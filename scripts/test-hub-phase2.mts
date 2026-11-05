// Eval Hub Phase 2 — ROUTE-LEVEL lifecycle test. Boots the REAL server against a REAL, THROWAWAY
// database and drives it over HTTP (same pattern as scripts/test-hub.mts). Nothing is mocked
// except the LLM provider, and even that is a REAL local HTTP server the hub reaches over the
// network stack via EVALHUB_JUDGE_URL — a mocked dispatcher proves nothing about what ships.
//
// Without EVALHUB_DATABASE_URL this prints a LOUD SKIP and exits 0 WITHOUT claiming a pass.
import http from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { makeSql } from "../src/db.js";
import { ensureSchema } from "../src/ensure-schema.js";
import { buildServer } from "../src/server.js";
import { tokenize, type EmbedFn } from "../src/scorers/metrics.js";

const ADMIN_URL = process.env.EVALHUB_DATABASE_URL || "";
if (!ADMIN_URL) {
  console.log("\n" + "=".repeat(78));
  console.log("  SKIP  scripts/test-hub-phase2.mts — EVALHUB_DATABASE_URL is NOT SET.");
  console.log("  NOTHING WAS TESTED. /api/score, /api/labels, /api/calibration/* , the 256KB cap,");
  console.log("  the 502-on-provider-failure law and auth on the new routes were ALL skipped.");
  console.log("  Run:  EVALHUB_DATABASE_URL=postgres://…/postgres npx tsx scripts/test-hub-phase2.mts");
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
const DBNAME = `evalhub_p2_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const adminUrl = new URL(ADMIN_URL);
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = "/" + DBNAME;
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
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

// ── the mock LLM provider (a real local HTTP server; the hub reaches it over TCP) ─────────────
type ProviderMode = "ok" | "http500" | "garbage_then_ok" | "garbage_always";
let mode: ProviderMode = "ok";
let providerCalls = 0;
let garbageServed = 0;

const provider = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    providerCalls++;
    if (mode === "http500") {
      res.writeHead(500, { "content-type": "text/plain" });
      return res.end("mock provider is down");
    }
    const body = JSON.parse(raw || "{}");
    const system = String(body?.messages?.[0]?.content ?? "");
    const user = String(body?.messages?.[body.messages.length - 1]?.content ?? "");
    const wantGarbage = mode === "garbage_always" || (mode === "garbage_then_ok" && garbageServed === 0);
    if (wantGarbage) garbageServed++;

    let content: string;
    if (wantGarbage) {
      content = "Sure, here are my thoughts in prose, definitely not JSON.";
    } else if (system.includes("extract atomic factual claims")) {
      // A deterministic stand-in extractor: one claim per sentence of the supplied TEXT.
      const text = user.replace(/^TEXT:\s*/i, "");
      const claims = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);
      content = JSON.stringify({ claims });
    } else {
      content = JSON.stringify({ score: 91, verdict: "pass", reasoning: "mock judge: meets the rubric" });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as AddressInfo).port;

// Env injection — exactly the knobs the box uses. The hub reads them per request.
process.env.EVALHUB_JUDGE_URL = `http://127.0.0.1:${providerPort}/chat/completions`;
process.env.EVALHUB_DEEPSEEK_KEY = "mock-key-not-a-real-secret";
process.env.EVALHUB_JUDGE_MODEL = "mock-judge-v1";

// A deterministic embedder for the assertions that must not depend on a model download.
// (Bag-of-tokens in a hashed 64-dim space — NOT MiniLM, and labelled as such wherever used.)
const detEmbed: EmbedFn = async (texts) =>
  texts.map((t) => {
    const v = new Array(64).fill(0);
    for (const tok of tokenize(t)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % 64] += 1;
    }
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / n);
  });

const TOKEN = "p2-token-" + Math.random().toString(36).slice(2, 10);
const sql = makeSql(DB_URL);
await ensureSchema(sql);
// app     = the shipping configuration (REAL MiniLM embedder)
// appDet  = same code, deterministic embedder — used only where an assertion must be exact
const app = buildServer({ sql, token: TOKEN });
const appDet = buildServer({ sql, token: TOKEN, embed: detEmbed });
await app.listen({ port: 0, host: "127.0.0.1" });
await appDet.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const BASE_DET = `http://127.0.0.1:${(appDet.server.address() as AddressInfo).port}`;

const TARGET = "p2_target_" + Math.random().toString(36).slice(2, 8);
const T19 = "p2_short_" + Math.random().toString(36).slice(2, 8);
const TLBL = "p2_lbl_" + Math.random().toString(36).slice(2, 8);
const SUITE = "llm_tailoring";
console.log(`\n[phase2] db ${createdDb ? DBNAME + " (throwaway)" : "SUPPLIED DB (fallback)"} · hub ${BASE} · mock provider :${providerPort}\n`);

type Res<T> = { status: number; body: T };
async function callTo<T = any>(base: string, method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Res<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-evalhub-token"] = token;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = { error: "non_json" }; }
  return { status: res.status, body: parsed as T };
}
function call<T = any>(m: string, p: string, b?: unknown, t: string | null = TOKEN) { return callTo<T>(BASE, m, p, b, t); }
function callDet<T = any>(m: string, p: string, b?: unknown) { return callTo<T>(BASE_DET, m, p, b, TOKEN); }

try {
  // ── auth is enforced on EVERY new route ───────────────────────────────────────────────────
  console.log("── auth on the Phase 2 routes ──");
  for (const [m, p] of [["POST", "/api/score"], ["POST", "/api/labels"], ["POST", "/api/calibration/compute"], ["GET", `/api/calibration/${TARGET}`]] as const) {
    const r = await call(m, p, m === "GET" ? undefined : {}, "wrong-token");
    ok(r.status === 401, `${m} ${p} with a bad token → 401`, r.status);
  }
  cannot((await call("POST", "/api/score", { kind: "grounding", payload: { citations: [], sources: {} } }, null)).status === 200,
    "an unauthenticated /api/score does NOT return 200");

  // ── /api/score kind:"metrics" — REAL, end to end ──────────────────────────────────────────
  console.log("\n── /api/score metrics (real) ──");
  const m1 = await call("POST", "/api/score", { kind: "metrics", payload: { expected: "Senior Backend Engineer", actual: "  senior backend engineer! " } });
  ok(m1.status === 200 && m1.body.exactNorm === true && m1.body.tokenF1 === 1, "normalized-identical → exactNorm true, tokenF1 1", JSON.stringify({ e: m1.body.exactNorm, f: m1.body.tokenF1 }));
  const m2 = await call("POST", "/api/score", { kind: "metrics", payload: { expected: "a b c d", actual: "a b x y" } });
  ok(m2.status === 200 && m2.body.exactNorm === false && m2.body.tokenF1 === 0.5, "hand-computed tokenF1 0.5 over HTTP", m2.body.tokenF1);
  cannot(m2.body.exactNorm === true, "a half-wrong answer is NOT an exact match");
  ok(typeof m1.body.latencyMs === "number" && m1.body.kind === "metrics", "response carries kind + latencyMs", JSON.stringify({ k: m1.body.kind, l: m1.body.latencyMs }));
  if (typeof m2.body.embedSim === "number") {
    ok(m2.body.embedSim >= 0 && m2.body.embedSim <= 1, "REAL MiniLM embedSim in [0,1]", m2.body.embedSim);
    const same = await call("POST", "/api/score", { kind: "metrics", payload: { expected: "the gate blocks a regression", actual: "the gate blocks a regression" } });
    ok(same.body.embedSim > 0.99, "REAL MiniLM: identical strings → ~1 over HTTP", same.body.embedSim);
  } else {
    console.log("  NOTE  embedSim came back NULL — the model is unavailable on this machine.");
    ok(Array.isArray(m2.body.warnings) && m2.body.warnings.length > 0, "…and the route DECLARED it in `warnings` instead of faking a number", JSON.stringify(m2.body.warnings));
  }

  // ── /api/score kind:"grounding" — deterministic, end to end ───────────────────────────────
  console.log("\n── /api/score grounding (real, deterministic) ──");
  const sources = { s1: "He cut p95 latency from 820ms to 210ms across forty services.", s2: "MSc, TU Berlin, 2019." };
  const g = await call("POST", "/api/score", {
    kind: "grounding",
    payload: {
      citations: [
        { sourceId: "s1", quote: "cut p95 latency from 820ms to 210ms" },
        { sourceId: "s2", quote: "MSc, TU Berlin" },
        { sourceId: "s1", quote: "he single-handedly rewrote the Linux scheduler" },
        { sourceId: "sX", quote: "no such source" },
      ],
      sources,
    },
  });
  ok(g.status === 200 && g.body.citationCount === 4, "4 citations checked", g.body.citationCount);
  ok(g.body.groundingRate === 0.5, "2 valid of 4 → groundingRate 0.5", g.body.groundingRate);
  ok(g.body.valid[0].found === true && g.body.valid[0].similarity === 1, "the exact quote is found at similarity 1");
  ok(g.body.valid[2].found === false, "the INVENTED quote is not found", g.body.valid[2].similarity);
  ok(g.body.valid[3].match === "unknown_source", "a citation to a missing source is named as such", g.body.valid[3].match);
  cannot(g.body.groundingRate === 1, "a citation set with a fabrication does NOT score 1");

  // ── the 256KB body cap ────────────────────────────────────────────────────────────────────
  console.log("\n── /api/score body cap (256KB, declared) ──");
  const big = { kind: "metrics", payload: { expected: "x", actual: "y".repeat(300 * 1024) } };
  const bigRes = await call("POST", "/api/score", big);
  ok(bigRes.status === 413, "a ~300KB body → 413, refused not truncated", bigRes.status);
  cannot(bigRes.status === 200, "an oversized score body is NOT silently accepted");
  const justUnder = await call("POST", "/api/score", { kind: "metrics", payload: { expected: "x", actual: "y".repeat(200 * 1024) } });
  ok(justUnder.status === 200, "a ~200KB body is accepted", justUnder.status);

  // ── /api/score kind:"judge" via the mock provider ─────────────────────────────────────────
  console.log("\n── /api/score judge (mock provider over real HTTP) ──");
  mode = "ok";
  const j = await call("POST", "/api/score", { kind: "judge", payload: { rubric: "Is the answer faithful?", input: "Q", output: "A", target: TARGET } });
  ok(j.status === 200 && j.body.score === 91 && j.body.verdict === "pass", "judge → score 91, verdict pass", JSON.stringify({ s: j.body.score, v: j.body.verdict }));
  ok(j.body.model === "mock-judge-v1", "the model actually used is reported", j.body.model);
  ok(j.body.calibration?.status === "uncalibrated" && j.body.calibration?.advisoryOnly === true,
    "an UNCALIBRATED judge says so and marks itself advisory-only", JSON.stringify(j.body.calibration));
  cannot(j.body.calibration?.status === "calibrated", "a judge with no kappa does NOT claim to be calibrated");

  mode = "garbage_then_ok"; garbageServed = 0;
  const jr = await call("POST", "/api/score", { kind: "judge", payload: { rubric: "R", input: "Q", output: "A" } });
  ok(jr.status === 200 && jr.body.retried === true && jr.body.score === 91, "unparseable answer → ONE retry → real score, retry declared", JSON.stringify({ r: jr.body.retried, s: jr.body.score }));

  mode = "garbage_always";
  const jg = await call("POST", "/api/score", { kind: "judge", payload: { rubric: "R", input: "Q", output: "A" } });
  ok(jg.status === 502 && jg.body.stage === "parse", "unparseable twice → 502(parse), NEVER a score", JSON.stringify({ s: jg.status, st: jg.body.stage }));
  cannot(typeof jg.body.score === "number", "a 502 carries NO fabricated score");

  mode = "http500";
  const j5 = await call("POST", "/api/score", { kind: "judge", payload: { rubric: "R", input: "Q", output: "A" } });
  ok(j5.status === 502 && j5.body.providerStatus === 500, "provider 500 → 502 with the provider's real status", JSON.stringify({ s: j5.status, p: j5.body.providerStatus }));
  cannot(j5.status === 200, "a dead provider does NOT produce a 200");
  mode = "ok";

  // ── /api/score kind:"hallucination" (deterministic embedder app) ──────────────────────────
  console.log("\n── /api/score hallucination (mock extractor + deterministic embedder) ──");
  const hSources = [
    "Vamsi Venkatesh worked at Siemens from 2019 to 2023 as a backend engineer building the order-routing service in Go.",
    "He completed an MSc at Otto von Guericke University Magdeburg in 2019.",
  ];
  const PLANT = "He was promoted to Vice President of Engineering at Rakuten in 2021, managing 140 people.";
  const hOut = `Vamsi Venkatesh worked at Siemens from 2019 to 2023. ${PLANT} He completed an MSc at Otto von Guericke University Magdeburg in 2019.`;
  const h = await callDet("POST", "/api/score", { kind: "hallucination", payload: { output: hOut, sources: hSources } });
  ok(h.status === 200 && h.body.claimCount === 3, "3 claims extracted end-to-end via the provider", h.body.claimCount);
  const planted = h.body.claims.find((c: any) => c.text.startsWith("He was promoted"));
  const clean = h.body.claims.filter((c: any) => !c.text.startsWith("He was promoted"));
  ok(planted && planted.supported === false, "the PLANTED claim is flagged unsupported", planted?.method);
  ok(clean.every((c: any) => c.supported === true), "both source-backed claims are supported", JSON.stringify(clean.map((c: any) => c.method)));
  ok(h.body.hallucinationRate === 0.3333, "hallucinationRate 1/3 → 0.3333", h.body.hallucinationRate);
  cannot(h.body.hallucinationRate === 0, "a plant does NOT yield a clean 0");
  mode = "http500";
  const hFail = await callDet("POST", "/api/score", { kind: "hallucination", payload: { output: hOut, sources: hSources } });
  ok(hFail.status === 502, "provider failure during claim extraction → 502, no partial score", hFail.status);
  cannot(typeof hFail.body.hallucinationRate === "number", "…and no hallucinationRate is invented");
  mode = "ok";

  // ── /api/labels ───────────────────────────────────────────────────────────────────────────
  console.log("\n── /api/labels (upsert) ──");
  const lb1 = await call("POST", "/api/labels", { target: TLBL, suite: SUITE, labeler: "founder", labels: [{ caseId: "c1", verdict: "pass", note: "first" }, { caseId: "c2", verdict: "fail" }] });
  ok(lb1.status === 200 && lb1.body.inserted === 2, "2 labels → inserted 2", JSON.stringify(lb1.body));
  const lb2 = await call("POST", "/api/labels", { target: TLBL, suite: SUITE, labeler: "founder", labels: [{ caseId: "c1", verdict: "fail", note: "changed my mind" }] });
  ok(lb2.status === 200 && lb2.body.inserted === 1, "re-labelling the same case → upsert, not a duplicate", lb2.body.inserted);
  const rows = await sql<{ n: number; verdict: string; note: string }[]>`
    SELECT count(*) OVER ()::int AS n, human->>'verdict' AS verdict, human->>'note' AS note
    FROM labels WHERE target = ${TLBL} AND case_id = 'c1'`;
  ok(rows.length === 1 && rows[0]!.verdict === "fail" && rows[0]!.note === "changed my mind", "the DB holds ONE row for that case, with the NEW verdict", JSON.stringify(rows));
  const lb3 = await call("POST", "/api/labels", { target: TLBL, suite: SUITE, labeler: "second_labeler", labels: [{ caseId: "c1", verdict: "pass" }] });
  ok(lb3.status === 200, "a SECOND labeler on the same case is a separate row (real disagreement survives)", lb3.status);
  ok(Number((await sql`SELECT count(*)::int AS n FROM labels WHERE target = ${TLBL} AND case_id = 'c1'`)[0]!.n) === 2, "…two rows now");
  ok((await call("POST", "/api/labels", { target: TLBL, suite: SUITE, labeler: "x", labels: [{ caseId: "c9", verdict: "maybe" }] })).status === 400, "a non-binary human verdict → 400");
  ok((await call("POST", "/api/labels", { target: TLBL, suite: SUITE, labeler: "x", labels: [] })).status === 400, "an empty label batch → 400, never a cheerful ok:true");

  // ── calibration: seed 25 usable pairs (+1 excluded) and hand-check the kappa ───────────────
  console.log("\n── /api/calibration/compute (hand-checked kappa) ──");
  //  18 (human pass, judge pass) · 3 (pass, fail) · 2 (fail, pass) · 2 (fail, fail)  → n = 25
  //  +1 case whose judge verdict is 'borderline' → EXCLUDED, never folded into 'fail'
  //  po = 20/25 = 0.8 ; human marginals 21/4 ; judge marginals 20/5
  //  pe = (21/25)(20/25) + (4/25)(5/25) = 0.672 + 0.032 = 0.704
  //  κ  = (0.8 - 0.704) / (1 - 0.704) = 0.096 / 0.296 = 0.3243
  const spec: { human: "pass" | "fail"; judge: string }[] = [
    ...Array.from({ length: 18 }, () => ({ human: "pass" as const, judge: "pass" })),
    ...Array.from({ length: 3 }, () => ({ human: "pass" as const, judge: "fail" })),
    ...Array.from({ length: 2 }, () => ({ human: "fail" as const, judge: "pass" })),
    ...Array.from({ length: 2 }, () => ({ human: "fail" as const, judge: "fail" })),
    { human: "pass" as const, judge: "borderline" },
  ];
  await call("POST", "/api/targets", { name: TARGET, kind: "product" });
  const runR = await call("POST", "/api/runs", { target: TARGET, suite: SUITE, gitSha: "cal_sha_1" });
  const runId = runR.body.runId as string;
  const push = await call("POST", `/api/runs/${runId}/results`, {
    results: spec.map((s, i) => ({ caseId: `cal_${i}`, pass: s.judge === "pass", scores: { judgeVerdict: s.judge, judgeScore: s.judge === "pass" ? 91 : 30 } })),
  });
  ok(push.status === 200 && push.body.inserted === 26, "26 results pushed with scores.judgeVerdict", push.body.inserted);
  await call("POST", `/api/runs/${runId}/finish`, {});
  const seed = await call("POST", "/api/labels", { target: TARGET, suite: SUITE, labeler: "founder", labels: spec.map((s, i) => ({ caseId: `cal_${i}`, verdict: s.human })) });
  ok(seed.status === 200 && seed.body.inserted === 26, "26 human labels seeded", seed.body.inserted);

  const cal = await call("POST", "/api/calibration/compute", { target: TARGET, suite: SUITE, judgeModel: "mock-judge-v1" });
  ok(cal.status === 200, "compute → 200", cal.status);
  ok(cal.body.n === 25, "n = 25 (the borderline case is EXCLUDED, not coerced)", cal.body.n);
  ok(cal.body.excluded === 1 && cal.body.excludedSample[0]?.reason?.startsWith("judge_verdict_not_binary"), "the exclusion is COUNTED and its reason named", JSON.stringify(cal.body.excludedSample));
  ok(cal.body.agreement === 0.8, "observed agreement 0.8 (20/25)", cal.body.agreement);
  ok(cal.body.expected === 0.704, "chance agreement 0.704", cal.body.expected);
  ok(cal.body.kappa === 0.3243, "κ = 0.3243 — matches the hand computation 0.096/0.296", cal.body.kappa);
  ok(cal.body.band === "fair" && cal.body.degenerate === false, "band 'fair', not degenerate", cal.body.band);
  ok(cal.body.confusion.pass.fail === 3 && cal.body.confusion.fail.pass === 2, "confusion matrix human→judge", JSON.stringify(cal.body.confusion));
  cannot(cal.body.kappa === cal.body.agreement, "κ is NOT the raw agreement (0.3243 ≠ 0.8)");
  const stored = await sql<{ kappa: string; n: number; agreement: string }[]>`SELECT kappa, n, agreement FROM calibrations WHERE target = ${TARGET}`;
  ok(stored.length === 1 && Number(stored[0]!.kappa) === 0.3243 && Number(stored[0]!.n) === 25, "the calibrations ROW really landed in the DB", JSON.stringify(stored));

  // the judge route must now report itself CALIBRATED for this target
  const jc = await call("POST", "/api/score", { kind: "judge", payload: { rubric: "R", input: "Q", output: "A", target: TARGET } });
  ok(jc.body.calibration?.status === "calibrated" && jc.body.calibration?.kappa === 0.3243 && jc.body.calibration?.n === 25,
    "after calibration the judge response carries {status:'calibrated', kappa, n}", JSON.stringify(jc.body.calibration));
  ok(jc.body.calibration?.advisoryOnly === false, "…and is no longer advisory-only");

  // ── refusal at n = 19 ─────────────────────────────────────────────────────────────────────
  console.log("\n── insufficient_labels (n = 19) ──");
  await call("POST", "/api/targets", { name: T19, kind: "product" });
  const r19 = await call("POST", "/api/runs", { target: T19, suite: SUITE, gitSha: "short_sha" });
  const run19 = r19.body.runId as string;
  await call("POST", `/api/runs/${run19}/results`, { results: Array.from({ length: 19 }, (_, i) => ({ caseId: `s_${i}`, pass: true, scores: { judgeVerdict: "pass" } })) });
  await call("POST", `/api/runs/${run19}/finish`, {});
  await call("POST", "/api/labels", { target: T19, suite: SUITE, labeler: "founder", labels: Array.from({ length: 19 }, (_, i) => ({ caseId: `s_${i}`, verdict: "pass" as const })) });
  const short = await call("POST", "/api/calibration/compute", { target: T19, suite: SUITE, judgeModel: "mock-judge-v1" });
  ok(short.status === 400 && short.body.error === "insufficient_labels", "19 pairs → 400 insufficient_labels", JSON.stringify({ s: short.status, e: short.body.error }));
  ok(short.body.n === 19 && short.body.need === 20, "…with the exact counts", JSON.stringify({ n: short.body.n, need: short.body.need }));
  cannot(short.status === 200, "a kappa on 19 cases is NOT computed");
  ok(Number((await sql`SELECT count(*)::int AS n FROM calibrations WHERE target = ${T19}`)[0]!.n) === 0, "…and NOTHING was written for it");

  // ── GET /api/calibration/:target ──────────────────────────────────────────────────────────
  console.log("\n── GET /api/calibration/:target ──");
  const getCal = await call("GET", `/api/calibration/${TARGET}`);
  ok(getCal.status === 200 && getCal.body.status === "calibrated", "→ 200, status calibrated", getCal.body.status);
  ok(getCal.body.calibrations.length === 1 && getCal.body.calibrations[0].judgeModel === "mock-judge-v1" && getCal.body.calibrations[0].kappa === 0.3243,
    "latest calibration per judge model", JSON.stringify(getCal.body.calibrations[0]));
  ok(getCal.body.labels.total === 26 && getCal.body.labels.bySuite[0].n === 26 && getCal.body.labels.bySuite[0].labelers === 1, "label counts by suite", JSON.stringify(getCal.body.labels));
  const empty = await call("GET", `/api/calibration/nobody_has_labelled_this`);
  ok(empty.status === 200 && empty.body.status === "uncalibrated" && empty.body.calibrations.length === 0, "an unknown target → uncalibrated, stated explicitly", empty.body.status);
  cannot(empty.body.status === "calibrated", "a target with no labels does NOT read as calibrated");

  // a SECOND compute must supersede, not duplicate, in the read view
  const cal2 = await call("POST", "/api/calibration/compute", { target: TARGET, suite: SUITE, judgeModel: "mock-judge-v1" });
  ok(cal2.status === 200, "recompute → 200");
  const getCal2 = await call("GET", `/api/calibration/${TARGET}`);
  ok(getCal2.body.calibrations.length === 1, "the read view shows ONE row per judge model (the latest)", getCal2.body.calibrations.length);
  ok(Number((await sql`SELECT count(*)::int AS n FROM calibrations WHERE target = ${TARGET}`)[0]!.n) === 2, "…while both computations are kept as history", "2");

  // ── bad input ─────────────────────────────────────────────────────────────────────────────
  console.log("\n── bad input ──");
  ok((await call("POST", "/api/score", { kind: "nope", payload: {} })).status === 400, "an unknown score kind → 400");
  ok((await call("POST", "/api/score", { kind: "metrics", payload: { expected: 1 } })).status === 400, "a malformed metrics payload → 400");
  ok((await call("POST", "/api/score", { kind: "grounding", payload: { citations: [{ sourceId: "a" }], sources: {} } })).status === 400, "a citation without a quote → 400");
  ok((await call("POST", "/api/calibration/compute", { target: TARGET })).status === 400, "compute without judgeModel → 400");
  ok(providerCalls > 0, "the mock provider was really reached over HTTP", `${providerCalls} calls`);
} catch (e) {
  console.error("\n  FAIL  unexpected exception:", e);
  fail++;
} finally {
  await app.close();
  await appDet.close();
  await new Promise<void>((r) => provider.close(() => r()));
  if (!createdDb) {
    // fallback path: we polluted a shared DB, so clean every row we made, explicitly.
    try {
      await sql`DELETE FROM labels WHERE target IN (${TARGET}, ${T19}, ${TLBL})`;
      await sql`DELETE FROM calibrations WHERE target IN (${TARGET}, ${T19})`;
      await sql`DELETE FROM targets WHERE name IN (${TARGET}, ${T19})`;
    } catch (e) { console.error("cleanup failed:", e); }
  }
  await sql.end({ timeout: 5 });
  if (createdDb) {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`);
      console.log(`\n[phase2] dropped throwaway database ${DBNAME}`);
    } catch (e) { console.error(`\n[phase2] COULD NOT DROP ${DBNAME}:`, String((e as Error).message)); fail++; }
  }
  await admin.end({ timeout: 5 });
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — score dispatch, 256KB cap, 502-not-a-score, labels upsert, kappa + calibration hold");
process.exit(fail ? 1 : 0);
