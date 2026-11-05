// Eval Hub — Cohen's kappa. PURE: no DB, no env, no clock (same law as verdict.ts).
//
//   po = observed agreement = (# pairs where both raters chose the same category) / n
//   pe = chance agreement   = Σ_k (rowMarginal_k / n) * (colMarginal_k / n)
//   κ  = (po − pe) / (1 − pe)
//
// THE DEGENERATE CASE, decided explicitly because the formula does not decide it:
// if pe == 1 the denominator is 0 and κ is mathematically UNDEFINED. pe can only reach 1 when both
// raters used exactly ONE category and it is the same one — which forces po == 1 (perfect
// agreement on a single-category corpus). We return **κ = 1** there and set `degenerate: true`, so
// a reader can see that the 1 came from "everyone said pass 25 times", not from a hard-won
// agreement across a mixed corpus. The alternative (returning 0 or NaN) would report perfect
// agreement as no agreement, which is the more misleading lie. `degenerate` is never hidden.
//
// n == 0 → { n: 0, kappa: 0, agreement: 0, degenerate: true }. The caller (POST /api/calibration/
// compute) refuses n < 20 long before this matters; the value exists so the function is total.

export type RatingPair = { human: string; judge: string };

export type KappaResult = {
  n: number;
  /** Raw observed agreement, 0..1 (4dp). */
  agreement: number;
  /** Cohen's kappa, −1..1 (4dp). See the degenerate note above. */
  kappa: number;
  /** Chance agreement pe (4dp) — shown so a suspiciously high kappa can be sanity-checked. */
  expected: number;
  categories: string[];
  /** confusion[humanCategory][judgeCategory] = count. */
  confusion: Record<string, Record<string, number>>;
  /** True when pe == 1 (single shared category) or n == 0: kappa is a CONVENTION, not a measure. */
  degenerate: boolean;
};

export function cohensKappa(pairs: RatingPair[]): KappaResult {
  const n = pairs.length;
  const categories = Array.from(new Set(pairs.flatMap((p) => [p.human, p.judge]))).sort();
  const confusion: Record<string, Record<string, number>> = {};
  for (const a of categories) {
    confusion[a] = {};
    for (const b of categories) confusion[a]![b] = 0;
  }
  if (n === 0) {
    return { n: 0, agreement: 0, kappa: 0, expected: 0, categories, confusion, degenerate: true };
  }

  let agree = 0;
  const humanMarg = new Map<string, number>();
  const judgeMarg = new Map<string, number>();
  for (const p of pairs) {
    confusion[p.human]![p.judge] = (confusion[p.human]![p.judge] ?? 0) + 1;
    humanMarg.set(p.human, (humanMarg.get(p.human) ?? 0) + 1);
    judgeMarg.set(p.judge, (judgeMarg.get(p.judge) ?? 0) + 1);
    if (p.human === p.judge) agree++;
  }
  const po = agree / n;
  let pe = 0;
  for (const c of categories) pe += ((humanMarg.get(c) ?? 0) / n) * ((judgeMarg.get(c) ?? 0) / n);

  const denom = 1 - pe;
  const degenerate = Math.abs(denom) < 1e-12;
  const kappa = degenerate ? (po >= 1 - 1e-12 ? 1 : 0) : (po - pe) / denom;

  return {
    n,
    agreement: r4(po),
    kappa: r4(kappa),
    expected: r4(pe),
    categories,
    confusion,
    degenerate,
  };
}

/** Landis & Koch bands — a label for the number, never a substitute for it. */
export function kappaBand(kappa: number): string {
  if (kappa < 0) return "worse than chance";
  if (kappa < 0.21) return "slight";
  if (kappa < 0.41) return "fair";
  if (kappa < 0.61) return "moderate";
  if (kappa < 0.81) return "substantial";
  return "almost perfect";
}

/** The hub refuses to compute a calibration below this: a kappa on 5 cases is theatre (addendum). */
export const MIN_CALIBRATION_LABELS = 20;

function r4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}
