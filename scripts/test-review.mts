// Eval Hub — the labelling screen + the review ranker. ROUTE-LEVEL, against a REAL throwaway
// database, driving the REAL server over HTTP (pattern of scripts/test-hub-phase3.mts). The judged
// rows it seeds are the SHAPE of the live hub's own rows (grounding valid[], tailoring truncated
// preview) — verified read-only against 169 on 2026-08-05 — because a fixture that does not look
// like production proves nothing about production.
//
// EVERY assertion here is paired with the question "how would this fail?". The negative controls
// (marked [neg-control]) assert the OPPOSITE of a thing that must not happen; if the code under
// test stopped working they would go red, which is the only reason to trust the greens.
//
// Without EVALHUB_DATABASE_URL this prints a LOUD SKIP and exits 0 WITHOUT claiming a pass.
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { makeSql } from "../src/db.js";
import { ensureSchema } from "../src/ensure-schema.js";
import { buildServer } from "../src/server.js";
import { buildReviewCard, rankReviewCandidates, salvageClaims, type JudgedRow } from "../src/review.js";
import { MIN_CALIBRATION_LABELS } from "../src/kappa.js";

const ADMIN_URL = process.env.EVALHUB_DATABASE_URL || "";
if (!ADMIN_URL) {
  console.log("\n" + "=".repeat(78));
  console.log("  SKIP  scripts/test-review.mts — EVALHUB_DATABASE_URL is NOT SET.");
  console.log("  NOTHING WAS TESTED. The ranker, the card builder, the /review HTML route, its POST");
  console.log("  resolve path, the label round trip and the live kappa readout were ALL skipped.");
  console.log("  Run:  EVALHUB_DATABASE_URL=postgres://…/postgres npx tsx scripts/test-review.mts");
  console.log("=".repeat(78) + "\n");
  process.exit(0);
}

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
const cannot = (wrong: boolean, what: string, d: unknown = "") => {
  console.log(`  ${!wrong ? "PASS" : "FAIL"}  [neg-control] ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (wrong) fail++;
};

// ── throwaway database ────────────────────────────────────────────────────────────────────────
const DBNAME = `evalhub_rev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = "/" + DBNAME;
const admin = postgres(new URL(ADMIN_URL).toString(), { max: 1, onnotice: () => {} });
let createdDb = false;
try {
  await admin.unsafe(`CREATE DATABASE "${DBNAME}"`);
  createdDb = true;
} catch (e) {
  console.log("\n" + "!".repeat(78));
  console.log(`  CREATE DATABASE failed (${String((e as Error).message).slice(0, 120)}).`);
  console.log("  Falling back to the SUPPLIED database. Say so out loud: this run did NOT verify");
  console.log("  against a virgin schema.");
  console.log("!".repeat(78) + "\n");
}
const DB_URL = createdDb ? testUrl.toString() : ADMIN_URL;

const TOKEN = "rev-token-" + Math.random().toString(36).slice(2, 10);
const sql = makeSql(DB_URL);
await ensureSchema(sql);
const app = buildServer({ sql, token: TOKEN });
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const T = "rev_" + Math.random().toString(36).slice(2, 8);
console.log(`\n[review] db ${createdDb ? DBNAME + " (throwaway)" : "SUPPLIED DB (fallback)"} · hub ${BASE} · target ${T}\n`);

type Res<T2> = { status: number; body: T2; text: string; contentType: string };
async function call<T2 = any>(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Res<T2>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-evalhub-token"] = token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = { error: "non_json" }; }
  return { status: res.status, body: parsed as T2, text, contentType: res.headers.get("content-type") || "" };
}

// ── fixture rows, in the LIVE hub's shapes ───────────────────────────────────────────────────
function groundingRow(id: string, rate: number): JudgedRow {
  return {
    suite: "grounding", caseId: id, pass: rate === 1,
    scores: { judgeVerdict: rate < 1 ? "fail" : "pass", groundingRate: rate },
    output: { ok: true, kind: "grounding", citationCount: 2, groundingRate: rate, valid: [
      { found: rate === 1, match: "exact", quote: `quote for ${id}`, evidence: `evidence for ${id}`, sourceId: "jd-berlin", similarity: rate === 1 ? 1 : 0.4 },
    ] },
    tags: ["llm", "grounding"], gitSha: "sha1", measuredAt: new Date().toISOString(),
  };
}
function tailoringRow(id: string, rate: number, truncated = false): JudgedRow {
  const claims = [
    { text: `claim A of ${id}`, supported: rate === 0, bestSource: 0, evidence: `résumé line for ${id}`, method: "anchor", similarity: null },
    { text: `claim B of ${id}`, supported: true, bestSource: 0, evidence: `another line for ${id}`, method: "anchor", similarity: null },
  ];
  const full = { ok: true, kind: "hallucination", claims, hallucinationRate: rate, claimCount: 14, model: "m" };
  return {
    suite: "tailoring_integrity", caseId: id, pass: rate === 0,
    scores: { judgeVerdict: rate > 0 ? "fail" : "pass", hallucinationRate: rate, claimCount: 14 },
    output: truncated
      ? { truncated: true, originalChars: 8837, preview: JSON.stringify(full).slice(0, 260) }
      : full,
    tags: ["llm", "tailoring"], gitSha: "sha1", measuredAt: new Date().toISOString(),
  };
}

try {
  // ══ 1. the ranker (PURE) ═══════════════════════════════════════════════════════════════════
  console.log("── rankReviewCandidates (pure) ──");
  const rows: JudgedRow[] = [
    tailoringRow("tail-far", 0.25), tailoringRow("tail-near", 0.06), tailoringRow("tail-mid", 0.12),
    tailoringRow("tail-pass1", 0), tailoringRow("tail-pass2", 0),
    groundingRow("grnd-fail", 0), groundingRow("grnd-pass1", 1), groundingRow("grnd-pass2", 1),
    { ...groundingRow("grnd-nometric", 1), scores: { judgeVerdict: "pass" } },
    { ...groundingRow("grnd-borderline", 0.5), scores: { judgeVerdict: "borderline", groundingRate: 0.5 } },
    { ...groundingRow("grnd-unknownsuite", 1), suite: "role_family" },
  ];
  const r = rankReviewCandidates(rows);
  ok(r.ordered[0]!.row.caseId === "tail-near" && r.ordered[1]!.row.caseId === "tail-mid",
    "the borderline band comes FIRST, closest to the flip point first",
    r.ordered.slice(0, 3).map((c) => c.row.caseId).join(" → "));
  ok(r.ordered.filter((c) => c.tier === 1).length === 2, "exactly the two in-band cases are tier 1", r.counts.tier1Borderline);
  const t2 = r.ordered.filter((c) => c.tier === 2);
  ok(t2.length >= 4 && t2[0]!.verdict !== t2[1]!.verdict, "tier 2 ALTERNATES verdicts",
    t2.slice(0, 4).map((c) => `${c.row.caseId}:${c.verdict}`).join(" "));
  ok(r.counts.confidenceFieldFound === false, "no confidence field is claimed where none exists");
  ok(r.explanation.join(" ").includes("NO per-case judge confidence exists"),
    "the explanation SAYS there is no confidence signal");
  const exReasons = r.excluded.map((e) => `${e.caseId}:${e.reason}`).sort();
  ok(exReasons.some((x) => x.startsWith("grnd-nometric:metric_missing")), "a row with no metric is excluded and named");
  ok(exReasons.some((x) => x.startsWith("grnd-borderline:judge_verdict_not_binary")), "a non-binary judge verdict is excluded and named");
  ok(exReasons.some((x) => x.startsWith("grnd-unknownsuite:no_known_metric_for_suite")), "an unknown suite is excluded and named");
  cannot(r.ordered.some((c) => c.row.caseId === "grnd-borderline"),
    "a 'borderline' judge verdict is NOT silently mapped to pass or fail");

  const limited = rankReviewCandidates(rows, { limit: 3 });
  ok(limited.ordered.length === 3, "--limit truncates the batch", limited.ordered.length);
  ok(limited.excluded.filter((e) => e.reason.startsWith("over_limit")).length === 5,
    "everything the limit dropped is named as over_limit, never silent",
    limited.excluded.filter((e) => e.reason.startsWith("over_limit")).length);

  // determinism: same input, same order.
  ok(JSON.stringify(rankReviewCandidates(rows).ordered.map((c) => c.row.caseId)) ===
     JSON.stringify(r.ordered.map((c) => c.row.caseId)), "the ranking is deterministic");

  // ══ 2. the card (PURE) ═════════════════════════════════════════════════════════════════════
  console.log("\n── buildReviewCard + salvageClaims (pure) ──");
  const truncCand = rankReviewCandidates([tailoringRow("tail-trunc", 0.1, true)]).ordered[0]!;
  const truncCard = buildReviewCard(truncCand);
  ok(truncCard.evidence.length >= 1, "whole claims are salvaged from a TRUNCATED preview", truncCard.evidence.length);
  ok(truncCard.gaps.some((g) => g.startsWith("Evidence is PARTIAL")),
    "the card SAYS the evidence is partial when the product truncated the payload");
  cannot(truncCard.evidence.some((e) => e.claim === ""), "no empty/half-parsed claim is manufactured from the cut-off tail");
  ok(salvageClaims('{"claims":[{"text":"a","supported":true},{"text":"b","supp').length === 1,
    "salvageClaims drops the incomplete trailing object instead of repairing it");
  ok(salvageClaims("no claims here at all").length === 0, "salvageClaims returns nothing when there is no claims array");

  const noFixture = buildReviewCard(rankReviewCandidates([groundingRow("grnd-x", 0.5)]).ordered[0]!);
  ok(noFixture.input === null && noFixture.gaps.some((g) => g.includes("not stored by the hub")),
    "without a fixture the missing case input is STATED, not implied");
  const withFixture = buildReviewCard(
    rankReviewCandidates([groundingRow("grnd-y", 0.5)]).ordered[0]!,
    { id: "grnd-y", input: { answer: "the answer", citations: [{ sourceId: "s1", quote: "q" }], sources: { s1: "source text" } } },
  );
  ok(withFixture.input !== null && withFixture.answer!.text === "the answer" && withFixture.source!.text.includes("source text"),
    "with a fixture the card carries the input, the agent's answer and the source");
  ok(withFixture.judge.reasoning.includes("groundingRate = 0.5") && withFixture.judge.rule === "groundingRate < 1",
    "the judge's rule and its actual number are on the card", withFixture.judge.reasoning.slice(0, 60));
  const failFirst = buildReviewCard(rankReviewCandidates([tailoringRow("tail-order", 0.5)]).ordered[0]!);
  ok(failFirst.evidence[0]!.state === "unsupported", "the items the verdict hinges on are shown first",
    failFirst.evidence.map((e) => e.state).join(","));

  // ══ 3. seed the hub and enqueue ════════════════════════════════════════════════════════════
  console.log("\n── seeding real-shaped judged rows through the hub's own routes ──");
  await call("POST", "/api/targets", { name: T });
  const seeded: JudgedRow[] = [];
  for (let i = 0; i < 12; i++) seeded.push(tailoringRow(`tail-${i}`, i < 6 ? 0.05 + i * 0.02 : 0));
  for (let i = 0; i < 12; i++) seeded.push(groundingRow(`grnd-${i}`, i < 6 ? 0.5 : 1));
  for (const suite of ["tailoring_integrity", "grounding"]) {
    const mine = seeded.filter((s) => s.suite === suite);
    const run = await call("POST", "/api/runs", { target: T, suite, gitSha: "sha1" });
    const push = await call("POST", `/api/runs/${run.body.runId}/results`, {
      results: mine.map((m) => ({ caseId: m.caseId, pass: m.pass, scores: m.scores, output: m.output, tags: m.tags })),
    });
    if (push.status !== 200) throw new Error(`seed failed: ${push.text}`);
    await call("POST", `/api/runs/${run.body.runId}/finish`, {});
  }
  const ranked = rankReviewCandidates(seeded);
  ok(ranked.ordered.length === 24, "all 24 seeded cases rank", ranked.ordered.length);

  for (const suite of ["tailoring_integrity", "grounding"]) {
    const items = ranked.ordered.filter((c) => c.row.suite === suite).map((c) => ({
      caseId: c.row.caseId, reason: c.borderline ? "judge_borderline" : "manual", payload: buildReviewCard(c),
    }));
    const e = await call("POST", "/api/review/enqueue", { target: T, suite, items });
    ok(e.status === 200 && e.body.enqueued === items.length, `enqueued ${suite}`, JSON.stringify(e.body));
  }
  // THE DEDUP CLAIM, tested rather than trusted: the same items again must add NOTHING.
  const again = await call("POST", "/api/review/enqueue", {
    target: T, suite: "grounding",
    items: ranked.ordered.filter((c) => c.row.suite === "grounding").map((c) => ({ caseId: c.row.caseId, reason: "manual", payload: {} })),
  });
  ok(again.status === 200 && again.body.enqueued === 0 && again.body.duplicates === 12,
    "re-enqueueing OPEN cases enqueues nothing and counts every one as a duplicate", JSON.stringify(again.body));
  const openNow = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM review_queue WHERE target = ${T} AND state = 'open'`;
  ok(openNow[0]!.n === 24, "the queue still holds exactly 24 open cards after the re-run", openNow[0]!.n);

  // ══ 4. the HTML route ══════════════════════════════════════════════════════════════════════
  console.log("\n── GET /review/:target (HTML) ──");
  const noTok = await fetch(`${BASE}/review/${T}`);
  ok(noTok.status === 401, "no token → 401", noTok.status);
  const badTok = await fetch(`${BASE}/review/${T}?token=nope`);
  ok(badTok.status === 401, "wrong token → 401", badTok.status);
  cannot(noTok.status === 200 || badTok.status === 200, "the labelling screen is NOT open to the world");
  const viaHeader = await fetch(`${BASE}/review/${T}`, { headers: { "x-evalhub-token": TOKEN } });
  ok(viaHeader.status === 200, "the header form authenticates (the Worker's path)", viaHeader.status);
  const res = await fetch(`${BASE}/review/${T}?token=${encodeURIComponent(TOKEN)}`);
  const html = await res.text();
  ok(res.status === 200 && (res.headers.get("content-type") || "").startsWith("text/html"), "the query form authenticates (the SSH-tunnel path)", res.status);
  ok((res.headers.get("cache-control") || "") === "no-store", "the page is not cacheable", res.headers.get("cache-control"));

  const schemes = html.match(/[a-z][a-z0-9+.-]*:\/\//gi) ?? [];
  ok(schemes.length === 0, "ZERO scheme-like strings (…://) in the served HTML", schemes.length === 0 ? "none" : JSON.stringify(schemes.slice(0, 5)));
  // THE CHECK CAN FAIL: the same regex over a deliberately poisoned copy must find the CDN.
  const poisoned = html.replace("</head>", '<link rel="stylesheet" href="https://cdn.example.com/x.css"></head>');
  cannot((poisoned.match(/[a-z][a-z0-9+.-]*:\/\//gi) ?? []).length === 0,
    "the zero-external-request check CAN fail — a planted CDN link is caught");
  ok(!/innerHTML/.test(html), "the page contains no innerHTML anywhere");

  // The script is served as a FILE (the vhost's `script-src 'self'` drops inline scripts silently),
  // so the honesty copy lives there. Fetch it and assert on it — and assert the page really points
  // at it, or these checks would pass on a page whose script 404s.
  ok(/<script[^>]+\bsrc\s*=\s*["']app\.js["']/i.test(html), "the page loads its script from a RELATIVE same-origin src");
  const appRes2 = await fetch(`${BASE}/review/app.js?token=${encodeURIComponent(TOKEN)}`);
  const appJs = await appRes2.text();
  ok(appRes2.status === 200 && (appRes2.headers.get("content-type") ?? "").includes("javascript"),
    "GET /review/app.js → 200 as JavaScript", `${appRes2.status} ${appRes2.headers.get("content-type")}`);
  // FOUR backslashes in the source = a regex matching TWO literal ones. A SINGLE \uXXXX in the
  // served script is correct JS source that parses to the character; a DOUBLED \\uXXXX is the bug
  // (String.raw preserves the doubling, and the browser then prints a literal backslash-u).
  ok(!/\\\\u[0-9a-fA-F]{4}/.test(appJs), "the served script has no DOUBLED unicode escapes");
  ok(/\\u[0-9a-fA-F]{4}/.test(appJs), "…and it does still carry real unicode escapes, so that check is looking at something");
  ok(html.includes(">a &middot; d &middot; s<") || html.includes("Agree with judge"), "the three keys are printed on the page");
  ok(/ADVISORY/.test(appJs) || appJs.includes("gates nothing"), "the page says the judge is advisory while no kappa exists");

  const embedded = JSON.parse(html.split('<script type="application/json" id="data">')[1]!.split("</script>")[0]!);
  ok(embedded.kappa === null, "kappa is NULL, not 0, while no labels exist", JSON.stringify(embedded.kappa));
  ok(embedded.counts.total === 24 && embedded.counts.labeled === 0, "progress starts at 0 of 24", JSON.stringify(embedded.counts));
  ok(embedded.postPath === `/review/${T}/resolve` && !/^https?:/.test(embedded.postPath),
    "the POST path is RELATIVE — the page can never call an absolute host", embedded.postPath);
  ok(embedded.items.length === 24 && embedded.items[0].card && embedded.items[0].card.v === 1,
    "every open card is embedded, already normalised", embedded.items.length);

  // ══ 5. the label round trip ════════════════════════════════════════════════════════════════
  console.log("\n── POST /review/:target/resolve — the round trip into labels ──");
  const first = embedded.items[0];
  const bad = await fetch(`${BASE}/review/${T}/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: first.id, verdict: "pass", labeler: "founder" }),
  });
  ok(bad.status === 401, "the resolve route refuses an unauthenticated POST", bad.status);

  async function resolve(id: string, verdict: string) {
    const r2 = await fetch(`${BASE}/review/${T}/resolve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, verdict, labeler: "founder", token: TOKEN }),
    });
    return { status: r2.status, body: (await r2.json()) as any };
  }

  const agree = await resolve(first.id, first.card.judge.verdict);
  ok(agree.status === 200 && agree.body.labelWritten === true, "a label round-trips through the screen's own POST", JSON.stringify(agree.body).slice(0, 120));
  const lab = await sql<{ verdict: string; labeler: string }[]>`
    SELECT human->>'verdict' AS verdict, labeler FROM labels WHERE target = ${T} AND case_id = ${first.caseId}`;
  ok(lab.length === 1 && lab[0]!.verdict === first.card.judge.verdict, "the labels TABLE holds the human verdict", JSON.stringify(lab));
  const st = await sql<{ state: string }[]>`SELECT state FROM review_queue WHERE id = ${first.id}::uuid`;
  ok(st[0]!.state === "labeled", "the queue card is closed as labeled", st[0]!.state);
  const twice = await resolve(first.id, "fail");
  ok(twice.status === 409, "resolving the same card twice is refused (409), never double-counted", twice.status);

  const second = embedded.items[1];
  const disagree = await resolve(second.id, second.card.judge.verdict === "pass" ? "fail" : "pass");
  const lab2 = await sql<{ verdict: string }[]>`SELECT human->>'verdict' AS verdict FROM labels WHERE target = ${T} AND case_id = ${second.caseId}`;
  ok(disagree.status === 200 && lab2[0]!.verdict !== second.card.judge.verdict,
    "disagree writes the OPPOSITE of the judge's verdict", `${second.card.judge.verdict} → ${lab2[0]!.verdict}`);

  const third = embedded.items[2];
  const skipped = await resolve(third.id, "skip");
  const lab3 = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM labels WHERE target = ${T} AND case_id = ${third.caseId}`;
  ok(skipped.status === 200 && skipped.body.labelWritten === false && lab3[0]!.n === 0,
    "a SKIP writes no label — 'I don't know' never becomes a verdict", JSON.stringify({ n: lab3[0]!.n }));
  const st3 = await sql<{ state: string }[]>`SELECT state FROM review_queue WHERE id = ${third.id}::uuid`;
  ok(st3[0]!.state === "skipped", "a skipped card is closed as skipped, not labeled", st3[0]!.state);

  // ══ 6. the live kappa readout ══════════════════════════════════════════════════════════════
  console.log("\n── the kappa readout: absent below the floor, with n beside it above ──");
  ok(agree.body.kappa === null, `kappa is still null at 1 label (floor is ${MIN_CALIBRATION_LABELS})`, JSON.stringify(agree.body.kappa));
  ok(agree.body.kappaPairs === 1, "the pair count is shown even below the floor", agree.body.kappaPairs);

  let last: any = null;
  const rest = embedded.items.slice(3);
  for (let i = 0; i < rest.length; i++) {
    // A deliberately MIXED set of human verdicts: agreeing with every judgement would make the
    // corpus single-category, and a degenerate kappa is not evidence the readout works.
    const v = i % 3 === 0 ? (rest[i].card.judge.verdict === "pass" ? "fail" : "pass") : rest[i].card.judge.verdict;
    last = (await resolve(rest[i].id, v)).body;
  }
  const labelled = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM labels WHERE target = ${T}`;
  ok(labelled[0]!.n >= MIN_CALIBRATION_LABELS, "enough labels now exist for a kappa", labelled[0]!.n);
  ok(last && last.kappa !== null && typeof last.kappa.kappa === "number" && last.kappa.n === labelled[0]!.n,
    "the readout appears WITH n once the floor is crossed", JSON.stringify(last?.kappa));
  ok(last.kappa.degenerate === false, "the corpus is not single-category, so the kappa is a measurement");

  const html2 = await (await fetch(`${BASE}/review/${T}?token=${encodeURIComponent(TOKEN)}`)).text();
  const emb2 = JSON.parse(html2.split('<script type="application/json" id="data">')[1]!.split("</script>")[0]!);
  ok(emb2.kappa !== null && emb2.kappa.n === labelled[0]!.n, "the reloaded page shows the same kappa and the same n", JSON.stringify(emb2.kappa));
  ok(/ESTIMATE|weak/i.test(html2) || /ESTIMATE|weak/i.test(appJs), "the page still refuses to present the kappa as settled");
  ok(emb2.counts.labeled + emb2.counts.skipped === 24 && emb2.counts.open === 0, "progress reaches 24 of 24", JSON.stringify(emb2.counts));

  // The persisted calibration must agree with the live readout — one definition of a pair, not two.
  const persisted = await call("POST", "/api/calibration/compute", { target: T, judgeModel: "test-judge" });
  ok(persisted.status === 200 && persisted.body.n === last.kappa.n && persisted.body.kappa === last.kappa.kappa,
    "POST /api/calibration/compute produces the SAME kappa and n as the screen's live readout",
    `${persisted.body.kappa}/${persisted.body.n} vs ${last.kappa.kappa}/${last.kappa.n}`);
} finally {
  await app.close();
  await sql.end();
  if (createdDb) {
    try { await admin.unsafe(`DROP DATABASE "${DBNAME}"`); } catch { /* the box keeps it; named in the log above */ }
  }
  await admin.end();
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — ranker, card, /review HTML + auth, the label round trip, dedup, and the live kappa readout");
process.exit(fail ? 1 : 0);
