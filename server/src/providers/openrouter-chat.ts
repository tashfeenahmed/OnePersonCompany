/**
 * OPENROUTER AS A MODEL PROVIDER — the mirror image of the OpenAI split, and
 * the same conclusion reached from the opposite direction.
 *
 * providers/openrouter.ts holds the COST connector, and its own header explains
 * why it insists on a MANAGEMENT key: an ordinary inference key is refused by
 * `/activity` and `/keys` with a 403, so it would connect, show a balance, and
 * never show what the balance went on. That is exactly right for reading the
 * bill. Probed on 2026-09-05, it is exactly wrong for asking a question —
 * OpenRouter's own words, verbatim, with the key scrubbed:
 *
 *     POST https://openrouter.ai/api/v1/chat/completions
 *     401  {"error":{"message":"User not found.","code":401}}
 *
 * A management key manages keys; it is not one. And the reverse is the sentence
 * openrouter.ts already wrote: an inference key cannot read the activity. So
 * the two surfaces need two credentials — the same shape OpenAI turned out to
 * have, arrived at from the other side.
 *
 * ONE PROBE HERE IS WORTH REPEATING BECAUSE IT LOOKS LIKE EVIDENCE AND IS NOT.
 * `GET /api/v1/models` answers 200 to the management key — and it answers 200
 * to NO key at all, which was checked. OpenRouter's catalog is public. A verify
 * built on it would pass every string ever typed into the box.
 *
 * SO `chat-key` IS VERIFIED AGAINST `/api/v1/key`, which is the one endpoint
 * that answers about the credential itself and says `is_management_key` in its
 * own words. A management key pasted into the inference field is refused there
 * with the reason, rather than being stored and failing "User not found." on
 * every message.
 *
 * The field is OPTIONAL, as OpenAI's is: the cost integration worked before
 * this existed and goes on working without it.
 */
import * as accounts from "../accounts.ts";
import * as vault from "../vault.ts";
import { configValue } from "../db.ts";
import { PROBE_TIMEOUT_MS, WireError, getJson } from "../chat/wire.ts";
import { registerProvider, type ModelProvider } from "../models/provider.ts";
import { readPolicy } from "../models/policy.ts";

export const OPENROUTER_CHAT_BASE = "https://openrouter.ai/api/v1";

/** The vault field this reads. `key` — the management key — belongs to the
 *  cost collector and is deliberately not named here. */
export const CHAT_FIELD = "chat-key";

const SERVICE = "OpenRouter";

/**
 * The two headers OpenRouter asks callers to send, and the reason they are
 * sent from a dashboard that is not a website.
 *
 * They are attribution, not auth: OpenRouter shows them on the activity page
 * and in its rankings. The owner is going to look at their own OpenRouter
 * account one day and want to know what spent the credits, and "onepersoncompany"
 * beside a request is a better answer than a blank. The same pair is already
 * sent by the cost collector, for the same reason, and both are this box's own
 * loopback address rather than a public URL — because that is the truth about
 * where the request came from.
 */
export const ATTRIBUTION = {
  "HTTP-Referer": "http://127.0.0.1:8787/",
  "X-Title": "onepersoncompany",
} as const;

export const WRONG_KEY_HINT =
  "OpenRouter refused that key for inference. A MANAGEMENT key manages keys — " +
  "it answers /activity and /keys for the costs page and is refused at " +
  "/chat/completions with “User not found.” This field wants an ordinary " +
  "INFERENCE key (sk-or-v1-…) from openrouter.ai → Keys; the management key " +
  "stays where it is, reading the bill.";

/* ----------------------------------------------------------------- verify */

/**
 * Is this a key that can spend credits?
 *
 * `/key` rather than a completion, because a completion costs money and needs
 * a model id nobody has chosen yet — and rather than `/models`, which is
 * public and would accept anything. This asks OpenRouter what the credential
 * IS and refuses the two answers that cannot complete: a management key, and
 * a key with no credit and a limit already spent.
 */
export async function verifyChatKey(
  key: string,
): Promise<
  { ok: true; label: string | null; limitRemaining: number | null } | { ok: false; error: string }
> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "Paste an inference key (sk-or-v1-…)." };
  if (trimmed.includes("\n"))
    return { ok: false, error: "That is more than one line. One key here." };

  try {
    const doc = await getJson<{
      data?: {
        label?: string;
        is_management_key?: boolean;
        limit_remaining?: number | null;
      };
    }>(
      `${OPENROUTER_CHAT_BASE}/key`,
      { Authorization: `Bearer ${trimmed}`, ...ATTRIBUTION },
      SERVICE,
      PROBE_TIMEOUT_MS,
    );
    if (doc.data?.is_management_key === true)
      return { ok: false, error: WRONG_KEY_HINT };
    /*
      A key whose own limit has run out is refused HERE. It is a valid
      credential that answers /key perfectly and 402s every completion — the
      "connects happily and then shows nothing" failure this codebase keeps
      catching at the door. Null is no limit at all, which is the ordinary
      case and is fine; zero is a limit with nothing left on it.
    */
    const left = doc.data?.limit_remaining ?? null;
    if (left !== null && left <= 0)
      return {
        ok: false,
        error:
          "That key is real and has nothing left on it — its spend limit is " +
          "exhausted, so every completion would come back 402. Raise the limit " +
          "on the key, or mint another.",
      };
    return { ok: true, label: doc.data?.label ?? null, limitRemaining: left };
  } catch (err) {
    if (err instanceof WireError) {
      if (err.status === 401 || err.status === 403)
        return { ok: false, error: `${WRONG_KEY_HINT} (OpenRouter said: ${err.message})` };
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Could not reach OpenRouter." };
  }
}

/* --------------------------------------------------------------- provider */

function answering(): accounts.Account | null {
  for (const account of accounts.list("openrouter")) {
    if (!account.connected) continue;
    if (accounts.entries(account.id).some((e) => e.field === CHAT_FIELD)) return account;
  }
  return null;
}

/**
 * One endpoint, from the first account holding an inference key — the same
 * argument openai-chat.ts makes: two OpenRouter accounts are two balances at
 * one URL, and spreading calls across them is the limiter choosing whose
 * credits to spend.
 *
 * `defaultModel` null is a genuinely good answer here and not merely a legal
 * one: OpenRouter's `/models` is a thousand ids, and its own `openrouter/auto`
 * routes on the prompt. Naming one in Settings is how the owner pins a price;
 * leaving it empty takes whatever the catalog lists first, which is a real id
 * from a real list rather than a guess made in this file.
 */
registerProvider("openrouter", (): ModelProvider | null => {
  const account = answering();
  if (!account) return null;
  const key = (vault.readSet(account.id, "models_openrouter")[CHAT_FIELD] ?? "").trim();
  if (!key) return null;

  const configured = (configValue("openrouter", "model") ?? "").trim();
  return {
    id: "openrouter",
    label: `OpenRouter · ${account.label}`,
    endpoints: [{ baseUrl: OPENROUTER_CHAT_BASE, key, label: account.label }],
    defaultModel: configured || null,
    policy: readPolicy("openrouter"),
  };
});

export function noteFailure(error: string) {
  const account = answering();
  if (account) accounts.markFailed(account.id, error.slice(0, 220));
}

export function noteOk() {
  const account = answering();
  if (account) accounts.markOk(account.id);
}
