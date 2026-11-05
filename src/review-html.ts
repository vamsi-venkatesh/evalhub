// Eval Hub — the judge-calibration labelling screen.
//
// ONE case per screen, three keys, no mouse required. It exists for exactly one reason: until a
// human has ruled on enough cases, Cohen's kappa does not exist and the LLM judge is advisory —
// it gates nothing. This page is the shortest path from "advisory" to "measured".
//
// SAME DESIGN LANGUAGE AS src/dashboard-html.ts, deliberately identical tokens (--bg:#07070a,
// --accent:#6E8FFF, IBM Plex Mono micro-labels, Instrument Serif display). Two laws inherited from
// that file, both hard-won:
//   • the `font:` SHORTHAND with clamp() in the size slot is dropped WHOLE by Chromium — every
//     clamped size here is written LONGHAND (font-family/font-size/line-height separately);
//   • selector specificity: the key-bar states (.k.on) are single-class rules that must not be
//     out-specified by a later .bar .k rule, so the state rules come LAST in their block.
//
// SELF-CONTAINED, ABSOLUTELY: no CDN, no font service, no image, no SVG namespace, no fetch to any
// absolute host. The only network call the page makes is a RELATIVE POST to the same origin it was
// served from — it is reached through an authenticating Cloudflare Worker, and an absolute host
// would route around that Worker and lose the auth.
//
// NO innerHTML ANYWHERE. Every string on this page — case ids, résumé text, judge reasoning — is
// product data. textContent only, so a case literally named `<script>` is displayed, never run.
import type { ReviewCard } from "./review.js";

export type ReviewItem = {
  id: string;
  caseId: string;
  suite: string;
  reason: string;
  enqueuedAt: string;
  /** Present when the card was built by scripts/enqueue-review.mts. */
  card: ReviewCard | null;
  /** The stored payload, shown verbatim when `card` is null. Never dressed up as a card. */
  raw: unknown;
};

export type ReviewScreenData = {
  target: string;
  suite: string | null;
  items: ReviewItem[];
  counts: { open: number; labeled: number; skipped: number; total: number };
  /** null until there are at least `minPairs` (human, judge) pairs. Never a placeholder number. */
  kappa: { n: number; kappa: number; agreement: number; expected: number; band: string; degenerate: boolean } | null;
  /** Pairs available RIGHT NOW, shown even when it is below the floor — that is the progress bar. */
  kappaPairs: number;
  minPairs: number;
  labeler: string;
  /** RELATIVE. Same origin, always — see the header note. */
  postPath: string;
  /** Carried only when the page was authenticated by ?token= (SSH-tunnel case); "" behind a Worker
   *  that injects the header, where the page never sees a secret at all. */
  token: string;
  /** True when items were truncated by ?limit — declared, never silent. */
  truncated: boolean;
};

function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderReviewHtml(data: ReviewScreenData): string {
  const target = escapeHtml(String(data.target));
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>eval hub &middot; label &middot; ${target}</title>
<style>
/* ─── Design tokens — identical to src/dashboard-html.ts (Career Agent OS, 2026-06-09) ──────── */
:root{
  --bg:#07070a; --surface:#0e0e12; --surface-2:#15151b;
  --ink-1:#f4f4f8; --ink-2:#a8a8b3; --ink-3:#6a6a76; --ink-4:#3e3e46;
  --border:rgba(255,255,255,0.06); --border-hi:rgba(255,255,255,0.14);
  --accent:#6E8FFF; --accent-soft:#8BA3FF;
  --positive:#4ade80; --warn:#fbbf24; --negative:#f87171;
  --sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --serif:"Instrument Serif",Georgia,"Times New Roman",serif;
  --max:1280px; --pad:40px; --barh:82px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink-1);font:15px/1.55 var(--sans);
  -webkit-font-smoothing:antialiased;overflow-x:hidden;padding-bottom:calc(var(--barh) + 26px)}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:linear-gradient(rgba(255,255,255,.014) 1px,transparent 1px),
                   linear-gradient(90deg,rgba(255,255,255,.014) 1px,transparent 1px);
  background-size:64px 64px}
body::after{content:"";position:fixed;top:-380px;right:-260px;width:1000px;height:1000px;
  pointer-events:none;z-index:0;background:radial-gradient(circle,rgba(110,143,255,.075),transparent 62%)}
.wrap{position:relative;z-index:1;max-width:var(--max);margin:0 auto;padding:0 var(--pad) 40px}

.nav{position:sticky;top:0;z-index:20;backdrop-filter:blur(12px);background:rgba(10,10,12,.85);
  border-bottom:1px solid var(--border)}
.nav-in{max-width:var(--max);margin:0 auto;padding:14px var(--pad);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:9px}
.brand i{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px rgba(110,143,255,.85)}
.brand b{font:600 10.5px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase}
.brand s{text-decoration:none;font:400 10.5px/1 var(--mono);letter-spacing:.10em;color:var(--ink-3)}
.prog{margin-left:auto;display:flex;align-items:center;gap:12px}
.prog b{font:600 13px/1 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:.02em}
.prog s{text-decoration:none;font:400 9.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3)}
.bararea{width:140px;height:3px;background:var(--surface-2);border:1px solid var(--border);border-radius:2px;overflow:hidden}
.bararea i{display:block;height:100%;background:var(--accent);width:0}

/* ── the honesty band. It is the FIRST thing on the page, by intent. ── */
.honest{margin:26px 0 0;border:1px solid var(--border);border-left:2px solid var(--warn);border-radius:4px;
  background:var(--surface);padding:15px 17px}
.honest.measured{border-left-color:var(--accent)}
.honest b{display:block;font:600 9.5px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin-bottom:9px}
.honest p{margin:0;font:400 13px/1.6 var(--sans);color:var(--ink-2)}
.honest em{font-style:normal;color:var(--ink-1);font-weight:600}
.honest s{display:block;margin-top:11px;text-decoration:none;font:400 10px/1.6 var(--mono);letter-spacing:.05em;color:var(--ink-3)}
.kfig{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--border);
  border:1px solid var(--border);margin:14px 0 0}
.kfig div{background:var(--surface-2);padding:12px 14px}
.kfig dt{margin:0 0 7px;font:500 8.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3)}
.kfig dd{margin:0;font:600 16px/1 var(--mono);font-variant-numeric:tabular-nums}

/* ── the case ── */
.caserail{display:flex;flex-wrap:wrap;margin:30px 0 0;border:1px solid var(--border);border-radius:4px;background:var(--surface)}
.caserail div{padding:11px 16px;font:500 9.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;
  color:var(--ink-3);border-right:1px solid var(--border);display:flex;align-items:center;gap:7px}
.caserail div:last-child{border-right:0}
.caserail b{color:var(--ink-1);font-weight:600;letter-spacing:.06em}

.verdict{margin:22px 0 0;border:1px solid var(--border);border-left:2px solid var(--ink-4);border-radius:4px;
  background:var(--surface);padding:18px 20px}
.verdict.fail{border-left-color:var(--negative)}
.verdict.pass{border-left-color:var(--positive)}
.verdict .vh{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
/* SPECIFICITY, the law from dashboard-html.ts, learned again here the hard way: this rule was
   first written as ".verdict .vh span" — (0,2,1) — which out-ranked BOTH ".vbig" and ".chip"
   (0,1,0) and silently rendered the display verdict at 9.5px and the chips in the wrong face.
   Caught by the rendered-page probe, 2026-08-05. It now targets ONE class, so nothing it does not
   mean to style can be captured by it. */
.verdict .vh .lbl{font:500 9.5px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.vbig{font-family:var(--serif);font-style:italic;font-weight:400;font-size:clamp(26px,3vw,38px);line-height:1;
  letter-spacing:-.01em;color:var(--accent-soft)}
.verdict p{margin:0;font:400 13.5px/1.65 var(--sans);color:var(--ink-2)}
.chip{display:inline-block;padding:3px 7px;border-radius:3px;font:600 8.5px/1 var(--mono);
  letter-spacing:.1em;text-transform:uppercase;border:1px solid}
.chip.ok{color:var(--positive);border-color:rgba(74,222,128,.35)}
.chip.bad{color:var(--negative);border-color:rgba(248,113,113,.4)}
.chip.warn{color:var(--warn);border-color:rgba(251,191,36,.4)}
.chip.dim{color:var(--ink-3);border-color:var(--border-hi)}

.gap{margin:16px 0 0;border:1px dashed rgba(251,191,36,.4);border-radius:4px;padding:12px 14px;
  font:400 11.5px/1.65 var(--mono);color:var(--warn)}
.gap p{margin:0 0 7px}
.gap p:last-child{margin:0}

.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin:22px 0 0;align-items:start}
.panel{border:1px solid var(--border);border-radius:5px;background:var(--surface);overflow:hidden}
.panel h3{margin:0;padding:12px 16px;border-bottom:1px solid var(--border);
  font:600 9.5px/1.35 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.panel .body{padding:14px 16px;max-height:280px;overflow:auto;-webkit-overflow-scrolling:touch}
.panel pre{margin:0;white-space:pre-wrap;word-break:break-word;font:400 12px/1.62 var(--mono);color:var(--ink-2)}
.panel.tall .body{max-height:420px}

.ev{margin:0;border-top:1px solid var(--border)}
.ev .item{padding:13px 16px;border-bottom:1px solid var(--border)}
.ev .item:last-child{border-bottom:0}
.ev .item.bad{border-left:2px solid var(--negative)}
.ev .item.good{border-left:2px solid var(--border-hi)}
.ev .claim{margin:0 0 8px;font:400 12.5px/1.6 var(--sans);color:var(--ink-1)}
.ev .src{margin:0;white-space:pre-wrap;word-break:break-word;font:400 11px/1.55 var(--mono);color:var(--ink-3);
  border-left:1px solid var(--border-hi);padding-left:10px}
.ev .meta{margin:0 0 7px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.empty{padding:20px 16px;color:var(--ink-3);font:400 12px/1.5 var(--mono)}

/* ── the key bar. Fixed, always visible: the keys ARE the interface. ── */
.bar{position:fixed;left:0;right:0;bottom:0;z-index:30;background:rgba(10,10,12,.94);backdrop-filter:blur(12px);
  border-top:1px solid var(--border)}
.bar-in{max-width:var(--max);margin:0 auto;padding:14px var(--pad);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.keys{display:flex;gap:10px;flex-wrap:wrap}
.k{display:flex;align-items:center;gap:9px;padding:9px 14px;border:1px solid var(--border);border-radius:4px;
  background:var(--surface);cursor:default}
.k kbd{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 6px;
  border:1px solid var(--border-hi);border-radius:3px;background:var(--surface-2);
  font:600 12px/1 var(--mono);text-transform:uppercase;color:var(--ink-1)}
.k span{font:500 9.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3)}
.status{margin-left:auto;font:400 10px/1.5 var(--mono);letter-spacing:.06em;color:var(--ink-3);text-align:right}
.status.err{color:var(--negative)}
/* state rules LAST: a .k.on must out-rank the .k base above it, and nothing below may re-specify .k */
.k.on{border-color:var(--accent);box-shadow:0 0 0 1px rgba(110,143,255,.25)}
.k.on kbd{border-color:var(--accent);color:var(--accent)}
.k.on span{color:var(--accent)}

.foot{margin-top:44px;padding-top:20px;border-top:1px solid var(--border);
  font:400 9.5px/1.7 var(--mono);letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3)}
.done{margin:44px 0 0;border:1px solid var(--border);border-radius:5px;background:var(--surface);padding:34px 26px;text-align:center}
.done b{display:block;font-family:var(--serif);font-style:italic;font-weight:400;font-size:clamp(24px,3.4vw,40px);
  line-height:1.1;color:var(--accent-soft);margin-bottom:12px}
.done p{margin:0;color:var(--ink-2);font:400 13.5px/1.65 var(--sans)}

@media (max-width:900px){
  :root{--pad:18px;--barh:118px}
  .grid{grid-template-columns:1fr;gap:16px}
  .panel .body{max-height:220px}
  .prog{margin-left:0;width:100%}
  .bararea{flex:1}
  .status{margin-left:0;width:100%;text-align:left}
  .keys{width:100%}
  .k{flex:1;justify-content:center}
}
</style></head>
<body>
<nav class="nav"><div class="nav-in">
  <span class="brand"><i></i><b>EVAL &middot; HUB</b><s>${target} &middot; label</s></span>
  <span class="prog"><s>Progress</s><b id="prog">0 / 0</b><span class="bararea"><i id="progbar"></i></span></span>
</div></nav>

<div class="wrap">
  <div class="honest" id="honest">
    <b id="honestCap">Judge status</b>
    <p id="honestBody"></p>
    <dl class="kfig" id="kfig"></dl>
    <s id="honestNote"></s>
  </div>

  <div id="stage"></div>

  <div class="foot" id="foot"></div>
</div>

<div class="bar"><div class="bar-in">
  <span class="keys">
    <span class="k" id="kA"><kbd>A</kbd><span>Agree with judge</span></span>
    <span class="k" id="kD"><kbd>D</kbd><span>Disagree</span></span>
    <span class="k" id="kS"><kbd>S</kbd><span>Skip</span></span>
  </span>
  <span class="status" id="status"></span>
</div></div>

<script type="application/json" id="data">${embedJson(data)}</script>
<script src="app.js" defer></script>
</body></html>`;
}

// THE CLIENT SCRIPT IS SERVED AS A FILE, NOT INLINED (2026-08-05).
//
// The estate's shared vhost sends `script-src 'self'` with no 'unsafe-inline' and no nonce, so an
// inline <script> is silently dropped by the browser: no JS error, no failed request, nothing in
// the console except a CSP violation that is easy to miss. The screen rendered its static chrome
// and stopped — "PROGRESS 0 / 0" with 46 cases actually queued and 156KB of correct data sitting
// unread in the page. The server was right, the data was right, and the page was dead.
//
// Serving the same bytes from a same-origin path satisfies 'self' without weakening anyone's CSP,
// and without hash-pinning a script that changes every time this file does. It is referenced
// RELATIVELY ("app.js" from /review/:target) so it keeps working through the authenticating
// Worker, which must never see an absolute host.
export const REVIEW_APP_JS = String.raw`(function(){
  "use strict";
  var D = JSON.parse(document.getElementById("data").textContent);
  var items = D.items || [];
  var counts = D.counts || {open:0,labeled:0,skipped:0,total:0};
  var kappa = D.kappa;            // null until D.minPairs pairs exist — never a placeholder number
  var kappaPairs = D.kappaPairs|0;
  var idx = 0, busy = false;

  function el(tag, cls, text){
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function dpair(term, val){
    var d = el("div"); d.appendChild(el("dt", null, term)); d.appendChild(el("dd", null, val)); return d;
  }
  function fixed(n, p){ return (Math.round(n * Math.pow(10,p)) / Math.pow(10,p)).toFixed(p); }

  // ── the honesty band ────────────────────────────────────────────────────────────────────────
  function renderHonest(){
    var box = document.getElementById("honest");
    var body = document.getElementById("honestBody");
    var note = document.getElementById("honestNote");
    var kfig = document.getElementById("kfig");
    var cap = document.getElementById("honestCap");
    body.textContent = ""; note.textContent = ""; kfig.textContent = "";
    while (body.firstChild) body.removeChild(body.firstChild);

    if (!kappa) {
      box.className = "honest";
      cap.textContent = "Judge status — advisory";
      body.appendChild(el("em", null, "The judge is ADVISORY. It gates nothing."));
      body.appendChild(document.createTextNode(
        " No Cohen's kappa exists for this target yet, so there is no measured agreement between it and a human — " +
        "and nothing here may be quoted as one. " + kappaPairs + " of the " + D.minPairs +
        " (human, judge) pairs needed for the hub to compute a kappa at all are in place."));
      note.textContent = "A pair needs BOTH a human label and a pushed judge verdict for the same case. Skips are not labels and never become pairs.";
    } else {
      box.className = "honest measured";
      cap.textContent = "Judge status — measured, and weak";
      body.appendChild(el("em", null, "Kappa " + fixed(kappa.kappa,3) + " on n = " + kappa.n + " pairs."));
      body.appendChild(document.createTextNode(
        " This is an ESTIMATE on " + kappa.n + " pairs, not a settled property of the judge. " +
        "A kappa over a few dozen labels carries a wide confidence interval; read it with n beside it, always. " +
        (kappa.degenerate ? "It is also DEGENERATE — every pair used a single category, so the number is a convention, not a measurement. " : "") +
        "Whether the judge gates anything is a separate, deliberate decision; this screen does not make it."));
      kfig.appendChild(dpair("Kappa", fixed(kappa.kappa,3)));
      kfig.appendChild(dpair("n (pairs)", String(kappa.n)));
      kfig.appendChild(dpair("Raw agreement", fixed(kappa.agreement,3)));
      kfig.appendChild(dpair("Chance (pe)", fixed(kappa.expected,3)));
      kfig.appendChild(dpair("Band", kappa.band));
      note.textContent = "Landis & Koch band — a label for the number, never a substitute for it. Computed live and NOT persisted; POST /api/calibration/compute is what records a calibration.";
    }
  }

  function renderProgress(){
    var done = counts.labeled + counts.skipped;
    document.getElementById("prog").textContent = done + " / " + counts.total;
    var pct = counts.total > 0 ? Math.round((done / counts.total) * 100) : 0;
    document.getElementById("progbar").style.width = pct + "%";
    document.getElementById("foot").textContent =
      "Queue " + counts.total + " \u00b7 labelled " + counts.labeled + " \u00b7 skipped " + counts.skipped +
      " \u00b7 open " + counts.open + " \u00b7 labeler " + D.labeler +
      (D.truncated ? " \u00b7 LIST TRUNCATED BY ?limit \u2014 reload for the rest" : "");
  }

  // ── the case ────────────────────────────────────────────────────────────────────────────────
  function panel(title, text, tall){
    var p = el("div", "panel" + (tall ? " tall" : ""));
    p.appendChild(el("h3", null, title));
    var b = el("div", "body");
    b.appendChild(el("pre", null, text));
    p.appendChild(b);
    return p;
  }

  function renderCase(){
    var stage = document.getElementById("stage");
    while (stage.firstChild) stage.removeChild(stage.firstChild);

    if (idx >= items.length) {
      var d = el("div", "done");
      d.appendChild(el("b", null, counts.open > 0 ? "That is the batch." : "Queue empty."));
      d.appendChild(el("p", null, counts.open > 0
        ? "This page held " + items.length + " case(s); " + counts.open + " remain open in the queue. Reload for the next batch."
        : "Nothing is waiting for a human on this target. Run scripts/enqueue-review.mts to fill the queue from judged results."));
      stage.appendChild(d);
      setKeys(false);
      return;
    }

    var it = items[idx];
    var c = it.card;

    var rail = el("div", "caserail");
    function cell(k, v){ var x = el("div", null, k + " "); x.appendChild(el("b", null, v)); rail.appendChild(x); }
    cell("Case", it.caseId);
    cell("Suite", it.suite);
    cell("Reason", it.reason);
    // The rank is the ENQUEUE-TIME rank across the whole ranked batch, not a position in this
    // page's list — writing "#43 of 22" would be a number the data does not support.
    if (c) { cell("Rank at enqueue", "#" + c.meta.rank); cell("Tier", c.meta.tier === 1 ? "1 \u00b7 borderline" : "2 \u00b7 balanced"); }
    if (c && c.meta.tags && c.meta.tags.length) cell("Tags", c.meta.tags.join(" \u00b7 "));
    stage.appendChild(rail);

    if (!c) {
      // A payload this page did not build. Shown VERBATIM — dressing it up as a card would be a lie
      // about where the fields came from.
      var raw = el("div", "gap");
      raw.appendChild(el("p", null, "This queue item was not built by scripts/enqueue-review.mts, so there is no normalised card. The stored payload is shown verbatim below."));
      stage.appendChild(raw);
      stage.appendChild(panel("Stored payload (verbatim)", JSON.stringify(it.raw, null, 2), true));
      setKeys(true);
      return;
    }

    var v = el("div", "verdict " + c.judge.verdict);
    var vh = el("div", "vh");
    vh.appendChild(el("span", "lbl", "The judge said"));
    vh.appendChild(el("span", "vbig", c.judge.verdict));
    vh.appendChild(el("span", "chip " + (c.judge.verdict === "pass" ? "ok" : "bad"), c.judge.metric + " = " + c.judge.value));
    if (c.judge.borderline) vh.appendChild(el("span", "chip warn", "borderline"));
    v.appendChild(vh);
    v.appendChild(el("p", null, c.judge.reasoning));
    stage.appendChild(v);

    if (c.gaps && c.gaps.length) {
      var g = el("div", "gap");
      for (var i = 0; i < c.gaps.length; i++) g.appendChild(el("p", null, c.gaps[i]));
      stage.appendChild(g);
    }

    var grid = el("div", "grid");
    if (c.input) grid.appendChild(panel(c.input.label, c.input.text));
    if (c.answer) grid.appendChild(panel(c.answer.label, c.answer.text));
    if (c.source) grid.appendChild(panel(c.source.label, c.source.text, true));

    var ev = el("div", "panel tall");
    ev.appendChild(el("h3", null, "What the judge checked \u2014 claim against source"));
    var list = el("div", "ev");
    if (!c.evidence.length) list.appendChild(el("div", "empty", "The hub stored no per-item ruling for this case."));
    for (var j = 0; j < c.evidence.length; j++) {
      var e = c.evidence[j];
      var bad = (e.state === "unsupported" || e.state === "not found");
      var row = el("div", "item " + (bad ? "bad" : "good"));
      var meta = el("div", "meta");
      meta.appendChild(el("span", "chip " + (bad ? "bad" : "ok"), e.state));
      if (e.sourceId) meta.appendChild(el("span", "chip dim", e.sourceId));
      if (e.similarity !== null && e.similarity !== undefined) meta.appendChild(el("span", "chip dim", "sim " + e.similarity));
      row.appendChild(meta);
      row.appendChild(el("p", "claim", e.claim));
      row.appendChild(el("p", "src", e.source === null ? "\u2014 the hub found no matching source text \u2014" : e.source));
      list.appendChild(row);
    }
    ev.appendChild(list);
    grid.appendChild(ev);
    stage.appendChild(grid);
    setKeys(true);
  }

  function setKeys(on){
    ["kA","kD","kS"].forEach(function(id){
      document.getElementById(id).className = on ? "k on" : "k";
    });
  }

  function say(msg, isErr){
    var s = document.getElementById("status");
    s.className = "status" + (isErr ? " err" : "");
    s.textContent = msg;
  }

  // ── the only network call on this page: RELATIVE, same origin, so the authenticating Worker in
  // front of the hub sees it. An absolute host would route around that Worker and lose the auth. ──
  function send(action){
    if (busy || idx >= items.length) return;
    var it = items[idx];
    var c = it.card;
    var judge = c ? c.judge.verdict : null;
    var verdict;
    if (action === "skip") verdict = "skip";
    else if (!judge) { say("cannot agree or disagree: this item carries no judge verdict \u2014 press S to skip", true); return; }
    else if (action === "agree") verdict = judge;
    else verdict = (judge === "pass" ? "fail" : "pass");

    busy = true;
    say(action === "skip" ? "skipping\u2026" : "recording " + verdict + "\u2026", false);
    var payload = { id: it.id, verdict: verdict, labeler: D.labeler, note: action };
    if (D.token) payload.token = D.token;
    fetch(location.pathname.replace(/\/+$/, "") + "/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    }).then(function(r){ return r.text().then(function(t){ return { s: r.status, t: t }; }); })
      .then(function(res){
        var b = null;
        try { b = JSON.parse(res.t); } catch (e) { b = null; }
        if (res.s !== 200 || !b || !b.ok) {
          busy = false;
          // The queue item stays OPEN on the server; the screen must not advance past it.
          say("NOT RECORDED \u2014 " + res.s + " " + (b && b.error ? b.error : res.t).toString().slice(0,120), true);
          return;
        }
        counts = b.counts || counts;
        kappa = (b.kappa === undefined) ? kappa : b.kappa;
        kappaPairs = (b.kappaPairs === undefined) ? kappaPairs : b.kappaPairs;
        idx++;
        busy = false;
        renderHonest(); renderProgress(); renderCase();
        say(b.state === "skipped" ? "skipped " + b.caseId : "recorded " + b.verdict + " for " + b.caseId, false);
      })
      .catch(function(e){
        busy = false;
        say("NOT RECORDED \u2014 " + String(e && e.message ? e.message : e).slice(0,120), true);
      });
  }

  document.addEventListener("keydown", function(ev){
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var k = (ev.key || "").toLowerCase();
    if (k !== "a" && k !== "d" && k !== "s") return;
    ev.preventDefault();
    send(k === "a" ? "agree" : k === "d" ? "disagree" : "skip");
  });

  renderHonest(); renderProgress(); renderCase();
  say(items.length ? "a \u00b7 d \u00b7 s" : "nothing open", false);
})();`;
