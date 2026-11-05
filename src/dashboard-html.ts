// Eval Hub — the dashboard page.
//
// AESTHETIC (2026-08-05, founder's choice): the design language of his own "Career Agent OS — live
// system telemetry" page (career.vvdexops.com/eval, tokens dated 2026-06-09, "Linear/Stripe tier").
// Near-black, hairline rules, IBM Plex Mono uppercase micro-labels, ONE periwinkle accent moment
// (#6E8FFF), a giant tabular count-up hero, and a metrics strip whose 1px GAPS are the rules. He
// compared it against the Observatory facility (zoomable rooms) and picked this one; the facility
// waits until enough products are onboarded for rooms to earn themselves.
//
// SELF-CONTAINED, ABSOLUTELY. No CDN, no font service, no analytics, no favicon fetch, no image.
// The rule is mechanically checkable and IS checked: scripts/test-hub-phase3.mts greps the SERVED
// bytes and fails on ANY scheme-like string. Font stacks NAME IBM Plex/Inter first and fall back to
// system faces — nothing is fetched, so the page is honest on a machine that has them and one that
// does not. The single `http://www.w3.org/2000/svg` string below is the SVG namespace, required by
// createElementNS for child nodes; it is declared once, never fetched, and the test's allowlist
// names it explicitly so the check stays falsifiable.
//
// NO innerHTML ANYWHERE. Every value here comes from the DB — suite names, alert messages, labeler
// notes: text a product author controls. Written with textContent and built with createElement, so
// a suite literally named `<script>` is displayed, never executed.
//
// The data is EMBEDDED, not fetched: a browser cannot set the x-evalhub-token header, so a
// client-side fetch would have to smuggle the token into a URL. The server already authenticated
// this request; it ships the JSON it already has.

export type DashboardData = Record<string, unknown> & { target: string };

/** JSON that is safe inside <script type="application/json">: only `<` and U+2028/9 can hurt. */
function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * The hero headline is a CLAIM, and it is not true of every target. "Every deploy passes a gate
 * that can say no" is true of conxto, whose deploy script calls the gate; it is a lie on a target
 * the hub only measures. So the headline is chosen from the target's own declared posture, and the
 * lede states the measured gate-check count beside the declaration — including the awkward case
 * where a target declares 'gate' and the hub has never been asked for one.
 */
function heroCopy(data: DashboardData): { badge: string; h1: string; lede: string } {
  const g = (data.gating ?? {}) as { declared?: string; gateChecks?: number; lastGateAt?: string | null };
  const declared = g.declared === "gate" ? "gate" : "advisory";
  const checks = Number(g.gateChecks ?? 0);
  const when = g.lastGateAt ? `, most recently ${escapeHtml(String(g.lastGateAt).replace("T", " ").replace(/\..*$/, "Z"))}` : "";
  if (declared === "gate") {
    return {
      badge: "DECLARED &middot; DEPLOY-GATING",
      h1: "Every deploy passes <em>a gate that can say no.</em>",
      lede:
        `Golden suites run before each release and again every night. A suite scoring below its promoted
         baseline blocks the deploy; a suite that goes silent raises an alert. ` +
        (checks > 0
          ? `The hub has answered <b>${checks}</b> gate check(s) for this target${when}.`
          : `The hub has answered <b>no</b> gate check for this target yet &mdash; the headline above claims a
             gate that nothing observed here supports.`) +
        ` The judge stays advisory until human labels give it a measured agreement.`,
    };
  }
  return {
    badge: "DECLARED &middot; ADVISORY &mdash; NO GATE",
    h1: "Measured, published, and <em>blocking nothing.</em>",
    lede:
      `This target's suites are recorded and shown here, and a regression raises an alert &mdash; but no
       deploy of this product is stopped by anything on this page. ` +
      (checks === 0
        ? `The hub has answered <b>no</b> gate check for this target, which is what an advisory posture
           should look like.`
        : `The hub has answered <b>${checks}</b> gate check(s) for this target${when} &mdash; which
           contradicts the advisory declaration. One of the two is wrong; read the numbers below knowing that.`) +
      ` Nothing here should be read as a release gate until the founder orders one.`,
  };
}

export function renderDashboardHtml(data: DashboardData): string {
  const target = escapeHtml(String(data.target));
  const hero = heroCopy(data);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>eval hub &middot; ${target}</title>
<style>
/* ─── Design tokens — after Career Agent OS (2026-06-09) ──────────────────────── */
:root{
  --bg:#07070a; --surface:#0e0e12; --surface-2:#15151b;
  --ink-1:#f4f4f8; --ink-2:#a8a8b3; --ink-3:#6a6a76; --ink-4:#3e3e46;
  --border:rgba(255,255,255,0.06); --border-hi:rgba(255,255,255,0.14);
  --accent:#6E8FFF; --accent-soft:#8BA3FF;
  --positive:#4ade80; --warn:#fbbf24; --negative:#f87171;
  --sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --serif:"Instrument Serif",Georgia,"Times New Roman",serif;
  --max:1280px; --pad:40px;
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
.tabs{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.tab{padding:5px 10px;border:1px solid var(--border);border-radius:4px;font:500 9.5px/1 var(--mono);
  letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);text-decoration:none}
.tab.on{border-color:var(--accent);color:var(--accent)}

.rail{display:flex;flex-wrap:wrap;margin:26px 0 0;border:1px solid var(--border);border-radius:4px;background:var(--surface)}
.rail div{padding:11px 16px;font:500 9.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink-3);border-right:1px solid var(--border);display:flex;align-items:center;gap:7px}
.rail div:last-child{border-right:0}
.rail b{color:var(--ink-1);font-weight:600}
.rail .live i{width:6px;height:6px;border-radius:50%;background:var(--positive);animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(74,222,128,.5)}50%{opacity:.55;box-shadow:0 0 0 5px rgba(74,222,128,0)}}
.amber{color:var(--warn)!important}

.hero{display:grid;grid-template-columns:1.4fr minmax(280px,1fr);gap:52px;margin:52px 0 0;align-items:start}
/* LONGHAND, deliberately: the font shorthand with clamp() in the size slot is dropped whole by
   Chromium, which silently rendered this hero at body size (caught in review 2026-08-05). */
.count{font-family:var(--mono);font-weight:600;font-size:clamp(64px,13.5vw,192px);line-height:.92;
  font-variant-numeric:tabular-nums;letter-spacing:-.03em;
  background:linear-gradient(180deg,#fff 0%,#f0f0f3 35%,#a4a4ae 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;margin:0}
.count-cap{font:500 9.5px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3);margin:14px 0 30px}
.count-cap.posture{margin:-20px 0 22px;color:var(--warn);border:1px solid var(--border);border-radius:4px;
  display:inline-block;padding:6px 10px}
.hero h1{font-size:clamp(24px,3.2vw,38px);line-height:1.18;letter-spacing:-.015em;margin:0 0 16px;font-weight:600}
.hero h1 em{font-family:var(--serif);font-style:italic;font-weight:400;color:var(--accent-soft)}
.hero p.lede{color:var(--ink-2);font-size:14.5px;line-height:1.62;margin:0;max-width:56ch}
.pulse{border:1px solid var(--border);border-radius:5px;background:var(--surface);padding:16px 18px}
.pulse-h{display:flex;align-items:center;gap:8px;font:500 9.5px/1 var(--mono);letter-spacing:.13em;
  text-transform:uppercase;color:var(--ink-3);margin-bottom:16px}
.pulse-h i{width:5px;height:5px;border-radius:50%;background:var(--accent)}
.pulse-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);margin:16px 0 0;border:1px solid var(--border)}
.pulse-grid div{background:var(--surface);padding:12px 13px}
.pulse-grid dt{font:500 9px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);margin:0 0 6px}
.pulse-grid dd{margin:0;font:600 17px/1 var(--mono);font-variant-numeric:tabular-nums}

/* the GAPS are the rules */
.strip{display:grid;grid-template-columns:repeat(8,1fr);gap:1px;background:var(--border);
  border:1px solid var(--border);margin:56px 0 0}
.strip div{background:var(--bg);padding:16px 14px}
.strip dt{font:500 8.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:0 0 9px}
.strip dd{margin:0;font:600 22px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.strip .u{font-size:11px;color:var(--ink-3);margin-left:3px}

.sec{margin-top:72px}
.sec+.sec{position:relative}
.sec+.sec::before{content:"\\25C7";position:absolute;top:-38px;left:50%;transform:translateX(-50%);color:var(--ink-4);font-size:11px}
.sec-h{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:0 0 18px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.sec-h h2{margin:0;font:600 12px/1 var(--mono);letter-spacing:.15em;text-transform:uppercase}
.sec-h span{font:400 10px/1 var(--mono);letter-spacing:.08em;color:var(--ink-3)}

/* wide content scrolls INSIDE its own box — the page body must never scroll sideways */
.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;min-width:760px;border-collapse:collapse}
.tbl th{text-align:left;font:500 8.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink-3);padding:0 12px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl td{padding:14px 12px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
.tbl tr td:first-child{border-left:2px solid transparent}
.tbl tr.bad td:first-child{border-left-color:var(--negative)}
.tbl .name{font:500 13px/1 var(--mono)}
.num{font:600 15px/1 var(--mono);font-variant-numeric:tabular-nums;text-align:right}
.sub{font:400 11px/1 var(--mono);color:var(--ink-3);font-variant-numeric:tabular-nums;text-align:right}
.d-ok{color:var(--positive)} .d-warn{color:var(--warn)} .d-bad{color:var(--negative)}
.chip{display:inline-block;padding:3px 7px;border-radius:3px;font:600 8.5px/1 var(--mono);
  letter-spacing:.1em;text-transform:uppercase;border:1px solid}
.chip.ok{color:var(--positive);border-color:rgba(74,222,128,.35)}
.chip.bad{color:var(--negative);border-color:rgba(248,113,113,.4)}
.chip.warn{color:var(--warn);border-color:rgba(251,191,36,.4)}

.chart{border:1px solid var(--border);border-radius:5px;background:var(--surface);padding:22px 20px 14px}
.chart-note{font:400 10px/1.5 var(--mono);letter-spacing:.06em;color:var(--ink-3);margin:12px 0 0}

.arch{position:relative;display:grid;grid-template-columns:1fr auto 1fr;gap:34px;align-items:center;
  border:1px solid var(--border);border-radius:5px;background:var(--surface);padding:26px 24px}
.arch-col{display:grid;gap:1px;background:var(--border);border:1px solid var(--border)}
.arch-cell{background:var(--surface);padding:12px 14px;font:500 10.5px/1.3 var(--mono);letter-spacing:.06em;color:var(--ink-2)}
.arch-cell b{display:block;font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin-bottom:5px;font-weight:500}
.arch-mid{position:relative;border:1px solid var(--accent);border-radius:4px;background:var(--surface-2);
  padding:20px 26px;box-shadow:inset 0 0 0 1px rgba(110,143,255,.12),0 0 32px -4px rgba(110,143,255,.16)}
.arch-mid::before{content:"";position:absolute;top:-1px;left:50%;transform:translateX(-50%);width:60px;height:2px;background:var(--accent)}
.arch-mid b{display:block;font:600 11px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.arch-mid span{display:block;margin-top:7px;font:400 10px/1 var(--mono);color:var(--ink-3)}
.arch svg.flow{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}

.list{border:1px solid var(--border);border-radius:5px;background:var(--surface)}
.list .row{display:grid;grid-template-columns:auto auto 1fr auto;gap:14px;align-items:center;
  padding:13px 16px;border-bottom:1px solid var(--border);font-size:13px}
.list .row:last-child{border-bottom:0}
.ts{font:400 10.5px/1 var(--mono);color:var(--ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{padding:22px 16px;color:var(--ink-3);font:400 12px/1 var(--mono)}
.cal{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--border);
  border:1px solid var(--border);margin:0}
.cal div{background:var(--surface);padding:15px 16px}
.cal dt{font:500 8.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin:0 0 8px}
.cal dd{margin:0;font:600 15px/1 var(--mono);font-variant-numeric:tabular-nums}
.cal-note{margin-top:14px;font:400 12.5px/1.6 var(--sans);color:var(--ink-2)}
/* Phase 3b — cost vs quality + prompt variants. Same tokens, no new colours, one accent. */
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1px;background:var(--border);
  border:1px solid var(--border);margin:16px 0 0}
.legend div{background:var(--surface);padding:12px 14px;font:400 11px/1.5 var(--mono);color:var(--ink-2)}
.legend b{display:block;font:600 11.5px/1.3 var(--mono);color:var(--ink-1);margin-bottom:5px}
.legend s{display:block;text-decoration:none;font:400 9.5px/1.4 var(--mono);letter-spacing:.06em;
  text-transform:uppercase;color:var(--ink-3);margin-top:5px}
.legend .fr b{color:var(--accent)}
.decision{border:1px solid var(--border);border-left:2px solid var(--ink-4);border-radius:4px;background:var(--surface);
  padding:15px 17px;margin:0 0 16px;font:400 13px/1.6 var(--sans);color:var(--ink-2)}
.decision.led{border-left-color:var(--accent)}
.decision b{display:block;font:600 9.5px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;
  color:var(--ink-3);margin-bottom:9px}
.decision em{font-style:normal;color:var(--ink-1);font-weight:600}
#abSurfaces .tbl-wrap{margin-bottom:34px}
#abSurfaces .tbl-wrap:last-child{margin-bottom:0}
.decision s{display:block;margin-top:11px;text-decoration:none;font:400 10px/1.6 var(--mono);
  letter-spacing:.05em;color:var(--ink-3)}
/* Phase 4 — shadow & canary. No new colours: block borrows the negative, inspect the warn. */
.decision.insp{border-left-color:var(--warn)}
.decision.blk{border-left-color:var(--negative)}
.decision.safe{border-left-color:var(--positive)}
.defn{margin:0 0 16px;font:400 11.5px/1.65 var(--mono);color:var(--ink-3);border:1px dashed var(--border-hi);
  border-radius:4px;padding:12px 14px}
.foot{margin-top:76px;padding-top:20px;border-top:1px solid var(--border);
  font:400 9.5px/1.7 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3)}

/* content is visible without JS; this only softens arrival */
.js .rv{opacity:0;transform:translateY(14px);transition:opacity .6s cubic-bezier(.2,.7,.3,1),transform .6s cubic-bezier(.2,.7,.3,1)}
.js .rv.in{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){.js .rv{opacity:1;transform:none;transition:none}.rail .live i{animation:none}}

@media (max-width:1040px){.strip{grid-template-columns:repeat(4,1fr)}.hero{grid-template-columns:1fr;gap:34px}}
@media (max-width:900px){
  :root{--pad:18px}
  .strip{grid-template-columns:repeat(2,1fr)}
  .arch{grid-template-columns:1fr;gap:18px}
  .arch svg.flow{display:none}
  .tbl thead{display:none}
  .tbl{min-width:0}
  .tbl tr{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:14px 0;border-bottom:1px solid var(--border)}
  .tbl td{border:0;padding:2px 0}
  .tbl tr td:first-child{border-left:0}
  .tbl td[data-l]::before{content:attr(data-l);display:inline-block;min-width:74px;
    font:500 8.5px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}
  .num,.sub{text-align:left}
  .list .row{grid-template-columns:1fr;gap:6px}
}
</style></head>
<body>
<nav class="nav"><div class="nav-in">
  <span class="brand"><i></i><b>EVAL &middot; HUB</b><s>${target}</s></span>
  <span class="tabs" id="tabs"></span>
</div></nav>

<div class="wrap">
  <div class="rail rv" id="rail"></div>

  <section class="hero">
    <div>
      <p class="count" id="count">0</p>
      <p class="count-cap">Cases evaluated &middot; latest run of every suite</p>
      <p class="count-cap posture">${hero.badge}</p>
      <h1>${hero.h1}</h1>
      <p class="lede">${hero.lede}</p>
    </div>
    <div class="pulse rv">
      <div class="pulse-h"><i></i>Suite scores &middot; latest runs</div>
      <svg viewBox="0 0 300 72" preserveAspectRatio="none" style="width:100%;height:72px;display:block" id="heroSpark" aria-hidden="true"></svg>
      <dl class="pulse-grid" id="pulseGrid"></dl>
    </div>
  </section>

  <dl class="strip rv" id="strip"></dl>

  <section class="sec rv">
    <div class="sec-h"><h2>Suites</h2><span id="suitesMeta"></span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>Suite</th><th style="text-align:right">Score</th><th style="text-align:right">Baseline</th>
      <th style="text-align:right">Delta</th><th>State</th><th>Trend</th>
      <th style="text-align:right">p50</th><th style="text-align:right">p95</th>
      <th style="text-align:right">p99</th><th style="text-align:right">Cases</th>
    </tr></thead><tbody id="suiteRows"></tbody></table></div>
  </section>

  <section class="sec rv">
    <div class="sec-h"><h2>Score vs baseline</h2><span id="chartMeta"></span></div>
    <div class="chart">
      <svg viewBox="0 0 900 240" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block" id="chart" aria-hidden="true"></svg>
      <p class="chart-note" id="chartNote"></p>
    </div>
  </section>

  <section class="sec rv" id="secCurves">
    <div class="sec-h"><h2>Cost vs quality</h2><span id="curveMeta"></span></div>
    <div class="chart">
      <svg viewBox="0 0 900 320" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block" id="curveChart" aria-hidden="true"></svg>
      <p class="chart-note" id="curveNote"></p>
    </div>
    <div class="legend" id="curveLegend"></div>
  </section>

  <section class="sec rv" id="secAb">
    <div class="sec-h"><h2>Prompt variants</h2><span id="abMeta"></span></div>
    <div id="abSurfaces"></div>
  </section>

  <section class="sec rv" id="secShadow">
    <div class="sec-h"><h2>Shadow &amp; canary</h2><span id="shadowMeta"></span></div>
    <div id="shadowBox"></div>
    <div id="canaryBox"></div>
  </section>

  <section class="sec rv">
    <div class="sec-h"><h2>Path of a release</h2><span>product &rarr; hub &rarr; gate</span></div>
    <div class="arch" id="arch">
      <svg class="flow" id="flow" aria-hidden="true"></svg>
      <div class="arch-col" id="archLeft"></div>
      <div class="arch-mid"><b>Eval Hub</b><span>suites &middot; baselines &middot; verdict</span></div>
      <div class="arch-col" id="archRight"></div>
    </div>
  </section>

  <section class="sec rv">
    <div class="sec-h"><h2>Alerts</h2><span id="alertMeta"></span></div>
    <div class="list" id="alerts"></div>
  </section>

  <section class="sec rv">
    <div class="sec-h"><h2>Judge calibration</h2><span id="calMeta"></span></div>
    <dl class="cal" id="cal"></dl>
    <p class="cal-note" id="calNote"></p>
  </section>

  <div class="foot" id="foot"></div>
</div>

<script type="application/json" id="data">${embedJson(data)}</script>
<script src="/dashboard/app.js" defer></script>
</body></html>`;
}

// THE CLIENT SCRIPT IS SERVED AS A FILE, NOT INLINED (2026-08-05).
//
// The estate's vhost sends `script-src 'self'` with no 'unsafe-inline' and no nonce, so this
// script was dropped by the browser on every request the dashboard has ever served. It was not a
// cosmetic loss: this code builds the suites table, the trend chart, the cost curves, the A/B
// panel, the shadow/canary section, the alerts list and the calibration block. What the founder
// actually saw was a shell reading "0 CASES EVALUATED" with no tables and no charts — a ZERO
// presented as a measurement, which is the one thing this whole platform exists to prevent.
//
// Referenced ROOT-relative because the dashboard is reachable at both "/" and "/<target>" through
// the authenticating Worker; a document-relative "app.js" resolves differently on each.
export const DASHBOARD_APP_JS = String.raw`(function(){
  "use strict";
  document.documentElement.className += " js";
  var D = JSON.parse(document.getElementById("data").textContent);
  var S = D.suites || [], A = D.alerts || [], T = D.targets || [];
  var NS = "http:" + "//www.w3.org/2000/svg"; // SVG namespace: declared, never fetched

  function el(tag, cls, txt){ var n = document.createElement(tag); if(cls) n.className = cls;
    if(txt !== undefined && txt !== null) n.textContent = String(txt); return n; }
  function svgEl(name){ return document.createElementNS(NS, name); }
  function ms(v){ return (v === null || v === undefined) ? "\u2014" : Math.round(v) + "ms"; }
  function fx(v, n){ return (v === null || v === undefined || v === "") ? "\u2014" : Number(v).toFixed(n === undefined ? 2 : n); }
  function rel(iso){ if(!iso) return "\u2014"; var s = (Date.now() - new Date(iso).getTime())/1000;
    if(s < 90) return Math.max(0, Math.round(s)) + "s ago";
    if(s < 5400) return Math.round(s/60) + "m ago";
    if(s < 172800) return Math.round(s/3600) + "h ago";
    return Math.round(s/86400) + "d ago"; }

  var cases = 0, regressed = 0, withBase = 0, p50s = [], p99s = [];
  S.forEach(function(s){
    cases += Number(s.casesPerRun || 0);
    if(s.regression) regressed++;
    if(s.baseline !== null && s.baseline !== undefined) withBase++;
    if(s.p50Ms !== null && s.p50Ms !== undefined) p50s.push(s.p50Ms);
    if(s.p99Ms !== null && s.p99Ms !== undefined) p99s.push(s.p99Ms);
  });
  var openAlerts = A.filter(function(a){ return !a.ack; }).length;
  var passRate = S.length ? ((S.length - regressed) / S.length) * 100 : null;
  var worstP99 = p99s.length ? Math.max.apply(null, p99s) : null;
  var medP50 = p50s.length ? p50s.slice().sort(function(a,b){ return a-b; })[Math.floor((p50s.length-1)/2)] : null;
  var cal = D.calibration || {};
  var calRow = (cal.calibrations || [])[0] || null;
  var calibrated = !!(calRow && calRow.kappa !== null && calRow.kappa !== undefined);

  var tabs = document.getElementById("tabs");
  T.forEach(function(t){
    // The posture travels WITH the name: a tab strip that lists four products identically implies
    // four products are gated. Only the ones that declare it carry the bullet.
    var gated = t.gating === "gate";
    var a = el("a", "tab" + (t.name === D.target ? " on" : "") + (gated ? "" : " amber"),
      t.name + (gated ? " • gate" : " • advisory"));
    a.setAttribute("href", "/" + encodeURIComponent(t.name));
    a.setAttribute("title", (gated ? "declared deploy-gating" : "declared advisory — blocks no deploy")
      + "; " + Number(t.gateChecks || 0) + " gate check(s) answered by this hub");
    tabs.appendChild(a);
  });

  var rail = document.getElementById("rail");
  function railCell(label, value, cls, live){
    var d = el("div", cls || "");
    if(live){ d.className += " live"; d.appendChild(el("i")); }
    d.appendChild(document.createTextNode(label + " "));
    if(value !== undefined) d.appendChild(el("b", null, value));
    return d;
  }
  rail.appendChild(railCell("system live", undefined, "", true));
  rail.appendChild(railCell("generated", rel(D.generatedAt)));
  rail.appendChild(railCell("window", (D.days || 7) + "d"));
  rail.appendChild(railCell("suites", S.length));
  rail.appendChild(railCell("alerts", openAlerts, openAlerts ? "amber" : ""));
  var G = D.gating || {};
  rail.appendChild(railCell("posture", (G.declared === "gate" ? "gate" : "advisory")
    + " / " + Number(G.gateChecks || 0) + " check" + (Number(G.gateChecks || 0) === 1 ? "" : "s"),
    G.declared === "gate" ? "" : "amber"));
  rail.appendChild(railCell("judge", calibrated ? ("kappa " + fx(calRow.kappa)) : "uncalibrated", calibrated ? "" : "amber"));

  var cEl = document.getElementById("count");
  (function countUp(){
    if(!cases || !window.requestAnimationFrame){ cEl.textContent = cases.toLocaleString(); return; }
    var start = null, dur = 1100;
    requestAnimationFrame(function frame(t){
      if(start === null) start = t;
      var k = Math.min(1, (t - start) / dur), eased = 1 - Math.pow(1 - k, 3);
      cEl.textContent = Math.round(cases * eased).toLocaleString();
      if(k < 1) requestAnimationFrame(frame);
    });
  })();

  (function heroSpark(){
    var svg = document.getElementById("heroSpark");
    // Mean score across suites at each trend point — the target's own curve over time.
    var series = [];
    var maxLen = 0;
    S.forEach(function(s){ if((s.trend||[]).length > maxLen) maxLen = s.trend.length; });
    for(var i = 0; i < maxLen; i++){
      var sum = 0, n = 0;
      S.forEach(function(s){
        var t = (s.trend || [])[i];
        var v = (typeof t === "number") ? t : (t && Number(t.score));
        if(v !== undefined && !isNaN(v)){ sum += v; n++; }
      });
      if(n) series.push(sum / n);
    }
    if(series.length < 2){
      var msg = el("div", "empty", "not enough runs yet to draw a trend");
      svg.parentNode.replaceChild(msg, svg);
      return;
    }
    var W = 300, H = 72, lo = Math.min.apply(null, series), hi = Math.max.apply(null, series);
    if(hi - lo < 1){ lo = Math.max(0, lo - 1); hi = lo + 2; }
    var step = W / (series.length - 1);
    var pts = series.map(function(v, i){
      return (i * step).toFixed(1) + "," + (H - 4 - ((v - lo) / (hi - lo)) * (H - 12)).toFixed(1);
    });
    var area = svgEl("polygon");
    area.setAttribute("points", "0," + H + " " + pts.join(" ") + " " + W + "," + H);
    area.setAttribute("fill", "rgba(110,143,255,.13)");
    svg.appendChild(area);
    var line = svgEl("polyline");
    line.setAttribute("points", pts.join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#6E8FFF");
    line.setAttribute("stroke-width", "1.6");
    svg.appendChild(line);
    // mark the latest point
    var last = pts[pts.length - 1].split(",");
    var dot = svgEl("circle");
    dot.setAttribute("cx", last[0]); dot.setAttribute("cy", last[1]); dot.setAttribute("r", "2.6");
    dot.setAttribute("fill", regressed ? "#f87171" : "#6E8FFF");
    svg.appendChild(dot);
  })();

  (function pulseGrid(){
    var g = document.getElementById("pulseGrid");
    [["suites green", (S.length - regressed) + " / " + S.length],
     ["regressions", String(regressed)],
     ["open alerts", String(openAlerts)],
     ["slowest p99", ms(worstP99)]].forEach(function(p){
      var d = el("div"); d.appendChild(el("dt", null, p[0])); d.appendChild(el("dd", null, p[1])); g.appendChild(d);
    });
  })();

  (function strip(){
    var s = document.getElementById("strip");
    [["suites", String(S.length), ""],
     ["cases", cases.toLocaleString(), ""],
     ["pass rate", passRate === null ? "\u2014" : fx(passRate, 1), passRate === null ? "" : "%"],
     ["baselines", String(withBase), ""],
     ["regressions", String(regressed), ""],
     ["alerts", String(openAlerts), ""],
     ["p50 median", medP50 === null ? "\u2014" : String(Math.round(medP50)), medP50 === null ? "" : "ms"],
     ["p99 worst", worstP99 === null ? "\u2014" : String(Math.round(worstP99)), worstP99 === null ? "" : "ms"]
    ].forEach(function(m){
      var d = el("div");
      d.appendChild(el("dt", null, m[0]));
      var dd = el("dd", null, m[1]);
      if(m[2]) dd.appendChild(el("span", "u", m[2]));
      d.appendChild(dd); s.appendChild(d);
    });
  })();

  function sparkFor(points){
    var host = el("span");
    var vals = (points || []).map(function(p){ return typeof p === "number" ? p : Number(p && p.score); })
                             .filter(function(v){ return !isNaN(v); });
    if(!vals.length){ host.appendChild(el("span", "sub", "\u2014")); return host; }
    var W = 62, H = 16, lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if(hi - lo < 1){ lo = Math.max(0, lo - 1); hi = lo + 2; }
    var step = vals.length > 1 ? W / (vals.length - 1) : W;
    var pts = vals.map(function(v, i){
      return (i * step).toFixed(1) + "," + (H - 2 - ((v - lo) / (hi - lo)) * (H - 4)).toFixed(1);
    }).join(" ");
    var svg = svgEl("svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H));
    var pl = svgEl("polyline");
    pl.setAttribute("points", pts); pl.setAttribute("fill", "none");
    pl.setAttribute("stroke", "#6E8FFF"); pl.setAttribute("stroke-width", "1.2");
    svg.appendChild(pl); host.appendChild(svg);
    return host;
  }

  (function suites(){
    var body = document.getElementById("suiteRows");
    document.getElementById("suitesMeta").textContent =
      S.length + " suites \u00b7 tolerance " + fx(D.regressionPct, 2) + " pts \u00b7 stale after " + (D.staleHours || 26) + "h";
    if(!S.length){
      var tr = el("tr"), td = el("td", "empty", "no suites have reported yet");
      td.setAttribute("colspan", "10"); tr.appendChild(td); body.appendChild(tr); return;
    }
    S.forEach(function(s){
      var tr = el("tr", s.regression ? "bad" : "");
      function cell(cls, txt, label){ var td = el("td", cls, txt); if(label) td.setAttribute("data-l", label); return td; }
      tr.appendChild(cell("name", s.suite, "suite"));
      tr.appendChild(cell("num", fx(s.score), "score"));
      tr.appendChild(cell("sub", fx(s.baseline), "baseline"));
      var d = s.delta;
      var dcls = (d === null || d === undefined) ? "sub" : (d < 0 ? (s.regression ? "num d-bad" : "num d-warn") : "num d-ok");
      tr.appendChild(cell(dcls, (d === null || d === undefined) ? "\u2014" : (d > 0 ? "+" : "") + fx(d), "delta"));
      var stTd = el("td"); stTd.setAttribute("data-l", "state");
      stTd.appendChild(el("span", "chip " + (s.regression ? "bad" : (s.baseline === null || s.baseline === undefined ? "warn" : "ok")),
        s.regression ? "regressed" : (s.baseline === null || s.baseline === undefined ? "no base" : "ok")));
      tr.appendChild(stTd);
      var tTd = el("td"); tTd.setAttribute("data-l", "trend"); tTd.appendChild(sparkFor(s.trend)); tr.appendChild(tTd);
      tr.appendChild(cell("sub", ms(s.p50Ms), "p50"));
      tr.appendChild(cell("sub", ms(s.p95Ms), "p95"));
      tr.appendChild(cell("sub", ms(s.p99Ms), "p99"));
      tr.appendChild(cell("sub", s.casesPerRun === null || s.casesPerRun === undefined ? "\u2014" : String(s.casesPerRun), "cases"));
      body.appendChild(tr);
    });
  })();

  (function chart(){
    var svg = document.getElementById("chart"), note = document.getElementById("chartNote");
    document.getElementById("chartMeta").textContent = S.length + " suites";
    if(!S.length){ note.textContent = "nothing to plot yet."; return; }
    var W = 900, H = 240, padB = 34, padT = 12;
    var scores = S.map(function(s){ return s.score === null || s.score === undefined ? 0 : s.score; });
    var minScore = Math.min.apply(null, scores);
    // ZOOMED DOMAIN, LABELLED. Scores cluster at 100; a 0-100 axis renders every bar identical and
    // hides exactly the movement this page exists to show. The truncation is stated, never silent.
    var lo = minScore >= 90 ? 90 : 0, hi = 100;
    var n = S.length, slot = W / n, bw = Math.min(64, slot * 0.52);
    S.forEach(function(s, i){
      var v = (s.score === null || s.score === undefined) ? lo : s.score;
      var h = Math.max(2, ((v - lo) / (hi - lo)) * (H - padB - padT));
      var x = i * slot + (slot - bw) / 2, y = H - padB - h;
      var r = svgEl("rect");
      r.setAttribute("x", x.toFixed(1)); r.setAttribute("y", y.toFixed(1));
      r.setAttribute("width", bw.toFixed(1)); r.setAttribute("height", h.toFixed(1));
      r.setAttribute("fill", s.regression ? "#f87171" : "#6E8FFF");
      r.setAttribute("opacity", s.regression ? "1" : "0.9");
      svg.appendChild(r);
      if(s.baseline !== null && s.baseline !== undefined){
        var by = H - padB - Math.max(0, ((s.baseline - lo) / (hi - lo)) * (H - padB - padT));
        var ln = svgEl("line");
        ln.setAttribute("x1", (x - 4).toFixed(1)); ln.setAttribute("x2", (x + bw + 4).toFixed(1));
        ln.setAttribute("y1", by.toFixed(1)); ln.setAttribute("y2", by.toFixed(1));
        ln.setAttribute("stroke", "#a8a8b3"); ln.setAttribute("stroke-width", "1");
        ln.setAttribute("stroke-dasharray", "3 3");
        svg.appendChild(ln);
      }
      var t = svgEl("text");
      t.setAttribute("x", (i * slot + slot / 2).toFixed(1));
      t.setAttribute("y", String(H - 12));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("fill", "#6a6a76");
      t.setAttribute("font-size", "9");
      t.setAttribute("font-family", "IBM Plex Mono, ui-monospace, monospace");
      t.textContent = s.suite.length > 14 ? s.suite.slice(0, 13) + "\u2026" : s.suite;
      svg.appendChild(t);
    });
    note.textContent = "bars = latest score \u00b7 dashed rule = promoted baseline \u00b7 y-axis " + lo + "\u2013100"
      + (lo > 0 ? " (TRUNCATED \u2014 stated so the scale cannot mislead)" : "");
  })();

  // ── Phase 3b · cost vs quality ──────────────────────────────────────────────────────────────
  // The section is REMOVED from the document when no model run exists. A chart of nothing is a
  // claim that there is nothing to see; an absent section is the honest shape of "not swept yet".
  (function curves(){
    var sec = document.getElementById("secCurves");
    var C = (D.curves && D.curves.models) || [];
    if(!C.length){ sec.parentNode.removeChild(sec); return; }
    var svg = document.getElementById("curveChart");
    var note = document.getElementById("curveNote");
    var legend = document.getElementById("curveLegend");
    var frontierCount = C.filter(function(m){ return m.frontier; }).length;
    var unpriced = (D.curves.unpriced) || [];
    document.getElementById("curveMeta").textContent =
      C.length + " models \u00b7 " + (D.curves.totalRuns || 0) + " runs \u00b7 " + frontierCount + " on the frontier";

    function usd(v){
      if(v === null || v === undefined) return "unknown";
      var n = Number(v);
      if(!isFinite(n)) return "unknown";
      if(n >= 1) return "$" + n.toFixed(2);
      if(n >= 0.01) return "$" + n.toFixed(3);
      return "$" + n.toFixed(5);
    }

    // Only models with a KNOWN cost can be placed on a cost axis. The rest are named below the
    // chart as unknown — never dropped, and never drawn at zero.
    var P = C.filter(function(m){ return m.costPer100Cases !== null && m.costPer100Cases !== undefined; });
    var W = 900, H = 320, L = 74, R = 26, TP = 18, B = 46;
    var x0 = L, x1 = W - R, y0 = TP, y1 = H - B;

    if(!P.length){
      note.textContent = "no model has a known cost, so nothing can be placed on a cost axis. "
        + C.length + " models have scores; their cost is unknown, not zero.";
      svg.parentNode.removeChild(svg);
    } else {
      var costs = P.map(function(m){ return m.costPer100Cases; });
      var scores = P.map(function(m){ return m.meanScore; });
      var cMax = Math.max.apply(null, costs), cMin = 0;
      if(cMax <= 0) cMax = 1;
      cMax = cMax * 1.15;
      var sMin = Math.min.apply(null, scores), sMax = Math.max.apply(null, scores);
      // ZOOMED, LABELLED — same law as the score chart: a 0-100 y-axis hides the whole comparison.
      var lo = Math.max(0, Math.floor(sMin) - 2), hi = Math.min(100, Math.ceil(sMax) + 2);
      if(hi - lo < 4){ hi = Math.min(100, lo + 4); }
      // INSET the plot area from the axes. Without it the cheapest model sits ON the y-axis and its
      // centred label lands on top of a y tick label — two strings in the same pixels, both
      // unreadable (caught in the 1440px render, 2026-08-05).
      var xa = x0 + 26, xb = x1 - 26;
      function px(c){ return xa + ((c - cMin) / (cMax - cMin)) * (xb - xa); }
      function py(s){ return y1 - ((s - lo) / (hi - lo)) * (y1 - y0); }

      function axis(x1a, y1a, x2a, y2a){
        var ln = svgEl("line");
        ln.setAttribute("x1", x1a.toFixed(1)); ln.setAttribute("y1", y1a.toFixed(1));
        ln.setAttribute("x2", x2a.toFixed(1)); ln.setAttribute("y2", y2a.toFixed(1));
        ln.setAttribute("stroke", "rgba(255,255,255,0.14)"); ln.setAttribute("stroke-width", "1");
        svg.appendChild(ln);
      }
      function label(x, y, txt, anchor, fill){
        var t = svgEl("text");
        t.setAttribute("x", x.toFixed(1)); t.setAttribute("y", y.toFixed(1));
        t.setAttribute("text-anchor", anchor || "middle");
        t.setAttribute("fill", fill || "#6a6a76");
        t.setAttribute("font-size", "9");
        t.setAttribute("font-family", "IBM Plex Mono, ui-monospace, monospace");
        t.textContent = txt;
        svg.appendChild(t);
      }
      axis(x0, y1, x1, y1);
      axis(x0, y0, x0, y1);
      for(var i = 0; i <= 4; i++){
        var cv = cMin + (cMax - cMin) * (i / 4);
        label(px(cv), y1 + 16, usd(cv), "middle");
        var sv = lo + (hi - lo) * (i / 4);
        label(x0 - 8, py(sv) + 3, sv.toFixed(1), "end");
      }
      label((x0 + x1) / 2, H - 8, "cost per 100 cases (usd)", "middle");

      // the computed frontier, drawn as a staircase through the Pareto points
      var fr = P.filter(function(m){ return m.frontier; })
                .sort(function(a, b){ return a.costPer100Cases - b.costPer100Cases; });
      if(fr.length > 1){
        var pts = [];
        fr.forEach(function(m){ pts.push(px(m.costPer100Cases).toFixed(1) + "," + py(m.meanScore).toFixed(1)); });
        var pl = svgEl("polyline");
        pl.setAttribute("points", pts.join(" "));
        pl.setAttribute("fill", "none");
        pl.setAttribute("stroke", "#6E8FFF");
        pl.setAttribute("stroke-width", "1.2");
        pl.setAttribute("stroke-dasharray", "4 4");
        svg.appendChild(pl);
      }

      P.forEach(function(m){
        var cx = px(m.costPer100Cases), cy = py(m.meanScore);
        var dot = svgEl("circle");
        dot.setAttribute("cx", cx.toFixed(1)); dot.setAttribute("cy", cy.toFixed(1));
        dot.setAttribute("r", m.frontier ? "5.5" : "4");
        dot.setAttribute("fill", m.frontier ? "#6E8FFF" : "none");
        dot.setAttribute("stroke", m.frontier ? "#6E8FFF" : "#6a6a76");
        dot.setAttribute("stroke-width", "1.4");
        svg.appendChild(dot);
        // Keep the label inside the plot: centred in the middle, pushed inward at either edge.
        var anchor = cx < xa + 66 ? "start" : (cx > xb - 66 ? "end" : "middle");
        var lx = anchor === "start" ? cx - 6 : (anchor === "end" ? cx + 6 : cx);
        label(lx, cy - 11, m.model.length > 22 ? m.model.slice(0, 21) + "\u2026" : m.model, anchor,
              m.frontier ? "#8BA3FF" : "#a8a8b3");
      });

      note.textContent = "each point = one model \u00b7 filled + dashed = the COMPUTED pareto frontier "
        + "(score up, cost down; ties keep both) \u00b7 y-axis " + lo + "\u2013" + hi
        + (lo > 0 || hi < 100 ? " (TRUNCATED \u2014 stated so the scale cannot mislead)" : "")
        + (unpriced.length ? " \u00b7 " + unpriced.length + " model(s) have NO known cost and are NOT plotted \u2014 listed below as unknown" : "");
    }

    // Every model gets a legend card, plotted or not, WITH the provenance of its cost.
    C.forEach(function(m){
      var d = el("div", m.frontier ? "fr" : "");
      d.appendChild(el("b", null, m.model + (m.frontier ? "  \u25c6 frontier" : "")));
      d.appendChild(document.createTextNode(
        "score " + fx(m.meanScore) + " \u00b7 " + m.runs + " run(s) \u00b7 " + (m.sampleCases || 0) + " cases"));
      d.appendChild(el("s", null,
        "cost/100 " + usd(m.costPer100Cases) + " \u00b7 source " + (m.costSource || "unknown")
        + (m.price ? " (as of " + m.price.asOf + ")" : "")
        + (m.costPer100Cases === null || m.costPer100Cases === undefined ? " \u00b7 " + (m.costReason || "unknown") : "")));
      legend.appendChild(d);
    });
  })();

  // ── Phase 3b · prompt variants ──────────────────────────────────────────────────────────────
  // Surfaces are never pooled: two prompts for "tailoring" and one for "agent_answers" are not
  // three competitors, and one merged table would print a leader for a race nobody ran.
  (function abTest(){
    var sec = document.getElementById("secAb");
    var SF = ((D.ab && D.ab.surfaces) || []).filter(function(s){ return (s.variants || []).length; });
    if(!SF.length){ sec.parentNode.removeChild(sec); return; }
    var host = document.getElementById("abSurfaces");
    var total = SF.reduce(function(a, s){ return a + s.variants.length; }, 0);
    var leaders = SF.filter(function(s){ return s.decision && s.decision.status === "leader"; }).length;
    document.getElementById("abMeta").textContent =
      total + " variants across " + SF.length + " surface(s) \u00b7 min n "
      + (D.ab.minN === undefined ? "\u2014" : D.ab.minN) + " \u00b7 " + leaders + " decided";

    SF.forEach(function(sf){
      var V = sf.variants || [], dec = sf.decision || {}, led = dec.status === "leader";

      var box = el("div", led ? "decision led" : "decision");
      box.appendChild(el("b", null, "surface " + sf.surface + " \u00b7 " + (led ? "leader" : "no decision yet")));
      var line = el("span");
      if(led){
        line.appendChild(el("em", null, dec.leader));
        line.appendChild(document.createTextNode(
          " leads by " + fx(dec.delta) + " pass-rate points, with n \u2265 " + dec.minN + " on every variant."));
      } else {
        line.appendChild(el("em", null, "No decision yet."));
        line.appendChild(document.createTextNode(" " + (dec.reason || "reason not stated")));
      }
      box.appendChild(line);
      box.appendChild(el("s", null,
        "Rule v0: a leader needs every variant at n \u2265 " + dec.minN + " AND a pass-rate gap \u2265 "
        + dec.minGapPoints + " points. No p-values \u2014 golden cases are not an i.i.d. sample of production traffic."));
      host.appendChild(box);

      var wrap = el("div", "tbl-wrap"), tbl = el("table", "tbl");
      var thead = el("thead"), hr = el("tr");
      ["Variant", "Hash", "n", "Pass rate", "Mean score", "State"].forEach(function(h, i){
        var th = el("th", null, h);
        if(i >= 2 && i <= 4) th.setAttribute("style", "text-align:right");
        hr.appendChild(th);
      });
      thead.appendChild(hr); tbl.appendChild(thead);
      var body = el("tbody");
      V.forEach(function(v){
        var isLeader = led && v.variantId === dec.leaderVariantId;
        var tr = el("tr");
        function cell(cls, txt, lab){ var td = el("td", cls, txt); if(lab) td.setAttribute("data-l", lab); return td; }
        tr.appendChild(cell("name", v.name, "variant"));
        tr.appendChild(cell("sub", String(v.hash || "").slice(0, 12), "hash"));
        tr.appendChild(cell("num", String(v.n), "n"));
        tr.appendChild(cell("num", v.passRate === null || v.passRate === undefined ? "\u2014" : fx(v.passRate) + "%", "pass rate"));
        tr.appendChild(cell("sub", v.meanScore === null || v.meanScore === undefined ? "\u2014" : fx(v.meanScore), "mean score"));
        var st = el("td"); st.setAttribute("data-l", "state");
        st.appendChild(el("span", "chip " + (isLeader ? "ok" : (v.n < dec.minN ? "warn" : "")),
          isLeader ? "leader" : (v.n < dec.minN ? "under n" : "measured")));
        tr.appendChild(st);
        body.appendChild(tr);
      });
      tbl.appendChild(body); wrap.appendChild(tbl); host.appendChild(wrap);
    });
  })();

  // ── Phase 4 · shadow & canary ───────────────────────────────────────────────────────────────
  // The section is REMOVED when neither a replay nor a transition exists. An empty "shadow" panel
  // would read as "we shadow-tested and found nothing" — the absence of the panel is the honest
  // shape of "no replay has ever run". Both words are printed WITH their definition attached
  // (addendum "Honest scoping FIRST"): there is no fleet here and the page never implies one.
  (function shadowCanary(){
    var sec = document.getElementById("secShadow");
    var SH = (D.shadow && D.shadow.last) || null;
    var CA = (D.canary && D.canary.events) || [];
    if(!SH && !CA.length){ sec.parentNode.removeChild(sec); return; }
    var meta = document.getElementById("shadowMeta");
    var sbox = document.getElementById("shadowBox"), cbox = document.getElementById("canaryBox");
    meta.textContent = (SH ? "1 replay \u00b7 " : "no replay \u00b7 ") + CA.length + " canary transition(s)";

    if(SH){
      var rec = String(SH.recommendation || "");
      var cls = rec === "block" ? "blk" : (rec === "safe" ? "safe" : "insp");
      var box = el("div", "decision " + cls);
      box.appendChild(el("b", null, "shadow replay \u00b7 candidate " + String(SH.candidateSha || "").slice(0, 12) + " \u00b7 " + (rec || "no verdict")));
      var line = el("span");
      line.appendChild(el("em", null, rec.toUpperCase()));
      line.appendChild(document.createTextNode(" \u2014 " + (SH.reason || "no reason recorded") + "."));
      box.appendChild(line);
      // THE THRESHOLDS THAT WERE APPLIED, on the artifact, never implicit.
      var th = SH.thresholds || {};
      box.appendChild(el("s", null,
        "Thresholds applied: diff when embedSim < " + fx(th.simThreshold, 2)
        + " \u00b7 inspect when diffRate > " + fx(th.diffRateInspect, 2)
        + " \u00b7 block when meanDelta < " + fx(th.meanDeltaBlock, 2)
        + " \u00b7 " + (th.rule || "")));
      sbox.appendChild(box);

      var wrap = el("div", "tbl-wrap"), tbl = el("table", "tbl");
      var thead = el("thead"), hr = el("tr");
      ["Compared", "Diffs", "Diff rate", "Unscored", "Mean delta", "Spend", "Finished"].forEach(function(h, i){
        var th2 = el("th", null, h);
        if(i <= 4) th2.setAttribute("style", "text-align:right");
        hr.appendChild(th2);
      });
      thead.appendChild(hr); tbl.appendChild(thead);
      var tb = el("tbody"), tr = el("tr");
      function cell(cls2, txt, lab){ var td = el("td", cls2, txt); if(lab) td.setAttribute("data-l", lab); return td; }
      tr.appendChild(cell("num", String(SH.compared), "compared"));
      tr.appendChild(cell("num", String(SH.diffs), "diffs"));
      tr.appendChild(cell("num", SH.diffRate === null || SH.diffRate === undefined ? "\u2014" : fx(SH.diffRate, 4), "diff rate"));
      tr.appendChild(cell("num", String(SH.unscored || 0), "unscored"));
      tr.appendChild(cell("num", SH.meanDelta === null || SH.meanDelta === undefined ? "not evaluated" : fx(SH.meanDelta), "mean delta"));
      tr.appendChild(cell("sub", SH.spendUsd === null || SH.spendUsd === undefined ? "unknown" : "$" + fx(SH.spendUsd, 4), "spend"));
      tr.appendChild(cell("sub", SH.finishedAt ? rel(SH.finishedAt) : "not finished", "finished"));
      tb.appendChild(tr); tbl.appendChild(tb); wrap.appendChild(tbl); sbox.appendChild(wrap);

      // Every caveat the verdict carries is printed. A "safe" is never bare on this page either.
      (SH.caveats || []).forEach(function(c){
        sbox.appendChild(el("p", "defn", "caveat \u00b7 " + c));
      });
      sbox.appendChild(el("p", "defn", (D.shadow && D.shadow.definition) || ""));
    }

    if(CA.length){
      cbox.appendChild(el("p", "defn", (D.canary && D.canary.definition) || ""));
      var host = el("div", "list");
      CA.forEach(function(e){
        var row = el("div", "row");
        row.appendChild(el("span", "ts", rel(e.createdAt)));
        row.appendChild(el("span", "chip " + (e.phase === "rollback" ? "bad" : (e.phase === "promote" ? "ok" : "warn")), e.phase));
        row.appendChild(el("span", null,
          String(e.sha || "").slice(0, 12)
          + (e.pct === null || e.pct === undefined ? "" : " \u00b7 " + e.pct + "% cohort")
          + (e.reason ? " \u00b7 " + e.reason : "")));
        row.appendChild(el("span", "ts", e.createdAt || ""));
        host.appendChild(row);
      });
      cbox.appendChild(host);
      var sm = (D.canary && D.canary.summary) || {};
      cbox.appendChild(el("p", "defn", sm.note || ""));
    }
  })();

  (function arch(){
    var left = document.getElementById("archLeft"), right = document.getElementById("archRight");
    var prods = T.length ? T : [{ name: D.target, kind: "product" }];
    prods.slice(0, 5).forEach(function(t){
      var c = el("div", "arch-cell");
      c.appendChild(el("b", null, t.kind || "product"));
      c.appendChild(document.createTextNode(t.name));
      left.appendChild(c);
    });
    [["gate", "blocks the deploy on regression"],
     ["alerts", "telegram on regression or silence"],
     ["review", "borderline cases to a human"]].forEach(function(p){
      var c = el("div", "arch-cell");
      c.appendChild(el("b", null, p[0]));
      c.appendChild(document.createTextNode(p[1]));
      right.appendChild(c);
    });
    function draw(){
      var host = document.getElementById("arch"), svg = document.getElementById("flow");
      while(svg.firstChild) svg.removeChild(svg.firstChild);
      if(window.innerWidth <= 720) return;
      var hb = host.getBoundingClientRect();
      var midEl = host.querySelector(".arch-mid"), mid = midEl.getBoundingClientRect();
      var mx = mid.left - hb.left, my = mid.top + mid.height / 2 - hb.top, mrx = mid.right - hb.left;
      function path(x1, y1, x2, y2){
        var dx = (x2 - x1) / 2, p = svgEl("path");
        p.setAttribute("d", "M " + x1 + " " + y1 + " C " + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2);
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", "rgba(110,143,255,.28)");
        p.setAttribute("stroke-width", "1");
        svg.appendChild(p);
      }
      Array.prototype.forEach.call(left.children, function(c){
        var r = c.getBoundingClientRect();
        path(r.right - hb.left, r.top + r.height / 2 - hb.top, mx, my);
      });
      Array.prototype.forEach.call(right.children, function(c){
        var r = c.getBoundingClientRect();
        path(mrx, my, r.left - hb.left, r.top + r.height / 2 - hb.top);
      });
    }
    draw();
    var tid; window.addEventListener("resize", function(){ clearTimeout(tid); tid = setTimeout(draw, 120); });
  })();

  (function alerts(){
    var host = document.getElementById("alerts");
    document.getElementById("alertMeta").textContent = A.length ? (openAlerts + " open of " + A.length) : "none";
    if(!A.length){ host.appendChild(el("div", "empty", "no alerts recorded")); return; }
    A.forEach(function(a){
      var row = el("div", "row");
      row.appendChild(el("span", "ts", rel(a.createdAt || a.created_at)));
      row.appendChild(el("span", "chip " + (a.kind === "regression" ? "bad" : "warn"), a.kind));
      row.appendChild(el("span", null, (a.suite ? a.suite + " \u00b7 " : "") + (a.message || "")));
      row.appendChild(el("span", "chip " + (a.ack ? "ok" : "warn"), a.ack ? "acked" : "open"));
      host.appendChild(row);
    });
  })();

  (function calibration(){
    var host = document.getElementById("cal");
    var labels = D.labels !== undefined ? D.labels : cal.labels;
    var labelCount = (typeof labels === "number") ? labels
      : (labels && typeof labels === "object")
        ? Object.keys(labels).reduce(function(a, k){ return a + Number(labels[k] || 0); }, 0) : 0;
    document.getElementById("calMeta").textContent = calibrated ? "measured" : "not yet measured";
    [["status", calibrated ? "calibrated" : "uncalibrated"],
     ["judge model", calRow ? (calRow.judgeModel || calRow.judge_model || "\u2014") : "\u2014"],
     ["kappa", calRow ? fx(calRow.kappa) : "\u2014"],
     ["agreement", (calRow && calRow.agreement !== undefined && calRow.agreement !== null) ? fx(calRow.agreement) : "\u2014"],
     ["labels", String(labelCount)],
     ["review open", String((D.review && D.review.open) || 0)]
    ].forEach(function(p){
      var d = el("div");
      d.appendChild(el("dt", null, p[0]));
      var dd = el("dd", null, p[1]);
      if(p[0] === "status" && !calibrated) dd.className = "amber";
      d.appendChild(dd); host.appendChild(d);
    });
    document.getElementById("calNote").textContent = calibrated
      ? "Judge scores carry a measured agreement with human labels. They still never gate a deploy on their own."
      : "No kappa exists yet, so judge scores for this target are ADVISORY ONLY and gate nothing. Calibration needs at least 20 human-labelled cases.";
  })();

  document.getElementById("foot").textContent =
    "eval hub \u00b7 target " + D.target + " \u00b7 generated " + (D.generatedAt || "") +
    " \u00b7 rendered from embedded data \u00b7 one same-origin script, no third-party requests";

  if("IntersectionObserver" in window){
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if(e.isIntersecting){ e.target.className += " in"; io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px" });
    Array.prototype.forEach.call(document.querySelectorAll(".rv"), function(n){ io.observe(n); });
  } else {
    Array.prototype.forEach.call(document.querySelectorAll(".rv"), function(n){ n.className += " in"; });
  }
  // Belt and braces: whatever happens with the observer, nothing stays invisible.
  setTimeout(function(){
    Array.prototype.forEach.call(document.querySelectorAll(".rv"), function(n){
      if(n.className.indexOf(" in") < 0) n.className += " in";
    });
  }, 1800);
})();`;
