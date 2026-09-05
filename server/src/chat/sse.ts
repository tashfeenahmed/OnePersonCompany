/**
 * READING SERVER-SENT EVENTS OFF A `fetch` BODY.
 *
 * This is the half of streaming that everybody writes wrong, and the wrong
 * version works for weeks before it does not. `res.body` is a stream of BYTES,
 * not of events: a chunk can end in the middle of a UTF-8 character, in the
 * middle of a line, or in the middle of a frame, and three chunks can arrive
 * carrying four frames between them. The naive implementation —
 * `chunk.toString().split("\n\n")` — is correct until the first answer
 * containing an emoji lands on a buffer boundary, at which point it produces a
 * replacement character in the middle of a word and nobody can reproduce it.
 *
 * So: a TextDecoder with `{ stream: true }` (it holds the split character
 * until the rest of it arrives) and an explicit line buffer that only emits a
 * frame on a blank line.
 *
 * WHY IT IS NOT `EventSource`. EventSource cannot POST, cannot set an
 * Authorization header, and reconnects on its own — which on a chat endpoint
 * means silently asking the same question again and paying for it twice. Every
 * SSE client in this codebase is fetch plus this parser, on both sides of the
 * wire: the server reads the agent's stream with it, and the browser reads
 * this server's stream with a copy of it (client/src/lib/api.ts) for exactly
 * the same reasons.
 *
 * THE FIELDS THIS UNDERSTANDS, AND THE ONE THAT MATTERS. The spec has four —
 * `event`, `data`, `id`, `retry` — plus comment lines that begin with a colon
 * and exist to keep a proxy from closing an idle connection. `data` is the
 * only one that can repeat, and repeats are joined with newlines rather than
 * concatenated, which is the difference between a two-line JSON document
 * parsing and not.
 *
 * `event` is what makes this more than an OpenAI chunk reader. Hermes' router
 * interleaves NAMED events — `event: hermes.tool.progress` — with the ordinary
 * anonymous `data:` chunks, and a parser that threw the event name away would
 * read a tool call as a malformed completion chunk and drop it. That name is
 * the whole reason the Chat page can draw what the agent did while it was
 * thinking.
 */

/** One dispatched event. `event` is null for the anonymous `data:`-only frames
 *  that carry ordinary OpenAI chunks — null rather than the spec's default of
 *  "message", because the caller's question is "was this named?" and answering
 *  it with a name the server never sent would be an invention. */
export type SseFrame = {
  event: string | null;
  data: string;
};

/** The sentinel every OpenAI-compatible server ends a stream with. It is not
 *  JSON and parsing it as JSON is the second-most-common bug in this area. */
export const SSE_DONE = "[DONE]";

/**
 * A byte stream in, frames out.
 *
 * An async generator rather than a callback, because the caller needs to be
 * able to STOP — `break` out of a `for await` and the reader is released
 * through the generator's `finally`, which is what cancels the upstream
 * request when the browser closes its tab. A callback-based reader has no way
 * to be told to stop that is not a flag somebody forgets to check.
 *
 * A frame with no `data` line at all is dropped rather than emitted empty: it
 * is a keep-alive comment or a stray `id:`, and both are transport noise the
 * caller has no use for.
 */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /* The frame being assembled. `data` accumulates across repeated data lines;
     `event` is last-one-wins, which is what the spec says and what every
     server does anyway. */
  let event: string | null = null;
  let data: string[] = [];

  function flush(): SseFrame | null {
    const frame = data.length ? { event, data: data.join("\n") } : null;
    event = null;
    data = [];
    return frame;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      /*
        \r\n as well as \n. The spec allows CRLF, LF and a bare CR as line
        terminators; a gateway behind a proxy that normalises line endings is
        not a hypothetical, and a parser that only knows \n reads a CRLF stream
        as one enormous line that never ends.
      */
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));

        /* A blank line dispatches. This is the ONLY thing that ends a frame —
           not a `data:` line, not the next `event:`. */
        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
          continue;
        }
        /* A comment. Servers send `: keep-alive` every so often to stop an
           idle proxy from hanging up, and it is not an event. */
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        /* The spec strips exactly ONE leading space after the colon, and only
           one — `data:  x` carries a value that starts with a space. */
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);

        if (field === "event") event = value;
        else if (field === "data") data.push(value);
        /* `id` and `retry` are for reconnection, which this never does. */
      }
    }

    /*
      A stream that ends without a trailing blank line still has a frame in
      hand, and it is usually the last thing the agent said. Dropping it is how
      an answer loses its final sentence on a server that closes the socket
      tidily but not politely.
    */
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split(/\r\n|\r|\n/)) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    /*
      Releasing the lock is what propagates a `break` in the caller's loop back
      down the wire: the reader is cancelled, the body is cancelled, and the
      agent stops being paid to write an answer nobody will read.
    */
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** `JSON.parse` that answers null instead of throwing. A stream is a place
 *  where one malformed chunk must not end the turn — the answer so far is
 *  still real, and the next chunk is probably fine. */
export function parseFrame<T>(data: string): T | null {
  if (!data || data === SSE_DONE) return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
