/**
 * WHICH CONVERSATIONS ARE BEING ANSWERED RIGHT NOW.
 *
 * The one fact a dispatch needs that the agent keeps failing to pass. The
 * sub-agents skill takes a `parentSessionId` so a run is filed under the chat
 * that asked for it; the system turn names the id; and the agent, asked to
 * research a venture, wrote "Parent session: s-0jk8q6" INTO THE BRIEF and
 * dispatched without the flag. The run then existed nowhere near the
 * conversation, and the owner asked why the rail showed nothing.
 *
 * So the server keeps the fact itself. Every chat turn registers its session
 * here for as long as the backend is answering it — the `ask` wrapper and the
 * stream route are the two doors — and a dispatch that arrives with no parent
 * while EXACTLY ONE conversation is in flight is filed under that one. Two in
 * flight is ambiguous and stays unfiled, as before; the explicit flag always
 * wins. The inference is reported on the reply as `parentSessionInferred`, so
 * a reader can tell a stated parent from a deduced one.
 *
 * Counted rather than flagged: a session can be answered on the web while a
 * Telegram poll re-asks it, and a set would drop the first when the second
 * ended.
 */
const live = new Map<string, number>();

/** Mark a session as being answered. Returns the matching release. */
export function begin(sessionId: string | null | undefined): () => void {
  /* A sub-agent's own turns come through the same backend under `run:<id>`
     — see runs/executor.ts — and a run is not a conversation: a dispatch
     made while one is working must not be filed under it, and its presence
     must not make the owner's one open chat look like two. */
  if (!sessionId || sessionId.startsWith("run:")) return () => {};
  live.set(sessionId, (live.get(sessionId) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (live.get(sessionId) ?? 1) - 1;
    if (n <= 0) live.delete(sessionId);
    else live.set(sessionId, n);
  };
}

/** The one session in flight, or null when there are none or several. */
export function only(): string | null {
  return live.size === 1 ? [...live.keys()][0]! : null;
}

/** Every session in flight — for a reader that wants the ambiguity spelled out. */
export function all(): string[] {
  return [...live.keys()];
}

/* ---------------------------------------------------------- notifications */

/**
 * WHAT HAPPENED TO A CONVERSATION WHILE IT WAS BEING ANSWERED. A dispatch
 * filed under a chat mid-turn is something the rail should show at once, not
 * when the turn ends; the stream route subscribes for its session and writes
 * whatever arrives here as a `child` event. Nothing is queued for a session
 * nobody is streaming — the row is on disk and the next rail read finds it.
 */
/*
 * THE FRAME CARRIES THE RUN, NOT A RUMOUR OF IT.
 *
 * A thinner shape with no `app` and no `to` would leave the rail unable to
 * draw a linkable child from it: it would have to throw the payload away and
 * re-poll the whole session list to find out what it had just been told — a
 * typed event doing the work of a "something changed" ping, at the cost of a
 * request. So this is a `RunChild` — the same shape the polled list
 * publishes, from the same builder — and a live child draws exactly like a
 * fetched one.
 *
 * A TYPE-ONLY IMPORT, so nothing of the subagents area is loaded to run a
 * chat: this file is on the hot path of every turn and the shape is erased at
 * compile time.
 */
import type { RunChild } from "../integrations/subagents/store.ts";

const listeners = new Map<string, Set<(e: RunChild) => void>>();

export function subscribe(sessionId: string, cb: (e: RunChild) => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (!set!.size) listeners.delete(sessionId);
  };
}

export function notify(sessionId: string, e: RunChild): void {
  for (const cb of [...(listeners.get(sessionId) ?? [])]) {
    try {
      cb(e);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/** A stream, registered for as long as it is being read. */
export async function* track<T>(sessionId: string | null | undefined, events: AsyncGenerator<T>): AsyncGenerator<T> {
  const end = begin(sessionId);
  try {
    for await (const e of events) yield e;
  } finally {
    end();
  }
}
