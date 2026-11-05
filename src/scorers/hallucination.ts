// Eval Hub — hallucination scoring (Phase 2 addendum §3).
//
// SPLIT OF RESPONSIBILITY, on purpose:
//   • the LLM only ENUMERATES claims (a listing task it is good at),
//   • the SUPPORT decision is DETERMINISTIC (anchor containment, with an embedding fallback that
//     can only ever rescue ANCHORLESS claims). We never ask a model "is this hallucinated?" and
//     record the answer as truth — that is how an eval starts grading itself.
//
// Both the extractor and the embedder are INJECTED, so this module is fully testable with a fake
// judge (fixed claims) and a fake embedder, with no network at all.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RULE SET (2026-08-05, tuned on eval-corpus/tailoring-claims-2026-08-05.json — 28 real
// judge-extracted cases, 12 with planted fabrications, 16 clean incl. 4 aggressive rewrites and
// 2 German ones). Design goal: separate a PLANTED FABRICATION from an AGGRESSIVE-BUT-HONEST
// REWRITE. The discriminator is not wording overlap (a real tailoring pass rewrites everything);
// it is the HARD FACTS. A fabrication imports an employer / certificate / school / figure the
// sources simply do not contain; a rewrite reuses them and only re-phrases the connective tissue.
//
//  1. Anchors are extracted from the RAW claim (capitalisation carries the signal):
//     • NUMBER   — every digit run (separators stripped: "EUR 120,000" → "120000") plus spelled-out
//                  English numerals ("eleven" → "11"; an inflated "eleven years" is as hard a fact
//                  as "11 years").
//     • ENTITY   — a run of TWO OR MORE consecutive capitalised tokens ("Zalando SE", "TU Berlin",
//                  "Google Cloud Professional Data Engineer"), a token mixing letters and digits
//                  ("N26", "GA4", "p95", "780KB", "C1"), or an ALL-CAPS token containing a hyphen
//                  ("SHRM-SCP"). These are the STRONG anchors — every planted fabrication in the
//                  corpus is one of them or a number.
//     • WEAK     — a lone capitalised token ("Rakuten", "Terraform", "Mitarbeitende"). Carries
//                  little signal: GERMAN CAPITALISES EVERY NOUN, so ordinary German words look
//                  like proper nouns. Weak anchors are matched leniently and, when they miss, the
//                  claim is handed to the embedding tier rather than condemned.
//     • DROPPED  — a lone ALL-CAPS abbreviation of ≤5 letters ("MTTA", "API", "EUR", "A/B").
//                  An honest rewrite abbreviates ("MTTA" for "mean time to acknowledge"), so a
//                  standalone acronym is never evidence of fabrication. Inside a multi-token
//                  entity it still counts ("IESE Business School", "ISTQB Advanced Level ...").
//
//  2. Matching is against the UNION of all sources, because tailoring legitimately merges the
//     résumé with the job description ("Senior SRE" comes from the JD, "United Kingdom" from the
//     CV — per-source matching would flag the honest merge).
//     • numbers  — exact membership in the source's number set. No substring games: "47" must not
//                  be satisfied by "1947".
//     • entity   — EVERY token of the run must appear in nsCompact(sources) — the normalised
//                  sources with ALL punctuation and whitespace removed. Compaction is what makes
//                  "Node.js" match the source tokens ["node","js"] and the possessive "WEBER's"
//                  match "Weber". Up to 2 trailing characters may be dropped from a token of ≥6
//                  characters, and only then, to absorb German inflection ("Stadtwerken" →
//                  "Stadtwerke"). No prefix leniency beyond that: this is the gate the plants die on.
//     • weak     — the same containment, plus singular ("APIs" → "api") and longest-prefix ≥5
//                  ("Englischkenntnisse" → "Englisch"), which is how German compounds are honoured.
//
//  3. Verdict per claim:
//     • the normalised claim is a substring of a source            → supported, method "lexical".
//     • ≥1 anchor and every anchor matches                         → supported, method "anchor".
//     • a NUMBER or ENTITY anchor is missing                       → UNSUPPORTED, method
//       "unsupported_anchor", missingAnchors lists what was absent. This verdict is FINAL — the
//       embedding tier may not rescue it. That is the invariant that keeps plants from sneaking
//       through a similarity threshold: an invented employer scores highly against a résumé that
//       talks about the same job in the same words.
//     • only WEAK anchors missing, or no anchors at all            → embedding tier: embedSim vs
//       the best sliding source window ≥ 0.80 → supported ("embed"), else "unsupported".
//
//  THE 0.80 EMBED THRESHOLD IS UNCHANGED, and on evidence: the corpus scores IDENTICALLY with the
//  real MiniLM tier on and with it off (`EMBED=off tsx scripts/tune-hallucination.mts`). Nothing in
//  28 real cases was decided by a similarity, so there was nothing to retune; the tier stays as the
//  safety net for anchorless prose, where it can no longer touch a fabrication.
//
//  WHAT THIS DELIBERATELY ACCEPTS: a derived figure is flagged. "seven years of experience"
//  (computed from a 2018 start date) and "roughly EUR 1.4M annualised" (120,000 × 12) are honest
//  but their numbers are not in the sources, so they are reported unsupported — exactly as an
//  inflated "eleven years" is. The checker cannot tell arithmetic from invention, and it says so
//  rather than guessing; the corpus budgets for it (≤15% of a clean case's claims).
// ─────────────────────────────────────────────────────────────────────────────────────────────
import { cosine, EmbedFn, normalizeText, tokenize } from "./metrics.js";
import type { ClaimExtractor } from "./judge.js";

export const SUPPORT_EMBED_THRESHOLD = 0.8;
/** Trailing characters droppable from a strong token to absorb inflection (only if len >= 6). */
const INFLECTION_SLACK = 2;
/** Shortest prefix a weak token may be reduced to when matching a compound. */
const WEAK_MIN_PREFIX = 5;

export type Claim = {
  text: string;
  supported: boolean;
  bestSource: number | null;
  evidence: string | null;
  /** How it was decided. Never hidden. */
  method: "lexical" | "anchor" | "embed" | "unsupported_anchor" | "unsupported" | "no_sources";
  /** Best embedding similarity seen, when the embed path ran. Null if it did not. */
  similarity: number | null;
  /** The hard facts that are absent from every source. Present only when they decided the verdict. */
  missingAnchors?: string[];
};

export type HallucinationScore = {
  claims: Claim[];
  hallucinationRate: number;
  claimCount: number;
  /** Present only when the embed path could not run — the lexical verdicts still stand, and the
   *  caller is TOLD that the second, more permissive check never happened. */
  warnings?: string[];
};

// ── anchors ───────────────────────────────────────────────────────────────────────────────────

const WORD_NUMBERS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
  nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
  sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30",
  forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90", hundred: "100",
};

/** Digits (separator-normalised) AND spelled-out English numerals. Both sides normalise alike. */
export function extractNumbers(text: string): string[] {
  const out = (text.match(/\d[\d.,]*/g) || []).map((n) => n.replace(/[.,]+$/, "").replace(/[.,]/g, ""));
  for (const t of text.toLowerCase().match(/[a-z]+/g) || []) {
    if (WORD_NUMBERS[t]) out.push(WORD_NUMBERS[t]);
  }
  return Array.from(new Set(out.filter((n) => n.length > 0)));
}

/** Normalised text with every separator removed: "Node.js, TypeScript" → "nodejstypescript". */
export function nsCompact(s: string): string {
  return normalizeText(s).replace(/\s+/g, "");
}

/** One whitespace token, stripped of surrounding punctuation and of the English possessive. */
export function cleanToken(raw: string): string {
  return (raw ?? "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}%]+$/u, "")
    .replace(/['’]s$/u, "")
    .replace(/['’]$/u, "");
}

const isCapitalized = (t: string): boolean => /^\p{Lu}/u.test(t);
const hasLetterAndDigit = (t: string): boolean => /\p{L}/u.test(t) && /\d/.test(t);
const isAllCaps = (t: string): boolean => /^[\p{Lu}\p{N}&./+-]+$/u.test(t) && /\p{Lu}/u.test(t);
/** A lone acronym ("MTTA", "API", "EUR") — an abbreviation an honest rewrite is free to coin. */
const isLoneAcronym = (t: string): boolean => /^\p{Lu}{2,5}$/u.test(t);
/**
 * Closed-class words that are only ever capitalised because a sentence starts with them. They must
 * never OPEN a proper-noun run: German capitalises the noun that follows, so "Die Senkung" and
 * "Die Time-to-Hire" would otherwise become strong entities made of ordinary grammar.
 */
const RUN_OPENERS_TO_DROP = new Set([
  "the","a","an","this","that","these","those","his","her","their","its","our","my","he","she","they","we","it","and","but","or","if","when","while",
  "die","der","das","den","dem","des","ein","eine","einen","einem","einer","eines","im","in","bei","es","er","sie","wir","ich","und","oder","als","auch","dann","für","von","mit","auf","aus","dass","weil",
]);

export type Anchor = {
  kind: "number" | "entity" | "weak";
  /** Human-readable anchor as it appeared in the claim. */
  text: string;
  /** Compacted tokens that must be found (numbers: the normalised figure). */
  tokens: string[];
};

/**
 * Anchors of a claim, per rule 1 in the header. Pure; capitalisation of the RAW claim matters.
 */
export function extractAnchors(rawClaim: string): Anchor[] {
  const anchors: Anchor[] = [];
  for (const n of extractNumbers(rawClaim)) anchors.push({ kind: "number", text: n, tokens: [n] });

  for (const sentence of (rawClaim ?? "").split(/(?<=[.!?])\s+/)) {
    const toks = sentence.trim().split(/\s+/).map(cleanToken).filter((t) => t.length > 0);
    let run: string[] = [];
    const flushRun = () => {
      // Strip leading closed-class openers ("Die Senkung" → "Senkung"): capitalisation there is
      // grammar, not a name.
      let eff = run;
      while (eff.length > 0 && RUN_OPENERS_TO_DROP.has(nsCompact(eff[0] as string))) eff = eff.slice(1);
      if (eff.length >= 2) {
        const tokens = eff.map(nsCompact).filter((t) => t.length > 0);
        if (tokens.length >= 2) anchors.push({ kind: "entity", text: eff.join(" "), tokens });
      } else if (eff.length === 1) {
        const t = eff[0] as string;
        const c = nsCompact(t);
        if (c.length === 0) {
          // nothing
        } else if (isAllCaps(t) && t.includes("-")) {
          anchors.push({ kind: "entity", text: t, tokens: [c] });
        } else if (!isLoneAcronym(t)) {
          anchors.push({ kind: "weak", text: t, tokens: [c] });
        }
      }
      run = [];
    };
    for (const t of toks) {
      // A CAPITALISED letter+digit token ("N26", "GA4", "C1") is a strong entity in its own right
      // and never joins a run: it must not drag a neighbouring word into a phrase gate ("Niveau C1"
      // — C1 is in the source, "Niveau" is ordinary German). Lowercase/digit-initial forms
      // ("p95", "60-merchant", "1.4M") are left to the NUMBER anchor, which is what carries them.
      if (hasLetterAndDigit(t) && isCapitalized(t)) {
        flushRun();
        const c = nsCompact(t);
        if (c.length > 0) anchors.push({ kind: "entity", text: t, tokens: [c] });
        continue;
      }
      if (isCapitalized(t)) {
        run.push(t);
      } else {
        flushRun();
      }
    }
    flushRun();
  }
  return dedupeAnchors(anchors);
}

function dedupeAnchors(anchors: Anchor[]): Anchor[] {
  const seen = new Set<string>();
  const out: Anchor[] = [];
  for (const a of anchors) {
    const k = `${a.kind}:${a.tokens.join("|")}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** Back-compat surface: the flat list of hard facts a claim asserts. */
export function keyFacts(claim: string): string[] {
  return extractAnchors(claim).flatMap((a) => a.tokens);
}

// ── matching ──────────────────────────────────────────────────────────────────────────────────

/** Strong containment: the whole token, or the token minus up to 2 trailing characters (len>=6). */
export function strongTokenFound(token: string, compact: string): boolean {
  if (token === "") return false;
  if (compact.includes(token)) return true;
  if (token.length >= 6) {
    for (let cut = 1; cut <= INFLECTION_SLACK; cut++) {
      const stem = token.slice(0, token.length - cut);
      if (stem.length >= 4 && compact.includes(stem)) return true;
    }
  }
  return false;
}

/** Weak containment: strong, or singular, or a prefix of >= WEAK_MIN_PREFIX characters. */
export function weakTokenFound(token: string, compact: string): boolean {
  if (strongTokenFound(token, compact)) return true;
  if (token.endsWith("s") && strongTokenFound(token.slice(0, -1), compact)) return true;
  for (let len = token.length - 1; len >= WEAK_MIN_PREFIX; len--) {
    if (compact.includes(token.slice(0, len))) return true;
  }
  return false;
}

export function anchorFound(anchor: Anchor, compact: string, numbers: Set<string>): boolean {
  if (anchor.kind === "number") return numbers.has(anchor.tokens[0] ?? "");
  const found = anchor.kind === "weak" ? weakTokenFound : strongTokenFound;
  return anchor.tokens.every((t) => found(t, compact));
}

export type SupportVerdict = {
  status: "verbatim" | "anchored" | "missing_hard_anchor" | "weak_gap" | "anchorless";
  /** Anchor texts that no source contains. */
  missing: string[];
  /** The source that matched the most anchors (null when nothing matched). */
  bestSource: number | null;
  evidence: string | null;
};

/**
 * The deterministic support decision for ONE claim against ALL sources (rules 2–3 in the header).
 * Pure. The embedding tier is only consulted for "weak_gap" and "anchorless".
 */
export function decideSupport(claim: string, sources: string[]): SupportVerdict {
  const nc = normalizeText(claim);
  if (nc === "") return { status: "anchorless", missing: [], bestSource: null, evidence: null };

  for (let s = 0; s < sources.length; s++) {
    if (normalizeText(sources[s] ?? "").includes(nc)) {
      return { status: "verbatim", missing: [], bestSource: s, evidence: clip(sources[s] ?? "") };
    }
  }

  const anchors = extractAnchors(claim);
  if (anchors.length === 0) return { status: "anchorless", missing: [], bestSource: null, evidence: null };

  const compacts = sources.map((s) => nsCompact(s ?? ""));
  const numberSets = sources.map((s) => new Set(extractNumbers(s ?? "")));
  const unionCompact = compacts.join("");
  const unionNumbers = new Set(numberSets.flatMap((s) => Array.from(s)));

  const missingHard: string[] = [];
  const missingWeak: string[] = [];
  for (const a of anchors) {
    if (anchorFound(a, unionCompact, unionNumbers)) continue;
    (a.kind === "weak" ? missingWeak : missingHard).push(a.text);
  }

  // Attribute the claim to whichever single source carries the most of its anchors (evidence only).
  let bestSource: number | null = null;
  let bestHits = 0;
  for (let s = 0; s < sources.length; s++) {
    const hits = anchors.filter((a) => anchorFound(a, compacts[s] ?? "", numberSets[s] ?? new Set())).length;
    if (hits > bestHits) { bestHits = hits; bestSource = s; }
  }

  if (missingHard.length > 0) {
    return { status: "missing_hard_anchor", missing: missingHard, bestSource: null, evidence: null };
  }
  if (missingWeak.length > 0) {
    return { status: "weak_gap", missing: missingWeak, bestSource, evidence: bestSource === null ? null : clip(sources[bestSource] ?? "") };
  }
  return {
    status: "anchored",
    missing: [],
    bestSource: bestSource ?? 0,
    evidence: clip(sources[bestSource ?? 0] ?? ""),
  };
}

/**
 * Back-compat single-source predicate: true iff the claim is verbatim-contained in the source or
 * every one of its anchors is found there. A claim with NO anchors cannot be settled lexically and
 * returns false (it belongs to the embedding tier).
 */
export function lexicallySupported(claim: string, source: string): boolean {
  const v = decideSupport(claim, [source]);
  return v.status === "verbatim" || v.status === "anchored";
}

/** Sliding token windows of a source, sized around the claim. Capped + deduped. */
export function sourceWindows(source: string, claimTokens: number, maxWindows = 60): string[] {
  const toks = tokenize(source);
  if (toks.length === 0) return [];
  const size = Math.min(Math.max(claimTokens * 2, 24), Math.max(toks.length, 1));
  const stride = Math.max(1, Math.floor(size / 2));
  const out: string[] = [];
  for (let i = 0; i < toks.length && out.length < maxWindows; i += stride) {
    out.push(toks.slice(i, i + size).join(" "));
    if (i + size >= toks.length) break;
  }
  return out.length === 0 ? [toks.join(" ")] : out;
}

export type HallucinationDeps = {
  extractClaims: ClaimExtractor;
  /** Batch embedder. If it throws, the lexical verdicts stand and a warning is emitted. */
  embed: EmbedFn;
};

export async function scoreHallucination(
  input: { output: string; sources: string[] },
  deps: HallucinationDeps
): Promise<HallucinationScore> {
  const sources = input.sources ?? [];
  // Provider failure here PROPAGATES (JudgeProviderError → 502). No claims list, no score.
  const texts = await deps.extractClaims(input.output ?? "");
  const claimTexts = texts.filter((t) => t.trim() !== "");
  const warnings: string[] = [];

  if (claimTexts.length === 0) {
    return { claims: [], hallucinationRate: 0, claimCount: 0 };
  }
  if (sources.length === 0) {
    // No sources = nothing can be supported. That is a 100% hallucination rate, stated plainly.
    const claims: Claim[] = claimTexts.map((t) => ({ text: t, supported: false, bestSource: null, evidence: null, method: "no_sources", similarity: null }));
    return { claims, hallucinationRate: 1, claimCount: claims.length, warnings: ["no sources supplied — every claim is unsupported by construction"] };
  }

  // Pass 1 — deterministic anchor containment. Cheap, and it needs no model.
  const claims: Claim[] = [];
  const needEmbed: number[] = [];
  for (const text of claimTexts) {
    const v = decideSupport(text, sources);
    if (v.status === "verbatim" || v.status === "anchored") {
      claims.push({ text, supported: true, bestSource: v.bestSource, evidence: v.evidence, method: v.status === "verbatim" ? "lexical" : "anchor", similarity: null });
    } else if (v.status === "missing_hard_anchor") {
      // FINAL. A missing hard fact is never rescued by a similarity score — that is precisely how
      // an invented employer would slip through (it sits in a sentence that otherwise matches).
      claims.push({ text, supported: false, bestSource: null, evidence: null, method: "unsupported_anchor", similarity: null, missingAnchors: v.missing });
    } else {
      needEmbed.push(claims.length);
      claims.push({ text, supported: false, bestSource: null, evidence: null, method: "unsupported", similarity: null, ...(v.missing.length ? { missingAnchors: v.missing } : {}) });
    }
  }

  // Pass 2 — embedSim(claim, best source window) >= 0.80, for the anchorless / weak-gap claims only.
  if (needEmbed.length > 0) {
    const windows: { s: number; text: string }[] = [];
    const maxClaimTokens = Math.max(...needEmbed.map((i) => tokenize(claims[i]!.text).length), 8);
    for (let s = 0; s < sources.length; s++) {
      for (const w of sourceWindows(sources[s] ?? "", maxClaimTokens)) windows.push({ s, text: w });
    }
    if (windows.length > 0) {
      try {
        const claimVecs = await deps.embed(needEmbed.map((i) => claims[i]!.text));
        const winVecs = await deps.embed(windows.map((w) => w.text));
        needEmbed.forEach((ci, k) => {
          const cv = claimVecs[k];
          if (!cv) return;
          let best = 0;
          let bestIdx = -1;
          winVecs.forEach((wv, wi) => {
            if (!wv) return;
            const sim = cosine(cv, wv);
            if (sim > best) { best = sim; bestIdx = wi; }
          });
          const c = claims[ci]!;
          c.similarity = round4(best);
          if (best >= SUPPORT_EMBED_THRESHOLD && bestIdx >= 0) {
            c.supported = true;
            c.method = "embed";
            c.bestSource = windows[bestIdx]!.s;
            c.evidence = clip(windows[bestIdx]!.text);
            delete c.missingAnchors;
          }
        });
      } catch (e) {
        // NEVER guess. The lexical verdicts are real; the embed pass is declared missing.
        warnings.push(`embed_support_check_unavailable: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    }
  }

  const unsupported = claims.filter((c) => !c.supported).length;
  return {
    claims,
    hallucinationRate: round4(unsupported / claims.length),
    claimCount: claims.length,
    ...(warnings.length ? { warnings } : {}),
  };
}

function clip(s: string): string {
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}
