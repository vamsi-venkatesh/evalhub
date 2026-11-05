// Eval Hub — alerting. Phase 3 addendum §"Alerting (item 14)".
//
// THE SHAPE: evaluation runs INSIDE the hub on an interval (no cron, no second process to forget
// about). Each tick scans every (target, suite) that HAS A BASELINE — a suite with no baseline has
// no bar to fall below and no promise to appear daily — and records:
//   regression   the latest finished run scored below baseline − EVALHUB_REGRESSION_PCT
//   missing_run  no finished run within EVALHUB_STALE_HOURS (default 26: a nightly suite must
//                appear DAILY, and 26 tolerates a two-hour drift without crying wolf)
//   hub_error    RESERVED by the addendum. Nothing emits it yet; it is declared, not simulated.
//
// TWO LAWS THIS FILE EXISTS TO KEEP:
//  1. THE SCAN NEVER KILLS THE SERVER. Every tick is wrapped; an error is counted and logged and
//     the next tick happens. An eval service that takes the box down over a failed SELECT is worse
//     than no eval service.
//  2. NO PER-SCAN SPAM. Missing Telegram credentials produce exactly ONE loud line at boot. The
//     alerts are still RECORDED — a wall of "telegram not configured" every 5 minutes trains the
//     reader to ignore the log, which is how the real alert gets missed.
import type { Sql } from "./db.js";
import { isRegression, round2 } from "./verdict.js";

export type AlertKind = "regression" | "missing_run" | "hub_error";

export const DEFAULT_ALERT_INTERVAL_S = 300;
export const DEFAULT_STALE_HOURS = 26;
/** One scan delivers at most this many pending alerts; the rest go out on the next tick (declared,
 *  never silent — the scan result reports `pending` so a backlog is visible). */
export const MAX_DELIVERIES_PER_SCAN = 25;

export function alertIntervalSFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EVALHUB_ALERT_INTERVAL_S);
  return Number.isFinite(n) && n >= 5 ? Math.floor(n) : DEFAULT_ALERT_INTERVAL_S;
}
export function staleHoursFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EVALHUB_STALE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_HOURS;
}

// ── Telegram delivery ─────────────────────────────────────────────────────────────────────────
export type TelegramConfig = { token: string; chat: string; api: string };

/**
 * EVALHUB_TG_TOKEN + EVALHUB_TG_CHAT. Either missing → null (delivery is SKIPPED, never faked).
 * EVALHUB_TG_API is an ADDITION to the addendum (default api.telegram.org): without it the delivery
 * path could only ever be tested against the real Telegram, and an untested delivery path is a
 * delivery path that does not work. It is a base URL, not a secret.
 */
export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
  const token = (env.EVALHUB_TG_TOKEN || "").trim();
  const chat = (env.EVALHUB_TG_CHAT || "").trim();
  if (!token || !chat) return null;
  return { token, chat, api: (env.EVALHUB_TG_API || "https://api.telegram.org").replace(/\/+$/, "") };
}

export type DeliveryOutcome = { ok: boolean; detail?: string };

/** Plain fetch, no SDK. A non-2xx or a thrown fetch is a FAILURE — the row stays undelivered and
 *  the next scan retries it. We never mark delivered on hope. */
export async function deliverTelegram(cfg: TelegramConfig, text: string): Promise<DeliveryOutcome> {
  try {
    const res = await fetch(`${cfg.api}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chat, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, detail: `telegram_http_${res.status}` };
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (body && body.ok === false) return { ok: false, detail: "telegram_ok_false" };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/** The message a human reads on their phone at 04:00. Numbers, not adjectives. */
export function alertText(a: { target: string; suite: string; kind: string; message: string }): string {
  return `[evalhub] ${a.kind.toUpperCase()} — ${a.target}/${a.suite}\n${a.message}`;
}

// ── the scan ──────────────────────────────────────────────────────────────────────────────────
export type ScanResult = {
  checked: number;
  created: number;
  duplicates: number;
  delivered: number;
  deliveryFailed: number;
  pending: number;
  deliverySkipped: boolean;
  errors: string[];
};

export type ScanOpts = {
  pct: number;
  staleHours: number;
  telegram?: TelegramConfig | null;
  /** injectable for the test suite; defaults to the real HTTP sender */
  send?: (cfg: TelegramConfig, text: string) => Promise<DeliveryOutcome>;
};

/**
 * ONE scan. Records what it finds, then tries to deliver what is pending.
 * Dedup (addendum): never two UNDELIVERED alerts with the same (target, suite, kind). Enforced by a
 * partial unique index in ensure-schema, not by a read-then-write race in this function.
 */
export async function scanAlerts(sql: Sql, opts: ScanOpts): Promise<ScanResult> {
  const out: ScanResult = {
    checked: 0, created: 0, duplicates: 0, delivered: 0, deliveryFailed: 0,
    pending: 0, deliverySkipped: false, errors: [],
  };

  // Latest finished run per suite that HAS a baseline. Age comes from the DB clock.
  const rows = await sql<{
    target: string; suite: string; baseline: string;
    run_id: string | null; run_score: string | null; finished_at: Date | null; age_hours: string | null;
  }[]>`
    SELECT b.target, b.suite, b.score AS baseline,
           r.id AS run_id, r.score AS run_score, r.finished_at,
           EXTRACT(EPOCH FROM (now() - r.finished_at)) / 3600.0 AS age_hours
    FROM baselines b
    LEFT JOIN LATERAL (
      SELECT id, score, finished_at FROM runs
      WHERE runs.target = b.target AND runs.suite = b.suite AND runs.finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1
    ) r ON true
    ORDER BY b.target, b.suite`;

  for (const row of rows) {
    out.checked++;
    const baseline = round2(Number(row.baseline));
    const ageHours = row.age_hours === null ? null : Number(row.age_hours);

    // missing_run — no finished run at all, or the newest one is older than the staleness window.
    if (row.finished_at === null || (ageHours !== null && ageHours > opts.staleHours)) {
      const message =
        row.finished_at === null
          ? `no finished run EVER, but a baseline of ${baseline.toFixed(2)} exists (stale after ${opts.staleHours}h)`
          : `no finished run for ${(ageHours as number).toFixed(1)}h (stale after ${opts.staleHours}h); last run ${row.finished_at.toISOString()}`;
      await record(sql, out, {
        target: row.target, suite: row.suite, kind: "missing_run", message,
        details: { baseline, staleHours: opts.staleHours, ageHours, lastRunAt: row.finished_at?.toISOString() ?? null },
      });
    }

    // regression — only computable when a finished run exists.
    if (row.run_id && row.run_score !== null) {
      const score = round2(Number(row.run_score));
      if (isRegression(score, baseline, opts.pct)) {
        await record(sql, out, {
          target: row.target, suite: row.suite, kind: "regression",
          message: `scored ${score.toFixed(2)} vs baseline ${baseline.toFixed(2)} (delta ${round2(score - baseline).toFixed(2)}, tolerance ${opts.pct})`,
          details: { score, baseline, delta: round2(score - baseline), pct: opts.pct, runId: row.run_id, finishedAt: row.finished_at?.toISOString() ?? null },
        });
      }
    }
  }

  // ── delivery of everything still pending (including alerts from EARLIER scans: a failed send
  //    is retried here, which is the whole point of `delivered` being a column and not a hope).
  const pending = await sql<{ id: string; target: string; suite: string; kind: string; message: string }[]>`
    SELECT id, target, suite, kind, message FROM alerts
    WHERE delivered = false ORDER BY created_at ASC LIMIT ${MAX_DELIVERIES_PER_SCAN + 1}`;
  out.pending = pending.length;

  if (!opts.telegram) {
    out.deliverySkipped = true; // recorded, not delivered — announced ONCE at boot, never per scan
    return out;
  }
  const send = opts.send ?? deliverTelegram;
  for (const a of pending.slice(0, MAX_DELIVERIES_PER_SCAN)) {
    const res = await send(opts.telegram, alertText(a));
    if (!res.ok) {
      out.deliveryFailed++;
      if (out.errors.length < 5) out.errors.push(`deliver ${a.id}: ${res.detail ?? "failed"}`);
      continue; // delivered stays false → the NEXT scan retries it
    }
    const upd = await sql<{ id: string }[]>`
      UPDATE alerts SET delivered = true, delivered_at = now() WHERE id = ${a.id}::uuid RETURNING id`;
    if (upd.length === 1) out.delivered++;
    else out.errors.push(`deliver ${a.id}: sent but the row did not update`);
  }
  return out;
}

async function record(
  sql: Sql,
  out: ScanResult,
  a: { target: string; suite: string; kind: AlertKind; message: string; details: unknown }
): Promise<void> {
  // ON CONFLICT DO NOTHING against the partial unique index (delivered = false OR ack = false):
  // an open alert for this (target, suite, kind) suppresses a second one until a human acks it.
  // A duplicate is a no-op we COUNT, never a silent nothing.
  const ins = await sql<{ id: string }[]>`
    INSERT INTO alerts (target, suite, kind, message, details)
    VALUES (${a.target}, ${a.suite}, ${a.kind}, ${a.message}, ${sql.json(a.details as never)})
    ON CONFLICT DO NOTHING
    RETURNING id`;
  if (ins.length === 1) out.created++;
  else out.duplicates++;
}

// ── the loop ──────────────────────────────────────────────────────────────────────────────────
export type Scanner = {
  stop: () => void;
  /** run one tick right now (the route-level test drives this, not the timer) */
  tick: () => Promise<ScanResult | null>;
  stats: () => { ticks: number; errors: number; created: number; delivered: number; lastError: string | null };
};

/**
 * setInterval inside the server's boot. `unref()` so the timer never keeps a process alive on its
 * own — a test that forgets to stop the scanner must not hang forever.
 */
export function startAlertScanner(opts: {
  sql: Sql;
  pct: number;
  intervalMs?: number;
  staleHours?: number;
  telegram?: TelegramConfig | null;
  send?: ScanOpts["send"];
  log?: (line: string) => void;
}): Scanner {
  const log = opts.log ?? ((l: string) => console.log(l));
  const intervalMs = opts.intervalMs ?? alertIntervalSFromEnv() * 1000;
  const staleHours = opts.staleHours ?? staleHoursFromEnv();
  const telegram = opts.telegram === undefined ? telegramConfigFromEnv() : opts.telegram;

  // THE ONE LOUD LINE. Boot only.
  if (!telegram) {
    log(
      "[evalhub] ALERTS: EVALHUB_TG_TOKEN/EVALHUB_TG_CHAT are NOT set — alerts will be RECORDED in the " +
        "alerts table and DELIVERED TO NOBODY. Read them via GET /api/alerts?undelivered=1. " +
        "(This line is printed once, at boot; the scan loop stays silent about it.)"
    );
  } else {
    log(`[evalhub] ALERTS: telegram delivery ENABLED (chat ${telegram.chat}, api ${telegram.api}); scan every ${Math.round(intervalMs / 1000)}s, stale after ${staleHours}h`);
  }

  const s = { ticks: 0, errors: 0, created: 0, delivered: 0, lastError: null as string | null };
  let running = false;

  const tick = async (): Promise<ScanResult | null> => {
    if (running) return null; // a slow scan must not stack on itself
    running = true;
    try {
      const r = await scanAlerts(opts.sql, { pct: opts.pct, staleHours, telegram, send: opts.send });
      s.ticks++;
      s.created += r.created;
      s.delivered += r.delivered;
      if (r.created > 0 || r.delivered > 0 || r.deliveryFailed > 0) {
        log(`[evalhub] alert scan: checked ${r.checked}, created ${r.created}, dedup ${r.duplicates}, delivered ${r.delivered}, failed ${r.deliveryFailed}, pending ${r.pending}`);
      }
      return r;
    } catch (e) {
      // LAW 1: the loop never crashes the server. Counted, logged, next tick continues.
      s.errors++;
      s.lastError = String((e as Error)?.message ?? e).slice(0, 300);
      log(`[evalhub] alert scan FAILED (${s.errors} total): ${s.lastError}`);
      return null;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer), tick, stats: () => ({ ...s }) };
}
