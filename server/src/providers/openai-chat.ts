/**
 * OpenAI AS A MODEL PROVIDER — which is a different credential from OpenAI as
 * a bill, and that is the whole content of this file.
 *
 * providers/openai.ts holds the COST connector: an org admin key (`sk-admin-…`)
 * reading `/v1/organization/costs`. The obvious thing to do here was to reuse
 * it. It was probed rather than assumed, on 2026-09-05, and it does not work —
 * OpenAI's own words, verbatim, with the key scrubbed:
 *
 *     GET  https://api.openai.com/v1/models
 *     403  "You have insufficient permissions for this operation. Missing
 *           scopes: api.model.read. Check that you have the correct role in
 *           your organization (Reader, Writer, Owner) and project (Viewer,
 *           Member, Owner), and if you're using a restricted API key, that it
 *           has the necessary scopes."
 *
 *     POST https://api.openai.com/v1/chat/completions
 *     401  "You have insufficient permissions for this operation. Missing
 *           scopes: model.request." …  code "missing_scope"
 *
 * So an admin key can read the organization's spend and cannot ask it a
 * question. The two surfaces want two different scopes and this account's key
 * carries one of them. That is not a misconfiguration to work around; it is
 * how OpenAI has drawn the line, and the right answer is a SECOND credential.
 *
 * HENCE `chat-key`: a second, OPTIONAL field on the same plugin, holding a
 * project key (`sk-proj-…`) minted with model access. It is optional because
 * the cost integration was working before this existed and must go on working
 * without it — an owner who wants the bill and not the inference pastes one key
 * and is not nagged for another. The two never mix: the cost collector reads
 * `key` and this file reads `chat-key`, and neither can see the other's.
 *
 * WHY NOT A SEPARATE PLUGIN CALLED "openai-inference". Because it is one
 * account at one company, and two tiles saying OpenAI is a page that makes the
 * owner choose between two right answers. The plugin page says which key does
 * what instead, which is a sentence rather than an architecture.
 *
 * WHAT THIS FILE DOES NOT TOUCH: providers/openai.ts, its collector, its
 * tables and its route. Additive, in the strict sense — nothing above changes
 * behaviour for an installation that never pastes a chat key.
 */
import * as accounts from "../accounts.ts";
import * as vault from "../vault.ts";
import { configValue } from "../db.ts";
import { PROBE_TIMEOUT_MS, WireError, getJson, readModelIds } from "../chat/wire.ts";
import { registerProvider, type ModelProvider } from "../models/provider.ts";
import { readPolicy } from "../models/policy.ts";

/** The inference base. `providers/openai.ts` exports the same string for the
 *  organization surface; it is repeated rather than imported because these are
 *  two integrations that happen to share a host, and a shared constant would
 *  be a single point at which a change made for the bill breaks the chat. */
export const OPENAI_CHAT_BASE = "https://api.openai.com/v1";

/** The vault field this reads. `key` — the admin key — belongs to the cost
 *  collector and is deliberately not named here. */
export const CHAT_FIELD = "chat-key";

const SERVICE = "OpenAI";

/** The sentence an admin key gets when it is pasted into the inference box.
 *  It is the failure this whole file exists because of, so it is named rather
 *  than left as OpenAI's status code. */
export const WRONG_KEY_HINT =
  "OpenAI refused that key for inference. An org admin key (sk-admin-…) reads " +
  "the organization's costs and is refused at /v1/chat/completions with " +
  "“Missing scopes: model.request” — the two surfaces want two different " +
  "scopes. This field wants a PROJECT key (sk-proj-…) from Settings → API " +
  "keys, with model access; the admin key stays where it is, reading the bill.";

/* ----------------------------------------------------------------- verify */

/**
 * Can this key ask OpenAI a question?
 *
 * `GET /v1/models` rather than a real completion, for the reason every other
 * verify here gives: a completion spends money and needs a model name nobody
 * has chosen yet, while the listing proves the key is real, is not the admin
 * key, and has model access — and it is exactly the call
 * `models/provider.ts` makes when no default model is configured, so a key
 * that passes this check is a key the provider can definitely use.
 *
 * The cost of that choice, said plainly: a project key restricted to
 * `model.request` alone, with `api.model.read` withheld, is refused here even
 * though it could complete. That key would also break model discovery, so
 * accepting it would trade a refusal at the door for an unexplained failure on
 * every message — this codebase's least favourite trade.
 */
export async function verifyChatKey(
  key: string,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "Paste a project key (sk-proj-…)." };
  if (trimmed.includes("\n"))
    return { ok: false, error: "That is more than one line. One key here." };

  try {
    const doc = await getJson<unknown>(
      `${OPENAI_CHAT_BASE}/models`,
      { Authorization: `Bearer ${trimmed}` },
      SERVICE,
      PROBE_TIMEOUT_MS,
    );
    const models = readModelIds(doc);
    if (!models.length)
      return {
        ok: false,
        error: "OpenAI answered the model list and it was empty, which should not happen. Try again, or check the key's project.",
      };
    return { ok: true, models };
  } catch (err) {
    if (err instanceof WireError) {
      if (err.status === 401 || err.status === 403)
        return { ok: false, error: `${WRONG_KEY_HINT} (OpenAI said: ${err.message})` };
      return { ok: false, error: err.message };
    }
    return { ok: false, error: "Could not reach OpenAI." };
  }
}

/* --------------------------------------------------------------- provider */

/**
 * The account whose chat key answers, without opening a ciphertext.
 *
 * Entry NAMES and dates are enough to decide "is there an inference key here",
 * which is the question `providers()` asks on every draw of the settings page.
 * The value is opened once, below, by the call that actually sends it.
 */
function answering(): accounts.Account | null {
  for (const account of accounts.list("openai")) {
    if (!account.connected) continue;
    if (accounts.entries(account.id).some((e) => e.field === CHAT_FIELD)) return account;
  }
  return null;
}

/**
 * ONE ENDPOINT, FROM THE FIRST ACCOUNT THAT HAS AN INFERENCE KEY.
 *
 * Two OpenAI accounts here means two organizations, and both of them reach the
 * same models at the same URL — so returning both as endpoints would not be
 * throughput, it would be the limiter silently deciding which organization
 * gets billed for each message. That is a decision with an invoice attached
 * and it belongs to the owner: a second org's inference is a second account
 * whose label says so, chosen by moving it to the top rather than by a
 * round-robin nobody can see.
 */
registerProvider("openai", (): ModelProvider | null => {
  const account = answering();
  if (!account) return null;
  const key = (vault.readSet(account.id, "models_openai")[CHAT_FIELD] ?? "").trim();
  if (!key) return null;

  const configured = (configValue("openai", "model") ?? "").trim();
  return {
    id: "openai",
    label: `OpenAI · ${account.label}`,
    endpoints: [{ baseUrl: OPENAI_CHAT_BASE, key, label: account.label }],
    /* Null is legal and means "ask /models and take the first". On OpenAI that
       list is a hundred ids in no useful order, so naming one in Settings is
       the ordinary thing to do — but a hard-coded "gpt-4o-mini" here would be
       this file inventing a spending decision, and a model id that will be
       retired on a date nobody here knows. */
    defaultModel: configured || null,
    policy: readPolicy("openai"),
  };
});

/** Mark the account from the outcome of a completion, the way every collector
 *  in this project marks its own. Kept here because the route that catches the
 *  failure does not know which account's key was sent. */
export function noteFailure(error: string) {
  const account = answering();
  if (account) accounts.markFailed(account.id, error.slice(0, 220));
}

export function noteOk() {
  const account = answering();
  if (account) accounts.markOk(account.id);
}
