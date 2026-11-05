// Full-lifecycle test for the Eval Hub HTTP service. Boots the REAL server on a random port
// against a REAL database and drives it over HTTP — no mocks, because a mocked dispatcher proves
// nothing about the thing that ships.
//
// If EVALHUB_DATABASE_URL is absent this prints a LOUD SKIP and exits 0 WITHOUT claiming a pass.
// A green line that never touched a database is a lie; there is no fake-pass path in this file.
import type { AddressInfo } from "node:net";
import { makeSql } from "../src/db.js";
import { ensureSchema } from "../src/ensure-schema.js";
import { buildServer } from "../src/server.js";

const DB = process.env.EVALHUB_DATABASE_URL || "";
if (!DB) {
  console.log("\n" + "=".repeat(78));
  console.log("  SKIP  scripts/test-hub.mts — EVALHUB_DATABASE_URL is NOT SET.");
  console.log("  NOTHING WAS TESTED. This is not a pass. The DB-backed lifecycle, the 502 write");
  console.log("  law, auth rejection and the gate were all skipped.");
  console.log("  Run:  EVALHUB_DATABASE_URL=postgres://…/evalhub_test npx tsx scripts/test-hub.mts");
  console.log("=".repeat(78) + "\n");
  process.exit(0);
}

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
/**
 * NEGATIVE CONTROL. Asserts that a DELIBERATELY WRONG expectation is indeed false — proving the
 * check in question is capable of failing before we assert the correct one. If the wrong
 * expectation ever holds, this line goes red exactly like a real failure.
 */
const cannot = (wrongCondition: boolean, what: string) => {
  console.log(`  ${!wrongCondition ? "PASS" : "FAIL"}  [neg-control] ${what}`);
  if (wrongCondition) fail++;
};

const TOKEN = "test-token-" + Math.random().toString(36).slice(2, 10);
const TARGET = "test_target_" + Math.random().toString(36).slice(2, 8);
const SUITE = "role_family";
const SHA1 = "sha1_" + Math.random().toString(36).slice(2, 8);
const SHA2 = "sha2_" + Math.random().toString(36).slice(2, 8);
const SHA3 = "sha3_" + Math.random().toString(36).slice(2, 8);

const sql = makeSql(DB);
await ensureSchema(sql);
const app = buildServer({ sql, token: TOKEN, regressionPct: 1.0 });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;
console.log(`\n[hub-test] server on ${BASE}, target ${TARGET}\n`);

type Res<T> = { status: number; body: T };
async function call<T = any>(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Res<T>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-evalhub-token"] = token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { parsed = { error: "non_json" }; }
  return { status: res.status, body: parsed as T };
}
const mkCases = (n: number, passing: number) =>
  Array.from({ length: n }, (_, i) => ({ caseId: `case_${i}`, pass: i < passing, latencyMs: 5, tags: ["det"] }));

async function runSuite(sha: string, total: number, passing: number) {
  const r = await call("POST", "/api/runs", { target: TARGET, suite: SUITE, gitSha: sha });
  const runId = (r.body as any).runId as string;
  const all = mkCases(total, passing);
  for (let i = 0; i < all.length; i += 150) {
    const batch = all.slice(i, i + 150);
    const p = await call("POST", `/api/runs/${runId}/results`, { results: batch });
    if (p.status !== 200) throw new Error(`results batch failed: ${p.status} ${JSON.stringify(p.body)}`);
  }
  const fin = await call("POST", `/api/runs/${runId}/finish`, {});
  return { runId, fin };
}

try {
  // ── auth ──────────────────────────────────────────────────────────────────────────────────
  console.log("── auth ──");
  ok((await call("GET", "/api/health", undefined, "wrong-token")).status === 401, "bad token → 401");
  ok((await call("GET", "/api/health", undefined, null)).status === 401, "missing token → 401");
  ok((await call("GET", "/api/health", undefined, TOKEN.slice(0, -1))).status === 401, "token of the wrong LENGTH → 401 (no early-exit leak)");
  const health = await call("GET", "/api/health");
  ok(health.status === 200 && (health.body as any).db === "up", "good token → 200 {db:'up'}", JSON.stringify(health.body));
  cannot((await call("GET", "/api/health", undefined, "wrong-token")).status === 200, "a wrong token does NOT get 200");

  // ── targets + runs ────────────────────────────────────────────────────────────────────────
  console.log("\n── targets + runs ──");
  const t = await call("POST", "/api/targets", { name: TARGET, kind: "product" });
  ok(t.status === 200 && (t.body as any).target === TARGET, "create target", t.status);
  const t2 = await call("POST", "/api/targets", { name: TARGET, kind: "product" });
  ok(t2.status === 200, "target upsert is idempotent", t2.status);
  ok((await call("POST", "/api/targets", { kind: "product" })).status === 400, "target without a name → 400");
  const bad = await call("POST", "/api/runs", { target: "no_such_target_xyz", suite: SUITE, gitSha: SHA1 });
  ok(bad.status === 400 && (bad.body as any).error === "unknown_target", "run against an unknown target → 400, never auto-created", bad.status);
  const r0 = await call("POST", "/api/runs", { target: TARGET, suite: SUITE, gitSha: SHA1 });
  ok(r0.status === 200 && typeof (r0.body as any).runId === "string", "create run → runId", (r0.body as any).runId);

  // ── results (incl. batching + caps) ───────────────────────────────────────────────────────
  console.log("\n── results ──");
  const runId0 = (r0.body as any).runId as string;
  // ONE suite of 200 cases (case_0..case_199, only case_199 failing) posted as TWO batches — the
  // ids must stay globally unique across batches or the failure list names the wrong case.
  const suite200 = mkCases(200, 199);
  const p1 = await call("POST", `/api/runs/${runId0}/results`, { results: suite200.slice(0, 150) });
  ok(p1.status === 200 && (p1.body as any).inserted === 150, "batch of 150 → inserted 150", JSON.stringify(p1.body));
  const p2 = await call("POST", `/api/runs/${runId0}/results`, { results: suite200.slice(150) });
  ok(p2.status === 200 && (p2.body as any).inserted === 50, "second batch → inserted 50");
  const tooBig = await call("POST", `/api/runs/${runId0}/results`, { results: mkCases(501, 501) });
  ok(tooBig.status === 413, "batch of 501 → 413, refused not silently trimmed", tooBig.status);
  ok((await call("POST", `/api/runs/00000000-0000-0000-0000-000000000000/results`, { results: [] })).status === 404, "results for an unknown run → 404");

  // ── THE WRITE LAW: a partly-failed batch must never answer 200 {ok:true} ──────────────────
  console.log("\n── never-lie-on-writes (502) ──");
  const beforeRows = Number((await sql`SELECT count(*)::int AS n FROM results WHERE run_id = ${runId0}::uuid`)[0]!.n);
  // latency_ms is int4; 3e9 overflows it at the DB. One row of three is unwritable.
  const mixed = await call("POST", `/api/runs/${runId0}/results`, {
    results: [
      { caseId: "w_ok_1", pass: true, latencyMs: 1 },
      { caseId: "w_bad", pass: true, latencyMs: 3_000_000_000 },
      { caseId: "w_ok_2", pass: true, latencyMs: 1 },
    ],
  });
  ok(mixed.status === 502, "a batch with an unwritable row → 502, NOT 200", mixed.status);
  ok((mixed.body as any).ok === false, "…and ok:false");
  ok((mixed.body as any).received === 3 && (mixed.body as any).inserted === 2 && (mixed.body as any).failed === 1,
    "…with EXACT counts received/inserted/failed", JSON.stringify(mixed.body));
  ok(Array.isArray((mixed.body as any).errors) && (mixed.body as any).errors.length > 0, "…and the real DB error is surfaced");
  const afterRows = Number((await sql`SELECT count(*)::int AS n FROM results WHERE run_id = ${runId0}::uuid`)[0]!.n);
  ok(afterRows === beforeRows + 2, "the reported 'inserted' matches the rows actually in the DB", `${beforeRows}→${afterRows}`);
  cannot((mixed.body as any).ok === true, "a failed batch does NOT report ok:true");
  // clean the write-law rows so they don't skew the run's score
  await sql`DELETE FROM results WHERE run_id = ${runId0}::uuid AND case_id LIKE 'w\\_%'`;

  // ── finish + verdict math ─────────────────────────────────────────────────────────────────
  console.log("\n── finish / verdict ──");
  const f0 = await call("POST", `/api/runs/${runId0}/finish`, {});
  const v0 = f0.body as any;
  ok(f0.status === 200, "finish → 200", f0.status);
  cannot(v0.score === 99.99, "the finish score is NOT 99.99 (this check can fail)");
  ok(v0.total === 200 && v0.passed === 199, "totals come from the RESULT ROWS, not the client", `${v0.passed}/${v0.total}`);
  ok(v0.score === 99.5, "199/200 → score 99.5", v0.score);
  ok(v0.baseline === null && v0.delta === null, "no baseline yet → baseline null, delta null");
  ok(v0.regression === false, "first run is never a regression (promotion creates the bar)");
  ok(v0.failures.length === 1 && v0.failures[0] === "case_199", "the failing caseId is named", JSON.stringify(v0.failures));
  ok(v0.failuresTruncated === false, "1 failure → not truncated");
  ok((await call("POST", `/api/runs/${runId0}/results`, { results: mkCases(1, 1) })).status === 409, "posting results to a FINISHED run → 409");

  // ── gate before any baseline ──────────────────────────────────────────────────────────────
  console.log("\n── gate ──");
  const g1 = await call("GET", `/api/gate/${TARGET}?sha=${SHA1}`);
  ok(g1.status === 200 && (g1.body as any).verdict === "pass", "gate on the first finished sha → pass", (g1.body as any).verdict);
  const gNone = await call("GET", `/api/gate/${TARGET}?sha=sha_that_never_ran`);
  ok((gNone.body as any).verdict === "no_runs", "gate on a sha with no runs → no_runs", (gNone.body as any).verdict);
  cannot((gNone.body as any).verdict === "pass", "a sha with no eval runs does NOT pass");
  ok((await call("GET", `/api/gate/${TARGET}`)).status === 400, "gate without ?sha → 400");

  // ── promote ───────────────────────────────────────────────────────────────────────────────
  console.log("\n── promote ──");
  const pr = await call("POST", "/api/baselines/promote", { target: TARGET, suite: SUITE, runId: runId0 });
  ok(pr.status === 200 && (pr.body as any).score === 99.5, "promote the 99.5 run → baseline 99.5", JSON.stringify(pr.body));
  const prMismatch = await call("POST", "/api/baselines/promote", { target: TARGET, suite: "other_suite", runId: runId0 });
  ok(prMismatch.status === 400, "promote with a mismatched suite → 400, never silently rebranded", prMismatch.status);

  // ── regression: exactly AT the threshold, then beyond it ──────────────────────────────────
  console.log("\n── regression rule against a live baseline (99.5, tolerance 1.0) ──");
  const at = await runSuite(SHA2, 200, 197); // 98.5 → exactly 1.0 below
  const vAt = at.fin.body as any;
  ok(vAt.score === 98.5 && vAt.baseline.score === 99.5, "second run 98.5 vs baseline 99.5", `${vAt.score}/${vAt.baseline.score}`);
  ok(vAt.delta === -1, "delta -1.00", vAt.delta);
  cannot(vAt.regression === true, "a drop of EXACTLY the tolerance is NOT flagged (this check can fail)");
  ok(vAt.regression === false, "…so regression is false");
  ok((await call("GET", `/api/gate/${TARGET}?sha=${SHA2}`)).body.verdict === "pass", "gate at threshold → pass");

  const beyond = await runSuite(SHA3, 200, 196); // 98.0 → 1.5 below
  const vB = beyond.fin.body as any;
  ok(vB.score === 98 && vB.delta === -1.5, "third run 98.0, delta -1.50", `${vB.score}/${vB.delta}`);
  ok(vB.regression === true, "beyond the tolerance → regression TRUE");
  ok(vB.failures.length === 4 && vB.failuresTotal === 4, "4 failing cases listed", JSON.stringify(vB.failures));
  const g3 = await call("GET", `/api/gate/${TARGET}?sha=${SHA3}`);
  ok(g3.body.verdict === "fail", "gate on the regressed sha → fail", g3.body.verdict);
  cannot(g3.body.verdict === "pass", "a regressed sha does NOT pass the gate");
  ok(g3.body.suites[0].baseline === 99.5 && g3.body.suites[0].regression === true, "gate reports the suite's baseline + regression flag", JSON.stringify(g3.body.suites[0].suite));
  ok(g3.body.suites[0].failuresTotal === 4 && g3.body.suites[0].failures.length === 4,
    "gate names the failing cases for a regressed suite (no re-finish needed)", JSON.stringify(g3.body.suites[0].failures));
  const gPass = await call("GET", `/api/gate/${TARGET}?sha=${SHA2}`);
  ok(gPass.body.suites[0].failures === undefined, "a passing suite carries no failure list (read path stays cheap)");
  // A read must not mutate: the gate is queried twice and the run's finished_at must not move.
  const fin1 = (await sql`SELECT finished_at FROM runs WHERE id = ${beyond.runId}::uuid`)[0]! as any;
  await call("GET", `/api/gate/${TARGET}?sha=${SHA3}`);
  const fin2 = (await sql`SELECT finished_at FROM runs WHERE id = ${beyond.runId}::uuid`)[0]! as any;
  ok(String(fin1.finished_at) === String(fin2.finished_at), "querying the gate does NOT rewrite finished_at");

  // ── promote must not ratchet the bar DOWN by accident ─────────────────────────────────────
  console.log("\n── baseline ratchet ──");
  const down = await call("POST", "/api/baselines/promote", { target: TARGET, suite: SUITE, runId: beyond.runId });
  ok(down.status === 409 && (down.body as any).error === "below_baseline", "promoting a WORSE run → 409 below_baseline", down.status);
  cannot(down.status === 200, "a worse run is NOT silently promoted");
  const forced = await call("POST", "/api/baselines/promote", { target: TARGET, suite: SUITE, runId: beyond.runId, force: true });
  ok(forced.status === 200 && (forced.body as any).score === 98 && (forced.body as any).forced === true, "…but {force:true} lowers it deliberately", JSON.stringify(forced.body));
  const b = await sql`SELECT score::float8 AS score FROM baselines WHERE target = ${TARGET} AND suite = ${SUITE}`;
  ok(Number(b[0]!.score) === 98, "the DB baseline really moved to 98", b[0]!.score);

  // ── truncation is declared, never silent ──────────────────────────────────────────────────
  console.log("\n── failure-list truncation is declared ──");
  const big = await runSuite("sha_many_" + Math.random().toString(36).slice(2, 6), 40, 5); // 35 failures
  const vBig = big.fin.body as any;
  ok(vBig.failures.length === 20 && vBig.failuresTotal === 35 && vBig.failuresTruncated === true,
    "35 failures → 20 returned, total 35, truncated:true", JSON.stringify({ n: vBig.failures.length, t: vBig.failuresTotal }));
  cannot(vBig.failuresTruncated === false, "a truncated list does NOT claim to be complete");
} catch (e) {
  console.error("\n  FAIL  unexpected exception:", e);
  fail++;
} finally {
  // cascade-clean everything this test created
  try { await sql`DELETE FROM targets WHERE name = ${TARGET}`; } catch (e) { console.error("cleanup failed:", e); }
  await app.close();
  await sql.end({ timeout: 5 });
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — hub lifecycle, write law, auth, verdict + gate hold");
process.exit(fail ? 1 : 0);
