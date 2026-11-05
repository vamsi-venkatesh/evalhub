// Eval Hub — LLM judge (Phase 2 addendum §2) over an OpenAI-compatible /chat/completions endpoint.
//
// THE LAW OF THIS FILE: a judge that could not be reached, or answered something we could not
// parse, produces an ERROR — never a score. A fabricated 72 is worse than a 502, because a 502 is
// visible and a 72 becomes a baseline. Every failure path here throws JudgeProviderError, and the
// route turns that into 502. There is no default score, no "assume pass", no retry-until-parse.
//
// `fetch` is INJECTED (default: global fetch) so the whole module is testable without network.
import type { Sql } from "../db.js";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const DEFAULT_JUDGE_URL = "https://api.deepseek.com/chat/completions";
export const DEFAULT_JUDGE_MODEL = "deepseek-chat";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";
export const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export const DEFAULT_OPENAI_MODEL = "gpt-6-luna";
export const JUDGE_TIMEOUT_MS = 60_000;
export const MAX_REASONING_CHARS = 600;
const ANTHROPIC_MAX_TOKENS = 4096;

export type JudgeProvider = "anthropic" | "openai" | "deepseek";

export type JudgeConfig = {
  url: string;
  key: string;
  model: string;
  /** Wire shape. "anthropic" = Messages API; anything else (or unset) = OpenAI-compatible /chat/completions. Inferred from the URL when unset. */
  provider?: JudgeProvider;
  /** Tried IN ORDER when this judge cannot be reached / is refused / has no credit (transport, http, config). Never on a parse failure. */
  fallbacks?: JudgeConfig[];
  fetchImpl?: FetchFn;
  timeoutMs?: number;
};

const isAnthropic = (cfg: JudgeConfig): boolean => cfg.provider === "anthropic" || (!cfg.provider && /anthropic\.com\/v1\/messages/.test(cfg.url));

/**
 * Env → config. The rotation (EVALHUB_JUDGE_ROTATION, default "anthropic,openai,deepseek") lists providers in the order they are
 * tried; a provider with no key is skipped. Keys: EVALHUB_ANTHROPIC_KEY, EVALHUB_OPENAI_KEY, EVALHUB_DEEPSEEK_KEY (the deploy writes
 * them into /opt/evalhub/.env). Models: EVALHUB_ANTHROPIC_MODEL (claude-haiku-5-5), EVALHUB_OPENAI_MODEL (gpt-6-luna),
 * EVALHUB_DEEPSEEK_MODEL. The legacy EVALHUB_JUDGE_URL / EVALHUB_JUDGE_MODEL still work and now configure the DeepSeek entry only,
 * so an old server env keeps its meaning as the last fallback. With no key at all the primary is Anthropic with an empty key, which
 * fails loudly as judge_key_missing (never a score).
 */
export function judgeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JudgeConfig {
  const all: Record<JudgeProvider, JudgeConfig> = {
    anthropic: { provider: "anthropic", url: env.EVALHUB_ANTHROPIC_URL || ANTHROPIC_MESSAGES_URL, key: env.EVALHUB_ANTHROPIC_KEY || "", model: env.EVALHUB_ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL },
    openai: { provider: "openai", url: env.EVALHUB_OPENAI_URL || DEFAULT_OPENAI_URL, key: env.EVALHUB_OPENAI_KEY || "", model: env.EVALHUB_OPENAI_MODEL || DEFAULT_OPENAI_MODEL },
    deepseek: { provider: "deepseek", url: env.EVALHUB_JUDGE_URL || DEFAULT_JUDGE_URL, key: env.EVALHUB_DEEPSEEK_KEY || "", model: env.EVALHUB_DEEPSEEK_MODEL || env.EVALHUB_JUDGE_MODEL || DEFAULT_JUDGE_MODEL },
  };
  const order = (env.EVALHUB_JUDGE_ROTATION || "anthropic,openai,deepseek").split(",").map((x) => x.trim().toLowerCase()).filter((x): x is JudgeProvider => x in all);
  const live = order.map((p) => all[p]).filter((c) => c.key);
  if (!live.length) return { ...all[order[0] ?? "anthropic"] };
  const [primary, ...rest] = live;
  return { ...primary!, ...(rest.length ? { fallbacks: rest } : {}) };
}

export type JudgeFailureStage = "config" | "transport" | "http" | "parse";

/** The ONLY way this module reports trouble. The route maps it to 502 (or 500 for 'config'). */
export class JudgeProviderError extends Error {
  readonly stage: JudgeFailureStage;
  readonly status: number | null;
  readonly detail: string;
  constructor(stage: JudgeFailureStage, message: string, status: number | null = null, detail = "") {
    super(message);
    this.name = "JudgeProviderError";
    this.stage = stage;
    this.status = status;
    this.detail = detail.slice(0, 500);
  }
}

export function isJudgeProviderError(e: unknown): e is JudgeProviderError {
  return e instanceof JudgeProviderError || (e as { name?: string })?.name === "JudgeProviderError";
}

type ChatMessage = { role: "system" | "user"; content: string };

const KEY_ENV: Record<string, string> = { anthropic: "EVALHUB_ANTHROPIC_KEY", openai: "EVALHUB_OPENAI_KEY", deepseek: "EVALHUB_DEEPSEEK_KEY" };

/** One raw chat call to ONE provider. Returns the assistant's text, or throws JudgeProviderError. */
async function chatOnce(cfg: JudgeConfig, messages: ChatMessage[]): Promise<string> {
  const anthropic = isAnthropic(cfg);
  if (!cfg.key) throw new JudgeProviderError("config", "judge_key_missing", null, `${KEY_ENV[cfg.provider ?? (anthropic ? "anthropic" : "deepseek")] ?? "the judge key"} is empty`);
  const doFetch = cfg.fetchImpl ?? (globalThis.fetch as FetchFn);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? JUDGE_TIMEOUT_MS);
  let res: Response;
  try {
    if (anthropic) {
      // Anthropic Messages API. `system` is a top-level field; NO temperature (current Claude models reject sampling params with a 400);
      // thinking is left at the model's default and only the TEXT blocks are read below.
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      res = await doFetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": cfg.key, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({ model: cfg.model, max_tokens: ANTHROPIC_MAX_TOKENS, ...(system ? { system } : {}), messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })) }),
        signal: ctl.signal,
      });
    } else {
      res = await doFetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
        // temperature 0 — the judge must be as deterministic as the provider allows. A judge that
        // scores the same pair 61 then 78 cannot support a baseline.
        body: JSON.stringify({ model: cfg.model, temperature: 0, messages, stream: false }),
        signal: ctl.signal,
      });
    }
  } catch (e) {
    throw new JudgeProviderError("transport", "judge_unreachable", null, String((e as Error)?.message ?? e));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 500); } catch { /* body is a bonus, the status is the fact */ }
    throw new JudgeProviderError("http", "judge_http_error", res.status, body);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new JudgeProviderError("parse", "judge_response_not_json", res.status, String((e as Error)?.message ?? e));
  }
  let content: unknown;
  if (anthropic) {
    const blocks = (json as { content?: { type?: string; text?: unknown }[] })?.content;
    content = Array.isArray(blocks) ? blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n") : undefined;
  } else {
    content = (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  }
  if (typeof content !== "string" || content.trim() === "") {
    throw new JudgeProviderError("parse", "judge_empty_content", res.status, JSON.stringify(json).slice(0, 300));
  }
  return content;
}

/** The judge chain: primary, then each fallback, moving on only when the provider itself failed (config / transport / http). Reports which model answered. */
async function chatRotating(cfg: JudgeConfig, messages: ChatMessage[]): Promise<{ content: string; model: string }> {
  const chain = [cfg, ...(cfg.fallbacks ?? [])];
  let first: unknown;
  for (const c of chain) {
    try {
      // fetchImpl / timeout given on the head config apply to the whole chain (tests inject them once)
      const content = await chatOnce({ ...c, fetchImpl: c.fetchImpl ?? cfg.fetchImpl, timeoutMs: c.timeoutMs ?? cfg.timeoutMs }, messages);
      return { content, model: c.model };
    } catch (e) {
      if (isJudgeProviderError(e) && e.stage === "parse") throw e;
      first ??= e;
      console.warn(`[judge] ${c.provider ?? "provider"} ${c.model} failed (${isJudgeProviderError(e) ? `${e.stage} ${e.status ?? ""} ${e.detail.slice(0, 120)}` : String(e)}); ${c === chain[chain.length - 1] ? "no fallback left" : "trying the next provider"}`);
    }
  }
  throw first;
}

/** Strip ```json fences and grab the outermost {...} — models garnish JSON no matter what you ask. */
export function extractJsonObject(raw: string): unknown {
  const s = raw.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? s.slice(start, end + 1) : s;
  return JSON.parse(candidate);
}

/**
 * Chat expecting strict JSON. ONE retry on a PARSE failure only (the model is told, verbatim, that
 * its previous answer was unparseable) — transport/HTTP failures are NOT retried here, because a
 * 401 or a 500 does not become truthful on the second ask.
 */
export async function chatJson<T = unknown>(
  cfg: JudgeConfig,
  messages: ChatMessage[],
  validate: (v: unknown) => T
): Promise<{ value: T; raw: string; retried: boolean; model: string }> {
  const attempt = async (msgs: ChatMessage[]): Promise<{ value: T; raw: string; model: string }> => {
    const { content: raw, model } = await chatRotating(cfg, msgs);
    return { value: validate(extractJsonObject(raw)), raw, model };
  };
  try {
    const first = await attempt(messages);
    return { ...first, retried: false };
  } catch (e) {
    if (isJudgeProviderError(e) && e.stage !== "parse") throw e; // transport/http/config: do not retry
    const why = String((e as Error)?.message ?? e).slice(0, 200);
    const retryMsgs: ChatMessage[] = [
      ...messages,
      { role: "user", content: `Your previous answer could not be parsed (${why}). Reply with ONE raw JSON object and NOTHING else — no prose, no markdown fences.` },
    ];
    try {
      const second = await attempt(retryMsgs);
      return { ...second, retried: true };
    } catch (e2) {
      if (isJudgeProviderError(e2) && e2.stage !== "parse") throw e2;
      throw new JudgeProviderError("parse", "judge_json_unparseable_after_retry", null, String((e2 as Error)?.message ?? e2));
    }
  }
}

// ── the judge scorer ──────────────────────────────────────────────────────────────────────────

export type JudgeVerdict = "pass" | "fail" | "borderline";
export type JudgePayload = { rubric: string; input: string; output: string; context?: string; target?: string };
export type JudgeScore = { score: number; verdict: JudgeVerdict; reasoning: string; model: string; retried: boolean };

const JUDGE_SYSTEM = [
  "You are a strict evaluation judge. You grade one model output against a rubric.",
  "Reply with ONE raw JSON object and nothing else:",
  '{"score": <integer 0-100>, "verdict": "pass"|"fail"|"borderline", "reasoning": "<=600 chars"}',
  "score 0 = the output completely fails the rubric, 100 = it fully satisfies it.",
  "verdict must agree with the score: >=70 pass, 50-69 borderline, <50 fail.",
  "Judge ONLY against the rubric. Do not reward style the rubric did not ask for.",
].join("\n");

function validateJudge(v: unknown): { score: number; verdict: JudgeVerdict; reasoning: string } {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("not an object");
  const score = Number(o.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error(`score out of range: ${String(o.score)}`);
  const verdict = String(o.verdict ?? "").toLowerCase();
  if (verdict !== "pass" && verdict !== "fail" && verdict !== "borderline") throw new Error(`bad verdict: ${String(o.verdict)}`);
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.slice(0, MAX_REASONING_CHARS) : "";
  return { score: Math.round(score * 100) / 100, verdict: verdict as JudgeVerdict, reasoning };
}

export async function runJudge(cfg: JudgeConfig, p: JudgePayload): Promise<JudgeScore> {
  const user = [
    `RUBRIC:\n${p.rubric}`,
    `INPUT:\n${p.input}`,
    p.context ? `CONTEXT:\n${p.context}` : null,
    `OUTPUT TO JUDGE:\n${p.output}`,
  ].filter(Boolean).join("\n\n---\n\n");
  const r = await chatJson(cfg, [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: user }], validateJudge);
  return { ...r.value, model: r.model, retried: r.retried };   // the model that ACTUALLY answered (calibration is keyed by it)
}

// ── claim extraction (used by the hallucination scorer) ───────────────────────────────────────

const CLAIMS_SYSTEM = [
  "You extract atomic factual claims from a text. A claim is ONE verifiable assertion.",
  "Reply with ONE raw JSON object and nothing else:",
  '{"claims": ["<claim 1>", "<claim 2>", ...]}',
  "Copy the wording of the text closely; do not add facts, do not summarise, do not interpret.",
  "Opinions, questions and formatting are not claims. Return at most 40 claims.",
].join("\n");

export const MAX_CLAIMS = 40;

function validateClaims(v: unknown): string[] {
  const o = v as Record<string, unknown>;
  const arr = o?.claims;
  if (!Array.isArray(arr)) throw new Error("claims is not an array");
  return arr
    .filter((c): c is string => typeof c === "string" && c.trim() !== "")
    .map((c) => c.trim())
    .slice(0, MAX_CLAIMS);
}

/** Extract claims via the judge model. Same never-fabricate law: provider trouble throws. */
export type ClaimExtractor = (output: string) => Promise<string[]>;

export function makeJudgeClaimExtractor(cfg: JudgeConfig): ClaimExtractor {
  return async (output: string) => {
    const r = await chatJson(cfg, [{ role: "system", content: CLAIMS_SYSTEM }, { role: "user", content: `TEXT:\n${output}` }], validateClaims);
    return r.value;
  };
}

// ── calibration status (addendum §"the judge is UNCALIBRATED until human labels produce a kappa") ──

export type CalibrationStatus = {
  status: "calibrated" | "uncalibrated";
  kappa?: number;
  n?: number;
  at?: string;
  /** Why it is uncalibrated. Never omitted when status is 'uncalibrated' — silence reads as "fine". */
  reason?: string;
  advisoryOnly: boolean;
};

/**
 * Latest calibration for (target, judgeModel). No target on the call → 'uncalibrated' with the
 * reason spelled out, because an unattributed judge score cannot inherit anyone's kappa.
 * `advisoryOnly` is true whenever the judge is uncalibrated: those scores MUST NOT gate anything.
 */
export async function calibrationFor(sql: Sql, target: string | undefined, judgeModel: string): Promise<CalibrationStatus> {
  if (!target) return { status: "uncalibrated", reason: "no_target_supplied", advisoryOnly: true };
  const rows = await sql<{ kappa: string; n: number; created_at: Date }[]>`
    SELECT kappa, n, created_at FROM calibrations
    WHERE target = ${target} AND judge_model = ${judgeModel}
    ORDER BY created_at DESC LIMIT 1`;
  const r = rows[0];
  if (!r) return { status: "uncalibrated", reason: "no_calibration_for_this_target_and_model", advisoryOnly: true };
  const kappa = Number(r.kappa);
  return {
    status: "calibrated",
    kappa: Number.isFinite(kappa) ? kappa : 0,
    n: Number(r.n),
    at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    advisoryOnly: false,
  };
}
