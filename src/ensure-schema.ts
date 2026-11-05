// Idempotent, code-side schema for the hub (conxto ensure-schema pattern: the box can't easily run
// a migration tool, so every boot runs CREATE ... IF NOT EXISTS). ADDITIVE ONLY — nothing here may
// ever drop or rewrite a column; a new column is a new `ADD COLUMN IF NOT EXISTS` line.
import type { Sql } from "./db.js";

export async function ensureSchema(sql: Sql): Promise<void> {
  // gen_random_uuid() lives in pgcrypto on PG12; PG13+ has it in core. Try, ignore if not permitted.
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
  } catch {
    /* core gen_random_uuid() (PG13+) is enough; a non-superuser role can't create extensions */
  }

  await sql`
    CREATE TABLE IF NOT EXISTS targets (
      name       text PRIMARY KEY,
      kind       text NOT NULL DEFAULT 'product',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;

  // ADDITIVE (2026-08-08, estate-wide onboarding): a target's GATING POSTURE.
  //
  // The hub cannot see a deploy script, so `gating` is a DECLARATION, not a measurement — and it is
  // named that way everywhere it is rendered. The default is 'advisory' on purpose: a product that
  // has just been onboarded gates nothing until somebody deliberately wires `bin/evalhub-gate.mts`
  // into its ship path and says so here. A silent default of 'gate' would let this platform claim a
  // blocking gate that does not exist — exactly the class of claim this repo exists to kill.
  await sql`ALTER TABLE targets ADD COLUMN IF NOT EXISTS gating text NOT NULL DEFAULT 'advisory'`;
  await sql`ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_gating_chk`;
  await sql`ALTER TABLE targets ADD CONSTRAINT targets_gating_chk CHECK (gating IN ('gate','advisory'))`;
  // …and the MEASUREMENT that can falsify the declaration: every answered GET /api/gate/:target is
  // recorded here. A target declaring 'gate' with zero gate checks is a claim with no evidence, and
  // the dashboard and the public page both print the count next to the declaration so it shows.
  await sql`
    CREATE TABLE IF NOT EXISTS gate_checks (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target     text NOT NULL,
      sha        text,
      verdict    text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS gate_checks_target_idx ON gate_checks (target, created_at DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS runs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target      text NOT NULL REFERENCES targets(name) ON DELETE CASCADE,
      suite       text NOT NULL,
      git_sha     text NOT NULL,
      mode        text NOT NULL DEFAULT 'push',
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      total       integer,
      passed      integer,
      score       numeric(6,2),
      meta        jsonb NOT NULL DEFAULT '{}'::jsonb
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS results (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id     uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      case_id    text NOT NULL,
      pass       boolean NOT NULL,
      score      numeric,
      scores     jsonb,
      output     jsonb,
      latency_ms integer,
      tags       text[],
      created_at timestamptz NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS baselines (
      target      text NOT NULL REFERENCES targets(name) ON DELETE CASCADE,
      suite       text NOT NULL,
      run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      score       numeric(6,2) NOT NULL,
      promoted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (target, suite)
    )`;

  // ── Phase 2 (addendum §"Labels & calibration") — ADDITIVE, nothing above is touched ──────────
  // Human labels. NO foreign key to targets on purpose: a founder may label a batch before the
  // product has ever registered itself, and losing labels to a cascade would destroy the only
  // hand-made data in the system. Cleanup is therefore explicit, never implicit.
  await sql`
    CREATE TABLE IF NOT EXISTS labels (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target     text NOT NULL,
      suite      text NOT NULL,
      case_id    text NOT NULL,
      human      jsonb NOT NULL,
      labeler    text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
  // The upsert key from the addendum: one label per (target, suite, case, labeler). Two labelers
  // on the same case is legitimate disagreement and both rows survive.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS labels_upsert_idx ON labels (target, suite, case_id, labeler)`;
  await sql`CREATE INDEX IF NOT EXISTS labels_target_suite_idx ON labels (target, suite)`;

  await sql`
    CREATE TABLE IF NOT EXISTS calibrations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target      text NOT NULL,
      judge_model text NOT NULL,
      kappa       numeric NOT NULL,
      n           integer NOT NULL,
      agreement   numeric NOT NULL,
      details     jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`;
  // "latest calibration per judge model" is the only read shape (GET /api/calibration/:target).
  await sql`CREATE INDEX IF NOT EXISTS calibrations_target_model_idx ON calibrations (target, judge_model, created_at DESC)`;

  // ── Phase 3 (addendum §"Alerting" / §"Human review queue") — ADDITIVE, nothing above is touched ──
  // Alerts. No FK to targets for the same reason labels has none: an alert about a product is
  // evidence, and evidence must survive the cleanup of the thing it is about.
  await sql`
    CREATE TABLE IF NOT EXISTS alerts (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target       text NOT NULL,
      suite        text NOT NULL,
      kind         text NOT NULL,
      message      text NOT NULL,
      details      jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at   timestamptz NOT NULL DEFAULT now(),
      delivered    boolean NOT NULL DEFAULT false,
      delivered_at timestamptz,
      ack          boolean NOT NULL DEFAULT false,
      ack_at       timestamptz
    )`;
  // THE DEDUP RULE, as a constraint rather than as a read-then-write in application code.
  // The addendum's floor is "never two UNDELIVERED alerts with the same (target, suite, kind)".
  // The predicate below is DELIBERATELY WIDER: `delivered = false OR ack = false`. The floor alone
  // would re-fire an unfixed regression every EVALHUB_ALERT_INTERVAL_S forever — the first delivery
  // clears the block, the next scan finds the same still-broken suite, and the phone buzzes every
  // five minutes until the reader mutes the channel. With this predicate an alert keeps deduping
  // until a human ACKs it: ack means "seen — tell me again only if it happens again". The floor is
  // still satisfied (two undelivered rows with one key can never coexist).
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS alerts_undelivered_dedup_idx
            ON alerts (target, suite, kind) WHERE (delivered = false OR ack = false)`;
  await sql`CREATE INDEX IF NOT EXISTS alerts_pending_idx ON alerts (created_at DESC) WHERE delivered = false`;
  await sql`CREATE INDEX IF NOT EXISTS alerts_target_created_idx ON alerts (target, created_at DESC)`;

  // Human review queue.
  await sql`
    CREATE TABLE IF NOT EXISTS review_queue (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target      text NOT NULL,
      suite       text NOT NULL,
      case_id     text NOT NULL,
      reason      text NOT NULL,
      payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      state       text NOT NULL DEFAULT 'open',
      labeled_at  timestamptz
    )`;
  // Dedup on (target, suite, case_id) among OPEN items only: re-enqueueing a case that is already
  // waiting is a no-op, while a case that was labelled and later goes borderline again may return.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS review_queue_open_dedup_idx
            ON review_queue (target, suite, case_id) WHERE state = 'open'`;
  await sql`CREATE INDEX IF NOT EXISTS review_queue_next_idx ON review_queue (target, enqueued_at ASC) WHERE state = 'open'`;

  // ── Phase 3b (addendum §2 cost curves / §3 prompt A/B) — ADDITIVE, nothing above is touched ──
  // One row per (model, suite) sweep run. No FK to runs: a sweep may be executed entirely outside
  // the runs/baselines flow (a bare model comparison is not a product deploy), and run_id is kept
  // as free text so a sweep that DID create a hub run can still be traced back to it.
  await sql`
    CREATE TABLE IF NOT EXISTS model_runs (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target         text NOT NULL,
      suite          text NOT NULL,
      model          text NOT NULL,
      provider       text,
      run_id         text,
      cases          integer NOT NULL,
      score          numeric(6,2) NOT NULL,
      tokens_in      bigint,
      tokens_out     bigint,
      cost_usd       numeric(12,6),
      -- 'table' | 'reported' | 'unknown'. NOT NULL and never defaulted to a price: an unknown cost
      -- must be readable AS unknown, and a NULL cost_usd with cost_source 'unknown' says exactly
      -- that. A 0 here would make an unpriced model the cheapest point on the frontier.
      cost_source    text NOT NULL DEFAULT 'unknown',
      latency_p50_ms integer,
      latency_p95_ms integer,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS model_runs_target_suite_idx ON model_runs (target, suite, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS model_runs_model_idx ON model_runs (target, model)`;

  // Prompt variants. The hash IS the identity: the same body posted twice is the same row, so a
  // runner that re-posts its prompt every night does not fill the table with clones.
  await sql`
    CREATE TABLE IF NOT EXISTS prompt_variants (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target     text NOT NULL,
      surface    text NOT NULL,
      name       text NOT NULL,
      hash       text NOT NULL,
      body       text NOT NULL,
      active     boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS prompt_variants_hash_idx ON prompt_variants (target, surface, hash)`;
  await sql`CREATE INDEX IF NOT EXISTS prompt_variants_target_idx ON prompt_variants (target, surface)`;

  await sql`
    CREATE TABLE IF NOT EXISTS ab_results (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target     text NOT NULL,
      surface    text NOT NULL,
      variant_id uuid NOT NULL REFERENCES prompt_variants(id) ON DELETE CASCADE,
      run_id     text,
      case_id    text NOT NULL,
      pass       boolean NOT NULL,
      score      numeric,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  // The tally read shape: every result of one variant.
  await sql`CREATE INDEX IF NOT EXISTS ab_results_variant_idx ON ab_results (variant_id)`;
  await sql`CREATE INDEX IF NOT EXISTS ab_results_target_surface_idx ON ab_results (target, surface)`;

  // ── Phase 4 (addendum §15 shadow replay / §16 canary) — ADDITIVE, nothing above is touched ───
  // SHADOW = REPLAY (addendum "Honest scoping FIRST"): golden cases re-run against a candidate
  // build on a second port and diffed against the baseline build's outputs. Nothing is served to a
  // user. No FK to targets: a replay is evidence and must survive the cleanup of its subject, the
  // same reason labels/alerts have none.
  await sql`
    CREATE TABLE IF NOT EXISTS shadow_runs (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target                text NOT NULL,
      candidate_sha         text NOT NULL,
      baseline_sha          text,
      sampled               integer NOT NULL DEFAULT 0,
      compared              integer NOT NULL DEFAULT 0,
      diffs                 integer NOT NULL DEFAULT 0,
      -- Pairs that arrived but could NOT be scored (the embedder was unavailable and the outputs
      -- were not identical). Counted separately and never folded into compared: a pair we could
      -- not compare is not a pair that agreed.
      unscored              integer NOT NULL DEFAULT 0,
      mean_score_candidate  numeric,
      mean_score_baseline   numeric,
      spend_usd             numeric(12,6),
      -- The similarity threshold IN FORCE for this run, frozen at creation. Reading it back from
      -- the env at report time would re-interpret an old run under today's rule.
      sim_threshold         numeric NOT NULL DEFAULT 0.90,
      started_at            timestamptz NOT NULL DEFAULT now(),
      finished_at           timestamptz,
      recommendation        text,
      reason                text,
      notes                 jsonb NOT NULL DEFAULT '{}'::jsonb
    )`;
  await sql`CREATE INDEX IF NOT EXISTS shadow_runs_target_idx ON shadow_runs (target, started_at DESC)`;

  // One row per compared pair. The contract only names shadow_runs, but the counters there must be
  // RECOMPUTABLE: a finish that trusts incrementally-updated integers can never be audited, and a
  // diff nobody can point at is an assertion. sim is NULL exactly when the pair was unscored.
  await sql`
    CREATE TABLE IF NOT EXISTS shadow_pairs (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id         uuid NOT NULL REFERENCES shadow_runs(id) ON DELETE CASCADE,
      case_id        text NOT NULL,
      sim            numeric,
      sim_source     text NOT NULL,
      exact          boolean NOT NULL,
      diff           boolean,
      score_baseline numeric,
      score_candidate numeric,
      note           text,
      created_at     timestamptz NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS shadow_pairs_run_idx ON shadow_pairs (run_id)`;

  // CANARY = BLUE/GREEN + COHORT (addendum): two systemd units, a cookie-pinned share on green,
  // and an automatic flip back on breach. The hub records the transitions the watcher POSTS; it
  // does not witness the traffic, and this table never pretends otherwise.
  await sql`
    CREATE TABLE IF NOT EXISTS canary_events (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      target     text NOT NULL,
      sha        text NOT NULL,
      phase      text NOT NULL,
      pct        integer,
      reason     text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
  // The vocabulary is closed AT THE DATABASE too, not only in the zod schema: a phase nobody can
  // interpret later must not be storable by any path, including psql.
  await sql`ALTER TABLE canary_events DROP CONSTRAINT IF EXISTS canary_events_phase_chk`;
  await sql`ALTER TABLE canary_events ADD CONSTRAINT canary_events_phase_chk
            CHECK (phase IN ('start','promote','rollback'))`;
  await sql`CREATE INDEX IF NOT EXISTS canary_events_target_idx ON canary_events (target, created_at DESC)`;

  // The stats/dashboard read shape: per-case latency of one run, and the trend of finished runs.
  await sql`CREATE INDEX IF NOT EXISTS results_run_latency_idx ON results (run_id) WHERE latency_ms IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS runs_target_finished_idx ON runs (target, finished_at DESC) WHERE finished_at IS NOT NULL`;

  // The gate's only query shape: finished runs for a (target, sha). Without this the gate is a
  // sequential scan on every deploy, forever.
  await sql`CREATE INDEX IF NOT EXISTS runs_target_sha_idx ON runs (target, git_sha)`;
  await sql`CREATE INDEX IF NOT EXISTS runs_target_suite_finished_idx ON runs (target, suite, finished_at DESC)`;
  // Finish aggregates + the failures list both fan out from one run_id.
  await sql`CREATE INDEX IF NOT EXISTS results_run_idx ON results (run_id)`;
  await sql`CREATE INDEX IF NOT EXISTS results_run_fail_idx ON results (run_id) WHERE pass = false`;
  // Calibration walks results BY CASE across runs ("the latest judge verdict for this case").
  await sql`CREATE INDEX IF NOT EXISTS results_case_created_idx ON results (case_id, created_at DESC)`;
}
