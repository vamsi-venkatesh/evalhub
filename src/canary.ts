// Eval Hub — canary transitions (Phase 4 addendum §16, item 16). The HUB half: the events table's
// vocabulary and the definition that must ride with the word. The watcher, the systemd units and
// the Caddy cohort live in the PRODUCT repo, not here.
//
// THE NAME, WITH ITS DEFINITION ATTACHED (addendum "Honest scoping FIRST"): there is no fleet and
// no load balancer here. "Canary" in this estate means BLUE/GREEN + COHORT — two systemd units,
// with a cookie-pinned share of traffic routed to green and an automatic flip back on breach.
// The bare word never appears on an artifact without this sentence.
//
// PURE: no DB, no clock, no env. The route validates through `isCanaryPhase` and stores what the
// product tells it; the hub asserts nothing about a rollback it did not witness.

export const CANARY_PHASES = ["start", "promote", "rollback"] as const;
export type CanaryPhase = (typeof CANARY_PHASES)[number];

export const CANARY_DEFINITION =
  "CANARY = BLUE/GREEN + COHORT: two systemd units on one box, with a cookie-pinned share of " +
  "traffic routed to green and an automatic flip back to blue on breach. There is no fleet and no " +
  "load balancer in this estate.";

/** The whole validation rule. An unknown phase is a 400, never a row nobody can interpret later. */
export function isCanaryPhase(v: unknown): v is CanaryPhase {
  return typeof v === "string" && (CANARY_PHASES as readonly string[]).includes(v);
}

export const DEFAULT_CANARY_PCT = 5;

export function canaryPctFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EVALHUB_CANARY_PCT);
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? Math.floor(raw) : DEFAULT_CANARY_PCT;
}

export type CanaryEvent = {
  id: string;
  target: string;
  sha: string;
  phase: CanaryPhase;
  pct: number | null;
  reason: string | null;
  createdAt: string;
};

/**
 * PURE summary of a target's canary history, for the report and the dashboard.
 * It reports WHAT WAS RECORDED and nothing more: a rollback the watcher never posted does not
 * exist here, and the summary says how many events it is speaking from.
 */
export function summariseCanary(events: readonly CanaryEvent[]): {
  events: number;
  starts: number;
  promotes: number;
  rollbacks: number;
  last: CanaryEvent | null;
  note: string;
} {
  const starts = events.filter((e) => e.phase === "start").length;
  const promotes = events.filter((e) => e.phase === "promote").length;
  const rollbacks = events.filter((e) => e.phase === "rollback").length;
  return {
    events: events.length,
    starts,
    promotes,
    rollbacks,
    last: events[0] ?? null,
    note:
      events.length === 0
        ? "no canary transition has ever been recorded for this target — the absence of rollbacks here is an absence of DATA, not a record of stability"
        : `${events.length} transition(s) recorded: ${starts} start, ${promotes} promote, ${rollbacks} rollback. This is what the watcher POSTED; the hub did not witness the traffic itself.`,
  };
}
