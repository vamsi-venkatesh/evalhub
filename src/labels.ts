// Eval Hub — the ONE human-label write path.
//
// Phase 2 gave labels a single entry point (POST /api/labels). Phase 3's review queue resolves an
// item into a human label too, and the addendum is explicit: "pass/fail writes a labels row (same
// table as calibration — human labels are human labels)". Two INSERTs with the same intent in two
// routes is how they drift — one grows an upsert key the other doesn't, and a calibration silently
// counts a case twice. So the statement lives here and BOTH routes call it.
import type { Sql } from "./db.js";

export type LabelInput = { caseId: string; verdict: "pass" | "fail"; score?: number; note?: string };
export type LabelWrite = {
  received: number;
  inserted: number;
  errors: { caseId: string; error: string }[];
};

/**
 * Upsert on (target, suite, case_id, labeler) — the Phase 2 key. Two labelers on one case is real
 * disagreement and both rows survive; the same labeler changing their mind replaces their own row.
 * Returns EXACT counts. The caller applies the write law (inserted < received → 502).
 */
export async function writeLabels(
  sql: Sql,
  input: { target: string; suite: string; labeler: string; labels: readonly LabelInput[] }
): Promise<LabelWrite> {
  let inserted = 0;
  const errors: { caseId: string; error: string }[] = [];
  for (const l of input.labels) {
    const human = {
      verdict: l.verdict,
      ...(l.score === undefined ? {} : { score: l.score }),
      ...(l.note === undefined ? {} : { note: l.note }),
    };
    try {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO labels (target, suite, case_id, human, labeler)
        VALUES (${input.target}, ${input.suite}, ${l.caseId}, ${sql.json(human as never)}, ${input.labeler})
        ON CONFLICT (target, suite, case_id, labeler)
        DO UPDATE SET human = EXCLUDED.human, updated_at = now()
        RETURNING id`;
      if (rows.length > 0) inserted++;
      else if (errors.length < 5) errors.push({ caseId: l.caseId, error: "upsert_returned_no_row" });
    } catch (e) {
      if (errors.length < 5) errors.push({ caseId: l.caseId, error: String((e as Error)?.message ?? e) });
    }
  }
  return { received: input.labels.length, inserted, errors };
}
