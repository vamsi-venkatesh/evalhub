// Eval Hub — deterministic text metrics + the shared embedding space (Phase 2 addendum §1).
//
// Everything here is PURE except `miniLmEmbed`, which lazily loads @xenova/transformers.
// Every function that needs embeddings takes the embedder as an ARGUMENT, so the whole module is
// unit-testable with a fake embedder and the test suite never depends on a model download.
// There is no fallback that invents a similarity: if the model cannot load, the caller gets the
// loader's error and must decide (the /api/score route reports it, it never fabricates a number).

/** Normalization used by exactNorm/tokenF1/grounding: lowercase, strip punctuation, collapse ws. */
export function normalizeText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    // strip diacritics, then anything that is not a letter/digit/space becomes a space
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(s: string): string[] {
  const n = normalizeText(s);
  return n === "" ? [] : n.split(" ");
}

/** Contract §1: exact match AFTER normalization (lowercase, punctuation stripped, ws collapsed). */
export function exactNorm(expected: string, actual: string): boolean {
  return normalizeText(expected) === normalizeText(actual);
}

/**
 * SQuAD-style token F1 over the token MULTISETS (a repeated token counts twice, capped by the
 * other side). Both empty → 1 (two empty answers agree). Exactly one empty → 0.
 */
export function tokenF1(expected: string, actual: string): number {
  const g = tokenize(expected);
  const p = tokenize(actual);
  if (g.length === 0 && p.length === 0) return 1;
  if (g.length === 0 || p.length === 0) return 0;
  const gc = counts(g);
  let common = 0;
  for (const [tok, n] of counts(p)) common += Math.min(n, gc.get(tok) ?? 0);
  if (common === 0) return 0;
  const precision = common / p.length;
  const recall = common / g.length;
  return (2 * precision * recall) / (precision + recall);
}

function counts(toks: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

// ── embeddings ────────────────────────────────────────────────────────────────────────────────

/** Embed a batch of strings → unit-norm vectors, one per input, all the same dimension. */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2@q";
export const EMBED_DIM = 384;

let _pipe: Promise<unknown> | null = null;

/**
 * Lazy process-wide MiniLM singleton — the same model/space conxto's MNEMA uses
 * (@xenova/transformers v2, Xenova/all-MiniLM-L6-v2, quantized, mean-pooled + normalized), so a
 * similarity computed here means the same thing as one computed there.
 * First call downloads the model to TRANSFORMERS_CACHE (the box: /opt/evalhub/.cache).
 */
function pipe(): Promise<any> {
  if (_pipe) return _pipe as Promise<any>;
  _pipe = (async () => {
    // @ts-ignore — runtime-only dep; typecheck must not require the model package to be installed
    const { pipeline, env } = await import("@xenova/transformers");
    if (process.env.TRANSFORMERS_CACHE) env.cacheDir = process.env.TRANSFORMERS_CACHE;
    env.allowRemoteModels = true;
    return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });
  })();
  return _pipe as Promise<any>;
}

/** The real embedder. Sequential on purpose: the box is memory-capped (MemoryMax=320M). */
export const miniLmEmbed: EmbedFn = async (texts: string[]) => {
  const enc = await pipe();
  const out: number[][] = [];
  for (const t of texts) {
    const r = await enc((t ?? "").slice(0, 8000), { pooling: "mean", normalize: true });
    out.push(Array.from(r.data as Float32Array));
  }
  return out;
};

/** Cosine similarity, clamped to [0,1] (negatives mean "unrelated", not "less than unrelated"). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  if (!Number.isFinite(c)) return 0;
  return Math.max(0, Math.min(1, c));
}

/**
 * Cosine similarity of two strings in the embedding space. The embedder is INJECTED (default: the
 * real MiniLM) so tests can run without a model download. Two empty strings → 1; one empty → 0,
 * decided before the model is ever touched.
 */
export async function embedSim(a: string, b: string, embed: EmbedFn = miniLmEmbed): Promise<number> {
  const ea = (a ?? "").trim();
  const eb = (b ?? "").trim();
  if (ea === "" && eb === "") return 1;
  if (ea === "" || eb === "") return 0;
  const [va, vb] = await embed([ea, eb]);
  if (!va || !vb) throw new Error("embedder returned fewer vectors than inputs");
  return cosine(va, vb);
}

/** All three metrics for one (expected, actual) pair. embedSim is null ONLY if the caller says so. */
export type MetricScores = { exactNorm: boolean; tokenF1: number; embedSim: number | null };
