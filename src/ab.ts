// Eval Hub — prompt A/B decisions (Phase 3b addendum §3, item 10).
//
// THE STANCE, quoted from the addendum: "An A/B result without enough samples is NOT a winner."
// This module can answer "no decision yet" and says WHY every single time. There are NO p-values
// here on purpose — a p-value over golden cases that are not an i.i.d. sample of production
// traffic is decoration, and the addendum forbids statistics we cannot defend.
//
// RULE v0 (both conditions, no exceptions):
//   1. EVERY compared variant has n >= minN (EVALHUB_AB_MIN_N, default 30), and
//   2. the pass-rate gap between the best and the second-best is >= AB_MIN_GAP_POINTS (5).
// Anything else → status "no_decision" with the reason spelled out.
//
// PURE: no DB, no env reads inside the decision (minN is passed in), no clock. Unit-tested in
// scripts/test-ab.mts. The query layer at the bottom fetches rows and decides nothing.
import type { Sql } from "./db.js";
import { round2 } from "./verdict.js";

export const DEFAULT_AB_MIN_N = 30;
/** Pass-rate points. Below this the two variants are "the same thing measured twice". */
export const AB_MIN_GAP_POINTS = 5;

export function abMinNFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EVALHUB_AB_MIN_N);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_AB_MIN_N;
}

/** One variant's measured tally. */
export type VariantTally = {
  variantId: string;
  name: string;
  hash: string;
  n: number;
  passed: number;
  /** Mean of the pushed per-case scores, when any were pushed. Advisory next to passRate. */
  meanScore: number | null;
};

export type VariantSummary = VariantTally & { passRate: number | null };

export type AbDecision = {
  status: "no_decision" | "leader";
  leader?: string;
  leaderVariantId?: string;
  /** Pass-rate points between the best and the runner-up. Null when it cannot be computed. */
  delta?: number | null;
  minN: number;
  minGapPoints: number;
  reason: string;
};

export type AbReport = { variants: VariantSummary[]; decision: AbDecision };

/**
 * The whole rule, in one pure function.
 * `minN` is injected so the env is read exactly once, at the route, and the test can vary it.
 */
export function decideAb(tallies: readonly VariantTally[], minN: number): AbReport {
  const variants: VariantSummary[] = tallies
    .map((t) => ({
      ...t,
      passRate: t.n > 0 ? round2((t.passed / t.n) * 100) : null,
      meanScore: t.meanScore === null ? null : round2(t.meanScore),
    }))
    // Best first, ties broken by name so the order is deterministic (a leader must not depend on
    // the row order postgres happened to return).
    .sort((a, b) => (b.passRate ?? -1) - (a.passRate ?? -1) || a.name.localeCompare(b.name));

  const base = { minN, minGapPoints: AB_MIN_GAP_POINTS };

  if (variants.length < 2) {
    return {
      variants,
      decision: {
        ...base, status: "no_decision", delta: null,
        reason: `only_${variants.length}_variant_with_results — an A/B needs at least two`,
      },
    };
  }

  const under = variants.filter((v) => v.n < minN);
  if (under.length > 0) {
    return {
      variants,
      decision: {
        ...base, status: "no_decision", delta: null,
        reason: `below_min_n: ${under.map((v) => `${v.name} n=${v.n}`).join(", ")} — every variant needs n >= ${minN}`,
      },
    };
  }

  const best = variants[0] as VariantSummary;
  const second = variants[1] as VariantSummary;
  if (best.passRate === null || second.passRate === null) {
    return { variants, decision: { ...base, status: "no_decision", delta: null, reason: "a_variant_has_no_pass_rate" } };
  }
  const delta = round2(best.passRate - second.passRate);

  if (delta < AB_MIN_GAP_POINTS) {
    return {
      variants,
      decision: {
        ...base, status: "no_decision", delta,
        reason: delta === 0
          ? `tie: ${best.name} and ${second.name} both at ${best.passRate}% — no winner`
          : `gap_${delta}_points_below_${AB_MIN_GAP_POINTS} — the difference is smaller than the rule calls decisive`,
      },
    };
  }

  return {
    variants,
    decision: {
      ...base, status: "leader", leader: best.name, leaderVariantId: best.variantId, delta,
      reason: `${best.name} leads ${second.name} by ${delta} points with n >= ${minN} on every variant`,
    },
  };
}

// ── query layer ───────────────────────────────────────────────────────────────────────────────

type AbDbRow = {
  variant_id: string; name: string; hash: string;
  n: number; passed: number; mean_score: string | null;
};

/** GET /api/ab/:target — fetch tallies, hand them to decideAb(). No rule lives here. */
export async function abReportFor(sql: Sql, target: string, surface: string | null, minN: number): Promise<AbReport & { surface: string | null }> {
  const rows = await sql<AbDbRow[]>`
    SELECT v.id::text AS variant_id, v.name, v.hash,
           count(r.id)::int AS n,
           count(r.id) FILTER (WHERE r.pass)::int AS passed,
           avg(r.score) AS mean_score
    FROM prompt_variants v
    LEFT JOIN ab_results r ON r.variant_id = v.id
    WHERE v.target = ${target} AND (${surface}::text IS NULL OR v.surface = ${surface})
    GROUP BY v.id, v.name, v.hash
    ORDER BY v.name`;
  const tallies: VariantTally[] = rows.map((r) => ({
    variantId: r.variant_id,
    name: r.name,
    hash: r.hash,
    n: Number(r.n),
    passed: Number(r.passed),
    meanScore: r.mean_score === null ? null : Number(r.mean_score),
  }));
  return { ...decideAb(tallies, minN), surface };
}

/**
 * One report PER SURFACE (the dashboard shape).
 *
 * Surfaces are NOT pooled. Two prompts for `tailoring` and one for `agent_answers` are not three
 * competitors — pooling them would compute a pass-rate gap between prompts that were never asked
 * the same questions, and print a "leader" for a comparison that never happened.
 */
export async function abReportsBySurface(sql: Sql, target: string, minN: number): Promise<(AbReport & { surface: string })[]> {
  const surfaces = await sql<{ surface: string }[]>`
    SELECT DISTINCT surface FROM prompt_variants WHERE target = ${target} ORDER BY surface`;
  const out: (AbReport & { surface: string })[] = [];
  for (const s of surfaces) {
    const r = await abReportFor(sql, target, s.surface, minN);
    out.push({ variants: r.variants, decision: r.decision, surface: s.surface });
  }
  return out;
}
