// Pure unit tests for src/shadow.ts (Phase 4 addendum §15) — NO database, no server, no embedder.
// If this file ever needs a DB, the shadow rule has leaked out of the pure layer and THAT is the bug.
import {
  decidePair, shadowVerdict, shadowSimFromEnv, thresholds,
  DEFAULT_SHADOW_SIM, SHADOW_DEFINITION, SHADOW_DIFF_RATE_INSPECT, SHADOW_MEAN_DELTA_BLOCK,
  type ShadowTally,
} from "../src/shadow.js";
import { CANARY_PHASES, isCanaryPhase, canaryPctFromEnv, summariseCanary, DEFAULT_CANARY_PCT } from "../src/canary.js";

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
const cannot = (wrong: boolean, what: string) => {
  console.log(`  ${!wrong ? "PASS" : "FAIL"}  [neg-control] ${what}`);
  if (wrong) fail++;
};

const TH = thresholds(DEFAULT_SHADOW_SIM);
const tally = (t: Partial<ShadowTally>): ShadowTally => ({
  sampled: t.compared ?? 0, compared: 0, diffs: 0, unscored: 0,
  meanScoreCandidate: null, meanScoreBaseline: null, spendUsd: null, ...t,
});

console.log("\n── thresholds + env ──");
{
  ok(DEFAULT_SHADOW_SIM === 0.9, "contract default EVALHUB_SHADOW_SIM is 0.90", DEFAULT_SHADOW_SIM);
  ok(SHADOW_DIFF_RATE_INSPECT === 0.15, "contract inspect threshold is diffRate > 0.15");
  ok(SHADOW_MEAN_DELTA_BLOCK === -1.0, "contract block threshold is meanDelta < -1.0");
  ok(shadowSimFromEnv({} as NodeJS.ProcessEnv) === 0.9, "no env → 0.90");
  ok(shadowSimFromEnv({ EVALHUB_SHADOW_SIM: "0.75" } as NodeJS.ProcessEnv) === 0.75, "env honoured");
  ok(shadowSimFromEnv({ EVALHUB_SHADOW_SIM: "banana" } as NodeJS.ProcessEnv) === 0.9, "unparseable env → default, not NaN");
  ok(shadowSimFromEnv({ EVALHUB_SHADOW_SIM: "7" } as NodeJS.ProcessEnv) === 0.9, "an out-of-range similarity is refused, not clamped into nonsense");
}

console.log("\n── one pair ──");
{
  ok(decidePair({ exact: false, sim: 0.95 }, 0.9).diff === false, "sim above the threshold is not a diff");
  ok(decidePair({ exact: false, sim: 0.89 }, 0.9).diff === true, "sim below the threshold IS a diff");
  ok(decidePair({ exact: false, sim: 0.9 }, 0.9).diff === false, "EXACTLY at the threshold is not a diff (strict <)");
  const un = decidePair({ exact: false, sim: null, simError: "model download failed" }, 0.9);
  ok(un.diff === null && un.simSource === "unavailable", "no embedder + no exact match → UNSCORED, not 'no diff'", un.simSource);
  ok(String(un.note).includes("model download failed"), "…and the embedder's real error travels with it", un.note);
  const ex = decidePair({ exact: true, sim: null }, 0.9);
  ok(ex.diff === false && ex.sim === 1 && ex.simSource === "exact_match",
    "no embedder but IDENTICAL text → not a diff, similarity 1 as a proof", ex.simSource);
  cannot(decidePair({ exact: false, sim: null }, 0.9).diff === false, "an uncomparable pair is NOT recorded as agreement");
  cannot(decidePair({ exact: false, sim: null }, 0.9).sim === 0, "an unavailable similarity is NOT stored as 0");
}

console.log("\n── verdict: the clean case ──");
{
  const v = shadowVerdict(tally({ sampled: 100, compared: 100, diffs: 5, meanScoreCandidate: 92, meanScoreBaseline: 91.5 }), TH);
  ok(v.recommendation === "safe", "5/100 diffs and a positive mean delta → safe", v.recommendation);
  ok(v.diffRate === 0.05 && v.meanDelta === 0.5, "diffRate and meanDelta are computed, not asserted", `${v.diffRate}/${v.meanDelta}`);
  ok(v.thresholds.simThreshold === 0.9 && v.thresholds.diffRateInspect === 0.15 && v.thresholds.meanDeltaBlock === -1,
    "EVERY threshold applied is stated on the response", JSON.stringify(v.thresholds));
  ok(typeof v.thresholds.rule === "string" && v.thresholds.rule.includes("blocking wins"), "…and the rule itself is spelled out");
  ok(v.definition === SHADOW_DEFINITION && v.definition.includes("No user traffic"), "the SHADOW definition rides on the verdict");
  ok(v.caveats.some((c) => c.includes("spend")), "an unreported spend is a stated caveat, not a silent zero", v.caveats.length);
  cannot(v.spendUsd === 0, "an unknown spend is NOT reported as $0");
}

console.log("\n── verdict: diffRate → inspect ──");
{
  const at = shadowVerdict(tally({ sampled: 100, compared: 100, diffs: 15, meanScoreCandidate: 90, meanScoreBaseline: 90 }), TH);
  ok(at.recommendation === "safe", "EXACTLY at 0.15 is not above it → still safe (strict >)", at.diffRate);
  const over = shadowVerdict(tally({ sampled: 100, compared: 100, diffs: 16, meanScoreCandidate: 90, meanScoreBaseline: 90 }), TH);
  ok(over.recommendation === "inspect" && over.diffRate === 0.16, "one diff beyond the threshold → inspect", over.diffRate);
  ok(over.reason.includes("0.15") && over.reason.includes("16"), "the reason names the threshold AND the count", over.reason);
  cannot(over.recommendation === "block", "a high diff rate alone does NOT block");
}

console.log("\n── verdict: meanDelta → block, and blocking WINS ──");
{
  const b = shadowVerdict(tally({ sampled: 50, compared: 50, diffs: 1, meanScoreCandidate: 88, meanScoreBaseline: 90 }), TH);
  ok(b.recommendation === "block" && b.meanDelta === -2, "meanDelta -2 blocks even with a clean diff rate", b.meanDelta);
  const edge = shadowVerdict(tally({ sampled: 50, compared: 50, diffs: 0, meanScoreCandidate: 89, meanScoreBaseline: 90 }), TH);
  ok(edge.recommendation === "safe" && edge.meanDelta === -1, "EXACTLY -1.0 does not block (strict <)", edge.meanDelta);
  const both = shadowVerdict(tally({ sampled: 100, compared: 100, diffs: 40, meanScoreCandidate: 80, meanScoreBaseline: 90 }), TH);
  ok(both.recommendation === "block", "BOTH rules breached → block, because blocking wins", both.recommendation);
  ok(both.reason.includes("blocking wins"), "…and the response says why inspect did not win", both.reason);
  cannot(both.recommendation === "inspect", "a blocked candidate is never downgraded to 'inspect'");
}

console.log("\n── verdict: ZERO pairs is not safe (the empty-run control) ──");
{
  const z = shadowVerdict(tally({ sampled: 0, compared: 0, diffs: 0 }), TH);
  ok(z.recommendation === "inspect", "zero compared pairs → inspect", z.recommendation);
  ok(z.reason.includes("proves nothing"), "…with the reason spelled out", z.reason);
  ok(z.diffRate === null, "diffRate of nothing is null, never 0", String(z.diffRate));
  cannot(z.recommendation === "safe", "AN EMPTY SHADOW RUN IS NOT SAFE — it proves nothing");
  cannot(z.diffRate === 0, "a diff rate of 0 is not manufactured out of an empty run");
  const zs = shadowVerdict(tally({ sampled: 10, compared: 0, diffs: 0, unscored: 10 }), TH);
  ok(zs.recommendation === "inspect" && zs.reason.includes("none could be scored"),
    "ten pairs that could not be scored is also not safe", zs.reason);
  // …and a blocking mean delta still wins over the empty-run rule.
  const zb = shadowVerdict(tally({ sampled: 0, compared: 0, diffs: 0, meanScoreCandidate: 10, meanScoreBaseline: 90 }), TH);
  ok(zb.recommendation === "block", "a blocking mean delta outranks even the zero-pairs rule", zb.recommendation);
}

console.log("\n── verdict: unscored pairs and undelivered samples ──");
{
  const u = shadowVerdict(tally({ sampled: 100, compared: 90, diffs: 0, unscored: 10, meanScoreCandidate: 90, meanScoreBaseline: 90 }), TH);
  ok(u.recommendation === "inspect", "any unscored pair keeps the run out of 'safe'", u.recommendation);
  cannot(u.recommendation === "safe", "90 clean pairs plus 10 uncomparable ones is NOT a clean run");
  const gap = shadowVerdict(tally({ sampled: 100, compared: 50, diffs: 0, meanScoreCandidate: 90, meanScoreBaseline: 90 }), TH);
  ok(gap.recommendation === "safe" && gap.caveats.some((c) => c.includes("never arrived")),
    "50 of 100 sampled cases arriving is a stated caveat on the verdict", gap.caveats.join(" | ").slice(0, 80));
}

console.log("\n── verdict: the mean-score rule when no score was pushed ──");
{
  const v = shadowVerdict(tally({ sampled: 20, compared: 20, diffs: 0, spendUsd: 0.12 }), TH);
  ok(v.meanDeltaEvaluated === false && v.meanDelta === null, "no scores → the blocking rule was NOT evaluated", String(v.meanDelta));
  ok(v.caveats.some((c) => c.includes("NOT evaluated")), "…and the verdict says so out loud", v.caveats[0]);
  ok(v.recommendation === "safe" && v.reason.includes("could not be evaluated"),
    "the diff-only run may still read safe, but never bare", v.reason);
  cannot(v.meanDelta === 0, "an unevaluated mean delta is NOT reported as 0 (which would read as parity)");
  ok(v.spendUsd === 0.12 && !v.caveats.some((c) => c.includes("spend")), "a reported spend removes the spend caveat", v.spendUsd);
}

console.log("\n── canary vocabulary ──");
{
  ok(CANARY_PHASES.length === 3 && isCanaryPhase("start") && isCanaryPhase("promote") && isCanaryPhase("rollback"),
    "the three contract phases are accepted", CANARY_PHASES.join(","));
  cannot(isCanaryPhase("rolledback"), "a near-miss phase is REJECTED, not stored");
  cannot(isCanaryPhase("PROMOTE"), "the vocabulary is case-sensitive — no silent normalisation");
  cannot(isCanaryPhase(""), "an empty phase is not a phase");
  ok(canaryPctFromEnv({} as NodeJS.ProcessEnv) === DEFAULT_CANARY_PCT, "default cohort is 5%", DEFAULT_CANARY_PCT);
  ok(canaryPctFromEnv({ EVALHUB_CANARY_PCT: "20" } as NodeJS.ProcessEnv) === 20, "env honoured");
  ok(canaryPctFromEnv({ EVALHUB_CANARY_PCT: "900" } as NodeJS.ProcessEnv) === 5, "an impossible cohort → default, not 900%");

  const empty = summariseCanary([]);
  ok(empty.events === 0 && empty.note.includes("absence of DATA"),
    "no events → the note says the silence is missing data, not stability", empty.note.slice(0, 50));
  cannot(empty.note.includes("stable"), "an empty canary history is never summarised as stability");
  const ev = (phase: "start" | "promote" | "rollback", i: number) => ({
    id: "i" + i, target: "t", sha: "abc", phase, pct: 5, reason: null, createdAt: "2026-08-05T0" + i + ":00:00Z",
  });
  const s = summariseCanary([ev("rollback", 3), ev("start", 2), ev("promote", 1), ev("start", 0)]);
  ok(s.events === 4 && s.starts === 2 && s.promotes === 1 && s.rollbacks === 1, "the phases are counted", JSON.stringify(s));
  ok(s.last?.phase === "rollback", "the newest event (first in the DESC list) is `last`", s.last?.phase);
  ok(s.note.includes("did not witness"), "the summary states the hub only recorded what was posted");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — shadow pair decision + verdict rules (incl. the zero-pairs control) and the canary vocabulary");
process.exit(fail ? 1 : 0);
