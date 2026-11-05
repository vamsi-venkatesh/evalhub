# Eval Hub

A quality service for LLM features and agents. It stores evaluation runs and results, keeps a baseline per suite, decides whether a new run is a regression, and blocks a product's deploy when it is. I run it for my own products; the public results page is [vvdexops.com/evals](https://vvdexops.com/evals).

Plain TypeScript on Node, PostgreSQL, no framework.

## What it does

- **Runs, baselines, verdicts.** A product posts a run (target, suite, git SHA) and its case results. Finishing the run computes the score from the stored rows, compares it with the promoted baseline and returns `regression: true/false` with the failing cases.
- **Deploy gate.** `bin/evalhub-gate.mts` asks the hub for the latest verdict for a commit and exits non-zero on a regression, so CI stops the deploy.
- **Scorers.** `metrics` (normalised exact match, token F1, embedding similarity), `judge` (an LLM judge with a fallback rotation across providers), `hallucination` (the LLM lists claims, then support is checked deterministically) and `grounding` (no LLM).
- **Judge calibration.** Human labels are compared with the judge's verdicts using Cohen's kappa. The hub refuses to report a kappa below 20 labelled pairs.
- **Human review.** A labelling screen shows one case per page with keyboard shortcuts (`a` pass, `d` fail, `s` skip). A decision writes a label through the same code path as the labels API.
- **Statistics and alerts.** p50/p95/p99 latency per suite (nearest-rank, no interpolation), learning curves, A/B and shadow comparisons, canary checks and alerts that fire again only if a problem comes back.

## Layout

```
src/
  server.ts          the HTTP surface (one route table, token-checked, JSON only)
  verdict.ts         score vs baseline → regression verdict
  scorers/           metrics, judge, hallucination, grounding, safety
  kappa.ts, labels.ts, review.ts, review-html.ts   calibration and the review queue
  stats.ts, curves.ts, ab.ts, shadow.ts, canary.ts, alerts.ts
  dashboard-html.ts  a self-contained HTML dashboard built from the same JSON
bin/evalhub-gate.mts the deploy gate
scripts/test-*.mts   one test suite per phase and per scorer
docs/                the contracts each phase was built against (v0 to v0.4)
```

About 7,700 lines of service code and 3,800 lines of tests (15 suites).

## Run it

```bash
npm install
EVALHUB_DATABASE_URL=postgres://… EVALHUB_TOKEN=… npm start
npm test          # all 15 suites
npm run gate      # the deploy gate
```

## Design choices

- **Scores come from stored rows, never from the client's summary.** A run's verdict is recomputed from the results in the database, so a buggy client cannot report a pass.
- **The bar only moves up on purpose.** Promoting a lower baseline needs an explicit `force`.
- **Deterministic where possible.** The LLM is used only where judgement is needed; claim support, grounding and the statistics are plain code with tests.

## Status

Running on my products server. This is the public copy of the source; deployment files and the commit history stay private.
