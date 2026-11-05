// Eval Hub — the human-review core: what to put in front of the founder, in what order, and what
// the screen is allowed to say about it.
//
// THREE JOBS, deliberately in one file because they are one decision:
//   1. RANKING (pure)  — rankReviewCandidates(): which judged cases teach the most, in what order.
//   2. CARD (pure)     — buildReviewCard(): the four things a human needs to rule on a case.
//   3. SHARED SERVER   — resolveReviewItem() / kappaSnapshot(): the ONE resolve path and the ONE
//                        definition of a (human, judge) pair, so /api/review/:id/resolve, the
//                        screen's own POST, and /api/calibration/compute can never disagree.
//
// THE HONESTY RULE THAT SHAPES ALL OF IT: the hub stores no per-case judge confidence. The judged
// rows carry exactly `judgeVerdict`, `hallucinationRate` | `groundingRate`, `claimCount`, `model`
// (verified against the live hub DB, 2026-08-05: 46 judged rows, conxto/grounding 18 +
// conxto/tailoring_integrity 28). So nothing here invents one. Ranking uses the product's OWN
// borderline bands — the constants already written in conxto scripts/eval/run-llm.mts
// advisoryJudgeVerdict() — plus distance to the pass/fail flip point of the real rate field, and
// rankReviewCandidates() RETURNS the explanation it used so the caller must print it.
import { cohensKappa, kappaBand, type KappaResult } from "./kappa.js";
import { writeLabels } from "./labels.js";
import type { Sql } from "./db.js";

// ── 1. RANKING ────────────────────────────────────────────────────────────────────────────────

/**
 * The product's own advisory bands, copied here as DATA with their provenance, not re-derived.
 * conxto scripts/eval/run-llm.mts:
 *   tailoring_integrity → judgeVerdict = fail iff hallucinationRate > 0; borderline iff <= 0.15
 *   grounding           → judgeVerdict = fail iff groundingRate < 1;     borderline iff >= 0.85
 * A suite that is not in this map has no known metric: its cases are EXCLUDED and NAMED, never
 * ranked by a rule invented on the spot.
 */
export const SUITE_RULES: Record<
  string,
  { metric: string; failWhen: string; failIsAbove: boolean; threshold: number; borderlineFrom: number }
> = {
  tailoring_integrity: {
    metric: "hallucinationRate",
    failWhen: "hallucinationRate > 0",
    failIsAbove: true,
    threshold: 0,
    borderlineFrom: 0.15,
  },
  grounding: {
    metric: "groundingRate",
    failWhen: "groundingRate < 1",
    failIsAbove: false,
    threshold: 1,
    borderlineFrom: 0.85,
  },
};

export type JudgedRow = {
  suite: string;
  caseId: string;
  pass: boolean;
  scores: Record<string, unknown> | null;
  output: unknown;
  tags: string[] | null;
  gitSha: string;
  measuredAt: string;
};

export type RankedCandidate = {
  row: JudgedRow;
  verdict: "pass" | "fail";
  metric: string;
  value: number;
  /** |value − threshold|. The ONLY continuous signal in the data. 0 on the pass side of both
   *  suites, because both suites' pass condition is an exact value (rate 0 / rate 1) — so the
   *  passes carry NO gradation at all, and this file says so rather than pretending they do. */
  distance: number;
  borderline: boolean;
  tier: 1 | 2;
  rank: number;
};

export type RankExclusion = { caseId: string; suite: string; reason: string };

export type RankResult = {
  ordered: RankedCandidate[];
  excluded: RankExclusion[];
  /** Lines the caller MUST print. The ranking is only honest if the reader can see the rule. */
  explanation: string[];
  counts: {
    considered: number;
    ranked: number;
    excluded: number;
    tier1Borderline: number;
    tier2Rest: number;
    pass: number;
    fail: number;
    confidenceFieldFound: boolean;
    scoreKeysSeen: string[];
  };
};

/** Names of fields that WOULD be a per-case confidence signal if the product ever pushed one. */
const CONFIDENCE_KEYS = ["confidence", "judgeConfidence", "logprob", "logProb", "probability", "certainty"];

/**
 * PURE. No DB, no clock, no env — same law as verdict.ts and kappa.ts.
 * Ranking, in one sentence: the product's borderline band first (closest to the flip point first),
 * then everything else alternating fail/pass so an early stop still leaves both categories present
 * — a single-category corpus produces kappa's degenerate case, which measures nothing.
 */
export function rankReviewCandidates(rows: readonly JudgedRow[], opts: { limit?: number } = {}): RankResult {
  const excluded: RankExclusion[] = [];
  const cands: RankedCandidate[] = [];
  const scoreKeys = new Set<string>();

  for (const row of rows) {
    for (const k of Object.keys(row.scores ?? {})) scoreKeys.add(k);
    const verdictRaw = String((row.scores as Record<string, unknown> | null)?.judgeVerdict ?? "").toLowerCase();
    if (verdictRaw !== "pass" && verdictRaw !== "fail") {
      excluded.push({ caseId: row.caseId, suite: row.suite, reason: `judge_verdict_not_binary:${verdictRaw || "absent"}` });
      continue;
    }
    const rule = SUITE_RULES[row.suite];
    if (!rule) {
      excluded.push({ caseId: row.caseId, suite: row.suite, reason: "no_known_metric_for_suite" });
      continue;
    }
    const value = Number((row.scores as Record<string, unknown>)[rule.metric]);
    if (!Number.isFinite(value)) {
      excluded.push({ caseId: row.caseId, suite: row.suite, reason: `metric_missing:${rule.metric}` });
      continue;
    }
    const distance = Math.abs(value - rule.threshold);
    // The band is a FAIL-side band in both suites (a pass sits exactly on the threshold), so a
    // borderline case is by construction a fail near the flip point.
    const borderline =
      verdictRaw === "fail" &&
      (rule.failIsAbove ? value > rule.threshold && value <= rule.borderlineFrom : value < rule.threshold && value >= rule.borderlineFrom);
    cands.push({
      row,
      verdict: verdictRaw,
      metric: rule.metric,
      value,
      distance,
      borderline,
      tier: borderline ? 1 : 2,
      rank: 0,
    });
  }

  const byCase = (a: RankedCandidate, b: RankedCandidate) => a.row.caseId.localeCompare(b.row.caseId);
  const tier1 = cands.filter((c) => c.tier === 1).sort((a, b) => a.distance - b.distance || byCase(a, b));
  const rest = cands.filter((c) => c.tier === 2);
  // Fails outside the band still have gradation: nearest the flip point first.
  const restFail = rest.filter((c) => c.verdict === "fail").sort((a, b) => a.distance - b.distance || byCase(a, b));
  // Passes have NO gradation (distance is 0 for every one of them). Case-id order, stated as such,
  // because a fabricated tie-break would look like a signal.
  const restPass = rest.filter((c) => c.verdict === "pass").sort(byCase);

  const interleaved: RankedCandidate[] = [];
  for (let i = 0; i < Math.max(restFail.length, restPass.length); i++) {
    if (restFail[i]) interleaved.push(restFail[i]!);
    if (restPass[i]) interleaved.push(restPass[i]!);
  }

  let ordered = [...tier1, ...interleaved];
  const beforeLimit = ordered.length;
  const limit = opts.limit;
  if (limit !== undefined && ordered.length > limit) {
    for (const c of ordered.slice(limit)) {
      excluded.push({ caseId: c.row.caseId, suite: c.row.suite, reason: `over_limit:${limit}` });
    }
    ordered = ordered.slice(0, limit);
  }
  ordered.forEach((c, i) => (c.rank = i + 1));

  const confidenceFieldFound = CONFIDENCE_KEYS.some((k) => scoreKeys.has(k));
  const t1 = ordered.filter((c) => c.tier === 1).length;
  const explanation: string[] = [];
  explanation.push(
    confidenceFieldFound
      ? `A per-case confidence field IS present in results.scores (${CONFIDENCE_KEYS.filter((k) => scoreKeys.has(k)).join(", ")}) — but this ranker does NOT read it yet; it ranks by distance to the judge's own threshold. Say so before trusting the order.`
      : `NO per-case judge confidence exists in the data. results.scores carries only: ${[...scoreKeys].sort().join(", ") || "(nothing)"}. Nothing was invented to stand in for one.`,
  );
  explanation.push(
    `TIER 1 (${t1} case${t1 === 1 ? "" : "s"}) — inside the product's OWN advisory borderline band ` +
      `(conxto run-llm.mts advisoryJudgeVerdict: tailoring_integrity hallucinationRate in (0, 0.15]; ` +
      `grounding groundingRate in [0.85, 1)). Ordered by distance to the flip point, closest first: ` +
      `these are the verdicts the judge's threshold decided most arbitrarily.`,
  );
  explanation.push(
    `TIER 2 (${ordered.length - t1}) — everything else, ALTERNATING fail/pass. Fails are ordered by ` +
      `distance to the threshold (closest first); passes are ordered by case id because they carry ` +
      `NO gradation at all — every pass sits exactly on the threshold (hallucinationRate 0 / ` +
      `groundingRate 1), so there is no borderline signal on the pass side and none is faked. ` +
      `The alternation exists so that stopping early still leaves both verdicts in the labelled set: ` +
      `a single-category corpus makes Cohen's kappa degenerate and measures nothing.`,
  );
  if (limit !== undefined && beforeLimit > limit) {
    explanation.push(`LEFT OUT by --limit ${limit}: ${beforeLimit - limit} ranked case(s), listed as over_limit exclusions.`);
  }
  if (excluded.length > 0) {
    const byReason = new Map<string, number>();
    for (const e of excluded) {
      const key = e.reason.split(":")[0]!;
      byReason.set(key, (byReason.get(key) ?? 0) + 1);
    }
    explanation.push(`LEFT OUT (${excluded.length}): ` + [...byReason].map(([r, n]) => `${r}×${n}`).join(", "));
  }

  return {
    ordered,
    excluded,
    explanation,
    counts: {
      considered: rows.length,
      ranked: ordered.length,
      excluded: excluded.length,
      tier1Borderline: t1,
      tier2Rest: ordered.length - t1,
      pass: ordered.filter((c) => c.verdict === "pass").length,
      fail: ordered.filter((c) => c.verdict === "fail").length,
      confidenceFieldFound,
      scoreKeysSeen: [...scoreKeys].sort(),
    },
  };
}

// ── 2. THE CARD ───────────────────────────────────────────────────────────────────────────────

export type EvidenceItem = {
  /** What the agent asserted / cited. */
  claim: string;
  /** The judge's machine ruling on THIS item. */
  state: "supported" | "unsupported" | "found" | "not found";
  /** The source text the hub matched it against — null when the hub found none. */
  source: string | null;
  sourceId: string | null;
  similarity: number | null;
};

export type ReviewCard = {
  v: 1;
  caseId: string;
  suite: string;
  input: { label: string; text: string } | null;
  answer: { label: string; text: string } | null;
  source: { label: string; text: string } | null;
  /** Non-null whenever a part of the card is missing or partial. Shown on screen, never swallowed. */
  gaps: string[];
  evidence: EvidenceItem[];
  judge: {
    verdict: "pass" | "fail";
    rule: string;
    metric: string;
    value: number;
    borderline: boolean;
    reasoning: string;
  };
  meta: { tags: string[]; gitSha: string; measuredAt: string; rank: number; tier: 1 | 2; distance: number };
};

/** A golden fixture line, when the caller supplies one (--fixtures). Shapes are the product's. */
export type FixtureCase = {
  id: string;
  suite?: string;
  input?: Record<string, unknown>;
  tags?: string[];
};

/**
 * PURE. Builds the four things a human needs — the case input, what the agent answered, the source
 * it cited, and the judge's verdict with its reasoning — out of what the hub ACTUALLY stores, plus
 * the golden fixture when one is supplied. Everything absent is named in `gaps`, never implied.
 */
export function buildReviewCard(c: RankedCandidate, fixture?: FixtureCase): ReviewCard {
  const gaps: string[] = [];
  const out = c.row.output as Record<string, unknown> | null;
  let evidence: EvidenceItem[] = [];

  if (c.row.suite === "grounding") {
    const valid = Array.isArray(out?.valid) ? (out!.valid as Record<string, unknown>[]) : [];
    if (valid.length === 0) gaps.push("The hub stored no per-citation ruling for this case.");
    evidence = valid.map((v) => ({
      claim: String(v.quote ?? ""),
      state: v.found === true ? ("found" as const) : ("not found" as const),
      source: v.evidence === undefined || v.evidence === null ? null : String(v.evidence),
      sourceId: v.sourceId === undefined || v.sourceId === null ? null : String(v.sourceId),
      similarity: Number.isFinite(Number(v.similarity)) ? Number(v.similarity) : null,
    }));
  } else {
    // tailoring_integrity. 25 of 28 rows on the live hub carry only `preview` — the PRODUCT
    // truncated the score payload at MAX_OUTPUT_CHARS. Whole claim objects are salvaged from the
    // prefix; the count that did NOT survive is stated on the card, because a fail verdict whose
    // unsupported claim was truncated away cannot be honestly agreed with.
    let claims: Record<string, unknown>[] = [];
    if (Array.isArray(out?.claims)) {
      claims = out!.claims as Record<string, unknown>[];
    } else if (typeof out?.preview === "string") {
      claims = salvageClaims(out.preview as string);
      const total = Number(c.row.scores?.claimCount);
      const totalTxt = Number.isFinite(total) ? String(total) : "an unknown number of";
      gaps.push(
        `Evidence is PARTIAL: the product truncated this result at ${Number(out.originalChars) || "?"} chars, ` +
          `so ${claims.length} of ${totalTxt} claims were recovered. A claim that decided the verdict may not be shown.`,
      );
    } else {
      gaps.push("The hub stored no per-claim ruling for this case.");
    }
    evidence = claims.map((v) => ({
      claim: String(v.text ?? ""),
      state: v.supported === true ? ("supported" as const) : ("unsupported" as const),
      source: v.evidence === undefined || v.evidence === null ? null : String(v.evidence),
      sourceId: v.bestSource === undefined || v.bestSource === null ? null : `source ${String(v.bestSource)}`,
      similarity: Number.isFinite(Number(v.similarity)) ? Number(v.similarity) : null,
    }));
  }

  // The items the verdict hinges on go first. Order is presentation, never a change to the ruling.
  evidence = [
    ...evidence.filter((e) => e.state === "unsupported" || e.state === "not found"),
    ...evidence.filter((e) => e.state === "supported" || e.state === "found"),
  ];

  let input: ReviewCard["input"] = null;
  let answer: ReviewCard["answer"] = null;
  let source: ReviewCard["source"] = null;
  const fi = fixture?.input;
  if (fi && c.row.suite === "tailoring_integrity") {
    input = { label: "Job description the résumé was tailored to", text: String(fi.jd ?? "") };
    answer = { label: "What the agent produced (tailored résumé)", text: String(fi.tailoredOutput ?? "") };
    source = { label: "The only permitted source (the candidate's real résumé)", text: String(fi.resume ?? "") };
  } else if (fi && c.row.suite === "grounding") {
    const cites = Array.isArray(fi.citations) ? (fi.citations as Record<string, unknown>[]) : [];
    input = {
      label: "Citations the agent attached",
      text: cites.map((x, i) => `[${i + 1}] ${String(x.sourceId ?? "?")} — “${String(x.quote ?? "")}”`).join("\n\n"),
    };
    answer = { label: "What the agent answered", text: String(fi.answer ?? "") };
    const srcs = (fi.sources ?? {}) as Record<string, string>;
    source = {
      label: "The sources it was allowed to cite",
      text: Object.entries(srcs).map(([k, v]) => `── ${k} ──\n${v}`).join("\n\n"),
    };
  } else {
    gaps.push(
      "The case INPUT is not stored by the hub — the product pushes only the score payload. " +
        "Run the enqueue script with --fixtures <dir of the golden .jsonl> to put the real input, the " +
        "agent's answer and the source on this card.",
    );
  }

  const rule = SUITE_RULES[c.row.suite]!;
  const reasoning =
    `The judge is a THRESHOLD, not a model: verdict = fail iff ${rule.failWhen}. ` +
    `Here ${c.metric} = ${c.value}, so it said ${c.verdict.toUpperCase()}. ` +
    (c.borderline
      ? `This is inside the product's own borderline band — the threshold decided it, not a margin.`
      : c.verdict === "pass"
        ? `Every pass sits exactly on the threshold, so there is no margin to read.`
        : `Distance from the threshold: ${round4(c.distance)}.`);

  return {
    v: 1,
    caseId: c.row.caseId,
    suite: c.row.suite,
    input,
    answer,
    source,
    gaps,
    evidence,
    judge: {
      verdict: c.verdict,
      rule: rule.failWhen,
      metric: c.metric,
      value: c.value,
      borderline: c.borderline,
      reasoning,
    },
    meta: {
      tags: c.row.tags ?? fixture?.tags ?? [],
      gitSha: c.row.gitSha,
      measuredAt: c.row.measuredAt,
      rank: c.rank,
      tier: c.tier,
      distance: round4(c.distance),
    },
  };
}

/**
 * PURE. Recovers the COMPLETE claim objects from a truncated `"claims":[…` JSON prefix. A partial
 * trailing object is dropped, never repaired: a half-parsed claim would be a fabricated one.
 */
export function salvageClaims(preview: string): Record<string, unknown>[] {
  const key = '"claims":[';
  const start = preview.indexOf(key);
  if (start < 0) return [];
  const out: Record<string, unknown>[] = [];
  let i = start + key.length;
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (; i < preview.length; i++) {
    const ch = preview[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") { if (depth === 0) objStart = i; depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          const o = JSON.parse(preview.slice(objStart, i + 1)) as Record<string, unknown>;
          out.push(o);
        } catch {
          /* an object we cannot parse is dropped, never guessed at */
        }
        objStart = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 0) break; // end of the claims array
  }
  return out;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

// ── 3. SHARED SERVER PATHS ────────────────────────────────────────────────────────────────────

export type ResolveInput = { verdict: "pass" | "fail" | "skip"; labeler: string; note?: string; score?: number };
export type ResolveOutcome =
  | { ok: true; status: 200; body: Record<string, unknown> }
  | { ok: false; status: 404 | 409 | 502; body: Record<string, unknown> };

/**
 * THE ONE resolve path. /api/review/:id/resolve and the labelling screen's own POST both call this,
 * so a label made with a keystroke is byte-for-byte the row a scripted POST would have written.
 */
export async function resolveReviewItem(sql: Sql, id: string, body: ResolveInput): Promise<ResolveOutcome> {
  const rows = await sql<{ id: string; target: string; suite: string; case_id: string; state: string }[]>`
    SELECT id, target, suite, case_id, state FROM review_queue WHERE id = ${id}::uuid`;
  const item = rows[0];
  if (!item) return { ok: false, status: 404, body: { ok: false, error: "review_item_not_found", id } };
  if (item.state !== "open") {
    return { ok: false, status: 409, body: { ok: false, error: "review_item_not_open", id, state: item.state } };
  }

  if (body.verdict === "skip") {
    const upd = await sql<{ id: string }[]>`
      UPDATE review_queue SET state = 'skipped', labeled_at = now() WHERE id = ${id}::uuid AND state = 'open'
      RETURNING id`;
    if (upd.length === 0) return { ok: false, status: 502, body: { ok: false, error: "resolve_wrote_nothing", id } };
    // A skip is NOT a label. "I don't know" is not a verdict, and writing one would poison kappa.
    return {
      ok: true,
      status: 200,
      body: { ok: true, id, state: "skipped", labelWritten: false, target: item.target, suite: item.suite, caseId: item.case_id },
    };
  }

  const w = await writeLabels(sql, {
    target: item.target,
    suite: item.suite,
    labeler: body.labeler,
    labels: [
      {
        caseId: item.case_id,
        verdict: body.verdict,
        ...(body.score === undefined ? {} : { score: body.score }),
        ...(body.note === undefined ? {} : { note: body.note }),
      },
    ],
  });
  if (w.inserted < 1) {
    // The label did not land → the item stays OPEN. Closing it here would lose the case forever
    // while reporting success: the exact lie the write law exists to prevent.
    return { ok: false, status: 502, body: { ok: false, error: "label_write_failed", id, errors: w.errors, state: "open" } };
  }
  const upd = await sql<{ id: string; labeled_at: Date }[]>`
    UPDATE review_queue SET state = 'labeled', labeled_at = now() WHERE id = ${id}::uuid AND state = 'open'
    RETURNING id, labeled_at`;
  if (upd.length === 0) {
    return { ok: false, status: 502, body: { ok: false, error: "resolve_wrote_nothing_after_label", id, labelWritten: true } };
  }
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      id,
      state: "labeled",
      labelWritten: true,
      verdict: body.verdict,
      target: item.target,
      suite: item.suite,
      caseId: item.case_id,
      labeler: body.labeler,
      labeledAt: upd[0]!.labeled_at,
    },
  };
}

export type KappaSnapshot = {
  pairs: { human: string; judge: string }[];
  excluded: { caseId: string; reason: string }[];
  labelsConsidered: number;
  judgeVerdictsConsidered: number;
};

/**
 * THE ONE definition of a (human, judge) pair. /api/calibration/compute persists a calibration from
 * it; the labelling screen reads it live and persists NOTHING. Two copies of "what counts as a
 * pair" is how one of them ends up lying about a kappa.
 */
export async function kappaSnapshot(sql: Sql, target: string, suite?: string | null): Promise<KappaSnapshot> {
  const s = suite ?? null;
  // Latest human label per case (a second labeler on the same case supersedes only by recency —
  // stated here rather than silently averaged, because averaging two humans is a research choice).
  const labelRows = await sql<{ case_id: string; verdict: string; labeler: string }[]>`
    SELECT DISTINCT ON (case_id) case_id, human->>'verdict' AS verdict, labeler
    FROM labels
    WHERE target = ${target} AND (${s}::text IS NULL OR suite = ${s})
    ORDER BY case_id, updated_at DESC`;
  // Latest pushed judge verdict per case (the product pushes results.scores.judgeVerdict).
  const judgeRows = await sql<{ case_id: string; verdict: string | null }[]>`
    SELECT DISTINCT ON (r.case_id) r.case_id, r.scores->>'judgeVerdict' AS verdict
    FROM results r JOIN runs ru ON ru.id = r.run_id
    WHERE ru.target = ${target}
      AND (${s}::text IS NULL OR ru.suite = ${s})
      AND r.scores ? 'judgeVerdict'
    ORDER BY r.case_id, r.created_at DESC`;

  const judgeBy = new Map(judgeRows.map((r) => [r.case_id, (r.verdict ?? "").toLowerCase()]));
  const pairs: { human: string; judge: string }[] = [];
  const excluded: { caseId: string; reason: string }[] = [];
  for (const l of labelRows) {
    const h = (l.verdict ?? "").toLowerCase();
    const j = judgeBy.get(l.case_id);
    if (j === undefined) { excluded.push({ caseId: l.case_id, reason: "no_pushed_judge_verdict" }); continue; }
    if (h !== "pass" && h !== "fail") { excluded.push({ caseId: l.case_id, reason: `human_verdict_not_binary:${h}` }); continue; }
    // 'borderline' is a real judge answer but not a binary rating; folding it into fail would
    // manufacture agreement. It is EXCLUDED and COUNTED, never quietly mapped.
    if (j !== "pass" && j !== "fail") { excluded.push({ caseId: l.case_id, reason: `judge_verdict_not_binary:${j}` }); continue; }
    pairs.push({ human: h, judge: j });
  }
  return { pairs, excluded, labelsConsidered: labelRows.length, judgeVerdictsConsidered: judgeRows.length };
}

export type LiveKappa = (KappaResult & { band: string }) | null;

/** The live, UNPERSISTED kappa the screen shows. null below the floor — never a number the data
 *  does not support, and the caller renders "n labels, need N" instead. */
export function liveKappaFrom(snap: KappaSnapshot, minPairs: number): LiveKappa {
  if (snap.pairs.length < minPairs) return null;
  const k = cohensKappa(snap.pairs);
  return { ...k, band: kappaBand(k.kappa) };
}
