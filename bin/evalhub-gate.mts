#!/usr/bin/env -S npx tsx
// evalhub-gate <target> --sha <gitSha> [--promote]
//
// The one gate that blocks any product's deploy on an eval regression.
//   exit 0  → 'pass'
//   exit 1  → 'fail'     (prints the regressed suites)
//   exit 2  → 'no_runs'  (a deploy without evals must FAIL LOUDLY, not slip through as "fine")
// --promote promotes every finished suite run of this sha to baseline (run AFTER a good deploy).
// Env: EVALHUB_URL (default http://127.0.0.1:4290), EVALHUB_TOKEN.

type GateSuite = {
  suite: string; runId: string; score: number; baseline: number | null; regression: boolean;
  failures?: string[]; failuresTotal?: number; failuresTruncated?: boolean;
};
type GateResp = { ok: boolean; target: string; sha: string; suites: GateSuite[]; verdict: "pass" | "fail" | "no_runs"; regressionPct: number };

const argv = process.argv.slice(2);
function flag(name: string): boolean { return argv.includes(`--${name}`); }
function opt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

// positional = anything that is neither a flag nor the VALUE of a value-taking flag
const VALUE_FLAGS = new Set(["--sha", "--url"]);
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) { if (VALUE_FLAGS.has(a)) i++; continue; }
  positional.push(a);
}
const target = positional[0];
const sha = opt("sha");
if (!target || !sha) {
  console.error("usage: evalhub-gate <target> --sha <gitSha> [--promote]");
  process.exit(2);
}

const BASE = (opt("url") || process.env.EVALHUB_URL || "http://127.0.0.1:4290").replace(/\/+$/, "");
const TOKEN = process.env.EVALHUB_TOKEN || "";
if (!TOKEN) {
  console.error("[gate] EVALHUB_TOKEN is not set — cannot query the hub. Refusing to pass a gate I could not run.");
  process.exit(2);
}

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-evalhub-token": TOKEN, ...(init?.headers || {}) },
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { body = { error: "non_json_response" }; }
  return { status: res.status, body: body as T };
}

const gate = await api<GateResp>(`/api/gate/${encodeURIComponent(target)}?sha=${encodeURIComponent(sha)}`).catch((e) => {
  console.error(`[gate] cannot reach the hub at ${BASE}: ${(e as Error).message}`);
  process.exit(2);
});

if (gate.status !== 200 || !gate.body?.ok) {
  console.error(`[gate] hub answered ${gate.status}: ${JSON.stringify(gate.body)}`);
  process.exit(2);
}

const { suites, verdict, regressionPct } = gate.body;
console.log(`[gate] ${target} @ ${sha} — ${suites.length} finished suite(s), tolerance ${regressionPct}pt`);
for (const s of suites) {
  const base = s.baseline === null ? "no baseline" : `baseline ${s.baseline}`;
  const delta = s.baseline === null ? "" : ` (${(s.score - s.baseline >= 0 ? "+" : "")}${(s.score - s.baseline).toFixed(2)})`;
  console.log(`  ${s.regression ? "REGRESSION" : "ok        "}  ${s.suite}  score ${s.score}  ${base}${delta}`);
}

if (verdict === "no_runs") {
  console.error(`[gate] NO_RUNS — no finished eval run for ${target} @ ${sha}. A deploy without evals does not pass.`);
  process.exit(2);
}
if (verdict === "fail") {
  const bad = suites.filter((s) => s.regression);
  console.error(`[gate] FAIL — ${bad.length} regressed suite(s): ${bad.map((s) => s.suite).join(", ")}`);
  for (const s of bad) {
    const f = s.failures ?? [];
    if (f.length) {
      console.error(`  ${s.suite} failing cases (${s.failuresTotal ?? f.length}${s.failuresTruncated ? ", TRUNCATED to 20" : ""}):`);
      for (const c of f) console.error(`    - ${c}`);
    }
  }
  process.exit(1);
}

console.log(`[gate] PASS`);

if (flag("promote")) {
  let promoted = 0, refused = 0;
  for (const s of suites) {
    const r = await api<{ ok: boolean; error?: string; baseline?: number }>("/api/baselines/promote", {
      method: "POST",
      body: JSON.stringify({ target, suite: s.suite, runId: s.runId }),
    });
    if (r.status === 200 && r.body.ok) { promoted++; console.log(`[gate] promoted ${s.suite} → baseline ${s.score}`); }
    else { refused++; console.log(`[gate] NOT promoted ${s.suite}: ${r.status} ${r.body?.error ?? ""}${r.body?.baseline !== undefined ? ` (current baseline ${r.body.baseline})` : ""}`); }
  }
  // Promotion is bookkeeping AFTER a green deploy; a refusal (score below an existing baseline)
  // is reported, not fatal — the deploy already happened and the gate already passed.
  console.log(`[gate] promote: ${promoted} promoted, ${refused} refused`);
}

process.exit(0);
