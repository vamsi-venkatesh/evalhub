// Sending the sign-in code.
//
// WHY THIS LIVES IN THE HUB AND NOT THE WORKER (2026-08-05): the estate sends mail through Zoho
// SMTP, and a Cloudflare Worker cannot speak raw SMTP. So the Worker owns the AUTH decision and the
// hub owns the TRANSPORT, reusing the path Conxto has been sending on for months rather than
// introducing a second mail provider for one login screen.
//
// THE SHAPE THAT MATTERS: a caller may NAME which recipient to use, but only from the fixed
// EVALS_LOGIN_EMAIL allowlist — anything else falls back to the first allowed address and can never
// be delivered elsewhere. The wording is composed here from a code validated as six digits, so
// nothing can be smuggled into the message either. The worst a leaked gateway secret can do is send
// the founder a number he did not ask for. An "email this text to that address" primitive behind
// one shared secret would have been an open relay with extra steps.


let transporter: unknown = null;


export type SendCodeResult =
  /** `via` names the channel that actually carried it — "sent" without a channel is not actionable. */
  | { ok: true; via: "email" }
  | { ok: false; error: "not_configured" | "bad_code" | "send_failed"; detail?: string };


/** PURE. Exported so the six-digit rule is testable without a network. */
export function isSixDigitCode(code: unknown): code is string {
  return typeof code === "string" && /^[0-9]{6}$/.test(code);
}

/**
 * The FIXED set of products this route will label a code for. A caller names a KEY, never a string
 * that reaches the message (2026-08-06): designlab.vvdexops.com signs in through the same transport
 * and a code headed "Eval Hub" would read as the wrong service. The law is unchanged — no recipient,
 * no subject and no body from the caller — because an unknown key falls back to "evals" and the
 * wording is still composed here.
 */
const PRODUCT_LABELS = { evals: "Eval Hub", designlab: "Design Lab" } as const;
export type ProductKey = keyof typeof PRODUCT_LABELS;

/** PURE. Resolves any caller-supplied value to one of the fixed keys; never returns anything else. */
export function resolveProduct(requested: unknown): ProductKey {
  const want = String(requested ?? "").trim().toLowerCase();
  return (Object.prototype.hasOwnProperty.call(PRODUCT_LABELS, want) ? want : "evals") as ProductKey;
}

/** PURE. The exact text that gets sent — no HTML, no link, nothing to click. */
export function codeMessage(
  code: string,
  minutes: number,
  product: ProductKey = "evals",
  at: Date = new Date(),
): { subject: string; text: string } {
  const label = PRODUCT_LABELS[product];
  // THE SUBJECT CARRIES A TIME (2026-08-07). Only the NEWEST request's code is valid — asking for
  // another silently cancels the previous one. Every email looked identical, so with two in the
  // inbox there was no way to tell which was live, and typing the older one reads as "that code is
  // not right", which sounds like a broken system rather than a stale message. The founder hit
  // exactly that, twice, and burned guesses against a code that had already been replaced.
  // A credential that expires ON REPLACEMENT must say when it was issued, or the user is guessing.
  const hhmm = at.toISOString().slice(11, 16);
  return {
    subject: `${code} — ${label} sign-in code (${hhmm} UTC)`,
    text: [
      `Your ${label} sign-in code is ${code}`,
      "",
      `Requested at ${hhmm} UTC. Expires in ${minutes} minutes and works once.`,
      "",
      "IF YOU HAVE MORE THAN ONE OF THESE EMAILS, USE THE NEWEST ONE.",
      "Requesting a new code cancels the previous one, so an older code will be refused.",
      "",
      "If you did not ask to sign in, ignore this — someone typed your address into the",
      "sign-in form and nothing has happened. There is no link in this email to click.",
    ].join("\n"),
  };
}

/** The addresses this service is willing to mail, from EVALS_LOGIN_EMAIL (comma/space separated). */
export function allowedRecipients(raw = process.env.EVALS_LOGIN_EMAIL || ""): string[] {
  return String(raw).split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * PURE. Resolve the recipient: a requested address is honoured ONLY if it is on the allowlist;
 * anything else falls back to the first allowed address. Never returns something unlisted.
 *
 * WHY A REQUESTED ADDRESS IS PERMITTED AT ALL (2026-08-05): the founder has two addresses and I had
 * hard-wired the wrong one, so his code went nowhere and the neutral sign-in page made the failure
 * silent. Letting the caller NAME which allowed address to use fixes that without giving anything
 * away: the set is still fixed here, in the environment, and an unlisted address can never be
 * chosen. The guarantee is unchanged — the worst a leaked token can do is mail the founder.
 */
export function resolveRecipient(requested: unknown, allowed = allowedRecipients()): string {
  const want = String(requested ?? "").trim().toLowerCase();
  if (want && allowed.includes(want)) return want;
  return allowed[0] ?? "";
}

/**
 * EMAIL. That is the instruction, and it is not negotiable by me.
 *
 * I briefly made this send over Telegram because email delivery was slow, and the founder was
 * right to call it a shortcut: he asked for an email login, and routing around a hard problem is
 * not the same as solving it. The delay is real and is being fixed where it actually lives — in
 * how this mail is sent and who it is sent as — not by changing the channel he asked for.
 *
 * LAW: when a requirement is inconvenient, fix the inconvenience. Substituting an easier mechanism
 * and reporting success is answering a question nobody asked.
 */
export async function sendLoginCode(code: string, requestedTo?: unknown, requestedProduct?: unknown): Promise<SendCodeResult> {
  if (!isSixDigitCode(code)) return { ok: false, error: "bad_code" };

  const to = resolveRecipient(requestedTo);
  const product = resolveProduct(requestedProduct);
  const host = (process.env.SMTP_HOST || "").trim();
  const user = (process.env.SMTP_USER || "").trim();
  const pass = process.env.SMTP_PASS || "";
  const from = (process.env.SMTP_FROM || user).trim();
  const port = Number(process.env.SMTP_PORT || 465);
  const minutes = Math.max(1, Math.round(Number(process.env.EVALS_CODE_TTL_SECONDS || 1800) / 60));

  // Loud, specific refusal. A login that silently no-ops because an env var is missing is the
  // worst possible failure here: the founder would sit waiting for a mail that was never attempted.
  const missing = [!to && "EVALS_LOGIN_EMAIL", !host && "SMTP_HOST", !user && "SMTP_USER", !pass && "SMTP_PASS"]
    .filter(Boolean).join(", ");
  if (missing) return { ok: false, error: "not_configured", detail: `missing: ${missing}` };

  try {
    if (!transporter) {
      const nm = (await import("nodemailer")) as unknown as { default?: unknown } & Record<string, unknown>;
      const lib = (nm.default ?? nm) as { createTransport: (o: unknown) => unknown };
      transporter = lib.createTransport({
        host,
        port,
        secure: port === 465, // 465 = implicit SSL, 587 = STARTTLS
        auth: { user, pass },
      });
    }
    const { subject, text } = codeMessage(code, minutes, product);
    const t0 = Date.now();
    // Keep the SMTP server's OWN reply. When a code arrives late, this is what says whether the
    // relay accepted it instantly (delay is downstream, at the receiving side) or sat on it.
    // Without it the only available answer is "it was sent", which explains nothing.
    const info = (await (transporter as { sendMail: (o: unknown) => Promise<unknown> }).sendMail({
      from: `${PRODUCT_LABELS[product]} <${from}>`,
      to,
      subject,
      text,
      headers: { "X-Priority": "1", Importance: "high" },
    })) as { messageId?: string; response?: string; accepted?: unknown[]; rejected?: unknown[] };
    console.log(
      `[auth] smtp accepted in ${Date.now() - t0}ms · to=${to} · id=${info?.messageId ?? "?"} · ` +
      `reply=${String(info?.response ?? "").slice(0, 120)} · accepted=${(info?.accepted ?? []).length} ` +
      `rejected=${(info?.rejected ?? []).length}`,
    );
    return { ok: true, via: "email" };
  } catch (e) {
    return { ok: false, error: "send_failed", detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
