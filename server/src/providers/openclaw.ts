/**
 * OPENCLAW — the open-source gateway.
 *
 * THE CATALOG SENDS YOU TO THE WRONG ENDPOINT, AND IT MATTERS. Its help text
 * says "POST /tools/invoke calls one named tool without a whole chat turn,
 * which is the shape a chart request wants". That is true about /tools/invoke
 * and it is the wrong door for THIS job, which is a conversation. The docs
 * (docs.openclaw.ai/gateway/tools-invoke-http-api) publish a DEFAULT HARD DENY
 * LIST for that endpoint — applied "even if session policy allows the tool" —
 * and `sessions_send`, the tool that would deliver a message to an agent
 * session, is on it, alongside `sessions_spawn`, `exec`, `spawn`, `shell` and
 * the filesystem writers. There is no way to ask a question through
 * /tools/invoke; the endpoint exists to run one named, allowlisted tool.
 *
 * THE CHAT SURFACE IS OpenAI-SHAPED, AND IT IS OFF UNTIL SOMEBODY TURNS IT ON.
 *
 *   POST <gateway>/v1/chat/completions      the turn
 *   GET  <gateway>/v1/models                what agents it will answer as
 *   GET  <gateway>/health                   liveness, and NO auth
 *
 * The first two are disabled by default and need one line of gateway config:
 *
 *   { gateway: { http: { endpoints: { chatCompletions: { enabled: true } } } } }
 *
 * Without it BOTH answer 404 — not 501, not a message, a bare `Not Found` —
 * which is indistinguishable from a wrong port unless something says so. That
 * sentence is `verify` below, and it is the single most useful thing in this
 * file.
 *
 * WHAT WAS ACTUALLY VERIFIED, AND WHAT WAS NOT. A real gateway was installed
 * (`npm i openclaw@latest`, 2026.9.1) and run on 127.0.0.1:18789 on 2026-09-04.
 * Confirmed against it, by hand:
 *
 *   GET  /health                     200 {"ok":true,"status":"live"}, no auth
 *   GET  /v1/models   (endpoint off) 404 "Not Found"
 *   GET  /v1/models   (no bearer)    401 {"error":{"message":"Unauthorized",
 *                                        "type":"unauthorized"}}
 *   GET  /v1/models   (bad bearer)   401, the same body
 *   GET  /v1/models   (real bearer)  200, ids: openclaw, openclaw/default,
 *                                        openclaw/main
 *   POST /tools/invoke (no bearer)   401; with bearer, 200 {"ok":true,...}
 *   POST /v1/chat/completions        500 {"error":{"message":"internal error",
 *                                        "type":"api_error"}}
 *
 * That last line is the gap and it is named rather than hidden: the turn
 * reached the agent and the agent had no harness to run — a bare gateway with
 * no model provider configured ("Agent harness runtime \"codex\" is
 * unavailable"). So every path in this file EXCEPT a successful assistant
 * message has been exercised against the real thing; the success path is built
 * from the documented schema, which is plain OpenAI. `chat/wire.ts` reads that
 * schema generously for exactly this reason.
 *
 * THE TOKEN IS AN OPERATOR CREDENTIAL, NOT AN API KEY. The docs say so twice
 * and in bold: "Treat this endpoint as a full operator-access surface", and a
 * valid gateway token "should be treated like an owner/operator credential" —
 * it carries operator.admin, operator.write, operator.approvals and the rest,
 * no matter what narrower scopes a caller claims. That is why the token is a
 * vault secret that never leaves this process, why nothing here ever puts it
 * in a URL, and why `verify` refuses to send it in the clear to a host that is
 * not on the owner's own network. Hermes' key gets no such check because
 * Hermes' key buys model completions; this one buys the machine.
 */
import * as accounts from "../accounts.ts";
import * as vault from "../vault.ts";
import { configValue } from "../db.ts";
import {
  ASK_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  WireError,
  chatCompletion,
  getJson,
  isPrivateHost,
  parseEndpoint,
  readModel,
  readModelIds,
  readText,
  readUsage,
} from "../chat/wire.ts";
import { registerBackend, type ChatBackend, type ChatReply } from "../chat/backend.ts";

const SERVICE = "OpenClaw";

export const FIELDS = ["gateway-url", "token"] as const;

/**
 * The agent to address, when the owner has not named one.
 *
 * `model` on this endpoint is NOT a provider model — it is an agent target,
 * and the docs call `openclaw/default` a "stable alias; safe to hardcode".
 * Which is the only reason there is a default at all: on Hermes the model list
 * is the owner's business and this file discovers it, while here the gateway
 * publishes a name that is guaranteed to mean "whatever agent you configured".
 */
const DEFAULT_AGENT = "openclaw/default";

/**
 * The gateway's origin — everything else is built from it.
 *
 * Unlike Hermes there is no `/v1` to append, because the gateway serves
 * several things off its root: `/health` and `/tools/invoke` sit beside
 * `/v1/…`. So a pasted `…/v1` is STRIPPED rather than kept, which is the
 * opposite move to the Hermes adapter's and for the opposite reason. People
 * paste `/v1` here anyway, out of habit from every other AI endpoint.
 */
export function normaliseGateway(
  raw: string,
): { ok: true; base: string; host: string } | { ok: false; error: string } {
  const parsed = parseEndpoint(raw, "OpenClaw gateway");
  if (!parsed.ok) return parsed;
  const base = parsed.base.replace(/\/v\d+$/, "");
  return { ok: true, base, host: parsed.url.hostname };
}

/* ----------------------------------------------------------------- verify */

/**
 * Two calls, because they prove two different things.
 *
 * `/health` needs no token and answers instantly: it says "there is an
 * OpenClaw gateway on this port". `/v1/models` needs the token and says "this
 * token is real AND the OpenAI endpoint is switched on". Either one alone
 * would connect an account that cannot chat — health alone misses the 404 that
 * the default configuration produces, and models alone cannot tell a wrong
 * port from a disabled endpoint, since both are a bare `Not Found`.
 *
 * NOT `POST /v1/chat/completions`. OpenClaw's own health documentation is
 * emphatic — "DON'T use /v1/chat/completions for health checks" — because
 * every ping creates a full agent session, 4-22KB of session store each. A
 * verify that bloated the gateway's session store every time somebody fixed a
 * typo would be this integration doing harm to the thing it integrates with.
 */
export async function verify(values: {
  gatewayUrl: string;
  token: string;
}): Promise<
  { ok: true; base: string; agents: string[] } | { ok: false; error: string }
> {
  const normalised = normaliseGateway(values.gatewayUrl);
  if (!normalised.ok) return { ok: false, error: normalised.error };

  const token = values.token.trim();
  if (!token) return { ok: false, error: "Paste the gateway's shared secret." };
  if (token.includes("\n"))
    return { ok: false, error: "That is more than one line. One token per gateway here." };
  if (/^https?:\/\//i.test(token))
    return {
      ok: false,
      error: "That is a URL, not a token. The gateway URL goes in the field above.",
    };

  /*
    A cleartext hop to a host that is not the owner's own is refused, and the
    refusal is specific to THIS credential. Anyone who reads this token off the
    wire owns the gateway — the docs' word, not a paraphrase — so "it is only a
    local dashboard" is not a reason to send it over plain http to the
    internet. https anywhere is fine, and so is http to loopback, RFC1918 or a
    tailnet address, which is where a gateway is supposed to live anyway.
  */
  if (!/^https:/i.test(normalised.base) && !isPrivateHost(normalised.host))
    return {
      ok: false,
      error:
        `That would send the gateway token to ${normalised.host} in the clear. ` +
        `An OpenClaw bearer is operator access to the whole gateway, not a ` +
        `scoped API key — use https, or reach the gateway over loopback, your ` +
        `LAN or a tailnet address.`,
    };

  try {
    const health = await getJson<{ ok?: boolean; status?: string }>(
      `${normalised.base}/health`,
      {},
      SERVICE,
      PROBE_TIMEOUT_MS,
    );
    /*
      BOTH FIELDS, AND `status` IS THE ONE THAT MATTERS. `{ ok: true }` on a
      path called /health is the most common two words in the language of HTTP
      services — this exact check passed against a completely unrelated model
      router on the owner's LAN, which answers /health with `{"ok":true,"dell":
      "off",…}` and would have been stored as an OpenClaw gateway. The
      documented body is `{"ok":true,"status":"live"}`, and the status string
      is what makes it OpenClaw's health rather than anybody's. Something that
      omits it is not this gateway, whatever else it is.
    */
    if (health?.ok !== true || typeof health.status !== "string")
      return {
        ok: false,
        error:
          `${normalised.base}/health answered, but not the way an OpenClaw ` +
          `gateway does — it should say {"ok":true,"status":"live"} and said ` +
          `${JSON.stringify(health).slice(0, 120)}. That is a different service ` +
          `on this port.`,
      };
    /* Starting and draining are real states with their own status values and
       their own answer: wait. Reported as themselves rather than as a generic
       failure, because "try again in a moment" and "you have the wrong port"
       are different instructions. */
    if (health.status !== "live" && health.status !== "started")
      return {
        ok: false,
        error:
          `The gateway is up but says it is “${health.status}” rather than ` +
          `live — it is still starting, or it is draining to shut down. Try ` +
          `again once it settles.`,
      };
  } catch (err) {
    const detail = err instanceof WireError ? err.message : `Could not reach ${SERVICE}.`;
    return {
      ok: false,
      error:
        err instanceof WireError && err.status === 404
          ? `There is no /health at ${normalised.base}, so that is not an ` +
            `OpenClaw gateway. It listens on 18789 by default.`
          : detail,
    };
  }

  try {
    const doc = await getJson<unknown>(
      `${normalised.base}/v1/models`,
      { Authorization: `Bearer ${token}` },
      SERVICE,
      PROBE_TIMEOUT_MS,
    );
    const agents = readModelIds(doc);
    if (!agents.length)
      return {
        ok: false,
        error: `${normalised.base}/v1/models listed no agents, so there is nothing to ask.`,
      };
    return { ok: true, base: normalised.base, agents };
  } catch (err) {
    if (err instanceof WireError) {
      if (err.status === 401 || err.status === 403)
        return {
          ok: false,
          error:
            `The gateway refused that token. It is the shared secret from ` +
            `gateway.auth.token (or the password, in password mode) — ` +
            `\`openclaw gateway auth-token --show\` prints it.`,
        };
      if (err.status === 404)
        return {
          ok: false,
          error:
            `The gateway is alive but its OpenAI endpoint is switched off — ` +
            `/v1/models is 404 while /health is 200. That is the DEFAULT: turn ` +
            `it on with gateway.http.endpoints.chatCompletions.enabled = true ` +
            `and restart the gateway. (/tools/invoke is always on, but it ` +
            `cannot carry a conversation — sessions_send is on its hard deny ` +
            `list.)`,
        };
      if (err.status === 429)
        return {
          ok: false,
          error: "The gateway is rate-limiting authentication attempts. Wait, then retry.",
        };
      return { ok: false, error: err.message };
    }
    return { ok: false, error: `Could not reach ${SERVICE}.` };
  }
}

/* ---------------------------------------------------------------- backend */

/** The first connected account, decided from entry NAMES so that drawing the
 *  backend selector never decrypts a token. Same reasoning as the Hermes
 *  adapter's, and the same reason it is written out twice: the two files are
 *  read one at a time by somebody debugging one of them. */
function usable(account: accounts.Account): boolean {
  if (!account.connected) return false;
  const held = new Set(accounts.entries(account.id).map((e) => e.field));
  return FIELDS.every((f) => held.has(f));
}

function answering(): accounts.Account | null {
  /*
    THE MANAGED GATEWAY WINS WHEN THE OWNER HAS SAID SO. Same rule, same
    reasoning and the same two config keys as the Hermes adapter's — written
    out again rather than shared, because these two files are read one at a
    time by somebody debugging one of them, and because importing
    agents/instance.ts here would close an import cycle.

    It matters slightly more on this side: a remote gateway token is operator
    access to somebody's whole machine, so "which of my two gateways did that
    turn actually go to" is not a question to answer with an insertion order.
  */
  if (configValue("openclaw", "mode") === "managed") {
    const id = Number(configValue("openclaw", "managedAccount") ?? 0);
    const managed = id ? accounts.get(id) : undefined;
    if (managed && managed.pluginId === "openclaw" && usable(managed)) return managed;
  }
  for (const account of accounts.list("openclaw")) if (usable(account)) return account;
  return null;
}

registerBackend("openclaw", (): ChatBackend | null => {
  const account = answering();
  if (!account) return null;

  return {
    id: "openclaw",
    label: `OpenClaw · ${account.label}`,

    async ask(turns, opts): Promise<ChatReply> {
      const values = vault.readSet(account.id, "chat_openclaw");
      const normalised = normaliseGateway(values["gateway-url"] ?? "");
      if (!normalised.ok) throw new WireError(500, normalised.error);
      const token = (values.token ?? "").trim();
      const agent = (configValue("openclaw", "agent") ?? "").trim() || DEFAULT_AGENT;

      /*
        THE SESSION, WHICH IS THE ONE THING THIS BACKEND DOES THAT HERMES DOES
        NOT. The docs: "By default the endpoint is stateless per request (a new
        session key is generated each call)", and passing an OpenAI `user`
        string derives a stable session key, with `conv:<id>` the recommended
        shape. So a conversation on this dashboard is a conversation inside the
        gateway too — its own memory, its own history, its own approvals — and
        without this every message would land in a fresh session and the agent
        would have no idea what it just said.

        `x-openclaw-session-key` is the explicit override and is deliberately
        NOT used: the docs put reserved namespaces behind a 400 and explicit
        incognito continuation behind operator.admin, which is authority this
        integration has no reason to exercise.

        The turns are still sent in full. Belt and braces on purpose — the
        gateway keeps its own history, but a session that was pruned, expired
        or never created must not silently answer the last message with no
        context, and an agent seeing its own words twice is a smaller fault
        than an agent seeing none of them.
      */
      const user = opts?.sessionId ? `conv:${opts.sessionId}` : undefined;

      const started = Date.now();
      const doc = await chatCompletion({
        base: normalised.base,
        path: "/v1/chat/completions",
        key: token,
        model: agent,
        turns,
        service: SERVICE,
        /* Documented context header. It tells the gateway where the message
           came from, which is what makes "the web page" and "Telegram"
           distinguishable in ITS logs as well as ours. */
        extra: { "x-openclaw-message-channel": opts?.channel ?? "web" },
        body: user ? { user } : {},
        timeoutMs: ASK_TIMEOUT_MS,
        signal: opts?.signal,
      });
      const ms = Date.now() - started;

      const text = readText(doc);
      if (text === null)
        throw new WireError(
          502,
          `${SERVICE} answered with no text. The agent ran and produced nothing, ` +
            `which on this gateway usually means the turn ended in a tool call ` +
            `it could not complete.`,
        );

      accounts.markOk(account.id);

      return {
        text,
        backend: "openclaw",
        /*
          What the gateway reports, and it is an AGENT name rather than a
          model: the docs are explicit that `model` here is an agent target,
          and the real backing model is only settable (by an operator) through
          x-openclaw-model. Reporting the agent is therefore the honest answer
          to "what wrote this" — it is what the gateway knows.
        */
        model: readModel(doc) ?? agent,
        usage: readUsage(doc),
        ms,
      };
    },
  };
});

/** As on Hermes: the route cannot know which account answered, so the file
 *  that chose it records the failure against it. */
export function noteFailure(error: string) {
  const account = answering();
  if (account) accounts.markFailed(account.id, error.slice(0, 220));
}
