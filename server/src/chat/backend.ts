/**
 * THE CHAT BACKEND — one contract, several agents behind it, exactly one live.
 *
 * Hermes (Nous Research's agent, reached over an OpenAI-compatible endpoint)
 * and OpenClaw (the open-source gateway, reached over its tools-invoke API) do
 * the same job for this app: take a conversation, think, answer. They differ
 * in wire shape and nothing that matters to a caller, so a caller never learns
 * which one it is talking to. The Chat page, the Telegram bridge, and anything
 * that arrives later all go through `ask()` below and nowhere else.
 *
 * ONLY ONE IS ACTIVE. Both may be connected — a key for each stored in the
 * vault — but a single `chat.backend` config value names the one that answers.
 * Two live agents answering the same question from two places is not a
 * feature; it is the same message arriving twice on a phone. The setting is
 * read on every call rather than cached, so switching takes effect on the next
 * message and never needs a restart.
 *
 * WHAT THIS FILE IS AND IS NOT. It is the seam: the type every adapter
 * implements and the one function every caller uses. It is not where the
 * adapters live — those are `providers/hermes.ts` and `providers/openclaw.ts`,
 * registered here — and it holds no HTTP itself.
 *
 * STREAMING WAS ADDED WITHOUT WIDENING THE SEAM. `ask()` is still the one
 * call every caller makes and still returns a whole turn; `stream()` is an
 * OPTIONAL second method beside it, and a backend that does not implement it
 * loses nothing — the route asks once and emits the answer as a single chunk.
 * The alternative, making every adapter speak SSE before it can answer a
 * message, would have made the next adapter's first day a stream parser.
 *
 * NULL MEANS "NO AGENT". `activeBackend()` returns null when nothing is
 * connected, or the configured backend is not connected, or nothing has been
 * chosen. A caller that gets null should say "no agent is connected" in its
 * own words (the Chat page's, Telegram's) rather than reply with an empty
 * string — silence from a bot is indistinguishable from a broken bot.
 *
 * AND THERE IS NOW A FLOOR BELOW NULL. `models/provider.ts` holds the layer
 * this one sits on: the providers that merely COMPLETE. When no agent is live
 * but a provider is, routes/chat.ts answers through that instead of refusing —
 * see `ProviderBackendId` below and the fallback in the route. This file is
 * unchanged by it: `ask()` still throws `NoBackendError` when no agent will
 * answer, because "no agent" is the true answer to the question this seam is
 * asked, and the caller is the right place to decide that a raw model is
 * better than nothing.
 */
import { activeProvider, type ProviderId } from "../models/provider.ts";
import { ASK_TIMEOUT_MS, WireError } from "./wire.ts";

export type ChatBackendId = "hermes" | "openclaw";

/**
 * WHAT WROTE A MESSAGE DOWN, which is a wider set than what can be an AGENT.
 *
 * When no agent is live but a model provider is, `routes/chat.ts` answers
 * through `models/provider.ts`'s `complete()` — a plain chat, with nothing
 * thinking in front of it. That reply was not written by a ChatBackend and
 * must not be stamped as one: an owner reading a transcript six weeks later is
 * entitled to know that a particular answer came from a raw model rather than
 * from Hermes with its tools.
 *
 * So the stored `backend` column can also hold `provider:<id>`, and this is
 * the type of that. It is deliberately NOT part of `ChatBackendId`:
 *
 *   — `ChatBackend.id` and `ChatReply.backend` stay the two agent ids, so
 *     neither adapter has to know this exists and neither can accidentally
 *     claim to be a provider.
 *   — the widening happens exactly once, on the MESSAGE, which is the only
 *     place both kinds of author meet.
 *
 * A template literal type rather than a hand-written union of four strings,
 * because the four are `ProviderId`'s four and a fifth provider must not need
 * an edit here to be storable.
 */
export type ProviderBackendId = `provider:${ProviderId}`;

/** Who a stored message says wrote it: an agent, a provider asked directly,
 *  or null on the owner's own turn — where null means "not applicable" rather
 *  than "asked and not told". */
export type MessageBackendId = ChatBackendId | ProviderBackendId;

export type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ChatReply = {
  text: string;
  /** Which agent answered. Surfaced, never hidden, because the two may not
   *  answer identically and the owner is entitled to know which one did. */
  backend: ChatBackendId;
  /** The model the agent reports having used, when it reports one. */
  model: string | null;
  /** Tokens, when the backend counts them. Absent is "not reported", not 0. */
  usage: { prompt: number; completion: number } | null;
  /** How long the round trip took, measured here. */
  ms: number;
};

export type AskOptions = {
  /** A stable id for a conversation, so a backend that keeps its own session
   *  state (OpenClaw can) continues the right one. Optional: a one-off ask
   *  has no session. */
  sessionId?: string;
  /**
   * Where the message came from — the page, a Telegram chat, or a RUN.
   *
   * `"run"` is not a door a person is standing at, and that is why it is worth
   * a third value rather than being folded into `"web"`. A run is one long
   * turn started from an app and executed on the server with nobody watching
   * the socket: nothing is waiting for a reply, the session id is `run:<id>`
   * rather than a conversation, and a backend that logs or rate-limits by
   * channel should be able to tell it apart from a person typing. Every
   * adapter that ignores this field — both of them, today — is unaffected.
   */
  channel?: "web" | "telegram" | "run";
  signal?: AbortSignal;
  /**
   * The hard cap on ONE streamed turn, when the caller has a better number than
   * chat/wire.ts's ten minutes.
   *
   * That cap is a chat's: a person is watching, and an agent still writing at
   * ten minutes is a runaway. A queued RUN already has a whole-job deadline —
   * the owner's `runSeconds`, enforced by the run's own signal — and a second,
   * shorter one underneath it failed every agent run on a slow local model at
   * exactly 600 seconds however large the budget had been set (run r-wzd6ml).
   * So the executor passes the run's budget here and the adapters forward it.
   */
  maxMs?: number;
  /**
   * How long the stream may be SILENT before it is given up on, when the
   * caller has a better number than chat/wire.ts's ninety seconds.
   *
   * Ninety seconds is a chat's: a person is waiting, and an agent that has
   * said nothing for a minute and a half has lost its model. It was kept for
   * runs too — "silence is a fault at any speed" — until a research run on
   * the Dell died at ninety seconds of silence while Hermes was holding a
   * shell command for approval (run r-wt5uag): the guardian waits up to ten
   * minutes, sends no keepalive while it waits, and the tool then returns an
   * error and the agent carries on. That is not a dead gateway, it is a slow
   * tool, and a run has a whole-job deadline above it. So the executor passes
   * a longer idle allowance for the `run` channel; a chat keeps the default.
   */
  idleMs?: number;
};

/**
 * HOW LONG A NON-STREAMING TURN MAY TAKE.
 *
 * Sixty seconds is the right patience for a hosted model. It is the wrong one
 * for an agent whose model is a 27B on a box under the desk, where one tool-using
 * turn is a few minutes: every Telegram message and every `POST /api/chat` ended
 * in "did not answer within 60 seconds" while the agent carried on working and
 * its answer was never stored. The owner has already said how slow the workspace
 * model is allowed to be — the active provider's `policy.timeoutMs` — so an
 * agent turn built out of those completions gets at least that long.
 */
export function askTimeoutMs(): number {
  return Math.max(ASK_TIMEOUT_MS, activeProvider()?.policy.timeoutMs ?? 0);
}

/**
 * ONE TOOL CALL, AS THE AGENT REPORTS IT WHILE IT IS HAPPENING.
 *
 * Hermes' router emits these as NAMED SSE events interleaved with the answer —
 * `event: hermes.tool.progress`, one with `status: "running"` and one with
 * `status: "completed"` per call. What it does NOT emit is the tool's RESULT,
 * and that absence is the whole shape of this type: there is no `output`
 * field, and there is not going to be one, because inventing a place to put a
 * result the wire never carries is how a page ends up with an empty box that
 * looks broken.
 *
 * So what a tool event can honestly say is: which tool, what it was called
 * with (`label` — the router's own one-line summary, "date", "ls /etc"), and
 * whether it is still going. That is what the grey line on the Chat page
 * shows, and it is exactly as much as is known.
 *
 * `label` and `emoji` are nullable because a backend that reports a tool
 * without a label has told us nothing about what it was doing, and "null"
 * beats a made-up label. `at` is this server's clock, not the agent's: an
 * agent's timestamps are its own box's, and two of them subtracted are only a
 * duration if the clocks agree.
 */
export type ChatToolEvent = {
  toolCallId: string;
  tool: string;
  label: string | null;
  emoji: string | null;
  status: "running" | "completed";
  at: string;
};

/**
 * What a streaming turn emits, in the order it happens.
 *
 * A DISCRIMINATED UNION AND NOT FOUR CALLBACKS. The route writes each of these
 * to the browser as an SSE event of the same name, and a union means the
 * compiler checks that every case is handled — which matters more than usual
 * here, because a case that is silently dropped is not a crash, it is an
 * answer that is quietly missing a paragraph.
 *
 * `done` IS THE LAST EVENT AND IT CARRIES THE WHOLE ANSWER, not just the last
 * chunk. The deltas are for drawing; `done.text` is what gets written to the
 * table. Reassembling the message from the deltas at the far end would mean
 * two places agreeing about what was said, and the one that ends up in the
 * transcript should be the one the server counted.
 */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  /** The model's working. Rendered folded and NEVER as the answer — a
   *  scratchpad in front of a reply is not what was said. */
  | { type: "reasoning"; text: string }
  | ({ type: "tool" } & ChatToolEvent)
  | {
      type: "done";
      text: string;
      model: string | null;
      usage: { prompt: number; completion: number } | null;
      ms: number;
      /** How long the call waited for a provider slot before it was sent —
       *  only the raw-provider path owns a queue, so an agent's turn leaves
       *  this null. Absent is "not measured", never zero. */
      queuedMs?: number | null;
    };

export interface ChatBackend {
  id: ChatBackendId;
  /** The account label this backend is using, for display ("Hermes · Nous
   *  Portal"). */
  label: string;
  ask(turns: ChatTurn[], opts?: AskOptions): Promise<ChatReply>;
  /**
   * The same turn, streamed — OPTIONAL, and that is a contract decision.
   *
   * Making it required would mean every backend that ever registers has to
   * implement SSE before it can answer a single message, which is a tax on the
   * next adapter for a feature the page can do without. So a backend without
   * this one still works everywhere: routes/chat.ts falls back to `ask()` and
   * emits the answer as a single `delta` followed by `done`, which is a
   * degraded stream rather than a broken page — the words arrive all at once
   * instead of one at a time, and everything downstream is unchanged.
   *
   * An async generator rather than a callback, so that a caller which stops
   * reading (a closed tab) cancels the upstream request through the
   * generator's own `finally` instead of through a flag somebody forgot to
   * check.
   */
  stream?(turns: ChatTurn[], opts?: AskOptions): AsyncGenerator<ChatStreamEvent>;
}

/* ------------------------------------------------------------------ registry */

/**
 * Adapters register themselves at import time. The order of `import` lines in
 * index.ts is therefore load-bearing and is commented there.
 */
const adapters = new Map<ChatBackendId, () => ChatBackend | null>();

/**
 * An adapter registers a FACTORY, not an instance: it is called on every
 * `activeBackend()` so a rotated key or a changed URL is picked up without a
 * restart. The factory returns null when its plugin is not connected.
 */
import * as inflight from "./inflight.ts";

export function registerBackend(id: ChatBackendId, make: () => ChatBackend | null) {
  adapters.set(id, make);
}

/** Which backend is configured to answer. Read from plugin config on every
 *  call — see the header for why it is not cached. Implemented by the chat
 *  routes module, which owns the config key; set here so this file has no
 *  import of the config store and stays a pure seam. */
let readChoice: () => ChatBackendId | null = () => null;

export function setChoiceReader(fn: () => ChatBackendId | null) {
  readChoice = fn;
}

// The managed-instance owner prepares the selected provider and holds a lease
// until the whole response finishes, including a streamed response's cleanup.
let prepare: (id: ChatBackendId, signal?: AbortSignal) => Promise<() => void> = async () => () => {};
export function setBackendPreparation(fn: typeof prepare) { prepare = fn; }

export type BackendReadiness = { ready: boolean; reason: string | null };
let readReadiness: (id: ChatBackendId) => BackendReadiness | null = () => null;
export function setBackendReadiness(fn: typeof readReadiness) { readReadiness = fn; }
export function backendReadiness(id: ChatBackendId): BackendReadiness | null { return readReadiness(id); }

/**
 * A WHOLE TURN, READ OFF THE AGENT'S STREAM.
 *
 * WHY THE NON-STREAMING DOOR STREAMS UNDERNEATH. An agent gateway stops working
 * when a streaming client goes away — Hermes logs `SSE client disconnected;
 * interrupted agent task` — and does NOT when a plain request is abandoned. So
 * a `POST /api/chat` or a Telegram message that timed out left the agent
 * running with nobody listening: on 2026-09-17 one carried on, dispatched a
 * sub-agent run, and its answer was never stored (run r-wzd6ml). Reading the
 * same turn as a stream makes the timeout a disconnect the agent can see.
 *
 * The caller still gets one `ChatReply` and the same 504 sentence. An endpoint
 * that refuses to stream (406) is asked the old way.
 */
async function askOverStream(backend: ChatBackend, turns: ChatTurn[], opts?: AskOptions): Promise<ChatReply> {
  const limit = askTimeoutMs();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), limit);
  const signal = opts?.signal ? AbortSignal.any([deadline.signal, opts.signal]) : deadline.signal;
  const started = Date.now();
  let text = "";
  try {
    for await (const event of backend.stream!(turns, { ...opts, signal, maxMs: limit })) {
      if (event.type === "delta") text += event.text;
      else if (event.type === "done")
        return { text: event.text || text, backend: backend.id, model: event.model, usage: event.usage, ms: event.ms };
    }
    return { text, backend: backend.id, model: null, usage: null, ms: Date.now() - started };
  } catch (err) {
    if (deadline.signal.aborted && !opts?.signal?.aborted)
      throw new WireError(504, `${backend.label} did not answer within ${Math.round(limit / 1000)} seconds.`);
    if (err instanceof WireError && err.status === 406) return backend.ask(turns, opts);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function activeBackend(): ChatBackend | null {
  const id = readChoice();
  if (!id) return null;
  const make = adapters.get(id);
  const backend = make?.();
  if (!backend) return null;
  return {
    ...backend,
    async ask(turns, opts) {
      const release = await prepare(id, opts?.signal);
      try { return backend.stream ? await askOverStream(backend, turns, opts) : await backend.ask(turns, opts); }
      finally { release(); }
    },
    ...(backend.stream ? {
      async *stream(turns: ChatTurn[], opts?: AskOptions) {
        const release = await prepare(id, opts?.signal);
        try { yield* backend.stream!(turns, opts); }
        finally { release(); }
      },
    } : {}),
  };
}

/** Every backend that could be chosen, and whether each is connected — for the
 *  selector on the Chat page and the plugin pages. */
export function backends(): { id: ChatBackendId; connected: boolean; label: string | null }[] {
  const ids: ChatBackendId[] = ["hermes", "openclaw"];
  return ids.map((id) => {
    const b = adapters.get(id)?.() ?? null;
    return { id, connected: b !== null, label: b?.label ?? null };
  });
}

/**
 * The one call every caller makes.
 *
 * Throws `NoBackendError` rather than returning null so a caller cannot forget
 * to handle the case: the Chat page turns it into a sentence, the Telegram
 * bridge into a reply, and neither can accidentally send nothing.
 */
export async function ask(turns: ChatTurn[], opts?: AskOptions): Promise<ChatReply> {
  const backend = activeBackend();
  if (!backend) throw new NoBackendError();
  /* Registered for the length of the answer — see chat/inflight.ts — so a
     sub-agent dispatched from inside it is filed under this conversation. */
  const end = inflight.begin(opts?.sessionId);
  try {
    return await backend.ask(turns, opts);
  } finally {
    end();
  }
}

export class NoBackendError extends Error {
  constructor() {
    super(
      "No agent is connected. Connect Hermes or OpenClaw under Integrations and choose one as the chat backend.",
    );
    this.name = "NoBackendError";
  }
}
