# Eval Hub — Contract v0 (authored by the orchestrator; both builders implement AGAINST this)

## Purpose
Estate-wide LLM/agent quality platform. One central service owns golden suites, runs, baselines,
regression verdicts. Products integrate via PUSH (run their own suites, post results) or later
PULL. One gate CLI blocks any product's deploy on regression.

## Placement
- Repo: this repository  (new; plain TypeScript + Node 22 + tsx, Fastify 5, postgres via `postgres` driver — same idioms as conxto)
- Runtime: products VPS the products server, 127.0.0.1:4290, systemd unit `evalhub.service`, own Postgres DB `evalhub` with own role. NEVER 185.
- Golden suites live as versioned JSONL files in the OWNING PRODUCT's repo (product-owned data), runs/results/baselines live in the hub DB (hub-owned truth).

## DB schema (hub)
- targets(name text pk, kind text 'product'|'model', created_at)
- runs(id uuid pk, target text fk, suite text, git_sha text, mode text 'push', started_at, finished_at, total int, passed int, score numeric, meta jsonb)
- results(id uuid pk, run_id fk, case_id text, pass bool, score numeric, scores jsonb, output jsonb, latency_ms int, tags text[])
- baselines(target text, suite text, run_id uuid fk, score numeric, promoted_at, PRIMARY KEY(target, suite))
- Aggregate score of a run = passed/total*100 rounded 2dp unless meta.scoring says otherwise.

## HTTP API (all under /api, auth header `x-evalhub-token` checked with timingSafeEqual; 401 JSON on failure)
- POST /api/targets {name, kind} → upsert. 
- POST /api/runs {target, suite, gitSha} → {runId}
- POST /api/runs/:id/results {results:[{caseId, pass, score?, scores?, output?, latencyMs?, tags?}]} → {ok, received} (batched, ≤500/batch)
- POST /api/runs/:id/finish {} → verdict: {ok, runId, suite, score, total, passed, baseline: {score, runId}|null, delta, regression: bool, failures:[caseId...max 20]}
  - regression rule v0: baseline exists AND (score < baseline.score - EVALHUB_REGRESSION_PCT[default 1.0]) → regression true. Missing baseline → regression false (first run passes; promotion creates the bar).
- POST /api/baselines/promote {target, suite, runId} → sets baseline (only if run finished & score >= current baseline or FORCE flag in body {force:true}).
- GET /api/gate/:target?sha=<gitSha> → {ok, sha, suites:[{suite, score, baseline, regression}], verdict:'pass'|'fail'|'no_runs'} — verdict fail if ANY finished run for that sha has regression; no_runs if no finished runs for that sha.
- GET /api/health → {ok, db:'up'}
- Failed writes NEVER return 200 {ok:true} — count and 502 (the conxto ingest law).

## Gate CLI (in hub repo, bin/evalhub-gate.mts)
`evalhub-gate <target> --sha <gitSha> [--promote]`
- Queries GET /api/gate; exit 0 on 'pass', exit 1 on 'fail' (print regressed suites + failures), exit 2 on 'no_runs' (a deploy without evals must FAIL LOUDLY, not slip).
- --promote: after a successful deploy, promotes every finished suite run of this sha to baseline.
- Reads EVALHUB_URL (default http://127.0.0.1:4290) + EVALHUB_TOKEN from env.

## Conxto onboarding (push mode, deterministic surfaces first — LLM-judge is Phase 2)
- Golden data: conxto repo `eval/golden/*.jsonl`, one JSON object per line: {id, surface, input, expected, tags[]}
- Surfaces v0 (all deterministic, ≥100 cases total): role_family (classifier), geo (geoFromText), ats_score (scoreResume invariants incl. no-JD/stub-JD laws), apply_resolver (slug/title/aggregator judgments), liveness (statusFromAge buckets).
- Runner: conxto `scripts/eval/run-golden.mts` — loads JSONL, executes the real engine functions, scores pass/fail deterministically, posts run→results→finish to the hub, prints the verdict, exits nonzero on regression. Runs ON THE BOX during deploy (hub is localhost there) and locally against a local hub if EVALHUB_URL set; if EVALHUB_URL unset → runs suites, prints, exits by pass/fail WITHOUT posting (offline mode) so local dev never breaks.
- deploy.sh ship gains, after npm test, gated by env EVALHUB_ENABLED=1 on the box: run-golden (posts) then evalhub-gate conxto --sha $SHA; after successful restart+health: evalhub-gate conxto --sha $SHA --promote.

## Laws (inherited from the estate, non-negotiable)
- Every response is JSON; a batch that wrote nothing must not say ok:true.
- No silent caps: truncation/sampling must be printed.
- Tests must be able to fail: negative controls in the test suites (a wrong expected MUST fail).
- Timestamps from the DB, not Date.now() where determinism matters.
- The service is additive-only on its own schema via ensure-schema at boot (conxto pattern).
