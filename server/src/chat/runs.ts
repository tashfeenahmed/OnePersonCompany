/**
 * A CHAT TURN IS THE SERVER'S WORK, NOT THE BROWSER'S.
 *
 * The old contract tied a turn to its HTTP response. `POST /chat/stream`
 * opened a stream, passed the request's own `AbortSignal` down to the agent,
 * and when the socket closed the agent stopped being paid to write an answer
 * nobody was reading. That was defensible — and the Chat page said so in its
 * header, at length and honestly: "A RELOAD CANNOT RE-ATTACH, AND THIS PAGE
 * DOES NOT PRETEND OTHERWISE." What was stored after a reload was the partial
 * row, labelled cut off.
 *
 * It is the wrong shape for the work this agent actually does. A Chief of
 * Staff asked to look at four ventures' search positions runs tools for
 * minutes, and the owner reloads a page, closes a laptop lid, or switches
 * networks in the middle of that. Losing the investigation to a refresh is
 * losing minutes of model time and a train of thought, and the words already
 * on screen stop growing with no way to get them back.
 *
 * So a turn now lives HERE, keyed by a run id and owned by the process:
 *
 *   - The user's message is written before anything starts, exactly as before.
 *   - The run gets its own AbortController. A closed tab aborts NOTHING; only
 *     an explicit cancel does.
 *   - Every event is stamped with a sequence number and kept in a buffer, so a
 *     client can attach late, reattach after a reload from any `since`, or
 *     never attach at all.
 *   - The assistant row is written at the end whether or not anybody is
 *     listening — which the old code already did in a `finally`, and which is
 *     now the ordinary case rather than the sad one.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * NO QUEUE. Two conversations answering at once are two ordinary background
 * tasks; the only gate is the model provider's own, where this app owns one
 * (see models/provider.ts). A scheduler here would be a second place that
 * decides what the box does next. What there IS is a refusal: one run per
 * conversation, because a second turn on the same transcript would be two
 * answers interleaving into one history.
 *
 * NO KNOWLEDGE OF AGENTS. This file has never heard of Hermes, OpenClaw, the
 * skills preamble or the venture roster. The caller composes the turns, picks
 * the backend and hands over an `open(signal)` that returns the stream of
 * events; routes/chat.ts is the only place that knows what a chat turn is made
 * of. That is what keeps this a run engine rather than a second copy of the
 * chat route.
 *
 * NO EVENTS ON DISK. The buffer is memory, capped, and dropped a short while
 * after the run ends. See integrations/agentcore/migrations.ts for why writing
 * a token at a time to SQLite was declined; the short version is that the
 * durable record of what was said is `chat_messages`, and this is only the
 * window in which it is still arriving.
 */
import type { ChatMessageRow, ChatToolCall } from "../db.ts";
import { appendChatMessage } from "../db.ts";
import type { ChatStreamEvent, MessageBackendId } from "./backend.ts";
import { subscribe } from "./inflight.ts";
import {
  chatRun,
  insertChatRun,
  latestChatRun,
  updateChatRun,
  type ChatRunRow,
  type ChatRunStatus,
} from "../integrations/agentcore/store.ts";

/** One buffered frame. `seq` starts at 1 and is dense, so `since=N` means
 *  exactly "everything after the Nth" with no gaps to reason about. */
export type RunFrame = { seq: number; event: string; data: unknown };

/**
 * A runaway backstop and nothing more. A reasoning model legitimately emits
 * thousands of deltas in one turn, and dropping the OLDEST would tear the
 * replay a reattaching page depends on — so the cap is high and hitting it
 * ENDS the run rather than corrupting its history.
 */
const MAX_FRAMES = 40_000;

/**
 * How long a finished run's buffer outlives it.
 *
 * A browser that was mid-read when the run ended has to be able to drain the
 * tail, and a page that reloads a second after the answer lands should still
 * find the `done` frame rather than a run that has vanished. After this the
 * transcript is the record — replaying events over rows that already contain
 * them would draw the turn twice.
 */
const RETAIN_MS = 120_000;

type Run = {
  id: string;
  sessionId: string;
  status: ChatRunStatus;
  frames: RunFrame[];
  seq: number;
  subscribers: Set<(f: RunFrame) => void>;
  ac: AbortController;
  cleanup: ReturnType<typeof setTimeout> | null;
  /** Resolves when the run has emitted its last frame. What a subscriber waits
   *  on instead of polling. */
  ended: Promise<void>;
  finish: () => void;
};

const runs = new Map<string, Run>();
/** sessionId -> runId, for the one-at-a-time rule and for the rail. */
const bySession = new Map<string, string>();

let counter = 0;
function newRunId(): string {
  counter += 1;
  /* Time first so a directory listing of ids sorts, and a counter after it so
     two runs started in the same millisecond are still two ids. */
  return `cr-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/* ------------------------------------------------------------------ starting */

export type ChatRunPlan = {
  sessionId: string;
  channel: string;
  ventureId: string | null;
  backend: MessageBackendId;
  backendLabel: string | null;
  /** The owner's message, already stored. The run does not write it: the route
   *  does, before deciding anything, so a turn that is refused here still
   *  leaves the question in the transcript. */
  user: ChatMessageRow;
  /** What the `start` frame carries, built by the route because only the route
   *  knows how a message is shaped for the wire. */
  start: Record<string, unknown>;
  /** The turn itself. Given the RUN's signal — not the request's — which is the
   *  whole point of this file. */
  open: (signal: AbortSignal) => AsyncGenerator<ChatStreamEvent>;
  /** A stored row as the page reads it. Passed in for `start`'s reason. */
  shape: (row: ChatMessageRow) => unknown;
  /** The turn threw, in the words the caller will show. Called BEFORE the row
   *  is written, because the caller's job here is to record the failure against
   *  the credential that stopped working — see routes/chat.ts, which is where
   *  the adapters that know which account answered live. */
  onError?: (message: string) => void;
  /** Told what the run did, once, after the row is written. The Telegram
   *  bridge and the briefing use the non-streaming route and never need this;
   *  it exists for a caller that wants the answer without subscribing. */
  onEnd?: (r: { status: ChatRunStatus; text: string; error: string | null }) => void;
};

export class RunBusyError extends Error {
  /* A plain field rather than a parameter property: this server runs under
     `node --experimental-strip-types`, which erases types and refuses to
     GENERATE code, and a constructor parameter property is generation. */
  readonly runId: string;
  constructor(runId: string) {
    super(
      "This conversation is already answering. Wait for it, or cancel it — " +
        "two turns on one transcript would interleave into one history.",
    );
    this.name = "RunBusyError";
    this.runId = runId;
  }
}

/**
 * Start a turn in the background and return at once.
 *
 * THE CALLER DOES NOT AWAIT THE ANSWER. It gets a run id, and either
 * subscribes to it (the streaming route does, immediately) or does not (a
 * caller that only wanted the work started). The turn proceeds either way.
 */
export function startChatRun(plan: ChatRunPlan): ChatRunRow {
  const existing = activeRun(plan.sessionId);
  if (existing) throw new RunBusyError(existing.id);

  const id = newRunId();
  const row = insertChatRun({
    id,
    sessionId: plan.sessionId,
    channel: plan.channel,
    ventureId: plan.ventureId,
    backend: plan.backend,
    userMessageId: plan.user.id,
  });

  let finish!: () => void;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run: Run = {
    id,
    sessionId: plan.sessionId,
    status: "running",
    frames: [],
    seq: 0,
    subscribers: new Set(),
    ac: new AbortController(),
    cleanup: null,
    ended,
    finish,
  };
  runs.set(id, run);
  bySession.set(plan.sessionId, id);
  updateChatRun(id, { status: "running" });

  const emit = (event: string, data: unknown) => {
    if (run.frames.length >= MAX_FRAMES) {
      /* Ending the run is the honest failure. Dropping frames would leave a
         reattaching page with a transcript that has a hole in it and no way to
         know. */
      run.ac.abort();
      return;
    }
    const frame: RunFrame = { seq: ++run.seq, event, data };
    run.frames.push(frame);
    for (const cb of [...run.subscribers]) {
      try {
        cb(frame);
      } catch {
        /* a subscriber's failure is its own; the buffer is still correct */
      }
    }
  };

  emit("run", { runId: id, sessionId: plan.sessionId, status: "running" });
  emit("start", { ...plan.start, runId: id });

  /* Deliberately not awaited — this IS the background. */
  void (async () => {
    /* What has been said so far, and what was done while saying it. Read by
       the write below on every path, which is why they live out here. */
    let text = "";
    const tools = new Map<string, ChatToolCall>();
    let model: string | null = null;
    let usage: { prompt: number; completion: number } | null = null;
    let ms = 0;
    let queuedMs: number | null = null;
    let finished = false;
    let failure: string | null = null;

    /* A sub-agent dispatched from inside this answer shows in the rail the
       moment it is filed rather than when the answer ends — chat/inflight.ts.
       Nothing is stored for it here: the row is the fact and the rail re-reads
       it. */
    const unsubscribe = subscribe(plan.sessionId, (child) => emit("child", child));

    try {
      for await (const event of plan.open(run.ac.signal)) {
        switch (event.type) {
          case "delta":
            text += event.text;
            emit("delta", { text: event.text });
            break;

          case "reasoning":
            emit("reasoning", { text: event.text });
            break;

          case "tool": {
            /*
              MERGED ON THE WAY THROUGH, not on the way out — the wire carries
              two events per call and the table stores one record with two
              timestamps. A `completed` for a call that was never announced
              still creates a record, with `startedAt` equal to `finishedAt`: a
              tool that finished is a thing that happened, and dropping it
              because the first half of the pair went missing would lose a fact
              to a wire glitch.
            */
            const existingCall = tools.get(event.toolCallId);
            if (existingCall) {
              if (event.status === "completed") existingCall.finishedAt = event.at;
              if (!existingCall.label && event.label) existingCall.label = event.label;
              if (!existingCall.emoji && event.emoji) existingCall.emoji = event.emoji;
            } else {
              tools.set(event.toolCallId, {
                toolCallId: event.toolCallId,
                tool: event.tool,
                label: event.label,
                emoji: event.emoji,
                startedAt: event.at,
                finishedAt: event.status === "completed" ? event.at : null,
                /* Where in the answer this happened, so a reload draws the grey
                   line where it was watched rather than at the end. */
                offset: text.length,
              });
            }
            emit("tool", {
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
            /* `event.text` and not the accumulator: the adapter counted the
               answer as it read it and may have applied a rule this loop cannot
               see — Hermes falls back to the model's reasoning when the content
               came back empty, which is a whole answer that arrived as no
               deltas at all. */
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
      failure = errorText(err);
      plan.onError?.(failure);
    } finally {
      unsubscribe();
    }

    const cancelled = run.ac.signal.aborted;

    /*
      THE WRITE, ON EVERY PATH THAT PRODUCED WORDS. Three outcomes and each has
      one row, or none:
        finished              a complete assistant row
        stopped, text so far  the same row with partial = 1
        stopped, nothing said no row at all
      The third is the rule the non-streaming route keeps: a failed turn writes
      no "error" message, because a transcript is what was SAID and an error is
      something the interface reports.
    */
    const list = [...tools.values()];
    let assistant: ChatMessageRow | null = null;
    if (finished || text) {
      assistant = appendChatMessage({
        sessionId: plan.sessionId,
        role: "assistant",
        content: text,
        channel: plan.channel,
        backend: plan.backend,
        model,
        promptTokens: usage?.prompt ?? null,
        completionTokens: usage?.completion ?? null,
        /* Null rather than 0 on a broken turn: a stream that stopped has not
           told us how long the answer took, only how long we waited. */
        ms: finished ? ms : null,
        tools: list,
        partial: !finished,
      });
    }

    const status: ChatRunStatus = finished ? "done" : cancelled ? "cancelled" : "failed";
    run.status = status;

    if (finished && assistant) {
      emit("done", {
        messageId: assistant.id,
        message: plan.shape(assistant),
        text,
        model,
        usage,
        ms,
        tools: list,
        queuedMs,
      });
    } else {
      emit("error", {
        message:
          failure ??
          (cancelled
            ? "Stopped by the owner."
            : "The stream ended without an answer."),
        messageId: assistant?.id ?? null,
        /* Whether anything was kept. The page draws what is on screen as a
           partial answer when this is true and drops it when it is not. */
        partial: assistant !== null,
        /* A stop is not a failure and must not be reported as one. The page
           shows no banner for a button the owner pressed themselves. */
        cancelled,
      });
    }

    updateChatRun(id, {
      status,
      assistantMessageId: assistant?.id ?? null,
      error: status === "failed" ? (failure ?? "The stream ended without an answer.") : null,
      lastSeq: run.seq,
      finished: true,
    });

    plan.onEnd?.({ status, text, error: failure });

    /* Every live subscriber is told the stream is over by the frame above; the
       ones that arrive within the retention window read it out of the buffer. */
    run.finish();
    if (bySession.get(plan.sessionId) === id) bySession.delete(plan.sessionId);
    run.cleanup = setTimeout(() => {
      if (runs.get(id) === run) runs.delete(id);
    }, RETAIN_MS);
    /* A box shutting down should not wait two minutes for this. */
    run.cleanup.unref?.();
  })();

  return chatRun(id) ?? row;
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const s = String(err ?? "").trim();
  return s || "The agent stopped for a reason it did not give.";
}

/* ------------------------------------------------------------- subscription */

/** The run answering this conversation right now, or null. Memory first — a
 *  row saying `running` for a run this process does not hold is a leftover of a
 *  restart, and `failInterruptedChatRuns` corrects those at start-up. */
export function activeRun(sessionId: string): Run | null {
  const id = bySession.get(sessionId);
  const run = id ? (runs.get(id) ?? null) : null;
  return run && run.status === "running" ? run : null;
}

/** Which conversations are being answered right now, for the rail. */
export function answeringSessions(): string[] {
  return [...bySession.keys()].filter((s) => activeRun(s) !== null);
}

export type RunHandle = {
  id: string;
  status: ChatRunStatus;
  lastSeq: number;
  /** Everything after `since`, in order. */
  replay: (since: number) => RunFrame[];
  /** Live frames from here on. Returns the unsubscribe. */
  listen: (cb: (f: RunFrame) => void) => () => void;
  ended: Promise<void>;
  running: boolean;
};

/** The in-memory run, if it is still held. Null once the retention window has
 *  passed — at which point the transcript is the record. */
export function runHandle(id: string): RunHandle | null {
  const run = runs.get(id);
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    lastSeq: run.seq,
    replay: (since) => run.frames.filter((f) => f.seq > since),
    listen: (cb) => {
      run.subscribers.add(cb);
      return () => run.subscribers.delete(cb);
    },
    ended: run.ended,
    running: run.status === "running",
  };
}

/**
 * The owner pressed stop.
 *
 * Aborting the run's controller is the whole of it: the agent call ends, the
 * loop's `finally` writes whatever was said as a partial row, and the last
 * frame says `cancelled`. Answering the caller before any of that has happened
 * is correct — "stop" is a request the run honours, and the run says when it
 * has.
 */
export function cancelChatRun(id: string): {
  ok: boolean;
  status: ChatRunStatus;
  error?: string;
  /** Told apart from "already over" so the route can answer 404 rather than
   *  409: a run that never existed is a mistake in the id, and a run that has
   *  finished is not. */
  notFound?: boolean;
} {
  const run = runs.get(id);
  if (!run) {
    const row = chatRun(id);
    if (!row)
      return { ok: false, status: "failed", notFound: true, error: `There is no run called "${id}".` };
    return { ok: false, status: row.status, error: `That run is already ${row.status}.` };
  }
  if (run.status !== "running")
    return { ok: false, status: run.status, error: `That run is already ${run.status}.` };
  run.ac.abort();
  return { ok: true, status: "cancelled" };
}

/** What a page asks when it opens a conversation: is there anything to
 *  reattach to, and from where. Memory is the authority while it holds the
 *  run; the row answers for everything older. */
export function sessionRunState(sessionId: string): {
  runId: string;
  status: ChatRunStatus;
  lastSeq: number;
  attachable: boolean;
  startedAt: string;
  error: string | null;
} | null {
  const live = activeRun(sessionId);
  if (live) {
    const row = chatRun(live.id);
    return {
      runId: live.id,
      status: live.status,
      lastSeq: live.seq,
      attachable: true,
      startedAt: row?.started_at ?? new Date().toISOString(),
      error: null,
    };
  }
  const row = latestChatRun(sessionId);
  if (!row) return null;
  return {
    runId: row.id,
    status: row.status,
    lastSeq: row.last_seq,
    /* A finished run inside its retention window can still be attached to — a
       page that reloaded a second after the answer landed drains the tail
       rather than fetching a transcript it is about to be handed anyway. */
    attachable: runs.has(row.id),
    startedAt: row.started_at,
    error: row.error,
  };
}
