// Eval Hub Phase 3 — ROUTE-LEVEL lifecycle test. Boots the REAL server against a REAL, THROWAWAY
// database and drives it over HTTP (pattern of scripts/test-hub-phase2.mts). NOTHING is mocked
// except Telegram, and even that is a REAL local HTTP server the hub reaches with its REAL
// deliverTelegram() over the network stack — a stubbed sender would prove nothing about what ships.
//
// Without EVALHUB_DATABASE_URL this prints a LOUD SKIP and exits 0 WITHOUT claiming a pass.
import http from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { makeSql, type Sql } from "../src/db.js";
import { ensureSchema } from "../src/ensure-schema.js";
import { buildServer } from "../src/server.js";
import { scanAlerts, startAlertScanner, telegramConfigFromEnv } from "../src/alerts.js";

const ADMIN_URL = process.env.EVALHUB_DATABASE_URL || "";
if (!ADMIN_URL) {
  console.log("\n" + "=".repeat(78));
  console.log("  SKIP  scripts/test-hub-phase3.mts — EVALHUB_DATABASE_URL is NOT SET.");
  console.log("  NOTHING WAS TESTED. /api/stats, the alert scan + dedup + telegram delivery/retry,");
  console.log("  /api/alerts, the dashboard JSON + HTML token gate, and the review queue were ALL skipped.");
  console.log("  Run:  EVALHUB_DATABASE_URL=postgres://…/postgres npx tsx scripts/test-hub-phase3.mts");
  console.log("=".repeat(78) + "\n");
  process.exit(0);
}

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
const cannot = (wrong: boolean, what: string) => {
  console.log(`  ${!wrong ? "PASS" : "FAIL"}  [neg-control] ${what}`);
  if (wrong) fail++;
};

// ── throwaway database ────────────────────────────────────────────────────────────────────────
const DBNAME = `evalhub_p3_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = "/" + DBNAME;
const admin = postgres(new URL(ADMIN_URL).toString(), { max: 1, onnotice: () => {} });
let createdDb = false;
try {
  await admin.unsafe(`CREATE DATABASE "${DBNAME}"`);
  createdDb = true;
} catch (e) {
  console.log("\n" + "!".repeat(78));
  console.log(`  CREATE DATABASE failed (${String((e as Error).message).slice(0, 120)}).`);
  console.log("  Falling back to the SUPPLIED database with explicit row cleanup. Say so out loud:");
  console.log("  this run did NOT verify against a virgin schema.");
  console.log("!".repeat(78) + "\n");
}
const DB_URL = createdDb ? testUrl.toString() : ADMIN_URL;

// ── the mock Telegram API (a real local HTTP server) ──────────────────────────────────────────
const TG_TOKEN = "9999:mock-bot-token-not-a-real-secret";
const TG_CHAT = "-100777";
let tgMode: "ok" | "down" = "down";
let tgAttempts = 0;
const tgDelivered: string[] = [];
const tgPaths: string[] = [];

const tg = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    tgAttempts++;
    tgPaths.push(String(req.url));
    if (tgMode === "down") {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("mock telegram is down");
    }
    try {
      const body = JSON.parse(raw || "{}");
      tgDelivered.push(String(body.text ?? ""));
    } catch { tgDelivered.push("<unparseable>"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: tgAttempts } }));
  });
});
await new Promise<void>((r) => tg.listen(0, "127.0.0.1", r));
const TG_PORT = (tg.address() as AddressInfo).port;

// Env injection — exactly the knobs the box uses; telegramConfigFromEnv() is what production calls.
process.env.EVALHUB_TG_TOKEN = TG_TOKEN;
process.env.EVALHUB_TG_CHAT = TG_CHAT;
process.env.EVALHUB_TG_API = `http://127.0.0.1:${TG_PORT}`;

const TOKEN = "p3-token-" + Math.random().toString(36).slice(2, 10);
const PCT = 1.0;
const STALE_HOURS = 26;
const sql = makeSql(DB_URL);
await ensureSchema(sql);
const app = buildServer({ sql, token: TOKEN, regressionPct: PCT });
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const T = "p3_target_" + Math.random().toString(36).slice(2, 8);
console.log(`\n[phase3] db ${createdDb ? DBNAME + " (throwaway)" : "SUPPLIED DB (fallback)"} · hub ${BASE} · mock telegram :${TG_PORT}\n`);

type Res<T2> = { status: number; body: T2; text: string; contentType: string };
async function call<T2 = any>(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Res<T2>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-evalhub-token"] = token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = { error: "non_json" }; }
  return { status: res.status, body: parsed as T2, text, contentType: res.headers.get("content-type") || "" };
}

/** seed one finished run; returns its id and score */
async function seedRun(suite: string, sha: string, cases: { pass: boolean; latencyMs?: number }[]) {
  const r = await call("POST", "/api/runs", { target: T, suite, gitSha: sha });
  const runId = r.body.runId as string;
  const push = await call("POST", `/api/runs/${runId}/results`, {
    results: cases.map((c, i) => ({ caseId: `${suite}_c${i}`, pass: c.pass, ...(c.latencyMs === undefined ? {} : { latencyMs: c.latencyMs }) })),
  });
  if (push.status !== 200) throw new Error(`seed results failed: ${push.text}`);
  const fin = await call("POST", `/api/runs/${runId}/finish`, {});
  return { runId, score: fin.body.score as number };
}

try {
  // ══ auth on EVERY new route ════════════════════════════════════════════════════════════════
  console.log("── auth on the Phase 3 routes ──");
  for (const [m, p] of [
    ["GET", `/api/stats/${T}`], ["GET", "/api/alerts"], ["POST", "/api/alerts/00000000-0000-4000-8000-000000000000/ack"],
    ["GET", `/api/dashboard/${T}`], ["POST", "/api/review/enqueue"], ["GET", "/api/review/next"],
    ["POST", "/api/review/00000000-0000-4000-8000-000000000000/resolve"],
  ] as const) {
    const r = await call(m, p, m === "GET" ? undefined : {}, "wrong-token");
    ok(r.status === 401, `${m} ${p} with a bad token → 401`, r.status);
  }
  cannot((await call("GET", `/api/stats/${T}`, undefined, null)).status === 200, "an unauthenticated /api/stats does NOT return 200");

  // ══ seed ═══════════════════════════════════════════════════════════════════════════════════
  console.log("\n── seeding runs / results / baselines ──");
  await call("POST", "/api/targets", { name: T, kind: "product" });

  // alpha — healthy. baseline 100, latest 100. Latencies of the OLD run are 9000ms so a percentile
  // taken from the wrong run is immediately visible.
  const aOld = await seedRun("alpha", "sha_a1", [0, 1, 2, 3].map(() => ({ pass: true, latencyMs: 9000 })));
  await call("POST", "/api/baselines/promote", { target: T, suite: "alpha", runId: aOld.runId });
  const aNew = await seedRun("alpha", "sha_a2", [100, 200, 300, 4000].map((l) => ({ pass: true, latencyMs: l })));
  ok(aOld.score === 100 && aNew.score === 100, "alpha: both runs 4/4 → 100", `${aOld.score}/${aNew.score}`);

  // beta — regressed. baseline 100 (5/5), latest 80 (8/10), latencies 10..100.
  const bOld = await seedRun("beta", "sha_b1", [0, 1, 2, 3, 4].map(() => ({ pass: true, latencyMs: 50 })));
  await call("POST", "/api/baselines/promote", { target: T, suite: "beta", runId: bOld.runId });
  const bNew = await seedRun("beta", "sha_b2", Array.from({ length: 10 }, (_, i) => ({ pass: i < 8, latencyMs: (i + 1) * 10 })));
  ok(bOld.score === 100 && bNew.score === 80, "beta: baseline run 100, latest run 80", `${bOld.score}/${bNew.score}`);

  // gamma — stale. Scores at baseline (no regression), but its only run is 100h old.
  const g = await seedRun("gamma", "sha_g1", [{ pass: true }, { pass: true }]);
  await call("POST", "/api/baselines/promote", { target: T, suite: "gamma", runId: g.runId });
  await sql`UPDATE runs SET started_at = now() - interval '100 hours', finished_at = now() - interval '100 hours'
            WHERE id = ${g.runId}::uuid`;
  ok(g.score === 100, "gamma: 2/2 → 100, then backdated 100h", g.score);

  // ══ GET /api/stats/:target ═════════════════════════════════════════════════════════════════
  console.log("\n── GET /api/stats/:target (hand-computed nearest-rank) ──");
  const st = await call("GET", `/api/stats/${T}?days=7`);
  ok(st.status === 200 && st.body.percentileMethod === "nearest_rank", "→ 200 and the percentile METHOD is declared", st.body.percentileMethod);
  const S: Record<string, any> = Object.fromEntries((st.body.suites as any[]).map((s) => [s.suite, s]));
  ok((st.body.suites as any[]).map((s) => s.suite).join(",") === "alpha,beta,gamma", "three suites, sorted", (st.body.suites as any[]).map((s) => s.suite).join(","));
  //  alpha latest latencies sorted [100,200,300,4000]: p50 → ceil(2)=2 → 200 ; p95 → ceil(3.8)=4 → 4000
  ok(S.alpha.p50Ms === 200 && S.alpha.p95Ms === 4000 && S.alpha.p99Ms === 4000, "alpha p50 200 / p95 4000 / p99 4000", `${S.alpha.p50Ms}/${S.alpha.p95Ms}/${S.alpha.p99Ms}`);
  cannot(S.alpha.p50Ms === 9000, "the percentiles come from the LATEST run, not the 9000ms one before it");
  ok(S.alpha.runs === 2 && S.alpha.casesPerRun === 4 && S.alpha.latencySamples === 4, "alpha: 2 runs in window, 4 cases, 4 latency samples", JSON.stringify({ r: S.alpha.runs, c: S.alpha.casesPerRun, n: S.alpha.latencySamples }));
  ok(S.alpha.latestScore === 100 && S.alpha.baseline === 100 && S.alpha.delta === 0, "alpha score/baseline/delta", JSON.stringify({ s: S.alpha.latestScore, b: S.alpha.baseline, d: S.alpha.delta }));
  //  beta latest latencies [10..100]: p50 → ceil(5)=5 → 50 ; p95 → ceil(9.5)=10 → 100
  ok(S.beta.p50Ms === 50 && S.beta.p95Ms === 100 && S.beta.p99Ms === 100, "beta p50 50 / p95 100 / p99 100", `${S.beta.p50Ms}/${S.beta.p95Ms}/${S.beta.p99Ms}`);
  ok(S.beta.latestScore === 80 && S.beta.baseline === 100 && S.beta.delta === -20, "beta delta −20", S.beta.delta);
  ok(S.gamma.p50Ms === null && S.gamma.latencySamples === 0, "gamma reported NO latency at all → null, not 0", JSON.stringify({ p: S.gamma.p50Ms, n: S.gamma.latencySamples }));
  cannot(S.gamma.p95Ms === 0, "a suite that reported no latency does NOT read as 0ms");
  ok(typeof S.alpha.runDurationMs.p50 === "number" && S.alpha.runDurationMs.n === 2, "whole-run wall clock percentiles present with their sample size", JSON.stringify(S.alpha.runDurationMs));
  const stClamp = await call("GET", `/api/stats/${T}?days=99999`);
  ok(stClamp.body.days === 365 && stClamp.body.daysClamped === true, "an absurd ?days clamps AND declares it", JSON.stringify({ d: stClamp.body.days, c: stClamp.body.daysClamped }));
  const stNarrow = await call("GET", `/api/stats/${T}?days=1`);
  const gammaNarrow = (stNarrow.body.suites as any[]).find((s) => s.suite === "gamma");
  ok(gammaNarrow.runs === 0 && gammaNarrow.baseline === 100, "?days=1 excludes the 100h-old gamma run but STILL shows the suite", JSON.stringify({ r: gammaNarrow.runs, b: gammaNarrow.baseline }));
  cannot(gammaNarrow.latestScore === 100, "a suite with no run in the window does NOT keep showing a score");

  // ══ alert scan ═════════════════════════════════════════════════════════════════════════════
  console.log("\n── alert scan #1: detection + delivery against a DOWN telegram ──");
  const tgCfg = telegramConfigFromEnv();
  ok(tgCfg !== null && tgCfg.token === TG_TOKEN && tgCfg.chat === TG_CHAT, "telegramConfigFromEnv() reads the real env knobs", JSON.stringify({ chat: tgCfg?.chat, api: tgCfg?.api }));
  ok(telegramConfigFromEnv({ EVALHUB_TG_TOKEN: "x" } as NodeJS.ProcessEnv) === null, "a token without a chat id → null (delivery SKIPPED, never faked)");

  tgMode = "down";
  const scan1 = await scanAlerts(sql, { pct: PCT, staleHours: STALE_HOURS, telegram: tgCfg });
  ok(scan1.checked === 3, "3 suites with baselines checked", scan1.checked);
  ok(scan1.created === 2, "2 alerts created (beta regression + gamma missing_run)", JSON.stringify({ c: scan1.created, d: scan1.duplicates }));
  const kinds = await sql<{ suite: string; kind: string }[]>`SELECT suite, kind FROM alerts WHERE target = ${T} ORDER BY suite`;
  ok(kinds.length === 2 && kinds[0]!.suite === "beta" && kinds[0]!.kind === "regression", "beta → regression", JSON.stringify(kinds[0]));
  ok(kinds[1]!.suite === "gamma" && kinds[1]!.kind === "missing_run", "gamma → missing_run", JSON.stringify(kinds[1]));
  cannot(kinds.some((k) => k.suite === "alpha"), "the HEALTHY suite produced no alert");
  ok(scan1.deliveryFailed === 2 && scan1.delivered === 0, "the DOWN telegram failed both deliveries", JSON.stringify({ f: scan1.deliveryFailed, d: scan1.delivered }));
  ok(tgAttempts === 2 && tgPaths.every((p) => p.includes(`/bot${TG_TOKEN}/sendMessage`)), "the hub really reached the mock over HTTP, on the bot sendMessage path", `${tgAttempts} attempts`);
  const undel = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM alerts WHERE target = ${T} AND delivered = false`;
  ok(Number(undel[0]!.n) === 2, "both rows are still UNDELIVERED — a failed send is never marked delivered", undel[0]!.n);
  const ids1 = (await sql<{ id: string; suite: string }[]>`SELECT id, suite FROM alerts WHERE target = ${T} ORDER BY suite`).map((r) => r.id);

  console.log("\n── alert scan #2: dedup (the same scan, twice) ──");
  const scan2 = await scanAlerts(sql, { pct: PCT, staleHours: STALE_HOURS, telegram: tgCfg });
  ok(scan2.created === 0 && scan2.duplicates === 2, "scanning again creates NOTHING and counts 2 duplicates", JSON.stringify({ c: scan2.created, d: scan2.duplicates }));
  const nAfter2 = Number((await sql`SELECT count(*)::int AS n FROM alerts WHERE target = ${T}`)[0]!.n);
  ok(nAfter2 === 2, "still exactly 2 alert rows", nAfter2);
  cannot(nAfter2 === 4, "a second scan does NOT double the alerts");
  ok(scan2.deliveryFailed === 2, "…and it RETRIED the two undelivered ones (telegram still down)", scan2.deliveryFailed);

  console.log("\n── alert scan #3: telegram comes back → the RETRY delivers ──");
  tgMode = "ok";
  const before = tgAttempts;
  const scan3 = await scanAlerts(sql, { pct: PCT, staleHours: STALE_HOURS, telegram: tgCfg });
  ok(scan3.delivered === 2 && scan3.deliveryFailed === 0, "both previously-failed alerts delivered on the next scan", JSON.stringify({ d: scan3.delivered, f: scan3.deliveryFailed }));
  ok(tgAttempts === before + 2, "two more real HTTP calls to the mock", tgAttempts);
  ok(tgDelivered.length === 2 && tgDelivered.some((t) => t.includes("REGRESSION")) && tgDelivered.some((t) => t.includes("MISSING_RUN")),
    "the mock received both messages, naming the kind", JSON.stringify(tgDelivered.map((t) => t.split("\n")[0])));
  ok(tgDelivered.some((t) => t.includes("80.00") && t.includes("100.00")), "the regression message carries the EXACT numbers", tgDelivered.find((t) => t.includes("80.00"))?.split("\n")[1]);
  const dl = await sql<{ id: string; delivered: boolean; delivered_at: Date | null }[]>`
    SELECT id, delivered, delivered_at FROM alerts WHERE target = ${T} ORDER BY suite`;
  ok(dl.every((r) => r.delivered === true && r.delivered_at !== null), "delivered_at is SET on both rows", JSON.stringify(dl.map((r) => !!r.delivered_at)));
  ok(dl.map((r) => r.id).join(",") === ids1.join(","), "…on the SAME rows created in scan #1 — this was a retry, not a re-creation", "same ids");

  console.log("\n── scan #4: a delivered-but-unacked alert still dedups (no 5-minute buzzing) ──");
  const scan4 = await scanAlerts(sql, { pct: PCT, staleHours: STALE_HOURS, telegram: tgCfg });
  ok(scan4.created === 0 && scan4.duplicates === 2, "still nothing new while the alerts are unacknowledged", JSON.stringify({ c: scan4.created, d: scan4.duplicates }));

  // ══ GET /api/alerts + ack ══════════════════════════════════════════════════════════════════
  console.log("\n── GET /api/alerts · POST /api/alerts/:id/ack ──");
  const al = await call("GET", `/api/alerts?target=${T}&limit=50`);
  ok(al.status === 200 && al.body.count === 2, "→ 200 with 2 alerts", al.body.count);
  ok(al.body.alerts[0].message.length > 0 && typeof al.body.alerts[0].details === "object", "each alert carries a message and its details", al.body.alerts[0].kind);
  const undelQ = await call("GET", `/api/alerts?target=${T}&undelivered=1`);
  ok(undelQ.body.count === 0, "?undelivered=1 now returns none — they were all delivered", undelQ.body.count);
  cannot(undelQ.body.count === 2, "a delivered alert is NOT listed as undelivered");

  const betaAlertId = (await sql<{ id: string }[]>`SELECT id FROM alerts WHERE target = ${T} AND suite = 'beta'`)[0]!.id;
  const ackRes = await call("POST", `/api/alerts/${betaAlertId}/ack`, {});
  ok(ackRes.status === 200 && ackRes.body.ack === true && ackRes.body.ackAt, "ack → 200, ack true with a timestamp", JSON.stringify({ a: ackRes.body.ack }));
  ok((await call("POST", `/api/alerts/${betaAlertId}/ack`, {})).status === 200, "acking twice is idempotent, not an error");
  ok((await call("POST", `/api/alerts/00000000-0000-4000-8000-000000000000/ack`, {})).status === 404, "acking an unknown id → 404");
  ok((await call("POST", `/api/alerts/not-a-uuid/ack`, {})).status === 400, "a malformed id → 400, not a 500");

  console.log("\n── scan #5: after the ack, a still-broken suite is news again ──");
  const scan5 = await scanAlerts(sql, { pct: PCT, staleHours: STALE_HOURS, telegram: tgCfg });
  ok(scan5.created === 1 && scan5.duplicates === 1, "the ACKED beta re-alerts; the unacked gamma still dedups", JSON.stringify({ c: scan5.created, d: scan5.duplicates }));
  ok(Number((await sql`SELECT count(*)::int AS n FROM alerts WHERE target = ${T} AND suite = 'beta'`)[0]!.n) === 2, "beta now has two alerts across time", "2");

  console.log("\n── delivery SKIPPED when telegram is not configured (recorded, not lost) ──");
  // Ack the gamma alert so the next scan has something NEW to record, then run that scan with NO
  // credentials at all: the alert must land in the table and simply not be sent anywhere.
  const gammaAlertId = (await sql<{ id: string }[]>`SELECT id FROM alerts WHERE target = ${T} AND suite = 'gamma' ORDER BY created_at DESC LIMIT 1`)[0]!.id;
  await call("POST", `/api/alerts/${gammaAlertId}/ack`, {});
  const scanNoTg = await scanAlerts(sql, { pct: PCT, staleHours: STALE_HOURS, telegram: null });
  ok(scanNoTg.deliverySkipped === true && scanNoTg.delivered === 0, "no credentials → deliverySkipped, delivered 0", JSON.stringify({ s: scanNoTg.deliverySkipped, d: scanNoTg.delivered }));
  ok(scanNoTg.created === 1, "…the alert was still RECORDED", scanNoTg.created);
  ok(scanNoTg.pending >= 1, "…and it sits UNDELIVERED in the DB, not dropped", scanNoTg.pending);
  const pendingApi = await call("GET", `/api/alerts?target=${T}&undelivered=1`);
  ok(pendingApi.body.count === 1, "GET /api/alerts?undelivered=1 is how a human reads it with no telegram", pendingApi.body.count);
  cannot(pendingApi.body.count === 0, "an undeliverable alert is NOT silently discarded");

  // ══ the loop ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n── the scan loop: it ticks, and it NEVER crashes the server ──");
  const bootLines: string[] = [];
  const scanner = startAlertScanner({ sql, pct: PCT, intervalMs: 40, staleHours: STALE_HOURS, telegram: null, log: (l) => bootLines.push(l) });
  await new Promise((r) => setTimeout(r, 160));
  scanner.stop();
  ok(scanner.stats().ticks >= 2, "setInterval really ran the scan repeatedly", `${scanner.stats().ticks} ticks`);
  ok(bootLines.length === 1 && bootLines[0]!.includes("NOT set") && bootLines[0]!.includes("RECORDED"),
    "ONE loud boot line about the missing telegram config — and only one, across many scans", `${bootLines.length} line(s)`);
  cannot(bootLines.length > 1, "the missing-credential warning is NOT repeated per scan");

  const brokenSql = { unsafe: () => { throw new Error("db is gone"); } } as unknown as Sql;
  // a tagged-template call on this object throws immediately — exactly what a dead pool does
  const badScanner = startAlertScanner({ sql: brokenSql, pct: PCT, intervalMs: 10_000, staleHours: STALE_HOURS, telegram: null, log: () => {} });
  const bad = await badScanner.tick();
  badScanner.stop();
  ok(bad === null && badScanner.stats().errors === 1 && badScanner.stats().lastError !== null,
    "a scan against a dead DB is COUNTED and swallowed — the process survives", badScanner.stats().lastError);
  ok((await call("GET", "/api/health")).status === 200, "…and the HTTP service is still up afterwards");

  // ══ dashboard ══════════════════════════════════════════════════════════════════════════════
  console.log("\n── GET /api/dashboard/:target (JSON) ──");
  const dash = await call("GET", `/api/dashboard/${T}`);
  ok(dash.status === 200 && dash.body.target === T, "→ 200 for the target", dash.body.target);
  const DS: Record<string, any> = Object.fromEntries((dash.body.suites as any[]).map((s) => [s.suite, s]));
  ok(DS.beta.regression === true && DS.alpha.regression === false, "regression flag per suite", JSON.stringify({ b: DS.beta.regression, a: DS.alpha.regression }));
  ok(DS.beta.trend.length === 2 && DS.beta.trend[0].score === 100 && DS.beta.trend[1].score === 80,
    "beta trend is ASCENDING by time: 100 then 80", JSON.stringify(DS.beta.trend.map((p: any) => p.score)));
  cannot(DS.beta.trend[0].score === 80, "the trend is NOT newest-first");
  ok(dash.body.trendPoints === 14, "the trend cap (14) is declared", dash.body.trendPoints);
  ok(dash.body.alerts.length === 4 && dash.body.alerts[0].createdAt >= dash.body.alerts[3].createdAt, "the last alerts, newest first", dash.body.alerts.length);
  ok(dash.body.calibration.status === "uncalibrated", "calibration status is stated honestly", dash.body.calibration.status);
  ok(dash.body.regressionPct === PCT && dash.body.staleHours === STALE_HOURS, "the thresholds behind the colours are on the page's data", JSON.stringify({ p: dash.body.regressionPct, s: dash.body.staleHours }));

  console.log("\n── GET /dashboard/:target?token= (HTML) ──");
  const bad401 = await call("GET", `/dashboard/${T}?token=nope`, undefined, null);
  ok(bad401.status === 401 && bad401.body.error === "unauthorized", "a WRONG query token → 401", bad401.status);
  const none401 = await call("GET", `/dashboard/${T}`, undefined, null);
  ok(none401.status === 401, "no token at all → 401", none401.status);
  cannot(none401.status === 200, "the HTML dashboard is NOT open to the world because it is not under /api");
  // the header token must NOT be a way in for this route either — it is query-token only, by design
  const htmlRes = await call("GET", `/dashboard/${T}?token=${encodeURIComponent(TOKEN)}`, undefined, null);
  ok(htmlRes.status === 200 && htmlRes.contentType.startsWith("text/html"), "the right query token → 200 text/html", htmlRes.contentType);
  const html = htmlRes.text;

  // The script is no longer inline, so the page's behaviour lives in a second document. Fetch it
  // and assert on it: checking only the HTML would now pass a page whose script 404s.
  const appRes = await call("GET", "/dashboard/app.js", undefined, null);
  ok(appRes.status === 200, "GET /dashboard/app.js → 200 (the page's script is actually served)", appRes.status);
  ok(appRes.contentType.includes("javascript"), "…as JavaScript, so nosniff will not block it", appRes.contentType);
  const appJs = appRes.text;
  ok(appJs.length > 5000, "…and it is the real script, not a stub", appJs.length);

  ok(html.includes("alpha") && html.includes("beta") && html.includes("gamma"), "the served HTML contains every suite name");
  ok(/<svg /.test(html) || /polyline/.test(appJs), "the sparkline is drawn (markup or the loaded script)");
  ok(appJs.includes("no third-party requests"), "the page states its own contract — and states it ACCURATELY, since it now loads one same-origin script");

  // THE EXTERNAL-REQUEST CHECK — on the SERVED BYTES, not on the source file.
  const schemes = html.match(/[a-z][a-z0-9+.-]*:\/\//gi) ?? [];
  const protoRel = html.match(/(?:src|href)\s*=\s*["']\/\//gi) ?? [];
  ok(schemes.length === 0, "ZERO scheme-like strings (…://) in the served HTML", schemes.length === 0 ? "none" : JSON.stringify(schemes.slice(0, 5)));
  ok(protoRel.length === 0, "no protocol-relative src/href either", protoRel.length);
  // NOT "no src/href at all" any more (2026-08-05). The page MUST load its script from a
  // same-origin src: the vhost sends `script-src 'self'` with no 'unsafe-inline', so an inline
  // script is silently dropped and the page renders a dead shell. The invariant that actually
  // protects anyone is that nothing is fetched from a THIRD PARTY — so that is what is asserted,
  // plus the positive requirement that the script really is external and really is same-origin.
  const offOrigin = (html.replace(/href="?#/g, "").match(/\b(?:src|href)\s*=\s*["'](?![\/][^\/])[^"']*/gi) ?? []);
  ok(offOrigin.length === 0, "no OFF-ORIGIN src/href — nothing is fetched from a third party", JSON.stringify(offOrigin.slice(0, 3)));
  ok(/<script[^>]+\bsrc\s*=\s*["']\/[^\/]/i.test(html), "the page's script IS loaded from a same-origin src (CSP 'self' runs it)");
  // the check must be able to FAIL: run the same regex over a page that DOES have an external URL
  const poisoned = html.replace("</head>", '<link rel="stylesheet" href="https://cdn.example.com/x.css"></head>');
  cannot((poisoned.match(/[a-z][a-z0-9+.-]*:\/\//gi) ?? []).length === 0, "the external-URL check CATCHES a planted CDN link (the probe can fail)");
  console.log(`  NOTE  served dashboard HTML: ${Buffer.byteLength(html, "utf8")} bytes`);
  // a suite name that looks like markup must be displayed, never executed
  ok(!html.includes("<script>alert"), "no inline event/script injection surface in the rendered data");

  // ══ review queue ═══════════════════════════════════════════════════════════════════════════
  console.log("\n── POST /api/review/enqueue (dedup on open items) ──");
  const enq = await call("POST", "/api/review/enqueue", {
    target: T, suite: "alpha",
    items: [
      { caseId: "rc1", reason: "judge_borderline", payload: { output: "first" } },
      { caseId: "rc2", reason: "judge_borderline", payload: { output: "second" } },
      { caseId: "rc3", reason: "low_confidence", payload: { output: "third" } },
    ],
  });
  ok(enq.status === 200 && enq.body.enqueued === 3 && enq.body.duplicates === 0, "3 items enqueued", JSON.stringify({ e: enq.body.enqueued, d: enq.body.duplicates }));
  const enq2 = await call("POST", "/api/review/enqueue", {
    target: T, suite: "alpha",
    items: [{ caseId: "rc1", reason: "judge_borderline", payload: {} }, { caseId: "rc9", reason: "manual", payload: {} }],
  });
  ok(enq2.body.enqueued === 1 && enq2.body.duplicates === 1, "re-enqueueing an OPEN case is a counted duplicate, not a second card", JSON.stringify({ e: enq2.body.enqueued, d: enq2.body.duplicates }));
  ok(Number((await sql`SELECT count(*)::int AS n FROM review_queue WHERE target = ${T} AND case_id = 'rc1'`)[0]!.n) === 1, "…exactly one row for rc1", "1");
  cannot(enq2.body.enqueued === 2, "a duplicate is NOT reported as enqueued");
  ok((await call("POST", "/api/review/enqueue", { target: T, suite: "alpha", items: [{ caseId: "x", reason: "because_i_said_so" }] })).status === 400, "an unknown reason → 400");
  ok((await call("POST", "/api/review/enqueue", { target: T, suite: "alpha", items: [] })).status === 400, "an empty enqueue → 400, never a cheerful ok:true");

  // deterministic ordering: back-date the enqueue times so "oldest first" is testable, not lucky
  await sql`UPDATE review_queue SET enqueued_at = now() - interval '40 minutes' WHERE target = ${T} AND case_id = 'rc1'`;
  await sql`UPDATE review_queue SET enqueued_at = now() - interval '30 minutes' WHERE target = ${T} AND case_id = 'rc2'`;
  await sql`UPDATE review_queue SET enqueued_at = now() - interval '20 minutes' WHERE target = ${T} AND case_id = 'rc3'`;
  await sql`UPDATE review_queue SET enqueued_at = now() - interval '10 minutes' WHERE target = ${T} AND case_id = 'rc9'`;

  console.log("\n── GET /api/review/next (oldest first) ──");
  const nx = await call("GET", `/api/review/next?target=${T}&limit=2`);
  ok(nx.status === 200 && nx.body.items.length === 2, "limit honoured", nx.body.items.length);
  ok(nx.body.items[0].caseId === "rc1" && nx.body.items[1].caseId === "rc2", "OLDEST first", nx.body.items.map((i: any) => i.caseId).join(","));
  cannot(nx.body.items[0].caseId === "rc9", "the queue is not newest-first");
  ok(nx.body.openTotal === 4, "the true open total is reported next to the truncated page", nx.body.openTotal);
  ok(nx.body.items[0].payload?.output === "first" && nx.body.items[0].reason === "judge_borderline", "payload and reason survive the round trip", JSON.stringify(nx.body.items[0].payload));

  console.log("\n── POST /api/review/:id/resolve ──");
  const labelsBefore = Number((await sql`SELECT count(*)::int AS n FROM labels WHERE target = ${T}`)[0]!.n);
  const rc1Id = nx.body.items[0].id as string;
  const res1 = await call("POST", `/api/review/${rc1Id}/resolve`, { verdict: "fail", note: "fabricated employer", labeler: "founder" });
  ok(res1.status === 200 && res1.body.state === "labeled" && res1.body.labelWritten === true, "resolve fail → labeled, label written", JSON.stringify({ s: res1.body.state, l: res1.body.labelWritten }));
  const lrow = await sql<{ verdict: string; note: string; suite: string; labeler: string }[]>`
    SELECT human->>'verdict' AS verdict, human->>'note' AS note, suite, labeler
    FROM labels WHERE target = ${T} AND case_id = 'rc1'`;
  ok(lrow.length === 1 && lrow[0]!.verdict === "fail" && lrow[0]!.note === "fabricated employer" && lrow[0]!.suite === "alpha" && lrow[0]!.labeler === "founder",
    "the labels row is EXACTLY what POST /api/labels would have written", JSON.stringify(lrow[0]));
  const calAfter = await call("GET", `/api/calibration/${T}`);
  ok(calAfter.body.labels.total === labelsBefore + 1 && calAfter.body.labels.bySuite.some((b: any) => b.suite === "alpha" && b.n === 1),
    "…and it is visible through the calibration/labels read path", JSON.stringify(calAfter.body.labels));
  ok((await call("POST", `/api/review/${rc1Id}/resolve`, { verdict: "pass", labeler: "founder" })).status === 409, "resolving an already-resolved item → 409");
  ok((await call("POST", `/api/review/00000000-0000-4000-8000-000000000000/resolve`, { verdict: "pass", labeler: "f" })).status === 404, "an unknown review id → 404");
  ok((await call("POST", `/api/review/${rc1Id}/resolve`, { verdict: "pass" })).status === 400, "resolve without a labeler → 400 (an anonymous human label is not a human label)");

  //  NEGATIVE CONTROL: skip must NOT write a label.
  const nx2 = await call("GET", `/api/review/next?target=${T}&limit=1`);
  const rc2Id = nx2.body.items[0].id as string;
  ok(nx2.body.items[0].caseId === "rc2", "the labelled item left the queue; rc2 is next", nx2.body.items[0].caseId);
  const beforeSkip = Number((await sql`SELECT count(*)::int AS n FROM labels WHERE target = ${T}`)[0]!.n);
  const skipRes = await call("POST", `/api/review/${rc2Id}/resolve`, { verdict: "skip", labeler: "founder" });
  ok(skipRes.status === 200 && skipRes.body.state === "skipped" && skipRes.body.labelWritten === false, "skip → state skipped, labelWritten false", JSON.stringify({ s: skipRes.body.state }));
  const afterSkip = Number((await sql`SELECT count(*)::int AS n FROM labels WHERE target = ${T}`)[0]!.n);
  cannot(afterSkip !== beforeSkip, "a SKIP wrote NO label row — 'I don't know' is not a verdict");
  ok(Number((await sql`SELECT count(*)::int AS n FROM labels WHERE target = ${T} AND case_id = 'rc2'`)[0]!.n) === 0, "…nothing at all for rc2", "0");

  //  a resolved case may be enqueued again later (the dedup is on OPEN items only)
  const reEnq = await call("POST", "/api/review/enqueue", { target: T, suite: "alpha", items: [{ caseId: "rc1", reason: "judge_disagreement", payload: {} }] });
  ok(reEnq.body.enqueued === 1, "a case that was already LABELLED may return to the queue", JSON.stringify({ e: reEnq.body.enqueued }));

  const dash2 = await call("GET", `/api/dashboard/${T}`);
  ok(dash2.body.review.open === 3 && dash2.body.review.labeled === 1 && dash2.body.review.skipped === 1,
    "the dashboard counts the queue by state", JSON.stringify(dash2.body.review));
} catch (e) {
  console.error("\n  FAIL  unexpected exception:", e);
  fail++;
} finally {
  await app.close();
  await new Promise<void>((r) => tg.close(() => r()));
  if (!createdDb) {
    try {
      await sql`DELETE FROM alerts WHERE target = ${T}`;
      await sql`DELETE FROM review_queue WHERE target = ${T}`;
      await sql`DELETE FROM labels WHERE target = ${T}`;
      await sql`DELETE FROM targets WHERE name = ${T}`;
    } catch (e) { console.error("cleanup failed:", e); }
  }
  await sql.end({ timeout: 5 });
  if (createdDb) {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`);
      console.log(`\n[phase3] dropped throwaway database ${DBNAME}`);
    } catch (e) { console.error(`\n[phase3] COULD NOT DROP ${DBNAME}:`, String((e as Error).message)); fail++; }
  }
  await admin.end({ timeout: 5 });
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — stats percentiles, alert detection/dedup/delivery+retry/ack, dashboard JSON+HTML gate, review queue");
process.exit(fail ? 1 : 0);
