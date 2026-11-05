// Eval Hub — latency/throughput statistics. Phase 3 addendum §"Latency percentiles (item 12)".
//
// TWO layers, deliberately separated (same law as verdict.ts / kappa.ts):
//   1. PURE MATH — percentile(), percentiles(), buildSuiteStats(). No DB, no env, no clock. Unit
//      tested against hand-computed values in scripts/test-stats.mts.
//   2. QUERY LAYER — suiteStatsFor(): fetches rows and hands them to (1). It decides nothing.
//
// THE PERCENTILE DEFINITION, stated because there are several and they disagree:
// NEAREST-RANK on the sorted sample. rank = ceil(p/100 * n), value = sorted[rank-1].
// No interpolation. p95 of ten samples is the 10th sample (ceil(9.5)=10), not a blend of the 9th
// and 10th. Every returned percentile is therefore a latency that a real case actually took —
// which is the only kind of number worth putting next to "p95" on a dashboard.
import type { Sql } from "./db.js";
import { round2 } from "./verdict.js";

/** Ascending numeric sort that does NOT mutate the caller's array. */
export function sortAsc(values: readonly number[]): number[] {
  return values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
}

/**
 * Nearest-rank percentile over an ALREADY SORTED ascending array.
 * Empty → null (there is no p95 of nothing; a 0 would read as "instant").
 * Single element → that element for every p.
 * p is clamped to (0,100]: p<=0 answers the minimum, p>100 answers the maximum.
 */
export function percentileSorted(sorted: readonly number[], p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  if (!Number.isFinite(p)) return null;
  if (p <= 0) return sorted[0] as number;
  const rank = Math.ceil((Math.min(p, 100) / 100) * n);
  const idx = Math.min(Math.max(rank, 1), n) - 1;
  return sorted[idx] as number;
}

/** Convenience: sorts a raw sample, then takes the percentile. */
export function percentile(values: readonly number[], p: number): number | null {
  return percentileSorted(sortAsc(values), p);
}

export type Percentiles = { n: number; p50: number | null; p95: number | null; p99: number | null };

/** p50/p95/p99 over one sample, sorted once. `n` is the SAMPLE SIZE that produced them — a p99
 *  computed from 3 numbers is arithmetic, not statistics, and the reader must be able to see that. */
export function percentiles(values: readonly number[]): Percentiles {
  const sorted = sortAsc(values);
  return {
    n: sorted.length,
    p50: percentileSorted(sorted, 50),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
  };
}

// ── assembly ──────────────────────────────────────────────────────────────────────────────────

/** One finished run inside the window, as the math needs it. */
export type StatsRun = {
  id: string;
  suite: string;
  score: number | null;
  total: number | null;
  startedAt: Date;
  finishedAt: Date;
};

export type SuiteStats = {
  suite: string;
  /** finished runs INSIDE the window (not all time). */
  runs: number;
  latestRunId: string | null;
  latestScore: number | null;
  baseline: number | null;
  delta: number | null;
  /** Per-CASE latency percentiles over the LATEST run of the suite (addendum). */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** Sample size behind p50/p95/p99 — results carrying a non-null latency_ms in that latest run. */
  latencySamples: number;
  /** Cases in the latest run (the run the latency percentiles describe). */
  casesPerRun: number | null;
  /** Whole-run wall clock (finished_at − started_at) percentiles across the window's runs. */
  runDurationMs: Percentiles;
  lastRunAt: string | null;
};

/**
 * PURE. `runs` may arrive in any order; `latencyByRun` supplies the per-case latencies of a run.
 * A suite that has a baseline but no run in the window still appears (runs: 0) — silence about a
 * suite that stopped reporting is exactly the failure Phase 3 exists to make visible.
 */
export function buildSuiteStats(input: {
  runs: readonly StatsRun[];
  latencyByRun: ReadonlyMap<string, readonly number[]>;
  baselines: ReadonlyMap<string, number>;
}): SuiteStats[] {
  const bySuite = new Map<string, StatsRun[]>();
  for (const r of input.runs) {
    const list = bySuite.get(r.suite) ?? [];
    list.push(r);
    bySuite.set(r.suite, list);
  }
  for (const s of input.baselines.keys()) if (!bySuite.has(s)) bySuite.set(s, []);

  const out: SuiteStats[] = [];
  for (const [suite, list] of bySuite) {
    list.sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime()); // newest first
    const latest = list[0] ?? null;
    const lat = latest ? (input.latencyByRun.get(latest.id) ?? []) : [];
    const latPct = percentiles(lat);
    const durations = list.map((r) => r.finishedAt.getTime() - r.startedAt.getTime()).filter((d) => d >= 0);
    const baseline = input.baselines.has(suite) ? round2(input.baselines.get(suite) as number) : null;
    const latestScore = latest && latest.score !== null ? round2(latest.score) : null;
    out.push({
      suite,
      runs: list.length,
      latestRunId: latest?.id ?? null,
      latestScore,
      baseline,
      delta: latestScore !== null && baseline !== null ? round2(latestScore - baseline) : null,
      p50Ms: latPct.p50,
      p95Ms: latPct.p95,
      p99Ms: latPct.p99,
      latencySamples: latPct.n,
      casesPerRun: latest?.total ?? null,
      runDurationMs: percentiles(durations),
      lastRunAt: latest ? latest.finishedAt.toISOString() : null,
    });
  }
  out.sort((a, b) => a.suite.localeCompare(b.suite));
  return out;
}

export const DEFAULT_STATS_DAYS = 7;
export const MAX_STATS_DAYS = 365;

/** ?days= — clamped, never trusted. Returns the clamp so the route can DECLARE it. */
export function clampDays(raw: unknown): { days: number; clamped: boolean } {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) {
    return { days: DEFAULT_STATS_DAYS, clamped: false };
  }
  const days = Math.min(Math.max(Math.floor(n), 1), MAX_STATS_DAYS);
  return { days, clamped: days !== Math.floor(n) };
}

/** QUERY LAYER — fetch, convert, delegate. It contains no arithmetic of its own. */
export async function suiteStatsFor(sql: Sql, target: string, days: number): Promise<SuiteStats[]> {
  // The window boundary comes from the DB clock (estate law), not from this process's Date.
  const runRows = await sql<
    { id: string; suite: string; score: string | null; total: number | null; started_at: Date; finished_at: Date }[]
  >`
    SELECT id, suite, score, total, started_at, finished_at
    FROM runs
    WHERE target = ${target}
      AND finished_at IS NOT NULL
      AND finished_at >= now() - (${days}::int * interval '1 day')
    ORDER BY suite, finished_at DESC`;

  const runs: StatsRun[] = runRows.map((r) => ({
    id: r.id,
    suite: r.suite,
    score: r.score === null ? null : Number(r.score),
    total: r.total === null ? null : Number(r.total),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));

  // Latency samples only for the LATEST run of each suite — that is what the addendum describes,
  // and pulling every case of every run in the window would be a table scan for numbers nobody reads.
  // The LATEST run per suite, chosen by comparing finished_at — NOT by trusting the query's ORDER BY
  // and taking whichever row a Map happened to keep. (A `new Map(runs.map(...))` keeps the LAST
  // occurrence, i.e. the OLDEST run under `ORDER BY suite, finished_at DESC`, and the percentiles
  // then silently describe the wrong run. That bug existed here and the route test caught it.)
  const latestBySuite = new Map<string, StatsRun>();
  for (const r of runs) {
    const cur = latestBySuite.get(r.suite);
    if (!cur || r.finishedAt.getTime() > cur.finishedAt.getTime()) latestBySuite.set(r.suite, r);
  }
  const latestIds = [...latestBySuite.values()].map((r) => r.id);
  const latencyByRun = new Map<string, number[]>();
  if (latestIds.length > 0) {
    const latRows = await sql<{ run_id: string; latency_ms: number }[]>`
      SELECT run_id, latency_ms FROM results
      WHERE run_id = ANY(${latestIds}::uuid[]) AND latency_ms IS NOT NULL`;
    for (const r of latRows) {
      const list = latencyByRun.get(r.run_id) ?? [];
      list.push(Number(r.latency_ms));
      latencyByRun.set(r.run_id, list);
    }
  }

  const baseRows = await sql<{ suite: string; score: string }[]>`
    SELECT suite, score FROM baselines WHERE target = ${target}`;
  const baselines = new Map(baseRows.map((b) => [b.suite, Number(b.score)]));

  return buildSuiteStats({ runs, latencyByRun, baselines });
}

/** Last N finished run scores per suite, ASCENDING by time — the dashboard's sparkline input. */
export const TREND_POINTS = 14;

export type TrendPoint = { score: number | null; at: string };

export async function trendsFor(sql: Sql, target: string, points = TREND_POINTS): Promise<Map<string, TrendPoint[]>> {
  const rows = await sql<{ suite: string; score: string | null; finished_at: Date }[]>`
    SELECT suite, score, finished_at FROM (
      SELECT suite, score, finished_at,
             row_number() OVER (PARTITION BY suite ORDER BY finished_at DESC) AS rn
      FROM runs
      WHERE target = ${target} AND finished_at IS NOT NULL
    ) t
    WHERE rn <= ${points}
    ORDER BY suite, finished_at ASC`;
  const out = new Map<string, TrendPoint[]>();
  for (const r of rows) {
    const list = out.get(r.suite) ?? [];
    list.push({ score: r.score === null ? null : round2(Number(r.score)), at: r.finished_at.toISOString() });
    out.set(r.suite, list);
  }
  return out;
}
