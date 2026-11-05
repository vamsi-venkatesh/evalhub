// Eval Hub — write a stakeholder release report to a file (Phase 4 addendum §17:
// "scripts/report.mts writes it to a file for pasting into the vault change log").
//
// It FETCHES the hub's own rendering; it does not re-derive a single number. If the markdown and
// this file could disagree, one of them would eventually be the lie.
//
//   npx tsx scripts/report.mts <target> [--sha <gitSha>] [--format md|json] [--out <path>] [--days 7]
//   env: EVALHUB_URL (default http://127.0.0.1:4290), EVALHUB_TOKEN
//
// Exit 0 on a written file, 1 on any failure. It never writes a partial file: the body is fetched
// whole, then written.
import { writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const target = argv[0];
if (!target || target.startsWith("--")) {
  console.error("usage: tsx scripts/report.mts <target> [--sha <gitSha>] [--format md|json] [--out <path>] [--days 7]");
  process.exit(1);
}
function flag(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? String(argv[i + 1]) : null;
}

const url = (process.env.EVALHUB_URL || "http://127.0.0.1:4290").replace(/\/+$/, "");
const token = process.env.EVALHUB_TOKEN || "";
if (!token) {
  console.error("[report] EVALHUB_TOKEN is not set — every /api request will 401. Refusing to pretend otherwise.");
  process.exit(1);
}
const format = flag("format") === "json" ? "json" : "md";
const sha = flag("sha");
const days = flag("days");
const qs = new URLSearchParams({ format });
if (sha) qs.set("sha", sha);
if (days) qs.set("days", days);

const endpoint = `${url}/api/report/${encodeURIComponent(target)}?${qs.toString()}`;
const res = await fetch(endpoint, { headers: { "x-evalhub-token": token } });
const body = await res.text();
if (!res.ok) {
  console.error(`[report] ${res.status} from ${endpoint}\n${body.slice(0, 800)}`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
const out = flag("out") || `evalhub-report-${target}-${sha ?? "latest"}-${stamp}.${format}`;
await writeFile(out, format === "json" ? JSON.stringify(JSON.parse(body), null, 2) + "\n" : body, "utf8");
console.log(`[report] wrote ${out} (${Buffer.byteLength(body, "utf8")} bytes, format ${format}, from ${endpoint})`);
