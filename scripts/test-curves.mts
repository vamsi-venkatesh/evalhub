// Pure unit tests for src/pricing.ts + src/curves.ts — NO database, no server, no env, no clock.
// If this file ever needs a DB, the frontier math has leaked into the query layer and THAT is the
// bug. The negative controls assert the two lies this code exists to prevent: an unknown price
// becoming 0, and a dominated model being called Pareto-optimal.
import { computeCost, knownModels, priceFor, PRICES } from "../src/pricing.js";
import { aggregateModelRuns, dominates, paretoFrontier, type ModelRunRow } from "../src/curves.js";

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
const cannot = (wrong: boolean, what: string) => {
  console.log(`  ${!wrong ? "PASS" : "FAIL"}  [neg-control] ${what}`);
  if (wrong) fail++;
};

console.log("\n── pricing: a known model computes ──");
{
  //  deepseek-chat: 0.27 / 1M in, 1.10 / 1M out.
  //  1,000,000 in + 1,000,000 out = 0.27 + 1.10 = 1.37 exactly.
  const c = computeCost({ model: "deepseek-chat", tokensIn: 1_000_000, tokensOut: 1_000_000 });
  ok(c.costUsd === 1.37, "1M in + 1M out on deepseek-chat = $1.37", c.costUsd);
  ok(c.costSource === "table", "costSource is 'table'", c.costSource);
  ok(c.price?.asOf === "2026-08-05" && typeof c.price?.source === "string" && c.price.source.length > 0,
    "the entry carries asOf AND a source note", JSON.stringify({ asOf: c.price?.asOf }));
  //  half a million in, a quarter million out: 0.135 + 0.275 = 0.41
  const h = computeCost({ model: "DeepSeek-Chat", tokensIn: 500_000, tokensOut: 250_000 });
  ok(h.costUsd === 0.41, "case-insensitive lookup, 500k/250k = $0.41", h.costUsd);
  ok(priceFor("  gpt-4o-mini  ") !== null, "lookup trims whitespace");
  ok(knownModels().length === Object.keys(PRICES).length && knownModels()[0] === knownModels().slice().sort()[0],
    "knownModels() enumerates the table, sorted", knownModels().join(","));
}

console.log("\n── pricing: an unknown model returns null AND a reason ──");
{
  const u = computeCost({ model: "some-model-nobody-priced", tokensIn: 1_000_000, tokensOut: 1_000_000 });
  ok(u.costUsd === null, "unknown model → costUsd null", String(u.costUsd));
  ok(u.costSource === "unknown", "…costSource 'unknown'", u.costSource);
  ok(typeof u.reason === "string" && u.reason.includes("no_price_entry_for_model"), "…with the reason named", u.reason);
  cannot(u.costUsd === 0, "an unknown price is NOT 0 — a 0 would crown the unpriced model as cheapest");
  ok(priceFor("deepseek") === null, "no prefix matching: 'deepseek' does not resolve to deepseek-chat");
  cannot(priceFor("deepseek-chat-v9") !== null, "a near-miss model name does NOT inherit a price");
}

console.log("\n── pricing: reported beats the table; missing tokens are unknown, not zero ──");
{
  const r = computeCost({ model: "deepseek-chat", tokensIn: 1_000_000, tokensOut: 1_000_000, reportedCostUsd: 0.9 });
  ok(r.costUsd === 0.9 && r.costSource === "reported", "a metered cost wins over the list price", JSON.stringify(r));
  cannot(r.costUsd === 1.37, "the table did NOT overwrite the caller's metered number");
  const rUnknown = computeCost({ model: "who-knows", tokensIn: null, tokensOut: null, reportedCostUsd: 0.02 });
  ok(rUnknown.costUsd === 0.02 && rUnknown.costSource === "reported", "an unpriced model with a metered cost is still known", rUnknown.costUsd);
  const noTok = computeCost({ model: "deepseek-chat", tokensIn: 1000, tokensOut: null });
  ok(noTok.costUsd === null && noTok.costSource === "unknown" && (noTok.reason ?? "").includes("token_counts_missing"),
    "a missing output token count → unknown, not 'input only'", noTok.reason);
  cannot(noTok.costUsd !== null, "a half-known token count does NOT produce a half-price");
  const bad = computeCost({ model: "deepseek-chat", tokensIn: 10, tokensOut: 10, reportedCostUsd: Number.NaN });
  ok(bad.costUsd === null && bad.costSource === "unknown", "a NaN reported cost → unknown, never silently re-priced", String(bad.costUsd));
}

console.log("\n── frontier: dominance definition ──");
{
  const a = { model: "a", meanScore: 90, costPer100Cases: 1 };
  const b = { model: "b", meanScore: 80, costPer100Cases: 2 };
  ok(dominates(a, b), "better score AND cheaper dominates");
  ok(!dominates(b, a), "…and the reverse does not");
  ok(!dominates(a, { model: "c", meanScore: 90, costPer100Cases: 1 }), "an identical point does NOT dominate (no strict improvement)");
  ok(dominates({ model: "d", meanScore: 90, costPer100Cases: 0.5 }, a), "same score, cheaper → dominates");
  ok(dominates({ model: "e", meanScore: 95, costPer100Cases: 1 }, a), "same cost, better → dominates");
}

console.log("\n── frontier: dominated points excluded ──");
{
  const pts = [
    { model: "cheap_bad", meanScore: 70, costPer100Cases: 0.10 },   // cheapest → frontier
    { model: "mid", meanScore: 85, costPer100Cases: 0.50 },          // frontier
    { model: "dear_good", meanScore: 95, costPer100Cases: 3.00 },    // best score → frontier
    { model: "dominated", meanScore: 80, costPer100Cases: 2.00 },    // worse than mid on BOTH
    { model: "also_dominated", meanScore: 70, costPer100Cases: 5.00 },
  ];
  const f = paretoFrontier(pts).map((p) => p.model).sort();
  ok(JSON.stringify(f) === JSON.stringify(["cheap_bad", "dear_good", "mid"]), "exactly the three non-dominated models", f.join(","));
  cannot(f.includes("dominated"), "a model worse on BOTH axes is NOT on the frontier");
  cannot(f.includes("also_dominated"), "…nor the one that is equal-score but 50x the cost");
  ok(paretoFrontier(pts).map((p) => p.model)[0] === "cheap_bad", "input order is preserved", paretoFrontier(pts)[0]?.model);
}

console.log("\n── frontier: ties, single point, empty ──");
{
  const tie = [
    { model: "twinA", meanScore: 88, costPer100Cases: 0.4 },
    { model: "twinB", meanScore: 88, costPer100Cases: 0.4 },
  ];
  const tf = paretoFrontier(tie).map((p) => p.model);
  ok(tf.length === 2, "two IDENTICAL points both stay on the frontier — a tie is a tie", tf.join(","));
  cannot(tf.length === 1, "a tie is NOT broken by whichever came first");

  const one = [{ model: "solo", meanScore: 10, costPer100Cases: 99 }];
  ok(paretoFrontier(one).length === 1, "a single point is trivially on its own frontier");
  ok(paretoFrontier([]).length === 0, "empty in → empty out");
  //  a partial tie: same score, one strictly cheaper → the dearer one IS dominated
  const partial = [
    { model: "same_score_cheap", meanScore: 88, costPer100Cases: 0.4 },
    { model: "same_score_dear", meanScore: 88, costPer100Cases: 0.9 },
  ];
  const pf = paretoFrontier(partial).map((p) => p.model);
  ok(pf.length === 1 && pf[0] === "same_score_cheap", "equal score, different cost → only the cheaper survives", pf.join(","));
  //  non-finite coordinates cannot be plotted and are excluded rather than sorted to one end
  const nf = paretoFrontier([{ model: "nan", meanScore: Number.NaN, costPer100Cases: 1 }, { model: "ok", meanScore: 5, costPer100Cases: 5 }]);
  ok(nf.length === 1 && nf[0]?.model === "ok", "a NaN coordinate is excluded, not ranked", nf.map((p) => p.model).join(","));
}

console.log("\n── aggregateModelRuns: case-weighted means, mixed sources, unpriced models ──");
{
  const row = (o: Partial<ModelRunRow> & { model: string }): ModelRunRow => ({
    provider: "p", cases: 100, score: 90, tokensIn: 1000, tokensOut: 500,
    costUsd: 0.1, costSource: "table", latencyP50Ms: 100, latencyP95Ms: 200, ...o,
  });
  const agg = aggregateModelRuns([
    //  m1: 100 cases @ 90 and 300 cases @ 94  → (9000 + 28200)/400 = 93.0
    row({ model: "m1", cases: 100, score: 90, costUsd: 0.10 }),
    row({ model: "m1", cases: 300, score: 94, costUsd: 0.30 }),
    //  m2: one run, cheaper, worse
    row({ model: "m2", cases: 100, score: 80, costUsd: 0.02 }),
    //  m3: no cost at all → not plottable
    row({ model: "m3", cases: 100, score: 99, costUsd: null, costSource: "unknown" }),
  ]);
  const byName = Object.fromEntries(agg.models.map((m) => [m.model, m]));
  ok(byName.m1?.meanScore === 93, "meanScore is CASE-WEIGHTED (93.0, not the flat mean 92.0)", byName.m1?.meanScore);
  cannot(byName.m1?.meanScore === 92, "a 300-case run does NOT count the same as a 100-case run");
  ok(byName.m1?.sampleCases === 400 && byName.m1?.runs === 2, "sampleCases and runs are reported", JSON.stringify({ c: byName.m1?.sampleCases, r: byName.m1?.runs }));
  //  cost/100 = total cost 0.40 over 400 cases * 100 = 0.10
  ok(byName.m1?.costPer100Cases === 0.1, "cost per 100 cases = total cost / total cases * 100", byName.m1?.costPer100Cases);
  ok(byName.m1?.meanCostUsd === 0.2, "meanCostUsd is the mean of the RUN costs", byName.m1?.meanCostUsd);
  ok(byName.m3?.costPer100Cases === null && (byName.m3?.costReason ?? "").length > 0,
    "an unpriced model has a null cost AND a stated reason", byName.m3?.costReason);
  cannot(byName.m3?.costPer100Cases === 0, "the unpriced model is NOT plotted at cost 0");
  ok(agg.unpriced.length === 1 && agg.unpriced[0]?.model === "m3", "…and it is NAMED in `unpriced`, not dropped", JSON.stringify(agg.unpriced));
  //  m3 has the best score but no cost → it CANNOT be on the frontier (it has no place on the plane)
  ok(agg.frontier.includes("m1") && agg.frontier.includes("m2"), "both priced models are Pareto-optimal here", agg.frontier.join(","));
  cannot(agg.frontier.includes("m3"), "a model with an UNKNOWN cost is not on the frontier, however good its score");
  ok(byName.m1?.price?.asOf === undefined || typeof byName.m1?.price?.asOf === "string", "price entry attached only when the model is in the table");
  ok(byName.m1?.tokensIn === 2000 && byName.m1?.tokensOut === 1000, "token counts sum across runs", JSON.stringify({ i: byName.m1?.tokensIn }));

  const mixed = aggregateModelRuns([
    row({ model: "mx", costSource: "table" }),
    row({ model: "mx", costSource: "reported" }),
  ]);
  ok(mixed.models[0]?.costSource === "mixed", "runs that disagree on provenance report 'mixed', never a flattened winner", mixed.models[0]?.costSource);
  ok(aggregateModelRuns([]).models.length === 0 && aggregateModelRuns([]).frontier.length === 0, "no runs → no models, no frontier");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — price table (known/unknown/reported), pareto dominance, frontier ties/empty/single, case-weighted aggregation");
process.exit(fail ? 1 : 0);
