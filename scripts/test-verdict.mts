// Pure unit tests for src/verdict.ts — NO database, no server, no env. If this file needs a DB,
// the verdict math has leaked out of the pure layer and that is itself the bug.
import {
  aggregateRun, buildRunVerdict, gateVerdict, isRegression, readScoringMode,
  regressionPctFromEnv, round2, DEFAULT_REGRESSION_PCT, MAX_FAILURES_RETURNED,
} from "../src/verdict.js";

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};

const cases = (n: number, passing: number, score: number | null = null) =>
  Array.from({ length: n }, (_, i) => ({ caseId: `c${i}`, pass: i < passing, score }));

console.log("\n── aggregation + rounding ──");
{
  const a = aggregateRun(cases(200, 197));
  ok(a.score === 98.5 && a.total === 200 && a.passed === 197, "197/200 → 98.5", a.score);
  const b = aggregateRun(cases(3, 2));
  ok(b.score === 66.67, "2/3 → 66.67 (2dp, rounded not truncated)", b.score);
  const c = aggregateRun(cases(3, 1));
  ok(c.score === 33.33, "1/3 → 33.33", c.score);
  ok(aggregateRun([]).score === 0, "empty run scores 0, never 100", aggregateRun([]).score);
  ok(aggregateRun(cases(7, 7)).score === 100, "7/7 → 100");
  ok(round2(1.005) === 1.01, "round2 lifts the .005 boundary up", round2(1.005));
  ok(round2(-1.0) === -1, "round2 keeps exact negatives exact", round2(-1.0));
}

console.log("\n── meta.scoring override ──");
{
  ok(readScoringMode(undefined) === "pass_rate", "no meta → pass_rate");
  ok(readScoringMode({ scoring: "mean_score" }) === "mean_score", "meta.scoring honoured");
  ok(readScoringMode({ scoring: "nonsense" }) === "pass_rate", "unknown scoring → default, not a crash");
  const m = aggregateRun(
    [{ caseId: "a", pass: true, score: 90 }, { caseId: "b", pass: false, score: 70 }],
    { scoring: "mean_score" }
  );
  ok(m.score === 80 && m.scoring === "mean_score", "mean_score averages the case scores", m.score);
  const fb = aggregateRun(cases(4, 2), { scoring: "mean_score" });
  ok(fb.score === 50 && fb.scoring === "pass_rate", "mean_score with no numeric scores falls back to pass_rate, and SAYS so", `${fb.score}/${fb.scoring}`);
}

console.log("\n── regression rule (the threshold edge) ──");
{
  ok(isRegression(98.5, 99.5, 1.0) === false, "exactly AT the threshold is NOT a regression (99.5→98.5, pct 1.0)");
  ok(isRegression(98.49, 99.5, 1.0) === true, "one hundredth beyond the threshold IS a regression");
  ok(isRegression(98.4, 99.5, 1.0) === true, "clearly beyond → regression");
  ok(isRegression(99.9, 99.5, 1.0) === false, "an improvement is never a regression");
  ok(isRegression(0, null, 1.0) === false, "missing baseline → false, even at score 0 (first run passes)");
  ok(isRegression(50, 100, 0) === true, "pct 0 → any drop regresses");
  ok(isRegression(100, 100, 0) === false, "pct 0 → an equal score does not regress");
  ok(DEFAULT_REGRESSION_PCT === 1.0, "contract default tolerance is 1.0");
  ok(regressionPctFromEnv({} as NodeJS.ProcessEnv) === 1.0, "no env → 1.0");
  ok(regressionPctFromEnv({ EVALHUB_REGRESSION_PCT: "2.5" } as NodeJS.ProcessEnv) === 2.5, "env honoured");
  ok(regressionPctFromEnv({ EVALHUB_REGRESSION_PCT: "banana" } as NodeJS.ProcessEnv) === 1.0, "unparseable env → default, not NaN");
}

console.log("\n── run verdict assembly ──");
{
  const v = buildRunVerdict({
    runId: "r1", suite: "role_family", score: 98.5, total: 200, passed: 197,
    baseline: { score: 99.5, runId: "r0" }, failures: ["a", "b", "c"], pct: 1.0,
  });
  ok(v.delta === -1, "delta = score - baseline", v.delta);
  ok(v.regression === false, "at-threshold verdict is not a regression");
  ok(v.baseline?.runId === "r0", "baseline ref carries the run it came from");
  const none = buildRunVerdict({ runId: "r1", suite: "s", score: 12, total: 1, passed: 0, baseline: null, failures: [], pct: 1 });
  ok(none.delta === null && none.regression === false, "missing baseline → delta null, regression false");
  const many = buildRunVerdict({
    runId: "r1", suite: "s", score: 0, total: 30, passed: 0, baseline: null,
    failures: Array.from({ length: 30 }, (_, i) => `f${i}`), pct: 1,
  });
  ok(many.failures.length === MAX_FAILURES_RETURNED, "failures capped at 20", many.failures.length);
  ok(many.failuresTotal === 30 && many.failuresTruncated === true, "the cap is DECLARED, not silent", `${many.failuresTotal}/${many.failuresTruncated}`);
}

console.log("\n── gate verdict precedence ──");
{
  const s = (suite: string, regression: boolean) => ({ suite, runId: "r", score: 1, baseline: null, regression });
  ok(gateVerdict([]) === "no_runs", "no finished runs → no_runs (never 'pass')");
  ok(gateVerdict([s("a", false), s("b", false)]) === "pass", "all clean → pass");
  ok(gateVerdict([s("a", false), s("b", true)]) === "fail", "ANY regression → fail");
  ok(gateVerdict([s("a", true)]) === "fail", "single regression → fail");
}

console.log("\n── negative controls (prove these assertions can FAIL) ──");
{
  // Each line asserts that the WRONG expectation is indeed wrong. If the math were broken such
  // that the wrong answer were produced, these flip and the suite goes red — which is the point:
  // a test that cannot fail proves nothing.
  ok(aggregateRun(cases(3, 2)).score !== 66.66, "negative control: 2/3 is NOT 66.66 (truncation would break this)");
  ok(isRegression(98.5, 99.5, 1.0) !== true, "negative control: the at-threshold case is NOT a regression");
  ok(gateVerdict([]) !== "pass", "negative control: an empty gate is NOT a pass");
  ok(aggregateRun([]).score !== 100, "negative control: an empty run is NOT 100");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — verdict math holds (pure layer)");
process.exit(fail ? 1 : 0);
