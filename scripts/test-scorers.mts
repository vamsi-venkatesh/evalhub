// Eval Hub Phase 2 — scorer unit suite. NO NETWORK, NO DATABASE, NO MODEL required.
// Every dependency that could reach the outside world (the judge's fetch, the embedder) is
// INJECTED here, so this file tests the real shipped code paths without a single packet.
//
// The one optional part is the real MiniLM: if @xenova/transformers can load and download the
// model, we additionally assert embedding sanity. If it cannot, we print a LOUD SKIP and count
// nothing as passed. There is no fake-embedding fallback that quietly stands in for the model.
import {
  cohensKappa,
  kappaBand,
  MIN_CALIBRATION_LABELS,
} from "../src/kappa.js";
import {
  bestWindowSimilarity,
  checkCitation,
  GROUNDING_FUZZY_THRESHOLD,
  scoreGrounding,
} from "../src/scorers/grounding.js";
import {
  decideSupport,
  extractAnchors,
  keyFacts,
  lexicallySupported,
  scoreHallucination,
  SUPPORT_EMBED_THRESHOLD,
} from "../src/scorers/hallucination.js";
import {
  chatJson,
  extractJsonObject,
  isJudgeProviderError,
  judgeConfigFromEnv,
  makeJudgeClaimExtractor,
  runJudge,
  type FetchFn,
  type JudgeConfig,
} from "../src/scorers/judge.js";
import {
  cosine,
  embedSim,
  exactNorm,
  normalizeText,
  tokenF1,
  tokenize,
  type EmbedFn,
} from "../src/scorers/metrics.js";

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
/** NEGATIVE CONTROL — asserts a deliberately WRONG expectation is false, proving the check can fail. */
const cannot = (wrong: boolean, what: string) => {
  console.log(`  ${!wrong ? "PASS" : "FAIL"}  [neg-control] ${what}`);
  if (wrong) fail++;
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── a deterministic FAKE embedder ─────────────────────────────────────────────────────────────
// Bag-of-tokens in a fixed 64-dim hashed space. It is NOT MiniLM and never pretends to be: it
// exists so the support/threshold LOGIC can be tested exactly. Cosine here ≈ token overlap.
const FAKE_DIM = 64;
const fakeEmbed: EmbedFn = async (texts: string[]) =>
  texts.map((t) => {
    const v = new Array(FAKE_DIM).fill(0);
    for (const tok of tokenize(t)) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % FAKE_DIM] += 1;
    }
    const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / n);
  });

console.log("\n══ metrics ══");
{
  ok(normalizeText("  The QUICK,  brown—fox!  ") === "the quick brown fox", "normalizeText: case, punctuation, whitespace", normalizeText("  The QUICK,  brown—fox!  "));
  ok(normalizeText("café") === "cafe", "normalizeText strips diacritics", normalizeText("café"));
  ok(exactNorm("Hello, World!", "  hello world  ") === true, "exactNorm ignores case/punctuation/ws");
  cannot(exactNorm("hello world", "hello there") === true, "exactNorm does NOT match different words");
  ok(exactNorm("", "") === true, "exactNorm: two empties match");

  // Hand-computed SQuAD-style F1 values.
  ok(tokenF1("the quick brown fox", "the quick brown fox") === 1, "tokenF1 identical → 1");
  ok(near(tokenF1("a b c d", "a b x y"), 0.5), "tokenF1 'a b c d' vs 'a b x y' → 0.5 (common 2, p .5, r .5)", tokenF1("a b c d", "a b x y"));
  ok(near(tokenF1("a b c", "a b c d e"), 0.75), "tokenF1 'a b c' vs 'a b c d e' → 0.75 (p .6, r 1)", tokenF1("a b c", "a b c d e"));
  ok(tokenF1("a b c", "x y z") === 0, "tokenF1 disjoint → 0");
  ok(tokenF1("", "") === 1, "tokenF1 both empty → 1");
  ok(tokenF1("", "a b") === 0, "tokenF1 one empty → 0");
  // multiset behaviour: repeats are capped by the other side, not double-counted.
  ok(near(tokenF1("a a b", "a b"), 0.8), "tokenF1 'a a b' vs 'a b' → 0.8 (common 2, p 1, r 2/3)", tokenF1("a a b", "a b"));
  cannot(tokenF1("a b c d", "a b x y") === 1, "a half-wrong answer does NOT score 1");

  ok(cosine([1, 0], [1, 0]) === 1, "cosine identical → 1");
  ok(cosine([1, 0], [0, 1]) === 0, "cosine orthogonal → 0");
  ok(cosine([1, 0], [-1, 0]) === 0, "cosine opposite → clamped to 0");
  ok(cosine([], []) === 0, "cosine of empty vectors → 0");
}

console.log("\n══ embedSim (injected fake embedder — the model is NOT involved) ══");
{
  ok(near(await embedSim("the sky is blue", "the sky is blue", fakeEmbed), 1), "identical strings → 1");
  const unrelated = await embedSim("quantum chromodynamics lattice", "banana bread recipe", fakeEmbed);
  ok(unrelated === 0, "token-disjoint strings → 0 in the fake space", unrelated);
  ok((await embedSim("", "", fakeEmbed)) === 1, "two empty strings → 1 (decided before the model)");
  ok((await embedSim("", "x", fakeEmbed)) === 0, "one empty string → 0");
  let called = 0;
  const counting: EmbedFn = async (t) => { called++; return fakeEmbed(t); };
  await embedSim("", "", counting);
  ok(called === 0, "the embedder is never called for the empty/empty shortcut", called);
}

console.log("\n══ grounding (fully deterministic — no model, no provider) ══");
{
  const sources = {
    s1: "The candidate led the migration of a 40-service monolith to Kubernetes, cutting p95 latency from 820ms to 210ms across the fleet.",
    s2: "She holds an MSc in Computer Science from TU Berlin and has published two papers on distributed consensus.",
  };
  const exact = checkCitation({ sourceId: "s1", quote: "cutting p95 latency from 820ms to 210ms" }, sources);
  ok(exact.found === true && exact.similarity === 1 && exact.match === "exact", "EXACT substring → found, similarity 1", JSON.stringify({ f: exact.found, s: exact.similarity, m: exact.match }));

  const punct = checkCitation({ sourceId: "s2", quote: "an  MSc, in Computer Science — from TU Berlin!" }, sources);
  ok(punct.found === true && punct.match === "exact", "EXACT after normalization (case/punct/ws) → found", punct.match);

  // One extra word inserted: not a substring, but the best window still overlaps heavily.
  const fuzzy = checkCitation({ sourceId: "s1", quote: "led the full migration of a 40-service monolith to Kubernetes" }, sources);
  ok(fuzzy.found === true && fuzzy.match === "fuzzy" && fuzzy.similarity >= GROUNDING_FUZZY_THRESHOLD && fuzzy.similarity < 1,
    `FUZZY (one inserted word) → found at sim >= ${GROUNDING_FUZZY_THRESHOLD}`, fuzzy.similarity);

  const miss = checkCitation({ sourceId: "s1", quote: "the candidate personally invented the Raft consensus protocol in 2009" }, sources);
  ok(miss.found === false && miss.match === "miss", "INVENTED quote → not found", `sim ${miss.similarity}`);
  cannot(miss.found === true, "a fabricated quote is NOT reported as grounded");
  cannot(miss.similarity >= GROUNDING_FUZZY_THRESHOLD, "…and its similarity is below the threshold");

  const unknown = checkCitation({ sourceId: "s99", quote: "anything at all" }, sources);
  ok(unknown.found === false && unknown.match === "unknown_source", "citation of a source that does not exist → unknown_source");
  const empty = checkCitation({ sourceId: "s1", quote: "   " }, sources);
  ok(empty.found === false && empty.match === "empty_quote", "empty quote → not 'grounded in everything'");

  const set = scoreGrounding(
    [
      { sourceId: "s1", quote: "cutting p95 latency from 820ms to 210ms" },
      { sourceId: "s2", quote: "MSc in Computer Science from TU Berlin" },
      { sourceId: "s1", quote: "the candidate personally invented the Raft consensus protocol" },
      { sourceId: "s9", quote: "nowhere" },
    ],
    sources
  );
  ok(set.citationCount === 4 && set.groundingRate === 0.5, "2 of 4 citations valid → groundingRate 0.5", set.groundingRate);
  ok(scoreGrounding([], sources).groundingRate === 0, "zero citations → rate 0, never 1");
  const bw = bestWindowSimilarity("nothing like this at all", sources.s2!);
  cannot(bw.similarity >= GROUNDING_FUZZY_THRESHOLD, "bestWindowSimilarity does not manufacture a match");
}

console.log("\n══ hallucination (INJECTED fake judge + injected fake embedder) ══");
{
  const SOURCES = [
    "Vamsi Venkatesh worked at Siemens from 2019 to 2023 as a backend engineer, where he built the order-routing service in Go.",
    "He completed an MSc at Otto von Guericke University Magdeburg in 2019.",
  ];
  const SUPPORTED = "Vamsi Venkatesh worked at Siemens from 2019 to 2023.";
  const SUPPORTED_PARAPHRASE = "He built the order-routing service in Go at Siemens.";
  const PLANTED = "He was promoted to Vice President of Engineering at Rakuten in 2021, managing 140 people.";

  // The fake judge returns FIXED claims — claim extraction is not what is under test here; the
  // deterministic SUPPORT decision is.
  const fixedClaims = async () => [SUPPORTED, SUPPORTED_PARAPHRASE, PLANTED];

  const r = await scoreHallucination({ output: "irrelevant — the extractor is injected", sources: SOURCES }, { extractClaims: fixedClaims, embed: fakeEmbed });
  ok(r.claimCount === 3, "3 claims scored", r.claimCount);
  const byText = new Map(r.claims.map((c) => [c.text, c]));
  ok(byText.get(SUPPORTED)!.supported === true, "a claim copied from the source IS supported", byText.get(SUPPORTED)!.method);
  ok(byText.get(SUPPORTED_PARAPHRASE)!.supported === true, "a reordered claim whose key facts are all in the source IS supported", byText.get(SUPPORTED_PARAPHRASE)!.method);
  ok(byText.get(PLANTED)!.supported === false, "the PLANTED fabrication IS FLAGGED", byText.get(PLANTED)!.method);
  ok(byText.get(PLANTED)!.bestSource === null && byText.get(PLANTED)!.evidence === null, "…with no source and no evidence attached");
  ok(r.hallucinationRate === 0.3333, "hallucinationRate 1/3 → 0.3333 (4dp)", r.hallucinationRate);
  cannot(byText.get(PLANTED)!.supported === true, "the planted claim is NOT waved through");
  cannot(byText.get(SUPPORTED)!.supported === false, "a genuinely supported claim is NOT falsely flagged");

  ok(byText.get(SUPPORTED)!.bestSource === 0, "the supporting source index is reported", byText.get(SUPPORTED)!.bestSource);

  // key-fact machinery
  ok(keyFacts("He earned 140% more in 2021").includes("140") && keyFacts("He earned 140% more in 2021").includes("2021"), "keyFacts keeps numbers", JSON.stringify(keyFacts("He earned 140% more in 2021")));
  ok(!keyFacts("the and of a").length, "keyFacts drops pure stopwords", JSON.stringify(keyFacts("the and of a")));
  ok(lexicallySupported("built the order-routing service in Go", SOURCES[0]!) === true, "lexicallySupported: key facts all present");
  ok(lexicallySupported("built the order-routing service in Rust", SOURCES[0]!) === false, "lexicallySupported: one novel token breaks it");

  // The embed path must be able to RESCUE a claim that lexical containment misses. The claim below
  // carries one token ("omicron") that is NOT in the source, so lexical containment fails outright;
  // the remaining 13 of 14 tokens overlap, so the vector similarity (13/14 ≈ 0.93 in the fake space)
  // clears the 0.80 threshold. This is the ONLY test that proves the second pass exists.
  const SRC14 = "zeta yankee whiskey tango foxtrot bravo delta echo golf hotel india juliet kilo lima";
  const CLAIM14 = "zeta yankee whiskey tango foxtrot bravo delta echo golf hotel india juliet kilo omicron";
  ok(lexicallySupported(CLAIM14, SRC14) === false, "…the rescue case really does fail lexical containment first");
  const embedOnly = await scoreHallucination({ output: "x", sources: [SRC14] }, { extractClaims: async () => [CLAIM14], embed: fakeEmbed });
  ok(embedOnly.claims[0]!.method === "embed", "a lexically-missed but semantically-near claim is rescued by the EMBED pass", embedOnly.claims[0]!.method);
  ok((embedOnly.claims[0]!.similarity ?? 0) >= SUPPORT_EMBED_THRESHOLD,
    `…at or above the ${SUPPORT_EMBED_THRESHOLD} threshold`, embedOnly.claims[0]!.similarity);
  cannot(embedOnly.claims[0]!.evidence === null, "…and the winning source window is attached as evidence");

  const noSrc = await scoreHallucination({ output: "x", sources: [] }, { extractClaims: fixedClaims, embed: fakeEmbed });
  ok(noSrc.hallucinationRate === 1 && noSrc.warnings?.length === 1, "no sources → rate 1 and a WARNING, never a silent 0", JSON.stringify(noSrc.warnings));
  cannot(noSrc.hallucinationRate === 0, "an output with no sources does NOT score a clean 0");

  const noClaims = await scoreHallucination({ output: "", sources: SOURCES }, { extractClaims: async () => [], embed: fakeEmbed });
  ok(noClaims.claimCount === 0 && noClaims.hallucinationRate === 0, "zero claims → rate 0, claimCount 0");

  // ANCHOR SEMANTICS (2026-08-05 rule set — see the hallucination.ts header).
  // A hard anchor is a number, a multi-token capitalised entity, a capitalised letter+digit token,
  // or an ALL-CAPS hyphenated form. A lone capitalised word is WEAK, and a lone ≤5-letter acronym
  // is no anchor at all (an honest rewrite may coin "MTTA" for "mean time to acknowledge").
  const kinds = (s: string) => extractAnchors(s).map((a) => `${a.kind}:${a.text}`);
  ok(kinds("He joined Zalando SE in 2021").includes("entity:Zalando SE"), "a two-word capitalised phrase is a STRONG entity", JSON.stringify(kinds("He joined Zalando SE in 2021")));
  ok(kinds("He led the SEPA rollout at N26").some((k) => k === "entity:N26"), "a letter+digit token is a STRONG entity", JSON.stringify(kinds("He led the SEPA rollout at N26")));
  ok(!kinds("MTTA fell from 14 minutes to 4 minutes").some((k) => k.includes("MTTA")), "a lone acronym is NOT an anchor (rewrites abbreviate)", JSON.stringify(kinds("MTTA fell from 14 minutes to 4 minutes")));
  ok(kinds("Die Senkung der Zeit war groß").every((k) => !k.startsWith("entity:")), "German sentence-opening grammar does NOT become a strong entity", JSON.stringify(kinds("Die Senkung der Zeit war groß")));
  ok(extractAnchors("He earned eleven years of experience").some((a) => a.kind === "number" && a.text === "11"), "a spelled-out numeral is a number anchor");
  {
    const SRC = ["ANNA WEBER — Backend Engineer. Skills: Node.js, TypeScript, PostgreSQL. Betreut 180 Mitarbeitende bei den Stadtwerke München."];
    ok(decideSupport("ANNA WEBER's skills include Node.js.", SRC).status === "anchored", "a possessive + a dotted tech name still match (punctuation-compacted containment)", decideSupport("ANNA WEBER's skills include Node.js.", SRC).status);
    ok(decideSupport("Sie war bei den Stadtwerken München tätig.", SRC).status === "anchored", "German inflection (Stadtwerken/Stadtwerke) still matches", decideSupport("Sie war bei den Stadtwerken München tätig.", SRC).status);
    const inv = decideSupport("ANNA WEBER's skills include Zalando SE.", SRC);
    ok(inv.status === "missing_hard_anchor" && inv.missing.includes("Zalando SE"), "an entity absent from the source is a HARD miss, named in `missing`", JSON.stringify(inv.missing));
    cannot(inv.status === "anchored", "compaction does NOT wave an absent entity through");
  }

  // A missing HARD anchor is final: the embedding tier may not rescue a fabrication, however well
  // the surrounding sentence matches. Proven with an embedder that returns near-perfect similarity.
  const yesEmbed: EmbedFn = async (texts: string[]) => texts.map(() => [1, 0, 0]);
  const noRescue = await scoreHallucination({ output: "x", sources: SOURCES }, { extractClaims: async () => [PLANTED], embed: yesEmbed });
  ok(noRescue.claims[0]!.supported === false && noRescue.claims[0]!.method === "unsupported_anchor", "a hard-anchor miss is NEVER rescued by the embed tier", noRescue.claims[0]!.method);
  cannot(noRescue.claims[0]!.method === "embed", "an all-1.0 embedder does NOT launder a planted claim");

  // A broken embedder must NOT be silently treated as "similarity 0" — the lexical verdicts stand
  // and the missing pass is declared. The extra claim below carries NO anchors, so it is the one
  // that actually reaches (and needs) the embed pass.
  const ANCHORLESS = "he shipped production software professionally for several years";
  const brokenEmbed: EmbedFn = async () => { throw new Error("model download blocked"); };
  const degraded = await scoreHallucination({ output: "x", sources: SOURCES }, { extractClaims: async () => [SUPPORTED, SUPPORTED_PARAPHRASE, PLANTED, ANCHORLESS], embed: brokenEmbed });
  ok(extractAnchors(ANCHORLESS).length === 0, "…the degraded-mode probe really is anchorless (or the test proves nothing)", JSON.stringify(extractAnchors(ANCHORLESS)));
  ok(degraded.warnings?.some((w) => w.startsWith("embed_support_check_unavailable")) === true, "a dead embedder is DECLARED, not hidden", JSON.stringify(degraded.warnings));
  ok(degraded.claims.find((c) => c.text === SUPPORTED)!.supported === true, "…and the lexical verdicts still hold");

  // A provider failure inside claim extraction must PROPAGATE (the route turns it into 502).
  let propagated = false;
  try {
    await scoreHallucination({ output: "x", sources: SOURCES }, {
      extractClaims: async () => { throw Object.assign(new Error("judge_http_error"), { name: "JudgeProviderError" }); },
      embed: fakeEmbed,
    });
  } catch (e) { propagated = isJudgeProviderError(e); }
  ok(propagated, "a provider failure during claim extraction PROPAGATES — no partial score is invented");
}

console.log("\n══ judge (INJECTED fetch — no network) ══");
{
  const chat = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  const seq = (responses: (() => Response | Promise<Response>)[]) => {
    const calls: { url: string; body: any }[] = [];
    const f: FetchFn = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
      return next();
    };
    return { f, calls };
  };
  const cfg = (f: FetchFn): JudgeConfig => ({ url: "http://mock/chat/completions", key: "k", model: "mock-judge", fetchImpl: f, timeoutMs: 2000 });

  ok(JSON.stringify(extractJsonObject('```json\n{"a":1}\n```')) === '{"a":1}', "extractJsonObject strips markdown fences");
  ok(JSON.stringify(extractJsonObject('Sure! {"a":2} hope that helps')) === '{"a":2}', "…and prose around the object");

  // 1) happy path
  {
    const { f, calls } = seq([() => chat('{"score":88,"verdict":"pass","reasoning":"meets the rubric"}')]);
    const j = await runJudge(cfg(f), { rubric: "R", input: "I", output: "O" });
    ok(j.score === 88 && j.verdict === "pass" && j.model === "mock-judge" && j.retried === false, "judge success → score/verdict/model", JSON.stringify(j));
    ok(calls[0]!.body.temperature === 0, "temperature 0 is sent", calls[0]!.body.temperature);
    ok(calls.length === 1, "one provider call on the happy path", calls.length);
  }
  // 2) malformed JSON → ONE retry → success
  {
    const { f, calls } = seq([() => chat("I think it's pretty good, maybe 80?"), () => chat('{"score":80,"verdict":"pass","reasoning":"ok"}')]);
    const j = await runJudge(cfg(f), { rubric: "R", input: "I", output: "O" });
    ok(j.score === 80 && j.retried === true, "malformed JSON → retried once → parsed", JSON.stringify({ s: j.score, r: j.retried }));
    ok(calls.length === 2, "exactly TWO provider calls (one retry, not a loop)", calls.length);
  }
  // 3) malformed twice → typed parse error, NEVER a score
  {
    const { f, calls } = seq([() => chat("nope"), () => chat("still nope")]);
    let err: unknown = null;
    try { await runJudge(cfg(f), { rubric: "R", input: "I", output: "O" }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err) && (err as any).stage === "parse", "unparseable twice → JudgeProviderError(parse)", (err as any)?.message);
    ok(calls.length === 2, "…and it stops at 2 calls", calls.length);
    cannot(typeof (err as any)?.score === "number", "no score is fabricated on a parse failure");
  }
  // 4) out-of-range score is a PARSE failure, not a clamp
  {
    const { f } = seq([() => chat('{"score":9001,"verdict":"pass","reasoning":"x"}')]);
    let err: unknown = null;
    try { await runJudge(cfg(f), { rubric: "R", input: "I", output: "O" }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err), "score 9001 → error, not a silently clamped 100", (err as any)?.message);
  }
  // 5) provider 500 → typed http error, and NO retry (a 500 does not become truthful twice)
  {
    const { f, calls } = seq([() => new Response("upstream exploded", { status: 500 })]);
    let err: any = null;
    try { await runJudge(cfg(f), { rubric: "R", input: "I", output: "O" }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err) && err.stage === "http" && err.status === 500, "provider 500 → JudgeProviderError(http, 500)", JSON.stringify({ s: err?.stage, c: err?.status }));
    ok(calls.length === 1, "an HTTP failure is NOT retried", calls.length);
    ok(String(err.detail).includes("upstream exploded"), "the provider's real body is surfaced", err.detail);
  }
  // 6) transport failure
  {
    const f: FetchFn = async () => { throw new Error("ECONNREFUSED"); };
    let err: any = null;
    try { await runJudge(cfg(f), { rubric: "R", input: "I", output: "O" }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err) && err.stage === "transport", "unreachable provider → JudgeProviderError(transport)", err?.message);
  }
  // 7) missing key → config error, and the network is never touched
  {
    let touched = false;
    const f: FetchFn = async () => { touched = true; return chat("{}"); };
    let err: any = null;
    try { await runJudge({ url: "http://mock", key: "", model: "m", fetchImpl: f }, { rubric: "R", input: "I", output: "O" }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err) && err.stage === "config", "empty key → JudgeProviderError(config)", err?.message);
    ok(touched === false, "…and no request was made");
  }
  // 8) empty assistant content
  {
    const { f } = seq([() => chat("")]);
    let err: any = null;
    try { await runJudge(cfg(f), { rubric: "R", input: "I", output: "O" }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err), "empty content → error, not score 0", err?.message);
  }
  // 9) claim extraction over the same transport
  {
    const { f } = seq([() => chat('{"claims":["a is b","c is d",""]}')]);
    const claims = await makeJudgeClaimExtractor(cfg(f))("whatever");
    ok(claims.length === 2 && claims[0] === "a is b", "claim extractor parses + drops empties", JSON.stringify(claims));
  }
  // 10) chatJson surfaces a validator rejection as a parse error after the retry
  {
    const { f } = seq([() => chat('{"claims":"not an array"}'), () => chat('{"claims":"still not an array"}')]);
    let err: any = null;
    try { await chatJson(cfg(f), [{ role: "user", content: "x" }], (v) => { if (!Array.isArray((v as any).claims)) throw new Error("claims is not an array"); return v; }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err) && err.stage === "parse", "a validator rejection is a parse failure", err?.message);
  }
  // env defaults: Claude first, then OpenAI, then DeepSeek; a provider with no key is skipped
  {
    const c = judgeConfigFromEnv({} as NodeJS.ProcessEnv);
    ok(c.provider === "anthropic" && c.url === "https://api.anthropic.com/v1/messages" && c.model === "claude-haiku-5-5" && c.key === "", "judgeConfigFromEnv with no keys: Anthropic claude-haiku-5-5 with an empty key (fails loudly as judge_key_missing)", JSON.stringify({ u: c.url, m: c.model }));
    const only = judgeConfigFromEnv({ EVALHUB_DEEPSEEK_KEY: "dk" } as NodeJS.ProcessEnv);
    ok(only.provider === "deepseek" && only.model === "deepseek-chat" && only.url === "https://api.deepseek.com/chat/completions" && !only.fallbacks, "only a DeepSeek key -> DeepSeek, like before");
    const legacy = judgeConfigFromEnv({ EVALHUB_JUDGE_URL: "http://x/y", EVALHUB_JUDGE_MODEL: "m2", EVALHUB_DEEPSEEK_KEY: "kk" } as NodeJS.ProcessEnv);
    ok(legacy.url === "http://x/y" && legacy.model === "m2" && legacy.key === "kk", "the legacy EVALHUB_JUDGE_URL / _MODEL still configure the DeepSeek entry");
    const all = judgeConfigFromEnv({ EVALHUB_ANTHROPIC_KEY: "a", EVALHUB_OPENAI_KEY: "o", EVALHUB_DEEPSEEK_KEY: "d", EVALHUB_JUDGE_MODEL: "deepseek-chat", EVALHUB_JUDGE_URL: "https://api.deepseek.com/chat/completions" } as NodeJS.ProcessEnv);
    ok(all.provider === "anthropic" && all.model === "claude-haiku-5-5" && all.fallbacks?.map((f) => f.provider).join(",") === "openai,deepseek" && all.fallbacks?.[0]?.model === "gpt-6-luna", "all keys set (the old server env still present): Claude Haiku 5.5 -> OpenAI gpt-6-luna -> DeepSeek");
    const noClaude = judgeConfigFromEnv({ EVALHUB_OPENAI_KEY: "o", EVALHUB_DEEPSEEK_KEY: "d" } as NodeJS.ProcessEnv);
    ok(noClaude.provider === "openai" && noClaude.fallbacks?.length === 1, "no Anthropic key: the rotation starts at OpenAI");
  }

  // Anthropic Messages API wire shape + rotation
  {
    let seen: { url: string; headers: Record<string, string>; body: any } | null = null;
    const anthropicOk: FetchFn = async (url, init) => {
      seen = { url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"score":91,"verdict":"pass","reasoning":"ok"}' }] }), { status: 200 });
    };
    const c: JudgeConfig = { provider: "anthropic", url: "https://api.anthropic.com/v1/messages", key: "sk-test", model: "claude-haiku-5-5", fetchImpl: anthropicOk, timeoutMs: 2000 };
    const j = await runJudge(c, { rubric: "R", input: "I", output: "O" });
    ok(j.score === 91 && j.verdict === "pass" && j.model === "claude-haiku-5-5", "Anthropic: text block parsed (thinking blocks ignored)");
    ok(seen!.headers["x-api-key"] === "sk-test" && seen!.headers["anthropic-version"] === "2023-06-01" && !("authorization" in seen!.headers), "Anthropic: x-api-key + anthropic-version, no Bearer");
    ok(typeof seen!.body.system === "string" && /strict evaluation judge/.test(seen!.body.system) && seen!.body.messages.every((m: any) => m.role === "user") && seen!.body.max_tokens > 0 && !("temperature" in seen!.body), "Anthropic: system is top-level, only user/assistant in messages, max_tokens set, NO temperature");

    // rotation: Claude out of credit (400) -> OpenAI answers; the reported model is the one that answered
    const calls: string[] = [];
    const rot: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes("anthropic")) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }), { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"score":70,"verdict":"pass","reasoning":"fallback"}' } }] }), { status: 200 });
    };
    const chain: JudgeConfig = { ...c, fetchImpl: rot, fallbacks: [{ provider: "openai", url: "https://api.openai.com/v1/chat/completions", key: "o", model: "gpt-6-luna" }, { provider: "deepseek", url: "https://api.deepseek.com/chat/completions", key: "d", model: "deepseek-chat" }] };
    const r = await runJudge(chain, { rubric: "R", input: "I", output: "O" });
    ok(r.score === 70 && r.model === "gpt-6-luna" && calls.length === 2 && calls[1]!.includes("openai"), "Claude refused (no credit) -> OpenAI luna judged, and the result names gpt-6-luna, not the primary", calls.join(" > "));
    const allDown: FetchFn = async () => new Response("down", { status: 503 });
    let err: any; try { await runJudge({ ...chain, fetchImpl: allDown }, { rubric: "R", input: "I", output: "O" }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err) && err.stage === "http" && err.status === 503, "every provider down -> an error (the first failure), never a score");
    // a PARSE failure is not a reason to switch provider
    const calls2: string[] = [];
    const junk: FetchFn = async (url) => { calls2.push(url); return new Response(JSON.stringify({ content: [{ type: "text", text: "not json" }] }), { status: 200 }); };
    err = undefined; try { await runJudge({ ...chain, fetchImpl: junk }, { rubric: "R", input: "I", output: "O" }); } catch (e) { err = e; }
    ok(isJudgeProviderError(err) && err.stage === "parse" && calls2.every((u) => u.includes("anthropic")), "unparseable answers retry on the SAME provider and never rotate", String(calls2.length));
  }
}

console.log("\n══ Cohen's kappa ══");
{
  const mk = (spec: [string, string, number][]) => spec.flatMap(([h, j, n]) => Array.from({ length: n }, () => ({ human: h, judge: j })));

  // (a) THE MAIN HAND-CHECK — the same distribution the route test seeds.
  //     18 (pass,pass) · 3 (pass,fail) · 2 (fail,pass) · 2 (fail,fail), n = 25
  //     po = (18+2)/25 = 0.8
  //     human marginals: pass 21, fail 4 · judge marginals: pass 20, fail 5
  //     pe = (21/25)(20/25) + (4/25)(5/25) = 0.672 + 0.032 = 0.704
  //     κ  = (0.8 − 0.704) / (1 − 0.704) = 0.096 / 0.296 = 0.324324… → 0.3243
  const main = cohensKappa(mk([["pass", "pass", 18], ["pass", "fail", 3], ["fail", "pass", 2], ["fail", "fail", 2]]));
  ok(main.n === 25, "n = 25", main.n);
  ok(main.agreement === 0.8, "observed agreement po = 0.8", main.agreement);
  ok(main.expected === 0.704, "chance agreement pe = 0.704", main.expected);
  ok(main.kappa === 0.3243, "κ = 0.3243 (hand-computed 0.096/0.296)", main.kappa);
  ok(main.degenerate === false, "not degenerate");
  ok(main.confusion.pass!.fail === 3 && main.confusion.fail!.pass === 2, "confusion matrix is oriented human→judge", JSON.stringify(main.confusion));
  cannot(main.kappa === main.agreement, "κ is NOT just the raw agreement");

  // (b) perfect agreement on a MIXED corpus: po=1, pe=0.5 → κ=1
  const mixedPerfect = cohensKappa(mk([["pass", "pass", 5], ["fail", "fail", 5]]));
  ok(mixedPerfect.kappa === 1 && mixedPerfect.agreement === 1 && mixedPerfect.expected === 0.5 && mixedPerfect.degenerate === false,
    "5/5 perfect on a mixed corpus → κ 1, pe 0.5, not degenerate", JSON.stringify({ k: mixedPerfect.kappa, e: mixedPerfect.expected }));

  // (c) THE DEGENERATE CASE: everyone said 'pass' 10 times. pe = 1 → κ undefined; we return 1
  //     and SAY it is degenerate.
  const deg = cohensKappa(mk([["pass", "pass", 10]]));
  ok(deg.agreement === 1 && deg.expected === 1 && deg.kappa === 1 && deg.degenerate === true,
    "all-same-category perfect agreement → κ 1 with degenerate:true (documented convention)", JSON.stringify({ k: deg.kappa, d: deg.degenerate }));
  cannot(deg.degenerate === false, "a single-category corpus does NOT masquerade as a real κ");

  // (d) exactly chance: 2/2/2/2 → po 0.5, pe 0.5 → κ 0
  const chance = cohensKappa(mk([["pass", "pass", 2], ["pass", "fail", 2], ["fail", "pass", 2], ["fail", "fail", 2]]));
  ok(chance.agreement === 0.5 && chance.expected === 0.5 && chance.kappa === 0, "chance-level agreement → κ 0", JSON.stringify({ po: chance.agreement, k: chance.kappa }));

  // (e) ASYMMETRIC MARGINALS — the reason kappa exists. Human says pass 10/10; the judge says pass
  //     8/10. 80% raw agreement, and κ = 0: the judge learned nothing a coin could not.
  const asym = cohensKappa(mk([["pass", "pass", 8], ["pass", "fail", 2]]));
  ok(asym.agreement === 0.8 && asym.kappa === 0, "80% agreement with degenerate human marginal → κ 0", JSON.stringify({ po: asym.agreement, k: asym.kappa }));
  cannot(asym.kappa > 0.5, "high raw agreement does NOT buy a high κ");

  // (f) total disagreement → κ = −1
  const anti = cohensKappa(mk([["pass", "fail", 5], ["fail", "pass", 5]]));
  ok(anti.agreement === 0 && anti.kappa === -1, "perfect disagreement → κ −1", anti.kappa);
  ok(kappaBand(anti.kappa) === "worse than chance", "band names it", kappaBand(anti.kappa));

  // (g) empty input is TOTAL, not a throw
  const zero = cohensKappa([]);
  ok(zero.n === 0 && zero.kappa === 0 && zero.degenerate === true, "n=0 → {n:0, κ:0, degenerate:true}", JSON.stringify(zero));

  // (h) three categories (borderline included) still computes
  const three = cohensKappa(mk([["pass", "pass", 6], ["fail", "fail", 6], ["borderline", "pass", 3], ["pass", "borderline", 3]]));
  ok(three.categories.length === 3 && three.n === 18, "three categories, n 18", JSON.stringify(three.categories));
  ok(three.kappa > 0 && three.kappa < 1, "…and κ lands strictly between 0 and 1", three.kappa);

  ok(kappaBand(0.85) === "almost perfect" && kappaBand(0.5) === "moderate" && kappaBand(0.1) === "slight", "kappaBand bands");
  ok(MIN_CALIBRATION_LABELS === 20, "the refusal threshold is 20 labels", MIN_CALIBRATION_LABELS);
}

// ── OPTIONAL: the real MiniLM. Never faked, never skipped silently. ───────────────────────────
console.log("\n══ real MiniLM embeddings (optional — needs @xenova/transformers + the model) ══");
{
  let realOk = false;
  let why = "";
  try {
    const { miniLmEmbed } = await import("../src/scorers/metrics.js");
    const same = await embedSim("the deployment gate blocks a regression", "the deployment gate blocks a regression", miniLmEmbed);
    const diff = await embedSim("the deployment gate blocks a regression", "banana bread needs ripe bananas", miniLmEmbed);
    const parap = await embedSim("the cat sat on the mat", "a cat was sitting on the rug", miniLmEmbed);
    realOk = true;
    ok(same > 0.99, "MiniLM: identical strings → ~1", same);
    ok(diff < 0.5, "MiniLM: unrelated strings → < 0.5", diff);
    ok(parap > diff, "MiniLM: a paraphrase scores higher than an unrelated string", `${parap} > ${diff}`);
    cannot(diff > same, "an unrelated pair does NOT beat an identical pair");
  } catch (e) {
    why = String((e as Error)?.message ?? e);
  }
  if (!realOk) {
    console.log("  " + "!".repeat(74));
    console.log("  SKIP  the real MiniLM could not run — NOTHING about real embeddings was tested.");
    console.log("  This is NOT a pass. embedSim in production is UNVERIFIED by this run.");
    console.log(`  reason: ${why.slice(0, 300)}`);
    console.log("  fix: npm i @xenova/transformers && allow the first-run model download");
    console.log("        (box: TRANSFORMERS_CACHE=/opt/evalhub/.cache, writable by the evalhub user)");
    console.log("  " + "!".repeat(74));
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — metrics, grounding, hallucination, judge transport + kappa hold");
process.exit(fail ? 1 : 0);
