// Eval Hub — hallucination REGRESSION CORPUS runner (offline, no LLM call, no network).
//
// Scores every case in eval-corpus/tailoring-claims-2026-08-05.json through the REAL
// scoreHallucination. The judge is STUBBED with the claims the production judge actually
// extracted for that case (they are frozen in the corpus), so what is under test here is only the
// SUPPORT DECISION — the thing this repo owns deterministically.
//
// Three acceptance checks, no trade-offs:
//   1. planted cases — every expected.mustFlag substring matches at least one UNSUPPORTED claim.
//   2. clean cases   — unsupported/total <= expected.maxHallucinationRate (0.15).
//   3. no case may be "passed" by producing zero claims (minClaims).
//
// Embeddings: real MiniLM by default (the model is cached under node_modules/@xenova/…/.cache).
// Run with EMBED=off to prove the anchor tier alone carries the corpus.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { miniLmEmbed, normalizeText, type EmbedFn } from "../src/scorers/metrics.js";
import { scoreHallucination } from "../src/scorers/hallucination.js";

type Case = {
  id: string;
  tags: string[];
  expected: { mustFlag?: string[]; maxHallucinationRate?: number; minClaims?: number };
  sources: string[];
  claims: string[];
};

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "..", "eval-corpus", "tailoring-claims-2026-08-05.json");
const cases: Case[] = JSON.parse(readFileSync(process.env.CORPUS ?? CORPUS, "utf8"));

const embedOff = process.env.EMBED === "off";
// An embedder that THROWS is the honest way to say "the second pass did not run" — the scorer
// records a warning instead of inventing a similarity.
const embed: EmbedFn = embedOff ? async () => { throw new Error("embed disabled (EMBED=off)"); } : miniLmEmbed;

const rows: string[] = [];
let failures = 0;
let plantFailures = 0;
let cleanFailures = 0;
let minClaimFailures = 0;
const detail: string[] = [];

for (const c of cases) {
  const planted = c.tags.includes("planted");
  const r = await scoreHallucination(
    { output: c.claims.join(" "), sources: c.sources },
    { extractClaims: async () => c.claims, embed }
  );
  const unsupported = r.claims.filter((x) => !x.supported);
  let pass = true;
  const notes: string[] = [];

  if ((c.expected.minClaims ?? 0) > r.claimCount) {
    pass = false; minClaimFailures++; notes.push(`minClaims ${c.expected.minClaims} > ${r.claimCount}`);
  }

  if (planted) {
    for (const frag of c.expected.mustFlag ?? []) {
      const n = normalizeText(frag);
      const hit = unsupported.some((x) => normalizeText(x.text).includes(n));
      if (!hit) {
        pass = false; plantFailures++;
        notes.push(`MISSED PLANT "${frag}"`);
        const carrier = r.claims.find((x) => normalizeText(x.text).includes(n));
        if (carrier) notes.push(`  carrier judged ${carrier.method} sim=${carrier.similarity}: ${carrier.text}`);
      }
    }
  } else {
    const rate = r.hallucinationRate;
    const max = c.expected.maxHallucinationRate ?? 0.15;
    if (rate > max) {
      pass = false; cleanFailures++;
      notes.push(`rate ${rate} > ${max}`);
    }
  }

  rows.push(
    `${c.id.padEnd(10)} ${(planted ? "planted" : "clean  ")} ` +
    `${String(unsupported.length).padStart(2)}/${String(r.claimCount).padEnd(2)} ` +
    `rate=${r.hallucinationRate.toFixed(3)} ${pass ? "PASS" : "FAIL"}` +
    (notes.length ? `  ← ${notes.join(" ; ")}` : "")
  );
  if (!pass) failures++;
  if (unsupported.length > 0 || !pass) {
    detail.push(`  ${c.id}${planted ? " (planted)" : ""}:`);
    for (const u of unsupported) {
      detail.push(`    [${u.method}${u.similarity != null ? ` sim=${u.similarity}` : ""}]${u.missingAnchors ? ` missing=${JSON.stringify(u.missingAnchors)}` : ""} ${u.text}`);
    }
  }
  if (r.warnings?.length && !embedOff) detail.push(`  ${c.id} WARN ${JSON.stringify(r.warnings)}`);
}

console.log(`\n══ hallucination corpus (${cases.length} cases, embed=${embedOff ? "OFF" : "MiniLM"}) ══`);
for (const r of rows) console.log(r);
console.log("\n── unsupported claims per case ──");
for (const d of detail) console.log(d);

const c1 = plantFailures === 0;
const c2 = cleanFailures === 0;
const c3 = minClaimFailures === 0;
console.log("\n── acceptance ──");
console.log(`  1. every planted mustFlag is flagged unsupported .......... ${c1 ? "PASS" : `FAIL (${plantFailures})`}`);
console.log(`  2. every clean case <= its maxHallucinationRate ........... ${c2 ? "PASS" : `FAIL (${cleanFailures})`}`);
console.log(`  3. every case still produced its minimum claim count ...... ${c3 ? "PASS" : `FAIL (${minClaimFailures})`}`);
if (c1 && c2 && c3) {
  console.log("\nALL 3 ACCEPTANCE CHECKS PASS");
} else {
  console.log(`\n${failures} CASE FAILURE(S)`);
  process.exitCode = 1;
}
