// Eval Hub — the model price table (Phase 3b addendum §2).
//
// THE LAW OF THIS FILE: an unknown model produces `unknown`, NEVER 0. A zero cost on a dashboard
// reads as "free" and would make an unpriced model the cheapest point on the Pareto frontier — the
// exact lie the frontier exists to prevent. Every lookup miss returns null plus a REASON string.
//
// Every entry carries `asOf` (the date the price was read) and `source` (where it was read). A
// price with no date is a rumour. These are LIST prices in USD per 1,000,000 tokens; they do not
// include cache discounts, batch discounts, or negotiated rates, and the dashboard says so.
//
// PURE: no env, no clock, no network, no DB. Unit-tested in scripts/test-curves.mts.

export type PriceEntry = {
  /** USD per 1,000,000 input tokens (list price). */
  inputPer1M: number;
  /** USD per 1,000,000 output tokens (list price). */
  outputPer1M: number;
  /** ISO date the price was read from the source. A price with no date is a rumour. */
  asOf: string;
  /** Where it was read. Named so a stale number can be re-checked, not just distrusted. */
  source: string;
};

/**
 * Keyed by the model id a product actually sends (provider's own string, lowercased on lookup).
 * Adding a model here is the ONLY way a cost gets computed — there is no heuristic, no prefix
 * match, no "close enough" family fallback. A near-miss price is a wrong price.
 */
export const PRICES: Readonly<Record<string, PriceEntry>> = Object.freeze({
  "deepseek-chat": {
    inputPer1M: 0.27, outputPer1M: 1.1,
    asOf: "2026-08-05", source: "api-docs.deepseek.com/quick_start/pricing (cache-miss input rate)",
  },
  "deepseek-reasoner": {
    inputPer1M: 0.55, outputPer1M: 2.19,
    asOf: "2026-08-05", source: "api-docs.deepseek.com/quick_start/pricing (cache-miss input rate)",
  },
  "llama-3.3-70b-versatile": {
    inputPer1M: 0.59, outputPer1M: 0.79,
    asOf: "2026-08-05", source: "groq.com/pricing",
  },
  "llama-3.1-8b-instant": {
    inputPer1M: 0.05, outputPer1M: 0.08,
    asOf: "2026-08-05", source: "groq.com/pricing",
  },
  "gpt-4o-mini": {
    inputPer1M: 0.15, outputPer1M: 0.6,
    asOf: "2026-08-05", source: "openai.com/api/pricing",
  },
});

/** Every model this table can price. Printed by the sweep runner so a typo is visible immediately. */
export function knownModels(): string[] {
  return Object.keys(PRICES).sort();
}

/** Exact, case-insensitive lookup. No prefix matching: a near-miss price is a wrong price. */
export function priceFor(model: string): PriceEntry | null {
  const key = String(model ?? "").trim().toLowerCase();
  if (!key) return null;
  return PRICES[key] ?? null;
}

/** 'table' = we computed it from PRICES · 'reported' = the caller metered it · 'unknown' = neither. */
export type CostSource = "table" | "reported" | "unknown";

export type CostComputation = {
  costUsd: number | null;
  costSource: CostSource;
  /** Present whenever costUsd is null, or whenever the caller should know WHY the source is what it is. */
  reason?: string;
  /** The table entry used, so the dashboard can print the date and source next to the number. */
  price?: PriceEntry;
};

/**
 * Cost of one run.
 *
 * PRECEDENCE: a REPORTED cost always wins. The product metered its own provider invoice; our table
 * is a second-hand list price and must never overwrite a measured number (addendum stance: "cost
 * numbers must come from METERED usage").
 *
 * Token counts are required for a table computation. Missing/negative/non-finite counts →
 * unknown with the reason, never a half-computed number treating the missing side as zero.
 */
export function computeCost(input: {
  model: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  reportedCostUsd?: number | null;
}): CostComputation {
  const reported = input.reportedCostUsd;
  if (reported !== null && reported !== undefined) {
    if (!Number.isFinite(reported) || reported < 0) {
      return { costUsd: null, costSource: "unknown", reason: `reported_cost_not_a_valid_number:${String(reported)}` };
    }
    return { costUsd: round6(reported), costSource: "reported", reason: "caller_metered_this_cost" };
  }
  const price = priceFor(input.model);
  if (!price) {
    return { costUsd: null, costSource: "unknown", reason: `no_price_entry_for_model:${String(input.model)}` };
  }
  const ti = input.tokensIn;
  const to = input.tokensOut;
  if (!isCount(ti) || !isCount(to)) {
    // Treating a missing token count as 0 would silently halve (or zero) the cost of the run.
    return {
      costUsd: null, costSource: "unknown", price,
      reason: `token_counts_missing_or_invalid:in=${String(ti)},out=${String(to)}`,
    };
  }
  const cost = (ti / 1_000_000) * price.inputPer1M + (to / 1_000_000) * price.outputPer1M;
  return { costUsd: round6(cost), costSource: "table", price, reason: `priced_from_table_asOf_${price.asOf}` };
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Six decimals: a 40-case suite on a cheap model costs fractions of a cent, and 0.00 is not a price. */
export function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1_000_000) / 1_000_000;
}
