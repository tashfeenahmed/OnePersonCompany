/**
 * THE CHAT PAGE — the one place in this app that talks to an agent.
 *
 * WHAT THE BROWSER DOES NOT HAVE, AND WILL NOT GET. No base URL, no key, no
 * token. It posts a session id and a sentence to `/api/chat` and reads back
 * what the agent said; which agent that was, where it lives and what it was
 * authorised with are facts held on the server, and the only one of them that
 * comes down here is the agent's NAME, because the owner is entitled to know
 * who answered. OpenClaw's bearer in particular is operator access to a whole
 * gateway — a page that held one could be talked into anything the gateway can
 * do.
 *
 * THE TRANSCRIPT LIVES ON THE SERVER, NOT IN THE STORE. `store.tsx` keeps
 * sessions — their titles, their ventures, their order in the rail — and it
 * keeps them in localStorage, which is exactly right for what they are. It
 * does NOT keep messages, and this page does not add them to it. The reason is
 * the Telegram bridge: it answers as the same agent, in the same session
 * store, with no localStorage and no React. A transcript in the browser would
 * make the page and the phone two conversations that disagree from the first
 * message that arrived by the other door. So the session id is the join, the
 * server holds the words, and this page is a reader of them.
 *
 * WHICH MEANS THIS PAGE HAS A MUTATION, and that is why it does not use
 * `useApi`. That hook draws a document: loading, failed, or an answer, with a
 * `reload` for afterwards. A chat is the other thing — a list that grows by an
 * append the page itself made, where the optimistic user message must survive
 * until the reply lands and a refetch triggered by a session change must not
 * wipe it. The load is therefore written out below with an explicit guard on
 * which session the answer belongs to. The alternative — `useApi` plus a
 * reload after every send — flickers the whole conversation on each turn.
 *
 * ------------------------------------------------------------------------
 *
 * THE ANSWER ARRIVES A WORD AT A TIME NOW, and that changed four things.
 *
 * 1. THERE ARE TWO KINDS OF MESSAGE ON SCREEN AT ONCE. The stored ones, which
 *    came out of the database and cannot change; and the one being written,
 *    which is state on this page and is not in the database yet. They are kept
 *    apart — `convo.messages` and `writing` — rather than merged into one list
 *    with a fake row in it, because a fake row needs a fake id and a fake
 *    timestamp, and every piece of code downstream then has to know which rows
 *    are real. When the turn finishes, the stored row arrives on the `done`
 *    event and replaces the live one; there is never a moment where both are
 *    drawn.
 *
 * 2. DELTAS ARE BATCHED TO AN ANIMATION FRAME. An agent writing quickly emits
 *    a chunk every few tens of milliseconds, and a `setState` per chunk is a
 *    React render per chunk — each of which re-parses the markdown of the
 *    message being written. Accumulating into a ref and flushing once per
 *    frame caps that at 60 renders a second no matter how fast the words
 *    arrive, and the `Markdown` component is memoised on its text so the rest
 *    of the transcript does not re-parse at all.
 *
 * 3. STOPPING IS AN ABORT, END TO END — of ONE chat. Each turn carries its
 *    own `AbortController`: aborting it closes that fetch body, which the
 *    server sees as a disconnect, which aborts its own call to the agent.
 *    Nothing is lost by stopping — the server stores what was said as a
 *    PARTIAL answer, and this page reloads the transcript to pick it up
 *    rather than keeping its own copy of it. The button stops the
 *    conversation you are LOOKING AT and no other.
 *
 * 4. THE RAIL IS RECONCILED AGAINST THE SERVER ON LOAD. The session list is
 *    still the store's, and it is still in localStorage — but it is now
 *    checked against the conversations that actually exist. That is also how
 *    the twelve invented sessions this app shipped with are retired: they are
 *    marked by the store's `migrate()` and swept here, once it is known which
 *    of them have real transcripts behind them. See `Session.seeded`.
 *
 * ------------------------------------------------------------------------
 *
 * THE CHAT BEING READ IS THE ONE IN THE ADDRESS BAR. `/chat/<sessionId>` is a
 * conversation and `/` is a new one; this component serves both routes and
 * reads the id out of `useParams`.
 *
 * THE ADDRESS IS THE ONLY COPY, and it is not mirrored into the store. The
 * session id is a route param on the way in and `navigate` on the way out, and
 * nothing persists it: a conversation being open is a fact about where you
 * are, not about the workspace. `StoreState` in lib/store.tsx carries the full
 * argument and the bug that made it.
 *
 * A NEW CHAT REWRITES ITS OWN ADDRESS. `/` shows an empty composer, the first
 * message creates the session, and the URL is replaced — not pushed — with
 * `/chat/<id>`. Replaced, because `/` and the chat it turned into are one
 * place: pushing would put a Back button between somebody and the page they
 * came from, and the step it went back to would be an empty composer for a
 * conversation that now exists.
 *
 * AN ID THAT NAMES NOTHING IS TOLD SO. It is not redirected to a new chat and
 * not silently emptied — the same call `Dashboards` makes about a slug that
 * matches no board. The check waits for the rail to have been reconciled
 * against the server once, because a conversation that started on Telegram is
 * real and is not in this browser's localStorage until then.
 *
 * ------------------------------------------------------------------------
 *
 * SEVERAL CHATS CAN BE ANSWERING AT ONCE, and `flights` below is the whole of
 * how.
 *
 * WHAT IT REPLACED, AND WHY THAT COULD NOT BE PATCHED. This page held one
 * `busy` session id, one `AbortController` and one `writing` bubble for the
 * entire screen — a shape that encodes "there is at most one turn in the
 * world". Under it, asking a second chat while the first was writing took the
 * first one's controller away (leaving a stream running that nothing could
 * stop) and painted the second one's words wherever the first one's had been;
 * and switching chats mid-answer dropped the answer off the screen, because
 * the single bubble belonged to whichever session was last looked at. Keyed by
 * session id, each of those becomes a fact about ONE conversation: its
 * controller, its text, its reasoning, its tool lines, when it started, and
 * the stored rows it is being said into.
 *
 * A PLAIN MAP RATHER THAN STATE, WITH A FORCED RENDER TO PAINT BY. The deltas
 * of a chat nobody is looking at must keep accumulating without re-rendering
 * the chat somebody IS looking at; a `useState` map would do exactly the
 * opposite — one render of this whole page per chunk of every background
 * answer. So the map is mutated in place and the render is forced only when
 * the session that changed is the session on screen. Switching chats reads the
 * map afresh, which is what makes coming back to a chat mid-answer show the
 * LIVE buffer instead of a reload that would arrive without the sentence in
 * it.
 *
 * IT SITS OUTSIDE THE COMPONENT, AND NOT IN A REF. A ref would be aborted by
 * an unmount, which is only defensible if leaving this page means leaving the
 * conversation behind for good — and it does not. A chat has an address, the
 * rail is a set of links, and glancing at /integrations and coming back is an
 * ordinary motion rather than an exit; killing an answer because somebody
 * looked at another page for four seconds would be a bug introduced by giving chats
 * URLs. So the map, the delta buffers and the frame are module state, they
 * outlive any one mount, and a page that mounts afterwards finds the turn
 * still running and draws it.
 *
 * WHICH NEEDS A WAY BACK IN, because the callbacks of a stream belong to the
 * mount that started it and that mount may be gone. `watchers` is that: every
 * mounted Chat registers one, the stream announces the session that changed,
 * and whichever page is up decides what to do about it. A turn that ends with
 * nobody watching still writes its rows to the server, still clears the rail's
 * mark, and still re-reads the rail — it just has no screen to paint, which is
 * the honest state of affairs rather than a special case.
 *
 * The tab closing still ends every one of them: a fetch dies with the page
 * that made it. Nothing here outlives the window.
 *
 * THE SERVER NEEDED NOTHING FOR THIS, AND THERE IS NO SECOND AGENT. Each
 * `POST /chat/stream` reads that session's own history — `chatMessages(
 * sessionId, CONTEXT_TURNS)` — and hands it to the backend as the turns of the
 * call, so two chats answering at once are two ordinary HTTP requests that
 * share nothing but a process. One Hermes serves them both. The only ceiling
 * is the model provider's concurrency policy, and only on the path where this
 * app owns the gate: with no agent live the answer goes through
 * `models/provider.ts`, where `series` means the second call waits for a slot.
 * That wait is said out loud below rather than left looking hung.
 *
 * A RELOAD CANNOT RE-ATTACH, AND THIS PAGE DOES NOT PRETEND OTHERWISE. A
 * stream belongs to a request and the request dies with the tab. The server
 * has no way to hand a fresh connection the middle of an answer, and faking
 * one — polling the partial row, say — would draw words that stop growing and
 * never finish. So a reload mid-answer shows what is STORED: the partial row
 * the stream route writes in its `finally`, labelled as cut off. The rail's
 * streaming marks are not persisted for the same reason (see
 * `setSessionStreaming` in the store) — a dot that survived a refresh would be
 * reporting an answer nobody is receiving.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { duration } from "@/lib/format";
import { useDraft } from "@/hooks/useDraft";
import { useModelProviders } from "@/hooks/useModelProviders";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  FolderClosed,
  LayoutDashboard,
  Plug,
  Plus,
  TriangleAlert,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommandBar } from "@/components/chat/CommandBar";
import { ReportCard } from "@/components/chat/ReportCard";
import { DailySuggestions } from "@/components/chat/DailySuggestions";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { VentureMark } from "@/components/VentureChrome";
import { Markdown } from "@/components/Markdown";
import { WORK_CHANGED } from "@/hooks/useRunQueue";
import { ToolCallLine } from "@/components/ToolCallLine";
import { ToolActivityText } from "@/components/ToolActivityText";
import { attachChatRun, cancelChatRun, type ChatRunHandlers } from "@/lib/chatRuns";
import {
  ApiError,
  api,
  type ChatBackendId,
  type ChatBackends,
  type ChatMessage,
  type ChatRunState,
  type ChatToolCall,
} from "@/lib/api";

const BACKEND_NAMES: Record<ChatBackendId, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * A conversation's name, from the first thing said in it.
 *
 * ONE RULE, USED IN BOTH PLACES A TITLE IS DERIVED: when the composer starts a
 * chat here, and when a conversation arrives from the server with no name in
 * the store — a chat that began on Telegram, or in another browser. Written
 * once so the same conversation does not end up with two different labels
 * depending on which door named it.
 *
 * It lives on this page rather than in the store because this page is where
 * both of those happen, and because the store is a `.tsx` module whose
 * non-component exports each cost a fast-refresh warning.
 *
 * Forty-eight characters is about a rail's width at this type size. The
 * ellipsis is a real one rather than three dots, because three dots wrap.
 */
function sessionTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "New chat";
  return trimmed.length > 48 ? `${trimmed.slice(0, 48).trimEnd()}…` : trimmed;
}

/**
 * A MESSAGE, SPLIT AT THE POINTS ITS TOOL CALLS HAPPENED.
 *
 * `offset` on each call is how many characters of the answer had been written
 * when it started, so the text is cut there and the grey line goes in the gap.
 * That is what makes a reloaded transcript read the way it did live — without
 * it, every stored call renders in a pile at the end and the message tells a
 * different story about the order things happened in.
 *
 * THE COST, NAMED: a cut lands wherever the agent happened to be, which can be
 * inside a markdown block. A tool called mid-list splits that list into two
 * lists with a grey line between them. That is accepted rather than worked
 * around, because the alternative — nudging the cut to the nearest blank line
 * — moves a tool call to a place it did not happen, and a transcript that
 * quietly reorders events is worse than one that renders two lists. In
 * practice agents call tools between paragraphs, which is where the cut lands.
 *
 * Offsets are sorted and clamped rather than trusted: they come out of a JSON
 * column, and one past the end of the text would silently drop the rest of the
 * answer.
 */
function splitByTools(
  text: string,
  tools: ChatToolCall[],
): { text: string; call: ChatToolCall | null }[] {
  if (!tools.length) return [{ text, call: null }];

  const sorted = [...tools].sort((a, b) => a.offset - b.offset);
  const parts: { text: string; call: ChatToolCall | null }[] = [];
  let cursor = 0;

  for (const call of sorted) {
    const at = Math.min(Math.max(call.offset, cursor), text.length);
    /* An empty segment is skipped, so two tools that ran back to back do not
       get a blank paragraph between their lines. */
    if (at > cursor) parts.push({ text: text.slice(cursor, at), call: null });
    parts.push({ text: "", call });
    cursor = at;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), call: null });
  return parts;
}

/**
 * The body of an assistant turn: markdown, with the tool lines where they
 * belong.
 *
 * Used for BOTH the stored messages and the one being streamed, which is the
 * point — a live answer and a reloaded one are drawn by the same function, so
 * they cannot look different. The only thing that differs is where the text
 * came from.
 */
function AssistantBody({
  text,
  tools,
  reasoning,
}: {
  text: string;
  tools: ChatToolCall[] | null;
  /** The model's working, for a turn in flight. Folded into the first
   *  Working group so the answer's machinery is one row, not several. */
  reasoning?: string | null;
}) {
  const parts = splitByTools(text, tools ?? []);
  /*
    BUNDLED. Seven tool lines between two paragraphs drawn as seven rows, each
    with its own disclosure, buries the answer under them. Consecutive calls — every run with no words between — become ONE
    `Working` row: closed, it says how many steps and how long; open, it is
    the lines, each of which still opens into its own detail. Two clicks to
    the bottom, none to the answer.
  */
  const groups: ({ kind: "text"; text: string } | { kind: "work"; calls: ChatToolCall[] })[] = [];
  for (const part of parts) {
    if (part.call) {
      const last = groups[groups.length - 1];
      if (last?.kind === "work") last.calls.push(part.call);
      else groups.push({ kind: "work", calls: [part.call] });
    } else if (part.text) groups.push({ kind: "text", text: part.text });
  }
  const firstWork = groups.findIndex((g) => g.kind === "work");
  return (
    <>
      {reasoning && firstWork === -1 && <Thinking text={reasoning} done={false} />}
      {groups.map((g, i) =>
        g.kind === "work" ? (
          <Working key={`w-${g.calls[0]!.toolCallId}`} calls={g.calls} reasoning={i === firstWork ? reasoning ?? null : null} />
        ) : (
          <Markdown key={`t-${i}`} text={g.text} linkContext="chat" />
        ),
      )}
    </>
  );
}

/**
 * ONE ROW FOR A RUN OF TOOL CALLS. Closed by default — the answer is what the
 * page is for — and while a call is still running the row carries that call's
 * own label, shimmering, so "what is it doing" is answered without opening
 * anything. Open, it is the ToolCallLines as they always were.
 */
function Working({ calls, reasoning }: { calls: ChatToolCall[]; reasoning: string | null }) {
  const [open, setOpen] = useState(false);
  const running = calls.find((c) => !c.finishedAt) ?? null;
  const ms = calls.reduce((n, c) => {
    if (!c.finishedAt) return n;
    const d = Date.parse(c.finishedAt) - Date.parse(c.startedAt);
    return Number.isFinite(d) && d > 0 ? n + d : n;
  }, 0);
  const steps = calls.length + (reasoning ? 1 : 0);
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "text-muted-foreground -mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline gap-1.5 rounded-[9px] px-1.5 py-0.5 text-left text-[14.5px] leading-[1.6] transition-colors",
          running
            ? "focus-visible:ring-ring focus-visible:ring-1"
            : "hover:bg-accent hover:text-foreground focus-visible:bg-accent",
        )}
      >
        <ChevronRight
          className={cn("size-3 shrink-0 self-center transition-transform", open && "rotate-90")}
          strokeWidth={1.8}
        />
        <ToolActivityText running={running !== null}>
          <span className="min-w-0 truncate">
            {running
              ? `Working · ${running.tool}${running.label ? ` · ${running.label}` : ""}`
              : `Worked · ${steps} step${steps === 1 ? "" : "s"}`}
          </span>
          <span className="shrink-0 whitespace-pre">
            {running ? ` · step ${calls.indexOf(running) + 1} of ${calls.length}…` : ms > 0 ? ` · ${duration(ms)}` : ""}
          </span>
        </ToolActivityText>
      </button>
      {open && (
        <div className="border-line-soft mt-0.5 ml-1.5 border-l pl-2.5">
          {reasoning && <Thinking text={reasoning} done={!running} />}
          {calls.map((c) => (
            <ToolCallLine key={c.toolCallId} call={c} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The model's working, folded.
 *
 * SOME MODELS SHOW THEIR REASONING and it arrives on its own event, separate
 * from the answer. It is NEVER drawn as the answer: a scratchpad in front of a
 * reply, on every turn, is the failure the server's reader avoids on the
 * non-streaming path for exactly the same reason. Folded, grey, and above the
 * text it led to.
 *
 * It is deliberately not persisted. Reasoning is a fact about how an answer
 * was arrived at, it can be several times the length of the answer, and it is
 * of interest for about as long as it takes to read the reply. Storing it
 * would double the size of the transcript to keep something nobody scrolls
 * back for.
 */
function Thinking({ text, done }: { text: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:bg-accent hover:text-foreground -mx-1.5 flex items-center gap-1.5 rounded-[9px] px-1.5 py-1 text-[13px] transition-colors"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          strokeWidth={1.8}
        />
        <Brain className="size-3.5 shrink-0" strokeWidth={1.6} />
        {done ? "Thought about it" : "Thinking…"}
      </button>
      {open && (
        <p className="text-muted-foreground border-line-soft mt-1 ml-4 border-l pl-3 text-[13px] leading-[1.55] whitespace-pre-wrap">
          {text.trim()}
        </p>
      )}
    </div>
  );
}

/**
 * ONE TURN IN FLIGHT — everything about an answer that is still arriving.
 *
 * Kept OUT of `convo.messages` on purpose. Merging the words being written
 * into the stored list would need an id and a timestamp the database has not
 * issued yet, and every piece of code that touches that list would then have
 * to know which rows are real. Separate, it is obvious: those are the stored
 * messages, and this is the one still being said.
 *
 * IT CARRIES ITS OWN COPY OF THE TRANSCRIPT, which is the field that makes
 * several of these possible at once. `convo` below describes the chat being
 * LOOKED AT — and a turn does not stop when you look somewhere else, so the
 * rows it is being said into travel with it. Coming back to a chat that is
 * still answering then draws from this record rather than from a fetch, and a
 * fetch is precisely what must not happen: the server's copy of that
 * conversation does not have the sentence currently arriving in it.
 */
type Flight = {
  /**
   * DETACHES THIS PAGE FROM THE STREAM — it does not stop the turn.
   *
   * ABORTING IT DOES NOT CANCEL THE AGENT. The server owns the run, so this
   * only ends the reading; `runId` below is what stops the answer.
   */
  controller: AbortController;
  /**
   * The server-side run this turn is, once it has said so.
   *
   * Null for the moment between the request leaving and the first frame
   * arriving — which is why `stopRequested` exists, so a button pressed inside
   * that moment is honoured rather than lost.
   */
  runId: string | null;
  /** The owner has pressed stop; send the cancel as soon as there is an id to
   *  send it against. */
  stopRequested: boolean;
  /**
   * DID THIS BROWSER ASK THE QUESTION?
   *
   * True for a turn started from the composer, false for one this page found
   * already running and reattached to. The difference is what may be dropped:
   * a turn the owner started here keeps its reader open across pages, because
   * an answer killed by a glance at /integrations is the bug the module-level
   * flight map exists to prevent. A REATTACHED reader is only this page's view
   * of somebody else's turn — the run continues on the server either way — so
   * closing the chat closes the socket, and reopening it attaches again from
   * the first frame. Without that, every chat visited while it happened to be
   * answering left an SSE connection open for the length of the turn, and six
   * of those exhaust the browser's per-origin pool on HTTP/1.1 and stall every
   * other request on the page.
   */
  owned: boolean;
  /** The answer so far. */
  text: string;
  /** The model's working so far, if it shows any. Never drawn as the answer. */
  reasoning: string;
  /** Merged as the events arrive: `running` creates the record, `completed`
   *  closes it, exactly as the server does before storing them. */
  tools: ChatToolCall[];
  /** When the question went up. Nothing draws it yet; it is the field a record
   *  of an in-flight turn is incomplete without, and what a "still going after
   *  two minutes" line would be measured from. */
  startedAt: number;
  /** The stored rows this turn is being said into, the owner's own message
   *  included — see above. */
  messages: ChatMessage[];
  /** How long the provider's gate made this turn wait, when it says so. */
  queuedMs: number | null;
  /**
   * Why it went wrong, in the server's own words, or null.
   *
   * ON THE RECORD RATHER THAN IN COMPONENT STATE, because the turn can fail
   * while nothing is mounted to hold a `useState` — see the file header. It
   * is deliberately NOT stored as a message: a transcript is what was said,
   * and an error is something the interface reports. It does not survive a
   * reload, which is correct — the question is durable, the failure was a
   * moment.
   */
  failure: string | null;
};

/** What a turn left behind when it ended: the rows it finished with, and
 *  whether it got all the way to `done`. Handed to whichever page is up. */
type Ending = { messages: ChatMessage[]; completed: boolean };

/* ==========================================================================
   EVERY TURN IN FLIGHT, FOR THE WHOLE APP — module state, outliving any mount.

   See the file header for why this is not a ref on the component any more.
   The short version: a chat has an address now, so leaving the chat page is
   something somebody does on the way to another page and back, not an exit —
   and an answer that was killed by a glance at /integrations would be a bug
   this app introduced by giving conversations URLs.

   A MODULE SINGLETON RATHER THAN A CONTEXT ABOVE THE ROUTER. A provider would
   be the same lifetime with more machinery, and the thing it buys — several
   independent copies in one document — is exactly what must not exist here.
   One browser tab is one owner talking to one agent; two maps of turns in
   flight would be two rails disagreeing about which chats are answering.
   ========================================================================== */

const flights = new Map<string, Flight>();

/**
 * DELTAS GO INTO A BUFFER AND OUT ONCE PER FRAME.
 *
 * A `setState` per chunk is a render per chunk, and an agent writing quickly
 * emits one every few tens of milliseconds — which would re-parse the markdown
 * of the growing message tens of times a second and re-render every other
 * bubble with it. The buffer absorbs the chunks; `requestAnimationFrame` hands
 * them over at the rate the screen can actually show them.
 *
 * rAF rather than a timer, because it is the browser saying "I am about to
 * paint" — a 16ms interval keeps firing in a background tab, where nobody is
 * reading and the work is pure heat.
 *
 * ONE BUFFER PER SESSION, ONE FRAME FOR ALL OF THEM. Three answers arriving at
 * once are still a single flush and at most a single render, and a chunk
 * belonging to a chat nobody is looking at costs one string concatenation and
 * nothing else. A frame per stream would be three times the paints for one
 * screen's worth of change.
 */
const pending = new Map<string, { text: string; reasoning: string }>();
let frame: number | null = null;

/**
 * WHAT THE LAST FINISHED TURN LEFT TO SAY, per chat.
 *
 * Two facts that belong to a conversation rather than to a screen: why the
 * last turn failed, and how long it waited for a model slot. They are here
 * rather than in component state for the same reason the flights are — a turn
 * can end while this page is not mounted, and "the chat that failed while you
 * were reading another one says so when you open it" is the behaviour worth
 * keeping. Cleared when that chat is asked something new.
 */
const lastTurn = new Map<
  string,
  { failure: string | null; queuedMs: number | null }
>();

/**
 * THE WAY BACK INTO A MOUNTED PAGE from a stream that does not belong to it.
 *
 * A stream's callbacks close over the render that started them, and that
 * render may be long gone by the time an answer finishes. Rather than let
 * those closures write into a dead component — silent no-ops, and a page that
 * sits on "Reading this chat…" forever after a background turn ends — every
 * mounted Chat registers a watcher here and the stream announces the session
 * that changed. Whoever is up decides what that means for what is on screen.
 */
type Watcher = (id: string, ending: Ending | null) => void;
const watchers = new Set<Watcher>();

/** Tell the page, if there is one. The answer says whether anybody heard —
 *  which is how a finished turn knows to go and re-read the rail itself. */
function announce(id: string, ending: Ending | null = null): boolean {
  /* Over a copy: a watcher's own setState can re-run the effect that
     registered it, and a Set that is added to while it is being walked is a
     watcher called twice. */
  for (const watch of [...watchers]) watch(id, ending);
  /* A turn that ended may have dispatched a sub-agent. The sidebar's badge
     and the Sub-agents page poll on their own clocks; this is how they learn
     to look now rather than in ten seconds — see hooks/useRunQueue.ts. */
  if (ending) window.dispatchEvent(new Event(WORK_CHANGED));
  return watchers.size > 0;
}


function buffer(id: string) {
  let b = pending.get(id);
  if (!b) {
    b = { text: "", reasoning: "" };
    pending.set(id, b);
  }
  return b;
}

function flush() {
  if (frame !== null) {
    cancelAnimationFrame(frame);
    frame = null;
  }
  if (!pending.size) return;
  const touched: string[] = [];
  for (const [id, buf] of pending) {
    const flight = flights.get(id);
    /* A buffer whose turn has already ended is dropped rather than kept: by
       then the stored row is the truth and these characters are in it. */
    if (!flight) continue;
    flight.text += buf.text;
    flight.reasoning += buf.reasoning;
    touched.push(id);
  }
  pending.clear();
  for (const id of touched) announce(id);
}

function schedule() {
  if (frame === null) frame = requestAnimationFrame(flush);
}

export function Chat() {
  const { state, addSession, reconcileSessions, setSessionStreaming } =
    useStore();
  const draftRoute = useParams().sessionId ?? "new";
  const [text, setText, draftError] = useDraft(`opc-chat-draft:${draftRoute}`);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Empty is a real answer: most chats are about nothing in particular.
  // Settings → General presets this; the picker still overrides it per chat.
  const [targetId, setTargetId] = useState<string | null>(
    state.workspace.defaultVentureId,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const target = state.ventures.find((v) => v.id === targetId);

  /**
   * ARRIVING FROM A VENTURE: `?venture=<id>` picks the target, `?q=<text>`
   * fills the composer, and both are then STRIPPED from the address.
   *
   * They are an instruction for this arrival, not a description of the page,
   * and leaving them in the bar would make Back re-apply them and a bookmark
   * of "the new chat screen" re-type somebody's question a fortnight later.
   * Stripping with `replace` for the same reason the new session's address is
   * replaced: this is one place, not two.
   *
   * The composer is filled rather than SENT. The openers on a venture page are
   * a starting sentence, and sending one without giving the owner the chance to
   * change a word would spend a turn on a question they did not finish asking.
   */
  useEffect(() => {
    if (!location.search) return;
    const params = new URLSearchParams(location.search);
    const venture = params.get("venture");
    const q = params.get("q");
    if (!venture && !q) return;
    if (venture) setTargetId(venture);
    if (q) setText(q);
    navigate(location.pathname, { replace: true });
    /* Focused last, so the caret is where somebody who wants to edit the
       opener would put it anyway. */
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [location.search, location.pathname, navigate, setText]);
  /*
    THE ADDRESS IS THE SELECTION. `/chat/<id>` is a conversation, `/` is a new
    one — see the file header for what this replaced and why the store's own
    `activeSessionId` was retired rather than kept in step.
  */
  const { sessionId: routeId } = useParams();
  const sessionId = routeId ?? null;

  /* ------------------------------------------------------------- state */

  /**
   * The conversation, AND the session it belongs to, in one piece of state.
   *
   * Two separate `messages` and `sessionId` states would be two things that
   * can disagree for a render — which is exactly the frame in which the last
   * chat's words appear under the new chat's title. Keeping them together
   * makes "these messages are that session's" a fact rather than a hope, and
   * it means switching sessions needs no state RESET at all: the mismatch is
   * detected during render, below, and an empty list is derived from it.
   *
   * That is also why there is no `setMessages([])` in the effect. Clearing on
   * the way in would be a synchronous setState inside an effect — a second
   * render to undo the first, for a value that can simply be computed.
   */
  const [convo, setConvo] = useState<{
    id: string | null;
    messages: ChatMessage[];
    /** Why this session's transcript could not be read. Kept beside the
     *  messages because it is about THIS session; a shared error would outlive
     *  the chat it described. */
    error: string | null;
  }>({ id: null, messages: [], error: null });

  /**
   * A SWITCH THAT WOULD NOT TAKE — the agent or provider picker refusing.
   *
   * The only failure left in component state, and it is here because it is the
   * only one that belongs to a screen rather than to a conversation: nobody
   * pressed a menu in a page that is not mounted. A turn's own failure lives
   * on its record and then in `lastTurn`, because a turn can end while this
   * page is somewhere else entirely.
   *
   * ONE SLOT, TAGGED RATHER THAN PER-SESSION. It is drawn only under the chat
   * it happened in, and there is no second menu being pressed in a chat you
   * cannot see.
   */
  const [switchFailure, setSwitchFailure] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [backends, setBackends] = useState<ChatBackends | null>(null);
  const { data: providers } = useModelProviders();
  /*
    MANAGED OR REMOTE, per agent — a second fetch, and worth it.

    `GET /api/chat/backends` answers the question this page is really asking
    (who can answer, who is chosen, who is live) and deliberately knows nothing
    about processes. But an agent this app SPAWNED and one running on somebody
    else's box are very different things to be talking to, and the one place
    that difference is invisible is a menu that names them both "Hermes". So
    the mode comes from /api/agents, which is the route that owns that fact.
  */
  const [modes, setModes] = useState<
    Partial<Record<ChatBackendId, "managed" | "remote">>
  >({});

  const bottomRef = useRef<HTMLDivElement>(null);

  /* ----------------------------------------------------------- streaming */

  /**
   * WHICH CHAT IS ON SCREEN — read from inside promises and stream callbacks,
   * where the render's `sessionId` is already stale.
   *
   * Two things need it. A transcript that arrives late must not overwrite a
   * newer one: switching chats in the rail twice in quick succession fires two
   * loads, and without this the slower answer wins and puts the wrong
   * conversation on screen. And a turn that finishes in the BACKGROUND must
   * not write its result over the conversation the owner has moved to. Both
   * comparisons only mean anything after an await, which is exactly what a ref
   * is for.
   */
  const showing = useRef<string | null>(null);

  /**
   * The render this page cannot get from state, because its streaming data is
   * deliberately not in state.
   *
   * A chat that is not on screen can grow all it likes for free, and the only
   * thing that costs a render is the one being read. A `useState` map would
   * have inverted that — three background answers would re-render the
   * transcript in front of somebody a hundred times a second between them.
   */
  const [, forceRepaint] = useReducer((n: number) => n + 1, 0);

  /**
   * RE-READ ONE TRANSCRIPT, quietly.
   *
   * The other loader — the effect below — reports what went wrong, because a
   * chat that will not open is the whole screen. This one runs after a turn
   * that ended badly, where the question is still on screen, the failure is
   * already named, and a second error about being unable to check the first
   * one is not information.
   */
  const reread = useCallback((id: string) => {
    api
      .chatSession(id)
      .then((doc) => {
        if (showing.current !== id || flights.has(id)) return;
        setConvo({ id, messages: doc.messages, error: null });
        setBackends(doc);
      })
      .catch(() => {});
  }, []);

  /**
   * THE RAIL, RECONCILED AGAINST WHAT THE SERVER ACTUALLY HAS — once, on load.
   *
   * The store keeps the list and the names; the server keeps the messages.
   * This is the one moment they are compared: sessions the server has and the
   * store does not are added with a derived title, sessions the store has and
   * the server does not are kept as empty drafts, and the twelve invented ones
   * this app shipped with are finally swept — but only the ones with no
   * transcript behind them. See `Session.seeded` in the store for why that
   * cannot happen in `migrate()`.
   *
   * ONCE, AND THE REF IS WHY. `reconcileSessions` comes from a context value
   * that is rebuilt on every state change, so an effect that depended on it
   * would fire, write state, get a new function, and fire again — forever. The
   * guard is not an optimisation; without it this is an infinite loop.
   *
   * A failure is silent. The rail already has its sessions from localStorage,
   * and an error banner about a list that is merely not-yet-checked would be
   * noise on top of the sentence the transcript loader is already about to say
   * if the API is really down.
   *
   * IT ALSO GATES ONE SENTENCE, WHICH IS NEW. "There is no session at this
   * address" is a claim about every conversation that exists, and until this
   * has run the store is only the ones this browser has seen — a chat that
   * started on Telegram is real and is not in localStorage. So `railChecked`
   * goes up when the answer lands, and the honest-refusal screen below waits
   * for it. It goes up on a failure too: with the API down the store is the
   * best knowledge available, and the transcript loader is already saying the
   * larger thing.
   */
  const [railChecked, setRailChecked] = useState(false);
  const syncRail = useCallback(
    () =>
      api
        .chatSessions()
        .then((doc) =>
          reconcileSessions(
            doc.sessions.map((s) => ({
              id: s.sessionId,
              /* Straight through, unshortened and unmerged: the children are
                 the server's list of what this chat dispatched, and the store
                 replaces rather than merges them. See `SessionChild`. */
              children: s.children,
              /* The server sends the first thing that was said, up to 200
                 characters. Shortening it to a rail-width label is this side's
                 job — and it is the same function the composer uses to name a
                 new chat, so a conversation gets one name wherever it is
                 named. */
              title: s.title ? sessionTitle(s.title) : "Untitled chat",
            })),
          ),
        )
        .catch(() => {})
        .finally(() => setRailChecked(true)),
    [reconcileSessions],
  );

  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current) return;
    reconciled.current = true;
    void syncRail();
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; see above */
  }, []);

  const refreshBackends = useCallback(() => {
    /* And the agents' modes, from the route that owns that fact. */
    api
      .agents()
      .then((doc) => setModes(Object.fromEntries(doc.agents.map((a) => [a.id, a.mode]))))
      /* Not knowing whether an agent is managed is a missing word, not a
         broken page. The selector still works without it. */
      .catch(() => setModes({}));
    api
      .chatBackends()
      .then(setBackends)
      /* A failure here is the API being down, which the transcript loader
         below is already about to say in a full sentence. Saying it twice on
         one screen is noise. */
      .catch(() => setBackends(null));
  }, []);

  const providerKey = providers?.providers.filter(p => p.live).map(p => `${p.id}:${p.model ?? ""}`).join("|");
  useEffect(() => { refreshBackends(); }, [providerKey, refreshBackends]);
  useEffect(() => {
    if (backends?.readiness?.ready !== false) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") refreshBackends(); }, 3000);
    return () => clearInterval(timer);
  }, [backends?.readiness?.ready, refreshBackends]);

  /**
   * THIS PAGE, LISTENING TO STREAMS IT DID NOT START.
   *
   * A turn's callbacks belong to the render that opened it, and the routing
   * change made that render disposable: leaving for /integrations unmounts
   * this component while the answer keeps arriving, and the page that comes
   * back is a different instance with different setState functions. Without
   * this, that page would show a bubble that never grows and then sit on
   * "Reading this chat…" forever when the turn ended, because the only code
   * that knew the turn was over was closed over a component nobody can see.
   *
   * So the mounted page subscribes, and the stream announces. Two cases:
   *
   *   A DELTA (`ending` null) — repaint, but only if this is the chat on
   *   screen. Everything else is free, which is the whole reason the map is
   *   not state.
   *
   *   AN END — the rows the turn finished with are the transcript, if the
   *   owner is still reading it. If they are not, the words are on the server
   *   and opening the chat again fetches them; what still has to happen is the
   *   RAIL, because a chat that answered while you were elsewhere may have
   *   just been given a name. And a completed turn refreshes the backend state
   *   either way: which agent is live is a fact about the page, not about the
   *   conversation it happened in.
   */
  useEffect(() => {
    const watcher: Watcher = (id, ending) => {
      const here = showing.current === id;
      if (!ending) {
        if (here) forceRepaint();
        return;
      }
      if (here) {
        setConvo({ id, messages: ending.messages, error: null });
        forceRepaint();
      } else {
        void syncRail();
      }
      if (ending.completed) refreshBackends();
      else if (here) {
        /*
          RE-READ THE TRANSCRIPT RATHER THAN KEEPING WHAT IS ON SCREEN.

          Every path that is not `done` ends with the server holding words this
          page does not: a stop, a dead gateway, an error event. It has stored
          them as a PARTIAL assistant row, and that row — with its real id, its
          real timestamp and its flag — is the truth. Reconstructing it here
          from the deltas would put a message on screen that the database does
          not have, which survives exactly until a refresh.
        */
        reread(id);
      }
    };
    watchers.add(watcher);
    return () => {
      watchers.delete(watcher);
    };
  }, [reread, refreshBackends, syncRail]);

  useEffect(() => {
    showing.current = sessionId;
    /*
      LET GO OF ANY READER THAT WAS ONLY WATCHING.

      A flight this page did not start is its VIEW of a turn, not the turn —
      the run belongs to the server and goes on being written whatever this
      browser does. Leaving its socket open for the length of the answer costs
      one of the browser's six per-origin connections for a chat nobody is
      looking at any more, and reopening the chat reattaches from the first
      frame in any case. A turn the owner started HERE is not touched: killing
      that on a glance at another page is the exact bug the module-level flight
      map exists to prevent.
    */
    for (const [id, inFlight] of [...flights]) {
      if (id === sessionId || inFlight.owned) continue;
      inFlight.controller.abort();
    }
    if (!sessionId) {
      refreshBackends();
      return;
    }
    /*
      A CHAT WITH A TURN IN FLIGHT IS NOT RE-READ FROM THE SERVER, and this is
      the guard that makes switching back to a streaming chat work at all. Its
      transcript is the one the flight is carrying — the rows it started
      against, plus the words arriving now — and the server's copy has neither
      the owner's just-sent message nor the sentence being written. Fetching it
      would wipe a live answer off the screen and replace it with the version
      stored before it began.

      It is the same guard the old page-wide `busy` ref was: a chat STARTED by
      the composer creates its session and shows the owner's message
      immediately, which fires this loader for a session the server has never
      heard of. Per session, it now also covers coming back to one.
    */
    if (flights.has(sessionId)) return;
    api
      .chatSession(sessionId)
      .then((doc) => {
        if (showing.current !== sessionId || flights.has(sessionId))
          return;
        setConvo({ id: sessionId, messages: doc.messages, error: null });
        /* The session read carries the backend state with it — one fetch for
           two things wanted at the same instant. */
        setBackends(doc);
        /*
          AND IF IT IS STILL BEING ANSWERED, PICK THE ANSWER BACK UP.

          The transcript above is what was STORED — the question, and any earlier
          turns — and `doc.run` says whether the server is still writing the
          next one. When it is, the flight is rebuilt from the stored rows and
          the run is replayed from its first frame: `since=0`, because a page
          that has just loaded has no words on screen and needs all of them.
          The buffer is on the server, so what arrives is the answer as it was
          watched, tool lines and all, continuing live from wherever it has got
          to.

          It comes from the SAME fetch as the messages, which is what keeps the
          reload from flickering between "cut off" and "still writing".
        */
        if (doc.run && doc.run.status === "running" && doc.run.attachable)
          reattach(sessionId, doc.run, doc.messages);
      })
      .catch((e: unknown) => {
        if (showing.current !== sessionId || flights.has(sessionId))
          return;
        setConvo({
          id: sessionId,
          messages: [],
          error:
            e instanceof Error
              ? e.message
              : "The API did not answer. Is the server running?",
        });
      });
    /* `reattach` is a plain function on the component and is recreated every
       render; listing it would re-run this loader on every render and re-fetch
       the transcript with it. It is called from a promise that has already
       checked `showing.current`, so a stale one cannot write into the wrong
       chat. */
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- see above */
  }, [sessionId, refreshBackends]);

  /*
    Derived, not stored. `convo` holding a different session id means this
    one's transcript has not arrived yet, which is the whole of what "loading"
    means here.
  */
  /**
   * The turn being written in THIS chat, if there is one.
   *
   * Read out of the map on every render rather than held in state, which is
   * what makes coming back to a chat mid-answer show the live buffer instead
   * of the version that was stored before it started. Switching away leaves
   * the answer running — it is still stored when it finishes — and it is not
   * painted over the conversation you moved to, because that conversation is
   * a different key.
   */
  const flight = sessionId ? (flights.get(sessionId) ?? null) : null;

  const settled = convo.id === sessionId;
  /* WHILE A TURN IS IN FLIGHT, ITS OWN COPY OF THE ROWS WINS. `convo` describes
     the chat being looked at and may still be describing the one you switched
     away from; the flight's copy is the only one with the owner's just-sent
     message in it. */
  const messages = flight ? flight.messages : settled ? convo.messages : [];
  const loadError = flight ? null : settled ? convo.error : null;
  /* Reading and answering are different waits. A chat with a turn in flight is
     never "loading": there is nothing being waited for that is not already on
     the screen. */
  const loading = !settled && !flight && sessionId !== null;
  /** Whether the chat ON SCREEN is answering — which is the only sense the
   *  composer's button has. Another chat being busy is not this one being
   *  busy, and that is the point of the whole map. */
  const busyHere = flight !== null;

  /** What the last turn in THIS chat left to say, if anything. A failure
   *  belongs to the chat it happened in: switching away and back should not
   *  show yesterday's timeout under today's question. */
  const note = sessionId ? lastTurn.get(sessionId) : undefined;
  /* Three sources, one banner, in the order they can be true: the turn
     happening now, the turn that just ended, and a menu that would not switch.
     The first two are on the record because a turn outlives this page; the
     third is component state because nobody presses a menu on a page that is
     not there. */
  const failureText =
    flight?.failure ??
    note?.failure ??
    (switchFailure && switchFailure.id === sessionId
      ? switchFailure.text
      : null);
  const waitedMs = note?.queuedMs ?? null;

  /**
   * AN ADDRESS THAT NAMES NO CONVERSATION — the call `Dashboards` makes about
   * a slug that matches no board, for the same reason: showing a different
   * chat, or an empty composer, under a URL somebody asked for is the worst of
   * the answers available.
   *
   * Every clause is load-bearing, and each one is a way of not saying this
   * when it is untrue:
   *
   *   `railChecked` — the store is only the chats this browser has seen until
   *   the server's list has landed. A conversation that started on Telegram
   *   would otherwise be refused for the second it takes to reconcile.
   *
   *   `!loading` — the transcript for this id has been asked for and answered.
   *
   *   `!flight` and `!messages.length` — belt and braces, and the braces
   *   matter: if there ARE words at this address then it is a conversation
   *   whatever the rail thinks, and a screen saying otherwise over the top of
   *   a real transcript would be the worst version of this.
   *
   *   `!loadError` — "the API did not answer" and "there is nothing here" are
   *   different sentences, and only the first one is true when the server is
   *   down. That one is already drawn.
   */
  const known =
    sessionId !== null &&
    state.sessions.some(
      (s) =>
        s.id === sessionId || s.children?.some((c) => c.id === sessionId),
    );
  const noSuchSession =
    sessionId !== null &&
    !known &&
    railChecked &&
    !loading &&
    !flight &&
    !loadError &&
    messages.length === 0;

  /*
    WHILE A SUB-AGENT IS WORKING, THE RAIL AND THIS TRANSCRIPT KEEP UP.

    A run dispatched from a chat turns from running to done minutes later,
    with nobody streaming: the rail child would stay "running" and the report
    the server writes into this conversation (runs/executor.ts,
    `reportToParent`) would sit unseen until a reload. So while any session
    has a queued or running child, the rail is re-read every five seconds —
    and when the OPEN conversation's live children shrink, its transcript is
    re-read once, which is the moment the report has landed.
  */
  const liveChildren = state.sessions
    .flatMap((s) => (s.children ?? []).filter((c) => c.status === "running" || c.status === "queued").map((c) => `${s.id}:${c.id}`))
    .sort()
    .join("|");
  const anyLive = liveChildren.length > 0;
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void syncRail(), 5_000);
    return () => clearInterval(t);
  }, [anyLive, syncRail]);
  /*
    AND CONVERSATIONS THAT STARTED SOMEWHERE ELSE ARRIVE WITHOUT A RELOAD.

    The rail was read once, on load, and again only while THIS browser's own
    sessions had live children. A chat begun on Telegram, on a phone, by the
    nightly rounds or by a script against the API is a real conversation on the
    server and stayed invisible here until somebody pressed reload — so work the
    owner was told was happening could not be watched from the page built for
    watching it. Twenty seconds, and only while the tab is visible: it is one
    indexed read, and a hidden tab has nobody to show it to.
  */
  /* Through a ref, because `syncRail` is rebuilt on every state change and an
     interval keyed on it would be reset by each streamed word and never fire. */
  const syncRailRef = useRef(syncRail);
  syncRailRef.current = syncRail;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void syncRailRef.current();
    }, 20_000);
    return () => clearInterval(t);
  }, []);
  const openLive = sessionId
    ? liveChildren.split("|").filter((k) => k.startsWith(`${sessionId}:`)).length
    : 0;
  const prevOpenLive = useRef(0);
  useEffect(() => {
    if (openLive < prevOpenLive.current && sessionId && !flights.has(sessionId)) {
      reread(sessionId);
      window.dispatchEvent(new Event(WORK_CHANGED));
    }
    prevOpenLive.current = openLive;
  }, [openLive, sessionId, reread]);

  /* New turns arrive at the bottom, which is where the eye is. */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, busyHere]);

  /**
   * A GROWING ANSWER FOLLOWS THE BOTTOM — UNLESS THE OWNER HAS SCROLLED UP.
   *
   * Scrolling to the bottom on every frame of a stream is the behaviour that
   * makes a long answer impossible to read while it is being written: you
   * scroll back to check something and get yanked forward a sixtieth of a
   * second later. So the follow only happens when the view is already within a
   * couple of lines of the end, which is the same rule a terminal uses and the
   * one people already have in their fingers.
   */
  const scroller = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !flight) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 120) el.scrollTop = el.scrollHeight;
    /* The record is MUTATED in place, so the object identity never changes and
       cannot be the dependency that matters. Its text and its tool count are
       values, and they are what moves the bottom of the page. */
  }, [flight, flight?.text, flight?.tools.length]);

  /* ------------------------------------------------------------- sending */

  /**
   * PICK UP AN ANSWER THIS PAGE DID NOT ASK FOR.
   *
   * Called when a conversation is opened and the server says a run is still
   * writing into it — after a reload, in a second tab, or on the phone that was
   * not the device the question was typed on. It builds the same record a
   * `send` would have built, from the rows the transcript already has, and
   * hands it the reattach door instead of the composer's.
   *
   * `since` IS 0 AND NOT THE RUN'S `lastSeq`. The two are different requests:
   * "give me the tail" is for a client that was reading and dropped, and
   * "give me the whole turn" is for one that has just arrived with an empty
   * bubble. This is always the second — the words are not on screen, so
   * resuming from the end would show a paragraph that begins in the middle.
   *
   * GUARDED, because two effects can race: a rail click and a URL change can
   * both land on the same session in one tick, and two flights for one chat
   * would be two readers writing into one buffer.
   */
  function reattach(id: string, run: ChatRunState, stored: ChatMessage[]) {
    if (flights.has(id)) return;
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      runId: run.runId,
      stopRequested: false,
      owned: false,
      text: "",
      reasoning: "",
      tools: [],
      /* When the TURN started, not when this page found it. The field is what a
         "still going after two minutes" line would be measured from, and
         measuring it from the reload would restart that clock. */
      startedAt: Date.parse(run.startedAt) || Date.now(),
      messages: [...stored],
      queuedMs: null,
      failure: null,
    };
    flights.set(id, flight);
    pending.delete(id);
    lastTurn.delete(id);
    /* The rail's mark, from the moment this page knows there is an answer
       coming — the same fact `send` sets, arrived at from the other direction. */
    setSessionStreaming(id, true);
    forceRepaint();

    void consume(
      id,
      flight,
      (handlers, signal) => attachChatRun(run.runId, 0, handlers, signal),
      null,
    );
  }

  /**
   * READ ONE TURN'S EVENTS INTO A FLIGHT, whichever door they came through.
   *
   * TWO DOORS AND ONE BODY, which is the whole reason this is a function. A
   * turn arrives here either because this page asked the question — `POST
   * /chat/stream`, the composer's door — or because the page was RELOADED
   * while an answer was being written and reattached to it — `GET
   * /chat/runs/<id>/events`, which replays the buffer and then continues live.
   * Those two produce identical events, and the moment they had two readers
   * they would begin to differ: the reattached one would merge a tool call
   * slightly differently, or forget to flush before applying an offset, and a
   * refresh would quietly redraw a transcript that had been right.
   *
   * So `open` is the only difference. Everything below — the buffering, the
   * tool merge, what a failure leaves behind, who is told — happens once.
   */
  async function consume(
    id: string,
    flight: Flight,
    open: (handlers: ChatRunHandlers, signal: AbortSignal) => Promise<void>,
    /** The negative id of the row put on screen before the server answered, or
     *  null when reattaching — there is nothing optimistic about a question the
     *  transcript already contains. */
    optimisticId: number | null,
  ) {
    /* Whether a `done` arrived. Everything else — a stop, a dead gateway, an
       error event — is the other case, and it has one recovery: re-read the
       transcript, because the server has already written down whatever was
       said, flagged partial. */
    let completed = false;

    try {
      await open(
        {
          /*
            THE RUN'S ID, WHICH IS WHAT THE STOP BUTTON NEEDS. Closing a socket
            no longer stops an answer — the server owns the turn — so cancelling
            is a request, and this is the only place the id arrives on the
            composer's door. A stop pressed before it got here is remembered on
            the record and sent the moment it does.
          */
          onRun: (e) => {
            flight.runId = e.runId;
            if (flight.stopRequested) void cancelChatRun(e.runId).catch(() => {});
          },

          onStart: (e) => {
            if (e.runId) {
              flight.runId = e.runId;
              if (flight.stopRequested) void cancelChatRun(e.runId).catch(() => {});
            }
            /*
              The optimistic row is replaced by the STORED one the moment the
              server confirms it. Not cosmetic: the optimistic id is negative
              and the real one is a row in the database, and a transcript that
              keeps the fake id would break the moment anything wanted to
              address that message.
            */
            if (optimisticId !== null)
              flight.messages = flight.messages.map((m) =>
                m.id === optimisticId ? e.user : m,
              );
            announce(id);
          },

          onDelta: (chunk) => {
            buffer(id).text += chunk;
            schedule();
          },

          onChild: () => {
            /* Filed under this chat a moment ago: show it now, not when the
               answer ends. */
            void syncRail();
            window.dispatchEvent(new Event(WORK_CHANGED));
          },
          onReasoning: (chunk) => {
            buffer(id).reasoning += chunk;
            schedule();
          },

          onTool: (e) => {
            /*
              FLUSHED FIRST. The tool's `offset` is measured against the whole
              answer, and applying it while a frame's worth of text is still
              sitting in the buffer would put the grey line in front of words
              that were written before it. One frame of wrongness that corrects
              itself is still a frame of wrongness that somebody sees.
            */
            flush();
            const at = flight.tools.findIndex(
              (x) => x.toolCallId === e.toolCallId,
            );
            /* Merged exactly as the server merges them before storing, so the
               live drawing and the reloaded one cannot differ. A NEW array
               each time rather than a push: the list is a prop of a memoised
               body, and a mutated array is a change React cannot see. */
            if (at === -1) {
              flight.tools = [
                ...flight.tools,
                {
                  toolCallId: e.toolCallId,
                  tool: e.tool,
                  label: e.label,
                  emoji: e.emoji,
                  startedAt: e.at,
                  finishedAt: e.status === "completed" ? e.at : null,
                  offset: e.offset,
                },
              ];
            } else {
              const tools = [...flight.tools];
              tools[at] = {
                ...tools[at],
                finishedAt:
                  e.status === "completed" ? e.at : tools[at].finishedAt,
                label: tools[at].label ?? e.label,
                emoji: tools[at].emoji ?? e.emoji,
              };
              flight.tools = tools;
            }
            announce(id);
          },

          onDone: (e) => {
            completed = true;
            flush();
            /* The STORED row, not the accumulated text. The database's copy is
               the one that will be there after a reload, and drawing anything
               else for the last three seconds of a turn is a transcript that
               changes when you refresh it. */
            flight.messages = [...flight.messages, e.message];
            /* Only if the server said so — the field is optional on the
               handler for the reason written there, and a queue this turn
               never waited in is not something to report. */
            if (typeof e.queuedMs === "number" && e.queuedMs > 0)
              flight.queuedMs = e.queuedMs;
            announce(id);
          },

          onError: (e) => {
            /* The server has already written the partial row by the time this
               arrives — that ordering is its guarantee — so there is nothing
               to keep on screen here. The reload below picks up what was
               stored, flagged as cut off.

               A CANCEL IS NOT A FAILURE. The owner pressed the button; the
               answer so far is about to appear as a partial message, which says
               everything the interface needs to, and a red banner under it
               would be the page reporting the owner to themselves. */
            if (!e.cancelled) flight.failure = e.message;
            announce(id);
          },
        },
        flight.controller.signal,
      );
    } catch (e: unknown) {
      /*
        A REFUSAL, OR A DETACH. `chatStream` throws for the errors that happen
        BEFORE the stream opens — no agent live, message too long, API down —
        and for an abort. An abort no longer means the turn stopped: it means
        this page stopped READING it, which is not a failure and gets no banner.
        That happens for real when the owner leaves a chat this page had only
        reattached to — see the session effect above, which lets go of readers
        it did not start.

        The failure goes on the RECORD whether or not this chat is the one on
        screen — and it is only ever drawn under the chat it happened in, so a
        chat that failed while the owner was reading another one says so when
        it is opened rather than failing silently. It survives on `lastTurn`
        after the record is dropped, which is what lets it survive this page
        being unmounted altogether.
      */
      const detached = flight.controller.signal.aborted;
      if (!detached)
        flight.failure =
          e instanceof Error
            ? e.message
            : "The message did not get through, and nothing said why.";
      /*
        A 503 is "no agent is live", which may have become true since the page
        loaded — somebody disconnected the plugin in another tab. The banner is
        driven by the backend state, so it has to be re-read or the page keeps
        offering a composer for an agent that is gone.
      */
      if (e instanceof ApiError && e.status === 503) refreshBackends();
    } finally {
      /*
        EVERYTHING STILL BUFFERED GOES IN BEFORE THE RECORD IS DROPPED —
        including other chats', which costs nothing: `flush` is the one frame
        they were already waiting for, and a buffer whose record has gone is
        discarded by it rather than stranded.
      */
      flush();
      flights.delete(id);
      pending.delete(id);
      /* What the turn leaves for the chat to say next time it is looked at.
         Set even when both fields are null, because "this chat's last turn is
         over and had nothing to report" is the thing that clears a banner from
         the turn before it. */
      lastTurn.set(id, {
        failure: flight.failure,
        queuedMs: flight.queuedMs,
      });
      setSessionStreaming(id, false);

      /*
        AND THE PAGE IS TOLD, RATHER THAN WRITTEN TO DIRECTLY.

        Everything above is a fact about the conversation and happens wherever
        this code is running. What comes next — put these rows on screen,
        re-read the transcript, refresh the backends — is a fact about a page,
        and by now there may be no page, or a DIFFERENT page from the one that
        pressed Send: leaving for /integrations mid-answer unmounts this
        component and the answer keeps arriving. Calling this instance's own
        setState here would be writing into a component nobody can see, which
        is silent, and would leave the page that IS up waiting forever for a
        turn it has no way of knowing has ended.

        So the ending is announced. The watcher above decides what it means for
        whatever is actually on screen; if nothing is, the rail is still re-read
        here, because a chat that answered while the owner was on another page
        may have just been given a name.
      */
      if (!announce(id, { messages: flight.messages, completed })) {
        void syncRail();
      }
    }
  }

  async function send() {
    const trimmed = text.trim();
    /*
      A CHAT THAT IS ALREADY ANSWERING DOES NOT TAKE A SECOND QUESTION — and
      that is the ONLY thing refused. NOT a page-wide `sending` flag, which
      would also refuse a question put to a DIFFERENT chat while any answer
      anywhere was being written. There is one record per session, so the
      composer of a quiet chat works while three others are streaming.
    */
    if (!trimmed || (sessionId && flights.has(sessionId))) return;

    /*
      A SESSION IS CREATED ONLY WHEN THERE IS NOT ONE ALREADY, and being at `/`
      is what makes that happen — no id in the address is the empty composer,
      and this is the line that finally makes the row, on the first thing said
      and named after it. The old mock made a new session on EVERY send, which
      was harmless when nothing was stored and would now start a fresh
      conversation with every sentence, the agent losing the thread between one
      message and the next.

      The title comes from the same rule the rail uses when a conversation
      arrives from the server with no name in the store — one function, so a
      chat started here and the same chat seen from another door get one name.
    */
    const id =
      sessionId ?? addSession(sessionTitle(trimmed), target?.id ?? null).id;
    showing.current = id;

    setText("");
    setSwitchFailure(null);
    /* Last time's failure and last time's queue wait are about last time. */
    lastTurn.delete(id);

    /*
      The owner's own words go on screen immediately, with a negative id so it
      cannot collide with a real row. The server stores the user message BEFORE
      it asks the agent, so this optimistic row is replaced by a real one that
      is genuinely there — including when the turn then fails, which is exactly
      when somebody wants their question back.
    */
    const optimistic: ChatMessage = {
      id: -Date.now(),
      ts: new Date().toISOString(),
      role: "user",
      content: trimmed,
      backend: null,
      channel: "web",
      model: null,
      usage: null,
      ms: null,
      tools: null,
      partial: false,
    };

    /*
      THE RECORD, MADE BEFORE THE REQUEST LEAVES.

      One fact, read by everything downstream: the loader's guard, the
      composer's button, the rail's mark, and the bubble the answer grows into.
      The alternative — a boolean for busy, a controller in one ref, a bubble
      in state — is four things that have to be kept in step, and they were
      exactly the four that could only ever describe one conversation.

      Its `messages` are the rows on screen for THIS chat plus the question
      just asked. They live on the record rather than in `convo` because
      `convo` is about the chat being LOOKED AT, and this one may stop being
      that a second from now.
    */
    const controller = new AbortController();
    const flight: Flight = {
      controller,
      runId: null,
      stopRequested: false,
      owned: true,
      text: "",
      reasoning: "",
      tools: [],
      startedAt: Date.now(),
      messages: [...(convo.id === id ? convo.messages : []), optimistic],
      queuedMs: null,
      failure: null,
    };
    flights.set(id, flight);
    pending.delete(id);
    /* The rail's mark, from the moment the request leaves rather than from the
       first byte: what it reports is "this chat is answering", and that is
       true while the gateway is still deciding to say anything. */
    setSessionStreaming(id, true);

    /*
      THE NEW CHAT TAKES ITS OWN ADDRESS, the moment it has one.

      REPLACE, NOT PUSH. `/` and the conversation it just became are one place
      — the composer did not move, it acquired a name — so a history entry
      between them would give Back a step that leads to an empty composer for a
      chat that now exists, one press away from the page the owner actually
      came from.

      AFTER THE RECORD IS IN THE MAP, deliberately. Navigating re-runs the
      transcript loader for this id, and the only thing that stops it fetching
      a conversation the server has not been told about yet — and painting its
      empty answer over the question just asked — is finding the flight
      already there. React batches both into one render, so the order is not
      strictly load-bearing today; it is written this way so that it cannot
      become load-bearing later without somebody noticing.
    */
    if (!sessionId) navigate(`/chat/${encodeURIComponent(id)}`, { replace: true });
    forceRepaint();

    /*
      THE VENTURE GOES WITH THE QUESTION, not with the session.

      It is read from the picker at the moment of sending rather than from the
      session's stored `ventureId`, because the picker is what the owner just
      looked at — changing it and asking is one gesture. The server turns it
      into one system turn of context (name, stage, what the owner said it is)
      and stores none of it, so a chat re-filed tomorrow does not carry today's
      answer to "how is it doing".
    */
    await consume(
      id,
      flight,
      (handlers, signal) =>
        api.chatStream(id, trimmed, handlers, signal, target?.id ?? null),
      optimistic.id,
    );
  }

  /**
   * Stop the agent mid-answer — THIS chat's answer, and no other.
   *
   * A REQUEST, NOT AN ABORT. Closing the socket does nothing: a turn is the
   * server's work and survives a closed tab, so the disconnect-cancels-the-run
   * chain is deliberately broken. Stopping is
   * `POST /chat/runs/<id>/cancel`, and aborting the fetch would now only mean
   * this page stopped watching an answer that kept being written.
   *
   * WHAT WAS SAID IS STILL KEPT: the server writes the partial row before it
   * reports the run cancelled, exactly as it did before.
   *
   * A STOP PRESSED BEFORE THE RUN HAS AN ID is remembered rather than dropped.
   * There is a moment between the request leaving and the `run` frame arriving,
   * and a button that did nothing in it would be a button that occasionally
   * does nothing — which is worse than one that is slow, because nobody can
   * tell which press was the one that missed.
   *
   * A CHAT THAT IS NOT ON SCREEN HAS NO STOP BUTTON, deliberately. The control
   * lives in the composer, the composer belongs to the conversation being
   * read, and a button that stopped an answer somewhere you could not see it
   * would be the one control on this page whose effect is invisible. Open the
   * chat, then stop it — the rail says which ones are still going.
   */
  function stop() {
    if (!sessionId) return;
    const inFlight = flights.get(sessionId);
    if (!inFlight) return;
    inFlight.stopRequested = true;
    if (inFlight.runId) void cancelChatRun(inFlight.runId).catch(() => {});
  }

  async function chooseBackend(id: ChatBackendId | null) {
    try {
      setBackends(await api.setChatBackend(id));
      setSwitchFailure(null);
    } catch (e: unknown) {
      /* Reported against the session being looked at, so it appears where the
         click happened. With no session open there is nothing to attach it to
         and the selector simply stays where it was — a menu that did not move
         is its own report that the switch did not take. */
      if (sessionId)
        setSwitchFailure({
          id: sessionId,
          text: e instanceof Error ? e.message : "Could not change the backend.",
        });
    }
  }

  /* --------------------------------------------------------------- parts */

  const live = backends?.live ?? null;
  const noAgent = backends !== null && live === null;
  /** Who takes the message when no agent does. Null with `noAgent` true is the
   *  only state in which the composer cannot be used at all. */
  const fallback = backends?.fallback ?? null;

  /**
   * "QUEUED", SAID ONLY WHERE IT IS KNOWN TO BE TRUE.
   *
   * With no agent live the turn goes through `models/provider.ts`, which holds
   * a gate: in `series` mode a second call WAITS for a slot before it is sent,
   * and this page would otherwise sit on "thinking…" for as long as the first
   * answer takes — indistinguishable, to somebody watching, from hung. Naming
   * the wait is the difference between a queue and a bug.
   *
   * IT IS NOT CLAIMED WHEN AN AGENT IS ANSWERING. Hermes is somebody else's
   * gateway with its own idea of how many calls it takes at once, and nothing
   * on this side can tell whether a second question is waiting or being worked
   * on. A guess would put a wrong explanation on screen, which is worse than
   * the honest "thinking…" it would have replaced.
   *
   * The condition is "this turn has produced nothing yet, another turn is in
   * flight, and the gate cannot be holding them both" — which is exactly when
   * the silence has a cause worth naming.
   */
  const gate = providers?.providers.find((p) => p.live)?.policy ?? null;
  const othersInFlight = flights.size - (flight ? 1 : 0);
  const queuedHere =
    busyHere &&
    !flight?.text &&
    !flight?.reasoning &&
    !flight?.tools.length &&
    othersInFlight > 0 &&
    live === null &&
    gate !== null &&
    othersInFlight >= (gate.mode === "series" ? 1 : gate.concurrency);

  const picker = (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13.5px]">
        {target ? (
          <VentureMark venture={target} size={14} />
        ) : (
          <FolderClosed className="size-3.5" strokeWidth={1.6} />
        )}
        {target?.name ?? "No venture"}
        <ChevronDown className="size-[13px]" strokeWidth={1.6} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onSelect={() => setTargetId(null)}>
          <span className="border-border size-[7px] shrink-0 rounded-[3px] border" />
          No venture
        </DropdownMenuItem>
        {state.ventures.map((v) => (
          <DropdownMenuItem key={v.id} onSelect={() => setTargetId(v.id)}>
            {/* The site's own icon where there is one, the colour square where
                there is not — the same mark this venture wears everywhere
                else, so the row is recognised rather than read. */}
            <VentureMark venture={v} size={14} />
            {v.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/* A PAGE, NOT A DIALOG, and it takes you off this screen on purpose:
            a venture wants a stage and a website, and asking for those in a
            box over a half-typed question was how the stage ended up being
            whatever the dialog defaulted to. */}
        <DropdownMenuItem onSelect={() => navigate("/ventures/new")}>
          <Plus className="size-4" strokeWidth={1.6} />
          New venture
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /*
    THE BACKEND SELECTOR, WHICH EXISTS TO MAKE ONE RULE VISIBLE.

    Both agents can be connected; exactly one answers. A row of toggles would
    imply otherwise, so this is a single-choice menu with a tick against the
    live one — the shape a radio group has, in the dropdown the header already
    uses. A connected agent that is not live reads "ready", which is the true
    state and the one that tells the owner the switch is one click away rather
    than a credential away.

    A backend with no credentials is shown and disabled rather than hidden.
    Hiding it would make the Integrations page the only way to discover that
    the other agent exists at all.
  */
  const selector = (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13.5px]">
        <Bot className="size-3.5" strokeWidth={1.6} />
        {live ? BACKEND_NAMES[live] : "No agent"}
        <ChevronDown className="size-[13px]" strokeWidth={1.6} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-muted-foreground text-[12.5px] font-normal">
          One agent answers. Connected is not the same as live.
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(backends?.backends ?? []).map((b) => (
          <DropdownMenuItem
            key={b.id}
            disabled={!b.connected}
            onSelect={() => b.connected && void chooseBackend(b.id)}
          >
            <Check
              className={cn("size-3.5 shrink-0", !b.live && "opacity-0")}
              strokeWidth={2}
            />
            <span className="flex-1">{BACKEND_NAMES[b.id]}</span>
            <span className="text-muted-foreground text-[12.5px]">
              {/* MANAGED or REMOTE beside each, because the two are not the
                  same thing to be talking to: one is a process this app
                  installed and supervises, the other is somebody else's box. */}
              {!b.connected
                ? "not connected"
                : `${modes[b.id] ? `${modes[b.id]} · ` : ""}${b.live ? "live" : "ready"}`}
            </span>
          </DropdownMenuItem>
        ))}
        {live && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void chooseBackend(null)}>
              <span className="size-3.5 shrink-0" />
              Turn the agent off
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/integrations">
            <Plug className="size-3.5" strokeWidth={1.6} />
            Connect an agent
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const hasChat = messages.length > 0 || busyHere;

  /*
    NOTHING LIVES AT THIS ADDRESS, SAID PLAINLY.

    A deleted chat, a link from another machine, a typo in the bar. It is not
    redirected to a new chat and it does not draw an empty composer: both would
    answer a question nobody asked, and the second is worse, because the next
    thing typed would silently start a conversation under an id somebody else
    had once. The rail is still there and every chat that DOES exist is one
    click away in it, which is why this offers one link rather than listing
    them — `Dashboards` has to list its boards because it has no rail.

    A RETURN, NOT A DIFFERENT ROUTE. Every hook above has already run, and this
    component must not be swapped out for another: the map of turns in flight
    now outlives a mount, but the page that draws them has to stay the same
    element for React to keep it. An unknown id is a thing this page SAYS, not
    a place the router goes.
  */
  if (noSuchSession)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="max-w-[380px] text-center">
          <h1 className="text-[20px] font-normal tracking-[-0.02em]">
            No session at this address
          </h1>
          <p className="text-muted-foreground mt-1.5 text-[14px] leading-relaxed">
            Nothing here is called “{sessionId}”. It may have been deleted, or
            the link may be from another browser. Every conversation you do have
            is in the rail.
          </p>
          <div className="mt-4 flex justify-center">
            <Link
              to="/"
              className="hover:bg-accent rounded-lg border px-2.5 py-1.5 text-[13.5px]"
            >
              Start a new chat
            </Link>
          </div>
        </div>
      </div>
    );

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 px-4.5">
        {picker}
        <div className="ml-auto flex items-center gap-0.5">
          {selector}
          <Link
            to="/dashboards"
            className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg p-2"
          >
            <LayoutDashboard className="size-3.5" strokeWidth={1.6} />
          </Link>
          <Link
            to="/integrations"
            className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg p-2"
          >
            <Plug className="size-3.5" strokeWidth={1.6} />
          </Link>
        </div>
      </header>

      <section
        ref={scroller}
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-6",
          hasChat ? "items-center" : "items-center justify-center",
        )}
      >
        <div className="w-full max-w-[760px]">
          {/*
            NO AGENT IS LIVE — SAID PLAINLY, WITH SOMEWHERE TO GO.

            The alternative every chat UI reaches for is to accept the message
            and fail afterwards, which teaches the owner that the composer
            sometimes works. `why` is the server's own sentence and distinguishes
            "nothing is chosen" from "the chosen one has no credentials", which
            are two different walks to two different places.
          */}
          {/*
            NO AGENT — WHICH IS NOW TWO DIFFERENT SITUATIONS, AND THE BANNER
            SAYS WHICH.

            With a provider live this is not a warning at all: the composer
            works, the message gets an answer, and the only thing the owner
            needs to know is that there is no agent in front of the model — no
            tools, no memory beyond this transcript — so an answer that says "I
            cannot look that up" is telling the truth rather than failing. It
            is drawn as a plain note with a Cpu rather than a warning triangle,
            because a triangle over a working composer teaches the owner to
            ignore triangles.

            With nothing live at all it is the original warning, and `why` is
            the server's own sentence: "nothing is chosen" and "the chosen one
            has no credentials" are two different walks to two different pages.
          */}
          {noAgent && (
            <div className="border-line-strong bg-card mb-5 flex items-start gap-2.5 rounded-[14px] border px-4.5 py-3.5">
              {fallback ? (
                <Cpu
                  className="text-muted-foreground mt-0.5 size-4 shrink-0"
                  strokeWidth={1.6}
                />
              ) : (
                <TriangleAlert
                  className="text-muted-foreground mt-0.5 size-4 shrink-0"
                  strokeWidth={1.6}
                />
              )}
              <p className="text-[13.5px]">
                {fallback ? (
                  <>
                    <span className="font-medium">
                      Talking to {fallback.label} directly — no agent in front of
                      it.
                    </span>{" "}
                    <span className="text-muted-foreground">
                      Answers come straight from the model: no tools, no memory
                      beyond this conversation.{" "}
                    </span>
                    <Link to="/integrations" className="underline underline-offset-2">
                      Connect an agent
                    </Link>
                  </>
                ) : (
                  <>
                    <span className="font-medium">Nothing is live.</span>{" "}
                    <span className="text-muted-foreground">
                      {backends?.why ??
                        "Connect Hermes or OpenClaw and choose one as the chat backend, or choose a model provider."}{" "}
                    </span>
                    <Link to="/integrations" className="underline underline-offset-2">
                      Open Integrations
                    </Link>
                  </>
                )}
              </p>
            </div>
          )}

          {loadError && (
            <div className="border-line-strong bg-card mb-5 rounded-[14px] border px-4.5 py-3.5 text-[13.5px]">
              <span className="font-medium">This chat could not be read.</span>{" "}
              <span className="text-muted-foreground">{loadError}</span>
            </div>
          )}

          {!hasChat && (
            <>
              <h1 className="mb-1.5 text-[27px] font-normal tracking-[-0.025em]">
                {greeting()}, {state.workspace.owner}.{" "}
                <span className="text-muted-foreground">
                  What are we shipping?
                </span>
              </h1>
              <p className="text-muted-foreground mb-6 text-[14.5px]">
                {loading
                  ? "Reading this chat…"
                  : "Picked from your workspace. Fresh every day."}
              </p>

              <DailySuggestions ventureId={targetId} onChoose={suggestion => {
                setTargetId(suggestion.ventureId);
                setText(suggestion.prompt);
                inputRef.current?.focus();
              }} />
            </>
          )}

          {hasChat && (
            <div className="flex flex-col gap-5 pb-2">
              {messages.map((m) =>
                m.role === "user" ? (
                  /*
                    THE OWNER'S OWN WORDS STAY PLAIN TEXT. Not markdown, and
                    that is deliberate: a person who types `*` means an
                    asterisk, and a pasted stack trace that quietly becomes a
                    bulleted list is the interface editing what somebody said.
                    Whitespace is preserved for the same reason.
                  */
                  <div key={m.id} className="flex justify-end">
                    <div className="bg-card max-w-[85%] rounded-[16px] px-4.5 py-3 text-[14.5px] whitespace-pre-wrap">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id}>
                    {m.report ? (
                      <ReportCard report={m.report} />
                    ) : (
                      <AssistantBody text={m.content.trim()} tools={m.tools} />
                    )}
                    {/*
                      A CUT-OFF ANSWER SAYS SO, EVERY TIME IT IS READ.

                      The words above are real — the agent said them and the
                      owner watched them arrive — but they are not the whole
                      answer, and a transcript that drew them like one would be
                      lying quietly and forever. This is why the row was stored
                      at all rather than dropped: half an answer, labelled, is
                      worth more than a gap where a conversation was.
                    */}
                    {m.partial && (
                      <p className="text-muted-foreground mt-1 text-[12.5px]">
                        <TriangleAlert
                          className="mr-1 inline size-3 align-[-1px]"
                          strokeWidth={1.8}
                        />
                        Cut off before the agent finished — this is what it had
                        said.
                      </p>
                    )}
                  </div>
                ),
              )}

              {/*
                THE ANSWER BEING WRITTEN. The same body renderer the stored
                messages use, so a live turn and a reloaded one cannot look
                different — the only thing that changes when the `done` event
                lands is where the text is coming from.
              */}
              {flight && (flight.text || flight.reasoning || flight.tools.length) ? (
                <div>
                  <AssistantBody text={flight.text} tools={flight.tools} reasoning={flight.reasoning || null} />
                </div>
              ) : null}

              {/* Before the first content arrives, the wait gets a sentence
                  that names who is answering,
                  because that is the thing worth knowing while you wait. When
                  the wait is a QUEUE rather than an agent thinking, it says
                  that instead: silence with a known cause is not the same
                  screen as silence. */}
              {busyHere &&
                !flight?.text &&
                !flight?.reasoning &&
                !flight?.tools.length && (
                <p className="text-muted-foreground text-[13.5px]">
                  {queuedHere
                    ? "Queued behind another reply — this provider completes one at a time."
                    : `${backends?.liveLabel ?? fallback?.label ?? "The agent"} is thinking…`}
                </p>
              )}

              {/* How long it waited for a slot, when the server said — beside
                  the answer it delayed rather than in a settings panel, because
                  "the model is slow" and "the queue was long" are different
                  complaints and only one of them is about the model. */}
              {waitedMs !== null && (
                <p className="text-muted-foreground text-[12.5px]">
                  Waited {duration(waitedMs)} for a model slot before
                  that answer could start.
                </p>
              )}

              {failureText && (
                <div className="border-line-strong bg-card rounded-[14px] border px-4.5 py-3.5 text-[13.5px]">
                  <span className="font-medium">That did not get an answer.</span>{" "}
                  <span className="text-muted-foreground">{failureText}</span>
                </div>
              )}

              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </section>

      <div className="flex shrink-0 justify-center px-6 pt-5 pb-5.5">
        <div className="w-full max-w-[760px]">
          <CommandBar
            value={text}
            onChange={setText}
            onSend={() => void send()}
            onStop={stop}
            onAttach={() => attachmentRef.current?.click()}
            busy={busyHere}
            inputRef={inputRef}
            error={draftError || attachmentError}
            placeholder={noAgent && !fallback
              ? "Connect an agent…"
              : "Ask anything…"}
          />
          <input ref={attachmentRef} hidden type="file" accept="text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.html,.css,.yaml,.yml,.log" onChange={async e => {
            const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
            if (file.size > 100_000) { setAttachmentError("Choose a text file smaller than 100 KB."); return; }
            try {
              const content = await file.text();
              if (content.includes("\0")) throw new Error("Choose a text file; binary attachments are not supported.");
              setText(previous => `${previous}\n\nAttached file: ${file.name}\n${content}`); setAttachmentError(null); inputRef.current?.focus();
            } catch (error) { setAttachmentError(String(error)); }
          }} />
          <div className="chat-command-context">
            {picker}
            <Link to="/integrations"
              className="hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px]">
              <Plug className="size-[14px]" strokeWidth={1.6} />
              Integrations
            </Link>
          </div>
          {/*
            The footer says which agent is answering, because the composer is
            where somebody is about to spend one. It keeps the original
            sentence when nothing is connected — the rail is still the truth
            about where a chat lands.
          */}
          <p className="text-muted-foreground mt-2.5 text-center text-[12.5px]">
            {backends?.readiness?.ready === false
              ? backends.readiness.reason
              : backends?.liveLabel
              ? `${backends.liveLabel} is ready. Uses your shared LLM selection.`
              : fallback
                ? `${fallback.label} is answering directly, across ${fallback.endpoints} endpoint${fallback.endpoints === 1 ? "" : "s"}. No agent, so no tools.`
                : "Chats save automatically. Choosing a venture is optional."}
          </p>
        </div>
      </div>
    </>
  );
}
