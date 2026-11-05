// Eval Hub — MULTI-TARGET GATING POSTURE. Route-level test against a REAL, THROWAWAY database
// (pattern of scripts/test-hub-phase4.mts).
//
// What it proves, and what it is able to fail on:
//   1. A newly created target is 'advisory' — the hub NEVER auto-claims a deploy gate.
//   2. Only an explicit {gating:'gate'} declares one, and re-upserting {name,kind} (which every
//      product runner does on every run) must NOT silently demote it back to advisory.
//   3. `gateChecks` is a MEASUREMENT: zero until GET /api/gate/:target is actually answered, and it
//      counts real answers, not declarations.
//   4. The rendered dashboard says the true thing for each posture — an advisory target's page must
//      not carry the "every deploy passes a gate that can say no" claim, and a gated one must.
//   5. The vocabulary is closed AT THE DATABASE: 'sometimes' is not a posture.
//
// Without EVALHUB_DATABASE_URL this prints a LOUD SKIP and exits 0 WITHOUT claiming a pass.
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { makeSql } from "../src/db.js";
import { ensureSchema } from "../src/ensure-schema.js";
import { buildServer } from "../src/server.js";

const ADMIN_URL = process.env.EVALHUB_DATABASE_URL || "";
if (!ADMIN_URL) {
  console.log("\n" + "=".repeat(78));
  console.log("  SKIP  scripts/test-hub-targets.mts — EVALHUB_DATABASE_URL is NOT SET.");
  console.log("  NOTHING WAS TESTED. The gating posture, the gate_checks measurement and the");
  console.log("  per-posture dashboard copy were ALL skipped.");
  console.log("  Run:  EVALHUB_DATABASE_URL=postgres://…/postgres npx tsx scripts/test-hub-targets.mts");
  console.log("=".repeat(78) + "\n");
  process.exit(0);
}

let fail = 0;
const ok = (c: boolean, what: string, d: unknown = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${what}${d !== "" ? `  (${String(d)})` : ""}`);
  if (!c) fail++;
};
const cannot = (wrong: boolean, what: string) => {
  console.log(`  ${!wrong ? "PASS" : "FAIL"}  [neg-control] ${what}`);
  if (wrong) fail++;
};

// ── throwaway database ────────────────────────────────────────────────────────────────────────
const DBNAME = `evalhub_tg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
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
  console.log("  Falling back to the SUPPLIED database with explicit row cleanup. Say so out loud:");
  console.log("  this run did NOT verify against a virgin schema.");
  console.log("!".repeat(78) + "\n");
}
const DB_URL = createdDb ? testUrl.toString() : ADMIN_URL;

const TOKEN = "tg-token-" + Math.random().toString(36).slice(2, 10);
const sql = makeSql(DB_URL);
await ensureSchema(sql);
const app = buildServer({ sql, token: TOKEN, regressionPct: 1.0 });
await app.listen({ port: 0, host: "127.0.0.1" });
const BASE = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

const GATED = "tg_gated_" + Math.random().toString(36).slice(2, 8);
const ADVISORY = "tg_advis_" + Math.random().toString(36).slice(2, 8);
const SHA = "cafe123";
console.log(`\n[targets] db ${createdDb ? DBNAME + " (throwaway)" : "SUPPLIED DB (fallback)"} · hub ${BASE}\n`);

type Res<T2> = { status: number; body: T2; text: string };
async function call<T2 = any>(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Res<T2>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-evalhub-token"] = token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = { error: "non_json" }; }
  return { status: res.status, body: parsed as T2, text };
}

async function seedRun(target: string, suite: string, sha: string, n: number, passing: number) {
  const r = await call("POST", "/api/runs", { target, suite, gitSha: sha });
  const runId = (r.body as any).runId as string;
  const results = Array.from({ length: n }, (_, i) => ({
    caseId: `${suite}_c${i}`, pass: i < passing, score: i < passing ? 100 : 0, latencyMs: 40 + i,
  }));
  await call("POST", `/api/runs/${runId}/results`, { results });
  await call("POST", `/api/runs/${runId}/finish`, {});
  return runId;
}

try {
  console.log("── a new target is ADVISORY until somebody says otherwise ──");
  const a = await call("POST", "/api/targets", { name: ADVISORY });
  ok(a.status === 200 && (a.body as any).gating === "advisory", "a target created with no posture is advisory", (a.body as any).gating);
  cannot((a.body as any).gating === "gate", "creating a target does not claim a deploy gate");

  console.log("\n── only an explicit declaration creates a gate, and a plain re-upsert cannot undo it ──");
  const g1 = await call("POST", "/api/targets", { name: GATED, kind: "product", gating: "gate" });
  ok((g1.body as any).gating === "gate", "an explicit {gating:'gate'} is stored", (g1.body as any).gating);
  const g2 = await call("POST", "/api/targets", { name: GATED, kind: "product" });
  ok((g2.body as any).gating === "gate", "a runner's {name,kind} upsert PRESERVES the declared gate", (g2.body as any).gating);
  cannot((g2.body as any).gating === "advisory", "an omitted `gating` does not silently demote a real gate");
  const g3 = await call("POST", "/api/targets", { name: GATED, kind: "product", gating: "advisory" });
  ok((g3.body as any).gating === "advisory", "an explicit demotion IS honoured — the field is not write-once", (g3.body as any).gating);
  await call("POST", "/api/targets", { name: GATED, kind: "product", gating: "gate" });

  console.log("\n── the vocabulary is closed at BOTH layers ──");
  const bad = await call("POST", "/api/targets", { name: GATED, gating: "sometimes" });
  ok(bad.status === 400, "the API refuses an unknown posture", bad.status);
  let dbRefused = false;
  try { await sql`UPDATE targets SET gating = 'sometimes' WHERE name = ${GATED}`; }
  catch { dbRefused = true; }
  ok(dbRefused, "and so does the DATABASE — psql cannot store a posture nobody can interpret");

  console.log("\n── gateChecks is a MEASUREMENT, not a restatement of the declaration ──");
  let d = await call("GET", `/api/dashboard/${GATED}`);
  ok((d.body as any).gating?.declared === "gate", "the dashboard carries the declaration", (d.body as any).gating?.declared);
  ok((d.body as any).gating?.gateChecks === 0, "…and ZERO gate checks, because no deploy has asked yet", (d.body as any).gating?.gateChecks);
  cannot((d.body as any).gating?.gateChecks > 0, "declaring a gate does not fabricate evidence that one ran");

  await seedRun(GATED, "unit", SHA, 4, 4);
  const gate = await call("GET", `/api/gate/${GATED}?sha=${SHA}`);
  ok(gate.status === 200 && (gate.body as any).verdict === "pass", "the gate answers for a finished run", (gate.body as any).verdict);
  d = await call("GET", `/api/dashboard/${GATED}`);
  ok((d.body as any).gating?.gateChecks === 1, "the answered gate check is now COUNTED", (d.body as any).gating?.gateChecks);
  ok(typeof (d.body as any).gating?.lastGateAt === "string", "…with the time it happened", (d.body as any).gating?.lastGateAt);

  const dAdv = await call("GET", `/api/dashboard/${ADVISORY}`);
  ok((dAdv.body as any).gating?.gateChecks === 0, "an untouched target still measures zero", (dAdv.body as any).gating?.gateChecks);
  const names = ((d.body as any).targets ?? []).map((t: any) => `${t.name}:${t.gating}`).sort();
  ok(names.length >= 2 && names.some((n: string) => n.endsWith(":advisory")) && names.some((n: string) => n.endsWith(":gate")),
    "the cross-target list carries each target's posture", names.join(" "));

  console.log("\n── the PAGE says the true thing for each posture ──");
  const pGated = await fetch(`${BASE}/dashboard/${GATED}?token=${TOKEN}`).then((r) => r.text());
  const pAdv = await fetch(`${BASE}/dashboard/${ADVISORY}?token=${TOKEN}`).then((r) => r.text());
  ok(/a gate that can say no/.test(pGated), "the gated page makes the gate claim");
  ok(/DEPLOY-GATING/.test(pGated), "…and labels it as DECLARED");
  cannot(/a gate that can say no/.test(pAdv), "the advisory page does NOT make the gate claim");
  ok(/ADVISORY &mdash; NO GATE/.test(pAdv), "the advisory page states its posture on its face");
  ok(/block no deploy|blocks no deploy|blocking nothing/i.test(pAdv), "…and says in words that it blocks nothing");
  ok(/<b>no<\/b> gate check for this target, which is what an advisory posture/.test(pAdv),
    "…and reads an absent gate check as CONSISTENT with advisory, not as a missing gate");
  ok(/answered <b>1<\/b> gate check/.test(pGated), "the gated page prints the MEASURED check count", "1");
  // The uncomfortable case: a target that DECLARES a gate but has never been asked for one must
  // say so on its own page, in the headline block, instead of quietly making the gate claim.
  const NEVER = "tg_neverg_" + Math.random().toString(36).slice(2, 8);
  await call("POST", "/api/targets", { name: NEVER, kind: "product", gating: "gate" });
  const pNever = await fetch(`${BASE}/dashboard/${NEVER}?token=${TOKEN}`).then((r) => r.text());
  ok(/nothing observed here supports/.test(pNever), "a declared gate with zero checks admits it is unsupported");
  await sql`DELETE FROM targets WHERE name = ${NEVER}`;
} finally {
  await app.close();
  if (!createdDb) {
    try {
      await sql`DELETE FROM gate_checks WHERE target IN (${GATED}, ${ADVISORY})`;
      await sql`DELETE FROM results WHERE run_id IN (SELECT id FROM runs WHERE target IN (${GATED}, ${ADVISORY}))`;
      await sql`DELETE FROM runs WHERE target IN (${GATED}, ${ADVISORY})`;
      await sql`DELETE FROM baselines WHERE target IN (${GATED}, ${ADVISORY})`;
      await sql`DELETE FROM alerts WHERE target IN (${GATED}, ${ADVISORY})`;
      await sql`DELETE FROM targets WHERE name IN (${GATED}, ${ADVISORY})`;
    } catch (e) { console.error("cleanup failed:", e); }
  }
  await sql.end({ timeout: 5 });
  if (createdDb) {
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DBNAME}" WITH (FORCE)`);
      console.log(`\n[targets] dropped throwaway database ${DBNAME}`);
    } catch (e) { console.error(`\n[targets] COULD NOT DROP ${DBNAME}:`, String((e as Error).message)); fail++; }
  }
  await admin.end({ timeout: 5 });
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nALL PASS — advisory default, declaration preserved across runner upserts, closed vocabulary at API + DB, measured gate checks, per-posture page copy");
process.exit(fail ? 1 : 0);
