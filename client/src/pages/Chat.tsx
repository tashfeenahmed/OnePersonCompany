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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUp,
  Bot,
  Bug,
  Check,
  ChevronDown,
  Code2,
  FolderClosed,
  LayoutDashboard,
  Plug,
  Plus,
  Sparkles,
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
import { ApiError, api, type ChatBackendId, type ChatBackends, type ChatMessage } from "@/lib/api";

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

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function Chat() {
  const { state, addSession } = useStore();
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

  const bottomRef = useRef<HTMLDivElement>(null);

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

  /* New turns arrive at the bottom, which is where the eye is. */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, sending]);

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
      const title =
        trimmed.length > 44 ? `${trimmed.slice(0, 44).trimEnd()}…` : trimmed;
      id = addSession(title, target?.id ?? null).id;
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
    };
    setConvo((c) => ({
      id,
      messages: c.id === id ? [...c.messages, optimistic] : [optimistic],
      error: null,
    }));

    try {
      const doc = await api.chatSend(id, trimmed);
      if (showing.current !== id) return;
      setConvo((c) => ({
        id,
        messages: [
          ...(c.id === id ? c.messages.filter((x) => x.id !== optimistic.id) : []),
          doc.user,
          doc.reply,
        ],
        error: null,
      }));
      refreshBackends();
    } catch (e: unknown) {
      if (showing.current !== id) return;
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
      busy.current = null;
      if (showing.current === id) setSending(false);
    }
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

  /* --------------------------------------------------------------- parts */

  const live = backends?.live ?? null;
  const noAgent = backends !== null && live === null;

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
              {!b.connected ? "not connected" : b.live ? "live" : "ready"}
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

  const hasChat = messages.length > 0 || sending;

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
          {noAgent && (
            <div className="border-line-strong bg-card mb-5 flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3">
              <TriangleAlert
                className="text-muted-foreground mt-0.5 size-4 shrink-0"
                strokeWidth={1.6}
              />
              <p className="text-[12.5px]">
                <span className="font-medium">No agent is live.</span>{" "}
                <span className="text-muted-foreground">
                  {backends?.why ??
                    "Connect Hermes or OpenClaw and choose one as the chat backend."}{" "}
                </span>
                <Link to="/integrations" className="underline underline-offset-2">
                  Open Integrations
                </Link>
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
                  <div key={m.id} className="flex justify-end">
                    <div className="bg-card max-w-[85%] rounded-[12px] border px-3.5 py-2.5 text-[13.5px] whitespace-pre-wrap">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id}>
                    <div className="text-[13.5px] leading-[1.6] whitespace-pre-wrap">
                      {m.content.trim()}
                    </div>
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
                      {m.backend ? BACKEND_NAMES[m.backend] : "Agent"}
                      {m.model && ` · ${m.model}`}
                      {m.ms !== null && ` · ${(m.ms / 1000).toFixed(1)}s`}
                      {m.usage &&
                        ` · ${m.usage.prompt + m.usage.completion} tokens`}
                    </p>
                  </div>
                ),
              )}

              {sending && (
                <p className="text-muted-foreground text-[12.5px]">
                  {backends?.liveLabel ?? "The agent"} is thinking…
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
                noAgent
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
              <button
                onClick={() => void send()}
                disabled={!text.trim() || sending}
                title="Send"
                className={cn(
                  "bg-primary text-primary-foreground ml-auto grid size-7 place-items-center rounded-lg transition-opacity",
                  text.trim() && !sending
                    ? "opacity-100"
                    : "pointer-events-none opacity-25",
                )}
              >
                <ArrowUp className="size-4" strokeWidth={2} />
              </button>
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
              : "Every chat lands in the rail. Naming a venture is optional."}
          </p>
        </div>
      </div>

      <VentureDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
