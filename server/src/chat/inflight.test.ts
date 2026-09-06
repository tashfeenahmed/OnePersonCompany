import { test } from "node:test";
import assert from "node:assert/strict";
import { all, begin, only, track } from "./inflight.ts";

test("one conversation in flight is the one; two is none; runs never count", async () => {
  assert.equal(only(), null);
  const a = begin("s-a");
  assert.equal(only(), "s-a");
  const r = begin("run:r-1");
  assert.equal(only(), "s-a", "a run's own turn is not a conversation");
  const b = begin("s-b");
  assert.equal(only(), null, "two conversations are ambiguous");
  assert.deepEqual(all().sort(), ["s-a", "s-b"]);
  b();
  assert.equal(only(), "s-a");
  a();
  r();
  assert.equal(only(), null);
});

test("a stream keeps its session in flight until it is drained", async () => {
  async function* three() {
    yield 1;
    assert.equal(only(), "s-x");
    yield 2;
    yield 3;
  }
  const seen: number[] = [];
  for await (const n of track("s-x", three())) seen.push(n);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(only(), null);
});

test("nested begins on one session are counted, not flagged", () => {
  const first = begin("s-n");
  const second = begin("s-n");
  first();
  assert.equal(only(), "s-n");
  second();
  assert.equal(only(), null);
});
