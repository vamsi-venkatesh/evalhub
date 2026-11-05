// Eval Hub Phase 4 — ROUTE-LEVEL lifecycle test. Boots the REAL server against a REAL, THROWAWAY
// database and drives it over HTTP (pattern of scripts/test-hub-phase3b.mts). The verdict math,
// the report assembly and the dashboard renderer are the production ones; only the EMBEDDER is a
// fake, and it is a fake with known geometry so the similarities below are hand-computable:
// each text becomes a unit vector over its token set, so cosine = |shared tokens| / |tokens|.
//
// Without EVALHUB_DATABASE_URL this prints a LOUD SKIP and exits 0 WITHOUT claiming a pass.
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { makeSql } from "../src/db.js";
import { ensureSchema } from "../src/ensure-schema.js";
import { buildServer } from "../src/server.js";
import { tokenize } from "../src/scorers/metrics.js";

const ADMIN_URL = process.env.EVALHUB_DATABASE_URL || "";
if (!ADMIN_URL) {
  console.log("\n" + "=".repeat(78));
  console.log("  SKIP  scripts/test-hub-phase4.mts — EVALHUB_DATABASE_URL is NOT SET.");
  console.log("  NOTHING WAS TESTED. /api/shadow/*, /api/canary/*, /api/report/:target and the new");
  console.log("  dashboard section were ALL skipped.");
  console.log("  Run:  EVALHUB_DATABASE_URL=postgres://…/postgres npx tsx scripts/test-hub-phase4.mts");
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

// The DOM-write property the page must never use. Built from parts so this file does not itself
// read as an assignment to a scanner.
const DOM_HTML_PROP = "inner" + "HTML";
const DOM_HTML_RE = new RegExp("\\." + DOM_HTML_PROP);

// ── the fake embedder (known geometry) ────────────────────────────────────────────────────────
// One dimension per token in a fixed vocabulary; a text is the unit vector over its OWN token set.
// cosine(a,b) = |A ∩ B| / sqrt(|A|·|B|). With equal-length texts that is exactly the shared-token
// fraction, so every expected similarity below is arithmetic, not a guess.
const VOCAB: string[] = [];
function vocabIndex(tok: string): number {
  let i = VOCAB.indexOf(tok);
  if (i < 0) { VOCAB.push(tok); i = VOCAB.length - 1; }
  return i;
}
const fakeEmbed = async (texts: string[]) => {
  for (const t of texts) for (const tok of tokenize(t)) vocabIndex(tok);
  const dim = Math.max(VOCAB.length, 1);
  return texts.map((t) => {
    const toks = [...new Set(tokenize(t))];
    const v = new Array(dim).fill(0);
    const norm = Math.sqrt(toks.length) || 1;
    for (const tok of toks) v[vocabIndex(tok)] = 1 / norm;
    return v;
  });
};

// ── throwaway database ────────────────────────────────────────────────────────────────────────
const DBNAME = `evalhub_p4_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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

process.env.EVALHUB_SHADOW_SIM = "0.90";
process.env.EVALHUB_CANARY_PCT = "5";

const TOKEN = "p4-token-" + Math.random().toString(36).slice(2, 10);
const sql = makeSql(DB_URL);
await ensureSchema(sql);
const app = buildServer({ sql, token: TOKEN, regressionPct: 1.0, embed: fakeEmbed });
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const T = "p4_target_" + Math.random().toString(36).slice(2, 8);
const EMPTY_T = "p4_empty_" + Math.random().toString(36).slice(2, 8);
const SHA = "aaaa111";
const OLD_SHA = "0000abc";
console.log(`\n[phase4] db ${createdDb ? DBNAME + " (throwaway)" : "SUPPLIED DB (fallback)"} · hub ${BASE}\n`);

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

/** Seed one finished run: create → results → finish. Returns the finish verdict. */
async function seedRun(target: string, suite: string, sha: string, n: number, passing: number, latency = 100) {
  const r = await call("POST", "/api/runs", { target, suite, gitSha: sha });
  const runId = (r.body as any).runId as string;
  const results = Array.from({ length: n }, (_, i) => ({
    caseId: `${suite}_c${i}`, pass: i < passing, score: i < passing ? 100 : 0, latencyMs: latency + i,
  }));
  await call("POST", `/api/runs/${runId}/results`, { results });
  const f = await call("POST", `/api/runs/${runId}/finish`, {});
  return { runId, verdict: f.body as any };
}

try {
  await call("POST", "/api/targets", { name: T, kind: "product" });
  await call("POST", "/api/targets", { name: EMPTY_T, kind: "product" });

  // ══ AUTH on every new route ════════════════════════════════════════════════════════════════
  console.log("── auth on the Phase 4 routes ──");
  const unauth: [string, string, unknown?][] = [
    ["POST", "/api/shadow/runs", { target: T, candidateSha: "x" }],
    ["POST", "/api/shadow/runs/00000000-0000-4000-8000-000000000000/pairs", { pairs: [{ caseId: "c", baselineOutput: "a", candidateOutput: "a" }] }],
    ["POST", "/api/shadow/runs/00000000-0000-4000-8000-000000000000/finish", {}],
    ["POST", "/api/canary/events", { target: T, sha: "x", phase: "start" }],
    ["GET", `/api/canary/${T}`],
    ["GET", `/api/report/${T}`],
    ["GET", `/api/report/${T}?format=md`],
  ];
  for (const [m, p, b] of unauth) {
    const r = await call(m, p, b, null);
    ok(r.status === 401 && (r.body as any).error === "unauthorized", `${m} ${p.split("?")[0]} without a token → 401`, r.status);
  }
  const wrongTok = await call("GET", `/api/report/${T}`, undefined, TOKEN + "x");
  cannot(wrongTok.status === 200, "a WRONG token does not reach the new read routes");
  const rowsAfterUnauth = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canary_events`;
  ok(Number(rowsAfterUnauth[0]!.n) === 0, "…and no unauthenticated write landed a row", rowsAfterUnauth[0]!.n);

  // ══ SHADOW REPLAY ══════════════════════════════════════════════════════════════════════════
  console.log("\n── POST /api/shadow/runs ──");
  const unknownTarget = await call("POST", "/api/shadow/runs", { target: "nobody_" + Date.now(), candidateSha: SHA });
  ok(unknownTarget.status === 400 && unknownTarget.body.error === "unknown_target", "a replay for an unregistered target → 400", unknownTarget.body.error);
  const sr = await call("POST", "/api/shadow/runs", { target: T, candidateSha: SHA, baselineSha: OLD_SHA, sampled: 10 });
  ok(sr.status === 200 && typeof sr.body.runId === "string", "a shadow run is created", String(sr.body.runId).slice(0, 8));
  ok(sr.body.simThreshold === 0.9, "the similarity threshold in force is returned", sr.body.simThreshold);
  ok(String(sr.body.definition).includes("No user traffic"), "…WITH the definition of the word 'shadow' attached", String(sr.body.definition).slice(0, 40));
  const RID = sr.body.runId as string;

  console.log("\n── POST /api/shadow/runs/:id/pairs (embedSim + exactNorm) ──");
  //  Twelve-token texts. cosine = shared/12 with the fake embedder, so:
  //    identical            → 1.00       not a diff
  //    11 of 12 shared      → 0.9167     not a diff (above 0.90)
  //    4 of 12 shared       → 0.3333     DIFF
  const BASE12 = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
  const NEAR12 = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda nu";
  const FAR12 = "alpha beta gamma delta rho sigma tau upsilon phi chi psi omega";
  const pairs = [
    // 7 identical
    ...Array.from({ length: 7 }, (_, i) => ({ caseId: `same_${i}`, baselineOutput: BASE12, candidateOutput: BASE12 })),
    // 1 near-identical, above the threshold
    { caseId: "near_0", baselineOutput: BASE12, candidateOutput: NEAR12 },
    // 2 clear diffs
    { caseId: "far_0", baselineOutput: BASE12, candidateOutput: FAR12 },
    { caseId: "far_1", baselineOutput: BASE12, candidateOutput: FAR12 },
  ];
  const pr = await call("POST", `/api/shadow/runs/${RID}/pairs`, { pairs, spendUsd: 0.0421 });
  ok(pr.status === 200 && pr.body.received === 10 && pr.body.inserted === 10, "ten pairs land", JSON.stringify({ r: pr.body.received, i: pr.body.inserted }));
  ok(pr.body.diffs === 2 && pr.body.unscored === 0, "exactly the two dissimilar pairs are recorded as diffs", JSON.stringify({ d: pr.body.diffs, u: pr.body.unscored }));
  ok(String(pr.body.diffRule).includes("0.9"), "the diff rule (embedSim < threshold) is stated on the response", pr.body.diffRule);
  const simRows = await sql<{ case_id: string; sim: string; sim_source: string; exact: boolean; diff: boolean }[]>`
    SELECT case_id, sim, sim_source, exact, diff FROM shadow_pairs WHERE run_id = ${RID}::uuid ORDER BY case_id`;
  const byCase = Object.fromEntries(simRows.map((r) => [r.case_id, r]));
  ok(Number(byCase["same_0"]!.sim) === 1 && byCase["same_0"]!.exact === true, "an identical pair scores exactSim 1 and exactNorm true", byCase["same_0"]!.sim);
  ok(Math.abs(Number(byCase["near_0"]!.sim) - 0.9167) < 0.001 && byCase["near_0"]!.diff === false,
    "11-of-12 shared tokens → 0.9167, above 0.90, NOT a diff", byCase["near_0"]!.sim);
  ok(Math.abs(Number(byCase["far_0"]!.sim) - 0.3333) < 0.001 && byCase["far_0"]!.diff === true,
    "4-of-12 shared tokens → 0.3333, below 0.90, IS a diff", byCase["far_0"]!.sim);
  cannot(byCase["near_0"]!.diff === true, "a near-identical output is not flagged as a difference");
  cannot(byCase["far_0"]!.exact === true, "a materially different output is not reported as an exact match");

  console.log("\n── shadow write guards ──");
  ok((await call("POST", `/api/shadow/runs/${RID}/pairs`, { pairs: [] })).status === 400, "an empty pairs array → 400");
  const tooMany = await call("POST", `/api/shadow/runs/${RID}/pairs`, {
    pairs: Array.from({ length: 201 }, (_, i) => ({ caseId: "x" + i, baselineOutput: "a", candidateOutput: "a" })),
  });
  ok(tooMany.status === 413 && tooMany.body.max === 200, "an oversized batch is REFUSED, not silently trimmed", JSON.stringify({ s: tooMany.status, m: tooMany.body.max }));
  ok((await call("POST", "/api/shadow/runs/00000000-0000-4000-8000-000000000000/pairs", { pairs: [{ caseId: "c", baselineOutput: "a", candidateOutput: "a" }] })).status === 404,
    "pairs for an unknown run → 404, never a cheerful ok:true");
  ok((await call("POST", "/api/shadow/runs/not-a-uuid/pairs", { pairs: [{ caseId: "c", baselineOutput: "a", candidateOutput: "a" }] })).status === 400,
    "a malformed run id → 400");

  console.log("\n── POST /api/shadow/runs/:id/finish (the verdict math) ──");
  const fin = await call("POST", `/api/shadow/runs/${RID}/finish`, {});
  ok(fin.status === 200 && fin.body.compared === 10 && fin.body.diffs === 2, "the finish counts what the pairs table holds", JSON.stringify({ c: fin.body.compared, d: fin.body.diffs }));
  ok(fin.body.diffRate === 0.2, "diffRate = 2/10 = 0.2", fin.body.diffRate);
  ok(fin.body.recommendation === "inspect" && fin.body.reason.includes("0.15"),
    "0.2 above the 0.15 threshold → inspect, with the threshold named", fin.body.reason);
  ok(fin.body.thresholds.simThreshold === 0.9 && fin.body.thresholds.diffRateInspect === 0.15 && fin.body.thresholds.meanDeltaBlock === -1,
    "EVERY threshold applied is stated in the response", JSON.stringify(fin.body.thresholds));
  ok(fin.body.spendUsd === 0.0421, "the metered replay spend is carried at 4dp (a sub-cent replay is not rounded away)", fin.body.spendUsd);
  ok(fin.body.meanDeltaEvaluated === false && fin.body.caveats.some((c: string) => c.includes("NOT evaluated")),
    "no pair carried scores → the blocking rule is declared unevaluated", fin.body.caveats.length);
  cannot(fin.body.recommendation === "safe", "a 20% diff rate is NOT safe");
  ok((await call("POST", `/api/shadow/runs/${RID}/pairs`, { pairs: [{ caseId: "late", baselineOutput: "a", candidateOutput: "a" }] })).status === 409,
    "pairs after the finish → 409 (a closed replay does not grow)");

  console.log("\n── the ZERO-PAIRS control: an empty replay is NOT safe ──");
  const empty = await call("POST", "/api/shadow/runs", { target: T, candidateSha: "empty1", sampled: 0 });
  const ef = await call("POST", `/api/shadow/runs/${empty.body.runId}/finish`, {});
  ok(ef.body.recommendation === "inspect" && ef.body.compared === 0, "zero compared pairs → inspect", ef.body.recommendation);
  ok(ef.body.diffRate === null, "…and diffRate is null, never 0", String(ef.body.diffRate));
  ok(String(ef.body.reason).includes("proves nothing"), "…with the reason on the response", ef.body.reason);
  cannot(ef.body.recommendation === "safe", "AN EMPTY SHADOW RUN IS NOT SAFE — it proves nothing");

  console.log("\n── the BLOCK control: a worse candidate is blocked, and blocking wins ──");
  const blk = await call("POST", "/api/shadow/runs", { target: T, candidateSha: "worse1", baselineSha: OLD_SHA, sampled: 4 });
  await call("POST", `/api/shadow/runs/${blk.body.runId}/pairs`, {
    pairs: [
      { caseId: "b0", baselineOutput: BASE12, candidateOutput: FAR12, scores: { baseline: 95, candidate: 80 } },
      { caseId: "b1", baselineOutput: BASE12, candidateOutput: FAR12, scores: { baseline: 95, candidate: 80 } },
      { caseId: "b2", baselineOutput: BASE12, candidateOutput: BASE12, scores: { baseline: 95, candidate: 80 } },
      { caseId: "b3", baselineOutput: BASE12, candidateOutput: BASE12, scores: { baseline: 95, candidate: 80 } },
    ],
    spendUsd: 0.01,
  });
  const bf = await call("POST", `/api/shadow/runs/${blk.body.runId}/finish`, {});
  ok(bf.body.meanDelta === -15 && bf.body.recommendation === "block", "meanDelta -15 → block", JSON.stringify({ d: bf.body.meanDelta, r: bf.body.recommendation }));
  ok(bf.body.diffRate === 0.5 && String(bf.body.reason).includes("blocking wins"),
    "the diff rate ALSO breached, and the response says blocking won", bf.body.reason);
  cannot(bf.body.recommendation === "inspect", "a candidate that scores 15 points worse is never merely 'inspect'");

  // ══ CANARY ═════════════════════════════════════════════════════════════════════════════════
  console.log("\n── POST /api/canary/events (the vocabulary is closed) ──");
  const bad = await call("POST", "/api/canary/events", { target: T, sha: SHA, phase: "rolledback", pct: 5 });
  ok(bad.status === 400 && bad.body.error === "unknown_phase", "an unknown phase → 400", bad.body.error);
  ok(Array.isArray(bad.body.allowed) && bad.body.allowed.join(",") === "start,promote,rollback",
    "…and the error NAMES the vocabulary", bad.body.allowed?.join(","));
  const noRow = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM canary_events WHERE phase = 'rolledback'`;
  ok(Number(noRow[0]!.n) === 0, "…and nothing was written", noRow[0]!.n);
  cannot((await call("POST", "/api/canary/events", { target: T, sha: SHA, phase: "PROMOTE" })).status === 200,
    "an upper-case phase is not silently normalised into the vocabulary");

  const ev1 = await call("POST", "/api/canary/events", { target: T, sha: SHA, phase: "start", pct: 5, reason: "green up, 5% cohort pinned" });
  ok(ev1.status === 200 && typeof ev1.body.id === "string", "a start transition records", String(ev1.body.id).slice(0, 8));
  ok(String(ev1.body.definition).includes("BLUE/GREEN"), "…WITH the definition of the word 'canary' attached", String(ev1.body.definition).slice(0, 40));
  await call("POST", "/api/canary/events", { target: T, sha: SHA, phase: "rollback", pct: 0, reason: "gate verdict fail on role_family" });
  await call("POST", "/api/canary/events", { target: T, sha: SHA, phase: "promote", pct: 100, reason: "clean for 30m" });

  console.log("\n── GET /api/canary/:target ──");
  const list = await call("GET", `/api/canary/${T}`);
  ok(list.status === 200 && list.body.count === 3, "every recorded transition is listed", list.body.count);
  ok(list.body.events[0].phase === "promote", "newest first", list.body.events[0].phase);
  ok(list.body.summary.starts === 1 && list.body.summary.rollbacks === 1 && list.body.summary.promotes === 1,
    "the summary counts the phases", JSON.stringify(list.body.summary).slice(0, 90));
  ok(String(list.body.summary.note).includes("did not witness"), "…and states the hub only recorded what was posted");
  const emptyList = await call("GET", `/api/canary/${EMPTY_T}`);
  ok(emptyList.body.count === 0 && String(emptyList.body.summary.note).includes("absence of DATA"),
    "a target with no transitions says the silence is missing data", emptyList.body.summary.note.slice(0, 40));
  cannot(String(emptyList.body.summary.note).toLowerCase().includes("stable"), "an empty canary history is never summarised as stability");
  ok((await call("GET", `/api/canary/${T}?sha=nothing_like_this`)).body.count === 0, "filtering by an unknown sha yields nothing, not everything");

  // ══ REPORT ═════════════════════════════════════════════════════════════════════════════════
  console.log("\n── seeding runs for the report ──");
  //  role_family: 100/100 on the OLD sha → promoted as the baseline; 80/100 on THIS sha → regression
  const oldRun = await seedRun(T, "role_family", OLD_SHA, 100, 100, 40);
  const promo = await call("POST", "/api/baselines/promote", { target: T, suite: "role_family", runId: oldRun.runId });
  ok(promo.status === 200 && promo.body.score === 100, "role_family baseline promoted at 100", promo.body.score);
  await seedRun(T, "role_family", SHA, 100, 80, 55);
  //  geo: reported for this sha but NEVER promoted → a suite nothing could regress against
  await seedRun(T, "geo", SHA, 40, 40, 30);
  //  safety: the probe suite
  await seedRun(T, "safety_probes", SHA, 40, 39, 700);
  //  a suite that ran historically but is SILENT for this sha
  await seedRun(T, "apply_resolver", OLD_SHA, 25, 25, 20);
  //  alerts + a metered model run + an unpriced one (after the promotion, so both fall in the window)
  await sql`INSERT INTO alerts (target, suite, kind, message) VALUES (${T}, 'role_family', 'regression', 'role_family fell 20.00 points below baseline')`;
  await call("POST", "/api/model-runs", {
    target: T, suite: "safety_probes", model: "deepseek-chat", provider: "deepseek",
    cases: 40, score: 97.5, tokensIn: 1_000_000, tokensOut: 200_000,
  });
  await call("POST", "/api/model-runs", { target: T, suite: "safety_probes", model: "mystery-9000", cases: 40, score: 99, tokensIn: 10, tokensOut: 10 });

  console.log("\n── GET /api/report/:target (json) ──");
  ok((await call("GET", `/api/report/nobody_${Date.now()}`)).status === 404, "a report for an unknown target → 404");
  ok((await call("GET", `/api/report/${T}?format=xml`)).status === 400, "an unsupported format → 400, never a silent default");
  const rep = await call("GET", `/api/report/${T}?sha=${SHA}`);
  ok(rep.status === 200 && rep.body.verdict === "fail", "the report's verdict comes from the SAME gate rule", rep.body.verdict);
  ok(rep.body.totals.suites === 3 && rep.body.totals.cases === 180 && rep.body.totals.passed === 159,
    "totals are summed from the runs of this sha", JSON.stringify(rep.body.totals));
  ok(rep.body.regressions.length === 1 && rep.body.regressions[0].suite === "role_family" && rep.body.regressions[0].delta === -20,
    "the regression is named with its delta", JSON.stringify(rep.body.regressions[0]).slice(0, 80));
  ok(rep.body.regressions[0].failuresTotal === 20 && rep.body.regressions[0].failures.length === 20,
    "…and the failing cases are listed", rep.body.regressions[0].failures.length);
  ok(rep.body.suitesMissingForSha.includes("apply_resolver"), "a suite that went silent for this sha is NAMED", rep.body.suitesMissingForSha.join(","));
  ok(rep.body.safety.probes === 40 && rep.body.safety.suite === "safety_probes", "the safety probe COUNT is measured, not asserted", rep.body.safety.probes);
  ok(rep.body.shadow && rep.body.shadow.recommendation === "block", "the latest shadow verdict travels with the report", rep.body.shadow?.recommendation);
  ok(rep.body.canary.events === 3 && rep.body.canary.rollbacks === 1, "so do the canary transitions", JSON.stringify({ e: rep.body.canary.events }));
  ok(rep.body.cost.runs === 2 && rep.body.cost.unknownCostModels.includes("mystery-9000"),
    "cost is metered, and the unpriced model is named", JSON.stringify(rep.body.cost));
  ok(rep.body.alerts.total === 1 && String(rep.body.alerts.sinceLabel).includes("baseline promotion"),
    "alerts are counted since the previous baseline promotion", rep.body.alerts.sinceLabel);
  const suiteRow = rep.body.suites.find((s: any) => s.suite === "role_family");
  ok(suiteRow.p50Ms !== null && suiteRow.latencySamples === 100, "latency percentiles come from THIS sha's run", JSON.stringify({ p: suiteRow.p50Ms, n: suiteRow.latencySamples }));
  ok(!/\bPASSED\b/.test(rep.body.headline) && rep.body.headline.includes("159 of 180"),
    "the headline states what passed over how many — never a bare verdict word", rep.body.headline.slice(0, 70));

  console.log("\n── the 'what this does not cover' block ──");
  const nc = (rep.body.notCovered as string[]).join("\n");
  ok(nc.includes("JUDGE UNCALIBRATED"), "an uncalibrated judge is declared");
  ok(nc.includes("40 PROBE(S)") && nc.includes("NEVER certifies safety"), "the safety probe count carries the never-certifies caveat");
  ok(nc.includes("NO BASELINE ON") && nc.includes("geo"), "every suite without a baseline is named", nc.split("\n").find((l) => l.includes("NO BASELINE"))?.slice(0, 70));
  ok(nc.includes("apply_resolver"), "the silent suite is repeated in the limits block");
  ok(nc.includes("COST INCOMPLETE") && nc.includes("mystery-9000"), "the unpriced model makes the cost a declared FLOOR");
  ok(nc.includes("GOLDEN SUITES, NOT PRODUCTION"), "the block always ends with the scope of the whole report");
  cannot((rep.body.notCovered as string[]).length === 0, "the limits block is never empty");

  //  calibrate the judge and watch the caveat CHANGE (the block is derived, not hard-coded text)
  await sql`INSERT INTO calibrations (target, judge_model, kappa, n, agreement, details)
            VALUES (${T}, 'deepseek-chat', 0.71, 40, 0.86, '{}'::jsonb)`;
  const rep2 = await call("GET", `/api/report/${T}?sha=${SHA}`);
  const nc2 = (rep2.body.notCovered as string[]).join("\n");
  ok(!nc2.includes("JUDGE UNCALIBRATED") && nc2.includes("kappa 0.71") && nc2.includes("40 human-labelled"),
    "with a kappa the caveat becomes 'this is a sample', with the number", nc2.split("\n")[0]?.slice(0, 80));
  cannot(nc2.includes("JUDGE UNCALIBRATED"), "the uncalibrated warning does not survive a real calibration");
  await sql`DELETE FROM calibrations WHERE target = ${T}`;

  console.log("\n── GET /api/report/:target?format=md (paste-ready) ──");
  const mdRes = await call("GET", `/api/report/${T}?sha=${SHA}&format=md`);
  ok(mdRes.status === 200 && mdRes.contentType.startsWith("text/markdown"), "200 text/markdown", mdRes.contentType);
  const md = mdRes.text;
  ok(md.startsWith(`## Eval report — ${T} @ ${SHA}`), "a vault-pasteable heading", md.split("\n")[0]);
  ok(md.includes("### What this does not cover"), "the markdown carries the 'does not cover' block");
  ok(!/\bPASSED\b/.test(md), "THE MD NEVER PRINTS A BARE 'PASSED'", md.match(/\bPASSED\b/)?.[0] ?? "none found");
  cannot(/\bPASSED\b/.test(md.replace("Gate verdict", "PASSED")) === false, "the bare-PASSED probe CAN fail (planted word is caught)");
  ok(md.includes("| `role_family` |") && md.includes("80 / 100"), "the suite table names what passed over how many", "role_family 80/100");
  ok(md.includes("159 of 180"), "…and the headline does too");
  ok(md.includes("**Uncalibrated.**"), "the judge state is in the markdown");
  ok(md.includes("40 probe(s) in suite `safety_probes`") && md.includes("never certifies safety"), "so is the safety coverage sentence");
  ok(md.includes("SHADOW = REPLAY") && md.includes("CANARY = BLUE/GREEN"), "both words appear WITH their definition, never bare");
  ok(md.includes("**This is a floor:**"), "the cost section declares itself a floor when a model is unpriced");
  ok(md.includes("nearest-rank"), "the percentile definition travels with the latency table");
  ok(md.includes("| Suite | Score | Cases passed |"), "the suite table is real markdown");
  const noRunsMd = (await call("GET", `/api/report/${T}?sha=never_ran&format=md`)).text;
  ok(noRunsMd.includes("`no_runs`") && noRunsMd.includes("nothing was measured"),
    "a sha with no runs reports an ABSENCE of evidence, not a pass", noRunsMd.split("\n")[4]?.slice(0, 60));
  cannot(/verdict: `pass`/.test(noRunsMd), "a sha nobody evaluated does NOT read as a pass");
  const emptyRep = await call("GET", `/api/report/${EMPTY_T}`);
  ok(emptyRep.status === 200 && emptyRep.body.verdict === "no_runs" && emptyRep.body.sha === null,
    "a target that never ran anything reports no_runs with no sha", JSON.stringify({ v: emptyRep.body.verdict, s: emptyRep.body.sha }));
  const autoSha = await call("GET", `/api/report/${T}`);
  ok(autoSha.body.shaSource === "latest_finished_run" && typeof autoSha.body.sha === "string",
    "with no ?sha the report picks the latest finished run AND declares the substitution", autoSha.body.shaSource);

  // ══ DASHBOARD ══════════════════════════════════════════════════════════════════════════════
  console.log("\n── the dashboard carries shadow + canary (additively) ──");
  const dash = await call("GET", `/api/dashboard/${T}`);
  ok(dash.status === 200 && dash.body.shadow.last !== null, "dashboardData() supplies `shadow`", dash.body.shadow.last?.recommendation);
  ok(dash.body.canary.events.length === 3, "…and the canary transitions", dash.body.canary.events.length);
  ok(dash.body.suites !== undefined && dash.body.alerts !== undefined && dash.body.calibration !== undefined
     && dash.body.curves !== undefined && dash.body.ab !== undefined,
    "every pre-existing dashboard key is still there (additive only)");
  const emptyDash = await call("GET", `/api/dashboard/${EMPTY_T}`);
  ok(emptyDash.body.shadow.last === null && emptyDash.body.canary.events.length === 0,
    "a target with neither is empty (the page drops the section)", JSON.stringify({ s: emptyDash.body.shadow.last, c: emptyDash.body.canary.events.length }));

  console.log("\n── GET /dashboard/:target (HTML) with the new section POPULATED ──");
  const htmlRes = await call("GET", `/dashboard/${T}?token=${encodeURIComponent(TOKEN)}`, undefined, null);
  ok(htmlRes.status === 200 && htmlRes.contentType.startsWith("text/html"), "200 text/html", htmlRes.contentType);
  const html = htmlRes.text;
  ok(html.includes("Shadow &amp; canary"), "the new section is in the markup");
  ok(html.includes("worse1") && html.includes("rollback"), "the shadow candidate and the canary phases are embedded in the data");
  ok(html.includes("BLUE/GREEN") && html.includes("SHADOW = REPLAY"), "both definitions travel with the page");
  ok(html.includes("meanDeltaBlock"), "the thresholds applied are embedded, not implied");
  //  THE EXTERNAL-REQUEST CHECK, on the SERVED BYTES, WITH the new section present.
  const schemes = html.match(/[a-z][a-z0-9+.-]*:\/\//gi) ?? [];
  ok(schemes.length === 0, "ZERO scheme-like strings (…://) in the served HTML", schemes.length === 0 ? "none" : JSON.stringify(schemes.slice(0, 5)));
  const protoRel = html.match(/(?:src|href)\s*=\s*["']\/\//gi) ?? [];
  ok(protoRel.length === 0, "no protocol-relative src/href either", protoRel.length);
  // NOT "no src/href at all" any more (2026-08-05). The page MUST load its script from a
  // same-origin src: the vhost sends `script-src 'self'` with no 'unsafe-inline', so an inline
  // script is silently dropped and the page renders a dead shell. The invariant that actually
  // protects anyone is that nothing is fetched from a THIRD PARTY — so that is what is asserted,
  // plus the positive requirement that the script really is external and really is same-origin.
  const offOrigin = (html.replace(/href="?#/g, "").match(/\b(?:src|href)\s*=\s*["'](?![\/][^\/])[^"']*/gi) ?? []);
  ok(offOrigin.length === 0, "no OFF-ORIGIN src/href — nothing is fetched from a third party", JSON.stringify(offOrigin.slice(0, 3)));
  ok(/<script[^>]+\bsrc\s*=\s*["']\/[^\/]/i.test(html), "the page's script IS loaded from a same-origin src (CSP 'self' runs it)");
  ok(!DOM_HTML_RE.test(html), `no .${DOM_HTML_PROP} anywhere in the page script`);
  const poisoned = html.replace("</head>", '<link rel="stylesheet" href="https://cdn.example.com/x.css"></head>');
  cannot((poisoned.match(/[a-z][a-z0-9+.-]*:\/\//gi) ?? []).length === 0, "the external-URL check CATCHES a planted CDN link (the probe can fail)");
  const poisoned2 = html.replace("</body>", `<script>node.${DOM_HTML_PROP}=x</script></body>`);
  cannot(!DOM_HTML_RE.test(poisoned2), `the .${DOM_HTML_PROP} check CATCHES a planted assignment (the probe can fail)`);
  console.log(`  NOTE  served dashboard HTML: ${Buffer.byteLength(html, "utf8")} bytes`);

  const emptyHtml = (await call("GET", `/dashboard/${EMPTY_T}?token=${encodeURIComponent(TOKEN)}`, undefined, null)).text;
  ok(emptyHtml.includes(`"last":null`) && emptyHtml.includes(`"events":[]`),
    "the empty target's page carries empty blocks — the script removes the section at render");
} catch (e) {
  console.error("\n  FAIL  unexpected exception:", e);
  fail++;
} finally {
  await app.close();
  if (!createdDb) {
    try {
      await sql`DELETE FROM shadow_pairs WHERE run_id IN (SELECT id FROM shadow_runs WHERE target = ${T})`;
      await sql`DELETE FROM shadow_runs WHERE target = ${T}`;
      await sql`DELETE FROM canary_events WHERE target IN (${T}, ${EMPTY_T})`;
      await sql`DELETE FROM alerts WHERE target = ${T}`;
      await sql`DELETE FROM model_runs WHERE target = ${T}`;
      await sql`DELETE FROM baselines WHERE target = ${T}`;
      await sql`DELETE FROM targets WHERE name IN (${T}, ${EMPTY_T})`;
    } catch (e) { console.error("cleanup failed:", e); }
  }
  await sql.end({ timeout: 5 });
  if (createdDb) {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`);
      console.log(`\n[phase4] dropped throwaway database ${DBNAME}`);
    } catch (e) { console.error(`\n[phase4] COULD NOT DROP ${DBNAME}:`, String((e as Error).message)); fail++; }
  }
  await admin.end({ timeout: 5 });
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — shadow replay lifecycle + verdict math, canary vocabulary + listing, report JSON/MD with its limits block, dashboard section");
process.exit(fail ? 1 : 0);
