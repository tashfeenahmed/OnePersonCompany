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
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  appendChatMessage,
  chatMessages,
  chatSessionSummaries,
  deleteChatSession,
  type ChatMessageRow,
  type ChatToolCall, ventureRows } from "../db.ts";
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
import { track } from "../chat/inflight.ts";
/*
  THE RUN ENGINE. A chat turn is the server's work now rather than the
  browser's — see chat/runs.ts for the whole argument. This file composes the
  turn and subscribes to it; it no longer reads the agent's events itself.
*/
import {
  RunBusyError,
  sessionBusy,
  answeringSessions,
  cancelChatRun,
  runHandle,
  sessionRunState,
  startChatRun,
} from "../chat/runs.ts";
import { chatRun as chatRunRow, deleteChatRuns } from "../integrations/agentcore/store.ts";
import * as hermes from "../providers/hermes.ts";
import * as openclaw from "../providers/openclaw.ts";
/*
  THE LAYER BELOW THE AGENTS, reached only when no agent is live. See the
  fallback in the POST handler for the argument; the import is here rather than
  inside it because a dynamic import in a request path is a first-call latency
  spike bought to hide a dependency that is real.
*/
import { activeProvider } from "../models/provider.ts";
/*
  THE BOUNDED TOOL LOOP FOR A DIRECT PROVIDER. It replaces the bare
  `complete()` on both fallback paths below and decides for itself whether this
  turn gets tools or the text-only completion this route has always made — see
  integrations/runtime/loop.ts for the bounds and the argument.
*/
import { directReply, directTurn } from "../integrations/runtime/loop.ts";
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

/*
  WHO WORKS FOR THE OWNER, and what has been filed under this conversation.
  Imported from the org area rather than queried here, on the same rule the
  line above keeps: the prose about a team, and the address of the page a run
  is read at, have exactly one author, and it is the file that owns them.
*/
import { childrenBySession, ventureTeamLines } from "../integrations/subagents/store.ts";
import { goalLines } from "../integrations/chief/goals.ts";
import { ROUNDS_SESSION } from "../integrations/chief/rounds.ts";
import { memoryLines } from "../integrations/chief/memory.ts";
import { knowledgeLines } from "../integrations/knowledge/store.ts";

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
  /*
    NO VENTURE SELECTED IS NOT NO VENTURES. The conversation that asked for
    "academic research for overbrilliant" had none selected, and the agent —
    which knew nothing of the owner's businesses beyond a pack called
    `ventures` it had not opened — asked what Overbrilliant was. So an
    unscoped conversation with a live agent gets the roster: one line per
    venture, name, slug and stage, which is twenty short lines and is what
    makes a business's name a word the agent recognises. The full record of
    any of them is one `opc ventures one --key <slug>` away, and the line says
    so in the words the agent can act on.
  */
  if (!ventureId) {
    if (!live) return turns;
    const rows = ventureRows();
    if (!rows.length) return turns;
    const managed = readMode(live.id) === "managed";
    const lines = [
      `The owner's ventures — name (slug) · stage — in the owner's order. A name ` +
        `in a question is one of these until proven otherwise:`,
      ...rows.map((r) => `- ${r.name} (${r.slug}) · ${r.stage}${r.host ? ` · ${r.host}` : ""}`),
      ``,
      managed
        ? `One venture in full is \`opc ventures one --key <slug>\`; its sub-agents ` +
          `and how to dispatch one are \`opc help subagents\`.`
        : `One venture in full is GET /api/skills/ventures?view=one&key=<slug>; its ` +
          `sub-agents are GET /api/skills/subagents.`,
    ];
    return [{ role: "system", content: lines.join("\n") }, ...turns];
  }
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
        `site — is ` +
        (readMode(live.id) === "managed"
          ? `\`opc ventures one --key ${venture.slug}\`.`
          : `GET /api/skills/ventures?view=one&key=${venture.slug}.`),
    );

  return [{ role: "system", content: lines.join("\n") }, ...turns];
}

/**
 * TELL THE CHIEF OF STAFF WHO IT CAN SEND, AND WHERE THE WORK WILL LAND.
 *
 * The chat agent is the Chief of Staff of this business: below it are the
 * ventures, and below each of those are six named workers that do the six kinds
 * of long run. It can dispatch one through the `subagents` skill — but two
 * facts it needs to do that well are not in any document it can fetch.
 *
 * THE FIRST IS THIS CONVERSATION'S OWN ID, which is a thing only the request
 * knows. Passed as `parentSessionId`, it files the run under this chat in the
 * owner's rail, so the answer to "what came of that?" is one click below the
 * question. Without it the run still happens and appears nowhere near the
 * conversation that asked for it.
 *
 * THE SECOND IS THE TEAM'S NAMES, when the chat is filed under a venture. An
 * agent that has been told "Example App 1 Researcher, Example App 1 SEO Analyst, …" can
 * answer "ask the SEO analyst to look at pricing" directly; one that has not
 * must first fetch the org to discover that such a worker exists, and the
 * failure mode of that is not a slower answer, it is advice instead of work.
 *
 * THE TWO HALVES HAVE DIFFERENT AUDIENCES, which is why they are one function
 * with two conditions rather than two functions. The dispatch sentence is an
 * INSTRUCTION ABOUT A TOOL and goes only where a tool exists — a live agent,
 * managed or remote. The provider fallback is a raw model with no way to call
 * anything, and telling it to pass a parameter on a call it cannot make is the
 * exact failure `withSkills` is written at length about. The team is not a
 * tool, it is a fact about the business, so it goes to everybody: a raw model
 * that knows the owner has an SEO analyst for this venture gives better advice
 * about who should do a thing, even though it cannot ask them itself.
 *
 * NOT STORED, and prepended, on the rule the other two turns keep: it is
 * context for one call rather than something anybody said.
 */
/**
 * THE WHOLE CONTEXT, IN ONE CALL, FOR EVERY SURFACE. The web routes below
 * compose it inline; the Telegram bridge asked the agent with the bare
 * history and nothing else, which is how a question about a venture from a
 * phone got an agent that had never heard of the venture. One function, so a
 * surface that asks the agent gets the same agent.
 */
export function composeTurns(
  history: ChatTurn[],
  sessionId: string,
  ventureId: string | null,
  live: ChatBackend | null,
): ChatTurn[] {
  return withSkills(
    withBudget(
      withOrg(withGoals(withVenture(history, ventureId, live), ventureId), sessionId, ventureId, live),
      live,
    ),
    live,
  );
}

/**
 * HOW TO READ A DOCUMENT THAT DID NOT FIT.
 *
 * Six lines, and every one of them is about the same failure. Skill answers
 * are now bounded (integrations/agentcore/bound.ts): a document over the
 * budget keeps its scalars and loses rows, and each shortened list ends with a
 * marker carrying the REAL total. An agent that has not been told this reads
 * the marker as data and reports the number of rows it was shown as the number
 * that exist — "you have 20 cards" when there are 412 — which is a worse
 * failure than the truncation it replaced, because it is confident.
 *
 * IT GOES ONLY WHERE THERE ARE TOOLS. A raw provider with no way to call
 * anything would be reading instructions about parameters it cannot pass; a
 * live agent, managed or remote, meets these markers on its next tool call.
 * Not stored, and prepended, on the rule every turn here keeps.
 */
function withBudget(turns: ChatTurn[], live: ChatBackend | null): ChatTurn[] {
  if (!live) return turns;
  return [
    {
      role: "system",
      content: [
        `Tool answers are capped. A list that did not fit ends with`,
        `{"truncated":true,"shown":N,"total":T} — T is the real total: report T, never N. A "_omitted"`,
        `count means fields were dropped from the end of that object as well.`,
        `To see more: pass limit/offset where the view lists them, narrow the window (fewer days, one`,
        `venture), or pass fields=<comma-separated top-level keys>. "_bounded".next names which applies.`,
        `Nothing is ever cut mid-value, so a document that parses is complete as far as it goes.`,
      ].join("\n"),
    },
    ...turns,
  ];
}

/**
 * WHAT THE OWNER IS TRYING TO DO, AND WHAT YOU ALREADY KNOW ABOUT THEM.
 *
 * ONE TURN FOR BOTH, and that is not laziness. Goals and memory are the same
 * KIND of thing — standing context that is true before the question is asked —
 * and a model reading two adjacent system turns treats the second as a
 * correction of the first. They are also the two documents that make every
 * other answer on this box mean something: without the goals, "traffic is down
 * 12%" is a fact with no significance; without the memory, the assistant meets
 * the owner again every morning.
 *
 * IT GOES TO EVERYBODY, including the raw provider fallback, on `withVenture`'s
 * argument rather than `withSkills`'s. This is not an instruction about a tool
 * that some backends do not have — it is the SUBJECT. A model with no tools at
 * all gives better advice for knowing that the owner has said this quarter is
 * about revenue, and it can act on that without fetching anything.
 *
 * BOTH HALVES ARE CAPPED AND BOTH ARE SILENT WHEN EMPTY. The goals are two
 * short documents at most; the memory is the newest thirty relevant notes with
 * the remainder counted rather than hidden. A fresh install has neither, and
 * then this function adds nothing at all — a turn saying "the owner has written
 * no goals" would be an instruction to go and ask for some.
 *
 * NOT STORED, and prepended, on the rule every turn here keeps: it is context
 * for one call rather than something anybody said, and a transcript read six
 * weeks later must not have a paragraph in it the owner never typed.
 */
function withGoals(turns: ChatTurn[], ventureId: string | null): ChatTurn[] {
  const lines = [...goalLines(ventureId)];
  const memory = memoryLines(ventureId);
  if (memory.length) lines.push(...(lines.length ? [``] : []), ...memory);
  /* THE THIRD DOCUMENT OF THE SAME KIND, added here rather than as a turn of
     its own for this function's own reason: goals, memory and product
     knowledge are all standing context that is true before the question is
     asked, and a model reading three adjacent system turns treats each as a
     correction of the one before. It is at most 25 lines, venture-scoped, and
     silent when nothing is known — and it deliberately carries no unconfirmed
     proposals; see integrations/knowledge/store.ts. */
  const known = knowledgeLines(ventureId);
  if (known.length) lines.push(...(lines.length ? [``] : []), ...known);
  if (!lines.length) return turns;
  return [{ role: "system", content: lines.join("\n") }, ...turns];
}

/** Sessions written by the server rather than opened by the owner. */
const SYSTEM_SESSION_NAMES: Record<string, string> = { briefing: "Briefing", autopilot: "Autopilot" };

function withOrg(
  turns: ChatTurn[],
  sessionId: string,
  ventureId: string | null,
  live: ChatBackend | null,
): ChatTurn[] {
  const lines: string[] = [];
  if (live)
    lines.push(
      `This conversation's id is \`${sessionId}\`; when you dispatch a sub-agent ` +
        `pass it as parentSessionId so the work is filed under this chat.`,
    );

  const team = ventureId ? ventureTeamLines(ventureId) : null;
  if (team) {
    lines.push(``, `The sub-agents on this venture, one per kind of work:`, ...team);
    lines.push(
      ``,
      `Each is a worker you can give a job to by venture and role. Dispatching ` +
        `one queues minutes of real work and answers with no report — say that ` +
        `it has been dispatched, and read what it wrote later.`,
    );
  }

  /* Nothing to say is nothing said. An empty system turn would cost a message
     and read as an instruction that was cut off. */
  if (!lines.length) return turns;
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
  /*
    WHAT WAS DISPATCHED FROM EACH CONVERSATION, nested under it.

    A run started by the Chief of Staff on this chat's behalf is not another
    conversation and must not be listed as one — it is a piece of work this
    conversation produced, which is exactly the shape the rail was already
    drawn for. So it arrives as a CHILD, with the page it is read at (`to`)
    written down here rather than composed by the client from the kind: a rail
    that guessed would send `geo` runs to a page that does not exist.

    Read in ONE statement for every session rather than one per session — see
    `childrenBySession` — because the rail asks for this list on a poll and a
    query per transcript would make that cost grow with the archive.
  */
  const children = childrenBySession();
  return c.json({
    /*
      ONE SESSION HAS A NAME THAT NO TRANSCRIPT COULD DERIVE. `chatSessionSummaries`
      titles a conversation with the first thing the OWNER said in it, which is the
      only honest candidate — except for the scheduled rounds, which nobody opened
      and nobody typed into. Its title would be null for ever and the rail would
      draw the estate's own nightly work as "Untitled chat". So the one machine-made
      conversation gets the one machine-made name, here rather than in db.ts: the
      derivation there is about rows and this is about a feature.
    */
    sessions: sessions.map((s) => ({
      ...s,
      /* The system sessions — rounds, the briefing, the autopilot — have no
         first user message to be named after, so they carry their own names. */
      title: s.sessionId === ROUNDS_SESSION ? s.title ?? "Rounds" : (SYSTEM_SESSION_NAMES[s.sessionId] ?? s.title),
      children: children.get(s.sessionId) ?? [],
    })),
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
    /*
      AND WHETHER THIS CONVERSATION IS STILL BEING ANSWERED, in the same fetch.

      A page that has just opened a chat has exactly two questions and they are
      asked at the same instant: what was said, and is something still arriving.
      Answering the second in a separate request would mean a reload paints the
      stored transcript first and then, a round trip later, discovers there is a
      live answer to reattach to — which is a visible flicker between "cut off"
      and "still writing" for every reload made mid-turn. `run` is null when
      this conversation has never been answered by a run; `attachable` says
      whether GET /chat/runs/<id>/events still has the frames.
    */
    run: sessionRunState(sessionId),
    ...backendState(),
  });
});

/** Forget one conversation. Scoped to a single session id by the route shape
 *  itself: there is no way to spell "all of them" here. */
chat.delete("/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  /* THE RUNS GO WITH THE TRANSCRIPT. `chat_runs` has no foreign key to cascade
     from — there is no `chat_sessions` table for one to point at — so a
     forgotten conversation would otherwise keep answering `latestChatRun`, and
     a page opening a recycled id would be told there is an answer waiting for
     it. Deleted here rather than in db.ts, so that file keeps knowing nothing
     about this area's table. */
  return c.json({
    sessionId,
    deleted: deleteChatSession(sessionId),
    runs: deleteChatRuns(sessionId),
  });
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

  /*
    ONE TURN PER CONVERSATION HERE TOO, AND THE RULE WAS HALF-KEPT WITHOUT IT.

    The streaming door refuses a second question on a transcript already being
    answered; this one did not, so a phone and a browser on the same session
    wrote two assistant rows for a history that had contained one question, each
    answering a version of the conversation the other had not seen.
    `sessionBusy` knows about both doors — the runs, and the sessions
    chat/inflight.ts has registered for the length of an `ask()` — which is what
    makes the invariant true rather than merely stated.

    REFUSED BEFORE THE MESSAGE IS STORED. The question is not lost: nothing was
    written, and the caller has a sentence saying to wait or to stop the answer
    that is already being written.
  */
  const busy = sessionBusy(sessionId);
  if (busy.busy)
    return c.json(
      { error: new RunBusyError(busy.runId ?? "").message, runId: busy.runId, ...backendState() },
      409,
    );

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
  const turns: ChatTurn[] = withBudget(
    withOrg(
      withGoals(
        withVenture(
          history.map((m) => ({ role: m.role, content: m.content })),
          ventureId,
          live,
        ),
        ventureId,
      ),
      sessionId,
      ventureId,
      live,
    ),
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
            Through `directReply()`, which runs the same turn the streaming
            route runs and hands back only what it ended with. Underneath it is
            still `complete()` — the ONLY path a completion takes, so this
            message queues behind the provider's policy exactly as an agent's
            would — plus the bounded tool loop when the chosen model has been
            measured to support one. This route's second caller is the Telegram
            bridge, and a question asked from a phone is the same question:
            giving the streaming page tools and the phone none would be two
            different agents behind one door.
          */
          const r = await directReply(turns, {
            signal: c.req.raw.signal,
            ventureId,
            onOutcome: (provider, endpoint) => noteOutcome(provider, endpoint, null),
          });
          return {
            text: r.text,
            backend: `provider:${fallback!.id}` as MessageBackendId,
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
 * THE TURN IS A RUN NOW, AND THAT IS THE ONE CHANGE TO THIS ROUTE. What used
 * to happen inside the response handler — read the agent's events, merge the
 * tool calls, write the assistant row — happens in `chat/runs.ts`, owned by
 * the process and keyed by a run id. This route composes the turn, starts the
 * run, and then does the only thing it was ever uniquely able to do:
 * SUBSCRIBE to it. Closing the tab now unsubscribes rather than cancelling,
 * and `GET /chat/runs/:id/events?since=` is how the next page attaches to the
 * same answer. The old header's paragraph — "a reload cannot re-attach" — was
 * true and is not any more; see chat/runs.ts for the argument.
 *
 * THE EVENT CONTRACT, IN FULL, because a stream with an undocumented shape is
 * a stream nobody can write a second client for. Every event is an SSE frame
 * with a name, a JSON body, and an `id` that is its sequence number:
 *
 *   run        { runId, sessionId, status }
 *              First, always, on both doors. It is how a client that has just
 *              reattached learns whether there is anything still arriving.
 *   start      { sessionId, userMessageId, user, backend, backendLabel, model,
 *                runId }
 *              Once, after the owner's turn is in the table. `model` is null
 *              here and not omitted: the model is what the SERVER reports
 *              having used and it is not known until it says so, which is a
 *              fact rather than a gap in the protocol.
 *   delta      { text }        a piece of the answer, in order
 *   reasoning  { text }        a piece of the model's working, if it shows any
 *   child      { runId, kind, title, status }
 *              A sub-agent was filed under this conversation mid-answer.
 *   tool       { toolCallId, tool, label, emoji, status, at, offset }
 *              A tool starting or finishing. `offset` is how much of the
 *              answer had been written when it happened — see below.
 *   done       { messageId, message, text, model, usage, ms, tools, queuedMs }
 *              Once, and only after the assistant row is in the table.
 *   error      { message, messageId, partial, cancelled }
 *              The turn ended without an answer. `messageId` is the PARTIAL
 *              row if there was anything to keep, and null if the agent had
 *              said nothing at all. `cancelled` is true when the owner pressed
 *              stop, which is not a failure and must not be drawn as one.
 *
 * EXACTLY ONE OF `done` AND `error` IS SENT, and both are sent AFTER the write
 * they describe. A client that has seen either one can reload and find the
 * same words; a client that has seen neither knows the connection died before
 * the run made up its mind, and reattaching is how it finds out which.
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

  /*
    ONE TURN PER CONVERSATION, REFUSED BEFORE THE MESSAGE IS STORED. Two runs
    on one transcript would read the same history, answer it twice and write
    two assistant rows interleaved with each other — and the second question
    would have been asked of a conversation that did not yet contain the first
    answer. The page already prevents this; a second tab, or a retry after a
    network blip, does not.
  */
  const already = sessionBusy(sessionId);
  if (already.busy)
    return c.json(
      {
        error: new RunBusyError(already.runId ?? "").message,
        runId: already.runId,
        /* Where to watch the answer it is already writing, so a client that
           lost its connection has somewhere to go rather than a refusal. There
           is no stream to offer when the other door is the non-streaming one. */
        events: already.runId ? `/api/chat/runs/${already.runId}/events` : null,
      },
      409,
    );

  /* Same order of writes as the non-streaming route, for the same reason: a
     turn that falls over still leaves the question in the transcript. */
  const stored = appendChatMessage({ sessionId, role: "user", content: message, channel });
  const history = chatMessages(sessionId, CONTEXT_TURNS);
  /* Same as the non-streaming route, for the same reason. */
  const turns: ChatTurn[] = withBudget(
    withOrg(
      withGoals(
        withVenture(
          history.map((m) => ({ role: m.role, content: m.content })),
          ventureId,
          live,
        ),
        ventureId,
      ),
      sessionId,
      ventureId,
      live,
    ),
    live,
  );

  const backendId: MessageBackendId = live
    ? live.id
    : (`provider:${fallback!.id}` as MessageBackendId);
  const label = live ? live.label : (fallback?.label ?? null);

  /**
   * THE BACKEND THAT CANNOT STREAM, MADE TO LOOK LIKE ONE THAT CAN.
   *
   * `stream()` is optional on `ChatBackend`, and the provider fallback has no
   * streaming path at all — `models/provider.ts` owns the limiter and is not
   * this feature's to rewrite. Both are served by asking once and emitting the
   * answer as a single `delta` followed by `done`. The words arrive in one
   * lump instead of one at a time, and every other part of the contract — the
   * row, the events, the partial handling — is identical, so no client needs a
   * second code path for it.
   */
  async function* oneShot(signal: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    /*
      THE PROVIDER PATH IS NOT ALWAYS ONE SHOT ANY MORE. `directTurn` decides
      between the text-only completion this function was written for and a
      BOUNDED TOOL LOOP over the skills registry, from the model's measured
      capability and the owner's setting — see integrations/runtime/loop.ts.
      Both come out of it as the same events, so this generator delegates the
      whole provider half rather than branching on the mode here: "which mode
      did this turn get" is one decision in one place, and this file does not
      get a second opinion about it.
    */
    if (!live) {
      yield* directTurn(turns, {
        signal,
        ventureId,
        onOutcome: (provider, endpoint) => noteOutcome(provider, endpoint, null),
      });
      return;
    }
    const reply = await ask(withSkills(turns, live), { sessionId, channel, signal });
    yield { type: "delta", text: reply.text };
    yield {
      type: "done",
      text: reply.text,
      model: reply.model,
      usage: reply.usage,
      ms: reply.ms,
      /* NULL, AND NOT A MEASUREMENT THAT WAS NOT MADE. This branch is the AGENT
         now that the provider half has moved into `directTurn` above, and an
         agent's turn never queues here: Hermes owns its own concurrency and
         reports nothing about it. The queue figure the provider path carries
         comes back through `directTurn`'s own `done`. */
      queuedMs: null,
    };
  }

  const run = startChatRun({
    sessionId,
    channel,
    ventureId,
    backend: backendId,
    backendLabel: label,
    user: stored,
    start: {
      sessionId,
      userMessageId: stored.id,
      user: shapeMessage(stored),
      backend: backendId,
      backendLabel: label,
      model: null,
    },
    shape: shapeMessage,
    /* `track` registers the session as in flight for as long as the run is
       reading — chat/inflight.ts — so a dispatch made mid-answer is filed under
       this chat even when the agent forgot to say so. `oneShot` goes through
       `ask`, which registers itself. */
    open: (signal) =>
      live?.stream
        ? track(sessionId, live.stream(withSkills(turns, live), { sessionId, channel, signal }))
        : oneShot(signal),
    onError: (failure) => {
      /* Recorded against the ACCOUNT that failed, so the Integrations page
         shows a red line on the credential that stopped working — the same rule
         the non-streaming route keeps, and the adapters still know which
         account answered. */
      if (live?.id === "hermes") hermes.noteFailure(failure);
      else if (live?.id === "openclaw") openclaw.noteFailure(failure);
      else if (fallback) noteOutcome(fallback.id, null, failure);
      console.error(`[chat/stream] ${backendId} failed — ${failure}`);
    },
  });

  return pipeRun(c, run.id, 0);
});

/* --------------------------------------------------------------- reattaching */

/**
 * Watch a turn that is already running — from wherever it has got to.
 *
 * THE POINT OF THE WHOLE FEATURE, in one route. `since` is a sequence number:
 * 0 replays the turn from its first frame, which is what a page that has just
 * reloaded wants (it has no words on screen and needs all of them); a number
 * is what a client that was reading and lost its connection sends, so it gets
 * the tail and not the answer twice. `Last-Event-ID` is honoured as well,
 * because every frame carries its seq as the SSE `id` and that header is what
 * the standard says a reconnecting client sends.
 *
 * A RUN THIS PROCESS NO LONGER HOLDS IS NOT AN ERROR. It answers one `run`
 * frame carrying the stored status and closes. That is the honest thing: the
 * answer is finished and in the transcript, and the client's next move is to
 * read the transcript rather than to wait. A run id that never existed is a
 * 404, because that IS a mistake.
 */
chat.get("/runs/:id/events", (c) => {
  const id = c.req.param("id");
  const header = c.req.header("last-event-id");
  const asked = c.req.query("since");
  const since = Number(asked ?? header ?? 0);
  const row = chatRunRow(id);
  if (!row && !runHandle(id)) return c.json({ error: `There is no run called "${id}".` }, 404);
  return pipeRun(c, id, Number.isFinite(since) && since > 0 ? Math.floor(since) : 0);
});

/**
 * Stop one turn.
 *
 * EXPLICIT, AND THE ONLY THING THAT STOPS AN ANSWER NOW. A closed tab used to
 * be a cancellation by accident; it is not any more, so this is the whole of
 * the stop button's other end. Whatever was said is written as a partial row
 * before the run reports itself cancelled, so pressing this loses nothing that
 * was on screen.
 *
 * IT ANSWERS `stopping`, NOT `cancelled`, and the difference is a real one.
 * Aborting is a request the run honours in its own `finally` — it still has a
 * partial row to write — so reporting the outcome here would be reporting it
 * before it happened. It used to, and the race was reachable: a cancel landing
 * after the agent had finished its last token but before the run wrote its
 * status was accepted, and then the turn landed as `done` while this route had
 * already told the owner it was cancelled. The authority on what happened is
 * the terminal frame; a run that has finished answering now refuses the cancel
 * outright and says so.
 *
 * 409 rather than 404 for a run that has already ended: it existed, it is not
 * running, and telling a client "no such run" would send it looking for a bug
 * in the id it just used.
 */
chat.post("/runs/:id/cancel", (c) => {
  const id = c.req.param("id");
  const r = cancelChatRun(id);
  if (!r.ok)
    return c.json(
      { error: r.error ?? "That run is not running.", runId: id, status: r.status },
      r.notFound ? 404 : 409,
    );
  return c.json({ runId: id, status: r.status });
});

/** Which conversations the SERVER is answering right now. The rail's marks
 *  after a reload come from here: the browser's own memory of them died with
 *  the page, and a dot that came back from localStorage would be reporting an
 *  answer nobody is receiving. */
chat.get("/runs", (c) => c.json({ sessions: answeringSessions() }));

/**
 * Frames out, in order, until the run ends or the reader goes away.
 *
 * THE DRAIN IS CHECKED BEFORE THE END, which is the one subtle line here: the
 * run emits its `done` frame and THEN marks itself finished, so a loop that
 * broke on "finished" without emptying the queue first would drop the last and
 * most important frame roughly whenever the timing was unlucky.
 *
 * THE KEEPALIVE IS NOT DECORATION. Hermes can think for minutes before the
 * first token, and an idle connection is a connection something in the middle
 * is entitled to close. A comment line every twenty-five seconds is what keeps
 * a long investigation from looking like a dead socket.
 */
function pipeRun(c: Context, runId: string, since: number) {
  return streamSSE(c, async (sse) => {
    const handle = runHandle(runId);
    if (!handle) {
      /* Past the retention window, or lost to a restart. One frame saying so,
         from the row, and the client reads the transcript. */
      const row = chatRunRow(runId);
      await sse
        .writeSSE({
          event: "run",
          data: JSON.stringify({
            runId,
            status: row?.status ?? "failed",
            error: row?.error ?? null,
            attachable: false,
          }),
        })
        .catch(() => {});
      return;
    }

    const queue = handle.replay(since);
    let wake: (() => void) | null = null;
    const nudge = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const off = handle.listen((f) => {
      queue.push(f);
      nudge();
    });
    let over = !handle.running;
    void handle.ended.then(() => {
      over = true;
      nudge();
    });
    const signal = c.req.raw.signal;
    const gone = () => signal.aborted;
    signal.addEventListener("abort", nudge, { once: true });

    try {
      for (;;) {
        while (queue.length) {
          const f = queue.shift()!;
          try {
            await sse.writeSSE({ id: String(f.seq), event: f.event, data: JSON.stringify(f.data) });
          } catch {
            /* The reader is gone. The run does not care — it is the server's
               work now — so this handler simply stops. */
            return;
          }
        }
        if (over || gone()) break;
        let timer: ReturnType<typeof setTimeout> | null = null;
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 25_000);
        });
        if (timer) clearTimeout(timer);
        /* A COMMENT, NOT A FRAME. `: keepalive` is bytes on the socket that no
           SSE parser turns into an event — both readers in this codebase skip
           a line beginning with a colon — so it proves the connection is alive
           without adding anything to the client's idea of what was said. */
        if (!queue.length && !over && !gone()) {
          try {
            await sse.write(": keepalive\n\n");
          } catch {
            return;
          }
        }
      }
    } finally {
      off();
      signal.removeEventListener("abort", nudge);
    }
  });
}
