import test from "node:test";
import assert from "node:assert/strict";
import { officeMotion } from "./officeMotion.ts";

function harness() {
  let time = 0,
    next = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const renders: number[] = [],
    states: boolean[] = [];
  const motion = officeMotion({
    render: (progress) => renders.push(progress),
    playing: (value) => states.push(value),
    request: (callback) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    cancel: (id) => {
      pending.delete(id);
    },
    now: () => time,
  });
  const advance = (ms: number) => {
    const until = time + ms;
    while (time < until) {
      time += 1000 / 60;
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback(time));
    }
  };
  return { motion, pending, renders, states, advance };
}

test("office stops scheduling frames after its intro and renders nothing while idle", () => {
  const h = harness();
  h.motion.play();
  h.advance(3000);
  assert.equal(h.renders.at(-1), 1);
  assert.equal(h.pending.size, 0);
  assert.equal(h.states.at(-1), false);
  assert(h.renders.length < 86, "render rate is capped at 30fps");
  const count = h.renders.length;
  h.advance(10000);
  assert.equal(h.renders.length, count);
  h.motion.play();
  h.advance(3000);
  assert(h.renders.length > count, "replay starts a new finite intro");
  assert.equal(h.pending.size, 0);
});
test("reduced motion renders one final frame without scheduling animation", () => {
  const h = harness();
  h.motion.play(true);
  assert.deepEqual(h.renders, [1]);
  assert.equal(h.pending.size, 0);
});
test("hiding the office cancels work; showing it settles instead of replaying", () => {
  const h = harness();
  h.motion.play();
  h.advance(300);
  h.motion.stop();
  assert.equal(h.pending.size, 0);
  const count = h.renders.length;
  h.advance(10000);
  assert.equal(h.renders.length, count);
  h.motion.settle();
  assert.equal(h.renders.at(-1), 1);
  assert.equal(h.renders.length, count + 1);
  assert.equal(h.pending.size, 0);
});
test("unmount cancels pending frames and prevents late replays or renders", () => {
  const h = harness();
  h.motion.play();
  h.advance(500);
  h.motion.dispose();
  const count = h.renders.length;
  h.motion.play();
  h.motion.settle();
  h.advance(10000);
  assert.equal(h.pending.size, 0);
  assert.equal(h.renders.length, count);
});
