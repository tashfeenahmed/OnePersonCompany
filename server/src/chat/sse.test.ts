/**
 * The one property of the SSE reader that a stalled chat depends on: a
 * keepalive COMMENT is activity. Hermes writes `: keepalive` every thirty
 * seconds while its model is still thinking, and the idle timer in wire.ts
 * must learn of it, or a long think is reported as a dead agent at ninety
 * seconds — which is what happened, on a 97,000-token context, in a
 * conversation that then lost its answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readSse } from "./sse.ts";

function stream(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const p of parts) ctrl.enqueue(enc.encode(p));
      ctrl.close();
    },
  });
}

test("a keepalive comment yields no frame but counts as activity", async () => {
  let activity = 0;
  const frames = [];
  for await (const f of readSse(stream([": keepalive\n\n", ": keepalive\n\n", "data: {\"x\":1}\n\n"]), {
    onActivity: () => activity++,
  }))
    frames.push(f);
  assert.equal(frames.length, 1, "comments are not frames");
  assert.equal(frames[0]!.data, '{"x":1}');
  assert.equal(activity, 3, "every chunk, comment or frame, is activity");
});

test("without a callback the reader behaves as before", async () => {
  const frames = [];
  for await (const f of readSse(stream(["event: ping\ndata: a\ndata: b\n\n"]))) frames.push(f);
  assert.deepEqual(frames, [{ event: "ping", data: "a\nb" }]);
});
