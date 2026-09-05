/**
 * HERMES — Nous Research's agent, reached over an OpenAI-compatible endpoint.
 *
 * WHAT HERMES ACTUALLY IS, BECAUSE THE CATALOG'S DESCRIPTION IS HALF RIGHT.
 * Probed against the real container on the owner's Pi
 * (`nousresearch/hermes-agent:latest`, 2026-09-04): Hermes is a COMMAND-LINE
 * agent. The container runs `hold.sh` and listens on nothing. There is no HTTP
 * API sitting there waiting to be pointed at, and the address the catalog
 * shipped as its placeholder — `http://127.0.0.1:3011/v1` — is not Hermes at
 * all: on that Pi, 3011 is workdash's own read-only proxy handing the
 * container a GET-only window onto the dashboard. It answers `/v1/models` with
 * 200 and an `index.html`, which is exactly the failure `getJson` in
 * chat/wire.ts now names in one sentence.
 *
 * SO WHERE IS THE OPENAI-COMPATIBLE ENDPOINT? Hermes ships one, and `hermes
 * --help` is where it says so. Two subcommands serve HTTP:
 *
 *   hermes serve          JSON-RPC over WebSocket, port 9119. The desktop
 *                         app's backend. NOT OpenAI-shaped, and not what this
 *                         adapter speaks.
 *   hermes proxy start    "Run a local HTTP server that forwards
 *                         OpenAI-compatible requests to an OAuth-authenticated
 *                         provider (e.g. Nous Portal). External apps can point
 *                         at the proxy with any bearer token; the proxy
 *                         attaches your real credentials."
 *                         127.0.0.1:8645 by default.
 *
 * The second one is this door, and its own help text settles the question the
 * field list would otherwise raise: THE KEY IS NOT CHECKED BY THE PROXY. It
 * takes any bearer and attaches the owner's real Nous Portal OAuth credential
 * on the way out. The key field is still required and still a secret, because
 * the same base URL may just as well be Nous Portal itself, or any other
 * OpenAI-compatible server the owner already has — and those do check it.
 *
 * WHAT IS UNVERIFIED, SAID PLAINLY. `hermes proxy start` refuses to run on
 * that Pi: `Not logged into Nous Portal. Run 'hermes auth add nous' first.`
 * There is no Nous credential on this estate and inventing one is not on the
 * table, so no completion has ever been read back from `hermes proxy` itself.
 * What HAS been verified end to end, through this adapter and `POST
 * /api/chat`, is a real OpenAI-compatible endpoint on the same Pi — the model
 * door on 172.31.7.1:3013 that the Hermes container is itself pointed at. Same
 * wire, same request, same parser, a real answer. The gap is one process, and
 * it is named here rather than papered over.
 *
 * MULTIPLE ACCOUNTS, ONE ANSWERER. A plugin holds a list of accounts and this
 * one is no exception — a Nous Portal key and a local router are two perfectly
 * reasonable rows. But a chat turn goes to ONE agent, so the factory below
 * takes the FIRST connected account and puts its label on the backend
 * ("Hermes · Nous Portal") so the page can say which. The alternative — asking
 * all of them and showing whichever answered first — is two bills and two
 * different answers to one question.
 */
import * as accounts from "../accounts.ts";
import * as vault from "../vault.ts";
import { configValue } from "../db.ts";
import {
  ASK_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  WireError,
  chatCompletion,
  chatCompletionStream,
  deltaText,
  getJson,
  parseEndpoint,
  readModel,
  readModelIds,
  readText,
  readUsage,
  type StreamChunk,
} from "../chat/wire.ts";
import { parseFrame } from "../chat/sse.ts";
import {
  registerBackend,
  type ChatBackend,
  type ChatReply,
  type ChatStreamEvent,
} from "../chat/backend.ts";

const SERVICE = "Hermes";

/** The vault fields, named once. routes/plugins.ts repeats them because its
 *  registry is the closed list that gets to write to the vault; this is the
 *  list this file reads back, and they have to agree. */
export const FIELDS = ["base-url", "key"] as const;

/**
 * The base URL, with `/v1` on the end whether or not it was pasted.
 *
 * EVERY OpenAI-COMPATIBLE SERVER PUTS ITS API UNDER `/v1`, and roughly half
 * the people pasting an address paste the origin because that is what is in
 * the terminal when the thing starts up. Appending it is therefore not a
 * guess, it is the convention — and a path that ALREADY ends in `/v1` is left
 * alone, so `https://portal.nousresearch.com/v1` and
 * `http://127.0.0.1:8645` both land on the same request.
 *
 * A server that genuinely serves completions at its root is the case this
 * gets wrong, and it gets it wrong LOUDLY: verify() below fails at connect
 * time with the URL it tried, rather than connecting and then 404ing on every
 * message for a week.
 */
export function normaliseBase(
  raw: string,
): { ok: true; base: string } | { ok: false; error: string } {
  const parsed = parseEndpoint(raw, "Hermes base");
  if (!parsed.ok) return parsed;
  const base = /\/v\d+$/.test(parsed.base) ? parsed.base : `${parsed.base}/v1`;
  return { ok: true, base };
}

/* ----------------------------------------------------------------- verify */

/**
 * A real round trip, not a URL check.
 *
 * `GET <base>/models` rather than a completion, for the reason OpenClaw's own
 * health page spells out about itself and which applies here just as well: a
 * completion spends a token budget and, on an agent, creates a session. The
 * model list proves the same three things a chat turn would — the address is
 * a server, it speaks this API, and it accepts this bearer — for nothing.
 *
 * IT ALSO COMES BACK WITH THE MODEL IDS, which is the whole reason the model
 * setting can default to "let the endpoint choose": the first id the endpoint
 * lists is a real id from a real list rather than a name this file made up.
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
  try {
    const doc = await getJson<unknown>(
      `${normalised.base}/models`,
      key ? { Authorization: `Bearer ${key}` } : {},
      SERVICE,
      PROBE_TIMEOUT_MS,
    );
    const models = readModelIds(doc);
    /*
      A model list that is EMPTY is refused rather than stored. An endpoint
      with no models answers `/models` perfectly and then refuses every
      completion — the "connects happily and then shows nothing" failure this
      codebase keeps catching at the door instead of an hour later.
    */
    if (!models.length)
      return {
        ok: false,
        error:
          `${normalised.base}/models answered, but listed no models. That is a ` +
          `server with nothing behind it — a Hermes proxy that has not been ` +
          `logged in (\`hermes auth add nous\`), or a router with no upstream.`,
      };
    return { ok: true, base: normalised.base, models };
  } catch (err) {
    if (err instanceof WireError) {
      if (err.status === 401 || err.status === 403)
        return {
          ok: false,
          error:
            `${normalised.base} refused that key. Note that \`hermes proxy\` ` +
            `accepts ANY bearer token and attaches its own Nous credential, so ` +
            `a refusal here means this URL is a real provider that wants a real ` +
            `key.`,
        };
      if (err.status === 404)
        return {
          ok: false,
          error:
            `There is no /models at ${normalised.base}. Check the port: on a box ` +
            `running \`hermes proxy start\` it is 8645, and \`hermes serve\` on ` +
            `9119 is a WebSocket JSON-RPC gateway that does not speak this API.`,
        };
      return { ok: false, error: err.message };
    }
    return { ok: false, error: `Could not reach ${SERVICE}.` };
  }
}

/* -------------------------------------------------------------- the model */

/**
 * Which model to ask for, and where the answer comes from.
 *
 * The owner may name one in Settings (`plugin_config`, a non-secret setting
 * that reads back — see routes/pluginConfig.ts). When they have not, the
 * endpoint's own first model is used, discovered once per process per URL.
 *
 * WHY A CACHE AND NOT A LOOKUP PER MESSAGE. Asking `/models` before every
 * chat turn doubles the round trips to buy a string that changes about never.
 * WHY A CACHE AND NOT A STORED VALUE: writing the discovered id into the
 * database at connect time would freeze it, and an endpoint that later drops
 * that model would fail every message with "unknown model" until somebody
 * cleared a row they did not know existed. A process-lifetime cache splits the
 * difference — cheap, and wrong for at most one restart.
 */
const discovered = new Map<string, string>();

async function pickModel(
  base: string,
  key: string,
  signal?: AbortSignal,
): Promise<string> {
  const configured = (configValue("hermes", "model") ?? "").trim();
  if (configured) return configured;

  const cached = discovered.get(base);
  if (cached) return cached;

  const doc = await getJson<unknown>(
    `${base}/models`,
    key ? { Authorization: `Bearer ${key}` } : {},
    SERVICE,
    PROBE_TIMEOUT_MS,
    signal,
  );
  const first = readModelIds(doc)[0];
  if (!first)
    throw new WireError(
      502,
      `${base} lists no models, so there is nothing to ask. Name one in the ` +
        `Hermes settings, or point this at an endpoint that has one.`,
    );
  discovered.set(base, first);
  return first;
}

/* ---------------------------------------------------------------- backend */

/**
 * The account that answers, without opening its ciphertext.
 *
 * `accounts.entries()` returns entry NAMES and dates, never values, so
 * deciding "is Hermes connected" costs no decryption and writes no row to
 * secret_access. That matters more than it looks: the Chat page asks
 * `backends()` for its selector on every load, and a design that decrypted a
 * key to draw a dropdown would fill the access log with reads that touched
 * nothing. The key is opened inside `ask`, once, by the call that actually
 * needs it.
 */
function usable(account: accounts.Account): boolean {
  if (!account.connected) return false;
  const held = new Set(accounts.entries(account.id).map((e) => e.field));
  return FIELDS.every((f) => held.has(f));
}

function answering(): accounts.Account | null {
  /*
    THE MANAGED INSTANCE WINS WHEN THE OWNER HAS SAID SO, and only then.

    `agents/instance.ts` can install and run a Hermes on this machine and
    connects it as an account of its own — which means a plugin can hold two
    perfectly good credentials at once: a Hermes on another box, pasted months
    ago, and the one this app spawned five minutes ago. "The first connected
    account" cannot decide between those, and whichever it picked would be an
    accident of insertion order rather than a decision.

    So it is a SETTING. `mode` says which kind of credential answers and
    `managedAccount` names the row the spawner created — both written by
    agents/instance.ts, both spelled out here rather than imported, because
    importing that module from this one would close a cycle (it imports this
    file for `verify` and FIELDS). Anything other than `managed` leaves the
    original rule exactly as it was.
  */
  if (configValue("hermes", "mode") === "managed") {
    const id = Number(configValue("hermes", "managedAccount") ?? 0);
    const managed = id ? accounts.get(id) : undefined;
    if (managed && managed.pluginId === "hermes" && usable(managed)) return managed;
  }
  for (const account of accounts.list("hermes")) if (usable(account)) return account;
  return null;
}

/**
 * Registered at import. index.ts imports this file for this side effect and
 * for no other reason, which is why the import order there is load-bearing and
 * is commented as such.
 */
registerBackend("hermes", (): ChatBackend | null => {
  const account = answering();
  if (!account) return null;

  return {
    id: "hermes",
    label: `Hermes · ${account.label}`,

    async ask(turns, opts): Promise<ChatReply> {
      /*
        Read at the point of use rather than when the factory ran. The factory
        is called on every `activeBackend()`, but a rotated key still has to be
        picked up mid-conversation, and reading here means the value in hand is
        the value in the vault a millisecond ago.
      */
      const values = vault.readSet(account.id, "chat_hermes");
      const normalised = normaliseBase(values["base-url"] ?? "");
      if (!normalised.ok) throw new WireError(500, normalised.error);
      const key = (values.key ?? "").trim();

      const started = Date.now();
      const model = await pickModel(normalised.base, key, opts?.signal);
      const doc = await chatCompletion({
        base: normalised.base,
        key: key || null,
        model,
        turns,
        service: SERVICE,
        timeoutMs: ASK_TIMEOUT_MS,
        signal: opts?.signal,
      });
      const ms = Date.now() - started;

      const text = readText(doc);
      if (text === null)
        throw new WireError(
          502,
          `${SERVICE} answered with no text at all. The turn reached the model ` +
            `and came back empty, which is a fault at the endpoint rather than ` +
            `here.`,
        );

      /*
        The account is marked from the outcome, the same way every collector in
        this project marks its own: a chat turn IS this plugin's health check,
        and a page that says "connected" about an endpoint that refused the
        last four messages is a page telling the owner something untrue.
      */
      accounts.markOk(account.id);

      return {
        text,
        backend: "hermes",
        /* What the SERVER said it used, not what was asked for — a router
           answers `auto` with the id it actually routed to. */
        model: readModel(doc) ?? model,
        usage: readUsage(doc),
        ms,
      };
    },

    /**
     * The same turn, as it is written — and the one place this adapter reads
     * something no other OpenAI-compatible server sends.
     *
     * HERMES' ROUTER PUTS TOOL CALLS IN NAMED SSE EVENTS, which is not in the
     * OpenAI spec and is the reason `chatCompletionStream` yields FRAMES
     * rather than text. Probed against the live instance on 2026-09-05:
     *
     *   event: hermes.tool.progress
     *   data: {"tool":"terminal","emoji":"💻","label":"date",
     *          "toolCallId":"call_…","status":"running"}
     *
     * …then the identical object with `"status":"completed"`, interleaved
     * between ordinary `data:` content chunks. THERE IS NO RESULT IN THE
     * STREAM — no output, no exit code, no stdout — so what this yields is
     * exactly what arrived: the tool, its one-line label, and running or
     * completed. Anything more on the page would be invented.
     *
     * THE TIMESTAMP IS OURS. The event carries none, and a timestamp from the
     * agent's own box would be a clock this process cannot vouch for. `at` is
     * stamped here, on receipt, which is honestly "when we heard about it"
     * rather than "when it happened" — the difference is a network hop and it
     * is the only one of the two this side can actually measure.
     *
     * FAILURE IS A THROW, MID-GENERATOR, AND THE ROUTE IS WRITTEN FOR IT. Text
     * already yielded has already been drawn on somebody's screen; the route
     * stores it flagged `partial` and says what went wrong. That is the whole
     * argument that kept streaming out of this codebase until now, and it is
     * settled in the route and the schema rather than here.
     */
    async *stream(turns, opts): AsyncGenerator<ChatStreamEvent> {
      const values = vault.readSet(account.id, "chat_hermes");
      const normalised = normaliseBase(values["base-url"] ?? "");
      if (!normalised.ok) throw new WireError(500, normalised.error);
      const key = (values.key ?? "").trim();

      const started = Date.now();
      const model = await pickModel(normalised.base, key, opts?.signal);

      /*
        Accumulated here rather than by the caller. The route needs the WHOLE
        answer to write the row, and reassembling it from the deltas at the far
        end would put two counts of "what was said" in play — the one drawn and
        the one stored — which are the same string right up until one chunk is
        dropped.
      */
      let text = "";
      let thinking = "";
      let reportedModel: string | null = null;
      let usage: { prompt: number; completion: number } | null = null;

      for await (const frame of chatCompletionStream({
        base: normalised.base,
        key: key || null,
        model,
        turns,
        service: SERVICE,
        signal: opts?.signal,
      })) {
        /* The tool events, which are the reason for the frame reader. Named
           events are matched by name and nothing else — an unknown named event
           is skipped in silence rather than guessed at. */
        if (frame.event === "hermes.tool.progress") {
          const t = parseFrame<{
            tool?: unknown;
            emoji?: unknown;
            label?: unknown;
            toolCallId?: unknown;
            status?: unknown;
          }>(frame.data);
          /* A tool event with no id and no name is not a tool event. Dropped
             rather than yielded with placeholders, because a grey line reading
             "unknown · unknown" tells the owner strictly less than no line. */
          if (!t || typeof t.tool !== "string" || !t.tool) continue;
          const status = t.status === "completed" ? "completed" : "running";
          yield {
            type: "tool",
            /* An id is what pairs `running` with `completed`. When the router
               omits one, the tool name is the next best key — two concurrent
               calls to the same tool would then merge into one line, which is
               a wrong drawing rather than a lost event. */
            toolCallId:
              typeof t.toolCallId === "string" && t.toolCallId ? t.toolCallId : t.tool,
            tool: t.tool,
            label: typeof t.label === "string" && t.label.trim() ? t.label : null,
            emoji: typeof t.emoji === "string" && t.emoji.trim() ? t.emoji : null,
            status,
            at: new Date().toISOString(),
          };
          continue;
        }
        /* Anything else named is not ours to interpret. */
        if (frame.event && frame.event !== "message") continue;

        if (frame.data === "[DONE]") break;
        const chunk = parseFrame<StreamChunk>(frame.data);
        if (!chunk) continue;
        /*
          AN ERROR CAN ARRIVE MID-STREAM, on a 200, after real text. A gateway
          that loses its upstream half way says so in a chunk and then closes;
          read as an ordinary chunk it is silence, and the turn ends looking
          complete when it was cut off.
        */
        const err = chunk.error;
        if (err) {
          const message = typeof err === "string" ? err : (err.message ?? "");
          throw new WireError(
            502,
            `${SERVICE} stopped mid-answer${message ? ` — ${message}` : "."}`,
          );
        }

        if (chunk.model) reportedModel = chunk.model;
        if (chunk.usage) {
          const u = readUsage({ usage: chunk.usage });
          if (u) usage = u;
        }

        const choice = chunk.choices?.[0];
        const piece = deltaText(choice?.delta);
        if (piece) {
          text += piece;
          yield { type: "delta", text: piece };
        }
        /* Reasoning is a SEPARATE event and never appended to `text`. A model's
           scratchpad in front of its answer, on every turn, is the failure
           `readText` avoids on the non-streaming path for the same reason. */
        const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          thinking += reasoning;
          yield { type: "reasoning", text: reasoning };
        }
      }

      const ms = Date.now() - started;

      /*
        THE SAME FALLBACK `readText` MAKES, and for the same reason: a model
        cut off at max_tokens has its working in `reasoning` and nothing in
        `content`, and showing the owner the working beats showing them an
        empty bubble. It is a fallback and never a supplement — the two are
        concatenated nowhere.
      */
      const answer = text || thinking;
      if (!answer)
        throw new WireError(
          502,
          `${SERVICE} streamed no text at all. The turn reached the model and ` +
            `came back empty, which is a fault at the endpoint rather than here.`,
        );

      accounts.markOk(account.id);

      yield {
        type: "done",
        text: answer,
        model: reportedModel ?? model,
        usage,
        ms,
      };
    },
  };
});

/** Record a failed turn against the account, so the plugin page shows it. Kept
 *  here rather than in the route because the route does not know which account
 *  answered — this file chose it. */
export function noteFailure(error: string) {
  const account = answering();
  if (account) accounts.markFailed(account.id, error.slice(0, 220));
}
