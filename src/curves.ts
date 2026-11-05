// Eval Hub — cost/quality curves (Phase 3b addendum §2, item 9).
//
// TWO layers, same separation as stats.ts:
//   1. PURE MATH — paretoFrontier(), aggregateModelRuns(). No DB, no env, no clock. Unit-tested in
//      scripts/test-curves.mts.
//   2. QUERY LAYER — modelCurvesFor(): fetches rows, hands them to (1), decides nothing.
//
// THE FRONTIER IS COMPUTED, NEVER ASSERTED. A model is on the frontier iff NO other model is at
// least as good on BOTH axes and strictly better on one:
//     dominates(a, b)  ⟺  a.score >= b.score AND a.cost <= b.cost AND (a.score > b.score OR a.cost < b.cost)
// b is on the frontier iff no a dominates it. Two models with IDENTICAL (score, cost) do not
// dominate each other, so BOTH stay on the frontier — a tie is a tie, not a coin toss.
//
// A model whose cost is UNKNOWN is NOT placed on the frontier and NOT silently dropped: it comes
// back in `unpriced` with its reason. Calling an unknown cost 0 would crown the unpriced model.
import type { Sql } from "./db.js";
import { computeCost, priceFor, type CostSource, type PriceEntry } from "./pricing.js";
import { percentile } from "./stats.js";
import { round2 } from "./verdict.js";

// ── 1. PURE MATH ──────────────────────────────────────────────────────────────────────────────

/** The minimum a point needs to be placed on the (cost, score) plane. */
export type FrontierPoint = { model: string; meanScore: number; costPer100Cases: number };

/** True iff `a` dominates `b`: at least as good on both axes, strictly better on one. */
export function dominates(a: FrontierPoint, b: FrontierPoint): boolean {
  const scoreAtLeast = a.meanScore >= b.meanScore;
  const costAtMost = a.costPer100Cases <= b.costPer100Cases;
  const strictly = a.meanScore > b.meanScore || a.costPer100Cases < b.costPer100Cases;
  return scoreAtLeast && costAtMost && strictly;
}

/**
 * The Pareto-optimal subset on (score ↑, cost ↓), in the input order.
 * Empty in → empty out. One point in → that point (nothing can dominate it).
 * O(n²) on purpose: n is the number of models a product sweeps (single digits), and the naive
 * double loop is the version a reader can check against the definition above.
 */
export function paretoFrontier<T extends FrontierPoint>(points: readonly T[]): T[] {
  const usable = points.filter((p) => Number.isFinite(p.meanScore) && Number.isFinite(p.costPer100Cases));
  return usable.filter((b) => !usable.some((a) => a !== b && dominates(a, b)));
}

/** One recorded model_run, as the math needs it. */
export type ModelRunRow = {
  model: string;
  provider: string | null;
  cases: number;
  score: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  costSource: CostSource;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
};

export type ModelCurve = {
  model: string;
  provider: string | null;
  runs: number;
  meanScore: number;
  /** Mean cost of ONE run. null when no run of this model had a cost. */
  meanCostUsd: number | null;
  /** The comparable axis: cost normalised to 100 cases. null when cost or cases are unknown. */
  costPer100Cases: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** 'table' | 'reported' | 'unknown' — 'mixed' when the runs disagree, never quietly flattened. */
  costSource: CostSource | "mixed";
  /** Total cases behind meanScore. A 96.0 from 5 cases must not read like a 96.0 from 500. */
  sampleCases: number;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Present when costPer100Cases is null — the reader is told WHY, never left with a blank. */
  costReason?: string;
  /** The price-table entry, so the page can print its date and source. */
  price?: PriceEntry;
  /** True when this model sits on the computed Pareto frontier. */
  frontier: boolean;
};

/**
 * Group runs by model and build one curve point per model.
 * meanScore is CASE-WEIGHTED (a 200-case run counts twice a 100-case run) — the alternative,
 * a flat mean of run scores, lets one tiny run swing the model's position on the plane.
 */
export function aggregateModelRuns(rows: readonly ModelRunRow[]): { models: ModelCurve[]; frontier: string[]; unpriced: { model: string; reason: string }[] } {
  const byModel = new Map<string, ModelRunRow[]>();
  for (const r of rows) {
    const list = byModel.get(r.model);
    if (list) list.push(r); else byModel.set(r.model, [r]);
  }

  const models: ModelCurve[] = [];
  for (const [model, runs] of byModel) {
    const cases = runs.reduce((a, r) => a + (Number.isFinite(r.cases) ? r.cases : 0), 0);
    const weighted = runs.reduce((a, r) => a + (Number.isFinite(r.score) ? r.score : 0) * (Number.isFinite(r.cases) ? r.cases : 0), 0);
    // Case-weighted where cases exist; otherwise the flat mean of the run scores, stated by the
    // sampleCases field being 0 rather than by a hidden branch.
    const meanScore = cases > 0 ? round2(weighted / cases) : round2(runs.reduce((a, r) => a + r.score, 0) / Math.max(1, runs.length));

    const costed = runs.filter((r) => r.costUsd !== null && Number.isFinite(r.costUsd as number));
    const meanCostUsd = costed.length ? round6(costed.reduce((a, r) => a + (r.costUsd as number), 0) / costed.length) : null;

    // cost per 100 cases uses ONLY the runs that have both a cost and a case count.
    const comparable = costed.filter((r) => Number.isFinite(r.cases) && r.cases > 0);
    const totalCost = comparable.reduce((a, r) => a + (r.costUsd as number), 0);
    const totalCases = comparable.reduce((a, r) => a + r.cases, 0);
    const costPer100Cases = totalCases > 0 ? round6((totalCost / totalCases) * 100) : null;

    const sources = new Set(runs.map((r) => r.costSource));
    const costSource: CostSource | "mixed" = sources.size === 1 ? ([...sources][0] as CostSource) : "mixed";

    const p50 = pickPercentile(runs.map((r) => r.latencyP50Ms));
    const p95 = pickPercentile(runs.map((r) => r.latencyP95Ms));
    const tokensIn = sumOrNull(runs.map((r) => r.tokensIn));
    const tokensOut = sumOrNull(runs.map((r) => r.tokensOut));

    const curve: ModelCurve = {
      model,
      provider: runs.find((r) => r.provider)?.provider ?? null,
      runs: runs.length,
      meanScore,
      meanCostUsd,
      costPer100Cases,
      p50Ms: p50,
      p95Ms: p95,
      costSource,
      sampleCases: cases,
      tokensIn,
      tokensOut,
      frontier: false,
    };
    if (costPer100Cases === null) {
      curve.costReason = costed.length === 0
        ? "no_run_of_this_model_has_a_cost"
        : "no_run_has_both_a_cost_and_a_case_count";
    }
    const p = priceFor(model);
    if (p) curve.price = p;
    models.push(curve);
  }

  models.sort((a, b) => b.meanScore - a.meanScore || a.model.localeCompare(b.model));

  const plottable = models
    .filter((m): m is ModelCurve & { costPer100Cases: number } => m.costPer100Cases !== null)
    .map((m) => ({ model: m.model, meanScore: m.meanScore, costPer100Cases: m.costPer100Cases }));
  const front = new Set(paretoFrontier(plottable).map((p) => p.model));
  for (const m of models) m.frontier = front.has(m.model);

  return {
    models,
    frontier: models.filter((m) => m.frontier).map((m) => m.model),
    // Named, not omitted: a model missing from the plot must be visible as missing.
    unpriced: models.filter((m) => m.costPer100Cases === null).map((m) => ({ model: m.model, reason: m.costReason ?? "unknown" })),
  };
}

/** Median of the reported per-run percentiles. A percentile OF percentiles is not a percentile of
 *  the raw sample, so it is labelled p50Ms "as reported by the runs" on the page, never as a p50. */
function pickPercentile(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  const m = percentile(v, 50);
  return m === null ? null : Math.round(m);
}

function sumOrNull(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
}

function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
}

// ── 2. QUERY LAYER ────────────────────────────────────────────────────────────────────────────

export type ModelRunInsert = {
  target: string;
  suite: string;
  model: string;
  provider: string | null;
  runId: string | null;
  cases: number;
  score: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd?: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
};

/** Resolve the cost for an incoming model_run through the ONE pricing path. */
export function resolveRunCost(r: ModelRunInsert) {
  return computeCost({
    model: r.model,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    reportedCostUsd: r.costUsd ?? null,
  });
}

type CurveDbRow = {
  model: string; provider: string | null; cases: number; score: string;
  tokens_in: string | null; tokens_out: string | null; cost_usd: string | null; cost_source: string;
  latency_p50_ms: number | null; latency_p95_ms: number | null;
};

/** GET /api/curves/:target — read the rows, hand them to the pure math. Decides nothing itself. */
export async function modelCurvesFor(sql: Sql, target: string, suite: string | null) {
  const rows = await sql<CurveDbRow[]>`
    SELECT model, provider, cases, score, tokens_in, tokens_out, cost_usd, cost_source,
           latency_p50_ms, latency_p95_ms
    FROM model_runs
    WHERE target = ${target} AND (${suite}::text IS NULL OR suite = ${suite})
    ORDER BY created_at ASC`;
  const mapped: ModelRunRow[] = rows.map((r) => ({
    model: r.model,
    provider: r.provider,
    cases: Number(r.cases),
    score: numOr0(r.score),
    tokensIn: numOrNull(r.tokens_in),
    tokensOut: numOrNull(r.tokens_out),
    costUsd: numOrNull(r.cost_usd),
    costSource: (["table", "reported", "unknown"].includes(r.cost_source) ? r.cost_source : "unknown") as CostSource,
    latencyP50Ms: r.latency_p50_ms === null ? null : Number(r.latency_p50_ms),
    latencyP95Ms: r.latency_p95_ms === null ? null : Number(r.latency_p95_ms),
  }));
  const agg = aggregateModelRuns(mapped);
  return { ...agg, totalRuns: rows.length, suite };
}

function numOr0(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
