// Guard: no page this service renders may carry a runnable inline <script>.
//
// WHY (2026-08-05). The estate's vhost sends `script-src 'self'` with no 'unsafe-inline' and no
// nonce. An inline <script> under that policy is dropped by the browser with NO JavaScript error
// and NO failed request — the only trace is a CSP violation line that is easy to miss. The
// dashboard shipped this way and nobody noticed: it served HTTP 200 with a correct payload and
// rendered "0 CASES EVALUATED" with no tables and no charts. A ZERO presented as a measurement,
// from the one service whose whole purpose is to stop exactly that.
//
// The lesson is not "remember to check". It is that an HTTP 200 and a correct payload are NOT
// evidence a page works, so the property has to be asserted structurally. This test fails the
// build if anyone inlines a script again.
//
// `<script type="application/json">` is explicitly ALLOWED: it is data, not code, and CSP does not
// run it. That distinction is the whole point of the check, so it is tested in both directions.
import { renderDashboardHtml } from "../src/dashboard-html.js";
import { renderReviewHtml } from "../src/review-html.js";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`); }
}

/** Every <script> tag that is NOT `type="application/json"` — i.e. everything the browser runs. */
function runnableScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>/gi)]
    .filter((m) => !/type\s*=\s*["']application\/json["']/i.test(m[1] ?? ""))
    .map((m) => m[0]);
}

const EMPTY_DASH = {
  target: "t", generatedAt: new Date(0).toISOString(), windowDays: 7, tolerancePts: 1,
  staleAfterHours: 26, suites: [], alerts: [], targets: ["t"], totals: null,
  calibration: null, curves: null, ab: null, shadow: null, canary: null,
} as never;

const EMPTY_REVIEW = {
  target: "t", suite: null, items: [], counts: { open: 0, labeled: 0, skipped: 0, total: 0 },
  kappa: null, kappaPairs: 0, minPairs: 20, postPath: "/review/t/resolve", labeler: "founder", token: "",
} as never;

for (const [name, html] of [
  ["dashboard", renderDashboardHtml(EMPTY_DASH)],
  ["review screen", renderReviewHtml(EMPTY_REVIEW)],
] as const) {
  const all = runnableScripts(html);
  const inline = all.filter((s) => !/\bsrc\s*=/i.test(s));
  ok(inline.length === 0, `${name}: no runnable INLINE <script>`, inline.slice(0, 3).join("  "));

  const external = all.filter((s) => /\bsrc\s*=/i.test(s));
  ok(external.length > 0, `${name}: its script is loaded from a src (so CSP 'self' allows it)`);

  // A src naming a host would be blocked by default-src 'self' AND would leak the request to a
  // third party. Relative or root-relative only.
  const absolute = external.filter((s) => /\bsrc\s*=\s*["'](?:[a-z]+:)?\/\//i.test(s));
  ok(absolute.length === 0, `${name}: no ABSOLUTE script src`, absolute.join("  "));

  ok(/<script type="application\/json"/i.test(html), `${name}: data is carried as inert application/json`);
}

// The detector itself must be able to fail — otherwise this whole file is decoration.
ok(runnableScripts(`<script>alert(1)</script>`).length === 1, "detector CATCHES a bare inline script");
ok(runnableScripts(`<script type="application/json">{}</script>`).length === 0, "detector IGNORES a json payload");
ok(runnableScripts(`<script src="/a.js"></script>`).length === 1, "detector SEES a src script (then classified)");

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
