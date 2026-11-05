// Pure unit tests for src/ab.ts — NO database, no server, no clock. The decision rule is the whole
// point of this module, and the negative controls assert the failure mode it exists to prevent: a
// "winner" declared off ten samples, or off a gap of one point.
import { abMinNFromEnv, AB_MIN_GAP_POINTS, decideAb, DEFAULT_AB_MIN_N, type VariantTally } from "../src/ab.js";

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
const cannot = (wrong: boolean, what: string) => {
  console.log(`  ${!wrong ? "PASS" : "FAIL"}  [neg-control] ${what}`);
  if (wrong) fail++;
};

const V = (name: string, n: number, passed: number, meanScore: number | null = null): VariantTally =>
  ({ variantId: `id_${name}`, name, hash: `hash_${name}`, n, passed, meanScore });

console.log("\n── below min-n → no_decision, with the reason ──");
{
  //  A: 20/25 = 80%, B: 10/25 = 40%. A 40-POINT gap — and still no decision, because n < 30.
  const r = decideAb([V("A", 25, 20), V("B", 25, 10)], 30);
  ok(r.decision.status === "no_decision", "status is no_decision", r.decision.status);
  ok(r.decision.reason.includes("below_min_n") && r.decision.reason.includes("n=25"), "the reason names the under-sampled variants", r.decision.reason);
  ok(r.decision.minN === 30 && r.decision.minGapPoints === AB_MIN_GAP_POINTS, "the thresholds are reported on the decision", JSON.stringify({ n: r.decision.minN, g: r.decision.minGapPoints }));
  cannot(r.decision.status === "leader", "a 40-point gap on 25 samples is NOT a winner");
  cannot(r.decision.leader !== undefined, "…and no leader name is smuggled into the payload");
  //  ONE variant under the floor is enough to stop the decision
  const one = decideAb([V("A", 40, 36), V("B", 12, 3)], 30);
  ok(one.decision.status === "no_decision" && one.decision.reason.includes("B n=12"), "one under-sampled variant blocks the whole decision", one.decision.reason);
}

console.log("\n── gap under 5 points → no_decision ──");
{
  //  A: 24/40 = 60.0%, B: 23/40 = 57.5% → gap 2.5 points.
  const r = decideAb([V("A", 40, 24), V("B", 40, 23)], 30);
  ok(r.decision.status === "no_decision", "a 2.5-point gap at n=40 is not decisive", r.decision.status);
  ok(r.decision.delta === 2.5, "the gap is still REPORTED, not hidden", r.decision.delta);
  ok(r.decision.reason.includes("gap_2.5_points_below_5"), "the reason states the gap and the threshold", r.decision.reason);
  cannot(r.decision.status === "leader", "the hub does not call 2.5 points a win");
  //  exactly 5.0 points IS decisive (the rule says >= 5)
  //  A: 26/40 = 65.0%, B: 24/40 = 60.0% → 5.0
  const edge = decideAb([V("A", 40, 26), V("B", 40, 24)], 30);
  ok(edge.decision.status === "leader" && edge.decision.delta === 5, "exactly 5.0 points IS a leader (the rule is >=)", JSON.stringify({ s: edge.decision.status, d: edge.decision.delta }));
  //  …and 4.99 is not. A: 40 cases can't make 4.99; use n=1000.
  const justUnder = decideAb([V("A", 1000, 650), V("B", 1000, 601)], 30);
  ok(justUnder.decision.status === "no_decision" && justUnder.decision.delta === 4.9, "4.9 points is NOT a leader", justUnder.decision.delta);
}

console.log("\n── clear winner → leader ──");
{
  //  A: 38/40 = 95.0%, B: 28/40 = 70.0% → 25.0 points, both n >= 30.
  const r = decideAb([V("B", 40, 28, 71.2), V("A", 40, 38, 94.4)], 30);
  ok(r.decision.status === "leader" && r.decision.leader === "A", "A leads", JSON.stringify({ s: r.decision.status, l: r.decision.leader }));
  ok(r.decision.leaderVariantId === "id_A", "the leader's variant id is returned so the UI need not match on names", r.decision.leaderVariantId);
  ok(r.decision.delta === 25, "the delta is the pass-rate gap in points", r.decision.delta);
  ok(r.variants[0]?.name === "A" && r.variants[0]?.passRate === 95, "variants come back best-first with pass rates", JSON.stringify(r.variants.map((v) => [v.name, v.passRate])));
  ok(r.variants[0]?.meanScore === 94.4, "the pushed mean score survives, rounded", r.variants[0]?.meanScore);
  cannot(r.decision.leader === "B", "the WORSE variant is not the leader (input order was B first)");
  ok(r.decision.reason.includes("leads") && r.decision.reason.includes("25"), "the reason states the finding", r.decision.reason);
}

console.log("\n── equal variants → no_decision ──");
{
  const r = decideAb([V("A", 60, 45), V("B", 60, 45)], 30);
  ok(r.decision.status === "no_decision" && r.decision.delta === 0, "identical tallies → no decision, delta 0", JSON.stringify({ s: r.decision.status, d: r.decision.delta }));
  ok(r.decision.reason.startsWith("tie:"), "a tie is named a tie", r.decision.reason);
  cannot(r.decision.leader !== undefined, "a coin toss is NOT performed to break a tie");
  //  determinism: the same tallies in the other order give the same answer
  const flipped = decideAb([V("B", 60, 45), V("A", 60, 45)], 30);
  ok(JSON.stringify(flipped.decision) === JSON.stringify(r.decision), "the decision does not depend on the row order");
}

console.log("\n── degenerate inputs ──");
{
  ok(decideAb([], 30).decision.status === "no_decision", "no variants → no decision");
  ok(decideAb([], 30).decision.reason.includes("only_0_variant"), "…with the count named", decideAb([], 30).decision.reason);
  const solo = decideAb([V("A", 100, 100)], 30);
  ok(solo.decision.status === "no_decision" && solo.decision.reason.includes("at least two"), "one variant is not an A/B, however many samples", solo.decision.reason);
  cannot(solo.decision.status === "leader", "a single variant cannot 'win' against nobody");
  const zero = decideAb([V("A", 0, 0), V("B", 40, 40)], 30);
  ok(zero.decision.status === "no_decision" && zero.decision.reason.includes("A n=0"), "a variant with no results at all blocks the decision", zero.decision.reason);
  ok(zero.variants.find((v) => v.name === "A")?.passRate === null, "n=0 → passRate null, never 0% (nothing was measured)", String(zero.variants.find((v) => v.name === "A")?.passRate));
  cannot(zero.variants.find((v) => v.name === "A")?.passRate === 0, "an unmeasured variant does NOT read as a 0% failure");
}

console.log("\n── env floor ──");
{
  ok(abMinNFromEnv({} as NodeJS.ProcessEnv) === DEFAULT_AB_MIN_N, "default min n is 30", abMinNFromEnv({} as NodeJS.ProcessEnv));
  ok(abMinNFromEnv({ EVALHUB_AB_MIN_N: "50" } as NodeJS.ProcessEnv) === 50, "env overrides the floor", abMinNFromEnv({ EVALHUB_AB_MIN_N: "50" } as NodeJS.ProcessEnv));
  ok(abMinNFromEnv({ EVALHUB_AB_MIN_N: "banana" } as NodeJS.ProcessEnv) === DEFAULT_AB_MIN_N, "a garbage env value falls back to the default, not to 0", abMinNFromEnv({ EVALHUB_AB_MIN_N: "banana" } as NodeJS.ProcessEnv));
  cannot(abMinNFromEnv({ EVALHUB_AB_MIN_N: "0" } as NodeJS.ProcessEnv) === 0, "a floor of 0 cannot be configured — it would make every run decisive");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — min-n floor, gap threshold (incl. the 5.0 boundary), clear leader, ties, degenerate inputs, env floor");
process.exit(fail ? 1 : 0);
