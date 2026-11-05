// Eval Hub — SHADOW REPLAY verdict math (Phase 4 addendum §15, item 15).
//
// THE NAME, WITH ITS DEFINITION ATTACHED (addendum "Honest scoping FIRST"). This estate runs ONE
// box per product; there is no fleet and no load balancer, so "shadow deployment" in the industry
// sense does not exist here and a page claiming it would be the exact dishonesty this platform
// exists to prevent. What this module scores is a REPLAY: sampled golden cases re-run against a
// candidate build on a second port, outputs diffed against the baseline build's outputs, nothing
// served to a user. That sentence travels on every verdict as `definition`.
//
// TWO LAYERS, same law as verdict.ts / stats.ts / ab.ts:
//   1. PURE MATH (this file) — no DB, no env inside a decision, no clock, no embedder.
//   2. The route fetches rows, calls the embedder, and hands numbers here. It decides nothing.
//
// RULE v0 (addendum §15), in the order it is applied:
//   · meanDelta < MEAN_DELTA_BLOCK (-1.0)  → "block"   — BLOCKING WINS over everything below.
//   · compared === 0                       → "inspect" — an empty shadow run proves NOTHING. It is
//                                             not evidence of safety; it is an absence of evidence.
//   · unscored > 0                         → "inspect" — a pair we could not compare is not a pair
//                                             that agreed.
//   · diffRate > DIFF_RATE_INSPECT (0.15)  → "inspect"
//   · otherwise                            → "safe", with every caveat that applies spelled out.
// Every verdict states the thresholds it applied. Never implicit, never a bare word.

export const DEFAULT_SHADOW_SIM = 0.9;
/** Above this share of diffed pairs a human looks before the candidate goes anywhere. */
export const SHADOW_DIFF_RATE_INSPECT = 0.15;
/** Mean candidate score minus mean baseline score. Below this the candidate is BLOCKED. */
export const SHADOW_MEAN_DELTA_BLOCK = -1.0;

/** The one-sentence definition that must ride on every shadow artifact (addendum, honest scoping). */
export const SHADOW_DEFINITION =
  "SHADOW = REPLAY: sampled golden cases were re-run against a candidate build and the outputs " +
  "diffed against the baseline build's outputs. No user traffic was mirrored, no fleet exists, " +
  "and nothing was served to a user.";

export function shadowSimFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EVALHUB_SHADOW_SIM);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SHADOW_SIM;
}

export type ShadowThresholds = {
  /** embedSim strictly below this marks the pair as a DIFF. */
  simThreshold: number;
  diffRateInspect: number;
  meanDeltaBlock: number;
};

export function thresholds(simThreshold: number): ShadowThresholds {
  return {
    simThreshold,
    diffRateInspect: SHADOW_DIFF_RATE_INSPECT,
    meanDeltaBlock: SHADOW_MEAN_DELTA_BLOCK,
  };
}

// ── one pair ──────────────────────────────────────────────────────────────────────────────────

export type PairInput = {
  /** exactNorm(baselineOutput, candidateOutput) — deterministic, always available. */
  exact: boolean;
  /** embedSim, or null when the embedder could not run. NEVER a fabricated number. */
  sim: number | null;
  /** The embedder's own error message, when there was one. */
  simError?: string | null;
};

export type PairDecision = {
  /** true = the outputs differ materially. null = we could not tell, which is NOT "no diff". */
  diff: boolean | null;
  sim: number | null;
  /** Where the similarity came from. "exact_match" is a PROOF, not an estimate: two strings that
   *  normalise identically are identical for scoring purposes, so sim 1 there is not invented. */
  simSource: "embed" | "exact_match" | "unavailable";
  note?: string;
};

/**
 * PURE. Decide one pair. A diff is recorded when embedSim < simThreshold (addendum §15).
 *
 * When the embedder is unavailable we do NOT guess. The single exception is an exact normalised
 * match: identical text has cosine 1 by construction, so that pair is provably not a diff and is
 * counted as compared. Everything else becomes `diff: null` — unscored, counted, and named.
 */
export function decidePair(p: PairInput, simThreshold: number): PairDecision {
  if (p.sim !== null && Number.isFinite(p.sim)) {
    return { diff: p.sim < simThreshold, sim: p.sim, simSource: "embed" };
  }
  if (p.exact) {
    return {
      diff: false, sim: 1, simSource: "exact_match",
      note: "embedder unavailable, but the outputs are identical after normalisation — similarity 1 is a proof here, not an estimate",
    };
  }
  return {
    diff: null, sim: null, simSource: "unavailable",
    note: `could not be compared: ${p.simError ?? "embedder unavailable"} — counted as UNSCORED, not as agreement`,
  };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────

export type ShadowTally = {
  /** Cases the replayer SAMPLED (declared by the runner). May exceed `compared` — say so. */
  sampled: number;
  /** Pairs that produced a usable similarity. */
  compared: number;
  diffs: number;
  /** Pairs received but not comparable. */
  unscored: number;
  meanScoreCandidate: number | null;
  meanScoreBaseline: number | null;
  spendUsd: number | null;
};

export type ShadowRecommendation = "safe" | "inspect" | "block";

export type ShadowVerdictOut = {
  ok: true;
  sampled: number;
  compared: number;
  diffs: number;
  unscored: number;
  /** diffs / compared, 4dp. null when nothing was compared — never 0, which would read as "clean". */
  diffRate: number | null;
  meanScoreCandidate: number | null;
  meanScoreBaseline: number | null;
  meanDelta: number | null;
  /** false when no pair carried both scores: the blocking rule could not be evaluated at all. */
  meanDeltaEvaluated: boolean;
  spendUsd: number | null;
  recommendation: ShadowRecommendation;
  reason: string;
  /** Everything true of this verdict that a bare word would hide. A "safe" is never bare. */
  caveats: string[];
  thresholds: ShadowThresholds & {
    rule: string;
  };
  definition: string;
};

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}
function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * THE WHOLE RULE, in one pure function. `th` is injected so the env is read exactly once, at the
 * route, and the unit test can vary every threshold.
 */
export function shadowVerdict(t: ShadowTally, th: ShadowThresholds): ShadowVerdictOut {
  const diffRate = t.compared > 0 ? round4(t.diffs / t.compared) : null;
  const meanDeltaEvaluated = t.meanScoreCandidate !== null && t.meanScoreBaseline !== null;
  const meanDelta = meanDeltaEvaluated
    ? round2((t.meanScoreCandidate as number) - (t.meanScoreBaseline as number))
    : null;

  const caveats: string[] = [];
  if (!meanDeltaEvaluated) {
    caveats.push(
      `the mean-score rule (block below ${th.meanDeltaBlock}) was NOT evaluated — no pair carried both a baseline and a candidate score, so this verdict rests on output diffing alone`
    );
  }
  if (t.unscored > 0) {
    caveats.push(`${t.unscored} pair(s) could not be compared at all and are counted as UNSCORED, not as agreement`);
  }
  if (t.sampled > t.compared + t.unscored) {
    caveats.push(
      `the runner declared ${t.sampled} sampled case(s) but only ${t.compared + t.unscored} pair(s) reached the hub — ${t.sampled - t.compared - t.unscored} never arrived`
    );
  }
  if (t.spendUsd === null) {
    caveats.push("no LLM spend was reported for this replay, so the cost of it is unknown, not zero");
  }

  const rule =
    `v0: meanDelta < ${th.meanDeltaBlock} -> block (blocking wins); zero compared pairs -> inspect; ` +
    `any unscored pair -> inspect; diffRate > ${th.diffRateInspect} -> inspect; else safe. ` +
    `A pair is a DIFF when embedSim < ${th.simThreshold}.`;

  const base = {
    ok: true as const,
    sampled: t.sampled,
    compared: t.compared,
    diffs: t.diffs,
    unscored: t.unscored,
    diffRate,
    meanScoreCandidate: t.meanScoreCandidate === null ? null : round2(t.meanScoreCandidate),
    meanScoreBaseline: t.meanScoreBaseline === null ? null : round2(t.meanScoreBaseline),
    meanDelta,
    meanDeltaEvaluated,
    // 4dp, not 2: a replay costing $0.0421 rounded to $0.04 is a 5% lie about a real metered number.
    spendUsd: t.spendUsd === null ? null : round4(t.spendUsd),
    caveats,
    thresholds: { ...th, rule },
    definition: SHADOW_DEFINITION,
  };

  // 1. BLOCKING WINS. A candidate that scores materially worse is blocked whatever its diff rate
  //    does — including when the diff rate ALSO breached, which on its own would only "inspect".
  if (meanDelta !== null && meanDelta < th.meanDeltaBlock) {
    const also = diffRate !== null && diffRate > th.diffRateInspect
      ? ` (the diff rate ${diffRate} also breached ${th.diffRateInspect}; blocking wins)`
      : "";
    return {
      ...base, recommendation: "block",
      reason: `meanDelta ${meanDelta} is below the block threshold ${th.meanDeltaBlock} over ${t.compared} compared pair(s)${also}`,
    };
  }

  // 2. ZERO PAIRS IS NOT SAFE. An empty replay proves nothing at all.
  if (t.compared === 0) {
    return {
      ...base, recommendation: "inspect",
      reason:
        t.unscored > 0
          ? `zero pairs could be compared (${t.unscored} arrived but none could be scored) — an unscored replay proves nothing, it is not evidence of safety`
          : "zero pairs were compared — an empty shadow replay proves nothing, it is not evidence of safety",
    };
  }

  // 3. A pair we could not compare is not a pair that agreed.
  if (t.unscored > 0) {
    return {
      ...base, recommendation: "inspect",
      reason: `${t.unscored} of ${t.compared + t.unscored} pair(s) could not be compared — the replay is incomplete, so it cannot read as clean`,
    };
  }

  // 4. The diff rate rule.
  if (diffRate !== null && diffRate > th.diffRateInspect) {
    return {
      ...base, recommendation: "inspect",
      reason: `diffRate ${diffRate} is above the inspect threshold ${th.diffRateInspect} (${t.diffs} diff(s) over ${t.compared} compared pair(s))`,
    };
  }

  return {
    ...base, recommendation: "safe",
    reason:
      `${t.diffs} diff(s) over ${t.compared} compared pair(s) — diffRate ${diffRate} is at or below ${th.diffRateInspect}` +
      (meanDeltaEvaluated
        ? `, and meanDelta ${meanDelta} is at or above ${th.meanDeltaBlock}`
        : `, and the mean-score rule could not be evaluated (see caveats)`),
  };
}
