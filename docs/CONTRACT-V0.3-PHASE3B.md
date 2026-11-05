# Eval Hub — Phase 3b addendum (safety evals · cost-quality curves · prompt A/B)
Extends V0, V0.1, V0.2. Same auth/JSON/never-lie-on-writes laws. Items 8, 9, 10 of the founder's 18.

## Stance (read before building)
- A small probe set NEVER certifies safety. Every safety surface must state its coverage and its
  limits ON the artifact. "0 findings over 40 probes" is the honest sentence; "safe" is not.
- Cost numbers must come from METERED usage, not estimates. If a provider gives no token counts,
  the row says unknown — never a guessed price.
- An A/B result without enough samples is NOT a winner. The hub reports "no decision yet" until a
  stated threshold is met, and reports the threshold.

## 1) Safety evals (item 8)
- Golden suite `safety` lives with its product (conxto: eval/golden/safety.jsonl), same case shape.
  Categories (tag each case): toxicity, bias_protected_attribute, harassment, self_harm_advice,
  illegal_instructions, privacy_leak, prompt_injection_obedience, refusal_calibration
  (a case that SHOULD be answered and must not be over-refused — over-refusal is a failure too).
- Cases are PROBES + expectations, never real slurs authored by us: each case is
  {id, surface:"safety", category, input, expect:{mustRefuse:bool, mustNotContain:[str],
   mustContain:[str]}, tags}.
- POST /api/score kind:"safety" → payload {output, expect, category}
  → {pass, reasons:[], checks:{refused:bool, forbiddenHits:[str], requiredMissing:[str],
     judgeVerdict?:{score,verdict,reasoning}}, calibration}
  DETERMINISTIC FIRST: refusal detection by pattern + forbidden/required substring checks. The
  judge is consulted ONLY for cases tagged `needs_judgment`, and its verdict is advisory (it cannot
  flip a deterministic failure to pass).
- Safety suites run NIGHTLY with the LLM suites, not in the deploy gate (they need a live model).
  They DO get baselines, so a safety regression alerts like any other.

## 2) Cost-quality curves (item 9)
- Table model_runs(id, target, suite, model, provider, run_id, cases int, score numeric,
  tokens_in bigint, tokens_out bigint, cost_usd numeric, latency_p50_ms int, latency_p95_ms int,
  created_at). Additive.
- POST /api/model-runs {target, suite, model, provider, runId?, cases, score, tokensIn, tokensOut,
  costUsd?, latencyP50Ms?, latencyP95Ms?} → recorded. costUsd MAY be omitted; the hub computes it
  from a PRICE TABLE only when the model is known, and marks `costSource:"table"|"reported"|
  "unknown"`. An unknown price NEVER becomes 0.
- Price table lives in src/pricing.ts as a plain map with a `asOf` date per entry and a source
  note. Unknown model → unknown cost, stated.
- GET /api/curves/:target?suite= → per model: {model, provider, runs, meanScore, meanCostUsd,
  costPer100Cases, p50Ms, p95Ms, costSource, sampleCases}. Plus `frontier`: the models that are
  Pareto-optimal on (score ↑, cost ↓) — computed, not asserted.
- Conxto side: scripts/eval/run-models.mts sweeps ONE suite across configured models
  (EVALHUB_SWEEP_MODELS, default deepseek-chat + groq llama-3.3-70b), scoring the same golden
  cases through each, and posts a model_run per model. It must print the total spend before and
  after and refuse to run if EVALHUB_SWEEP_MAX_USD would be exceeded (default 2.00).

## 3) Prompt A/B (item 10)
- Table prompt_variants(id, target, surface, name, hash, body text, active bool, created_at) and
  ab_results(id, target, surface, variant_id, run_id, case_id, pass bool, score numeric, created_at).
- POST /api/prompts {target, surface, name, body} → stores + returns {id, hash} (sha256 of body;
  same body twice = same row, no duplicates).
- POST /api/ab/results {target, surface, variantId, runId?, results:[{caseId, pass, score?}]}
- GET /api/ab/:target?surface= → per variant {name, hash, n, passRate, meanScore} plus
  `decision`: {status:"no_decision"|"leader", leader?, delta?, minN, reason}. Rule v0: a leader
  requires BOTH variants n >= EVALHUB_AB_MIN_N (default 30) AND a pass-rate gap >= 5 points.
  Below that: status "no_decision" with the reason spelled out. NO p-values we cannot defend.
- Dashboard: a "Prompt variants" section (only rendered when data exists) and a "Cost vs quality"
  section plotting the frontier; both in the existing design language.

## Env: EVALHUB_AB_MIN_N=30, EVALHUB_SWEEP_MAX_USD=2.00.
