// Eval Hub — verdict math. PURE functions only: no DB, no env reads, no clock.
// Everything the hub decides (a run's score, whether it regressed, whether a sha may ship) is
// decided here so it can be unit-tested without a database. The HTTP layer only fetches rows and
// hands them to these functions. Contract v0 §"DB schema" + §"HTTP API".

/** Round to 2 decimal places. The contract's scores are all 2dp; float drift is not a verdict. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type ScoringMode = "pass_rate" | "mean_score";

/** A single case result as it matters to aggregation. */
export type ScoredResult = { caseId: string; pass: boolean; score: number | null };

export type RunAggregate = { total: number; passed: number; score: number; scoring: ScoringMode };

/**
 * Aggregate score of a run = passed/total*100 rounded 2dp UNLESS meta.scoring says otherwise
 * (contract v0). The one alternative in v0 is `mean_score`: the mean of the per-case `score`
 * values (already on the caller's own scale), 2dp. If `mean_score` is asked for but no case
 * carried a numeric score, we fall back to the pass rate rather than inventing a number —
 * and say so in the returned `scoring` field, so the caller can see the fallback happened.
 * An empty run scores 0: zero of zero cases passed is not "100%".
 */
export function aggregateRun(results: ScoredResult[], meta?: unknown): RunAggregate {
  const total = results.length;
  const passed = results.reduce((n, r) => n + (r.pass ? 1 : 0), 0);
  const asked = readScoringMode(meta);
  if (asked === "mean_score") {
    const nums = results.map((r) => r.score).filter((s): s is number => typeof s === "number" && Number.isFinite(s));
    if (nums.length > 0) {
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      return { total, passed, score: round2(mean), scoring: "mean_score" };
    }
    // no numeric scores → honest fallback, reported as pass_rate
  }
  const score = total === 0 ? 0 : round2((passed / total) * 100);
  return { total, passed, score, scoring: "pass_rate" };
}

/** meta.scoring is product-supplied JSON; anything we don't recognise means "the default". */
export function readScoringMode(meta: unknown): ScoringMode {
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const s = (meta as Record<string, unknown>).scoring;
    if (s === "mean_score" || s === "pass_rate") return s;
  }
  return "pass_rate";
}

export const DEFAULT_REGRESSION_PCT = 1.0;

/** EVALHUB_REGRESSION_PCT, defaulting to 1.0. Kept out of the pure functions on purpose. */
export function regressionPctFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EVALHUB_REGRESSION_PCT;
  if (raw === undefined || raw === "") return DEFAULT_REGRESSION_PCT;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_REGRESSION_PCT;
}

/**
 * Regression rule v0: baseline exists AND score < baseline.score - pct → regression.
 * EXACTLY at the threshold is NOT a regression (strict `<`): a suite that drops precisely the
 * tolerated amount is tolerated, by definition of the tolerance.
 * Missing baseline → false. The first run must pass; promotion is what creates the bar.
 */
export function isRegression(score: number, baselineScore: number | null, pct: number): boolean {
  if (baselineScore === null || baselineScore === undefined) return false;
  return round2(score) < round2(baselineScore - pct);
}

export type BaselineRef = { score: number; runId: string };

export type RunVerdict = {
  ok: true;
  runId: string;
  suite: string;
  score: number;
  total: number;
  passed: number;
  baseline: BaselineRef | null;
  delta: number | null;
  regression: boolean;
  failures: string[];
  /** No silent caps (estate law): if the failure list was cut, the caller is told, with the true count. */
  failuresTotal: number;
  failuresTruncated: boolean;
};

export const MAX_FAILURES_RETURNED = 20;

/** Assemble the finish/verdict payload from already-aggregated numbers. Pure. */
export function buildRunVerdict(input: {
  runId: string;
  suite: string;
  score: number;
  total: number;
  passed: number;
  baseline: BaselineRef | null;
  failures: string[];
  pct: number;
}): RunVerdict {
  const score = round2(input.score);
  const baseline = input.baseline ? { score: round2(input.baseline.score), runId: input.baseline.runId } : null;
  const delta = baseline ? round2(score - baseline.score) : null;
  const failuresTotal = input.failures.length;
  const failures = input.failures.slice(0, MAX_FAILURES_RETURNED);
  return {
    ok: true,
    runId: input.runId,
    suite: input.suite,
    score,
    total: input.total,
    passed: input.passed,
    baseline,
    delta,
    regression: isRegression(score, baseline ? baseline.score : null, input.pct),
    failures,
    failuresTotal,
    failuresTruncated: failuresTotal > failures.length,
  };
}

export type GateSuite = {
  suite: string;
  runId: string;
  score: number;
  baseline: number | null;
  regression: boolean;
  /** Populated only for regressed suites, so the gate CLI can name the broken cases without
   *  re-POSTing /finish (a read path must never rewrite finished_at). Capped + declared. */
  failures?: string[];
  failuresTotal?: number;
  failuresTruncated?: boolean;
};
export type GateVerdict = "pass" | "fail" | "no_runs";

/**
 * Gate precedence (contract v0): no finished runs for the sha → 'no_runs' (a deploy without evals
 * must fail LOUDLY, not slip); otherwise ANY regressed suite → 'fail'; else 'pass'.
 */
export function gateVerdict(suites: GateSuite[]): GateVerdict {
  if (suites.length === 0) return "no_runs";
  return suites.some((s) => s.regression) ? "fail" : "pass";
}
