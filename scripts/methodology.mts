#!/usr/bin/env npx tsx
// Eval Hub — the PUBLIC METHODOLOGY PAGE generator (Phase 4 addendum §18, item 18).
//
// Produces the static page published at vvdexops.com/evals: how this estate evaluates its AI
// systems, and the numbers, including the bad ones.
//
// THE LAW OF THIS FILE
//   1. EVERY NUMBER COMES FROM THE HUB. This generator fetches the hub's own API and prints what
//      came back. There is no arithmetic here that the hub does not already do, and there is no
//      literal number in this file that appears on the page as a measurement.
//   2. A MISSING NUMBER SAYS "unavailable" — never 0, never "—", never a plausible-looking
//      placeholder. `unk()` renders a visibly different token, and where the hub told us WHY the
//      number is missing, the reason is printed beside it.
//   3. THE LIMITS COME FROM THE HUB TOO. The "What this does not cover" block is not re-authored
//      here: it is the array `src/report.ts` derives BY RULE, fetched from GET /api/report and
//      printed verbatim. If the limits and the numbers could drift apart, one of them would
//      eventually be the lie.
//   4. ANYTHING THE HUB NEVER RECORDED IS LABELLED. The failure register (docs/FAILURES.jsonl)
//      is human-written prose from the build log. Every entry renders with `hubVerified` on its
//      face; every entry currently in the file is NOT hub-verified and says so, in the page, next
//      to the words. That is the difference between a record and a measurement, and the page is
//      not allowed to blur it.
//   5. ZERO EXTERNAL REQUESTS. No CDN, no font service, no image, no analytics, no favicon fetch.
//      Enforced mechanically at the bottom of this file: the rendered bytes are scanned for any
//      scheme-like string or remote-resource tag and the generator EXITS NONZERO rather than write
//      a page that phones home.
//
// USAGE
//   npx tsx scripts/methodology.mts [--out <path>] [--days 30] [--seed-target conxto]
//                                   [--targets a,b] [--data-out <path>] [--allow-empty]
//   env: EVALHUB_URL (default http://127.0.0.1:4290), EVALHUB_TOKEN (required)
//
// The hub binds loopback on the products VPS, so this runs ON the products server (or through an SSH
// tunnel). With the hub unreachable it EXITS 1 and writes nothing: a methodology page whose
// numbers are all "unavailable" is not a publication, it is an outage. `--allow-empty` overrides
// that deliberately, for the case where the honest page IS the empty one.
//
// WHERE THIS IS PUBLISHED (the products server ONLY — never 185, which is trading)
//   The public site is hand-edited static HTML under /opt/vvdex-products/vvdexops/site, bind-mounted
//   read-only into the Caddy container as /srv/vvdexops. That vhost is a BARE file_server with no
//   try_files, so an extensionless URL only resolves as a directory index: the page must land at
//   site/evals/index.html to answer at vvdexops.com/evals. A file named evals.html would answer at
//   /evals.html and NOWHERE else.
//   The vhost's CSP is `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'`.
//   An inline <style> is allowed; an inline <script> would be BLOCKED by the browser. This page
//   therefore ships zero script — it is a static render, and the CSP is a second reason for that,
//   not the first one.
import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── args ──────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next !== undefined && !next.startsWith("--") ? String(next) : null;
}
const has = (name: string) => argv.includes(`--${name}`);

const HUB = (process.env.EVALHUB_URL || "http://127.0.0.1:4290").replace(/\/+$/, "");
const TOKEN = process.env.EVALHUB_TOKEN || "";
const OUT = resolve(process.cwd(), flag("out") || "dist/evals/index.html");
const DATA_OUT = flag("data-out") ? resolve(process.cwd(), flag("data-out")!) : null;
const DAYS = Number(flag("days") || 30);
const SEED = flag("seed-target") || "conxto";
const ONLY = (flag("targets") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ALLOW_EMPTY = has("allow-empty");
const REGISTER = resolve(ROOT, "docs/FAILURES.jsonl");

if (!TOKEN) {
  console.error("[methodology] EVALHUB_TOKEN is not set — every /api request would 401. Refusing to render a page of blanks and call it a publication.");
  process.exit(1);
}

// ── fetch, with provenance ────────────────────────────────────────────────────────────────────
/** Every endpoint this page's numbers came from, printed on the page itself. */
const provenance: { path: string; status: number | string; at: string }[] = [];

async function api<T>(path: string): Promise<T | null> {
  const at = new Date().toISOString();
  try {
    const res = await fetch(`${HUB}${path}`, { headers: { "x-evalhub-token": TOKEN } });
    const text = await res.text();
    provenance.push({ path, status: res.status, at });
    if (!res.ok) {
      console.error(`[methodology] ${res.status} from ${path}: ${text.slice(0, 300)}`);
      return null;
    }
    return JSON.parse(text) as T;
  } catch (err) {
    provenance.push({ path, status: "unreachable", at });
    console.error(`[methodology] ${path} unreachable: ${(err as Error).message}`);
    return null;
  }
}

type Any = Record<string, any>;

// ── html helpers ──────────────────────────────────────────────────────────────────────────────
function esc(s: unknown): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** THE MISSING-NUMBER TOKEN. Never 0, never a dash that could read as "nothing happened". */
function unk(reason?: string): string {
  return `<span class="unk">unavailable</span>${reason ? `<span class="unk-why">(${esc(reason)})</span>` : ""}`;
}
function num(v: unknown, opts: { suffix?: string; digits?: number; reason?: string } = {}): string {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return unk(opts.reason);
  const n = typeof v === "number" ? (opts.digits === undefined ? v : Number(v.toFixed(opts.digits))) : v;
  return `${esc(n)}${opts.suffix ? `<span class="u">${esc(opts.suffix)}</span>` : ""}`;
}
function ms(v: unknown): string {
  return v === null || v === undefined ? unk() : `${esc(Math.round(Number(v)))}<span class="u">ms</span>`;
}
function ts(v: unknown): string {
  return v === null || v === undefined ? unk() : esc(String(v).replace("T", " ").replace(/\.\d+Z$/, "Z"));
}
function delta(v: unknown): string {
  if (v === null || v === undefined) return unk();
  const n = Number(v);
  const cls = n < 0 ? "d-bad" : n > 0 ? "d-ok" : "";
  return `<span class="${cls}">${n > 0 ? "+" : ""}${esc(Number(n.toFixed(2)))}</span>`;
}

// ── data ──────────────────────────────────────────────────────────────────────────────────────
const health = await api<Any>("/api/health");
const seedDash = await api<Any>(`/api/dashboard/${encodeURIComponent(SEED)}`);

let targetNames: string[] = [];
if (seedDash && Array.isArray(seedDash.targets)) targetNames = seedDash.targets.map((t: Any) => String(t.name));
if (ONLY.length) targetNames = targetNames.filter((n) => ONLY.includes(n));
if (targetNames.length === 0 && ONLY.length) targetNames = ONLY;

const targetKind = new Map<string, string>();
for (const t of (seedDash?.targets ?? []) as Any[]) targetKind.set(String(t.name), String(t.kind ?? "unknown"));

type TargetData = { name: string; kind: string; dash: Any | null; report: Any | null };
const targets: TargetData[] = [];
for (const name of targetNames) {
  const dash = name === SEED ? seedDash : await api<Any>(`/api/dashboard/${encodeURIComponent(name)}`);
  const report = await api<Any>(`/api/report/${encodeURIComponent(name)}?days=${DAYS}&format=json`);
  targets.push({ name, kind: targetKind.get(name) ?? "unknown", dash, report });
}

/**
 * GATING POSTURE, printed on the public page beside every target.
 *
 * A page that lists three products under one "the gate blocks the deploy" narrative would be
 * making a claim about two of them that is false. The hub stores a DECLARATION (`gating`) and a
 * MEASUREMENT (`gateChecks` — how many gate answers it has actually given), and both are printed:
 * an unknown declaration renders as `unavailable`, never as "advisory", because a page must not
 * invent a posture for a target whose dashboard did not answer.
 */
function posture(t: TargetData): { label: string; verdictLabel: string; note: string } {
  const g = (t.dash?.gating ?? null) as Any | null;
  if (!g) {
    return {
      label: "posture unavailable",
      verdictLabel: "suite verdict",
      note: "The evaluation service did not answer for this target, so this page states nothing about whether it gates a deploy.",
    };
  }
  const declared = String(g.declared ?? "advisory");
  const checks = Number(g.gateChecks ?? 0);
  const last = g.lastGateAt ? `, last ${String(g.lastGateAt).replace("T", " ").replace(/\..*$/, "Z")}` : "";
  if (declared === "gate") {
    return {
      label: "declared: deploy-gating",
      // Only a gated target has a "gate verdict". Printing that phrase over an advisory target
      // would tell a reader a gate ran, which is the exact impression this whole block exists to
      // prevent.
      verdictLabel: "gate verdict",
      note:
        `A regression on a gated suite is meant to stop this product's ship path. Measured: ` +
        (checks > 0
          ? `${checks} gate check(s) answered by the service${last} &mdash; the declaration is backed by observed deploys.`
          : `the service has answered NO gate check for this target. The declaration says a gate blocks this product's deploy; nothing the service has seen supports that yet.`),
    };
  }
  return {
    label: "declared: advisory &mdash; no gate",
    verdictLabel: "suite verdict, advisory",
    note:
      `Scores for this target are recorded and published; they block no deploy, and the verdict beside this line stops nothing. Measured: ` +
      (checks === 0
        ? `no gate check has been answered for this target, which is exactly what an advisory posture should look like.`
        : `${checks} gate check(s) HAVE been answered for a target declared advisory${last}. Those two facts disagree: either something is gating on this product without saying so, or the declaration is stale. Read this target's numbers with that in mind.`),
  };
}
const alertsAll = await api<Any>("/api/alerts?limit=200");

const hubUp = !!health?.ok;
const anyData = targets.some((t) => t.dash || t.report);
if (!hubUp || !anyData) {
  if (!ALLOW_EMPTY) {
    console.error(
      `[methodology] the hub answered nothing usable (health ok=${String(hubUp)}, targets with data=${targets.filter((t) => t.dash || t.report).length}). ` +
        "Refusing to write a page whose every number would be 'unavailable'. Pass --allow-empty if that IS the honest page today."
    );
    process.exit(1);
  }
  console.error("[methodology] --allow-empty: rendering a page that states, on its face, that the hub returned no data.");
}

// ── derived totals — SUMS ONLY, of numbers the hub computed ───────────────────────────────────
function sum(xs: (number | null | undefined)[]): number | null {
  const vals = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}
const allSuites: Any[] = targets.flatMap((t) => ((t.dash?.suites ?? []) as Any[]).map((s): Any => ({ ...s, target: t.name })));
const totalCases = sum(allSuites.map((s) => s.casesPerRun as number));
const totalLabels = sum(targets.map((t) => (t.dash?.labels?.total ?? t.report?.calibration?.labels) as number));
const totalSafetyProbes = sum(targets.map((t) => t.report?.safety?.probes as number));
const kappas = targets
  .map((t) => t.report?.calibration)
  .filter((c: Any) => c && c.status === "calibrated" && typeof c.kappa === "number") as Any[];
// Alerts must respect the same target whitelist as the cards — otherwise a filtered-out target
// (e.g. an internal test target) still surfaces its alerts in the public failure register.
const alertRows = ((alertsAll?.alerts ?? []) as Any[]).filter(
  (a) => targetNames.length === 0 || targetNames.includes(String(a.target)),
);
/** The one calibration row that exists, or null. Named once so no expression below can index [0] blind. */
const kappaRow: Any | null = kappas.length > 0 ? kappas[0]! : null;
const regressionAlerts = alertRows.filter((a) => a.kind === "regression");
const regressedSuitesNow = allSuites.filter((s) => s.regression === true);
const generatedAt = new Date().toISOString();

// COUNTS ARE ONLY COUNTS WHEN THE SOURCE ANSWERED. If the endpoint behind a tally failed, the tally
// is `null` and renders as "unavailable" — a page that says "0 targets under evaluation" because the
// service was down has stated a measurement it never made.
const dashAllOk = targets.length > 0 && targets.every((t) => !!t.dash);
const targetsCount = seedDash ? targets.length : null;
const suitesCount = dashAllOk ? allSuites.length : null;
const regressedCount = dashAllOk ? regressedSuitesNow.length : null;
/** Why a judge/safety number is missing: never computed, or never answered. */
const missingReason = (whenNoData: string) => (hubUp && dashAllOk ? whenNoData : "the evaluation service did not answer");

// the definitions the hub itself publishes — never re-worded here
const shadowDef: string | null = (targets.find((t) => t.dash?.shadow?.definition)?.dash?.shadow?.definition as string) ?? null;
const canaryDef: string | null = (targets.find((t) => t.dash?.canary?.definition)?.dash?.canary?.definition as string) ?? null;
const pctDef: string | null = (targets.find((t) => t.report?.definitions?.percentiles)?.report?.definitions?.percentiles as string) ?? null;
const regDef: string | null = (targets.find((t) => t.report?.definitions?.regression)?.report?.definitions?.regression as string) ?? null;
const regressionPct: number | null = (targets.find((t) => typeof t.dash?.regressionPct === "number")?.dash?.regressionPct as number) ?? null;
const staleHours: number | null = (targets.find((t) => typeof t.dash?.staleHours === "number")?.dash?.staleHours as number) ?? null;
const abMinN: number | null = (targets.find((t) => typeof t.dash?.ab?.minN === "number")?.dash?.ab?.minN as number) ?? null;
/** How many targets DECLARE a deploy gate. `null` when a dashboard did not answer — a target whose
 *  posture is unknown must not be silently counted as "not gated". */
const gatedCount = dashAllOk ? targets.filter((t) => String(t.dash?.gating?.declared ?? "") === "gate").length : null;
const advisoryCount = dashAllOk ? targets.filter((t) => String(t.dash?.gating?.declared ?? "") === "advisory").length : null;

// ── the failure register (human prose, hub-verification stated on every entry) ─────────────────
type Failure = {
  id: string; date: string; title: string; status: string; what: string; lesson: string;
  hubVerified: boolean; provenance: { source: string; ref: string };
};
let failures: Failure[] = [];
try {
  failures = readFileSync(REGISTER, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Failure);
} catch (err) {
  console.error(`[methodology] cannot read ${REGISTER}: ${(err as Error).message}`);
  process.exit(1);
}
if (failures.length === 0) {
  console.error("[methodology] the failure register is empty. A methodology page with no published failure is an advertisement — refusing.");
  process.exit(1);
}

// ── page ──────────────────────────────────────────────────────────────────────────────────────
const CSS = `
:root{
  --bg:#07070a; --surface:#0e0e12; --surface-2:#15151b;
  --ink-1:#f4f4f8; --ink-2:#a8a8b3; --ink-3:#6a6a76; --ink-4:#3e3e46;
  --border:rgba(255,255,255,0.06); --border-hi:rgba(255,255,255,0.14);
  --accent:#6E8FFF; --accent-soft:#8BA3FF;
  --positive:#4ade80; --warn:#fbbf24; --negative:#f87171;
  --sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --serif:"Instrument Serif",Georgia,"Times New Roman",serif;
  --max:1180px; --pad:40px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink-1);font:15px/1.55 var(--sans);
  -webkit-font-smoothing:antialiased;overflow-x:hidden}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:linear-gradient(rgba(255,255,255,.014) 1px,transparent 1px),
                   linear-gradient(90deg,rgba(255,255,255,.014) 1px,transparent 1px);
  background-size:64px 64px}
body::after{content:"";position:fixed;top:-380px;right:-260px;width:1000px;height:1000px;
  pointer-events:none;z-index:0;background:radial-gradient(circle,rgba(110,143,255,.075),transparent 62%)}
.wrap{position:relative;z-index:1;max-width:var(--max);margin:0 auto;padding:0 var(--pad) 80px}
.nav{position:sticky;top:0;z-index:20;backdrop-filter:blur(12px);background:rgba(10,10,12,.85);
  border-bottom:1px solid var(--border)}
.nav-in{max-width:var(--max);margin:0 auto;padding:14px var(--pad);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px}
.brand i{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px rgba(110,143,255,.85)}
.brand b{font:600 10.5px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase}
.brand s{text-decoration:none;font:400 10.5px/1 var(--mono);letter-spacing:.10em;color:var(--ink-3)}
.stamp{margin-left:auto;font:400 9.5px/1 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3)}
.rail{display:flex;flex-wrap:wrap;margin:26px 0 0;border:1px solid var(--border);border-radius:4px;background:var(--surface)}
.rail div{padding:11px 16px;font:500 9.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink-3);border-right:1px solid var(--border);display:flex;align-items:center;gap:7px}
.rail div:last-child{border-right:0}
.rail b{color:var(--ink-1);font-weight:600}
.rail .live i{width:6px;height:6px;border-radius:50%;background:var(--positive)}
.rail .down i{width:6px;height:6px;border-radius:50%;background:var(--negative)}
.hero{margin:52px 0 0;max-width:74ch}
/* LONGHAND, deliberately: Chromium drops the whole \`font:\` shorthand when clamp() sits in the
   size slot — the hero silently renders at body size. Caught in the dashboard, 2026-08-05. */
.count{font-family:var(--mono);font-weight:600;font-size:clamp(56px,12vw,168px);line-height:.92;
  font-variant-numeric:tabular-nums;letter-spacing:-.03em;
  background:linear-gradient(180deg,#fff 0%,#f0f0f3 35%,#a4a4ae 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;margin:0}
.count-cap{font:500 9.5px/1.5 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);margin:14px 0 30px}
.hero h1{font-size:clamp(24px,3.2vw,38px);line-height:1.18;letter-spacing:-.015em;margin:0 0 16px;font-weight:600}
.hero h1 em{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--accent-soft)}
.hero p.lede{color:var(--ink-2);font-size:14.5px;line-height:1.62;margin:0 0 14px;max-width:62ch}
.strip{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);
  border:1px solid var(--border);margin:56px 0 0}
.strip div{background:var(--bg);padding:16px 14px}
.strip dt{font:500 8.5px/1.35 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:0 0 9px}
.strip dd{margin:0;font:600 22px/1.15 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.strip dd .unk-why{display:block;margin:6px 0 0;font-size:10px;line-height:1.5}
.strip .u{font-size:11px;color:var(--ink-3);margin-left:3px}
.unk{font:600 12px/1.3 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--warn)}
/* INLINE, deliberately: a block-level reason splits the sentence it belongs to and strands the
   following punctuation on its own line (seen at 1440 and 390 in the first render, 2026-08-05). */
.unk-why{display:inline;margin-left:5px;font:400 11px/1.5 var(--mono);letter-spacing:.03em;text-transform:none;color:var(--ink-3)}
.sec{margin-top:72px}
.sec+.sec{position:relative}
.sec+.sec::before{content:"\\25C7";position:absolute;top:-38px;left:50%;transform:translateX(-50%);color:var(--ink-4);font-size:11px}
.sec-h{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:0 0 18px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.sec-h h2{margin:0;font:600 12px/1.2 var(--mono);letter-spacing:.15em;text-transform:uppercase}
.sec-h span{font:400 10px/1.4 var(--mono);letter-spacing:.08em;color:var(--ink-3)}
.prose{color:var(--ink-2);font-size:14.5px;line-height:1.68;max-width:74ch}
.prose p{margin:0 0 14px}
.prose strong{color:var(--ink-1);font-weight:600}
.prose code{font:400 12.5px/1 var(--mono);color:var(--accent-soft)}
.defs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1px;background:var(--border);
  border:1px solid var(--border);margin:22px 0 0}
.defs div{background:var(--surface);padding:17px 18px}
.defs dt{font:600 9.5px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 9px}
.defs dd{margin:0;font-size:13px;line-height:1.62;color:var(--ink-2)}
.defs dd em{font-style:normal;color:var(--ink-1)}
.is-not{margin-top:10px;padding-top:10px;border-top:1px dashed var(--border-hi);font:400 11.5px/1.6 var(--mono);color:var(--ink-3)}
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:6px}
.tbl{width:100%;min-width:740px;border-collapse:collapse}
.tbl th{text-align:left;font:500 8.5px/1.3 var(--mono);letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink-3);padding:0 12px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl td{padding:13px 12px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
.tbl tr td:first-child{border-left:2px solid transparent}
.tbl tr.bad td:first-child{border-left-color:var(--negative)}
.tbl .name{font:500 13px/1.3 var(--mono)}
.tbl .num{font:600 14px/1.2 var(--mono);font-variant-numeric:tabular-nums;text-align:right}
.tbl .sub{font:400 11px/1.3 var(--mono);color:var(--ink-3);font-variant-numeric:tabular-nums;text-align:right}
.d-ok{color:var(--positive)} .d-bad{color:var(--negative)}
.chip{display:inline-block;padding:3px 7px;border-radius:3px;font:600 8.5px/1.2 var(--mono);
  letter-spacing:.1em;text-transform:uppercase;border:1px solid}
.chip.ok{color:var(--positive);border-color:rgba(74,222,128,.35)}
.chip.bad{color:var(--negative);border-color:rgba(248,113,113,.4)}
.chip.warn{color:var(--warn);border-color:rgba(251,191,36,.4)}
.chip.mute{color:var(--ink-3);border-color:var(--border-hi)}
.tgt-h{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin:34px 0 8px}
.tgt-h b{font:600 13px/1.2 var(--mono);letter-spacing:.08em}
.tgt-h span{font:400 10.5px/1.5 var(--mono);color:var(--ink-3)}
.headline{border:1px solid var(--border);border-left:2px solid var(--accent);border-radius:4px;
  background:var(--surface);padding:15px 17px;margin:14px 0 0;font-size:13.5px;line-height:1.62;color:var(--ink-2)}
.list{border:1px solid var(--border);border-radius:5px;background:var(--surface);margin-top:18px}
.list .row{padding:14px 16px;border-bottom:1px solid var(--border);font-size:13.5px;line-height:1.6;color:var(--ink-2)}
.list .row:last-child{border-bottom:0}
.list .row b{display:block;font:600 9.5px/1.3 var(--mono);letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink-3);margin-bottom:7px}
.empty{padding:20px 16px;color:var(--ink-3);font:400 12px/1.6 var(--mono)}
.fail{border:1px solid var(--border);border-left:2px solid var(--negative);border-radius:4px;
  background:var(--surface);padding:19px 20px;margin:0 0 14px}
.fail.open{border-left-color:var(--warn)}
.fail.published{border-left-color:var(--ink-4)}
.fail-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:0 0 11px}
.fail-h b{font-size:15px;font-weight:600;color:var(--ink-1);line-height:1.35}
.fail-h s{text-decoration:none;font:400 9.5px/1.3 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3)}
.fail p{margin:0 0 11px;font-size:13.5px;line-height:1.68;color:var(--ink-2)}
.fail .lesson{font-size:13px;color:var(--ink-1);border-top:1px dashed var(--border-hi);padding-top:11px;margin:0}
.fail .prov{margin:11px 0 0;font:400 10.5px/1.6 var(--mono);letter-spacing:.03em;color:var(--ink-3)}
.foot{margin-top:76px;padding-top:20px;border-top:1px solid var(--border);
  font:400 10px/1.8 var(--mono);letter-spacing:.06em;color:var(--ink-3)}
.foot b{color:var(--ink-2);font-weight:500;letter-spacing:.12em;text-transform:uppercase}
.foot ul{margin:10px 0 0;padding:0;list-style:none}
.foot li{padding:2px 0}
@media (max-width:1040px){.strip{grid-template-columns:repeat(2,1fr)}}
@media (max-width:900px){
  :root{--pad:18px}
  .tbl thead{display:none}
  .tbl{min-width:0}
  .tbl tr{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:14px 0;border-bottom:1px solid var(--border)}
  .tbl td{border:0;padding:2px 0}
  .tbl tr td:first-child{border-left:0}
  .tbl td[data-l]::before{content:attr(data-l);display:inline-block;min-width:78px;
    font:500 8.5px/1.3 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
  .tbl .num,.tbl .sub{text-align:left}
  .nav-in{gap:8px}
  .stamp{margin-left:0;width:100%}
}
`;

function suiteTable(t: TargetData): string {
  const suites = (t.dash?.suites ?? []) as Any[];
  if (suites.length === 0) return `<div class="list"><div class="empty">The hub has no finished run recorded for this target. Nothing is claimed about it.</div></div>`;
  const rows = suites
    .map((s) => {
      const state = s.regression
        ? `<span class="chip bad">regressed</span>`
        : s.baseline === null || s.baseline === undefined
          ? `<span class="chip mute">no baseline</span>`
          : `<span class="chip ok">at or above</span>`;
      return `<tr class="${s.regression ? "bad" : ""}">
      <td class="name" data-l="Suite">${esc(s.suite)}</td>
      <td class="num" data-l="Score">${num(s.score, { digits: 2 })}</td>
      <td class="num" data-l="Baseline">${num(s.baseline, { digits: 2, reason: "never promoted" })}</td>
      <td class="num" data-l="Delta">${delta(s.delta)}</td>
      <td data-l="State">${state}</td>
      <td class="sub" data-l="Cases">${num(s.casesPerRun)}</td>
      <td class="sub" data-l="Runs">${num(s.runs)}</td>
      <td class="sub" data-l="p50">${ms(s.p50Ms)}</td>
      <td class="sub" data-l="p95">${ms(s.p95Ms)}</td>
      <td class="sub" data-l="Last run">${ts(s.lastRunAt)}</td>
    </tr>`;
    })
    .join("\n");
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>
    <th>Suite</th><th style="text-align:right">Score</th><th style="text-align:right">Baseline</th>
    <th style="text-align:right">Delta</th><th>State</th><th style="text-align:right">Cases</th>
    <th style="text-align:right">Runs</th><th style="text-align:right">p50</th>
    <th style="text-align:right">p95</th><th style="text-align:right">Last run</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
}

const targetBlocks = targets
  .map((t) => {
    const r = t.report;
    const head = r?.headline
      ? `<div class="headline">${esc(r.headline)}</div>`
      : `<div class="headline">The hub returned no report for this target, so this page states nothing about it.</div>`;
    const p = posture(t);
    return `<div class="tgt-h"><b>${esc(t.name)}</b><span>kind ${esc(t.kind)} &middot; ${p.label} &middot; ${p.verdictLabel} ${
      r?.verdict ? esc(r.verdict) : "unavailable"
    } &middot; sha ${r?.sha ? esc(String(r.sha).slice(0, 12)) : "unavailable"} &middot; window ${num(r?.windowDays, { suffix: "d" })}</span></div>
    <div class="is-not">${p.note}</div>
    ${head}
    ${suiteTable(t)}`;
  })
  .join("\n");

const notCoveredBlocks = targets
  .map((t) => {
    const items = (t.report?.notCovered ?? []) as string[];
    if (items.length === 0)
      return `<div class="list"><div class="row"><b>${esc(t.name)}</b>The hub returned no limits block for this target, which means it returned no report. Absence of a caveat here is absence of data.</div></div>`;
    return `<div class="list"><div class="row"><b>${esc(t.name)} &middot; derived by the hub, printed verbatim</b>${items
      .map((i) => `<div style="margin:0 0 9px">${esc(i)}</div>`)
      .join("")}</div></div>`;
  })
  .join("\n");

const safetyBlocks = targets
  .map((t) => {
    const s = t.report?.safety as Any | undefined;
    if (!s || !s.probes)
      return `<div class="list"><div class="row"><b>${esc(t.name)}</b>No safety probe suite has ever reported to the hub for this target. This page therefore publishes <span class="unk">unavailable</span> for its safety score — not a zero, and not a pass. Probes exist in the product repo; a probe that was never run against the hub is not a measurement.</div></div>`;
    const suiteRow = (t.dash?.suites ?? []).find((x: Any) => x.suite === s.suite) as Any | undefined;
    return `<div class="list"><div class="row"><b>${esc(t.name)} &middot; suite ${esc(s.suite ?? "unnamed")}</b>${num(s.probes)} probe(s), scoring ${num(
      s.score,
      { digits: 2 }
    )}, measured ${ts(s.measuredAt)}, baseline ${num(suiteRow?.baseline, { digits: 2, reason: "never promoted — this suite cannot fail the gate yet" })}.
    A probe set of this size never certifies safety: it reports findings over the probes it ran.
    <div class="is-not">Per-category numbers are NOT published here, because the service exposes none: it records
    the suite's score, not a breakdown by category. The weakest category is named in the failures section below,
    from a build log, and is labelled there as not service-verified.</div></div></div>`;
  })
  .join("\n");

const alertBlock = (() => {
  if (!alertsAll) return `<div class="list"><div class="empty">The alerts endpoint did not answer. Nothing is claimed about alerting.</div></div>`;
  if (alertRows.length === 0)
    return `<div class="list"><div class="empty">The hub has recorded ${num(alertsAll.count)} alert(s). An empty list here is an absence of recorded alerts, not evidence that nothing went wrong.</div></div>`;
  return `<div class="list">${alertRows
    .slice(0, 20)
    .map(
      (a) =>
        `<div class="row"><b>${esc(a.kind)} &middot; ${esc(a.target)} / ${esc(a.suite)} &middot; ${ts(a.createdAt)} &middot; ${
          a.ack ? "acknowledged" : "open"
        }</b>${esc(a.message)}</div>`
    )
    .join("")}${
    alertRows.length > 20
      ? `<div class="row"><b>cap</b>${esc(alertRows.length - 20)} further alert(s) exist and are not listed here. The cap is stated, never silent.</div>`
      : ""
  }</div>`;
})();

const failureBlocks = failures
  .map(
    (f) => `<article class="fail ${esc(f.status)}">
    <div class="fail-h"><b>${esc(f.title)}</b><s>${esc(f.id)} &middot; ${esc(f.date)} &middot; ${esc(f.status)}</s></div>
    <p>${esc(f.what)}</p>
    <p class="lesson">${esc(f.lesson)}</p>
    <p class="prov">${
      f.hubVerified
        ? "HUB-VERIFIED &mdash; the numbers in this entry are recorded in the Eval Hub database."
        : "NOT HUB-VERIFIED &mdash; the numbers in this entry come from a build log, not from a hub record. Treat them as a written account, not a measurement."
    } SOURCE: ${esc(f.provenance.source)} &middot; ${esc(f.provenance.ref)}</p>
  </article>`
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="How VVDex evaluates its AI systems: golden suites, baselines, an uncalibrated judge that gates nothing, safety probes that certify nothing, and the failures this platform has already made.">
<title>VVDexOps &middot; how we evaluate our AI systems</title>
<style>${CSS}</style></head>
<body>
<nav class="nav"><div class="nav-in">
  <span class="brand"><i></i><b>VVDEXOPS &middot; EVALS</b><s>methodology</s></span>
  <span class="stamp">generated ${esc(generatedAt)}</span>
</div></nav>

<div class="wrap">
  <div class="rail">
    <div class="${hubUp ? "live" : "down"}"><i></i>eval hub ${hubUp ? "reachable" : "unreachable"}</div>
    <div>targets <b>${num(targetsCount)}</b></div>
    <div>deploy-gating <b>${num(gatedCount)}</b></div>
    <div>suites <b>${num(suitesCount)}</b></div>
    <div>window <b>${num(DAYS, { suffix: "d" })}</b></div>
    <div>regression tolerance <b>${num(regressionPct, { suffix: "pts" })}</b></div>
    <div>staleness alarm <b>${num(staleHours, { suffix: "h" })}</b></div>
  </div>

  <section class="hero">
    <p class="count">${num(totalCases)}</p>
    <p class="count-cap">Cases evaluated &middot; latest run of every suite the hub knows about</p>
    <h1>What we measure, what it proves, and <em>where it has already failed us.</em></h1>
    <p class="lede">This page is generated from the evaluation service's own records. Every number on it was
      read from that service at the moment of generation; nothing here was typed by hand, and where a
      number does not exist the page says <span class="unk">unavailable</span> rather than showing you a
      zero that looks like a result.</p>
    <p class="lede">It publishes the weak numbers too. A dead claim gets published here, not buried &mdash;
      that is the same rule that killed an earlier accuracy claim of ours in public.</p>
  </section>

  <dl class="strip">
    <div><dt>Targets under evaluation</dt><dd>${num(targetsCount)}</dd></div>
    <div><dt>Of those, deploy-gating</dt><dd>${num(gatedCount, { reason: "a target dashboard did not answer, so no posture can be counted" })}</dd></div>
    <div><dt>Advisory &mdash; blocking nothing</dt><dd>${num(advisoryCount, { reason: "a target dashboard did not answer, so no posture can be counted" })}</dd></div>
    <div><dt>Suites with recorded runs</dt><dd>${num(suitesCount)}</dd></div>
    <div><dt>Cases in latest runs</dt><dd>${num(totalCases)}</dd></div>
    <div><dt>Suites regressed right now</dt><dd>${num(regressedCount)}</dd></div>
    <div><dt>Human labels recorded</dt><dd>${num(totalLabels, { reason: missingReason("no label has been recorded") })}</dd></div>
    <div><dt>Judge kappa</dt><dd>${
      kappaRow ? num(kappaRow.kappa, { digits: 3 }) : unk(missingReason("no kappa has ever been computed"))
    }</dd></div>
    <div><dt>Safety probes recorded</dt><dd>${
      totalSafetyProbes ? num(totalSafetyProbes) : unk(missingReason("no safety suite has reported to the hub"))
    }</dd></div>
    <div><dt>Alerts the hub has raised</dt><dd>${num(alertsAll?.count)}</dd></div>
  </dl>

  <section class="sec">
    <div class="sec-h"><h2>What a golden suite is</h2><span>and what it is not</span></div>
    <div class="prose">
      <p>A <strong>golden suite</strong> is a versioned file of test cases that lives in the product's own
      repository, one JSON object per line, each with an input and the expected outcome. The product's
      runner executes the <strong>real engine function</strong> on each case &mdash; not a mock, not a
      description of the engine &mdash; and pushes every case result to the evaluation service, which
      stores the run and computes the score. Suites run before a release and again nightly.</p>
      <p>A golden suite is <strong>not</strong> production traffic. It is a curated set of cases someone
      chose. It says what the engine does on those cases, on the day they were run, and nothing about the
      requests no case represents. When a suite scores 100, the honest sentence is "every case we wrote
      passed", never "it works".</p>
    </div>
    <dl class="defs">
      <div><dt>Baseline</dt><dd>The score of a run that was explicitly <em>promoted</em> after a green
        deploy. It becomes the bar. A suite with no promoted baseline cannot fail the gate however low it
        scores &mdash; that is stated on this page wherever it applies rather than hidden.</dd></div>
      <div><dt>Regression</dt><dd>${regDef ? esc(regDef) : unk("the hub did not return its regression definition")}</dd></div>
      <div><dt>The gate</dt><dd>A command a deploy can run. It exits 0 to pass, 1 when a suite regressed,
        and <em>2 when no evals ran at all</em> &mdash; a deploy without evidence fails loudly instead of
        slipping through.</dd>
        <div class="is-not">It gates on the deterministic suites only. The model-dependent suites run
        nightly and alert; they do not block a release.</div>
        <div class="is-not">It does not run for every target on this page. ${num(gatedCount)} of
        ${num(targetsCount)} target(s) declare a deploy-gating posture; the rest are measured and
        published and block nothing. Each target's block below states which it is, and how many gate
        checks this service has actually answered for it.</div></div>
      <div><dt>Latency percentiles</dt><dd>${pctDef ? esc(pctDef) : unk("the hub did not return its percentile definition")}</dd></div>
      <div><dt>Shadow &mdash; here</dt><dd>${shadowDef ? esc(shadowDef) : unk("the hub did not return its shadow definition")}</dd></div>
      <div><dt>Canary &mdash; here</dt><dd>${canaryDef ? esc(canaryDef) : unk("the hub did not return its canary definition")}</dd></div>
    </dl>
  </section>

  <section class="sec">
    <div class="sec-h"><h2>The numbers</h2><span>every value below was read from the evaluation service at generation time</span></div>
    ${targetBlocks}
  </section>

  <section class="sec">
    <div class="sec-h"><h2>The judge</h2><span>uncalibrated means advisory</span></div>
    <div class="prose">
      <p>Some surfaces cannot be scored by string comparison, so a second model reads the output against a
      rubric and returns a verdict. That judge is only worth what its agreement with a human is worth, and
      that agreement is a measured number &mdash; Cohen's kappa against human labels on the same cases.</p>
      <p><strong>Right now that number does not exist.</strong> Human labels recorded:
      ${num(totalLabels, { reason: missingReason("no label has been recorded") })}. Kappa: ${kappaRow ? num(kappaRow.kappa, { digits: 3 }) : unk(missingReason("never computed"))}.
      Until a kappa exists, every judge verdict is <strong>advisory</strong>: it is recorded, it is shown, and
      it <strong>gates nothing</strong>. The service enforces this rather than trusting us to remember &mdash; it
      refuses to compute a kappa on fewer than twenty labelled pairs, because a kappa over five cases is
      theatre, and a judge score can never flip a deterministic failure into a pass.</p>
    </div>
    <div class="list">${targets
      .map(
        (t) =>
          `<div class="row"><b>${esc(t.name)}</b>calibration status <strong>${esc(
            t.report?.calibration?.status ?? "unavailable"
          )}</strong> &middot; kappa ${num(t.report?.calibration?.kappa, { digits: 3, reason: "never computed" })} &middot; labelled pairs ${num(
            t.report?.calibration?.n
          )} &middot; human labels ${num(t.report?.calibration?.labels)} &middot; judge model ${
            t.report?.calibration?.judgeModel ? esc(t.report.calibration.judgeModel) : unk("no calibration row exists")
          }</div>`
      )
      .join("")}</div>
  </section>

  <section class="sec">
    <div class="sec-h"><h2>Safety probes</h2><span>a probe set never certifies safety</span></div>
    <div class="prose">
      <p>Safety cases are <strong>probes with expectations</strong>: an input, and a rule for what the answer
      must and must not contain. They are checked deterministically first &mdash; refusal detection, forbidden
      and required strings &mdash; and the judge is consulted only where a case is tagged as needing judgment,
      where its verdict is advisory and cannot rescue a deterministic failure. Over-refusal counts as a
      failure too: a product that refuses someone who needed help has failed them.</p>
      <p>The honest sentence about a probe run is "<strong>N findings over M probes</strong>". It is never
      "safe". Absence of a finding is absence of a finding.</p>
    </div>
    ${safetyBlocks}
  </section>

  <section class="sec">
    <div class="sec-h"><h2>What this does not cover</h2><span>derived by the service from the same data as the numbers above</span></div>
    <div class="prose"><p>This block is not written for this page. The evaluation service assembles it by rule
    from the same rows it scored, so the limits cannot drift out of sync with the numbers. It is printed here
    exactly as the service returned it.</p></div>
    ${notCoveredBlocks}
  </section>

  <section class="sec">
    <div class="sec-h"><h2>Alerts raised</h2><span>including the ones against ourselves</span></div>
    ${alertBlock}
  </section>

  <section class="sec">
    <div class="sec-h"><h2>Failures we publish</h2><span>written records from the build log &mdash; marked as such</span></div>
    <div class="prose"><p>Everything above this line came from the evaluation service. Everything below it is
    <strong>written prose</strong> about defects this platform found, including defects in itself. Where an
    entry carries a number that the service never recorded, the entry says so on its face. That distinction is
    the point: a record is not a measurement.</p></div>
    ${failureBlocks}
  </section>

  <div class="foot">
    <b>Provenance</b>
    <ul>${provenance.map((p) => `<li>${esc(p.path)} &rarr; ${esc(p.status)} &middot; ${esc(p.at)}</li>`).join("")}</ul>
    <ul>
      <li>generated ${esc(generatedAt)} by scripts/methodology.mts from the evaluation service's own API</li>
      <li>the service runs on loopback on the products host; this page is a static render of what it answered</li>
      <li>no number on this page was typed by hand, except inside entries explicitly marked NOT HUB-VERIFIED</li>
      <li>this page makes no external request: no CDN, no font service, no image, no analytics</li>
    </ul>
  </div>
</div>
</body></html>
`;

// ── the zero-external-request gate — mechanical, and able to fail ──────────────────────────────
const schemeHits = html.match(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\//g) ?? [];
const tagHits = html.match(/<(img|script|link|iframe|video|audio|source|object|embed)\b/gi) ?? [];
const urlFnHits = html.match(/url\(/gi) ?? [];
if (schemeHits.length || tagHits.length || urlFnHits.length) {
  console.error(
    `[methodology] REFUSING TO WRITE: the page is not self-contained. scheme strings=${JSON.stringify(schemeHits.slice(0, 5))} ` +
      `remote-capable tags=${JSON.stringify(tagHits.slice(0, 5))} css url()=${urlFnHits.length}`
  );
  process.exit(1);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html, "utf8");
console.log(`[methodology] wrote ${OUT} (${Buffer.byteLength(html, "utf8")} bytes)`);
console.log(
  `[methodology] hub=${hubUp ? "reachable" : "UNREACHABLE"} targets=${targets.length} suites=${allSuites.length} ` +
    `cases=${totalCases ?? "unavailable"} labels=${totalLabels ?? "unavailable"} kappa=${kappaRow ? kappaRow.kappa : "unavailable"} ` +
    `safetyProbes=${totalSafetyProbes ? totalSafetyProbes : "unavailable"} alerts=${alertsAll?.count ?? "unavailable"} ` +
    `failureRegister=${failures.length}`
);
console.log(`[methodology] endpoints read: ${provenance.map((p) => `${p.path}[${p.status}]`).join(" ")}`);
console.log("[methodology] self-contained check PASSED: 0 scheme strings, 0 remote-capable tags, 0 css url()");

if (DATA_OUT) {
  const payload = { generatedAt, hub: { reachable: hubUp }, provenance, targets, alerts: alertsAll, register: failures };
  await mkdir(dirname(DATA_OUT), { recursive: true });
  await writeFile(DATA_OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[methodology] wrote ${DATA_OUT} — the exact API payloads this page was rendered from`);
}
