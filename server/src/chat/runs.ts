/**
 * A CHAT TURN IS THE SERVER'S WORK, NOT THE BROWSER'S.
 *
 * A turn tied to its HTTP response — `POST /chat/stream` opening a stream,
 * passing the request's own `AbortSignal` down to the agent, and stopping
 * when the socket closed because nobody was reading the answer — leaves a
 * reload with no way to re-attach; what survives is the partial row, labelled
 * cut off.
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
import { CANCELLING, type RunStatusOrCancelling } from "../../../shared/runStatus.ts";
import type { ChatMessageRow } from "../db.ts";
import { appendChatMessage } from "../db.ts";
import type { ChatStreamEvent, MessageBackendId } from "./backend.ts";
import { consumeTurn, newTurn } from "./consume.ts";
import { all as inflightSessions, subscribe } from "./inflight.ts";
import { byteLength } from "../integrations/agentcore/bound.ts";
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
 * TWO CAPS, BECAUSE A COUNT IS NOT A SIZE.
 *
 * The first cut bounded FRAMES only, and the frames' payloads are unbounded: a
 * backend with no streaming path emits the whole answer as one delta and then
 * repeats it in `done` (see routes/chat.ts's `oneShot`), so a single run holds
 * roughly twice the answer in two frames and would never come near a
 * forty-thousand-frame ceiling. With no global limit on concurrent runs and a
 * two-minute retention past the end, "bounded" has to mean bounded in bytes.
 *
 * A reasoning model legitimately emits thousands of deltas in one turn, and
 * dropping the OLDEST would tear the replay a reattaching page depends on — so
 * both caps are high, and hitting either ENDS the run rather than corrupting
 * its history.
 */
const MAX_FRAMES = 40_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

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
  /** What the buffered frames cost, so the cap above can be about memory. */
  bytes: number;
  /** The generator has yielded `done`; the turn is landing and a cancel that
   *  arrives now is too late to change what happens. See `cancelChatRun`. */
  settling: boolean;
  /** A cap was hit and frames were refused. Reported on the terminal frame, so
   *  a reader is told its transcript has a hole rather than left to infer it. */
  overflowed: boolean;
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
  /** The account label behind that id ("Hermes · Nous Portal"). Carried on the
   *  plan rather than derived here, for a caller that wants to name the
   *  answering backend in its own `start` payload or its own report. */
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
  /**
   * Told what the run did, once, after the row is written.
   *
   * CONTRACT SURFACE WITH NO READER IN THIS FILE'S OWN CALLER, and deliberately
   * so: `routes/chat.ts` subscribes to the stream and learns the outcome from
   * the terminal frame, but a caller that starts a turn and does NOT subscribe
   * — a scheduled job, another area driving its own tool loop through
   * `open(signal)` — has no other way to be told. Called inside the run's own
   * try/catch, so a throw here fails the run rather than the process.
   */
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
    bytes: 0,
    settling: false,
    overflowed: false,
    seq: 0,
    subscribers: new Set(),
    ac: new AbortController(),
    cleanup: null,
    ended,
    finish,
  };
  runs.set(id, run);
  bySession.set(plan.sessionId, id);

  /**
   * Buffer a frame and hand it to everybody listening.
   *
   * `force` IS FOR THE TERMINAL FRAME AND FOR NOTHING ELSE. The caps below
   * refuse ordinary frames — that is what a cap is — but the first version
   * refused the closing `done`/`error` too, which is the one frame a reader
   * cannot do without: a live subscriber saw the socket close with no ending,
   * and a reattacher replayed forty thousand frames and still found none. So
   * the ending is always buffered and always delivered, whatever the caps say,
   * and `overflowed` is how the reader is told the middle is incomplete.
   */
  const emit = (event: string, data: unknown, force = false) => {
    const cost = byteLength(JSON.stringify(data ?? null));
    if (!force && (run.frames.length >= MAX_FRAMES || run.bytes + cost > MAX_BUFFER_BYTES)) {
      /* Ending the run is the honest failure. Dropping frames silently would
         leave a reattaching page with a hole in its transcript and no way to
         know there was one. */
      run.overflowed = true;
      run.ac.abort();
      return;
    }
    const frame: RunFrame = { seq: ++run.seq, event, data };
    run.frames.push(frame);
    run.bytes += cost;
    for (const cb of [...run.subscribers]) {
      try {
        cb(frame);
      } catch {
        /* a subscriber's failure is its own; the buffer is still correct */
      }
    }
  };

  /**
   * THE ONE LANDING, WHATEVER THE FLIGHT WAS.
   *
   * Idempotent, and called from a `finally` that nothing can skip. Before this
   * existed the tail of the run — the assistant row, the terminal frame, the
   * status write — sat outside any `try`, so a `SQLITE_BUSY` on the write took
   * down an unhandled rejection AND left `bySession` pointing at a run that
   * would never resolve its `ended` promise: every later turn on that
   * conversation 409'd for the life of the process, and every subscriber waited
   * for ever. The rule now is that the maps and the promise are released on
   * every exit path, including the ones nobody thought of.
   */
  let landed = false;
  const land = (status: ChatRunStatus) => {
    if (landed) return;
    landed = true;
    run.status = status;
    if (bySession.get(plan.sessionId) === id) bySession.delete(plan.sessionId);
    run.finish();
    run.cleanup = setTimeout(() => {
      if (runs.get(id) === run) runs.delete(id);
    }, RETAIN_MS);
    /* A box shutting down should not wait two minutes for this. */
    run.cleanup.unref?.();
  };

  try {
    emit("run", { runId: id, sessionId: plan.sessionId, status: "running" });
    emit("start", { ...plan.start, runId: id });
  } catch (err) {
    /* A plan whose `start` payload cannot be serialised, or a caller that threw
       from a subscriber the engine has not got yet. The row exists and the
       question is stored, so the honest end is a failed run rather than a
       conversation that can never be asked anything again. */
    land("failed");
    try {
      updateChatRun(id, { status: "failed", error: errorText(err), lastSeq: run.seq, finished: true });
    } catch {
      /* the row is beyond reach; the maps are already released */
    }
    throw err;
  }

  /* Deliberately not awaited — this IS the background. */
  void (async () => {
    /* What has been said so far, and what was done while saying it. Read by
       the write below on every path, which is why they live out here. */
    /* MADE HERE AND FILLED IN PLACE, so a stream that throws half way through
       still leaves the words it did produce for the partial row below. */
    const turn = newTurn();
    let failure: string | null = null;

    /* A sub-agent dispatched from inside this answer shows in the rail the
       moment it is filed rather than when the answer ends — chat/inflight.ts.
       Nothing is stored for it here: the row is the fact and the rail re-reads
       it. */
    const unsubscribe = subscribe(plan.sessionId, (child) => emit("child", child));

    try {
      /* The loop itself is chat/consume.ts, which the run executor reads too.
         Everything specific to a CHAT turn is in the four hooks below: the
         frames the browser is watching, and the cancel door. */
      await consumeTurn(plan.open(run.ac.signal), {
        delta: (text) => emit("delta", { text }),
        /* KEPT, and folded by the page. A live answer may show the model's
           working; a stored report may not — see consume.ts. */
        reasoning: (text) => emit("reasoning", { text }),
        tool: (call, event) =>
          emit("tool", {
            toolCallId: event.toolCallId,
            tool: event.tool,
            label: event.label,
            emoji: event.emoji,
            status: event.status,
            at: event.at,
            offset: call.offset,
          }),
        /* FROM HERE A CANCEL IS TOO LATE, and saying so is the whole point of
           the flag: the answer is complete and about to be stored, and a stop
           button that reported "cancelled" for a turn that then lands as
           `done` is the one thing that control must never do. */
        done: () => {
          run.settling = true;
        },
      }, turn);
    } catch (err) {
      failure = errorText(err);
      plan.onError?.(failure);
    } finally {
      unsubscribe();
    }

    const { text, model, usage, ms, queuedMs, finished } = turn;

    /* AN OVERFLOW IS NOT A CANCEL. Both abort the same controller, and the
       owner did not press anything when the buffer filled — reporting it as a
       stop would put the fault on the person watching. */
    const cancelled = run.ac.signal.aborted && !finished && !run.overflowed;
    let status: ChatRunStatus = finished ? "done" : cancelled ? "cancelled" : "failed";

    /*
      EVERYTHING FROM HERE IS INSIDE A TRY, AND THE `finally` IS THE POINT.

      The write, the terminal frame and the status update all reach outside this
      module — SQLite, a caller's `shape`, a caller's `onEnd` — and any of them
      can throw. When they did, the throw escaped a `void`-ed async function as
      an unhandled rejection (which ends the process on this Node) and, worse,
      skipped the two lines that release the conversation: `bySession` kept
      pointing at a run nobody would ever finish, so every later turn on that
      chat was refused as busy and every subscriber waited on a promise that
      never resolved. The turn is allowed to fail; the conversation is not
      allowed to be lost with it.
    */
    try {
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
      const list = turn.tools;
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

      if (finished && assistant) {
        /* FORCED, like every terminal frame: a run that hit its buffer cap must
           still be able to say it is over. */
        emit(
          "done",
          {
            messageId: assistant.id,
            message: plan.shape(assistant),
            text,
            model,
            usage,
            ms,
            tools: list,
            queuedMs,
            /* True when the caps refused frames in the middle. The words are
               whole — they are read from the accumulator, not from the buffer —
               but a reattacher's replay is not. */
            incomplete: run.overflowed,
          },
          true,
        );
      } else {
        emit(
          "error",
          {
            message:
              failure ??
              (run.overflowed
                ? "That answer was longer than this server will hold in memory, so it was stopped."
                : cancelled
                  ? "Stopped by the owner."
                  : "The stream ended without an answer."),
            messageId: assistant?.id ?? null,
            /* Whether anything was kept. The page draws what is on screen as a
               partial answer when this is true and drops it when it is not. */
            partial: assistant !== null,
            /* A stop is not a failure and must not be reported as one. The page
               shows no banner for a button the owner pressed themselves. */
            cancelled,
            incomplete: run.overflowed,
          },
          true,
        );
      }

      updateChatRun(id, {
        status,
        assistantMessageId: assistant?.id ?? null,
        error: status === "failed" ? (failure ?? "The stream ended without an answer.") : null,
        lastSeq: run.seq,
        finished: true,
      });

      plan.onEnd?.({ status, text, error: failure });
    } catch (err) {
      /*
        THE LANDING ITSELF FAILED. The answer may or may not be in the
        transcript — that is exactly what could not be established — so the run
        is reported failed with the reason, on a best-effort basis: the frame
        first, because a reader waiting on a socket is the party that suffers
        most from silence, and then the row.
      */
      status = "failed";
      const why = errorText(err);
      console.error(`[chat/runs] ${id} could not be landed — ${why}`);
      try {
        emit("error", { message: why, messageId: null, partial: false, cancelled: false, incomplete: true }, true);
      } catch {
        /* nothing left to tell */
      }
      try {
        updateChatRun(id, { status: "failed", error: why, lastSeq: run.seq, finished: true });
      } catch {
        /* the row is beyond reach; the maps are released below regardless */
      }
    } finally {
      /* Every live subscriber has been told the stream is over by the frame
         above; the ones that arrive within the retention window read it out of
         the buffer. This releases the conversation either way. */
      land(status);
    }
  })().catch((err: unknown) => {
    /*
      NOTHING SHOULD REACH HERE — the body's own `finally` lands the run — but a
      `void`-ed async function with no catch is a process-ending unhandled
      rejection on this Node, and "the API died while answering a chat" is not
      an acceptable way to learn about a bug in the paragraph above.
    */
    console.error(`[chat/runs] ${id} ended unexpectedly — ${errorText(err)}`);
    land("failed");
  });

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
  /** What the run IS, not what it will become. A successful cancel answers
   *  `cancelling`, because the run has been asked and has not yet landed. */
  status: RunStatusOrCancelling;
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
  /*
    THE ANSWER ARRIVED WHILE THE BUTTON WAS BEING PRESSED. `status` is not
    written until the tail runs, so gating on it alone accepted a cancel for a
    turn whose generator had already yielded `done` — and then reported
    "cancelled" for a run that landed as `done`. The flag is set the moment the
    answer is complete, which is the earliest point at which cancelling is a lie.
  */
  if (run.settling)
    return {
      ok: false,
      status: "running",
      error: "That answer has already finished; there is nothing left to stop.",
    };
  run.ac.abort();
  /*
    `cancelling`, NOT `cancelled`. Aborting is a request the run honours in its
    own `finally` — it still has a partial row to write — and the authority on
    what happened is the terminal frame, not this reply. Reporting the outcome
    here would be reporting it before it happened.

    THE WORD WAS `stopping` HERE AND `cancelling` ON THE RUN QUEUE, for one
    state, declared by no type on either path. It is `cancelling` on both now:
    the state it leads to is `cancelled`, and a vocabulary whose participle
    does not match its past tense invites exactly that drift. See
    shared/runStatus.ts.
  */
  return { ok: true, status: CANCELLING };
}

/**
 * IS THIS CONVERSATION ALREADY BEING ANSWERED, BY ANY DOOR?
 *
 * `activeRun` knows about runs, which is the streaming door. It is not the only
 * door: the non-streaming `POST /chat` and the Telegram bridge both go straight
 * through `ask()`, which registers the session in chat/inflight.ts for the
 * length of the answer. A guard that consulted only the runs would let a phone
 * and a browser answer one transcript at once — two assistant rows for a
 * history that only ever contained one question.
 *
 * Answers the run id when there is one, so a caller can point a client at the
 * stream it should be watching; null `runId` with `busy: true` is the other
 * door, which has no stream to offer.
 */
export function sessionBusy(sessionId: string): { busy: boolean; runId: string | null } {
  const run = activeRun(sessionId);
  if (run) return { busy: true, runId: run.id };
  return { busy: inflightSessions().includes(sessionId), runId: null };
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
