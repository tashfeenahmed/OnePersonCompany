/**
 * REATTACHING TO AN ANSWER THAT IS ALREADY BEING WRITTEN.
 *
 * The Chat page's header used to say, at length and honestly, that a reload
 * could not re-attach to a turn in flight: the stream belonged to a request and
 * the request died with the tab, so a refresh mid-answer showed the partial row
 * and called it cut off. That is no longer the shape of the server. A chat turn
 * is a RUN it owns (server/src/chat/runs.ts): it has an id, its events are
 * buffered with sequence numbers, and it keeps going whether or not anybody is
 * listening.
 *
 * So this file is the other end of that. Three calls and no state:
 *
 *   attachChatRun   subscribe to a run from sequence `since` — 0 for a page
 *                   with nothing on screen, N for a client that was reading and
 *                   lost its connection, so it gets the tail and not the answer
 *                   twice.
 *   cancelChatRun   the stop button. It is now an explicit request rather than
 *                   a side effect of closing a socket, because closing a socket
 *                   no longer stops anything.
 *   answeringSessions  which conversations the SERVER is answering, for the
 *                   rail after a reload — the browser's own marks died with the
 *                   page, and a mark restored from localStorage would be
 *                   reporting an answer nobody is receiving.
 *
 * THE PARSER IS A SECOND COPY AND THAT IS DELIBERATE. `api.chatStream` has one
 * of these for the POST door; this is the GET door, and the two differ in
 * exactly one respect — this one starts from a sequence number and can be
 * called repeatedly for the same turn. Sharing the loop would mean exporting a
 * frame reader from `api.ts` for one caller, and the loop is thirty lines whose
 * two traps (a chunk can end mid-character; only a blank line dispatches) are
 * written down in both places rather than assumed in one.
 */
import type { ChatRunState, ChatStreamHandlers } from "@/lib/api";
import { call } from "@/lib/api";

/** Everything the reattach door can announce, on top of the ordinary turn
 *  events. `run` is always first: it is how a client learns, in one frame,
 *  whether there is anything still arriving. */
export type ChatRunHandlers = ChatStreamHandlers & {
  onRun?: (e: {
    runId: string;
    sessionId?: string;
    status: ChatRunState["status"];
    attachable?: boolean;
    error?: string | null;
  }) => void;
};

/**
 * Watch a run from `since`, and resolve when it is over.
 *
 * A NORMAL `fetch` AND NOT `EventSource`, for the reason every SSE client in
 * this codebase is: EventSource reconnects on its own, and a reconnect that
 * re-requested a turn would be a second answer nobody asked for. Here it would
 * be harmless — this door only reads — but the abort semantics matter: the
 * caller must be able to STOP READING without stopping the run, and that is
 * precisely what closing this fetch does now.
 *
 * The signal detaches the reader. It does not cancel the answer; `cancelChatRun`
 * is the only thing that does.
 */
export async function attachChatRun(
  runId: string,
  since: number,
  handlers: ChatRunHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `/api/chat/runs/${encodeURIComponent(runId)}/events?since=${Math.max(0, Math.floor(since))}`,
    { headers: { accept: "text/event-stream" }, signal },
  );
  if (!res.ok || !res.body) {
    /* A run this server has never heard of is a 404 and is not an exception
       worth throwing at a page: the transcript is still the truth and the
       caller's fallback is to read it. */
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];

  const dispatch = () => {
    if (!data.length) {
      event = null;
      return;
    }
    const raw = data.join("\n");
    data = [];
    const name = event;
    event = null;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* One malformed frame is one lost event, not a lost turn. */
      return;
    }
    switch (name) {
      case "run":
        handlers.onRun?.(parsed as Parameters<NonNullable<ChatRunHandlers["onRun"]>>[0]);
        break;
      case "start":
        handlers.onStart?.(parsed as Parameters<NonNullable<ChatStreamHandlers["onStart"]>>[0]);
        break;
      case "delta":
        handlers.onDelta?.((parsed as { text: string }).text);
        break;
      case "reasoning":
        handlers.onReasoning?.((parsed as { text: string }).text);
        break;
      case "child":
        handlers.onChild?.(parsed as Parameters<NonNullable<ChatStreamHandlers["onChild"]>>[0]);
        break;
      case "tool":
        handlers.onTool?.(parsed as Parameters<NonNullable<ChatStreamHandlers["onTool"]>>[0]);
        break;
      case "done":
        handlers.onDone?.(parsed as Parameters<NonNullable<ChatStreamHandlers["onDone"]>>[0]);
        break;
      case "error":
        handlers.onError?.(parsed as Parameters<NonNullable<ChatStreamHandlers["onError"]>>[0]);
        break;
      /* An event this build does not know about is skipped rather than guessed
         at. A newer server may say more than an older page reads. */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          dispatch();
          continue;
        }
        /* A comment. The server writes `: keepalive` while the agent is still
           thinking, and it is not an event. */
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value2 = colon === -1 ? "" : line.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);
        if (field === "event") event = value2;
        else if (field === "data") data.push(value2);
        /* `id` carries the sequence number. It is not read here: the caller
           that wants to resume from a point counts the frames it handled,
           which is the same number and needs no parsing. */
      }
    }
    /* A stream that ends without a trailing blank line still has a frame in
       hand, and it is usually the `done`. */
    dispatch();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Stop one turn.
 *
 * WHAT WAS SAID IS KEPT. The server writes whatever the agent had written as a
 * partial assistant row before it reports the run cancelled, so pressing this
 * loses nothing that was on screen — the same promise the old abort made, now
 * made by something that survives the tab.
 */
export function cancelChatRun(runId: string) {
  return call<{ runId: string; status: ChatRunState["status"] }>(
    `/chat/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
}

/** Which conversations the server is answering right now. */
export function answeringSessions() {
  return call<{ sessions: string[] }>("/chat/runs");
}
