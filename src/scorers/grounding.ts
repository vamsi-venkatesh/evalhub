// Eval Hub — citation grounding (Phase 2 addendum §4). FULLY DETERMINISTIC. No LLM, no embeddings,
// no network: the same (citations, sources) pair scores identically on the box, on a laptop, and in
// a year's time. That is the whole point — this is the check that CAN gate.
//
// A citation is `found` iff:
//   (a) EXACT: the normalized quote is a substring of the normalized source  → similarity 1
//   (b) FUZZY: the best sliding token-window of the source scores tokenF1 >= 0.85 against the quote
//
// CHOICE OF FUZZY MEASURE (the addendum permits token-overlap OR embedSim): we use normalized
// token-overlap (the same SQuAD-style multiset tokenF1 as metrics.ts) over sliding windows, NOT
// embedSim. Reason: grounding is a QUOTATION check. A paraphrase that means the same thing is not
// the quote the product claimed to have copied, and embedSim would happily call it 0.9. Token
// overlap catches the real-world case (whitespace, casing, punctuation, an inserted word, a
// truncated tail) while still failing an invented quote. It also keeps this scorer model-free.
import { normalizeText, tokenF1, tokenize } from "./metrics.js";

export const GROUNDING_FUZZY_THRESHOLD = 0.85;
/** Hard cap on source tokens scanned per citation. Declared, never silent (see `truncated`). */
export const MAX_SOURCE_TOKENS = 20_000;

export type Citation = { sourceId: string; quote: string };
export type SourceMap = Record<string, string>;

export type CitationCheck = {
  sourceId: string;
  quote: string;
  found: boolean;
  similarity: number;
  /** 'exact' | 'fuzzy' | 'miss' | 'unknown_source' | 'empty_quote' — why it scored what it scored. */
  match: "exact" | "fuzzy" | "miss" | "unknown_source" | "empty_quote";
  /** The winning source window, for a human reading the report. Null on a miss. */
  evidence: string | null;
  /** True if the source was longer than MAX_SOURCE_TOKENS and the scan was capped. */
  truncated?: boolean;
};

export type GroundingScore = {
  valid: CitationCheck[];
  groundingRate: number;
  citationCount: number;
};

/** Best sliding-window token-overlap of `quote` inside `source`, plus the winning window text. */
export function bestWindowSimilarity(quote: string, source: string): { similarity: number; window: string | null; truncated: boolean } {
  const q = tokenize(quote);
  const all = tokenize(source);
  if (q.length === 0 || all.length === 0) return { similarity: 0, window: null, truncated: false };
  const truncated = all.length > MAX_SOURCE_TOKENS;
  const s = truncated ? all.slice(0, MAX_SOURCE_TOKENS) : all;

  // Window sizes bracket the quote length so an inserted or dropped word can still win.
  const sizes = new Set<number>([q.length, Math.max(1, q.length - 1), q.length + 1, Math.max(1, Math.round(q.length * 0.8)), Math.round(q.length * 1.2)]);
  let best = 0;
  let bestWin: string | null = null;
  const qs = q.join(" ");
  for (const size of sizes) {
    if (size <= 0 || size > s.length) {
      // The quote is longer than the whole source: compare against the entire source once.
      if (size > s.length && bestWin === null) {
        const whole = s.join(" ");
        const sim = tokenF1(qs, whole);
        if (sim > best) { best = sim; bestWin = whole; }
      }
      continue;
    }
    for (let i = 0; i + size <= s.length; i++) {
      const win = s.slice(i, i + size).join(" ");
      const sim = tokenF1(qs, win);
      if (sim > best) { best = sim; bestWin = win; }
      if (best === 1) break;
    }
    if (best === 1) break;
  }
  return { similarity: best, window: bestWin, truncated };
}

export function checkCitation(c: Citation, sources: SourceMap): CitationCheck {
  const base = { sourceId: c.sourceId, quote: c.quote };
  if (!c.quote || normalizeText(c.quote) === "") {
    // An empty quote is not "grounded in everything". It is a broken citation.
    return { ...base, found: false, similarity: 0, match: "empty_quote", evidence: null };
  }
  const src = sources[c.sourceId];
  if (typeof src !== "string") {
    return { ...base, found: false, similarity: 0, match: "unknown_source", evidence: null };
  }
  const nq = normalizeText(c.quote);
  const ns = normalizeText(src);
  if (ns.includes(nq)) {
    return { ...base, found: true, similarity: 1, match: "exact", evidence: clip(nq) };
  }
  const { similarity, window, truncated } = bestWindowSimilarity(c.quote, src);
  const sim = round4(similarity);
  const found = sim >= GROUNDING_FUZZY_THRESHOLD;
  return {
    ...base,
    found,
    similarity: sim,
    match: found ? "fuzzy" : "miss",
    evidence: found && window ? clip(window) : null,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Score a whole citation set. Zero citations → rate 0 (nothing was grounded), never 1. */
export function scoreGrounding(citations: Citation[], sources: SourceMap): GroundingScore {
  const valid = citations.map((c) => checkCitation(c, sources));
  const found = valid.filter((v) => v.found).length;
  return {
    valid,
    groundingRate: valid.length === 0 ? 0 : round4(found / valid.length),
    citationCount: valid.length,
  };
}

function clip(s: string): string {
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}
