# Eval Hub — Phase 2 addendum (judge · metrics · hallucination · grounding · calibration)
Extends CONTRACT-V0.md. Same auth, same JSON-only, same never-lie-on-writes laws.

## Design stance
- Shared scorers live in the HUB, implemented once. Products call them SYNCHRONOUSLY during their
  eval runs via POST /api/score and include the returned scores in the results they push. The hub
  stays stateless per score call; runs/baselines flow is unchanged.
- LLM suites are NOT part of the per-deploy gate (spend + latency). They run NIGHTLY via a systemd
  timer on the box and on demand; regressions surface through the same runs/baselines tables and
  (Phase 3) alerting. The deploy gate keeps the deterministic suites only.
- The judge is UNCALIBRATED until human labels produce a kappa. The hub must report calibration
  status honestly on every judge response: {calibration: {status:'uncalibrated'|'calibrated',
  kappa?, n?, at?}}. An uncalibrated judge's scores are advisory and MUST NOT gate anything.

## POST /api/score  (one endpoint, kind-dispatched; body ≤ 256KB)
Common: {kind, payload}. Response always {ok, kind, ...scores, latencyMs, model?} .
1. kind:"metrics" — payload {expected: string, actual: string}
   → {exactNorm: bool, tokenF1: 0..1, embedSim: 0..1}  (MiniLM in-process, quantized — same
   model conxto uses; normalization: lowercase, collapse whitespace, strip punctuation for exactNorm)
2. kind:"judge" — payload {rubric: string, input: string, output: string, context?: string}
   → {score: 0..100, verdict: "pass"|"fail"|"borderline", reasoning: string≤600, model, calibration}
   Judge model: EVALHUB_JUDGE_MODEL (default deepseek-chat) via OpenAI-compat HTTP with
   EVALHUB_DEEPSEEK_KEY. Deterministic-ish: temperature 0. On provider failure → 502, NEVER a
   fabricated score.
3. kind:"hallucination" — payload {output: string, sources: string[]}
   → {claims: [{text, supported: bool, bestSource: int|null, evidence: string|null}],
      hallucinationRate: 0..1, claimCount}
   Claim extraction via the judge model (structured JSON out); support check is DETERMINISTIC:
   a claim is supported iff (lexical containment of its key facts OR embedSim(claim, best
   source window) >= 0.80). Provider failure → 502.
4. kind:"grounding" — payload {citations: [{sourceId, quote}], sources: {id: text}}
   → {valid: [{sourceId, quote, found: bool, similarity}], groundingRate: 0..1}
   DETERMINISTIC, no LLM: found iff exact substring OR normalized fuzzy window sim >= 0.85.

## Labels & calibration
- Table labels(id uuid, target, suite, case_id, human jsonb {verdict, score?, note?}, labeler,
  created_at). Table calibrations(id uuid, target, judge_model, kappa numeric, n int, agreement
  numeric, details jsonb, created_at).
- POST /api/labels {target, suite, labels:[{caseId, verdict:"pass"|"fail", score?, note?}], labeler}
  → {ok, inserted} (upsert on target+suite+case_id+labeler).
- POST /api/calibration/compute {target, suite?, judgeModel} → runs judge over every LABELED case's
  stored latest result output? NO — v1: expects the product to have pushed judge verdicts in
  results.scores.judgeVerdict for those cases; computes Cohen's kappa human-vs-judge over the
  intersection, stores a calibrations row, returns {ok, kappa, n, agreement}. n<20 → refuse
  (400 insufficient_labels): a kappa on 5 cases is theatre.
- GET /api/calibration/:target → latest calibration per judge model + label counts.

## Conxto Phase 2 suites (LLM surfaces — nightly, not deploy-gated)
- eval/golden/llm/tailoring_integrity.jsonl — fixture triples {resume, jd, tailoredOutput} with
  KNOWN planted fabrications (and clean controls); expected {hallucinationRateMax / mustFlag:
  [claim substrings]} — scored via /api/score hallucination. ≥25 cases, ≥8 with plants.
- eval/golden/llm/grounding.jsonl — {answer, citations, sources} valid/invalid mixes, ≥15 cases.
- scripts/eval/run-llm.mts — same push flow as run-golden but suites tailoring_integrity +
  grounding; pass/fail per case from expected vs hub scores; supports --dry (skip hub baselines,
  print only). Runs nightly via conxto-evals.timer (03:30 CET) + on demand.
- Calibration batch: eval/calibration/batch-001.jsonl (50 sampled cases: 25 tailoring outputs,
  25 agent answers, each with the full context a human needs) + eval/calibration/labeler.html —
  a single-file local labeler (no network: loads the batch via file input, founder clicks
  pass/fail/note per case, exports labels JSONL for POST /api/labels).

## Env (hub): EVALHUB_DEEPSEEK_KEY, EVALHUB_JUDGE_MODEL=deepseek-chat, EVALHUB_JUDGE_URL
(default https://api.deepseek.com/chat/completions). Embeddings need @xenova/transformers (runtime
dep; model cached under /opt/evalhub/.cache).
