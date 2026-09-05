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
 * STREAMING, AND THE PRICE THAT WAS PAID FOR IT.
 *
 * This header used to say there was none, and gave the reason: "a stream that
 * dies half way has already put half an answer on screen and there is no
 * truthful way to store that as a message, so it needs a partial-message state
 * in the table, in the API and on the page. That is a feature, not a wire
 * change." That was right, and the feature has now been built — all three
 * parts of it, which is why it took a migration rather than a flag:
 *
 *   the table   019_chat_tools adds `partial` and `tools`
 *   the API     POST /chat/stream below, whose `error` event is emitted AFTER
 *               the partial row is written, so a client that sees the failure
 *               can trust the transcript already has the words
 *   the page    a bubble that grows, and draws the partial flag when it is set
 *
 * THE OLD ROUTE IS UNCHANGED AND IS NOT DEPRECATED. `POST /chat` still fetches
 * a whole turn and returns a document, because the second caller still wants
 * exactly that: Telegram has no growing bubble to render into and sends one
 * message when the answer is done. Two routes for two shapes of caller is
 * cheaper than one route with a mode, and it means the bridge cannot be broken
 * by a change to the streaming path.
 *
 * WHAT IS STORED, AND WHEN. Nothing assistant-shaped is written until the
 * stream ends, one way or the other. A row written on the first delta and
 * updated as it grew would be a row that is briefly a lie in the database (an
 * assistant message that says three words), readable by the other door mid-
 * sentence. So: the user's turn goes down first as it always did, the deltas
 * go to the browser and nowhere else, and exactly one assistant row is written
 * at the end — complete, or flagged `partial` and honest about it.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  appendChatMessage,
  chatMessages,
  chatSessionSummaries,
  deleteChatSession,
  type ChatMessageRow,
  type ChatToolCall,
} from "../db.ts";
import {
  NoBackendError,
  activeBackend,
  ask,
  backends,
  setChoiceReader,
  type ChatBackend,
  type ChatStreamEvent,
  type ChatTurn,
  type MessageBackendId,
} from "../chat/backend.ts";
import { readChatBackend, writeChatBackend } from "./pluginConfig.ts";
import { WireError } from "../chat/wire.ts";
import * as hermes from "../providers/hermes.ts";
import * as openclaw from "../providers/openclaw.ts";
/*
  THE LAYER BELOW THE AGENTS, reached only when no agent is live. See the
  fallback in the POST handler for the argument; the import is here rather than
  inside it because a dynamic import in a request path is a first-call latency
  spike bought to hide a dependency that is real.
*/
import { activeProvider, complete } from "../models/provider.ts";
import { noteOutcome } from "./models.ts";
/*
  WHERE THE SKILLS LIVE, AND WHY THIS ROUTE HAS TO KNOW. A MANAGED agent has
  the packs installed into its own home and the MCP server registered in its
  own config; a REMOTE one is somebody else's process on somebody else's box
  and this app can write nothing into it. `readMode` is how those two are told
  apart — see `withSkills` below.
*/
import { readMode } from "../agents/instance.ts";
import { preamble } from "../skills/registry.ts";
/*
  WHICH BUSINESS THIS CONVERSATION IS ABOUT, when the page said. Imported
  from the route rather than read from the table here, because the STAGE
  prose that goes in the turn belongs to /api/ventures and must have exactly
  one author — the form the owner picked the stage on, the agent that acts
  on it and this turn all quote the same sentence.
*/
import { ventureContext } from "./ventures.ts";

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

/**
 * Tell a REMOTE agent that this dashboard's data exists — and tell a managed
 * one nothing.
 *
 * THE ASYMMETRY IS THE POINT AND IT IS NOT AN OVERSIGHT. A managed agent has
 * the whole registry installed: one skill pack per connected integration in its
 * own skills directory, and the MCP server registered in its own config. Both
 * carry the full honesty rules. Prepending a summary of the same thing as a
 * system turn would put two sets of instructions about one subject in front of
 * one model — a short one saying "curl /api/skills/stripe" and a long one
 * saying rather more — and the failure mode of that is not redundancy, it is a
 * model choosing between them: it reads the preamble, decides it now knows how
 * to fetch Stripe, never loads the pack, and answers without the rules. The
 * packs are strictly the better half, so the preamble stands down for them.
 *
 * A REMOTE agent has neither, because there is nothing of ours on the machine
 * it runs on. The preamble is all it will ever get, so it gets it: the base
 * URL, one line per connected skill, and the four rules that are true of every
 * document here. It is capped at about 1,500 characters — see
 * `skills/registry.ts` — so it costs a fraction of one turn.
 *
 * THE PROVIDER FALLBACK GETS NOTHING EITHER, and that is deliberate. When no
 * agent is live, a message goes to a raw model through `complete()`: no tools,
 * no terminal, no way to fetch a URL. Handing it a base URL would be handing it
 * an instruction it cannot carry out, and a model told to fetch something it
 * cannot fetch does not say so — it writes down what the answer would probably
 * have been. That is the one outcome this whole feature exists to prevent.
 *
 * The turn is prepended rather than appended so the transcript stays the last
 * thing the model read, and it is NOT stored: it is context for one call, not
 * something anybody said, and a transcript read six weeks later should not have
 * a paragraph in it that the owner never typed.
 */
function withSkills(turns: ChatTurn[], live: ChatBackend | null): ChatTurn[] {
  if (!live) return turns;
  if (readMode(live.id) === "managed") return turns;
  return [{ role: "system", content: preamble() }, ...turns];
}

/**
 * TELL WHOEVER IS ANSWERING WHICH BUSINESS THIS IS ABOUT.
 *
 * THIS ONE GOES TO EVERYBODY, and that is the difference from `withSkills`
 * above — which is why the two are separate functions rather than one with a
 * flag. The preamble stands down for a managed agent because the agent already
 * has the same instructions as skill packs, and stands down for a raw provider
 * because it would be telling a model with no tools to fetch a URL. Neither
 * argument applies here: this is not an instruction about tools, it is the
 * SUBJECT of the conversation. A managed Hermes could go and read
 * /api/skills/ventures, but it would have to guess that it should, and a raw
 * model cannot read anything at all — for both of them, "the owner is asking
 * about Example App 1, which is launched" is the difference between advice about
 * churn and advice about validating demand.
 *
 * THE STAGE IS THE PAYLOAD. Everything else in the turn is there to make the
 * answer specific; the stage is what makes it CORRECT. So it arrives with the
 * sentence that defines it rather than as a bare word, because "pre-launch"
 * means something precise to the owner who picked it off a form that explained
 * it, and nothing in particular to a model that has met the word in a thousand
 * other contexts.
 *
 * THE URL IS MENTIONED ONLY TO SOMETHING THAT COULD FETCH IT. Any live agent
 * can — a managed one through its own MCP tools and packs, a remote one
 * through the preamble's base URL — so both are told where the full record is.
 * The provider fallback is told nothing about URLs, for the reason
 * `withSkills` gives at length: a model asked to fetch something it cannot
 * fetch does not say so, it writes down what the answer would probably have
 * been.
 *
 * NOT STORED, and prepended rather than appended, on the same rule the
 * preamble keeps: it is context for one call rather than something anybody
 * said, and a transcript read six weeks later must not have a paragraph in it
 * the owner never typed. An id that names nothing is IGNORED — a client
 * holding a venture deleted in another tab is a stale page, not a bad request.
 */
function withVenture(
  turns: ChatTurn[],
  ventureId: string | null,
  live: ChatBackend | null,
): ChatTurn[] {
  if (!ventureId) return turns;
  const ctx = ventureContext(ventureId);
  if (!ctx) return turns;
  const { venture, stageMeans } = ctx;

  const lines = [
    `This conversation is about one of the owner's ventures.`,
    ``,
    `Name: ${venture.name}`,
    `Stage: ${venture.stage} — ${stageMeans}`,
  ];
  if (venture.website)
    lines.push(`Website: ${venture.website}${venture.host ? ` (${venture.host})` : ""}`);
  if (venture.description) lines.push(`What it is: ${venture.description}`);
  lines.push(
    ``,
    `The stage is the owner's own declaration and it is what to tailor advice ` +
      `to. The description is the owner's words about it.`,
  );
  if (live)
    lines.push(
      `The whole record — including the colours and the icon measured from the ` +
        `site — is GET /api/skills/ventures.`,
    );

  return [{ role: "system", content: lines.join("\n") }, ...turns];
}

/* ------------------------------------------------------------------ shapes */

/** A stored message as the page reads it. The database's snake_case stays in
 *  the database; nulls stay null, because "not reported" is not zero. */
function shapeMessage(r: ChatMessageRow) {
  return {
    id: r.id,
    ts: r.ts,
    role: r.role,
    content: r.content,
    /* Widened from ChatBackendId, because an assistant row can also have been
       written by a PROVIDER asked directly — `provider:local` and the like.
       See chat/backend.ts for why that widening happens on the message rather
       than on the backend contract. */
    backend: r.backend as MessageBackendId | null,
    channel: r.channel,
    model: r.model,
    usage:
      r.prompt_tokens === null && r.completion_tokens === null
        ? null
        : { prompt: r.prompt_tokens ?? 0, completion: r.completion_tokens ?? 0 },
    ms: r.ms,
    /*
      THE TOOL CALLS, PARSED HERE RATHER THAN SHIPPED AS A STRING. The column
      is JSON this codebase wrote, so it parses — but "so it parses" is the
      assumption every JSON column in every project has made right up until a
      hand-edited row, and a transcript that throws a 500 because one message
      has a bad `tools` value is a whole conversation lost to one artefact of
      its rendering. Null on anything unreadable: the message is the point, the
      grey lines are decoration.
    */
    tools: readTools(r.tools),
    /* A boolean on the wire, because 0/1 is SQLite's way of spelling one and
       the browser should not have to know that. */
    partial: r.partial === 1,
  };
}

function readTools(raw: string | null): ChatToolCall[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ChatToolCall[]) : null;
  } catch {
    return null;
  }
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
  /*
    THE FOURTH FACT, ADDED WITH THE FALLBACK: what would answer if no agent
    does. It is deliberately NOT folded into `live` — `live` means "an agent is
    thinking", and a raw model is not one. A page that saw a green dot here and
    called it an agent would be promising tools and memory that are not there.
  */
  const provider = live === null ? activeProvider() : null;
  return {
    backends: backends().map((b) => ({
      ...b,
      /* The one that will actually be asked. At most one of these is true, by
         construction — that is the whole rule, made visible. */
      live: live !== null && live.id === b.id,
    })),
    chosen,
    /* Null when no AGENT will answer, and the page turns that into a sentence
       with a link to Integrations. The reason is spelled out so the page does
       not have to reverse-engineer it from the flags above. */
    live: live?.id ?? null,
    liveLabel: live?.label ?? null,
    /* Who takes the message when `live` is null. Null here as well means
       nothing at all will answer, which is the only state that refuses a
       message outright. */
    fallback: provider
      ? { provider: provider.id, label: provider.label, endpoints: provider.endpoints.length }
      : null,
    why:
      live !== null
        ? null
        : provider !== null
          ? `No agent is live, so messages go straight to ${provider.label} — a model with nothing in front of it: no tools, no memory beyond this transcript.`
          : chosen === null
            ? "No agent is chosen and no model provider is live. Pick Hermes or OpenClaw, or choose a provider under Models."
            : `${chosen} is chosen but not connected — its credentials are not in the vault yet, and no model provider is live either.`,
  };
}

/**
 * THE BODY BOTH SEND ROUTES TAKE, VALIDATED ONCE.
 *
 * `POST /chat` and `POST /chat/stream` are two shapes of ANSWER and exactly
 * one shape of REQUEST, and the refusals have to agree: a message that is too
 * long must be too long on both, with the same sentence and the same status,
 * or the streaming page and the Telegram bridge disagree about what is
 * sendable. Written out twice they would drift the first time one of them
 * grew a field.
 */
type SendBody =
  | {
      ok: true;
      sessionId: string;
      message: string;
      channel: "web" | "telegram";
      /** Which venture the page had open when this was typed, or null. NOT
       *  validated against the table here — an id that names nothing is
       *  ignored downstream rather than refused, because a client holding a
       *  venture somebody deleted in another tab has a stale list, not a bad
       *  request, and refusing its message would be losing the message. */
      ventureId: string | null;
    }
  | { ok: false; status: 400 | 413; error: string };

async function readSendBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<SendBody> {
  const body = (await c.req.json().catch(() => null)) as {
    sessionId?: string;
    message?: string;
    channel?: string;
    ventureId?: string;
  } | null;

  const sessionId = (body?.sessionId ?? "").trim();
  const message = body?.message ?? "";
  if (!sessionId) return { ok: false, status: 400, error: "A sessionId is required." };
  if (typeof message !== "string" || !message.trim())
    return { ok: false, status: 400, error: "There is no message to send." };
  if (message.length > MAX_MESSAGE)
    return {
      ok: false,
      status: 413,
      error:
        `That message is ${message.length.toLocaleString()} characters. The ` +
        `limit here is ${MAX_MESSAGE.toLocaleString()} — anything larger is a ` +
        `file rather than a message, and the agent would refuse it after a ` +
        `long wait and a token bill.`,
    };
  const ventureId = (body?.ventureId ?? "").trim();
  return {
    ok: true,
    sessionId,
    message,
    channel: body?.channel === "telegram" ? "telegram" : "web",
    ventureId: ventureId || null,
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

/**
 * EVERY CONVERSATION THAT HAS WORDS IN IT.
 *
 * This is the route that makes the rail honest. Until now the session list was
 * entirely the browser's: twelve seeded titles in localStorage that named no
 * conversation, beside a `chat_messages` table full of conversations that were
 * named by nothing. The page could open a chat it had never had and show an
 * empty transcript for one it had.
 *
 * SO WHO OWNS A SESSION NOW? Both, and the split is the same one 016_chat drew
 * and this route does not move: the SERVER owns the messages, the CLIENT owns
 * the list. There is still no `chat_sessions` table — see the comment on
 * `chatSessionSummaries` in db.ts for the argument, which is that a rename
 * would immediately give one name two authorities. What this answers is the
 * question only the server can: which ids have messages, how many, and when.
 * The page reconciles its list against that — new ids get added with the title
 * derived here, ids it has that the server has never heard of stay as empty
 * drafts, and a name the owner typed always wins over this one.
 *
 * TELEGRAM'S CONVERSATIONS ARE IN HERE TOO, and that is deliberate rather than
 * an oversight. `telegram:<chat id>` sessions are real transcripts with the
 * same agent, and hiding them from the page would rebuild the exact thing the
 * shared table exists to prevent: one agent with amnesia on whichever door you
 * did not come in through. `channels` says which door each came by, so the
 * page can label them rather than pretend they started here.
 */
chat.get("/sessions", (c) => {
  const sessions = chatSessionSummaries();
  return c.json({
    sessions,
    /* The count is the server's own, not `sessions.length` read by the client
       after a filter — a page that shows fewer rows than exist should be able
       to tell that it is doing so. */
    total: sessions.length,
  });
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
  const body = await readSendBody(c);
  if (!body.ok) return c.json({ error: body.error }, body.status);
  const { sessionId, message, channel, ventureId } = body;

  /*
    WHO IS GOING TO ANSWER — AND THE FALLBACK, WHICH IS THE ONE REAL ADDITION
    TO THIS ROUTE SINCE IT WAS WRITTEN.

    An AGENT (Hermes, OpenClaw) thinks: tools, memory, multi-step work. A
    PROVIDER (a local model, OpenAI, OpenRouter, FreeLLMAPI) completes: turns
    in, text out. Until now a message with no agent live was refused with a
    503, which was right when a provider was not a thing this server had. It is
    now, and refusing while a perfectly good model sits connected two settings
    away is refusing for the sake of an architecture diagram.

    SO THE ORDER IS AGENT FIRST, ALWAYS, AND A PROVIDER SECOND. An agent that
    is live is what the owner chose and is strictly more capable; falling
    through to a raw model while one was running would be answering a question
    with the worse of two available answers. The fallback is only ever reached
    when `activeBackend()` is null.

    AND THE ANSWER SAYS WHICH IT WAS. The assistant row is stamped
    `provider:<id>` rather than with an agent id, so a transcript read six
    weeks later does not attribute a bare completion to Hermes. That is the
    same rule the two agents already keep about each other, extended one layer
    down.

    REFUSED BEFORE THE MESSAGE IS STORED, and only when NEITHER will answer.
    Nothing is live, so there is no conversation for this question to be part
    of — writing it down would leave a user turn in the transcript that nothing
    ever saw and that a later, successful turn would silently answer out of
    order.
  */
  const live = activeBackend();
  const fallback = live ? null : activeProvider();
  if (!live && !fallback) {
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
  /* The transcript, with the venture the page was on in front of it when there
     was one. Built once and used on BOTH paths below — the agent's and the
     provider fallback's — because a question about a business must not get a
     different answer depending on which of them happened to be live. */
  const turns: ChatTurn[] = withVenture(
    history.map((m) => ({ role: m.role, content: m.content })),
    ventureId,
    live,
  );

  try {
    /*
      ONE SHAPE OUT OF TWO PATHS. `ask()` and `complete()` return different
      objects — one names an agent, the other a provider and the endpoint it
      landed on — and they are flattened here rather than downstream, so
      everything below this line (the row, the response, the Telegram bridge's
      reading of it) is written once and cannot drift between the two.
    */
    const reply: {
      text: string;
      backend: MessageBackendId;
      model: string | null;
      usage: { prompt: number; completion: number } | null;
      ms: number;
    } = live
      ? await ask(withSkills(turns, live), {
          sessionId,
          channel,
          /* The client's own signal. A closed tab or a cancelled fetch ends the
             outbound call rather than leaving it running for an answer nobody is
             waiting for. */
          signal: c.req.raw.signal,
        })
      : await (async () => {
          /*
            Through `complete()`, which is the ONLY path a completion takes —
            so this message queues behind the provider's policy exactly as an
            agent's would. A chat that jumped the limiter would be the one
            caller able to put two completions on a single GPU at once.
          */
          const r = await complete(turns, { signal: c.req.raw.signal });
          noteOutcome(r.provider, r.endpoint, null);
          return {
            text: r.text,
            backend: `provider:${r.provider}` as MessageBackendId,
            model: r.model,
            usage: r.usage,
            ms: r.ms,
          };
        })();

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
      because only they know which of a plugin's accounts answered — and for a
      provider that is `noteOutcome`, which knows the same thing one layer
      down.
    */
    if (live?.id === "hermes") hermes.noteFailure(message);
    else if (live?.id === "openclaw") openclaw.noteFailure(message);
    else if (fallback) noteOutcome(fallback.id, null, message);

    console.error(`[chat] ${live?.id ?? `provider:${fallback?.id}`} failed — ${message}`);

    /*
      502 rather than 500: this process is fine, the thing it called is not,
      and the difference tells the owner whether to look at this app or at
      their gateway. A timeout keeps its own 504 for the same reason.
    */
    const status = err instanceof WireError && err.status === 504 ? 504 : 502;
    return c.json(
      {
        error: message,
        backend: live ? live.id : (`provider:${fallback!.id}` as MessageBackendId),
        user: shapeMessage(stored),
      },
      status,
    );
  }
});

/* ---------------------------------------------------------------- streaming */

/**
 * Say something, and watch it being written.
 *
 * THE EVENT CONTRACT, IN FULL, because a stream with an undocumented shape is
 * a stream nobody can write a second client for. Every event is an SSE frame
 * with a name and a JSON body:
 *
 *   start      { sessionId, userMessageId, user, backend, backendLabel, model }
 *              Once, after the owner's turn is in the table. `model` is null
 *              here and not omitted: the model is what the SERVER reports
 *              having used and it is not known until it says so, which is a
 *              fact rather than a gap in the protocol.
 *   delta      { text }        a piece of the answer, in order
 *   reasoning  { text }        a piece of the model's working, if it shows any
 *   tool       { toolCallId, tool, label, emoji, status, at, offset }
 *              A tool starting or finishing. `offset` is how much of the
 *              answer had been written when it happened — see below.
 *   done       { messageId, message, text, model, usage, ms, tools }
 *              Once, and only after the assistant row is in the table.
 *   error      { message, messageId, partial }
 *              The turn failed. `messageId` is the PARTIAL row if there was
 *              anything to keep, and null if the agent had said nothing at
 *              all — the distinction the page needs to decide whether the
 *              words on screen are now durable or were never real.
 *
 * EXACTLY ONE OF `done` AND `error` IS SENT, and both are sent AFTER the write
 * they describe. A client that has seen either one can reload and find the
 * same words; a client that has seen neither knows the connection died before
 * the server made up its mind, and reloading is how it finds out which.
 *
 * WHY `offset` IS ON THE TOOL EVENT. The grey line belongs where it happened —
 * between the paragraph the agent wrote before it ran the tool and the one it
 * wrote after. Live, that is free: the events arrive in order. On RELOAD it is
 * not, because the stored message is one string and an array of calls, and
 * without a position every tool line piles up at the end and the transcript
 * tells a different story than the one that was watched. The offset is a
 * character count into `text`, which is stable under nothing except the exact
 * string it was measured against — and that string is stored beside it in the
 * same row, so it cannot drift.
 *
 * AN ABORTED STREAM STILL WRITES. The client's `AbortSignal` is passed down to
 * the agent call, so a closed tab stops the outbound turn — but the words
 * already streamed are words the owner read, and the write happens in a
 * `finally` that does not care whether anybody is still listening. This is the
 * one place in the file where the database write matters more than the
 * response.
 */
chat.post("/stream", async (c) => {
  const body = await readSendBody(c);
  if (!body.ok) return c.json({ error: body.error }, body.status);
  const { sessionId, message, channel, ventureId } = body;

  /*
    REFUSED AS A PLAIN HTTP ERROR, BEFORE THE STREAM OPENS. A 503 with a
    sentence is something every client already handles; the same refusal
    delivered as an `error` event inside a 200 would make "no agent is
    connected" indistinguishable, at the status line, from a successful
    conversation. The stream is for things that go wrong AFTER the agent has
    been reached.
  */
  const live = activeBackend();
  const fallback = live ? null : activeProvider();
  if (!live && !fallback)
    return c.json({ error: new NoBackendError().message, ...backendState() }, 503);

  /* Same order of writes as the non-streaming route, for the same reason: a
     turn that falls over still leaves the question in the transcript. */
  const stored = appendChatMessage({ sessionId, role: "user", content: message, channel });
  const history = chatMessages(sessionId, CONTEXT_TURNS);
  /* Same as the non-streaming route, for the same reason. */
  const turns: ChatTurn[] = withVenture(
    history.map((m) => ({ role: m.role, content: m.content })),
    ventureId,
    live,
  );

  const backendId: MessageBackendId = live
    ? live.id
    : (`provider:${fallback!.id}` as MessageBackendId);
  const label = live ? live.label : (fallback?.label ?? null);

  return streamSSE(c, async (sse) => {
    /*
      EVERY WRITE IS ALLOWED TO FAIL SILENTLY. Once the browser has gone,
      writing to the stream throws — and the interesting work left in this
      handler is the database write, which must not be skipped because nobody
      is listening. Swallowing here rather than wrapping each call site keeps
      that decision in one place with the reason attached.
    */
    const say = async (event: string, data: unknown) => {
      try {
        await sse.writeSSE({ event, data: JSON.stringify(data) });
      } catch {
        /* the reader is gone; the row still gets written below */
      }
    };

    await say("start", {
      sessionId,
      userMessageId: stored.id,
      user: shapeMessage(stored),
      backend: backendId,
      backendLabel: label,
      model: null,
    });

    /* What has been said so far, and what was done while saying it. Both are
       read by the `finally`, which is why they live out here rather than in
       the loop. */
    let text = "";
    /* Keyed by toolCallId so `completed` finds the record `running` made.
       A Map because insertion order IS the order they happened, and that is
       the order the page draws them in. */
    const tools = new Map<string, ChatToolCall>();
    let model: string | null = null;
    let usage: { prompt: number; completion: number } | null = null;
    let ms = 0;
    let finished = false;
    let queuedMs: number | null = null;
    let failure: string | null = null;

    /**
     * THE BACKEND THAT CANNOT STREAM, MADE TO LOOK LIKE ONE THAT CAN.
     *
     * `stream()` is optional on `ChatBackend`, and the provider fallback has
     * no streaming path at all — `models/provider.ts` owns the limiter and is
     * not this feature's to rewrite. Both are served by asking once and
     * emitting the answer as a single `delta` followed by `done`. The words
     * arrive in one lump instead of one at a time, and every other part of the
     * contract — the row, the events, the partial handling — is identical, so
     * the page needs no second code path for it.
     */
    async function* oneShot(): AsyncGenerator<ChatStreamEvent> {
      const reply = live
        ? await ask(withSkills(turns, live), { sessionId, channel, signal: c.req.raw.signal })
        : await (async () => {
            const r = await complete(turns, { signal: c.req.raw.signal });
            noteOutcome(r.provider, r.endpoint, null);
            return { text: r.text, model: r.model, usage: r.usage, ms: r.ms, queuedMs: r.queuedMs };
          })();
      yield { type: "delta", text: reply.text };
      yield {
        type: "done",
        text: reply.text,
        model: reply.model,
        usage: reply.usage,
        ms: reply.ms,
        // An agent's turn never queues here — Hermes owns its own concurrency
        // and reports nothing — so only the provider path carries a number.
        queuedMs: "queuedMs" in reply ? (reply.queuedMs ?? null) : null,
      };
    }

    const events: AsyncGenerator<ChatStreamEvent> = live?.stream
      ? live.stream(withSkills(turns, live), { sessionId, channel, signal: c.req.raw.signal })
      : oneShot();

    try {
      for await (const event of events) {
        switch (event.type) {
          case "delta":
            text += event.text;
            await say("delta", { text: event.text });
            break;

          case "reasoning":
            await say("reasoning", { text: event.text });
            break;

          case "tool": {
            /*
              MERGED ON THE WAY THROUGH, not on the way out. The wire carries
              two events per call and the table stores one record with two
              timestamps — so `running` creates the record and `completed`
              closes it. A `completed` for a call that was never announced
              still creates one, with `startedAt` equal to `finishedAt`: a
              tool that finished is a thing that happened, and dropping it
              because the first half of the pair went missing would lose a
              fact to a wire glitch.
            */
            const existing = tools.get(event.toolCallId);
            if (existing) {
              if (event.status === "completed") existing.finishedAt = event.at;
              if (!existing.label && event.label) existing.label = event.label;
              if (!existing.emoji && event.emoji) existing.emoji = event.emoji;
            } else {
              tools.set(event.toolCallId, {
                toolCallId: event.toolCallId,
                tool: event.tool,
                label: event.label,
                emoji: event.emoji,
                startedAt: event.at,
                finishedAt: event.status === "completed" ? event.at : null,
                /* Where in the answer this happened. See the header. */
                offset: text.length,
              });
            }
            await say("tool", {
              toolCallId: event.toolCallId,
              tool: event.tool,
              label: event.label,
              emoji: event.emoji,
              status: event.status,
              at: event.at,
              offset: tools.get(event.toolCallId)!.offset,
            });
            break;
          }

          case "done": {
            queuedMs = event.queuedMs ?? null;
            /*
              `event.text` and not the accumulated `text`. The adapter counted
              the answer as it read it and may have applied a rule this loop
              cannot see — Hermes falls back to the model's reasoning when the
              content came back empty, which is a whole answer that arrived as
              no deltas at all. Trusting the accumulator here would store an
              empty message for exactly the turn where the fallback mattered.
            */
            text = event.text;
            model = event.model;
            usage = event.usage;
            ms = event.ms;
            finished = true;
            break;
          }
        }
      }
    } catch (err) {
      failure =
        err instanceof WireError
          ? err.message
          : err instanceof NoBackendError
            ? err.message
            : err instanceof Error
              ? err.message
              : "The agent stopped for a reason it did not give.";

      /* Against the account that failed, so Integrations shows a red line on
         the credential that stopped working — the same rule the non-streaming
         route keeps, and the adapters still know which account answered. */
      if (live?.id === "hermes") hermes.noteFailure(failure);
      else if (live?.id === "openclaw") openclaw.noteFailure(failure);
      else if (fallback) noteOutcome(fallback.id, null, failure);
      console.error(`[chat/stream] ${backendId} failed — ${failure}`);
    }

    /*
      THE WRITE, AND IT HAPPENS ON EVERY PATH THAT PRODUCED WORDS.

      Three outcomes and each has one row, or none:
        finished              a complete assistant row
        failed, text so far   the same row with partial = 1
        failed, nothing said  no row at all
      The third is the non-streaming route's rule, unchanged: a failed turn
      writes no "error" message, because a transcript is what was SAID and an
      error is something the interface reports. What is new is the second — the
      case where the agent DID say something before it fell over, which the old
      route could never be in, and where dropping the words would delete
      something the owner watched arrive.
    */
    const list = [...tools.values()];
    let messageId: number | null = null;
    if (finished || text) {
      const assistant = appendChatMessage({
        sessionId,
        role: "assistant",
        content: text,
        channel,
        backend: backendId,
        model,
        promptTokens: usage?.prompt ?? null,
        completionTokens: usage?.completion ?? null,
        /* Null rather than 0 on a failed turn: a stream that broke has not
           told us how long the answer took, only how long we waited. */
        ms: finished ? ms : null,
        tools: list,
        partial: !finished,
      });
      messageId = assistant.id;

      if (finished)
        await say("done", {
          messageId: assistant.id,
          /* The stored row itself, so the page swaps in what the database has
             rather than keeping its own reconstruction of it. Two copies of
             one message is how a transcript starts disagreeing with itself
             across a reload. */
          message: shapeMessage(assistant),
          text,
          model,
          usage,
          ms,
          tools: list,
          queuedMs,
        });
    }

    if (!finished)
      await say("error", {
        message: failure ?? "The stream ended without an answer.",
        messageId,
        /* Whether anything was kept. The page draws the bubble it already has
           as a partial answer when this is true, and drops it when it is not —
           because in that case nothing was ever stored and leaving it on
           screen would promise a durability the transcript does not have. */
        partial: messageId !== null,
      });
  });
});
