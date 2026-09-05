/**
 * THE CHAT PAGE — the one place in this app that talks to an agent.
 *
 * It used to be a mock: a composer, four opener cards, and a `send` that put a
 * title in the session rail and threw the text away. Everything below the
 * composer is now real, and the shape of the page is deliberately unchanged —
 * the openers still sit under the greeting until there is a conversation, the
 * rail still gets a session on the first message, the venture picker still
 * does what it did.
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
 * 3. STOPPING IS AN ABORT, END TO END. One `AbortController`: aborting it
 *    closes the fetch body, which the server sees as a disconnect, which
 *    aborts its own call to the agent. Nothing is lost by stopping — the
 *    server stores what was said as a PARTIAL answer, and this page reloads
 *    the transcript to pick it up rather than keeping its own copy of it.
 *
 * 4. THE RAIL IS RECONCILED AGAINST THE SERVER ON LOAD. The session list is
 *    still the store's, and it is still in localStorage — but it is now
 *    checked against the conversations that actually exist. That is also how
 *    the twelve invented sessions this app shipped with are retired: they are
 *    marked by the store's `migrate()` and swept here, once it is known which
 *    of them have real transcripts behind them. See `Session.seeded`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUp,
  Bot,
  Brain,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Cpu,
  FolderClosed,
  LayoutDashboard,
  Plug,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Square,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { VentureDialog } from "@/components/VentureDialog";
import { Markdown } from "@/components/Markdown";
import { ToolCallLine } from "@/components/ToolCallLine";
import {
  ApiError,
  api,
  type ChatBackendId,
  type ChatBackends,
  type ChatMessage,
  type ChatToolCall,
  type MessageBackendId,
  type ModelProviders,
  type ProviderId,
} from "@/lib/api";

const SUGGESTIONS = [
  {
    icon: Sparkles,
    title: "Explore starter templates",
    desc: "Standard startup scaffolds, ready to fork",
    prompt:
      "Explore standard startup templates and show me what fits a solo founder.",
  },
  {
    icon: Wrench,
    title: "Build a new feature",
    desc: "Plan it, scaffold it, wire it up",
    prompt: "Help me build a new feature. Start by asking what the feature is.",
  },
  {
    icon: Code2,
    title: "Review code",
    desc: "Catch bugs and rough edges before merge",
    prompt: "Review the code on my current branch and flag anything risky.",
  },
  {
    icon: Bug,
    title: "Fix an issue",
    desc: "Paste an error, trace it to the cause",
    prompt: "Here's a failing test / error. Help me fix it.",
  },
];

const BACKEND_NAMES: Record<ChatBackendId, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

const PROVIDER_NAMES: Record<ProviderId, string> = {
  freellmapi: "FreeLLMAPI",
  local: "Local model",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

/**
 * WHO WROTE THIS MESSAGE, and the two kinds of author are named differently on
 * purpose.
 *
 * An AGENT answered with tools and memory behind it; a PROVIDER answered as a
 * bare completion because no agent was live. Reading a transcript six weeks
 * later, "Hermes" and "Local model, direct" are two different claims about
 * what that answer was capable of being, and collapsing them into one name
 * would be the same lie the two agents already refuse to tell about each
 * other.
 */
function authorName(backend: MessageBackendId | null): string {
  if (!backend) return "Agent";
  if (backend.startsWith("provider:"))
    return `${PROVIDER_NAMES[backend.slice("provider:".length) as ProviderId]}, direct`;
  return BACKEND_NAMES[backend as ChatBackendId];
}

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
}: {
  text: string;
  tools: ChatToolCall[] | null;
}) {
  const parts = splitByTools(text, tools ?? []);
  return (
    <>
      {parts.map((part, i) =>
        part.call ? (
          <ToolCallLine key={`${part.call.toolCallId}-${i}`} call={part.call} />
        ) : (
          <Markdown key={i} text={part.text} />
        ),
      )}
    </>
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
        className="text-muted-foreground hover:bg-accent hover:text-foreground -mx-1.5 flex items-center gap-1.5 rounded-[7px] px-1.5 py-1 text-[12px] transition-colors"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          strokeWidth={1.8}
        />
        <Brain className="size-3.5 shrink-0" strokeWidth={1.6} />
        {done ? "Thought about it" : "Thinking…"}
      </button>
      {open && (
        <p className="text-muted-foreground border-line-soft mt-1 ml-4 border-l pl-3 text-[12px] leading-[1.55] whitespace-pre-wrap">
          {text.trim()}
        </p>
      )}
    </div>
  );
}

/**
 * The turn being written, right now, on this page.
 *
 * Kept OUT of `convo.messages` on purpose. Merging it in would need an id and
 * a timestamp the database has not issued yet, and every piece of code that
 * touches the list would then have to know which rows are real. Separate, it
 * is obvious: these are the stored messages, and this is the one still being
 * said.
 */
type LiveTurn = {
  /** Which session it belongs to. Switching chats mid-answer must not paint
   *  the new chat with the old one's words. */
  sessionId: string;
  text: string;
  reasoning: string;
  /** Merged as the events arrive: `running` creates the record, `completed`
   *  closes it, exactly as the server does before storing them. */
  tools: ChatToolCall[];
};

export function Chat() {
  const { state, addSession, reconcileSessions } = useStore();
  const [text, setText] = useState("");
  // Empty is a real answer: most chats are about nothing in particular.
  // Settings → General presets this; the picker still overrides it per chat.
  const [targetId, setTargetId] = useState<string | null>(
    state.workspace.defaultVentureId,
  );
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const target = state.ventures.find((v) => v.id === targetId);
  const sessionId = state.activeSessionId;

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

  const [sending, setSending] = useState(false);
  /** The last send's failure, in the server's own words, tagged with the
   *  session it happened in. Deliberately NOT stored as a message: a
   *  transcript is what was said, and an error is something the interface
   *  reports. It does not survive a reload, which is correct — the question is
   *  durable, the failure was a moment. */
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const [backends, setBackends] = useState<ChatBackends | null>(null);
  /**
   * THE PROVIDER LAYER, kept beside the agent one rather than folded into it.
   *
   * `/chat/backends` already says WHICH provider would take a message when no
   * agent is live — that is the `fallback` field, and it is what the banner
   * and the composer read. This second document is the list of all four and
   * their connected states, which only the picker needs; fetching it here
   * rather than inside the picker means the header does not flicker a "No
   * provider" label for one frame on every open.
   */
  const [providers, setProviders] = useState<ModelProviders | null>(null);
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

  const [writing, setWriting] = useState<LiveTurn | null>(null);

  /**
   * DELTAS GO INTO A REF AND OUT ONCE PER FRAME.
   *
   * A `setState` per chunk is a render per chunk, and an agent writing quickly
   * emits one every few tens of milliseconds — which would re-parse the
   * markdown of the growing message tens of times a second and re-render every
   * other bubble with it. The ref absorbs the chunks; `requestAnimationFrame`
   * hands them over at the rate the screen can actually show them.
   *
   * rAF rather than a timer, because it is the browser saying "I am about to
   * paint" — a 16ms interval keeps firing in a background tab, where nobody is
   * reading and the work is pure heat.
   */
  const pending = useRef<{ text: string; reasoning: string }>({ text: "", reasoning: "" });
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const { text, reasoning } = pending.current;
    if (!text && !reasoning) return;
    pending.current = { text: "", reasoning: "" };
    setWriting((t) =>
      t ? { ...t, text: t.text + text, reasoning: t.reasoning + reasoning } : t,
    );
  }, []);

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  }, [flush]);

  /* The stop button's other end. A ref rather than state: aborting must not
     wait for a render, and nothing is drawn from it. */
  const abort = useRef<AbortController | null>(null);

  /* An unmount mid-answer stops the agent. Without this, navigating away
     leaves a turn running on the server with nobody to receive it — which is
     billable work for an answer that has no screen left to appear on. */
  useEffect(
    () => () => {
      abort.current?.abort();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

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
   */
  const reconciled = useRef(false);
  useEffect(() => {
    if (reconciled.current) return;
    reconciled.current = true;
    api
      .chatSessions()
      .then((doc) =>
        reconcileSessions(
          doc.sessions.map((s) => ({
            id: s.sessionId,
            /* The server sends the first thing that was said, up to 200
               characters. Shortening it to a rail-width label is this side's
               job — and it is the same function the composer uses to name a
               new chat, so a conversation gets one name wherever it is
               named. */
            title: s.title ? sessionTitle(s.title) : "Untitled chat",
          })),
        ),
      )
      .catch(() => {});
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; see above */
  }, []);

  /*
    A session id that arrives late must not overwrite a newer one's messages.
    Switching chats in the rail twice in quick succession fires two loads, and
    without this the slower answer wins and puts the wrong conversation on
    screen. The ref is read inside the promise, after the await, which is the
    only place the comparison means anything.
  */
  const showing = useRef<string | null>(null);

  /*
    Which session is mid-send. A chat STARTED by the composer creates its
    session and immediately shows the owner's message, which fires the loader
    below for a session the server has never heard of — and that load, arriving
    a moment later with an empty list, would wipe the message off the screen
    while it was being answered. The load defers to a send in progress; the
    send's own result is the newer truth anyway.
  */
  const busy = useRef<string | null>(null);

  const refreshBackends = useCallback(() => {
    /* The provider list is refreshed with the backend state, because the two
       change together: making a provider the default is what turns "no agent
       is live" from a refusal into a fallback. */
    api
      .modelProviders()
      .then(setProviders)
      .catch(() => setProviders(null));
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

  useEffect(() => {
    showing.current = sessionId;
    if (!sessionId) {
      refreshBackends();
      return;
    }
    api
      .chatSession(sessionId)
      .then((doc) => {
        if (showing.current !== sessionId || busy.current === sessionId) return;
        setConvo({ id: sessionId, messages: doc.messages, error: null });
        /* The session read carries the backend state with it — one fetch for
           two things wanted at the same instant. */
        setBackends(doc);
      })
      .catch((e: unknown) => {
        if (showing.current !== sessionId || busy.current === sessionId) return;
        setConvo({
          id: sessionId,
          messages: [],
          error:
            e instanceof Error
              ? e.message
              : "The API did not answer. Is the server running?",
        });
      });
  }, [sessionId, refreshBackends]);

  /*
    Derived, not stored. `convo` holding a different session id means this
    one's transcript has not arrived yet, which is the whole of what "loading"
    means here.
  */
  const settled = convo.id === sessionId;
  const messages = settled ? convo.messages : [];
  const loadError = settled ? convo.error : null;
  const loading = !settled && sessionId !== null;
  /** A failure belongs to the chat it happened in. Switching away and back
   *  should not show yesterday's timeout under today's question. */
  const failureText = failure && failure.id === sessionId ? failure.text : null;
  /** The turn being written, if it belongs to the chat on screen. Switching
   *  chats mid-answer leaves the answer running — it is still stored when it
   *  finishes — but it is not painted over the conversation you moved to. */
  const liveTurn = writing && writing.sessionId === sessionId ? writing : null;

  /* New turns arrive at the bottom, which is where the eye is. */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, sending]);

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
    if (!el || !liveTurn) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 120) el.scrollTop = el.scrollHeight;
  }, [liveTurn, liveTurn?.text, liveTurn?.tools.length]);

  /* ------------------------------------------------------------- sending */

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    /*
      A session is created only when there is not one already. The old mock
      made a new session on EVERY send, which was harmless when nothing was
      stored and would now start a fresh conversation with every sentence —
      the agent losing the thread between one message and the next.
    */
    let id = sessionId;
    if (!id) {
      /* The same rule the rail uses when a conversation arrives from the
         server with no name in the store — one function, so a chat started
         here and the same chat seen from another door get one title. */
      id = addSession(sessionTitle(trimmed), target?.id ?? null).id;
      showing.current = id;
    }

    setText("");
    setFailure(null);
    setSending(true);
    busy.current = id;

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
    setConvo((c) => ({
      id,
      messages: c.id === id ? [...c.messages, optimistic] : [optimistic],
      error: null,
    }));

    /* The bubble the answer grows into. Created before the first byte so the
       "thinking" state and the answer are the same element, rather than a
       spinner that is replaced by a bubble a moment later. */
    setWriting({ sessionId: id, text: "", reasoning: "", tools: [] });
    pending.current = { text: "", reasoning: "" };

    const controller = new AbortController();
    abort.current = controller;
    /* Whether a `done` arrived. Everything else — a stop, a dead gateway, an
       error event — is the other case, and it has one recovery: re-read the
       transcript, because the server has already written down whatever was
       said, flagged partial. */
    let completed = false;

    try {
      await api.chatStream(
        id,
        trimmed,
        {
          onStart: (e) => {
            /*
              The optimistic row is replaced by the STORED one the moment the
              server confirms it. Not cosmetic: the optimistic id is negative
              and the real one is a row in the database, and a transcript that
              keeps the fake id would break the moment anything wanted to
              address that message.
            */
            setConvo((c) =>
              c.id === id
                ? {
                    ...c,
                    messages: c.messages.map((m) =>
                      m.id === optimistic.id ? e.user : m,
                    ),
                  }
                : c,
            );
          },

          onDelta: (chunk) => {
            pending.current.text += chunk;
            schedule();
          },

          onReasoning: (chunk) => {
            pending.current.reasoning += chunk;
            schedule();
          },

          onTool: (e) => {
            /*
              FLUSHED FIRST. The tool's `offset` is measured against the whole
              answer, and applying it while a frame's worth of text is still
              sitting in the ref would put the grey line in front of words that
              were written before it. One frame of wrongness that corrects
              itself is still a frame of wrongness that somebody sees.
            */
            flush();
            setWriting((t) => {
              if (!t) return t;
              const at = t.tools.findIndex((x) => x.toolCallId === e.toolCallId);
              /* Merged exactly as the server merges them before storing, so
                 the live drawing and the reloaded one cannot differ. */
              if (at === -1)
                return {
                  ...t,
                  tools: [
                    ...t.tools,
                    {
                      toolCallId: e.toolCallId,
                      tool: e.tool,
                      label: e.label,
                      emoji: e.emoji,
                      startedAt: e.at,
                      finishedAt: e.status === "completed" ? e.at : null,
                      offset: e.offset,
                    },
                  ],
                };
              const tools = [...t.tools];
              tools[at] = {
                ...tools[at],
                finishedAt: e.status === "completed" ? e.at : tools[at].finishedAt,
                label: tools[at].label ?? e.label,
                emoji: tools[at].emoji ?? e.emoji,
              };
              return { ...t, tools };
            });
          },

          onDone: (e) => {
            completed = true;
            flush();
            /* The STORED row, not the accumulated text. The database's copy is
               the one that will be there after a reload, and drawing anything
               else for the last three seconds of a turn is a transcript that
               changes when you refresh it. */
            setConvo((c) =>
              c.id === id
                ? { ...c, messages: [...c.messages, e.message], error: null }
                : c,
            );
            setWriting(null);
          },

          onError: (e) => {
            /* The server has already written the partial row by the time this
               arrives — that ordering is its guarantee — so there is nothing
               to keep on screen here. The reload below picks up what was
               stored, flagged as cut off. */
            setFailure({ id, text: e.message });
          },
        },
        controller.signal,
      );
    } catch (e: unknown) {
      /*
        A REFUSAL, OR A STOP. `chatStream` throws for the errors that happen
        BEFORE the stream opens — no agent live, message too long, API down —
        and for an abort. The abort is not a failure and gets no banner: the
        owner pressed the button, and the answer so far is about to appear as
        a partial message, which says everything the interface needs to.
      */
      const stopped = controller.signal.aborted;
      if (!stopped && showing.current === id)
        setFailure({
          id,
          text:
            e instanceof Error
              ? e.message
              : "The message did not get through, and nothing said why.",
        });
      /*
        A 503 is "no agent is live", which may have become true since the page
        loaded — somebody disconnected the plugin in another tab. The banner is
        driven by the backend state, so it has to be re-read or the page keeps
        offering a composer for an agent that is gone.
      */
      if (e instanceof ApiError && e.status === 503) refreshBackends();
    } finally {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      abort.current = null;
      busy.current = null;
      setWriting((t) => (t?.sessionId === id ? null : t));
      if (showing.current === id) setSending(false);

      if (completed) {
        refreshBackends();
      } else {
        /*
          RE-READ THE TRANSCRIPT RATHER THAN KEEPING WHAT IS ON SCREEN.

          Every path that is not `done` ends with the server holding words this
          page does not: a stop, a dead gateway, an error event. It has stored
          them as a PARTIAL assistant row, and that row — with its real id, its
          real timestamp and its flag — is the truth. Reconstructing it here
          from the deltas would put a message on screen that the database does
          not have, which survives exactly until a refresh.

          A failure to re-read is left alone. The question is still in the
          transcript, the failure banner is still up, and a second error about
          being unable to check the first one is not information.
        */
        api
          .chatSession(id)
          .then((doc) => {
            if (showing.current !== id) return;
            setConvo({ id, messages: doc.messages, error: null });
            setBackends(doc);
          })
          .catch(() => {});
      }
    }
  }

  /** Stop the agent mid-answer. One abort, all the way down: the fetch body
   *  closes, the server sees a disconnect, and its own call to the agent is
   *  cancelled. What was already said is stored as partial, so nothing on
   *  screen is lost by pressing this. */
  function stop() {
    abort.current?.abort();
  }

  async function chooseBackend(id: ChatBackendId | null) {
    try {
      setBackends(await api.setChatBackend(id));
      setFailure(null);
    } catch (e: unknown) {
      /* Reported against the session being looked at, so it appears where the
         click happened. With no session open there is nothing to attach it to
         and the selector simply stays where it was — a menu that did not move
         is its own report that the switch did not take. */
      if (sessionId)
        setFailure({
          id: sessionId,
          text: e instanceof Error ? e.message : "Could not change the backend.",
        });
    }
  }

  /**
   * Choose the provider every agent inherits — and, when no agent is live, the
   * one that answers this chat directly.
   *
   * The backend state is re-read afterwards and not merely the provider list,
   * because THAT is what carries the fallback sentence the banner and the
   * composer are drawn from: a provider chosen here changes what the page says
   * about a chat with no agent in it.
   */
  async function chooseProvider(id: ProviderId | null) {
    try {
      setProviders(await api.setModelProvider(id));
      setBackends(await api.chatBackends());
      setFailure(null);
    } catch (e: unknown) {
      if (sessionId)
        setFailure({
          id: sessionId,
          text: e instanceof Error ? e.message : "Could not change the provider.",
        });
    }
  }

  /* --------------------------------------------------------------- parts */

  const live = backends?.live ?? null;
  const noAgent = backends !== null && live === null;
  /** Who takes the message when no agent does. Null with `noAgent` true is the
   *  only state in which the composer cannot be used at all. */
  const fallback = backends?.fallback ?? null;

  const picker = (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]">
        <FolderClosed className="size-3.5" strokeWidth={1.6} />
        {target?.name ?? "No venture"}
        <ChevronDown className="size-[13px]" strokeWidth={1.6} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onSelect={() => setTargetId(null)}>
          <span className="border-border size-[7px] shrink-0 rounded-[2px] border" />
          No venture
        </DropdownMenuItem>
        {state.ventures.map((v) => (
          <DropdownMenuItem key={v.id} onSelect={() => setTargetId(v.id)}>
            <span
              className="size-[7px] shrink-0 rounded-[2px]"
              style={{ background: v.color }}
            />
            {v.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setCreating(true)}>
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
      <DropdownMenuTrigger className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]">
        <Bot className="size-3.5" strokeWidth={1.6} />
        {live ? BACKEND_NAMES[live] : "No agent"}
        <ChevronDown className="size-[13px]" strokeWidth={1.6} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-muted-foreground text-[11.5px] font-normal">
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
            <span className="text-muted-foreground text-[11.5px]">
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

  /*
    THE PROVIDER PICKER, WHICH IS NOT A SECOND AGENT SELECTOR.

    The two menus name two layers and the header shows both because they can
    disagree in a way the owner has to be able to see. The agent selector says
    who is THINKING; this says which model is COMPLETING — the one every agent
    is pointed at, and the one that answers this chat directly when no agent is
    live. A single control covering both would have to pretend that "Hermes"
    and "the local model" are alternatives at the same level, and they are not:
    Hermes talks to the local model.

    It is shown whether or not an agent is live, for the same reason: an agent
    IS spending the provider named here, and hiding the label until the agent
    goes away would mean the only time you could see which model you were
    paying for is when nothing was using it.

    The whole table — endpoints, policies, what each provider is — lives in
    Settings → Models. This is the switch, not the page.
  */
  const providerPicker = (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]">
        <Cpu className="size-3.5" strokeWidth={1.6} />
        {providers?.live ? PROVIDER_NAMES[providers.live] : "No provider"}
        <ChevronDown className="size-[13px]" strokeWidth={1.6} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="text-muted-foreground text-[11.5px] font-normal">
          One provider completes. Agents are pointed at it, and with no agent
          live it answers this chat itself.
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(providers?.providers ?? []).map((p) => (
          <DropdownMenuItem
            key={p.id}
            disabled={!p.connected}
            onSelect={() => p.connected && void chooseProvider(p.id)}
          >
            <Check
              className={cn("size-3.5 shrink-0", !p.live && "opacity-0")}
              strokeWidth={2}
            />
            <span className="flex-1">{PROVIDER_NAMES[p.id]}</span>
            <span className="text-muted-foreground text-[11.5px]">
              {!p.connected
                ? "not connected"
                : p.live
                  ? `default · ${p.policy.mode === "series" ? "series" : `${p.policy.concurrency} at once`}`
                  : "ready"}
            </span>
          </DropdownMenuItem>
        ))}
        {providers?.live && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void chooseProvider(null)}>
              <span className="size-3.5 shrink-0" />
              No default — nothing completes
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <SlidersHorizontal className="size-3.5" strokeWidth={1.6} />
            Endpoints and policy
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const hasChat = messages.length > 0 || sending;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 px-4.5">
        {picker}
        <div className="ml-auto flex items-center gap-0.5">
          {providerPicker}
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
            <div className="border-line-strong bg-card mb-5 flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3">
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
              <p className="text-[12.5px]">
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
            <div className="border-line-strong bg-card mb-5 rounded-[10px] border px-3.5 py-3 text-[12.5px]">
              <span className="font-medium">This chat could not be read.</span>{" "}
              <span className="text-muted-foreground">{loadError}</span>
            </div>
          )}

          {!hasChat && (
            <>
              <h1 className="mb-1.5 text-[25px] font-normal tracking-[-0.025em]">
                {greeting()}, {state.workspace.owner}.{" "}
                <span className="text-muted-foreground">
                  What are we shipping?
                </span>
              </h1>
              <p className="text-muted-foreground mb-6 text-[13.5px]">
                {loading
                  ? "Reading this chat…"
                  : "Start from scratch, or pick up one of these."}
              </p>

              <div className="grid gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map(({ icon: Icon, title, desc, prompt }) => (
                  <button
                    key={title}
                    onClick={() => {
                      setText(prompt);
                      inputRef.current?.focus();
                    }}
                    className="bg-card hover:border-line-strong flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3 text-left transition-colors active:translate-y-px"
                  >
                    <Icon
                      className="text-muted-foreground mt-0.5 size-4 shrink-0"
                      strokeWidth={1.6}
                    />
                    <span>
                      <span className="block text-[13px] font-medium tracking-tight">
                        {title}
                      </span>
                      <span className="text-muted-foreground mt-0.5 block text-[12px]">
                        {desc}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
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
                    <div className="bg-card max-w-[85%] rounded-[12px] border px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id}>
                    <AssistantBody text={m.content.trim()} tools={m.tools} />
                    {/*
                      WHICH AGENT, WHICH MODEL, HOW LONG. Under every answer and
                      not in a tooltip, because the two backends do not answer
                      identically and a transcript that hides which one spoke is
                      a transcript you cannot reason about later. Every field is
                      omitted rather than zeroed when the agent did not report
                      it — an agent that counts no tokens has not said the turn
                      was free.
                    */}
                    <p className="text-muted-foreground mt-1.5 text-[11.5px]">
                      {authorName(m.backend)}
                      {m.model && ` · ${m.model}`}
                      {m.ms !== null && ` · ${(m.ms / 1000).toFixed(1)}s`}
                      {m.usage &&
                        ` · ${m.usage.prompt + m.usage.completion} tokens`}
                    </p>
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
                      <p className="text-muted-foreground mt-1 text-[11.5px]">
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
              {liveTurn && (liveTurn.text || liveTurn.reasoning || liveTurn.tools.length) ? (
                <div>
                  {liveTurn.reasoning && (
                    <Thinking text={liveTurn.reasoning} done={false} />
                  )}
                  <AssistantBody text={liveTurn.text} tools={liveTurn.tools} />
                  {/*
                    THE CARET, WHICH IS THE ONLY THING ON THIS PAGE THAT SAYS
                    "still going". A spinner beside a growing answer is two
                    controls saying the same thing; this is one, and it sits
                    exactly where the next word will appear.
                  */}
                  <span className="bg-foreground ml-0.5 inline-block h-[13px] w-[2px] animate-pulse align-[-1px]" />
                </div>
              ) : null}

              {/* Before the first byte there is nothing to draw a caret after,
                  so the wait gets a sentence — and it names who is answering,
                  because that is the thing worth knowing while you wait. */}
              {sending &&
                !liveTurn?.text &&
                !liveTurn?.reasoning &&
                !liveTurn?.tools.length && (
                <p className="text-muted-foreground text-[12.5px]">
                  {backends?.liveLabel ?? fallback?.label ?? "The agent"} is
                  thinking…
                </p>
              )}

              {failureText && (
                <div className="border-line-strong bg-card rounded-[10px] border px-3.5 py-3 text-[12.5px]">
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
          <div className="bg-card focus-within:border-foreground rounded-[14px] border px-3 pt-3 pb-2 transition-colors">
            <Textarea
              ref={inputRef}
              value={text}
              autoFocus
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                noAgent && !fallback
                  ? "Connect an agent under Integrations to start talking…"
                  : "Ask anything, or describe what you want to build…"
              }
              className="max-h-[200px] min-h-[46px] resize-none border-0 bg-transparent p-0 px-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center gap-0.5 pt-1">
              <button
                title="Attach"
                className="hover:bg-accent rounded-lg p-1.5"
              >
                <Plus className="size-[15px]" strokeWidth={1.6} />
              </button>
              {picker}
              <Link
                to="/integrations"
                className="hover:bg-accent flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]"
              >
                <Plug className="size-[15px]" strokeWidth={1.6} />
                Integrations
              </Link>
              {/*
                SEND BECOMES STOP, IN THE SAME PLACE. One control, because
                there is only ever one thing to do with a turn in flight, and a
                separate stop button somewhere else is a button that is
                disabled 99% of the time. The square is the universal spelling
                of it and needs no label.

                Stopping is not a cancel: the server keeps what the agent had
                already said, flagged as cut off. Nothing on screen is lost by
                pressing it, which is why it is offered without a confirmation.
              */}
              {sending ? (
                <button
                  onClick={stop}
                  title="Stop"
                  className="bg-primary text-primary-foreground ml-auto grid size-7 place-items-center rounded-lg"
                >
                  <Square className="size-3 fill-current" strokeWidth={2} />
                </button>
              ) : (
                <button
                  onClick={() => void send()}
                  disabled={!text.trim()}
                  title="Send"
                  className={cn(
                    "bg-primary text-primary-foreground ml-auto grid size-7 place-items-center rounded-lg transition-opacity",
                    text.trim() ? "opacity-100" : "pointer-events-none opacity-25",
                  )}
                >
                  <ArrowUp className="size-4" strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
          {/*
            The footer says which agent is answering, because the composer is
            where somebody is about to spend one. It keeps the original
            sentence when nothing is connected — the rail is still the truth
            about where a chat lands.
          */}
          <p className="text-muted-foreground mt-2.5 text-center text-[11.5px]">
            {backends?.liveLabel
              ? `${backends.liveLabel} is answering. Only one agent is live at a time.`
              : fallback
                ? `${fallback.label} is answering directly, across ${fallback.endpoints} endpoint${fallback.endpoints === 1 ? "" : "s"}. No agent, so no tools.`
                : "Every chat lands in the rail. Naming a venture is optional."}
          </p>
        </div>
      </div>

      <VentureDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
