# Eval Hub — Phase 3 addendum (latency · alerting · dashboards · human review)
Extends V0 + V0.1. Same auth/JSON/write laws. Items 11-14 of the founder's scope.

## Latency percentiles (item 12)
GET /api/stats/:target?days=7 → per suite over finished runs in window:
{suites:[{suite, runs, latestScore, baseline, p50Ms, p95Ms, p99Ms, casesPerRun, lastRunAt}]}
Percentiles computed over results.latency_ms of the LATEST run per suite (per-case latency),
plus runDurationMs percentiles over the window's runs (finished_at - started_at). Pure math in
src/verdict.ts or a new src/stats.ts, unit-tested (known arrays → known percentiles, empty edge).

## Alerting (item 14)
- Table alerts(id, target, suite, kind, message, details jsonb, created_at, delivered bool,
  delivered_at, ack bool). Kinds: 'regression' (finished run scored below baseline - pct),
  'missing_run' (a suite with a baseline has no finished run in staleness window),
  'hub_error' (reserved).
- Alert EVALUATION runs inside the hub on an interval (EVALHUB_ALERT_INTERVAL_S default 300):
  scans latest finished runs vs baselines + staleness (EVALHUB_STALE_HOURS default 26 — nightly
  suites must appear daily). Dedup: never two undelivered alerts with same (target,suite,kind).
- DELIVERY: Telegram via EVALHUB_TG_TOKEN + EVALHUB_TG_CHAT (plain fetch to api.telegram.org).
  Missing env → alerts still RECORDED, delivery skipped with ONE loud boot log (never per-scan
  spam). Delivery marks delivered_at; failures retry next scan (delivered stays false).
- GET /api/alerts?undelivered=1&limit=50; POST /api/alerts/:id/ack.
- The scan loop must never crash the server: errors logged, next tick continues.

## Dashboard (item 13)
- GET /api/dashboard/:target → JSON: suites table (score, baseline, delta, trend: last 14 finished
  run scores per suite ASC by time), alerts (last 10), calibration status, label counts.
- GET /dashboard/:target?token=X → self-contained HTML (no CDN, inline CSS/JS, dark, terminal
  aesthetic per the estate's data products: no blue). Token via QUERY PARAM accepted for this
  route ONLY (browsers can't set headers; hub binds 127.0.0.1 so exposure = SSH tunnel; document
  `ssh -L 4290:127.0.0.1:4290 root@169...` in README). Renders the JSON client-side: per-suite
  sparkline trend (inline SVG), score vs baseline, alert list, calibration state. NO external
  requests of any kind.

## Human review queue (item 11)
- Table review_queue(id, target, suite, case_id, reason, payload jsonb, enqueued_at, state
  'open'|'labeled'|'skipped', labeled_at). Reasons: 'judge_borderline', 'judge_disagreement',
  'low_confidence', 'manual'.
- POST /api/review/enqueue {target, suite, items:[{caseId, reason, payload}]} → dedup on
  (target,suite,case_id,state='open').
- GET /api/review/next?target=&limit=10 → oldest open items.
- POST /api/review/:id/resolve {verdict:'pass'|'fail'|'skip', note?, labeler} — pass/fail writes
  a labels row (same table as calibration — human labels are human labels) and state='labeled';
  skip → state='skipped'.
- Conxto side: run-llm.mts enqueues every case whose judge verdict was 'borderline' AND every
  hallucination case where the checker and expected disagree... NO — cases with expected are
  auto-scored. Enqueue: judge verdict 'borderline' (advisory judge run already happens for
  calibration) with the full case payload. Cap 20 enqueues per run (no silent cap — print it).

## Env (hub): EVALHUB_TG_TOKEN, EVALHUB_TG_CHAT, EVALHUB_ALERT_INTERVAL_S=300,
EVALHUB_STALE_HOURS=26. deploy/evalhub.service gains the two non-secret Environment defaults.
