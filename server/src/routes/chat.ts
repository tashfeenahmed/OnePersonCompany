/**
 * THE CHAT ROUTE — one door, whichever agent is behind it.
 *
 * Three things live here and nothing else: send a message, list the backends,
 * choose one. Every one of them goes through `chat/backend.ts`, which is the
 * seam; this file holds no HTTP to an agent and knows nothing about Hermes or
 * OpenClaw beyond their two ids.
 *
 * A MESSAGE, NOT A TRANSCRIPT — WHICH IS THE ONE REAL DESIGN DECISION IN THIS
 * FILE. The obvious contract is `{ sessionId, turns }`: the caller keeps the
 * conversation and posts the whole thing each time, the server stays stateless
 * and there is no table. It was declined, and the reason is the second caller.
 *
 * A Telegram bridge is being built against the same seam. Telegram hands you a
 * chat id and one new message; it has no store of its own, no React state, and
 * no way to reconstruct what was said on the dashboard an hour ago. If the
 * route demanded turns, every caller would have to keep its own copy of the
 * conversation — and then the page and the phone would be two conversations
 * with one agent, diverging from the first message that arrived by the other
 * door. So the contract is `{ sessionId, message }`, the server holds the
 * history in `chat_messages`, and both doors read and write the same rows.
 * "Continue this conversation" then means the same thing everywhere.
 *
 * The cost of that choice is real and worth naming: the server is now stateful
 * about chat, and a session id from the browser is trusted as an opaque key.
 * It is not a secret and it grants nothing — a guessed id reads a conversation
 * on a service bound to 127.0.0.1 — but it IS the whole authorisation story,
 * and if this app ever grows a second user that is the line to revisit.
 *
 * EVERY OUTBOUND CALL CARRIES A DEADLINE, and it is not this file's timeout
 * alone. `chat/wire.ts` puts an AbortSignal.timeout on the fetch, and the
 * request's own signal is combined with it, so a closed tab and a hung agent
 * both end the call. An agent that decides to think for an hour must not be
 * able to hold a socket, a page and a row lock while it does.
 *
 * NO STREAMING, DELIBERATELY. Both backends speak SSE — Hermes' router streams
 * `data:` chunks with `reasoning` deltas, OpenClaw documents `stream: true`
 * with a trailing usage chunk — and rendering it would be nicer. It is not
 * built, because the honest version is more than a pipe: a stream that dies
 * half way has already put half an answer on screen and there is no truthful
 * way to store that as a message, so it needs a partial-message state in the
 * table, in the API and on the page. That is a feature, not a wire change, and
 * this route is the wire. The full turn is fetched, written down, and returned.
 */
import { Hono } from "hono";
import {
  appendChatMessage,
  chatMessages,
  deleteChatSession,
  type ChatMessageRow,
} from "../db.ts";
import {
  NoBackendError,
  activeBackend,
  ask,
  backends,
  setChoiceReader,
  type ChatBackendId,
  type ChatTurn,
} from "../chat/backend.ts";
import { readChatBackend, writeChatBackend } from "./pluginConfig.ts";
import { WireError } from "../chat/wire.ts";
import * as hermes from "../providers/hermes.ts";
import * as openclaw from "../providers/openclaw.ts";

export const chat = new Hono();

/**
 * THE WIRING THAT MAKES `activeBackend()` WORK, done at import.
 *
 * chat/backend.ts deliberately has no import of the config store — it is a
 * pure seam, and a seam that reached into the database would be a seam with an
 * opinion about where a setting lives. So it exposes `setChoiceReader` and
 * somebody has to call it. That somebody is this file, because this file owns
 * the config key, and it happens at import so that any module which can reach
 * `ask()` has already been through here.
 *
 * The function is passed rather than the value: `readChatBackend` is invoked
 * on EVERY `activeBackend()`, which is what makes switching agents take effect
 * on the next message instead of the next restart.
 */
setChoiceReader(readChatBackend);

/**
 * How much of a conversation the agent is told about.
 *
 * A number rather than a token budget, because the two backends count tokens
 * differently and one of them (OpenClaw) keeps its own session anyway. Forty
 * turns is around twenty exchanges — long enough that "as I said earlier"
 * works, short enough that a chat left open for a month does not start costing
 * a fortune per message. The whole transcript is still stored and still shown
 * on the page; this is only what gets SENT.
 */
const CONTEXT_TURNS = 40;

/** Longest message accepted. A paste that is really a file is refused here
 *  rather than at the agent, where it arrives as an opaque 400 after a long
 *  wait and a token bill. */
const MAX_MESSAGE = 32_000;

/* ------------------------------------------------------------------ shapes */

/** A stored message as the page reads it. The database's snake_case stays in
 *  the database; nulls stay null, because "not reported" is not zero. */
function shapeMessage(r: ChatMessageRow) {
  return {
    id: r.id,
    ts: r.ts,
    role: r.role,
    content: r.content,
    backend: r.backend as ChatBackendId | null,
    channel: r.channel,
    model: r.model,
    usage:
      r.prompt_tokens === null && r.completion_tokens === null
        ? null
        : { prompt: r.prompt_tokens ?? 0, completion: r.completion_tokens ?? 0 },
    ms: r.ms,
  };
}

/**
 * Who could answer, who is chosen, and who is actually live.
 *
 * THREE FACTS RATHER THAN ONE, because they come apart and the interface has
 * to be able to say which. A backend can be connected and not chosen ("ready,
 * not live"); chosen and not connected (picked before the key was pasted); or
 * both, which is the only combination that answers a message. Collapsing them
 * into a single boolean is how a page ends up saying "no agent connected" to
 * somebody looking at a green dot on the Hermes page.
 */
function backendState() {
  const chosen = readChatBackend();
  const live = activeBackend();
  return {
    backends: backends().map((b) => ({
      ...b,
      /* The one that will actually be asked. At most one of these is true, by
         construction — that is the whole rule, made visible. */
      live: live !== null && live.id === b.id,
    })),
    chosen,
    /* Null when nothing will answer, and the page turns that into a sentence
       with a link to Integrations. The reason is spelled out so the page does
       not have to reverse-engineer it from the flags above. */
    live: live?.id ?? null,
    liveLabel: live?.label ?? null,
    why:
      live !== null
        ? null
        : chosen === null
          ? "No agent is chosen. Pick Hermes or OpenClaw to make one live."
          : `${chosen} is chosen but not connected — its credentials are not in the vault yet.`,
  };
}

/* ------------------------------------------------------------------ routes */

/** The selector's data. Cheap on purpose: no vault value is decrypted to
 *  answer it — the adapters decide "connected" from entry names alone. */
chat.get("/backends", (c) => c.json(backendState()));

/**
 * Choose the one that answers.
 *
 * Writes through pluginConfig, which owns the key and its validation, rather
 * than touching `plugin_config` from here. `null` is a legal body and means
 * "no agent is live" — a state worth being able to reach deliberately, because
 * the alternative to switching an agent off is deleting its credentials.
 */
chat.put("/backend", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    backend?: string | null;
  } | null;
  if (!body || !("backend" in body))
    return c.json({ error: "Expected { backend: \"hermes\" | \"openclaw\" | null }." }, 400);

  const value = body.backend;
  if (value !== null && value !== "hermes" && value !== "openclaw")
    return c.json(
      {
        error:
          `“${String(value)}” is not a chat backend. The two are hermes and ` +
          `openclaw, and null means none of them.`,
      },
      400,
    );

  writeChatBackend(value);
  /*
    Answered with the WHOLE state rather than an ok. Choosing a backend that
    turns out not to be connected is a thing that happens, and the caller
    should not have to make a second request to find out that the switch it
    just flipped did not make anything live.
  */
  return c.json(backendState());
});

/** One conversation, oldest first — what the page loads when a session is
 *  opened, and what Telegram would read to show history. */
chat.get("/:sessionId/messages", (c) => {
  const sessionId = c.req.param("sessionId");
  return c.json({
    sessionId,
    messages: chatMessages(sessionId).map(shapeMessage),
    ...backendState(),
  });
});

/** Forget one conversation. Scoped to a single session id by the route shape
 *  itself: there is no way to spell "all of them" here. */
chat.delete("/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  return c.json({ sessionId, deleted: deleteChatSession(sessionId) });
});

/**
 * Say something, and get an answer.
 *
 * THE ORDER OF WRITES IS THE POINT. The user's message is stored BEFORE the
 * agent is asked, so a turn that times out, is refused, or arrives while
 * nothing is connected still leaves the question in the transcript. The
 * alternative — write both at the end — loses the owner's own words every time
 * the agent falls over, which is exactly when they would like to retry them.
 *
 * The assistant's message is stored only if there is one. A failed turn writes
 * no assistant row at all rather than a row saying "error": a transcript is
 * what was SAID, and an error is something the interface reports, not
 * something the agent said. The page shows the failure beneath the question
 * and it disappears on reload, which is correct — the question is real and
 * durable, the failure was a moment.
 */
chat.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    message?: string;
    channel?: string;
  } | null;

  const sessionId = (body?.sessionId ?? "").trim();
  const message = body?.message ?? "";
  if (!sessionId) return c.json({ error: "A sessionId is required." }, 400);
  if (typeof message !== "string" || !message.trim())
    return c.json({ error: "There is no message to send." }, 400);
  if (message.length > MAX_MESSAGE)
    return c.json(
      {
        error:
          `That message is ${message.length.toLocaleString()} characters. The ` +
          `limit here is ${MAX_MESSAGE.toLocaleString()} — anything larger is a ` +
          `file rather than a message, and the agent would refuse it after a ` +
          `long wait and a token bill.`,
      },
      413,
    );
  const channel = body?.channel === "telegram" ? "telegram" : "web";

  /*
    REFUSED BEFORE THE MESSAGE IS STORED, and only in this one case. Nothing is
    live, so there is no conversation for this question to be part of — writing
    it down would leave a user turn in the transcript that no agent ever saw
    and that a later, successful turn would silently answer out of order.
  */
  const live = activeBackend();
  if (!live) {
    const state = backendState();
    return c.json({ error: new NoBackendError().message, ...state }, 503);
  }

  const stored = appendChatMessage({ sessionId, role: "user", content: message, channel });

  /*
    The history INCLUDES the message just written, which is why it is read
    after the insert rather than before and appended to. One source of truth
    for "what this conversation is", and no chance of the sent turns
    disagreeing with the stored ones by an off-by-one.
  */
  const history = chatMessages(sessionId, CONTEXT_TURNS);
  const turns: ChatTurn[] = history.map((m) => ({ role: m.role, content: m.content }));

  try {
    const reply = await ask(turns, {
      sessionId,
      channel,
      /* The client's own signal. A closed tab or a cancelled fetch ends the
         outbound call rather than leaving it running for an answer nobody is
         waiting for. */
      signal: c.req.raw.signal,
    });

    const assistant = appendChatMessage({
      sessionId,
      role: "assistant",
      content: reply.text,
      channel,
      backend: reply.backend,
      model: reply.model,
      promptTokens: reply.usage?.prompt ?? null,
      completionTokens: reply.usage?.completion ?? null,
      ms: reply.ms,
    });

    return c.json({
      sessionId,
      user: shapeMessage(stored),
      reply: shapeMessage(assistant),
      /* The ChatReply as the contract defines it, beside the stored row. The
         Telegram bridge wants this and not the row; the page wants the row. */
      backend: reply.backend,
      model: reply.model,
      usage: reply.usage,
      ms: reply.ms,
    });
  } catch (err) {
    /*
      `NoBackendError` is still possible here despite the check above — the
      credentials can be deleted between the two lines — and it keeps its 503
      and its own sentence, which is the one chat/backend.ts wrote for exactly
      this purpose.
    */
    if (err instanceof NoBackendError)
      return c.json({ error: err.message, user: shapeMessage(stored), ...backendState() }, 503);

    const message =
      err instanceof WireError
        ? err.message
        : err instanceof Error
          ? err.message
          : "The agent failed for a reason it did not give.";

    /*
      Recorded against the ACCOUNT that failed, so the Integrations page shows
      a red line on the credential that stopped working. The adapters do it
      because only they know which of a plugin's accounts answered.
    */
    if (live.id === "hermes") hermes.noteFailure(message);
    else openclaw.noteFailure(message);

    console.error(`[chat] ${live.id} failed — ${message}`);

    /*
      502 rather than 500: this process is fine, the thing it called is not,
      and the difference tells the owner whether to look at this app or at
      their gateway. A timeout keeps its own 504 for the same reason.
    */
    const status = err instanceof WireError && err.status === 504 ? 504 : 502;
    return c.json(
      { error: message, backend: live.id, user: shapeMessage(stored) },
      status,
    );
  }
});
