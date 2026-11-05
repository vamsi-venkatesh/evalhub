// Eval Hub — the stakeholder release report (Phase 4 addendum §17, item 17).
//
// THE LAW OF THIS FILE, quoted from the addendum: "The report NEVER prints a bare 'PASSED'; it
// prints what passed, over what, measured when." Every claim in here therefore carries three
// things — the thing measured, the sample it was measured over, and the timestamp it was measured
// at. There is no sentence in this module that can be true of an empty database.
//
// The second law: a report that only lists what we checked is an advertisement. Every rendering
// ends with "What this does not cover", assembled by RULE from the same data (§`buildNotCovered`),
// so the limits cannot drift out of sync with the numbers above them.
//
// PURE: no DB, no clock, no env. buildReport() takes rows the route already fetched and returns the
// JSON body; renderReportMarkdown() turns that same object into paste-ready markdown for a vault
// change log. Both are unit-tested in scripts/test-hub-phase4.mts against a real assembled report.
import { gateVerdict, round2, type GateSuite } from "./verdict.js";
import { SHADOW_DEFINITION, type ShadowRecommendation } from "./shadow.js";
import { CANARY_DEFINITION } from "./canary.js";

export type ReportSuite = {
  suite: string;
  runId: string;
  score: number;
  total: number | null;
  passed: number | null;
  baseline: number | null;
  delta: number | null;
  regression: boolean;
  measuredAt: string | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  latencySamples: number;
  failures: string[];
  failuresTotal: number;
};

export type ReportCalibration = {
  status: "calibrated" | "uncalibrated";
  judgeModel: string | null;
  kappa: number | null;
  n: number;
  band: string | null;
  at: string | null;
  labels: number;
};

export type ReportSafety = {
  /** The suite whose name marks it as the safety probe set, when one has reported. */
  suite: string | null;
  probes: number;
  measuredAt: string | null;
  score: number | null;
};

export type ReportAlert = { kind: string; suite: string; message: string; createdAt: string; ack: boolean };

export type ReportCost = {
  since: string | null;
  totalUsd: number | null;
  runs: number;
  models: number;
  unknownCostModels: string[];
};

export type ReportShadow = {
  runId: string;
  candidateSha: string;
  baselineSha: string | null;
  recommendation: ShadowRecommendation;
  reason: string;
  compared: number;
  diffs: number;
  diffRate: number | null;
  meanDelta: number | null;
  spendUsd: number | null;
  thresholds: Record<string, unknown>;
  finishedAt: string | null;
} | null;

export type ReportCanary = {
  events: number;
  starts: number;
  promotes: number;
  rollbacks: number;
  last: { phase: string; sha: string; pct: number | null; reason: string | null; createdAt: string } | null;
  note: string;
};

export type ReportInput = {
  target: string;
  sha: string | null;
  generatedAt: string;
  windowDays: number;
  regressionPct: number;
  suites: ReportSuite[];
  /** Suites the target has ever run that did NOT report for this sha. Named, never omitted. */
  suitesMissingForSha: string[];
  calibration: ReportCalibration;
  safety: ReportSafety;
  alerts: { since: string | null; sinceLabel: string; total: number; open: number; items: ReportAlert[] };
  cost: ReportCost;
  shadow: ReportShadow;
  canary: ReportCanary;
};

export type Report = ReportInput & {
  ok: true;
  verdict: "pass" | "fail" | "no_runs";
  headline: string;
  totals: { suites: number; cases: number; passed: number; withBaseline: number; regressions: number };
  regressions: { suite: string; score: number; baseline: number | null; delta: number | null; failures: string[]; failuresTotal: number }[];
  notCovered: string[];
  definitions: { shadow: string; canary: string; percentiles: string; regression: string };
};

/**
 * THE "WHAT THIS DOES NOT COVER" BLOCK — assembled by rule from the report's own data.
 *
 * The three the addendum names explicitly are mandatory and unconditional in their trigger:
 *   1. an UNCALIBRATED judge (whenever no kappa exists),
 *   2. the safety probe COUNT, always with the never-certifies caveat,
 *   3. every suite with NO BASELINE (a suite nothing could regress against).
 * The rest are added when the data warrants them. The block is never empty: a report that
 * covered everything would be the first lie on the page.
 */
export function buildNotCovered(r: Omit<Report, "notCovered" | "definitions">): string[] {
  const out: string[] = [];

  // 1. the judge
  if (r.calibration.status !== "calibrated" || r.calibration.kappa === null) {
    out.push(
      `JUDGE UNCALIBRATED — no kappa has ever been computed for ${r.target}, so any LLM-judge score behind these numbers is ADVISORY and gates nothing. ` +
        `${r.calibration.labels} human label(s) exist; calibration needs a measured agreement before a judge verdict may carry weight.`
    );
  } else {
    out.push(
      `JUDGE AGREEMENT IS A SAMPLE — kappa ${r.calibration.kappa} (${r.calibration.band ?? "band unknown"}) over ${r.calibration.n} human-labelled case(s), measured ${r.calibration.at ?? "at an unknown time"} on model ${r.calibration.judgeModel ?? "unknown"}. ` +
        `It describes agreement on THOSE cases, not on the cases this release will meet.`
    );
  }

  // 2. safety probes — the count, and the caveat, every single time
  if (r.safety.probes === 0) {
    out.push(
      "SAFETY UNMEASURED — no safety probe suite has reported for this target, so nothing on this page says anything about safety. " +
        "A probe set never certifies safety, and here there is not even a probe set."
    );
  } else {
    out.push(
      `SAFETY COVERAGE IS ${r.safety.probes} PROBE(S) — suite "${r.safety.suite}", measured ${r.safety.measuredAt ?? "at an unknown time"}` +
        `${r.safety.score === null ? "" : `, scoring ${r.safety.score}`}. ` +
        "A probe set of this size NEVER certifies safety: it can only report findings over the probes it ran. " +
        "Absence of a finding here is absence of a finding, not absence of harm."
    );
  }

  // 3. suites with no baseline
  const noBase = r.suites.filter((s) => s.baseline === null).map((s) => s.suite);
  if (noBase.length > 0) {
    out.push(
      `NO BASELINE ON ${noBase.length} SUITE(S) — ${noBase.join(", ")}. Their scores are reported, but nothing could regress against them: ` +
        "a suite without a promoted baseline cannot fail the gate, however low it scores."
    );
  } else if (r.suites.length === 0) {
    out.push(
      `NO SUITE REPORTED FOR THIS SHA — nothing was measured for ${r.sha ?? "(no sha given)"}, so this report describes an absence of evidence, not a clean release.`
    );
  }

  // suites that exist historically but went silent for this sha
  if (r.suitesMissingForSha.length > 0) {
    out.push(
      `SUITES SILENT FOR THIS SHA — ${r.suitesMissingForSha.join(", ")} have run for this target before but produced no finished run for ${r.sha ?? "this sha"}. ` +
        "Their last known score is NOT carried forward here."
    );
  }

  // cost provenance
  if (r.cost.unknownCostModels.length > 0) {
    out.push(
      `COST INCOMPLETE — ${r.cost.unknownCostModels.length} model(s) have no known price (${r.cost.unknownCostModels.join(", ")}). ` +
        "Their spend is unknown, not zero, so the total below is a FLOOR."
    );
  } else if (r.cost.runs === 0) {
    out.push("COST UNMEASURED — no metered model run exists in this window, so the LLM spend behind this release is unknown, not zero.");
  }

  // shadow
  if (r.shadow === null) {
    out.push(
      "NO SHADOW REPLAY — no candidate build was replayed for this target, so nothing here compares this release's outputs against the previous build's."
    );
  } else {
    out.push(
      `SHADOW REPLAY IS GOLDEN CASES ONLY — ${r.shadow.compared} pair(s) compared for candidate ${r.shadow.candidateSha}. ` +
        "No real user request was replayed, and no traffic was mirrored: the definition of shadow here is a replay of golden cases on a second port."
    );
  }

  // canary
  if (r.canary.events === 0) {
    out.push(
      "NO CANARY TRANSITION RECORDED — the absence of a rollback below is an absence of DATA, not a record of stability. The hub never observed the traffic itself."
    );
  }

  // latency
  const thinLatency = r.suites.filter((s) => s.latencySamples > 0 && s.latencySamples < 20).map((s) => s.suite);
  if (thinLatency.length > 0) {
    out.push(
      `THIN LATENCY SAMPLES — ${thinLatency.join(", ")} report percentiles over fewer than 20 cases. A p99 computed from a handful of numbers is arithmetic, not statistics.`
    );
  }

  out.push(
    "THIS REPORT DESCRIBES GOLDEN SUITES, NOT PRODUCTION — every number above comes from curated cases the hub was told to run. It says nothing about traffic no suite represents."
  );
  return out;
}

/** Assemble the report body. PURE. */
export function buildReport(input: ReportInput): Report {
  const gateSuites: GateSuite[] = input.suites.map((s) => ({
    suite: s.suite, runId: s.runId, score: s.score, baseline: s.baseline, regression: s.regression,
  }));
  const verdict = gateVerdict(gateSuites);
  const cases = input.suites.reduce((a, s) => a + (s.total ?? 0), 0);
  const passed = input.suites.reduce((a, s) => a + (s.passed ?? 0), 0);
  const withBaseline = input.suites.filter((s) => s.baseline !== null).length;
  const regressions = input.suites
    .filter((s) => s.regression)
    .map((s) => ({ suite: s.suite, score: s.score, baseline: s.baseline, delta: s.delta, failures: s.failures, failuresTotal: s.failuresTotal }));

  // THE HEADLINE. Never a bare verdict word: it names the sample and the moment.
  const measuredAt = input.suites.map((s) => s.measuredAt).filter((x): x is string => !!x).sort().slice(-1)[0] ?? null;
  const headline =
    verdict === "no_runs"
      ? `No finished eval run exists for ${input.target} at ${input.sha ?? "(no sha given)"} — nothing was measured, so nothing is claimed.`
      : verdict === "fail"
        ? `${regressions.length} of ${input.suites.length} suite(s) regressed against a promoted baseline for ${input.target} at ${input.sha}: ` +
          `${passed} of ${cases} case(s) passed, measured ${measuredAt ?? "at an unknown time"} (tolerance ${round2(input.regressionPct)} pts).`
        : `${passed} of ${cases} case(s) passed across ${input.suites.length} suite(s) for ${input.target} at ${input.sha}, ` +
          `${withBaseline} of them against a promoted baseline, measured ${measuredAt ?? "at an unknown time"} — no suite fell more than ${round2(input.regressionPct)} pts below its baseline.`;

  const core = {
    ...input,
    ok: true as const,
    verdict,
    headline,
    totals: { suites: input.suites.length, cases, passed, withBaseline, regressions: regressions.length },
    regressions,
  };

  return {
    ...core,
    notCovered: buildNotCovered(core),
    definitions: {
      shadow: SHADOW_DEFINITION,
      canary: CANARY_DEFINITION,
      percentiles: "nearest-rank over the per-case latencies of the LATEST finished run of each suite; no interpolation, so every value is a latency a real case actually took",
      regression: `a suite regressed when its score fell strictly more than ${round2(input.regressionPct)} points below its promoted baseline; a suite with no baseline cannot regress`,
    },
  };
}

// ── markdown ──────────────────────────────────────────────────────────────────────────────────

function md2(v: number | null | undefined, suffix = ""): string {
  return v === null || v === undefined ? "—" : `${round2(v)}${suffix}`;
}
function mdMs(v: number | null): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}ms`;
}
function mdDelta(v: number | null): string {
  if (v === null || v === undefined) return "—";
  const r = round2(v);
  return `${r > 0 ? "+" : ""}${r}`;
}

/**
 * Paste-ready markdown for a vault change log (addendum §17 + the vault's own conventions: exact
 * numbers, no hype, honest about what is pending).
 */
export function renderReportMarkdown(r: Report): string {
  const L: string[] = [];
  L.push(`## Eval report — ${r.target} @ ${r.sha ?? "(no sha)"}`);
  L.push("");
  L.push(`_Generated ${r.generatedAt} by Eval Hub from its own recorded runs. Window: last ${r.windowDays} day(s)._`);
  L.push("");
  L.push(`**Gate verdict: \`${r.verdict}\`** — ${r.headline}`);
  L.push("");

  L.push("### Suites");
  if (r.suites.length === 0) {
    L.push(`_No finished run for ${r.sha ?? "this sha"}. Nothing was measured._`);
  } else {
    L.push("| Suite | Score | Cases passed | Baseline | Delta | State | Measured at |");
    L.push("|---|---:|---:|---:|---:|---|---|");
    for (const s of r.suites) {
      const state = s.regression ? "regressed" : s.baseline === null ? "no baseline — cannot regress" : "at or above baseline";
      L.push(
        `| \`${s.suite}\` | ${md2(s.score)} | ${s.passed ?? "—"} / ${s.total ?? "—"} | ${md2(s.baseline)} | ${mdDelta(s.delta)} | ${state} | ${s.measuredAt ?? "unknown"} |`
      );
    }
  }
  L.push("");

  L.push("### Regressions caught");
  if (r.regressions.length === 0) {
    L.push(
      `_None. ${r.totals.withBaseline} of ${r.totals.suites} suite(s) had a promoted baseline to be measured against; ${r.totals.suites - r.totals.withBaseline} had none and therefore could not regress._`
    );
  } else {
    for (const g of r.regressions) {
      L.push(
        `- \`${g.suite}\` scored ${md2(g.score)} against baseline ${md2(g.baseline)} (${mdDelta(g.delta)} pts). ` +
          `${g.failuresTotal} failing case(s)${g.failures.length ? `, first ${g.failures.length}: ${g.failures.map((f) => `\`${f}\``).join(", ")}` : ""}.`
      );
    }
  }
  L.push("");

  L.push("### Latency");
  L.push(`_${r.definitions.percentiles}._`);
  L.push("");
  L.push("| Suite | p50 | p95 | p99 | Samples |");
  L.push("|---|---:|---:|---:|---:|");
  if (r.suites.length === 0) {
    L.push("| — | — | — | — | 0 |");
  } else {
    for (const s of r.suites) {
      L.push(`| \`${s.suite}\` | ${mdMs(s.p50Ms)} | ${mdMs(s.p95Ms)} | ${mdMs(s.p99Ms)} | ${s.latencySamples} |`);
    }
  }
  L.push("");

  L.push("### Judge calibration");
  L.push(
    r.calibration.status === "calibrated" && r.calibration.kappa !== null
      ? `Kappa ${r.calibration.kappa} (${r.calibration.band ?? "band unknown"}) over ${r.calibration.n} human-labelled case(s) against model \`${r.calibration.judgeModel}\`, measured ${r.calibration.at ?? "at an unknown time"}. ${r.calibration.labels} label(s) recorded in total.`
      : `**Uncalibrated.** No kappa exists for this target; ${r.calibration.labels} human label(s) recorded. Every judge score behind these numbers is advisory and gates nothing.`
  );
  L.push("");

  L.push("### Safety probes");
  L.push(
    r.safety.probes === 0
      ? "No safety probe suite has reported for this target. Nothing here measures safety."
      : `${r.safety.probes} probe(s) in suite \`${r.safety.suite}\`${r.safety.score === null ? "" : `, scoring ${md2(r.safety.score)}`}, measured ${r.safety.measuredAt ?? "at an unknown time"}. A probe set never certifies safety.`
  );
  L.push("");

  L.push(`### Alerts ${r.alerts.sinceLabel}`);
  if (r.alerts.items.length === 0) {
    L.push(`_None recorded ${r.alerts.sinceLabel}. ${r.alerts.open} alert(s) are currently unacknowledged for this target._`);
  } else {
    for (const a of r.alerts.items) {
      L.push(`- \`${a.kind}\` on \`${a.suite}\` — ${a.message} (${a.createdAt}, ${a.ack ? "acknowledged" : "OPEN"})`);
    }
    if (r.alerts.total > r.alerts.items.length) {
      L.push(`- _…${r.alerts.total - r.alerts.items.length} more not listed (the list is capped, and the cap is stated)._`);
    }
  }
  L.push("");

  L.push("### Cost");
  L.push(
    r.cost.runs === 0
      ? `No metered model run recorded ${r.cost.since ? `since ${r.cost.since}` : "in this window"}. LLM spend for this release is **unknown, not zero**.`
      : `$${(r.cost.totalUsd ?? 0).toFixed(4)} metered over ${r.cost.runs} model run(s) across ${r.cost.models} model(s)${r.cost.since ? `, since ${r.cost.since}` : ""}.` +
        (r.cost.unknownCostModels.length
          ? ` **This is a floor:** ${r.cost.unknownCostModels.length} model(s) have no known price (${r.cost.unknownCostModels.join(", ")}) and contribute an unknown amount.`
          : "")
  );
  L.push("");

  L.push("### Shadow replay");
  L.push(`_${r.definitions.shadow}_`);
  L.push("");
  if (r.shadow === null) {
    L.push("No shadow replay has been recorded for this target.");
  } else {
    L.push(
      `Candidate \`${r.shadow.candidateSha}\` vs baseline \`${r.shadow.baselineSha ?? "unstated"}\`: **${r.shadow.recommendation}** — ${r.shadow.reason}. ` +
        `${r.shadow.diffs} diff(s) over ${r.shadow.compared} compared pair(s) (diffRate ${r.shadow.diffRate ?? "—"}), meanDelta ${r.shadow.meanDelta ?? "not evaluated"}, ` +
        `spend ${r.shadow.spendUsd === null ? "unknown" : `$${r.shadow.spendUsd}`}, finished ${r.shadow.finishedAt ?? "not finished"}.`
    );
    L.push("");
    L.push(`Thresholds applied: \`${JSON.stringify(r.shadow.thresholds)}\`.`);
  }
  L.push("");

  L.push("### Canary");
  L.push(`_${r.definitions.canary}_`);
  L.push("");
  L.push(
    `${r.canary.events} transition(s) recorded: ${r.canary.starts} start, ${r.canary.promotes} promote, ${r.canary.rollbacks} rollback.` +
      (r.canary.last
        ? ` Last: \`${r.canary.last.phase}\` on \`${r.canary.last.sha}\` at ${r.canary.last.createdAt}${r.canary.last.pct === null ? "" : ` (${r.canary.last.pct}% cohort)`}${r.canary.last.reason ? ` — ${r.canary.last.reason}` : ""}.`
        : "") +
      ` ${r.canary.note}`
  );
  L.push("");

  L.push("### What this does not cover");
  for (const n of r.notCovered) L.push(`- ${n}`);
  L.push("");
  L.push(
    `_Regression rule: ${r.definitions.regression}. Every number above was read from the Eval Hub database at ${r.generatedAt}; none was typed by hand._`
  );
  L.push("");
  return L.join("\n");
}
