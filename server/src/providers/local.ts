/**
 * LOCAL MODELS — anything on this machine or this network that speaks the
 * OpenAI chat-completions wire.
 *
 * WHAT THIS IS NOT: an Ollama integration. Ollama, LM Studio, vLLM, llama.cpp's
 * server, LocalAI, text-generation-webui and a hand-rolled FastAPI in front of
 * transformers all expose the same two endpoints — `GET /v1/models` and `POST
 * /v1/chat/completions` — and the differences between them are in what they run
 * rather than in how they are asked. A plugin per product would be six plugins
 * holding one adapter, six catalog tiles, and a seventh the day somebody ships
 * a new runner. So there is ONE plugin whose credential is a URL, and the
 * product's name is what the owner types in the label.
 *
 * ONE ACCOUNT PER ENDPOINT, AND ALL OF THEM ANSWER. This is the one provider
 * here whose several accounts are not several places to read the same figure
 * from — they are several machines that can each take a completion, which is
 * the entire reason the Policy type has a `balance` field. A laptop and a GPU
 * box are two endpoints of one provider, spread across by the limiter in
 * models/provider.ts. Contrast the agents in chat/backend.ts, where several
 * accounts exist and exactly ONE answers: asking two agents one question is two
 * answers to reconcile, while asking two endpoints two questions is twice the
 * throughput.
 *
 * THE KEY IS OPTIONAL, WHICH NO OTHER CREDENTIAL HERE IS. Ollama and LM Studio
 * ship with no auth at all and bind to loopback, which IS their access control
 * — the same argument searxng.ts makes about a managed instance ("a key checked
 * by this process against a value this process generated would be a password on
 * a door in a locked room"). vLLM behind `--api-key`, or a box reached over
 * Tailscale, does want one. So the field exists, is a secret, and is empty by
 * default — and `verify` refuses an empty key against a host that is NOT on the
 * owner's own network, because "I left the key box empty" against somebody
 * else's server is a mistake rather than a configuration.
 *
 * AND A KEY NEVER CROSSES A PUBLIC NETWORK IN THE CLEAR. `http://` plus a
 * non-private host plus a key is refused outright. There is no version of that
 * request worth making: the bearer is readable by everything between here and
 * there, and the alternative is one character (`https`).
 */
import * as accounts from "../accounts.ts";
import * as vault from "../vault.ts";
import { configValue } from "../db.ts";
import {
  PROBE_TIMEOUT_MS,
  WireError,
  getJson,
  isPrivateHost,
  parseEndpoint,
  readModelIds,
} from "../chat/wire.ts";
import {
  forgetDiscovered,
  registerProvider,
  type Endpoint,
  type ModelProvider,
} from "../models/provider.ts";
import { readPolicy } from "../models/policy.ts";

const SERVICE = "the local endpoint";

/** The vault fields, named once. routes/plugins.ts repeats them because its
 *  registry is the closed list that may write to the vault; this is the list
 *  read back, and the two have to agree. */
export const FIELDS = ["base-url", "key"] as const;

/** `base-url` is the credential; `key` is the half that may be left empty. The
 *  route's "every field must be filled" rule is relaxed for exactly this one,
 *  and the relaxation is declared rather than assumed. */
export const OPTIONAL_FIELDS = ["key"] as const;

/* -------------------------------------------------------------- the URL */

/**
 * The base URL, with `/v1` on the end whether or not it was pasted.
 *
 * Every one of these runners serves its OpenAI-compatible surface under `/v1`
 * — Ollama on 11434, LM Studio on 1234, vLLM on 8000, llama.cpp on 8080 — and
 * what a person copies is what their terminal printed when the thing started,
 * which is the origin. Appending is therefore the convention rather than a
 * guess, and a path that already ends in a version segment is left alone. The
 * same rule providers/hermes.ts applies, written out again rather than
 * imported: that file is about an agent's proxy and this one is about a model
 * server, and a shared helper would be one place for a change made for one of
 * them to break the other.
 *
 * A server that genuinely answers at its root is the case this gets wrong, and
 * it gets it wrong at the door: `verify` fails with the URL it actually tried.
 */
export function normaliseBase(
  raw: string,
): { ok: true; base: string; url: URL } | { ok: false; error: string } {
  const parsed = parseEndpoint(raw, "local model");
  if (!parsed.ok) return parsed;
  const base = /\/v\d+$/.test(parsed.base) ? parsed.base : `${parsed.base}/v1`;
  return { ok: true, base, url: new URL(base) };
}

/**
 * The two rules about who may be sent a key, and who may be asked without one.
 *
 * Kept apart from `verify` so the same judgement can be quoted in the help
 * text and applied by the factory — a check that only runs at connect time is
 * a check a hand-edited row walks around.
 */
export function credentialProblem(url: URL, key: string): string | null {
  const priv = isPrivateHost(url.hostname);
  if (!key && !priv)
    return (
      `${url.host} is not on your own network, so it needs a key. A public ` +
      `endpoint with no bearer is either open to everybody or about to refuse ` +
      `every completion — and neither is something to find out an hour later. ` +
      `Loopback and LAN addresses are exempt, because binding to 127.0.0.1 IS ` +
      `the access control.`
    );
  if (key && url.protocol === "http:" && !priv)
    return (
      `That would send the key in the clear to ${url.host}. Use https:// — ` +
      `there is no version of this request worth making over plain HTTP to a ` +
      `host outside your own network.`
    );
  return null;
}

/* ----------------------------------------------------------------- verify */

/**
 * A real round trip, and the model list comes back with it.
 *
 * `GET /models` rather than a completion, for the reason hermes.ts gives: a
 * completion loads a model into VRAM and spends a minute doing it, and the
 * listing proves the same three things — the address is a server, it speaks
 * this API, and it accepts this bearer — for nothing.
 *
 * AN EMPTY MODEL LIST IS REFUSED. A runner with nothing pulled answers
 * `/models` perfectly and then fails every completion with "model not found",
 * which is this codebase's least favourite shape of failure: it connects, it
 * looks right, and it is empty. Ollama with no `ollama pull` behind it is
 * exactly that, and it is the likeliest way this integration is first tried.
 */
export async function verify(values: {
  baseUrl: string;
  key: string;
}): Promise<
  { ok: true; base: string; models: string[] } | { ok: false; error: string }
> {
  const normalised = normaliseBase(values.baseUrl);
  if (!normalised.ok) return { ok: false, error: normalised.error };

  const key = values.key.trim();
  const problem = credentialProblem(normalised.url, key);
  if (problem) return { ok: false, error: problem };

  try {
    const doc = await getJson<unknown>(
      `${normalised.base}/models`,
      key ? { Authorization: `Bearer ${key}` } : {},
      SERVICE,
      PROBE_TIMEOUT_MS,
    );
    const models = readModelIds(doc);
    if (!models.length)
      return {
        ok: false,
        error:
          `${normalised.base}/models answered and listed nothing. That is a ` +
          `runner with no model behind it — \`ollama pull qwen3:0.6b\`, or load ` +
          `a model in LM Studio, and try again. Stored as it is, this would ` +
          `connect and then refuse every completion.`,
      };
    return { ok: true, base: normalised.base, models };
  } catch (err) {
    if (err instanceof WireError) {
      if (err.status === 401 || err.status === 403)
        return {
          ok: false,
          error:
            `${normalised.base} refused that bearer. Ollama and LM Studio check ` +
            `no key at all, so a refusal here means this endpoint was started ` +
            `with one — vLLM's --api-key, or a proxy in front of it.`,
        };
      if (err.status === 404)
        return {
          ok: false,
          error:
            `There is no /models at ${normalised.base}. Check the port: Ollama ` +
            `is 11434, LM Studio 1234, vLLM 8000, llama.cpp 8080 — and Ollama's ` +
            `own /api is a different, non-OpenAI surface from the /v1 this uses.`,
        };
      return { ok: false, error: err.message };
    }
    return { ok: false, error: `Could not reach ${normalised.base}.` };
  }
}

/* -------------------------------------------------------------- endpoints */

/**
 * Every connected endpoint, with its bearer.
 *
 * WHY THERE IS A CACHE HERE AND NOWHERE ELSE IN THIS CODEBASE. The base URL is
 * a vault field — one account is one credential set, which is what lets the
 * ordinary accounts routes verify and store it like everything else — and this
 * function runs on every `activeProvider()`, which includes every draw of the
 * settings page. Decrypting three endpoints to render a dropdown would fill
 * `secret_access` with reads that touched nothing, and that table's whole
 * value is that "what opened the credential last night" is a short answer.
 *
 * So the cache is keyed on the ENTRY TIMESTAMPS, which `vault.entries` returns
 * without opening anything. A ciphertext that is rewritten gets a new stamp and
 * is re-read on the next call; a page poll costs one indexed query per account
 * and no decryption. It is not a TTL, because a TTL is a window in which a
 * freshly pasted URL is quietly ignored.
 */
type Cached = { stamp: string; baseUrl: string; key: string | null };
const cache = new Map<number, Cached>();

function endpointFor(account: accounts.Account): Endpoint | null {
  const held = vault.entries(account.id);
  const stamp = held.map((e) => `${e.name}@${e.updatedAt}`).join("|");
  let entry = cache.get(account.id);

  if (!entry || entry.stamp !== stamp) {
    const values = vault.readSet(account.id, "models_local");
    const normalised = normaliseBase(values["base-url"] ?? "");
    if (!normalised.ok) {
      cache.delete(account.id);
      return null;
    }
    const key = (values.key ?? "").trim();
    if (credentialProblem(normalised.url, key)) {
      cache.delete(account.id);
      return null;
    }
    /* The discovered-model memo in provider.ts is keyed by base URL, so a URL
       that has just been repointed must not keep the model id the last server
       at that address happened to list first. */
    if (entry && entry.baseUrl !== normalised.base) forgetDiscovered(entry.baseUrl);
    entry = { stamp, baseUrl: normalised.base, key: key || null };
    cache.set(account.id, entry);
  }

  return { baseUrl: entry.baseUrl, key: entry.key, label: account.label };
}

/** The endpoints, in the order the accounts were added — which is the order
 *  round-robin walks, so "the first one" on the page is the first one asked. */
export function endpoints(): { account: accounts.Account; endpoint: Endpoint }[] {
  const out: { account: accounts.Account; endpoint: Endpoint }[] = [];
  for (const account of accounts.list("local")) {
    if (!account.connected) continue;
    const endpoint = endpointFor(account);
    if (endpoint) out.push({ account, endpoint });
  }
  return out;
}

/** What one endpoint says it serves. Used by `GET /api/models/local/models`,
 *  which is a live read rather than a stored list: a model is pulled and
 *  deleted by a person at a terminal, and a cached catalog would be wrong
 *  within a day. */
export async function models(
  endpoint: Endpoint,
  signal?: AbortSignal,
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const doc = await getJson<unknown>(
      `${endpoint.baseUrl}/models`,
      endpoint.key ? { Authorization: `Bearer ${endpoint.key}` } : {},
      `${SERVICE} (${endpoint.label})`,
      PROBE_TIMEOUT_MS,
      signal,
    );
    return { ok: true, models: readModelIds(doc) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `Could not reach ${endpoint.label}.`,
    };
  }
}

/* --------------------------------------------------------------- provider */

/**
 * Registered at import. routes/models.ts imports this file for this side
 * effect, exactly as routes/chat.ts imports the two agent adapters for theirs,
 * and index.ts is where the ordering is spelled out.
 *
 * `defaultModel` is null when the setting is empty, and that is a real value
 * rather than a missing one: models/provider.ts then asks the endpoint's own
 * `/models` and takes the first id, which is an answer derived from the server
 * instead of assumed about it. A local runner serving exactly one model — the
 * ordinary case — never needs this field filled at all.
 */
registerProvider("local", (): ModelProvider | null => {
  const live = endpoints();
  if (!live.length) return null;
  const configured = (configValue("local", "model") ?? "").trim();
  return {
    id: "local",
    label:
      live.length === 1
        ? `Local · ${live[0]!.account.label}`
        : `Local · ${live.length} endpoints`,
    endpoints: live.map((e) => e.endpoint),
    defaultModel: configured || null,
    policy: readPolicy("local"),
  };
});

/** Record a failed completion against the account that owns an endpoint, so
 *  the plugin page shows a red line on the box that stopped answering rather
 *  than on the plugin as a whole. Matched by label, which is what the reply
 *  carries — the ids never leave this file. */
export function noteFailure(endpointLabel: string, error: string) {
  const hit = accounts.list("local").find((a) => a.label === endpointLabel);
  if (hit) accounts.markFailed(hit.id, error.slice(0, 220));
}

/** The mirror of the above, for a completion that worked. A round trip IS this
 *  plugin's health check — there is nothing else to collect from a model
 *  server — so a page saying "connected" about a box that refused the last four
 *  calls would be telling the owner something untrue. */
export function noteOk(endpointLabel: string) {
  const hit = accounts.list("local").find((a) => a.label === endpointLabel);
  if (hit) accounts.markOk(hit.id);
}
