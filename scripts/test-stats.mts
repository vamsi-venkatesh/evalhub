// Pure unit tests for src/stats.ts — NO database, no server, no env, no clock. If this file ever
// needs a DB, the percentile math has leaked into the query layer and that is itself the bug.
//
// The percentiles are checked against HAND-COMPUTED nearest-rank values, and the negative controls
// assert what the numbers must NOT be — an interpolated p95 and a nearest-rank p95 differ, and a
// test that passes under both definitions has tested nothing.
import {
  buildSuiteStats, clampDays, percentile, percentileSorted, percentiles, sortAsc,
  DEFAULT_STATS_DAYS, MAX_STATS_DAYS, type StatsRun,
} from "../src/stats.js";

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
const cannot = (wrong: boolean, what: string) => {
  console.log(`  ${!wrong ? "PASS" : "FAIL"}  [neg-control] ${what}`);
  if (wrong) fail++;
};

console.log("\n── nearest-rank percentiles over known arrays ──");
{
  //  1..10, n = 10.  rank(p) = ceil(p/100 * 10)
  //  p50 → ceil(5)   = 5  → sorted[4]  = 5
  //  p95 → ceil(9.5) = 10 → sorted[9]  = 10
  //  p99 → ceil(9.9) = 10 → sorted[9]  = 10
  //  p10 → ceil(1)   = 1  → sorted[0]  = 1
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  ok(percentile(a, 50) === 5, "p50 of 1..10 = 5", percentile(a, 50));
  ok(percentile(a, 95) === 10, "p95 of 1..10 = 10 (rank 10, no interpolation)", percentile(a, 95));
  ok(percentile(a, 99) === 10, "p99 of 1..10 = 10", percentile(a, 99));
  ok(percentile(a, 10) === 1, "p10 of 1..10 = 1", percentile(a, 10));
  ok(percentile(a, 100) === 10, "p100 = the maximum", percentile(a, 100));
  cannot(percentile(a, 95) === 9.55, "p95 is NOT the interpolated 9.55 — this is nearest-rank");
  cannot(percentile(a, 50) === 5.5, "p50 is NOT the mean-of-middle-pair 5.5");

  //  1..100, n = 100 → rank(p) = p, so the value IS p.
  const b = Array.from({ length: 100 }, (_, i) => i + 1);
  ok(percentile(b, 50) === 50 && percentile(b, 95) === 95 && percentile(b, 99) === 99,
    "1..100 → p50/p95/p99 = 50/95/99", `${percentile(b, 50)}/${percentile(b, 95)}/${percentile(b, 99)}`);

  //  n = 5: [10,20,30,40,50].  p50 → ceil(2.5) = 3 → 30 ; p20 → ceil(1) = 1 → 10 ; p21 → ceil(1.05) = 2 → 20
  const c = [10, 20, 30, 40, 50];
  ok(percentile(c, 50) === 30, "p50 of 5 values = the 3rd", percentile(c, 50));
  ok(percentile(c, 20) === 10 && percentile(c, 21) === 20, "the rank boundary at p20/p21 lands where ceil() says",
    `${percentile(c, 20)}/${percentile(c, 21)}`);
  ok(percentile(c, 95) === 50 && percentile(c, 99) === 50, "p95 and p99 of 5 values are both the max", percentile(c, 95));

  //  the sample need not arrive sorted
  ok(percentile([5, 1, 3], 50) === 3, "an UNSORTED sample is sorted before ranking", percentile([5, 1, 3], 50));
  ok(sortAsc([5, 1, 3])[0] === 1 && sortAsc([9, 10, 2])[2] === 10, "sortAsc sorts NUMERICALLY, not lexically (10 > 9)",
    JSON.stringify(sortAsc([9, 10, 2])));
  cannot(sortAsc([9, 10, 2])[0] === 10, "…a lexical sort would have put \"10\" first");
  const orig = [3, 1, 2];
  sortAsc(orig);
  ok(orig[0] === 3, "sortAsc does NOT mutate the caller's array", JSON.stringify(orig));
}

console.log("\n── edges: empty, single, one-off values ──");
{
  ok(percentile([], 50) === null && percentile([], 95) === null, "the percentile of NOTHING is null");
  cannot(percentile([], 95) === 0, "an empty sample does NOT report 0ms — that would read as 'instant'");
  const p = percentiles([]);
  ok(p.n === 0 && p.p50 === null && p.p95 === null && p.p99 === null, "percentiles([]) → n 0 and three nulls", JSON.stringify(p));

  ok(percentile([42], 50) === 42 && percentile([42], 99) === 42 && percentile([42], 1) === 42,
    "a single sample is every percentile of itself", percentile([42], 99));
  const one = percentiles([7]);
  ok(one.n === 1 && one.p50 === 7 && one.p95 === 7, "percentiles([7]) → n 1, all 7", JSON.stringify(one));

  ok(percentileSorted([1, 2, 3], 0) === 1, "p0 answers the minimum", percentileSorted([1, 2, 3], 0));
  ok(percentileSorted([1, 2, 3], -5) === 1, "a negative p is clamped to the minimum");
  ok(percentileSorted([1, 2, 3], 500) === 3, "a p above 100 is clamped to the maximum");
  ok(percentileSorted([1, 2, 3], Number.NaN) === null, "a NaN p answers null, not a number");
  ok(percentile([1, Number.NaN, 3, Infinity], 100) === 3, "NaN/Infinity samples are dropped, not ranked", percentile([1, Number.NaN, 3, Infinity], 100));

  // duplicates: n = 6, all 100 except one 5000. p95 → ceil(5.7) = 6 → the outlier.
  const d = [100, 100, 100, 100, 100, 5000];
  ok(percentile(d, 50) === 100 && percentile(d, 95) === 5000, "one outlier in six moves p95 but not p50",
    `${percentile(d, 50)}/${percentile(d, 95)}`);
  cannot(percentile(d, 50) === 5000, "a single slow case does NOT drag the median");
  //  n = 100 with TWO slow cases: p99 → ceil(99) = 99 → sorted[98] = the first slow one; p95 → sorted[94] = fast.
  //  With only ONE slow case in 100, nearest-rank p99 is still the 99th sample and stays FAST — the
  //  outlier appears at p100 alone. That is a property of the definition, and it is asserted here so
  //  nobody later "fixes" the percentile into an interpolation because a dashboard looked too calm.
  const two = percentiles(Array.from({ length: 100 }, (_, i) => (i < 98 ? 100 : 9000)));
  ok(two.p95 === 100 && two.p99 === 9000, "2 slow cases in 100 show at p99, not at p95", `${two.p95}/${two.p99}`);
  const one100 = percentiles(Array.from({ length: 100 }, (_, i) => (i < 99 ? 100 : 9000)));
  ok(one100.p99 === 100 && percentile(Array.from({ length: 100 }, (_, i) => (i < 99 ? 100 : 9000)), 100) === 9000,
    "1 slow case in 100: nearest-rank p99 is the 99th sample (fast); the outlier is p100", `${one100.p99}`);
}

console.log("\n── ?days clamping (declared, never silent) ──");
{
  ok(clampDays(undefined).days === DEFAULT_STATS_DAYS && clampDays(undefined).clamped === false, "no ?days → the default window", DEFAULT_STATS_DAYS);
  ok(clampDays("").days === DEFAULT_STATS_DAYS && clampDays("bananas").days === DEFAULT_STATS_DAYS, "junk ?days → the default, not a crash");
  ok(clampDays("30").days === 30 && clampDays("30").clamped === false, "?days=30 is honoured");
  ok(clampDays("0").days === 1 && clampDays("0").clamped === true, "?days=0 clamps to 1 AND says so", JSON.stringify(clampDays("0")));
  ok(clampDays("99999").days === MAX_STATS_DAYS && clampDays("99999").clamped === true, "an absurd window clamps to the max AND says so", MAX_STATS_DAYS);
  cannot(clampDays("99999").clamped === false, "a clamped window is never reported as the one that was asked for");
}

console.log("\n── buildSuiteStats assembly (pure) ──");
{
  const t = (iso: string) => new Date(iso);
  const runs: StatsRun[] = [
    // suite A: two runs; the newest is r2
    { id: "r1", suite: "alpha", score: 90, total: 3, startedAt: t("2026-08-01T00:00:00Z"), finishedAt: t("2026-08-01T00:00:10Z") },
    { id: "r2", suite: "alpha", score: 97.5, total: 4, startedAt: t("2026-08-02T00:00:00Z"), finishedAt: t("2026-08-02T00:00:04Z") },
    // suite B: one run, no latency rows at all
    { id: "r3", suite: "beta", score: 80, total: 2, startedAt: t("2026-08-02T00:00:00Z"), finishedAt: t("2026-08-02T00:00:20Z") },
  ];
  const latency = new Map<string, number[]>([
    ["r1", [900, 900, 900]],       // the OLD run — must not be used
    ["r2", [100, 200, 300, 4000]], // the latest run of alpha
  ]);
  const baselines = new Map<string, number>([["alpha", 95], ["gamma", 88]]); // gamma has a baseline and NO runs
  const s = buildSuiteStats({ runs, latencyByRun: latency, baselines });

  ok(s.map((x) => x.suite).join(",") === "alpha,beta,gamma", "suites are sorted and a baseline-only suite still APPEARS", s.map((x) => x.suite).join(","));
  const alpha = s.find((x) => x.suite === "alpha")!;
  ok(alpha.runs === 2 && alpha.latestRunId === "r2" && alpha.latestScore === 97.5, "alpha: 2 runs, latest = r2 @ 97.5", JSON.stringify({ n: alpha.runs, id: alpha.latestRunId, s: alpha.latestScore }));
  ok(alpha.baseline === 95 && alpha.delta === 2.5, "delta = latest − baseline, 2dp", alpha.delta);
  //  latency of r2 sorted = [100,200,300,4000]; p50 → ceil(2) = 2 → 200 ; p95 → ceil(3.8) = 4 → 4000
  ok(alpha.p50Ms === 200 && alpha.p95Ms === 4000 && alpha.p99Ms === 4000, "alpha latency p50 200 / p95 4000 / p99 4000", `${alpha.p50Ms}/${alpha.p95Ms}/${alpha.p99Ms}`);
  cannot(alpha.p50Ms === 900, "the percentiles come from the LATEST run, not the older one");
  ok(alpha.latencySamples === 4 && alpha.casesPerRun === 4, "sample size and case count are reported next to the percentiles", `${alpha.latencySamples}/${alpha.casesPerRun}`);
  //  run durations across the window: r2 = 4000ms, r1 = 10000ms → sorted [4000,10000]; p50 → ceil(1)=1 → 4000
  ok(alpha.runDurationMs.n === 2 && alpha.runDurationMs.p50 === 4000 && alpha.runDurationMs.p95 === 10000,
    "whole-run wall clock percentiles over the window", JSON.stringify(alpha.runDurationMs));
  ok(alpha.lastRunAt === "2026-08-02T00:00:04.000Z", "lastRunAt = the newest finished_at", alpha.lastRunAt);

  const beta = s.find((x) => x.suite === "beta")!;
  ok(beta.p50Ms === null && beta.latencySamples === 0, "a suite whose cases carried no latency reports null, not 0", JSON.stringify({ p: beta.p50Ms, n: beta.latencySamples }));
  ok(beta.baseline === null && beta.delta === null, "no baseline → no delta invented");

  const gamma = s.find((x) => x.suite === "gamma")!;
  ok(gamma.runs === 0 && gamma.latestScore === null && gamma.lastRunAt === null, "gamma: a baseline with NO runs is visible and empty", JSON.stringify({ r: gamma.runs, s: gamma.latestScore }));
  cannot(gamma.latestScore === 88, "a silent suite does NOT inherit its baseline as a score");
  ok(gamma.baseline === 88 && gamma.delta === null, "…its baseline is still shown, with no delta", gamma.baseline);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — nearest-rank percentiles, edges, clamping and stats assembly hold");
process.exit(fail ? 1 : 0);
