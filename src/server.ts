// Eval Hub HTTP service — contract v0.
// Every endpoint answers JSON. Auth is a single shared token compared with timingSafeEqual.
// THE WRITE LAW (inherited from conxto's ingest-batch, 2026-08-04): a batch that wrote nothing —
// or wrote less than it received — must NEVER answer 200 {ok:true}. It counts what landed and
// answers 502 so the caller's retry treats it as transient instead of counting it as delivered.
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { db, type Sql } from "./db.js";
import { ensureSchema } from "./ensure-schema.js";
import { cohensKappa, kappaBand, MIN_CALIBRATION_LABELS } from "./kappa.js";
import { scoreGrounding, type Citation } from "./scorers/grounding.js";
import { scoreHallucination } from "./scorers/hallucination.js";
import {
  calibrationFor,
  isJudgeProviderError,
  judgeConfigFromEnv,
  makeJudgeClaimExtractor,
  runJudge,
  type JudgeConfig,
} from "./scorers/judge.js";
import { exactNorm, embedSim, miniLmEmbed, tokenF1, type EmbedFn } from "./scorers/metrics.js";
import { scoreSafety, type SafetyPayload } from "./scorers/safety.js";
import { abMinNFromEnv, abReportFor, abReportsBySurface } from "./ab.js";
import { modelCurvesFor, resolveRunCost } from "./curves.js";
import { writeLabels } from "./labels.js";
import { alertIntervalSFromEnv, staleHoursFromEnv, startAlertScanner } from "./alerts.js";
import { renderDashboardHtml, DASHBOARD_APP_JS } from "./dashboard-html.js";
import { renderReviewHtml, REVIEW_APP_JS, type ReviewItem, type ReviewScreenData } from "./review-html.js";
import { sendLoginCode, isSixDigitCode } from "./mail.js";
import { kappaSnapshot, liveKappaFrom, resolveReviewItem, type ReviewCard } from "./review.js";
import { clampDays, percentiles, suiteStatsFor, trendsFor, TREND_POINTS } from "./stats.js";
import {
  decidePair,
  shadowSimFromEnv,
  shadowVerdict,
  thresholds as shadowThresholds,
  SHADOW_DEFINITION,
  type ShadowRecommendation,
} from "./shadow.js";
import { canaryPctFromEnv, CANARY_DEFINITION, CANARY_PHASES, summariseCanary, type CanaryEvent, type CanaryPhase } from "./canary.js";
import { buildReport, renderReportMarkdown, type ReportAlert, type ReportInput, type ReportSuite } from "./report.js";
import {
  aggregateRun,
  buildRunVerdict,
  gateVerdict,
  MAX_FAILURES_RETURNED,
  regressionPctFromEnv,
  round2,
  type GateSuite,
  type ScoredResult,
} from "./verdict.js";

export const MAX_RESULTS_PER_BATCH = 500;
const BODY_LIMIT = 8 * 1024 * 1024; // eval outputs are chunky; 1MB (fastify default) truncates real batches
/** Addendum §"POST /api/score (body ≤ 256KB)". Enforced per-route by fastify → 413, never trimmed. */
export const SCORE_BODY_LIMIT = 256 * 1024;

// ── validation ───────────────────────────────────────────────────────────────────────────────
const TargetBody = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["product", "model"]).default("product"),
  // OPTIONAL on purpose, and absent ≠ 'advisory'. An upsert that omits `gating` must LEAVE the
  // stored posture alone: conxto's runner posts {name,kind} on every run, and a defaulted value
  // here would silently demote a real deploy gate to advisory on the next push.
  gating: z.enum(["gate", "advisory"]).optional(),
});

const RunBody = z.object({
  target: z.string().min(1).max(120),
  suite: z.string().min(1).max(120),
  gitSha: z.string().min(1).max(80),
  mode: z.literal("push").default("push"),
  meta: z.record(z.unknown()).optional(),
});

const ResultItem = z.object({
  caseId: z.string().min(1).max(200),
  pass: z.boolean(),
  score: z.number().finite().nullable().optional(),
  scores: z.record(z.unknown()).nullable().optional(),
  output: z.unknown().optional(),
  latencyMs: z.number().finite().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
});
const ResultsBody = z.object({ results: z.array(ResultItem) });

const PromoteBody = z.object({
  target: z.string().min(1),
  suite: z.string().min(1),
  runId: z.string().uuid(),
  force: z.boolean().default(false),
});

// ── Phase 2 validation ───────────────────────────────────────────────────────────────────────
const MetricsPayload = z.object({ expected: z.string(), actual: z.string() });
const JudgePayloadZ = z.object({
  rubric: z.string().min(1),
  input: z.string(),
  output: z.string(),
  context: z.string().optional(),
  // Additive to the addendum: without a target the hub cannot look up WHOSE calibration applies,
  // and an unattributed judge score must not inherit someone else's kappa.
  target: z.string().min(1).max(120).optional(),
});
const HallucinationPayload = z.object({ output: z.string(), sources: z.array(z.string()).max(50) });
const GroundingPayload = z.object({
  citations: z.array(z.object({ sourceId: z.string(), quote: z.string() })).max(200),
  sources: z.record(z.string()),
});
// Phase 3b: safety joins the same kind-dispatched endpoint. `category` is a free string validated
// against the addendum's list INSIDE the scorer (unknownCategory is reported, not rejected) — a
// product inventing a ninth category must not have its probe silently dropped at the door.
const SafetyPayloadZ = z.object({
  output: z.string(),
  expect: z.object({
    mustRefuse: z.boolean().optional(),
    mustNotContain: z.array(z.string()).max(200).optional(),
    mustContain: z.array(z.string()).max(200).optional(),
  }).default({}),
  category: z.string().min(1).max(80),
  tags: z.array(z.string().max(80)).max(50).optional(),
  rubric: z.string().max(4000).optional(),
  input: z.string().max(20000).optional(),
  target: z.string().min(1).max(120).optional(),
});

const ScoreBody = z.object({ kind: z.enum(["metrics", "judge", "hallucination", "grounding", "safety"]), payload: z.unknown() });

// ── Phase 3b validation (addendum §2 model runs / §3 prompt A/B) ─────────────────────────────
const ModelRunBody = z.object({
  target: z.string().min(1).max(120),
  suite: z.string().min(1).max(120),
  model: z.string().min(1).max(160),
  provider: z.string().min(1).max(80).nullable().optional(),
  runId: z.string().min(1).max(120).nullable().optional(),
  cases: z.number().int().min(0),
  score: z.number().finite().min(0).max(100),
  tokensIn: z.number().int().min(0).nullable().optional(),
  tokensOut: z.number().int().min(0).nullable().optional(),
  costUsd: z.number().finite().min(0).nullable().optional(),
  latencyP50Ms: z.number().int().min(0).nullable().optional(),
  latencyP95Ms: z.number().int().min(0).nullable().optional(),
});

const PromptBody = z.object({
  target: z.string().min(1).max(120),
  surface: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  body: z.string().min(1).max(200_000),
  active: z.boolean().default(true),
});

export const MAX_AB_RESULTS_PER_BATCH = 500;
const AbResultsBody = z.object({
  target: z.string().min(1).max(120),
  surface: z.string().min(1).max(120),
  variantId: z.string().uuid(),
  runId: z.string().min(1).max(120).nullable().optional(),
  results: z.array(z.object({
    caseId: z.string().min(1).max(200),
    pass: z.boolean(),
    score: z.number().finite().nullable().optional(),
  })).min(1),
});

// ── Phase 4 validation (addendum §15 shadow replay / §16 canary) ─────────────────────────────
const ShadowRunBody = z.object({
  target: z.string().min(1).max(120),
  candidateSha: z.string().min(1).max(80),
  baselineSha: z.string().min(1).max(80).nullable().optional(),
  /** How many cases the replayer SAMPLED. Declared by the runner so a batch that never arrived is
   *  visible as a gap rather than as agreement. */
  sampled: z.number().int().min(0).default(0),
  notes: z.record(z.unknown()).optional(),
});

/** Embedding is per pair and sequential (the box is memory-capped) — this cap is REFUSED, never trimmed. */
export const MAX_SHADOW_PAIRS_PER_BATCH = 200;
const ShadowPairsBody = z.object({
  pairs: z.array(z.object({
    caseId: z.string().min(1).max(200),
    baselineOutput: z.string().max(200_000),
    candidateOutput: z.string().max(200_000),
    scores: z.object({
      baseline: z.number().finite().nullable().optional(),
      candidate: z.number().finite().nullable().optional(),
    }).optional(),
  })).min(1),
  /** Metered LLM spend for this batch of replays. Omitted → unknown, never 0. */
  spendUsd: z.number().finite().min(0).nullable().optional(),
});

const CanaryEventBody = z.object({
  target: z.string().min(1).max(120),
  sha: z.string().min(1).max(80),
  // Not z.enum: an unknown phase must produce OUR error, naming the vocabulary, not a zod issue
  // list a watcher's log will swallow.
  phase: z.string().min(1).max(40),
  pct: z.number().int().min(0).max(100).nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
});

const LabelsBody = z.object({
  target: z.string().min(1).max(120),
  suite: z.string().min(1).max(120),
  labeler: z.string().min(1).max(120),
  labels: z.array(z.object({
    caseId: z.string().min(1).max(200),
    verdict: z.enum(["pass", "fail"]),
    score: z.number().finite().optional(),
    note: z.string().max(2000).optional(),
  })).min(1).max(1000),
});

const CalibrationBody = z.object({
  target: z.string().min(1).max(120),
  suite: z.string().min(1).max(120).optional(),
  judgeModel: z.string().min(1).max(120),
});

// ── Phase 3 validation ───────────────────────────────────────────────────────────────────────
export const REVIEW_REASONS = ["judge_borderline", "judge_disagreement", "low_confidence", "manual"] as const;
export const MAX_REVIEW_ENQUEUE = 500;

const ReviewEnqueueBody = z.object({
  target: z.string().min(1).max(120),
  suite: z.string().min(1).max(120),
  items: z.array(z.object({
    caseId: z.string().min(1).max(200),
    reason: z.enum(REVIEW_REASONS),
    payload: z.unknown().optional(),
  })).min(1).max(MAX_REVIEW_ENQUEUE),
});

const ReviewResolveBody = z.object({
  verdict: z.enum(["pass", "fail", "skip"]),
  note: z.string().max(2000).optional(),
  labeler: z.string().min(1).max(120),
  score: z.number().finite().optional(),
});

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown, reply: FastifyReply): z.infer<T> | null {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    reply.code(400).send({ error: "bad_request", issues: r.error.issues.slice(0, 10) });
    return null;
  }
  return r.data;
}

/** numeric columns arrive as strings from postgres-js; a verdict must never compare "98.50" to 98.5. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type BuildOpts = {
  sql: Sql;
  token: string;
  regressionPct?: number;
  logger?: boolean;
  /** Phase 2 injection points. Default: env-derived judge config + the real MiniLM embedder. */
  judge?: () => JudgeConfig;
  embed?: EmbedFn;
};

// Sign-in code sending: at most 5 in 10 minutes, process-wide. Deliberately a hard cap rather than
// per-IP — there is exactly one person who signs in here, and a per-IP bucket would just hand an
// attacker a fresh allowance per address.
const SEND_WINDOW_MS = 10 * 60 * 1000;
const SEND_MAX_PER_WINDOW = 5;
let sendCodeHits: number[] = [];

export function buildServer(opts: BuildOpts): FastifyInstance {
  const { sql } = opts;
  const want = opts.token || "";
  const pct = opts.regressionPct ?? regressionPctFromEnv();
  // Read per request, not once at boot: a systemd restart is not required to rotate the key, and
  // the route test can point the hub at a local mock provider by setting env before it builds.
  const judgeCfg = opts.judge ?? (() => judgeConfigFromEnv());
  const embed: EmbedFn = opts.embed ?? miniLmEmbed;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: BODY_LIMIT });

  // Every error is JSON, never an HTML page or a bare string.
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    const code = typeof e.statusCode === "number" && e.statusCode >= 400 ? e.statusCode : 500;
    reply.code(code).send({ ok: false, error: code === 500 ? "internal_error" : e.code ?? "error", detail: e.message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, error: "not_found" }));

  // ── auth: one shared token, constant-time. An empty configured token authorises NOBODY.
  const tokenOk = (got: string): boolean =>
    want.length > 0 && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;
    if (!tokenOk(String((req.headers["x-evalhub-token"] as string) || ""))) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  });

  // ── GET /api/health ────────────────────────────────────────────────────────────────────────
  app.get("/api/health", async (_req, reply) => {
    try {
      await sql`SELECT 1`;
      return { ok: true, db: "up" as const };
    } catch (e) {
      // "db: up" while the pool is dead is exactly the lie this service exists to prevent.
      return reply.code(503).send({ ok: false, db: "down" as const, detail: String((e as Error).message) });
    }
  });

  // ── POST /api/targets ──────────────────────────────────────────────────────────────────────
  app.post("/api/targets", async (req, reply) => {
    const body = parse(TargetBody, req.body, reply);
    if (!body) return;
    // COALESCE(excluded, current): omitting `gating` preserves what is stored; a new row gets the
    // column default 'advisory'. Only an explicit {gating:'gate'} can declare a blocking gate.
    const gating = body.gating ?? null;
    const rows = await sql<{ name: string; kind: string; gating: string; created_at: Date }[]>`
      INSERT INTO targets (name, kind, gating)
      VALUES (${body.name}, ${body.kind}, COALESCE(${gating}::text, 'advisory'))
      ON CONFLICT (name) DO UPDATE
        SET kind = EXCLUDED.kind,
            gating = COALESCE(${gating}::text, targets.gating)
      RETURNING name, kind, gating, created_at`;
    const row = rows[0];
    if (!row) return reply.code(502).send({ ok: false, error: "upsert_wrote_nothing", target: body.name });
    return { ok: true, target: row.name, kind: row.kind, gating: row.gating, createdAt: row.created_at };
  });

  // ── POST /api/runs ─────────────────────────────────────────────────────────────────────────
  app.post("/api/runs", async (req, reply) => {
    const body = parse(RunBody, req.body, reply);
    if (!body) return;
    const t = await sql<{ name: string }[]>`SELECT name FROM targets WHERE name = ${body.target}`;
    if (t.length === 0) {
      // Honest 400 rather than a silent auto-create: a typo'd target that invents itself is how a
      // product ends up gating on an empty history that always passes.
      return reply.code(400).send({ ok: false, error: "unknown_target", target: body.target, hint: "POST /api/targets first" });
    }
    const rows = await sql<{ id: string; started_at: Date }[]>`
      INSERT INTO runs (target, suite, git_sha, mode, meta)
      VALUES (${body.target}, ${body.suite}, ${body.gitSha}, ${body.mode}, ${sql.json((body.meta ?? {}) as never)})
      RETURNING id, started_at`;
    const row = rows[0];
    if (!row) return reply.code(502).send({ ok: false, error: "insert_wrote_nothing" });
    return { ok: true, runId: row.id, startedAt: row.started_at };
  });

  // ── POST /api/runs/:id/results ─────────────────────────────────────────────────────────────
  app.post("/api/runs/:id/results", async (req, reply) => {
    const runId = String((req.params as { id: string }).id || "");
    const body = parse(ResultsBody, req.body, reply);
    if (!body) return;
    if (body.results.length > MAX_RESULTS_PER_BATCH) {
      // No silent truncation: we refuse the oversized batch instead of quietly keeping 500 of it.
      return reply.code(413).send({
        ok: false, error: "batch_too_large", received: body.results.length, max: MAX_RESULTS_PER_BATCH,
      });
    }
    const run = await sql<{ id: string; finished_at: Date | null }[]>`
      SELECT id, finished_at FROM runs WHERE id::text = ${runId}`;
    if (run.length === 0) return reply.code(404).send({ ok: false, error: "run_not_found", runId });
    if (run[0]?.finished_at) return reply.code(409).send({ ok: false, error: "run_already_finished", runId });

    let inserted = 0;
    const errors: { caseId: string; error: string }[] = [];
    // Row-at-a-time (pipelined in chunks) is deliberate: it is the only way to know EXACTLY how
    // many rows landed. A bulk insert that half-fails can only report "the batch failed".
    for (let i = 0; i < body.results.length; i += 50) {
      const chunk = body.results.slice(i, i + 50);
      const settled = await Promise.allSettled(
        chunk.map((r) =>
          sql`INSERT INTO results (run_id, case_id, pass, score, scores, output, latency_ms, tags)
              VALUES (${runId}::uuid, ${r.caseId}, ${r.pass},
                      ${r.score ?? null}, ${r.scores ? sql.json(r.scores as never) : null},
                      ${r.output === undefined ? null : sql.json(r.output as never)},
                      ${r.latencyMs ?? null}, ${(r.tags ?? null) as never})`
        )
      );
      settled.forEach((s, j) => {
        if (s.status === "fulfilled") inserted++;
        else if (errors.length < 5) errors.push({ caseId: chunk[j]?.caseId ?? "?", error: String((s.reason as Error)?.message ?? s.reason) });
      });
    }
    const received = body.results.length;
    const failed = received - inserted;
    if (failed > 0) {
      // THE WRITE LAW. ok reflects what actually LANDED.
      return reply.code(502).send({ ok: false, received, inserted, failed, errors });
    }
    return { ok: true, received, inserted, failed: 0 };
  });

  // ── POST /api/runs/:id/finish ──────────────────────────────────────────────────────────────
  app.post("/api/runs/:id/finish", async (req, reply) => {
    const runId = String((req.params as { id: string }).id || "");
    const runRows = await sql<{ id: string; target: string; suite: string; meta: unknown }[]>`
      SELECT id, target, suite, meta FROM runs WHERE id::text = ${runId}`;
    const run = runRows[0];
    if (!run) return reply.code(404).send({ ok: false, error: "run_not_found", runId });

    const rows = await sql<{ case_id: string; pass: boolean; score: string | null }[]>`
      SELECT case_id, pass, score FROM results WHERE run_id = ${run.id}::uuid ORDER BY case_id`;
    const results: ScoredResult[] = rows.map((r) => ({ caseId: r.case_id, pass: r.pass, score: numOrNull(r.score) }));
    const agg = aggregateRun(results, run.meta);

    // finished_at comes from the DB clock, not Date.now() (estate law: timestamps from the DB).
    const upd = await sql<{ id: string }[]>`
      UPDATE runs SET finished_at = now(), total = ${agg.total}, passed = ${agg.passed}, score = ${agg.score}
      WHERE id = ${run.id}::uuid RETURNING id`;
    if (upd.length === 0) return reply.code(502).send({ ok: false, error: "finish_wrote_nothing", runId });

    const base = await sql<{ score: string; run_id: string }[]>`
      SELECT score, run_id FROM baselines WHERE target = ${run.target} AND suite = ${run.suite}`;
    const b = base[0];

    const verdict = buildRunVerdict({
      runId: run.id,
      suite: run.suite,
      score: agg.score,
      total: agg.total,
      passed: agg.passed,
      baseline: b ? { score: num(b.score), runId: b.run_id } : null,
      failures: results.filter((r) => !r.pass).map((r) => r.caseId),
      pct,
    });
    return { ...verdict, scoring: agg.scoring };
  });

  // ── POST /api/baselines/promote ────────────────────────────────────────────────────────────
  app.post("/api/baselines/promote", async (req, reply) => {
    const body = parse(PromoteBody, req.body, reply);
    if (!body) return;
    const runRows = await sql<{ id: string; target: string; suite: string; score: string | null; finished_at: Date | null }[]>`
      SELECT id, target, suite, score, finished_at FROM runs WHERE id::text = ${body.runId}`;
    const run = runRows[0];
    if (!run) return reply.code(404).send({ ok: false, error: "run_not_found", runId: body.runId });
    if (!run.finished_at) return reply.code(409).send({ ok: false, error: "run_not_finished", runId: body.runId });
    if (run.target !== body.target || run.suite !== body.suite) {
      return reply.code(400).send({
        ok: false, error: "run_target_suite_mismatch",
        run: { target: run.target, suite: run.suite }, asked: { target: body.target, suite: body.suite },
      });
    }
    const score = round2(num(run.score));
    const cur = await sql<{ score: string; run_id: string }[]>`
      SELECT score, run_id FROM baselines WHERE target = ${body.target} AND suite = ${body.suite}`;
    const currentScore = cur[0] ? round2(num(cur[0].score)) : null;
    if (currentScore !== null && score < currentScore && !body.force) {
      // A baseline that ratchets DOWN on every deploy is not a baseline. Refuse, loudly.
      return reply.code(409).send({
        ok: false, error: "below_baseline", score, baseline: currentScore,
        hint: "re-post with {force:true} to deliberately lower the bar",
      });
    }
    const out = await sql<{ target: string }[]>`
      INSERT INTO baselines (target, suite, run_id, score, promoted_at)
      VALUES (${body.target}, ${body.suite}, ${run.id}::uuid, ${score}, now())
      ON CONFLICT (target, suite) DO UPDATE SET run_id = EXCLUDED.run_id, score = EXCLUDED.score, promoted_at = now()
      RETURNING target`;
    if (out.length === 0) return reply.code(502).send({ ok: false, error: "promote_wrote_nothing" });
    return { ok: true, target: body.target, suite: body.suite, runId: run.id, score, previous: currentScore, forced: body.force };
  });

  // ── GET /api/gate/:target?sha=… ────────────────────────────────────────────────────────────
  app.get("/api/gate/:target", async (req, reply) => {
    const target = String((req.params as { target: string }).target || "");
    const sha = String((req.query as { sha?: string }).sha || "");
    if (!sha) return reply.code(400).send({ ok: false, error: "missing_sha", hint: "GET /api/gate/:target?sha=<gitSha>" });

    // Latest FINISHED run per suite for this sha — a re-run of one suite supersedes its predecessor.
    const rows = await sql<{ suite: string; id: string; score: string | null }[]>`
      SELECT DISTINCT ON (suite) suite, id, score
      FROM runs
      WHERE target = ${target} AND git_sha = ${sha} AND finished_at IS NOT NULL
      ORDER BY suite, finished_at DESC`;
    const bases = await sql<{ suite: string; score: string }[]>`
      SELECT suite, score FROM baselines WHERE target = ${target}`;
    const baseBySuite = new Map(bases.map((b) => [b.suite, round2(num(b.score))]));

    const suites: GateSuite[] = rows.map((r) => {
      const score = round2(num(r.score));
      const baseline = baseBySuite.has(r.suite) ? (baseBySuite.get(r.suite) as number) : null;
      return { suite: r.suite, runId: r.id, score, baseline, regression: baselineRegression(score, baseline, pct) };
    });
    // Name the broken cases for the regressed suites only — the gate CLI prints them, and a read
    // path must never mutate a run to get them.
    for (const s of suites) {
      if (!s.regression) continue;
      const f = await sql<{ case_id: string }[]>`
        SELECT case_id FROM results WHERE run_id = ${s.runId}::uuid AND pass = false
        ORDER BY case_id LIMIT ${MAX_FAILURES_RETURNED + 1}`;
      const total = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM results WHERE run_id = ${s.runId}::uuid AND pass = false`;
      s.failures = f.slice(0, MAX_FAILURES_RETURNED).map((r) => r.case_id);
      s.failuresTotal = total[0]?.n ?? s.failures.length;
      s.failuresTruncated = s.failuresTotal > s.failures.length;
    }
    const verdict = gateVerdict(suites);
    // The gate is the only place the hub can OBSERVE that a deploy path really consults it. Record
    // it. This is a read route that writes one audit row on purpose: without it, `targets.gating`
    // would be an unfalsifiable declaration. A failed insert must never turn a gate answer into a
    // 500 — the deploy's verdict is the contract; the audit row is bookkeeping.
    try {
      await sql`INSERT INTO gate_checks (target, sha, verdict) VALUES (${target}, ${sha}, ${verdict})`;
    } catch (e) {
      app.log.error({ err: e, target, sha }, "[evalhub] gate_checks insert failed — the verdict below is still authoritative");
    }
    return { ok: true, target, sha, suites, verdict, regressionPct: pct };
  });

  // ══ PHASE 2 ═══════════════════════════════════════════════════════════════════════════════
  // ── POST /api/score  (kind-dispatched; body ≤ 256KB) ───────────────────────────────────────
  app.post("/api/score", { bodyLimit: SCORE_BODY_LIMIT }, async (req, reply) => {
    const body = parse(ScoreBody, req.body, reply);
    if (!body) return;
    const t0 = Date.now();
    const done = <T extends object>(extra: T) => ({ ok: true as const, kind: body.kind, ...extra, latencyMs: Date.now() - t0 });

    try {
      if (body.kind === "metrics") {
        const p = parse(MetricsPayload, body.payload, reply);
        if (!p) return;
        const warnings: string[] = [];
        let sim: number | null = null;
        try {
          sim = round4(await embedSim(p.expected, p.actual, embed));
        } catch (e) {
          // The model could not load/run. exactNorm and tokenF1 are REAL and are returned; the
          // similarity is null with the reason attached. A fabricated 0.9 here would be worse than
          // no number at all, and a silent 0 would read as "totally unrelated".
          warnings.push(`embedSim unavailable: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
        return done({
          exactNorm: exactNorm(p.expected, p.actual),
          tokenF1: round4(tokenF1(p.expected, p.actual)),
          embedSim: sim,
          ...(warnings.length ? { warnings } : {}),
        });
      }

      if (body.kind === "judge") {
        const p = parse(JudgePayloadZ, body.payload, reply);
        if (!p) return;
        const cfg = judgeCfg();
        const j = await runJudge(cfg, p);
        const calibration = await calibrationFor(sql, p.target, j.model);   // the model that ANSWERED, not the primary: a fallback model has its own (absent) calibration
        return done({ score: j.score, verdict: j.verdict, reasoning: j.reasoning, model: j.model, retried: j.retried, calibration });
      }

      if (body.kind === "hallucination") {
        const p = parse(HallucinationPayload, body.payload, reply);
        if (!p) return;
        const cfg = judgeCfg();
        const s = await scoreHallucination(p, { extractClaims: makeJudgeClaimExtractor(cfg), embed });
        return done({ ...s, model: cfg.model });
      }

      if (body.kind === "grounding") {
        // grounding — deterministic, no provider, no model.
        const p = parse(GroundingPayload, body.payload, reply);
        if (!p) return;
        return done(scoreGrounding(p.citations as Citation[], p.sources));
      }

      // safety — DETERMINISTIC FIRST. The judge is consulted only for cases tagged
      // `needs_judgment` and its verdict is ADVISORY: scoreSafety() copies `pass` from the frozen
      // deterministic result, so no provider answer can turn a failure into a pass. A judge that
      // is unreachable therefore does NOT 502 here (unlike kind:"judge", where it IS the score) —
      // the deterministic verdict is complete on its own and is returned with the note attached.
      {
        const p = parse(SafetyPayloadZ, body.payload, reply);
        if (!p) return;
        const cfg = judgeCfg();
        const s = await scoreSafety(p as SafetyPayload, { judgeConfig: cfg });
        const calibration = await calibrationFor(sql, p.target, cfg.model);
        return done({
          pass: s.pass,
          reasons: s.reasons,
          checks: s.checks,
          calibration: s.calibration,
          category: s.category,
          unknownCategory: s.unknownCategory,
          judge: s.judge,
          // The judge's own calibration status, so "advisory" is not just a word in a comment.
          judgeCalibration: calibration,
        });
      }
    } catch (e) {
      if (isJudgeProviderError(e)) {
        // NEVER a fabricated score (addendum §2/§3). The caller sees the provider's real trouble.
        const code = e.stage === "config" ? 500 : 502;
        return reply.code(code).send({
          ok: false, error: e.message, stage: e.stage, providerStatus: e.status, detail: e.detail, kind: body.kind,
        });
      }
      throw e;
    }
  });

  // ── POST /api/labels ───────────────────────────────────────────────────────────────────────
  app.post("/api/labels", async (req, reply) => {
    const body = parse(LabelsBody, req.body, reply);
    if (!body) return;
    // ONE write path (src/labels.ts) — POST /api/review/:id/resolve calls the same function, so a
    // human label made through the queue is byte-for-byte the same row as one posted here.
    const w = await writeLabels(sql, body);
    if (w.inserted < w.received) {
      // THE WRITE LAW, same as results: what landed is what we report.
      return reply.code(502).send({ ok: false, received: w.received, inserted: w.inserted, failed: w.received - w.inserted, errors: w.errors });
    }
    return { ok: true, received: w.received, inserted: w.inserted, target: body.target, suite: body.suite, labeler: body.labeler };
  });

  // ── POST /api/calibration/compute ──────────────────────────────────────────────────────────
  app.post("/api/calibration/compute", async (req, reply) => {
    const body = parse(CalibrationBody, req.body, reply);
    if (!body) return;

    // ONE definition of a (human, judge) pair — src/review.ts kappaSnapshot(). The labelling screen
    // reads the SAME function live, so the number it shows and the number persisted here can never
    // come from two different ideas of what a pair is.
    const snap = await kappaSnapshot(sql, body.target, body.suite ?? null);
    const { pairs, excluded } = snap;
    const labelRows = { length: snap.labelsConsidered };
    const judgeRows = { length: snap.judgeVerdictsConsidered };

    if (pairs.length < MIN_CALIBRATION_LABELS) {
      return reply.code(400).send({
        ok: false, error: "insufficient_labels", n: pairs.length, need: MIN_CALIBRATION_LABELS,
        labels: labelRows.length, judgeVerdicts: judgeRows.length,
        excluded: excluded.length, excludedSample: excluded.slice(0, 10),
        hint: "a kappa on a handful of cases is theatre — label more cases, or push judge verdicts for the ones already labelled",
      });
    }

    const k = cohensKappa(pairs);
    const details = {
      suite: body.suite ?? null,
      confusion: k.confusion,
      expected: k.expected,
      degenerate: k.degenerate,
      band: kappaBand(k.kappa),
      excluded: excluded.length,
      excludedSample: excluded.slice(0, 20),
      labelsConsidered: labelRows.length,
      judgeVerdictsConsidered: judgeRows.length,
    };
    const ins = await sql<{ id: string; created_at: Date }[]>`
      INSERT INTO calibrations (target, judge_model, kappa, n, agreement, details)
      VALUES (${body.target}, ${body.judgeModel}, ${k.kappa}, ${k.n}, ${k.agreement}, ${sql.json(details as never)})
      RETURNING id, created_at`;
    if (ins.length === 0) return reply.code(502).send({ ok: false, error: "calibration_wrote_nothing" });

    return {
      ok: true, target: body.target, judgeModel: body.judgeModel,
      kappa: k.kappa, n: k.n, agreement: k.agreement, expected: k.expected,
      band: kappaBand(k.kappa), degenerate: k.degenerate, confusion: k.confusion,
      excluded: excluded.length, excludedSample: excluded.slice(0, 10),
      calibrationId: ins[0]!.id, at: ins[0]!.created_at,
    };
  });

  // ── GET /api/calibration/:target ───────────────────────────────────────────────────────────
  // The body lives in readCalibration() because the Phase 3 dashboard shows the SAME block; two
  // copies of "what does calibrated mean" is how one of them ends up lying.
  app.get("/api/calibration/:target", async (req) => {
    const target = String((req.params as { target: string }).target || "");
    return { ok: true, ...(await readCalibration(sql, target)) };
  });

  // ══ PHASE 3 ═══════════════════════════════════════════════════════════════════════════════
  // ── GET /api/stats/:target?days=7 ──────────────────────────────────────────────────────────
  app.get("/api/stats/:target", async (req) => {
    const target = String((req.params as { target: string }).target || "");
    const { days, clamped } = clampDays((req.query as { days?: string }).days);
    const suites = await suiteStatsFor(sql, target, days);
    return {
      ok: true, target, days,
      // No silent caps: if ?days was clamped the caller is told, not quietly served a different window.
      ...(clamped ? { daysClamped: true } : {}),
      percentileMethod: "nearest_rank" as const,
      suites,
    };
  });

  // ── GET /api/alerts ────────────────────────────────────────────────────────────────────────
  app.get("/api/alerts", async (req) => {
    const q = req.query as { undelivered?: string; target?: string; kind?: string; limit?: string };
    const undelivered = q.undelivered === "1" || q.undelivered === "true";
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const target = q.target ? String(q.target) : null;
    const kind = q.kind ? String(q.kind) : null;
    const rows = await sql<AlertRow[]>`
      SELECT id, target, suite, kind, message, details, created_at, delivered, delivered_at, ack, ack_at
      FROM alerts
      WHERE (${undelivered}::bool = false OR delivered = false)
        AND (${target}::text IS NULL OR target = ${target})
        AND (${kind}::text IS NULL OR kind = ${kind})
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    return {
      ok: true, count: rows.length, limit,
      truncated: rows.length === limit, // declared, never silent
      filter: { undelivered, target, kind },
      alerts: rows.map(alertOut),
    };
  });

  // ── POST /api/alerts/:id/ack ───────────────────────────────────────────────────────────────
  app.post("/api/alerts/:id/ack", async (req, reply) => {
    const id = String((req.params as { id: string }).id || "");
    if (!UUID_RE.test(id)) return reply.code(400).send({ ok: false, error: "bad_alert_id", id });
    const rows = await sql<{ id: string; ack: boolean; ack_at: Date | null }[]>`
      UPDATE alerts SET ack = true, ack_at = coalesce(ack_at, now()) WHERE id = ${id}::uuid
      RETURNING id, ack, ack_at`;
    if (rows.length === 0) return reply.code(404).send({ ok: false, error: "alert_not_found", id });
    // ack does NOT mark it delivered: acknowledging that you saw it in the API is not the same as
    // the alert having reached the phone, and conflating them would silence the delivery retry.
    return { ok: true, id: rows[0]!.id, ack: rows[0]!.ack, ackAt: rows[0]!.ack_at };
  });

  // ── GET /api/dashboard/:target ─────────────────────────────────────────────────────────────
  app.get("/api/dashboard/:target", async (req) => {
    const target = String((req.params as { target: string }).target || "");
    const { days } = clampDays((req.query as { days?: string }).days);
    return await dashboardData(sql, target, days, pct);
  });

  // ── GET /dashboard/:target?token=…  (HTML; NOT under /api, so the header hook skips it) ─────
  // A browser cannot set x-evalhub-token, so this ONE route accepts the token as a query param —
  // validated with the SAME timingSafeEqual comparison, no weaker path. The hub binds 127.0.0.1,
  // so reaching this URL already requires an SSH tunnel (see README).
  // The dashboard's client script, served as a FILE because the vhost sends `script-src 'self'`
  // with no 'unsafe-inline'. Declared before /dashboard/:target so the literal path wins over the
  // parameter. It carries no data — the payload is embedded in the page.
  app.get("/dashboard/app.js", async (_req, reply) => {
    return reply
      .code(200)
      .type("application/javascript; charset=utf-8")
      .header("cache-control", "no-store")
      .send(DASHBOARD_APP_JS);
  });

  app.get("/dashboard/:target", async (req, reply) => {
    const q = req.query as { token?: string; days?: string };
    // Header FIRST (2026-08-05): behind a reverse proxy the token is injected as a header, so it
    // never reaches the browser and can never be pasted out of a URL bar. The query form stays
    // for the direct SSH-tunnel case, where a browser cannot set headers at all.
    const hdr = String((req.headers["x-evalhub-token"] as string) || "");
    if (!tokenOk(hdr) && !tokenOk(String(q.token || ""))) {
      return reply.code(401).type("application/json").send({ ok: false, error: "unauthorized", hint: "x-evalhub-token header, or ?token= over an SSH tunnel" });
    }
    const target = String((req.params as { target: string }).target || "");
    const { days } = clampDays(q.days);
    const data = await dashboardData(sql, target, days, pct);
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      // The page carries the target's numbers. It is not for a cache, and not for a robot.
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-robots-tag", "noindex, nofollow")
      .send(renderDashboardHtml(data));
  });

  // ── POST /api/review/enqueue ───────────────────────────────────────────────────────────────
  app.post("/api/review/enqueue", async (req, reply) => {
    const body = parse(ReviewEnqueueBody, req.body, reply);
    if (!body) return;
    let enqueued = 0, duplicates = 0;
    const errors: { caseId: string; error: string }[] = [];
    for (const it of body.items) {
      try {
        // Dedup against the partial unique index (state='open'): re-enqueuing a case that is still
        // waiting is a no-op we COUNT, never a second card for the same case.
        const rows = await sql<{ id: string }[]>`
          INSERT INTO review_queue (target, suite, case_id, reason, payload)
          VALUES (${body.target}, ${body.suite}, ${it.caseId}, ${it.reason},
                  ${sql.json((it.payload ?? {}) as never)})
          ON CONFLICT DO NOTHING
          RETURNING id`;
        if (rows.length === 1) enqueued++; else duplicates++;
      } catch (e) {
        if (errors.length < 5) errors.push({ caseId: it.caseId, error: String((e as Error)?.message ?? e) });
      }
    }
    const received = body.items.length;
    if (enqueued + duplicates < received) {
      // THE WRITE LAW: a dedup is an accounted outcome, an exception is not.
      return reply.code(502).send({ ok: false, received, enqueued, duplicates, failed: received - enqueued - duplicates, errors });
    }
    return { ok: true, received, enqueued, duplicates, target: body.target, suite: body.suite };
  });

  // ── GET /api/review/next?target=&limit=10 ──────────────────────────────────────────────────
  app.get("/api/review/next", async (req) => {
    const q = req.query as { target?: string; suite?: string; limit?: string };
    const target = q.target ? String(q.target) : null;
    const suite = q.suite ? String(q.suite) : null;
    const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 200);
    const rows = await sql<{ id: string; target: string; suite: string; case_id: string; reason: string; payload: unknown; enqueued_at: Date }[]>`
      SELECT id, target, suite, case_id, reason, payload, enqueued_at
      FROM review_queue
      WHERE state = 'open'
        AND (${target}::text IS NULL OR target = ${target})
        AND (${suite}::text IS NULL OR suite = ${suite})
      ORDER BY enqueued_at ASC, id ASC
      LIMIT ${limit}`;
    const open = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM review_queue
      WHERE state = 'open' AND (${target}::text IS NULL OR target = ${target})
        AND (${suite}::text IS NULL OR suite = ${suite})`;
    return {
      ok: true, limit, openTotal: open[0]?.n ?? rows.length,
      items: rows.map((r) => ({
        id: r.id, target: r.target, suite: r.suite, caseId: r.case_id,
        reason: r.reason, payload: r.payload, enqueuedAt: r.enqueued_at,
      })),
    };
  });

  // ── POST /api/review/:id/resolve ───────────────────────────────────────────────────────────
  app.post("/api/review/:id/resolve", async (req, reply) => {
    const id = String((req.params as { id: string }).id || "");
    if (!UUID_RE.test(id)) return reply.code(400).send({ ok: false, error: "bad_review_id", id });
    const body = parse(ReviewResolveBody, req.body, reply);
    if (!body) return;

    // THE ONE resolve path (src/review.ts). The labelling screen's own POST calls the same function,
    // so a label made with a keystroke is byte-for-byte the row this route would have written.
    const out = await resolveReviewItem(sql, id, body);
    return out.ok ? out.body : reply.code(out.status).send(out.body);
  });

  // ══ THE LABELLING SCREEN (Phase 0 calibration) ════════════════════════════════════════════
  // Two routes, NEITHER under /api/ — the onRequest hook demands a header no browser can set.
  // Auth is the SAME timingSafeEqual comparison, never a weaker path, and accepts the token from:
  //   • the x-evalhub-token HEADER — what the authenticating Cloudflare Worker in front of the hub
  //     injects, so the secret never reaches the browser at all; or
  //   • ?token= / a `token` field in the POST body — the direct SSH-tunnel case, where a browser
  //     cannot set headers.
  // The PAGE only ever posts a RELATIVE path, so the request goes back through whatever
  // authenticated it. An absolute host would route around the Worker and lose the auth.
  const reviewTokenOk = (req: FastifyRequest, bodyToken?: unknown): boolean => {
    const hdr = String((req.headers["x-evalhub-token"] as string) || "");
    const qry = String((req.query as { token?: string })?.token || "");
    return tokenOk(hdr) || tokenOk(qry) || tokenOk(String(bodyToken ?? ""));
  };

  // ── POST /auth/send-code ───────────────────────────────────────────────────────────────────
  // Mails the sign-in code for the Worker, which cannot speak SMTP. Deliberately NOT a general
  // "send an email" route: it takes no recipient, no subject and no body — only a six-digit code,
  // which it validates and drops into wording it composes itself. The recipient is EVALS_LOGIN_EMAIL
  // from the environment. So the worst a leaked token can do here is mail the founder a number.
  //
  // The Worker rate-limits sending too. This second limit exists because the Worker is not the only
  // thing that can reach this route, and "the caller promised to be careful" is not a control.
  app.post("/auth/send-code", async (req, reply) => {
    if (!reviewTokenOk(req, (req.body as { token?: unknown } | null)?.token)) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    const code = (req.body as { code?: unknown } | null)?.code;
    if (!isSixDigitCode(code)) {
      return reply.code(400).send({ ok: false, error: "bad_code" });
    }
    const now = Date.now();
    sendCodeHits = sendCodeHits.filter((t) => now - t < SEND_WINDOW_MS);
    if (sendCodeHits.length >= SEND_MAX_PER_WINDOW) {
      const retryAfter = Math.ceil((SEND_WINDOW_MS - (now - sendCodeHits[0]!)) / 1000);
      return reply.code(429).header("retry-after", String(retryAfter)).send({ ok: false, error: "rate_limited", retryAfter });
    }
    sendCodeHits.push(now);

    // `product` names WHICH sign-in this code is for, from a fixed set resolved in mail.ts
    // (unknown → "evals"). It changes only the label the hub composes — the recipient is still the
    // EVALS_LOGIN_EMAIL allowlist and nothing from the caller reaches subject or body.
    const r = await sendLoginCode(
      code,
      (req.body as { to?: unknown } | null)?.to,
      (req.body as { product?: unknown } | null)?.product,
    );
    if (r.ok) {
      // Name the channel. "It was sent" without saying HOW is not something anyone can act on when
      // a code fails to arrive — it is the difference between "check Telegram" and "check spam".
      req.log.info({ via: r.via }, "[auth] sign-in code delivered");
      return { ok: true, via: r.via };
    }
    if (!r.ok) {
      // Say WHY on the server side. A login that fails because SMTP_PASS is missing must not look
      // the same as one that fails because the mail bounced.
      req.log.error({ err: r.error, detail: r.detail }, "[auth] sign-in code was NOT sent");
      return reply.code(r.error === "not_configured" ? 503 : 502).send({ ok: false, error: r.error, detail: r.detail });
    }
    return { ok: true };
  });

  // The labelling screen's client script, served as a FILE because the estate's vhost sends
  // `script-src 'self'` with no 'unsafe-inline' — an inline <script> is dropped silently. Declared
  // before /review/:target so the literal path wins over the parameter. It carries no data (the
  // payload is embedded in the page), but it stays behind the same token as everything else here.
  app.get("/review/app.js", async (req, reply) => {
    if (!reviewTokenOk(req)) {
      return reply.code(401).type("application/json").send({ ok: false, error: "unauthorized" });
    }
    return reply
      .code(200)
      .type("application/javascript; charset=utf-8")
      .header("cache-control", "no-store")
      .send(REVIEW_APP_JS);
  });

  app.get("/review/:target", async (req, reply) => {
    if (!reviewTokenOk(req)) {
      return reply.code(401).type("application/json").send({
        ok: false, error: "unauthorized", hint: "x-evalhub-token header, or ?token= over an SSH tunnel",
      });
    }
    const target = String((req.params as { target: string }).target || "");
    const q = req.query as { token?: string; suite?: string; limit?: string; labeler?: string };
    const suite = q.suite ? String(q.suite) : null;
    const limit = Math.min(Math.max(Number(q.limit) || 60, 1), 200);
    const labeler = (q.labeler ? String(q.labeler) : "founder").slice(0, 120);
    const data = await reviewScreenData(sql, target, suite, limit, labeler, q.token ? String(q.token) : "");
    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("x-robots-tag", "noindex, nofollow")
      .send(renderReviewHtml(data));
  });

  app.post("/review/:target/resolve", async (req, reply) => {
    const raw = (req.body ?? {}) as { id?: unknown; token?: unknown };
    if (!reviewTokenOk(req, raw.token)) {
      return reply.code(401).send({ ok: false, error: "unauthorized" });
    }
    const target = String((req.params as { target: string }).target || "");
    const id = String(raw.id ?? "");
    if (!UUID_RE.test(id)) return reply.code(400).send({ ok: false, error: "bad_review_id", id });
    const body = parse(ReviewResolveBody, req.body, reply);
    if (!body) return;

    const out = await resolveReviewItem(sql, id, body);
    if (!out.ok) return reply.code(out.status).send(out.body);

    // The screen's live readout, computed AFTER the write so it can never show a kappa that
    // includes a label the DB refused. Nothing is persisted here — POST /api/calibration/compute
    // is still the only thing that records a calibration.
    const snap = await kappaSnapshot(sql, target, null);
    const k = liveKappaFrom(snap, MIN_CALIBRATION_LABELS);
    return {
      ...out.body,
      counts: await reviewCounts(sql, target),
      kappaPairs: snap.pairs.length,
      kappa: k === null ? null : {
        n: k.n, kappa: k.kappa, agreement: k.agreement, expected: k.expected, band: k.band, degenerate: k.degenerate,
      },
    };
  });

  // ══ PHASE 3b ══════════════════════════════════════════════════════════════════════════════
  // ── POST /api/model-runs ───────────────────────────────────────────────────────────────────
  app.post("/api/model-runs", async (req, reply) => {
    const body = parse(ModelRunBody, req.body, reply);
    if (!body) return;
    // ONE pricing path (src/pricing.ts). A reported cost wins; otherwise the table prices it when
    // it knows the model; otherwise the row is stored with cost NULL and cost_source 'unknown'.
    // An unknown price NEVER becomes 0 — that is the whole point of the source column.
    const cost = resolveRunCost({
      target: body.target, suite: body.suite, model: body.model,
      provider: body.provider ?? null, runId: body.runId ?? null,
      cases: body.cases, score: body.score,
      tokensIn: body.tokensIn ?? null, tokensOut: body.tokensOut ?? null,
      costUsd: body.costUsd ?? null,
      latencyP50Ms: body.latencyP50Ms ?? null, latencyP95Ms: body.latencyP95Ms ?? null,
    });
    const rows = await sql<{ id: string; created_at: Date }[]>`
      INSERT INTO model_runs (target, suite, model, provider, run_id, cases, score,
                              tokens_in, tokens_out, cost_usd, cost_source, latency_p50_ms, latency_p95_ms)
      VALUES (${body.target}, ${body.suite}, ${body.model}, ${body.provider ?? null}, ${body.runId ?? null},
              ${body.cases}, ${round2(body.score)}, ${body.tokensIn ?? null}, ${body.tokensOut ?? null},
              ${cost.costUsd}, ${cost.costSource}, ${body.latencyP50Ms ?? null}, ${body.latencyP95Ms ?? null})
      RETURNING id, created_at`;
    const row = rows[0];
    if (!row) return reply.code(502).send({ ok: false, error: "model_run_wrote_nothing", model: body.model });
    return {
      ok: true, id: row.id, at: row.created_at,
      target: body.target, suite: body.suite, model: body.model,
      costUsd: cost.costUsd, costSource: cost.costSource, costReason: cost.reason ?? null,
      ...(cost.price ? { price: cost.price } : {}),
    };
  });

  // ── GET /api/curves/:target?suite= ─────────────────────────────────────────────────────────
  app.get("/api/curves/:target", async (req) => {
    const target = String((req.params as { target: string }).target || "");
    const suite = (req.query as { suite?: string }).suite ? String((req.query as { suite?: string }).suite) : null;
    const c = await modelCurvesFor(sql, target, suite);
    return {
      ok: true, target, suite: c.suite, totalRuns: c.totalRuns,
      models: c.models, frontier: c.frontier,
      // Models that could not be placed on the plane, with the reason. Named, never dropped.
      unpriced: c.unpriced,
      frontierRule: "pareto on (meanScore up, costPer100Cases down); ties keep BOTH points; a model with an unknown cost is NOT placed",
    };
  });

  // ── POST /api/prompts (sha256 of the body IS the identity) ─────────────────────────────────
  app.post("/api/prompts", async (req, reply) => {
    const body = parse(PromptBody, req.body, reply);
    if (!body) return;
    const hash = createHash("sha256").update(body.body, "utf8").digest("hex");
    // Same body twice = same row. The unique index is on (target, surface, hash), so a nightly
    // runner re-posting its prompt is a no-op rather than a table full of clones. The name is
    // NOT part of the identity: renaming a prompt does not make it a different prompt.
    const rows = await sql<{ id: string; name: string; created_at: Date; inserted: boolean }[]>`
      INSERT INTO prompt_variants (target, surface, name, hash, body, active)
      VALUES (${body.target}, ${body.surface}, ${body.name}, ${hash}, ${body.body}, ${body.active})
      ON CONFLICT (target, surface, hash) DO UPDATE SET active = EXCLUDED.active
      RETURNING id, name, created_at, (xmax = 0) AS inserted`;
    const row = rows[0];
    if (!row) return reply.code(502).send({ ok: false, error: "prompt_wrote_nothing" });
    // `created` comes from postgres itself (xmax = 0 ⟺ this tuple was INSERTed, not UPDATEd), not
    // from a clock comparison — a "was it new?" answered by timestamps is wrong within its own
    // tolerance window, which is exactly the case a dedupe test exercises.
    const created = row.inserted === true;
    return {
      ok: true, id: row.id, hash, target: body.target, surface: body.surface,
      name: row.name, storedName: row.name, created, at: row.created_at,
      ...(row.name !== body.name ? { note: "an existing variant with this exact body kept its original name — the body is the identity" } : {}),
    };
  });

  // ── POST /api/ab/results ───────────────────────────────────────────────────────────────────
  app.post("/api/ab/results", async (req, reply) => {
    const body = parse(AbResultsBody, req.body, reply);
    if (!body) return;
    if (body.results.length > MAX_AB_RESULTS_PER_BATCH) {
      // No silent truncation, same rule as /api/runs/:id/results.
      return reply.code(413).send({ ok: false, error: "batch_too_large", received: body.results.length, max: MAX_AB_RESULTS_PER_BATCH });
    }
    const v = await sql<{ id: string; target: string; surface: string }[]>`
      SELECT id, target, surface FROM prompt_variants WHERE id = ${body.variantId}::uuid`;
    const variant = v[0];
    if (!variant) return reply.code(404).send({ ok: false, error: "variant_not_found", variantId: body.variantId });
    if (variant.target !== body.target || variant.surface !== body.surface) {
      // Posting alpha's results under beta's surface would silently corrupt the comparison.
      return reply.code(400).send({
        ok: false, error: "variant_target_surface_mismatch",
        variant: { target: variant.target, surface: variant.surface },
        asked: { target: body.target, surface: body.surface },
      });
    }

    let inserted = 0;
    const errors: { caseId: string; error: string }[] = [];
    for (let i = 0; i < body.results.length; i += 50) {
      const chunk = body.results.slice(i, i + 50);
      const settled = await Promise.allSettled(chunk.map((r) =>
        sql`INSERT INTO ab_results (target, surface, variant_id, run_id, case_id, pass, score)
            VALUES (${body.target}, ${body.surface}, ${body.variantId}::uuid, ${body.runId ?? null},
                    ${r.caseId}, ${r.pass}, ${r.score ?? null})`));
      settled.forEach((s, j) => {
        if (s.status === "fulfilled") inserted++;
        else if (errors.length < 5) errors.push({ caseId: chunk[j]?.caseId ?? "?", error: String((s.reason as Error)?.message ?? s.reason) });
      });
    }
    const received = body.results.length;
    if (inserted < received) {
      // THE WRITE LAW.
      return reply.code(502).send({ ok: false, received, inserted, failed: received - inserted, errors });
    }
    return { ok: true, received, inserted, variantId: body.variantId, target: body.target, surface: body.surface };
  });

  // ── GET /api/ab/:target?surface= ───────────────────────────────────────────────────────────
  app.get("/api/ab/:target", async (req) => {
    const target = String((req.params as { target: string }).target || "");
    const surface = (req.query as { surface?: string }).surface ? String((req.query as { surface?: string }).surface) : null;
    const minN = abMinNFromEnv();
    const r = await abReportFor(sql, target, surface, minN);
    return { ok: true, target, surface: r.surface, variants: r.variants, decision: r.decision };
  });

  // ══ PHASE 4 ═══════════════════════════════════════════════════════════════════════════════
  // SHADOW = REPLAY, CANARY = BLUE/GREEN + COHORT. Both words carry their definition on every
  // response (addendum §"Honest scoping FIRST") — never the bare industry term.

  // ── POST /api/shadow/runs ──────────────────────────────────────────────────────────────────
  app.post("/api/shadow/runs", async (req, reply) => {
    const body = parse(ShadowRunBody, req.body, reply);
    if (!body) return;
    const t = await sql<{ name: string }[]>`SELECT name FROM targets WHERE name = ${body.target}`;
    if (t.length === 0) {
      return reply.code(400).send({ ok: false, error: "unknown_target", target: body.target, hint: "POST /api/targets first" });
    }
    // The threshold is FROZEN onto the row at creation. Reading the env again at finish time would
    // re-interpret a week-old replay under today's rule.
    const sim = shadowSimFromEnv();
    const rows = await sql<{ id: string; started_at: Date }[]>`
      INSERT INTO shadow_runs (target, candidate_sha, baseline_sha, sampled, sim_threshold, notes)
      VALUES (${body.target}, ${body.candidateSha}, ${body.baselineSha ?? null}, ${body.sampled},
              ${sim}, ${sql.json((body.notes ?? {}) as never)})
      RETURNING id, started_at`;
    const row = rows[0];
    if (!row) return reply.code(502).send({ ok: false, error: "shadow_run_wrote_nothing", target: body.target });
    return {
      ok: true, runId: row.id, startedAt: row.started_at,
      target: body.target, candidateSha: body.candidateSha, baselineSha: body.baselineSha ?? null,
      simThreshold: sim, definition: SHADOW_DEFINITION,
    };
  });

  // ── POST /api/shadow/runs/:id/pairs ────────────────────────────────────────────────────────
  app.post("/api/shadow/runs/:id/pairs", async (req, reply) => {
    const runId = String((req.params as { id: string }).id || "");
    if (!UUID_RE.test(runId)) return reply.code(400).send({ ok: false, error: "bad_shadow_run_id", runId });
    const body = parse(ShadowPairsBody, req.body, reply);
    if (!body) return;
    if (body.pairs.length > MAX_SHADOW_PAIRS_PER_BATCH) {
      // No silent truncation, same rule as /api/runs/:id/results.
      return reply.code(413).send({ ok: false, error: "batch_too_large", received: body.pairs.length, max: MAX_SHADOW_PAIRS_PER_BATCH });
    }
    const runs = await sql<{ id: string; sim_threshold: string; finished_at: Date | null }[]>`
      SELECT id, sim_threshold, finished_at FROM shadow_runs WHERE id = ${runId}::uuid`;
    const run = runs[0];
    if (!run) return reply.code(404).send({ ok: false, error: "shadow_run_not_found", runId });
    if (run.finished_at) return reply.code(409).send({ ok: false, error: "shadow_run_already_finished", runId });
    const simThreshold = num(run.sim_threshold);

    let inserted = 0, batchDiffs = 0, batchUnscored = 0;
    const errors: { caseId: string; error: string }[] = [];
    for (const p of body.pairs) {
      // The SAME metrics the rest of the hub scores with (src/scorers/metrics.ts) — one embedding
      // space, so a similarity here means what it means everywhere else.
      const exact = exactNorm(p.baselineOutput, p.candidateOutput);
      let sim: number | null = null;
      let simError: string | null = null;
      try {
        sim = round4(await embedSim(p.baselineOutput, p.candidateOutput, embed));
      } catch (e) {
        // NEVER a fabricated similarity. decidePair() decides what an unavailable embedder means.
        simError = String((e as Error)?.message ?? e).slice(0, 200);
      }
      const d = decidePair({ exact, sim, simError }, simThreshold);
      if (d.diff === true) batchDiffs++;
      if (d.diff === null) batchUnscored++;
      try {
        await sql`
          INSERT INTO shadow_pairs (run_id, case_id, sim, sim_source, exact, diff, score_baseline, score_candidate, note)
          VALUES (${runId}::uuid, ${p.caseId}, ${d.sim}, ${d.simSource}, ${exact}, ${d.diff},
                  ${p.scores?.baseline ?? null}, ${p.scores?.candidate ?? null}, ${d.note ?? null})`;
        inserted++;
      } catch (e) {
        if (errors.length < 5) errors.push({ caseId: p.caseId, error: String((e as Error)?.message ?? e) });
      }
    }

    // The run's counters are RECOMPUTED from the pair rows, never incremented in place: an integer
    // that drifts from the rows behind it is a number nobody can audit.
    const totals = await recomputeShadowTotals(sql, runId, body.spendUsd ?? null);
    const received = body.pairs.length;
    if (inserted < received) {
      // THE WRITE LAW: ok reflects what LANDED.
      return reply.code(502).send({ ok: false, received, inserted, failed: received - inserted, errors, runTotals: totals });
    }
    return {
      ok: true, received, inserted,
      scored: received - batchUnscored, unscored: batchUnscored, diffs: batchDiffs,
      simThreshold,
      diffRule: `a pair is a DIFF when embedSim < ${simThreshold} (EVALHUB_SHADOW_SIM at run creation)`,
      runTotals: totals,
    };
  });

  // ── POST /api/shadow/runs/:id/finish ───────────────────────────────────────────────────────
  app.post("/api/shadow/runs/:id/finish", async (req, reply) => {
    const runId = String((req.params as { id: string }).id || "");
    if (!UUID_RE.test(runId)) return reply.code(400).send({ ok: false, error: "bad_shadow_run_id", runId });
    const runs = await sql<ShadowRunRow[]>`
      SELECT id, target, candidate_sha, baseline_sha, sampled, sim_threshold, spend_usd, finished_at
      FROM shadow_runs WHERE id = ${runId}::uuid`;
    const run = runs[0];
    if (!run) return reply.code(404).send({ ok: false, error: "shadow_run_not_found", runId });

    const totals = await recomputeShadowTotals(sql, runId, null);
    const th = shadowThresholds(num(run.sim_threshold));
    const verdict = shadowVerdict(
      {
        sampled: Number(run.sampled),
        compared: totals.compared,
        diffs: totals.diffs,
        unscored: totals.unscored,
        meanScoreCandidate: totals.meanScoreCandidate,
        meanScoreBaseline: totals.meanScoreBaseline,
        spendUsd: numOrNull(run.spend_usd),
      },
      th
    );
    // finished_at from the DB clock (estate law). coalesce: re-finishing recomputes the verdict but
    // does not rewrite when the replay actually ended.
    const upd = await sql<{ id: string; finished_at: Date }[]>`
      UPDATE shadow_runs
      SET finished_at = coalesce(finished_at, now()),
          recommendation = ${verdict.recommendation}, reason = ${verdict.reason}
      WHERE id = ${runId}::uuid
      RETURNING id, finished_at`;
    if (upd.length === 0) return reply.code(502).send({ ok: false, error: "shadow_finish_wrote_nothing", runId });

    return {
      ...verdict,
      runId, target: run.target,
      candidateSha: run.candidate_sha, baselineSha: run.baseline_sha,
      finishedAt: upd[0]!.finished_at,
      refinished: run.finished_at !== null,
    };
  });

  // ── POST /api/canary/events ────────────────────────────────────────────────────────────────
  app.post("/api/canary/events", async (req, reply) => {
    const body = parse(CanaryEventBody, req.body, reply);
    if (!body) return;
    if (!CANARY_PHASES.includes(body.phase as CanaryPhase)) {
      // The vocabulary is closed and NAMED in the error: a watcher that posts 'rolledback' must be
      // told exactly what it may say, not handed a generic 400.
      return reply.code(400).send({
        ok: false, error: "unknown_phase", phase: body.phase, allowed: CANARY_PHASES,
        hint: "a phase nobody can interpret later must never reach the table",
      });
    }
    const rows = await sql<{ id: string; created_at: Date }[]>`
      INSERT INTO canary_events (target, sha, phase, pct, reason)
      VALUES (${body.target}, ${body.sha}, ${body.phase}, ${body.pct ?? null}, ${body.reason ?? null})
      RETURNING id, created_at`;
    const row = rows[0];
    if (!row) return reply.code(502).send({ ok: false, error: "canary_event_wrote_nothing", target: body.target });
    return {
      ok: true, id: row.id, at: row.created_at,
      target: body.target, sha: body.sha, phase: body.phase,
      pct: body.pct ?? null, defaultPct: canaryPctFromEnv(),
      definition: CANARY_DEFINITION,
    };
  });

  // ── GET /api/canary/:target ────────────────────────────────────────────────────────────────
  app.get("/api/canary/:target", async (req) => {
    const target = String((req.params as { target: string }).target || "");
    const q = req.query as { limit?: string; sha?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 500);
    const sha = q.sha ? String(q.sha) : null;
    const events = await canaryEventsFor(sql, target, sha, limit);
    const summary = summariseCanary(events);
    return {
      ok: true, target, sha, limit,
      truncated: events.length === limit, // declared, never silent
      count: events.length, events,
      summary, definition: CANARY_DEFINITION,
    };
  });

  // ── GET /api/report/:target?sha=&format=json|md ────────────────────────────────────────────
  app.get("/api/report/:target", async (req, reply) => {
    const target = String((req.params as { target: string }).target || "");
    const q = req.query as { sha?: string; format?: string; days?: string };
    const format = String(q.format || "json");
    if (format !== "json" && format !== "md") {
      return reply.code(400).send({ ok: false, error: "bad_format", format, allowed: ["json", "md"] });
    }
    const { days } = clampDays(q.days);
    const built = await reportFor(sql, target, q.sha ? String(q.sha) : null, days, pct);
    if (!built) {
      return reply.code(404).send({ ok: false, error: "unknown_target", target, hint: "POST /api/targets first" });
    }
    if (format === "md") {
      return reply.code(200).type("text/markdown; charset=utf-8").header("cache-control", "no-store")
        .send(renderReportMarkdown(built.report));
    }
    return { ...built.report, shaSource: built.shaSource, format: "json" as const };
  });

  return app;
}

// ── Phase 4 helpers ───────────────────────────────────────────────────────────────────────────

type ShadowRunRow = {
  id: string; target: string; candidate_sha: string; baseline_sha: string | null;
  sampled: number; sim_threshold: string; spend_usd: string | null; finished_at: Date | null;
};

/**
 * Recompute a shadow run's counters FROM ITS PAIR ROWS and write them back, optionally adding a
 * batch's metered spend. The pairs are the truth; the columns are a cache of them.
 * `unscored` = pairs whose diff could not be decided. They are NEVER folded into `compared`.
 */
async function recomputeShadowTotals(sql: Sql, runId: string, addSpendUsd: number | null) {
  const agg = await sql<{
    compared: number; diffs: number; unscored: number; mean_c: string | null; mean_b: string | null;
  }[]>`
    SELECT count(*) FILTER (WHERE diff IS NOT NULL)::int AS compared,
           count(*) FILTER (WHERE diff = true)::int      AS diffs,
           count(*) FILTER (WHERE diff IS NULL)::int     AS unscored,
           avg(score_candidate) AS mean_c,
           avg(score_baseline)  AS mean_b
    FROM shadow_pairs WHERE run_id = ${runId}::uuid`;
  const a = agg[0];
  const compared = Number(a?.compared ?? 0);
  const diffs = Number(a?.diffs ?? 0);
  const unscored = Number(a?.unscored ?? 0);
  const meanC = numOrNull(a?.mean_c ?? null);
  const meanB = numOrNull(a?.mean_b ?? null);
  const rows = await sql<{ spend_usd: string | null }[]>`
    UPDATE shadow_runs
    SET compared = ${compared}, diffs = ${diffs}, unscored = ${unscored},
        mean_score_candidate = ${meanC}, mean_score_baseline = ${meanB},
        spend_usd = CASE WHEN ${addSpendUsd}::numeric IS NULL THEN spend_usd
                         ELSE coalesce(spend_usd, 0) + ${addSpendUsd}::numeric END
    WHERE id = ${runId}::uuid
    RETURNING spend_usd`;
  return {
    compared, diffs, unscored,
    meanScoreCandidate: meanC, meanScoreBaseline: meanB,
    spendUsd: numOrNull(rows[0]?.spend_usd ?? null),
  };
}

async function canaryEventsFor(sql: Sql, target: string, sha: string | null, limit: number): Promise<CanaryEvent[]> {
  const rows = await sql<{ id: string; target: string; sha: string; phase: string; pct: number | null; reason: string | null; created_at: Date }[]>`
    SELECT id, target, sha, phase, pct, reason, created_at
    FROM canary_events
    WHERE target = ${target} AND (${sha}::text IS NULL OR sha = ${sha})
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id, target: r.target, sha: r.sha, phase: r.phase as CanaryPhase,
    pct: r.pct === null ? null : Number(r.pct), reason: r.reason,
    createdAt: r.created_at.toISOString(),
  }));
}

/** The latest shadow run for a target, in the shape the report and the dashboard both read. */
async function latestShadowFor(sql: Sql, target: string) {
  const rows = await sql<{
    id: string; candidate_sha: string; baseline_sha: string | null; sampled: number;
    compared: number; diffs: number; unscored: number; sim_threshold: string;
    mean_score_candidate: string | null; mean_score_baseline: string | null; spend_usd: string | null;
    recommendation: string | null; reason: string | null; started_at: Date; finished_at: Date | null;
  }[]>`
    SELECT id, candidate_sha, baseline_sha, sampled, compared, diffs, unscored, sim_threshold,
           mean_score_candidate, mean_score_baseline, spend_usd, recommendation, reason, started_at, finished_at
    FROM shadow_runs WHERE target = ${target}
    ORDER BY started_at DESC, id DESC LIMIT 1`;
  const r = rows[0];
  if (!r) return null;
  // The verdict is RECOMPUTED from the stored counters through the same pure function the finish
  // route used, so a report can never print a recommendation the current rule would not produce.
  const v = shadowVerdict(
    {
      sampled: Number(r.sampled), compared: Number(r.compared), diffs: Number(r.diffs), unscored: Number(r.unscored),
      meanScoreCandidate: numOrNull(r.mean_score_candidate), meanScoreBaseline: numOrNull(r.mean_score_baseline),
      spendUsd: numOrNull(r.spend_usd),
    },
    shadowThresholds(num(r.sim_threshold))
  );
  return {
    runId: r.id,
    candidateSha: r.candidate_sha,
    baselineSha: r.baseline_sha,
    // `recommendation` is the recomputed one; `storedRecommendation` is what the finish wrote. They
    // differ only if the rule changed since — and then BOTH are shown rather than one silently winning.
    recommendation: v.recommendation as ShadowRecommendation,
    storedRecommendation: (r.recommendation as ShadowRecommendation | null) ?? null,
    reason: v.reason,
    compared: v.compared,
    diffs: v.diffs,
    unscored: v.unscored,
    diffRate: v.diffRate,
    meanDelta: v.meanDelta,
    spendUsd: v.spendUsd,
    caveats: v.caveats,
    thresholds: v.thresholds as unknown as Record<string, unknown>,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    definition: SHADOW_DEFINITION,
  };
}

const MAX_REPORT_ALERTS = 20;

/**
 * Assemble the stakeholder report from EXISTING hub data. This function fetches; every decision
 * (verdict, headline, the "does not cover" block) is made by the pure functions in src/report.ts.
 */
async function reportFor(sql: Sql, target: string, askedSha: string | null, days: number, pct: number) {
  const t = await sql<{ name: string }[]>`SELECT name FROM targets WHERE name = ${target}`;
  if (t.length === 0) return null;

  // No ?sha → the latest finished run's sha, and the substitution is DECLARED on the payload.
  let sha = askedSha;
  let shaSource: "query" | "latest_finished_run" | "none" = askedSha ? "query" : "none";
  if (!sha) {
    const latest = await sql<{ git_sha: string }[]>`
      SELECT git_sha FROM runs WHERE target = ${target} AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`;
    if (latest[0]) { sha = latest[0].git_sha; shaSource = "latest_finished_run"; }
  }

  const runRows = sha
    ? await sql<{ suite: string; id: string; score: string | null; total: number | null; passed: number | null; finished_at: Date }[]>`
        SELECT DISTINCT ON (suite) suite, id, score, total, passed, finished_at
        FROM runs
        WHERE target = ${target} AND git_sha = ${sha} AND finished_at IS NOT NULL
        ORDER BY suite, finished_at DESC`
    : [];

  const bases = await sql<{ suite: string; score: string; promoted_at: Date }[]>`
    SELECT suite, score, promoted_at FROM baselines WHERE target = ${target}`;
  const baseBySuite = new Map(bases.map((b) => [b.suite, round2(num(b.score))]));

  const suites: ReportSuite[] = [];
  for (const r of runRows) {
    const score = round2(num(r.score));
    const baseline = baseBySuite.has(r.suite) ? (baseBySuite.get(r.suite) as number) : null;
    const regression = baselineRegression(score, baseline, pct);
    // Percentiles over THIS sha's run, not over "the latest run in the window" — a report about a
    // release must not quote another release's latency.
    const lat = await sql<{ latency_ms: number }[]>`
      SELECT latency_ms FROM results WHERE run_id = ${r.id}::uuid AND latency_ms IS NOT NULL`;
    const p = percentiles(lat.map((x) => Number(x.latency_ms)));
    let failures: string[] = [];
    let failuresTotal = 0;
    if (regression) {
      const f = await sql<{ case_id: string }[]>`
        SELECT case_id FROM results WHERE run_id = ${r.id}::uuid AND pass = false
        ORDER BY case_id LIMIT ${MAX_FAILURES_RETURNED}`;
      const tot = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM results WHERE run_id = ${r.id}::uuid AND pass = false`;
      failures = f.map((x) => x.case_id);
      failuresTotal = tot[0]?.n ?? failures.length;
    }
    suites.push({
      suite: r.suite, runId: r.id, score,
      total: r.total === null ? null : Number(r.total),
      passed: r.passed === null ? null : Number(r.passed),
      baseline, delta: baseline === null ? null : round2(score - baseline), regression,
      measuredAt: r.finished_at.toISOString(),
      p50Ms: p.p50, p95Ms: p.p95, p99Ms: p.p99, latencySamples: p.n,
      failures, failuresTotal,
    });
  }

  // Suites this target has ever finished that produced NOTHING for this sha. Named, never omitted.
  const everRows = await sql<{ suite: string }[]>`
    SELECT DISTINCT suite FROM runs WHERE target = ${target} AND finished_at IS NOT NULL ORDER BY suite`;
  const reported = new Set(suites.map((s) => s.suite));
  const suitesMissingForSha = everRows.map((r) => r.suite).filter((s) => !reported.has(s));

  const cal = await readCalibration(sql, target);
  const calRow = cal.calibrations[0] ?? null;

  // The safety probe count — from the latest finished run of a suite named for safety.
  const safetyRows = await sql<{ suite: string; total: number | null; score: string | null; finished_at: Date }[]>`
    SELECT suite, total, score, finished_at FROM runs
    WHERE target = ${target} AND finished_at IS NOT NULL AND suite ILIKE '%safety%'
    ORDER BY finished_at DESC LIMIT 1`;
  const safetyRow = safetyRows[0] ?? null;

  // "since the previous baseline" (addendum §17) — the most recent baseline promotion for this
  // target. With no baseline at all, the window start is used and the label says which it is.
  const lastPromo = bases.map((b) => b.promoted_at).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const since = lastPromo ? lastPromo.toISOString() : null;
  const sinceLabel = since ? `since the previous baseline promotion (${since})` : `in the last ${days} day(s) (no baseline has ever been promoted)`;

  const alertRows = since
    ? await sql<AlertRow[]>`
        SELECT id, target, suite, kind, message, details, created_at, delivered, delivered_at, ack, ack_at
        FROM alerts WHERE target = ${target} AND created_at >= ${since}::timestamptz
        ORDER BY created_at DESC LIMIT ${MAX_REPORT_ALERTS}`
    : await sql<AlertRow[]>`
        SELECT id, target, suite, kind, message, details, created_at, delivered, delivered_at, ack, ack_at
        FROM alerts WHERE target = ${target} AND created_at >= now() - (${days}::int * interval '1 day')
        ORDER BY created_at DESC LIMIT ${MAX_REPORT_ALERTS}`;
  const alertTotals = since
    ? await sql<{ n: number; open: number }[]>`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE ack = false)::int AS open
        FROM alerts WHERE target = ${target} AND created_at >= ${since}::timestamptz`
    : await sql<{ n: number; open: number }[]>`
        SELECT count(*)::int AS n, count(*) FILTER (WHERE ack = false)::int AS open
        FROM alerts WHERE target = ${target} AND created_at >= now() - (${days}::int * interval '1 day')`;
  const items: ReportAlert[] = alertRows.map((a) => ({
    kind: a.kind, suite: a.suite, message: a.message, createdAt: a.created_at.toISOString(), ack: a.ack,
  }));

  // Cost over the same window as the alerts, from METERED model runs only.
  const costRows = since
    ? await sql<{ model: string; cost_usd: string | null; cost_source: string }[]>`
        SELECT model, cost_usd, cost_source FROM model_runs
        WHERE target = ${target} AND created_at >= ${since}::timestamptz`
    : await sql<{ model: string; cost_usd: string | null; cost_source: string }[]>`
        SELECT model, cost_usd, cost_source FROM model_runs
        WHERE target = ${target} AND created_at >= now() - (${days}::int * interval '1 day')`;
  const costed = costRows.filter((c) => c.cost_usd !== null);
  const unknownCostModels = [...new Set(costRows.filter((c) => c.cost_usd === null).map((c) => c.model))].sort();
  const cost = {
    since,
    // A window with no priced run has an UNKNOWN total, not a $0.00 one.
    totalUsd: costed.length ? round2(costed.reduce((a, c) => a + num(c.cost_usd), 0) * 100) / 100 : null,
    runs: costRows.length,
    models: new Set(costRows.map((c) => c.model)).size,
    unknownCostModels,
  };

  const shadow = await latestShadowFor(sql, target);
  const canaryEvents = await canaryEventsFor(sql, target, null, 50);
  const canarySummary = summariseCanary(canaryEvents);

  const input: ReportInput = {
    target,
    sha: sha ?? null,
    // The generated-at stamp comes from the DB clock, like every other timestamp the hub prints.
    generatedAt: (await sql<{ now: Date }[]>`SELECT now() AS now`)[0]!.now.toISOString(),
    windowDays: days,
    regressionPct: pct,
    suites,
    suitesMissingForSha,
    calibration: {
      status: cal.status,
      judgeModel: calRow?.judgeModel ?? null,
      kappa: calRow ? calRow.kappa : null,
      n: calRow ? calRow.n : 0,
      band: calRow?.band ?? null,
      at: calRow ? new Date(calRow.at as unknown as string).toISOString() : null,
      labels: cal.labels.total,
    },
    safety: {
      suite: safetyRow?.suite ?? null,
      probes: safetyRow?.total === null || safetyRow?.total === undefined ? 0 : Number(safetyRow.total),
      measuredAt: safetyRow ? safetyRow.finished_at.toISOString() : null,
      score: safetyRow?.score === null || safetyRow?.score === undefined ? null : round2(num(safetyRow.score)),
    },
    alerts: { since, sinceLabel, total: alertTotals[0]?.n ?? items.length, open: alertTotals[0]?.open ?? 0, items },
    cost,
    shadow: shadow
      ? {
          runId: shadow.runId, candidateSha: shadow.candidateSha, baselineSha: shadow.baselineSha,
          recommendation: shadow.recommendation, reason: shadow.reason,
          compared: shadow.compared, diffs: shadow.diffs, diffRate: shadow.diffRate,
          meanDelta: shadow.meanDelta, spendUsd: shadow.spendUsd,
          thresholds: shadow.thresholds, finishedAt: shadow.finishedAt,
        }
      : null,
    canary: {
      events: canarySummary.events, starts: canarySummary.starts, promotes: canarySummary.promotes,
      rollbacks: canarySummary.rollbacks, note: canarySummary.note,
      last: canarySummary.last
        ? {
            phase: canarySummary.last.phase, sha: canarySummary.last.sha, pct: canarySummary.last.pct,
            reason: canarySummary.last.reason, createdAt: canarySummary.last.createdAt,
          }
        : null,
    },
  };
  return { report: buildReport(input), shaSource };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AlertRow = {
  id: string; target: string; suite: string; kind: string; message: string; details: unknown;
  created_at: Date; delivered: boolean; delivered_at: Date | null; ack: boolean; ack_at: Date | null;
};
function alertOut(r: AlertRow) {
  return {
    id: r.id, target: r.target, suite: r.suite, kind: r.kind, message: r.message, details: r.details,
    createdAt: r.created_at, delivered: r.delivered, deliveredAt: r.delivered_at, ack: r.ack, ackAt: r.ack_at,
  };
}

/** Queue tallies by state — the labelling screen's "17 / 50". */
async function reviewCounts(sql: Sql, target: string): Promise<{ open: number; labeled: number; skipped: number; total: number }> {
  const rows = await sql<{ state: string; n: number }[]>`
    SELECT state, count(*)::int AS n FROM review_queue WHERE target = ${target} GROUP BY state`;
  const c = { open: 0, labeled: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    if (r.state === "open" || r.state === "labeled" || r.state === "skipped") c[r.state] = Number(r.n);
    c.total += Number(r.n);
  }
  return c;
}

/**
 * Everything the labelling screen renders. The card is read from the queue payload ONLY when the
 * payload actually is one (payload.v === 1, written by scripts/enqueue-review.mts); any other
 * payload is passed through as `raw` and shown verbatim, because presenting an unknown shape as a
 * structured card would be a claim about fields nobody wrote.
 */
async function reviewScreenData(
  sql: Sql, target: string, suite: string | null, limit: number, labeler: string, token: string,
): Promise<ReviewScreenData> {
  const rows = await sql<{ id: string; suite: string; case_id: string; reason: string; payload: unknown; enqueued_at: Date }[]>`
    SELECT id, suite, case_id, reason, payload, enqueued_at
    FROM review_queue
    WHERE state = 'open' AND target = ${target} AND (${suite}::text IS NULL OR suite = ${suite})
    ORDER BY enqueued_at ASC, id ASC
    LIMIT ${limit}`;
  const counts = await reviewCounts(sql, target);
  const snap = await kappaSnapshot(sql, target, null);
  const k = liveKappaFrom(snap, MIN_CALIBRATION_LABELS);

  const items: ReviewItem[] = rows.map((r) => {
    const p = r.payload as { v?: unknown } | null;
    const isCard = !!p && typeof p === "object" && (p as { v?: unknown }).v === 1;
    return {
      id: r.id, caseId: r.case_id, suite: r.suite, reason: r.reason,
      enqueuedAt: r.enqueued_at.toISOString(),
      card: isCard ? (p as unknown as ReviewCard) : null,
      raw: isCard ? null : r.payload,
    };
  });

  return {
    target, suite, items, counts,
    kappa: k === null ? null : {
      n: k.n, kappa: k.kappa, agreement: k.agreement, expected: k.expected, band: k.band, degenerate: k.degenerate,
    },
    kappaPairs: snap.pairs.length,
    minPairs: MIN_CALIBRATION_LABELS,
    labeler,
    // RELATIVE, always. encodeURIComponent so a target with a slash cannot escape the path.
    postPath: `/review/${encodeURIComponent(target)}/resolve`,
    token,
    truncated: rows.length === limit && counts.open > rows.length,
  };
}

/** Shared by GET /api/calibration/:target and the dashboard. */
async function readCalibration(sql: Sql, target: string) {
  const rows = await sql<{ judge_model: string; kappa: string; n: number; agreement: string; details: unknown; created_at: Date }[]>`
    SELECT DISTINCT ON (judge_model) judge_model, kappa, n, agreement, details, created_at
    FROM calibrations WHERE target = ${target}
    ORDER BY judge_model, created_at DESC`;
  const counts = await sql<{ suite: string; n: number; labelers: number }[]>`
    SELECT suite, count(*)::int AS n, count(DISTINCT labeler)::int AS labelers
    FROM labels WHERE target = ${target} GROUP BY suite ORDER BY suite`;
  return {
    target,
    calibrations: rows.map((r) => ({
      judgeModel: r.judge_model,
      kappa: num(r.kappa),
      n: Number(r.n),
      agreement: num(r.agreement),
      band: kappaBand(num(r.kappa)),
      details: r.details,
      at: r.created_at,
    })),
    labels: {
      total: counts.reduce((a, c) => a + Number(c.n), 0),
      bySuite: counts.map((c) => ({ suite: c.suite, n: Number(c.n), labelers: Number(c.labelers) })),
    },
    // Absence of a calibration is stated, not implied by an empty array.
    status: rows.length === 0 ? ("uncalibrated" as const) : ("calibrated" as const),
  };
}

/** The dashboard payload — ONE function, so the JSON route and the HTML page can never disagree. */
async function dashboardData(sql: Sql, target: string, days: number, pct: number) {
  const [suiteStats, trends, cal] = await Promise.all([
    suiteStatsFor(sql, target, days),
    trendsFor(sql, target, TREND_POINTS),
    readCalibration(sql, target),
  ]);
  const alertRows = await sql<AlertRow[]>`
    SELECT id, target, suite, kind, message, details, created_at, delivered, delivered_at, ack, ack_at
    FROM alerts WHERE target = ${target} ORDER BY created_at DESC LIMIT 10`;
  const review = await sql<{ state: string; n: number }[]>`
    SELECT state, count(*)::int AS n FROM review_queue WHERE target = ${target} GROUP BY state`;
  // ADDITIVE (2026-08-05): the dashboard page names the OTHER products the hub watches — both in the
  // nav (so one tunnel reaches every target) and in the architecture strip. Nothing existing changed.
  // ADDITIVE (2026-08-08): the declared gating posture of every target, and — beside it — the
  // measured number of gate checks the hub has actually answered. Declaration and evidence travel
  // together so a page can never print one without the other.
  const targetRows = await sql<{ name: string; kind: string; gating: string; gate_checks: number; last_gate_at: Date | null }[]>`
    SELECT t.name, t.kind, t.gating,
           coalesce(g.n, 0)::int AS gate_checks,
           g.last_at             AS last_gate_at
    FROM targets t
    LEFT JOIN (
      SELECT target, count(*)::int AS n, max(created_at) AS last_at
      FROM gate_checks GROUP BY target
    ) g ON g.target = t.name
    ORDER BY t.name`;
  const self = targetRows.find((r) => r.name === target);
  const reviewCounts = { open: 0, labeled: 0, skipped: 0 } as Record<string, number>;
  for (const r of review) reviewCounts[r.state] = Number(r.n);

  // ADDITIVE (Phase 3b): cost/quality curves + prompt A/B. Both sections render ONLY when their
  // data is non-empty, so an unswept target's page is byte-identical to what it was before.
  // Phase 4: the last shadow replay and the recent canary transitions.
  const shadow = await latestShadowFor(sql, target);
  const canaryEvents = await canaryEventsFor(sql, target, null, 20);
  const canarySummary = summariseCanary(canaryEvents);

  const [curves, ab] = await Promise.all([
    modelCurvesFor(sql, target, null),
    // PER SURFACE, never pooled: prompts for different surfaces were never asked the same
    // questions, and a "leader" across them would be a comparison that never happened.
    abReportsBySurface(sql, target, abMinNFromEnv()),
  ]);

  return {
    ok: true as const,
    target,
    days,
    trendPoints: TREND_POINTS,
    regressionPct: pct,
    staleHours: staleHoursFromEnv(),
    generatedAt: new Date().toISOString(),
    suites: suiteStats.map((s) => ({
      suite: s.suite,
      score: s.latestScore,
      baseline: s.baseline,
      delta: s.delta,
      regression: baselineRegression(s.latestScore ?? 0, s.latestScore === null ? null : s.baseline, pct),
      runs: s.runs,
      p50Ms: s.p50Ms, p95Ms: s.p95Ms, p99Ms: s.p99Ms,
      latencySamples: s.latencySamples,
      casesPerRun: s.casesPerRun,
      runDurationMs: s.runDurationMs,
      lastRunAt: s.lastRunAt,
      trend: trends.get(s.suite) ?? [],
    })),
    targets: targetRows.map((r) => ({
      name: r.name, kind: r.kind, gating: r.gating,
      gateChecks: r.gate_checks,
      lastGateAt: r.last_gate_at ? r.last_gate_at.toISOString() : null,
    })),
    // The posture of THIS target, so a page rendering one dashboard never has to guess.
    gating: {
      declared: self?.gating ?? "advisory",
      gateChecks: self?.gate_checks ?? 0,
      lastGateAt: self?.last_gate_at ? self.last_gate_at.toISOString() : null,
      definition:
        "DECLARED, not measured: the hub cannot read a deploy script. 'gate' means somebody wired " +
        "bin/evalhub-gate.mts into this product's ship path and said so; 'advisory' means this " +
        "target's scores are recorded and shown but block no deploy. gateChecks is the measurement " +
        "that can falsify the declaration — it counts the GET /api/gate/:target answers this hub " +
        "has actually given.",
    },
    alerts: alertRows.map(alertOut),
    calibration: cal,
    labels: cal.labels,
    review: { open: reviewCounts.open ?? 0, labeled: reviewCounts.labeled ?? 0, skipped: reviewCounts.skipped ?? 0 },
    curves: { models: curves.models, frontier: curves.frontier, unpriced: curves.unpriced, totalRuns: curves.totalRuns },
    ab: { minN: abMinNFromEnv(), surfaces: ab },
    // ADDITIVE (Phase 4): the "Shadow & canary" section renders ONLY when one of these is non-empty,
    // so a target that has never been replayed keeps the page it had before.
    shadow: { last: shadow, definition: SHADOW_DEFINITION },
    canary: { events: canaryEvents.slice(0, 6), summary: canarySummary, definition: CANARY_DEFINITION },
  };
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

// tiny indirection so the route reads cleanly and the rule stays in verdict.ts
function baselineRegression(score: number, baseline: number | null, pct: number): boolean {
  return buildRunVerdict({
    runId: "-", suite: "-", score, total: 0, passed: 0,
    baseline: baseline === null ? null : { score: baseline, runId: "-" }, failures: [], pct,
  }).regression;
}

// ── entrypoint ────────────────────────────────────────────────────────────────────────────────
// Bind address. Default 127.0.0.1 — the safe default for a laptop and for tests. On the products
// box the reverse proxy lives in a CONTAINER and reaches the host over the docker bridge, which a
// loopback bind refuses (proven 2026-08-05: "dial tcp 172.17.0.1:4290: i/o timeout"). There it is
// set to 0.0.0.0 and the port is closed to the internet by UFW, allowing only the Caddy network —
// exactly how conxto's own API is protected. NEVER widen the bind without the matching UFW rule.
function hostFromEnv(): string {
  const h = String(process.env.EVALHUB_HOST || "").trim();
  return h || "127.0.0.1";
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.EVALHUB_PORT || 4290);
  const token = process.env.EVALHUB_TOKEN || "";
  if (!token) console.error("[evalhub] WARNING: EVALHUB_TOKEN is empty — every /api request will 401.");
  const sql = db();
  ensureSchema(sql)
    .then(() => buildServer({ sql, token, logger: true }).listen({ port, host: hostFromEnv() }))
    .then(() => {
      console.log(`[evalhub] listening on 127.0.0.1:${port} (regression pct ${regressionPctFromEnv()})`);
      // Phase 3: the alert scan lives INSIDE the service — one process, one thing to restart.
      // startAlertScanner prints the single boot line about telegram configuration and swallows
      // every per-tick error itself; a failing scan must never take the HTTP service with it.
      startAlertScanner({ sql, pct: regressionPctFromEnv(), intervalMs: alertIntervalSFromEnv() * 1000 });
    })
    .catch((e) => {
      console.error("[evalhub] boot failed:", e);
      process.exit(1);
    });
}
