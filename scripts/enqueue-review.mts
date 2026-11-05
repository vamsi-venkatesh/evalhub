// Eval Hub — fill the human-review queue from REAL judged results already in the hub DB.
//
// WHY THIS EXISTS: review_queue and labels were both empty. Nothing had ever populated the queue,
// so no human label existed, so no Cohen's kappa existed, so the LLM judge was advisory and gated
// nothing. This script is the first half of closing that loop; src/review-html.ts is the second.
//
// WHAT IT DOES NOT DO: invent a confidence signal. The hub stores no per-case judge confidence —
// results.scores carries judgeVerdict + the rate the verdict was thresholded from, and that is all.
// The ranking rule is src/review.ts rankReviewCandidates(), and this script PRINTS the rule and
// every exclusion before it writes anything. If you cannot read why a case is at position 1, the
// order is not evidence.
//
// READS the DB directly (EVALHUB_DATABASE_URL); WRITES only through POST /api/review/enqueue, so
// the dedup that matters — the partial unique index on (target, suite, case_id) WHERE state='open'
// — is the one production uses. Re-running is a no-op on cases already waiting, and the script
// reports enqueued vs duplicates from the route's own counts, never from its own optimism.
//
// USAGE
//   EVALHUB_DATABASE_URL=… EVALHUB_TOKEN=… npx tsx scripts/enqueue-review.mts \
//     --target conxto [--suite grounding] [--limit 50] [--hub http://127.0.0.1:4290] \
//     [--fixtures /path/to/conxto/eval/golden/llm] [--labeler founder] [--include-labelled] [--dry-run]
//
// --fixtures IS NOT OPTIONAL IN PRACTICE. The hub stores the SCORE payload, not the case. Without
// the golden .jsonl the card has the judge's per-claim rulings but no case input, no agent answer
// and no source document — and the screen will say so on every card. Point it at the product's
// eval/golden/llm directory.
import fs from "node:fs";
import path from "node:path";
import { makeSql } from "../src/db.js";
import {
  buildReviewCard,
  rankReviewCandidates,
  type FixtureCase,
  type JudgedRow,
} from "../src/review.js";

// ── args ──────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const TARGET = flag("target") ?? "conxto";
const SUITE = flag("suite") ?? null;
const LIMIT = flag("limit") === undefined ? 50 : Math.max(1, Number(flag("limit")));
const HUB = (flag("hub") ?? process.env.EVALHUB_URL ?? "http://127.0.0.1:4290").replace(/\/+$/, "");
const TOKEN = flag("token") ?? process.env.EVALHUB_TOKEN ?? "";
const FIXTURES = flag("fixtures") ?? null;
const DRY = has("dry-run");
const INCLUDE_LABELLED = has("include-labelled");
const CHUNK = 100; // the route accepts 500; 100 keeps a failure's blast radius readable

const DB = process.env.EVALHUB_DATABASE_URL ?? "";
if (!DB) {
  console.error("EVALHUB_DATABASE_URL is not set. NOTHING WAS READ AND NOTHING WAS ENQUEUED.");
  process.exit(2);
}
if (!DRY && !TOKEN) {
  console.error("No hub token (--token or EVALHUB_TOKEN). NOTHING WAS ENQUEUED. Use --dry-run to see the ranking without writing.");
  process.exit(2);
}

const line = (n = 92) => console.log("─".repeat(n));

// ── read the judged results ───────────────────────────────────────────────────────────────────
const sql = makeSql(DB);
const rows = await sql<{
  suite: string; case_id: string; pass: boolean; scores: Record<string, unknown> | null;
  output: unknown; tags: string[] | null; git_sha: string; created_at: Date;
}[]>`
  SELECT DISTINCT ON (ru.suite, r.case_id)
         ru.suite, r.case_id, r.pass, r.scores, r.output, r.tags, ru.git_sha, r.created_at
  FROM results r JOIN runs ru ON ru.id = r.run_id
  WHERE ru.target = ${TARGET}
    AND (${SUITE}::text IS NULL OR ru.suite = ${SUITE})
    AND r.scores ? 'judgeVerdict'
  ORDER BY ru.suite, r.case_id, r.created_at DESC`;

// Cases the founder has already ruled on. Re-queueing them would spend his 20 minutes re-deciding
// what is already decided. Excluded by default, NAMED, and --include-labelled turns it off.
const labelled = new Set<string>();
if (!INCLUDE_LABELLED) {
  const l = await sql<{ suite: string; case_id: string }[]>`
    SELECT DISTINCT suite, case_id FROM labels
    WHERE target = ${TARGET} AND (${SUITE}::text IS NULL OR suite = ${SUITE})`;
  for (const r of l) labelled.add(`${r.suite}::${r.case_id}`);
}
// Cases already waiting in the queue. The route would dedup them anyway; naming them here is what
// turns "0 enqueued" from a mystery into a fact.
const alreadyOpen = new Set<string>();
{
  const o = await sql<{ suite: string; case_id: string }[]>`
    SELECT suite, case_id FROM review_queue
    WHERE target = ${TARGET} AND state = 'open' AND (${SUITE}::text IS NULL OR suite = ${SUITE})`;
  for (const r of o) alreadyOpen.add(`${r.suite}::${r.case_id}`);
}

const judged: JudgedRow[] = rows.map((r) => ({
  suite: r.suite,
  caseId: r.case_id,
  pass: r.pass,
  scores: r.scores,
  output: r.output,
  tags: r.tags,
  gitSha: r.git_sha,
  measuredAt: r.created_at.toISOString(),
}));

console.log("");
line();
console.log(`ENQUEUE REVIEW · target ${TARGET}${SUITE ? ` · suite ${SUITE}` : " · all suites"} · hub ${HUB}${DRY ? " · DRY RUN (writes nothing)" : ""}`);
line();
console.log(`Judged results found in the hub DB (latest row per case): ${judged.length}`);

const preFiltered = judged.filter((j) => {
  const key = `${j.suite}::${j.caseId}`;
  return !labelled.has(key) && !alreadyOpen.has(key);
});
const skippedLabelled = judged.filter((j) => labelled.has(`${j.suite}::${j.caseId}`));
const skippedOpen = judged.filter((j) => !labelled.has(`${j.suite}::${j.caseId}`) && alreadyOpen.has(`${j.suite}::${j.caseId}`));
if (skippedLabelled.length) console.log(`  already LABELLED, left out (${skippedLabelled.length}): ${skippedLabelled.map((j) => j.caseId).join(", ")}`);
if (skippedOpen.length) console.log(`  already OPEN in the queue, left out (${skippedOpen.length}): ${skippedOpen.map((j) => j.caseId).join(", ")}`);

// ── rank ──────────────────────────────────────────────────────────────────────────────────────
const ranked = rankReviewCandidates(preFiltered, { limit: LIMIT });

console.log("");
console.log("HOW IT RANKED — and what it left out");
line();
for (const l of ranked.explanation) console.log("  " + wrap(l, 88, "  "));
console.log("");
console.log(`  Selected ${ranked.counts.ranked}: ${ranked.counts.fail} fail-verdict, ${ranked.counts.pass} pass-verdict ` +
  `(both categories are required — Cohen's kappa on a single category is degenerate and measures nothing).`);
console.log("");
console.log("  ORDER (rank · tier · suite · case · judge · metric · distance to the flip point):");
for (const c of ranked.ordered) {
  console.log(
    `    ${String(c.rank).padStart(3)}  T${c.tier}  ${c.row.suite.padEnd(20)} ${c.row.caseId.padEnd(12)} ` +
      `${c.verdict.toUpperCase().padEnd(4)} ${c.metric}=${String(c.value).padEnd(8)} d=${c.distance.toFixed(4)}${c.borderline ? "  ← borderline band" : ""}`,
  );
}
if (ranked.excluded.length) {
  console.log("");
  console.log(`  EXCLUDED (${ranked.excluded.length}) — every one named, none silent:`);
  for (const e of ranked.excluded) console.log(`    ${e.suite} ${e.caseId} — ${e.reason}`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
const fixtures = new Map<string, FixtureCase>();
if (FIXTURES) {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const text = fs.readFileSync(path.join(FIXTURES, f), "utf8");
    for (const raw of text.split("\n")) {
      const t = raw.trim();
      if (!t.startsWith("{")) continue;
      try {
        const o = JSON.parse(t) as FixtureCase;
        if (o.id) fixtures.set(o.id, o);
      } catch { /* a fixture line we cannot parse is skipped, and counted below */ }
    }
  }
  console.log("");
  console.log(`FIXTURES · read ${fixtures.size} case(s) from ${files.length} file(s) in ${FIXTURES}`);
} else {
  console.log("");
  console.log("FIXTURES · NONE SUPPLIED (--fixtures). The hub stores the score payload, not the case, so every");
  console.log("           card will carry the judge's per-item rulings but NO case input, NO agent answer and");
  console.log("           NO source document — and the screen will say so on each one.");
}

// ── build the cards ───────────────────────────────────────────────────────────────────────────
const cards = ranked.ordered.map((c) => ({ c, card: buildReviewCard(c, fixtures.get(c.row.caseId)) }));
const withInput = cards.filter((x) => x.card.input !== null).length;
const withGaps = cards.filter((x) => x.card.gaps.length > 0).length;
const partialEvidence = cards.filter((x) => x.card.gaps.some((g) => g.startsWith("Evidence is PARTIAL"))).length;
console.log("");
console.log("CARD COMPLETENESS — stated, because a card the founder cannot rule on is worse than no card");
line();
console.log(`  ${withInput}/${cards.length} carry the real case input + agent answer + source (from fixtures).`);
console.log(`  ${partialEvidence}/${cards.length} carry PARTIAL per-claim evidence: the PRODUCT truncated its score payload`);
console.log(`     at MAX_OUTPUT_CHARS, so only the claims that fit the stored prefix were recovered. The claim`);
console.log(`     that decided such a verdict may not be visible; the card says so, and S (skip) is the honest key.`);
console.log(`  ${withGaps}/${cards.length} carry at least one stated gap.`);

if (DRY) {
  console.log("");
  console.log("DRY RUN — nothing was written to review_queue.");
  await sql.end();
  process.exit(0);
}

// ── write, through the production route ───────────────────────────────────────────────────────
const bySuite = new Map<string, { caseId: string; reason: string; payload: unknown }[]>();
for (const { c, card } of cards) {
  const list = bySuite.get(c.row.suite) ?? [];
  // 'judge_borderline' is the contract's reason for a case inside the advisory band; everything
  // else is 'manual' — this script chose it, and pretending otherwise would mislabel the provenance.
  list.push({ caseId: c.row.caseId, reason: c.borderline ? "judge_borderline" : "manual", payload: card });
  bySuite.set(c.row.suite, list);
}

let received = 0, enqueued = 0, duplicates = 0, failed = 0;
console.log("");
console.log("ENQUEUEING through POST /api/review/enqueue (the route's own dedup, not this script's)");
line();
for (const [suite, items] of bySuite) {
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    const res = await fetch(`${HUB}/api/review/enqueue`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-evalhub-token": TOKEN },
      body: JSON.stringify({ target: TARGET, suite, items: batch }),
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* reported raw below */ }
    if (res.status !== 200) {
      failed += batch.length;
      console.log(`  FAILED  ${suite} [${i + 1}..${i + batch.length}] — HTTP ${res.status} ${text.slice(0, 200)}`);
      console.log(`          NOT ENQUEUED: ${batch.map((b) => b.caseId).join(", ")}`);
      continue;
    }
    received += Number(body.received ?? 0);
    enqueued += Number(body.enqueued ?? 0);
    duplicates += Number(body.duplicates ?? 0);
    console.log(`  ${suite} [${i + 1}..${i + batch.length}] → received ${body.received}, enqueued ${body.enqueued}, duplicates ${body.duplicates}`);
  }
}

console.log("");
line();
console.log(`RESULT · received ${received} · enqueued ${enqueued} · duplicates (already open) ${duplicates} · failed ${failed}`);
const open = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM review_queue WHERE target = ${TARGET} AND state = 'open'`;
console.log(`review_queue open for ${TARGET}: ${open[0]?.n ?? 0}`);
console.log(`Label them:  GET /review/${TARGET}   (keys: a = agree with the judge, d = disagree, s = skip)`);
line();
await sql.end();
process.exit(failed > 0 ? 1 : 0);

function wrap(s: string, width: number, indent: string): string {
  const words = s.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > width) { out.push(cur); cur = w; } else { cur = cur ? cur + " " + w : w; }
  }
  if (cur) out.push(cur);
  return out.join("\n" + indent);
}
