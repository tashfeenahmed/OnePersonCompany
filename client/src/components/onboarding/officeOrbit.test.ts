import test from "node:test";
import assert from "node:assert/strict";
import { officeOrbit, type OfficeView } from "./officeOrbit.ts";

class Surface extends EventTarget {
  capture = new Set<number>();
  attributes = new Map<string, string>();
  focused = false;
  getBoundingClientRect() {
    return { width: 600, height: 500 };
  }
  setPointerCapture(id: number) {
    this.capture.add(id);
  }
  hasPointerCapture(id: number) {
    return this.capture.has(id);
  }
  releasePointerCapture(id: number) {
    this.capture.delete(id);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  focus() {
    this.focused = true;
  }
}
function harness(reducedMotion = false) {
  const surface = new Surface();
  const pending = new Map<number, FrameRequestCallback>();
  const changes: OfficeView[] = [];
  let starts = 0,
    id = 0,
    time = 0;
  const orbit = officeOrbit(surface as unknown as HTMLElement, {
    start: () => {
      starts++;
    },
    change: (view) => changes.push(view),
    request: (callback) => {
      pending.set(++id, callback);
      return id;
    },
    cancel: (frame) => {
      pending.delete(frame);
    },
    now: () => time,
    reducedMotion: () => reducedMotion,
  });
  function send(type: string, values: Record<string, unknown> = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 0,
      clientY: 0,
      ...values,
    });
    surface.dispatchEvent(event);
    return event;
  }
  const flush = () => {
    const callbacks = [...pending.values()];
    pending.clear();
    callbacks.forEach((callback) => callback(time));
  };
  const advance = (ms: number, frameMs = 1000 / 60) => {
    const end = time + ms;
    while (time < end) {
      time = Math.min(end, time + frameMs);
      flush();
    }
  };
  return {
    surface,
    pending,
    changes,
    orbit,
    send,
    flush,
    advance,
    starts: () => starts,
  };
}

test("drag captures and coalesces moves; pausing before release leaves it still", () => {
  const h = harness();
  h.send("pointerdown");
  assert(h.surface.focused);
  assert(h.surface.capture.has(1));
  assert.equal(h.starts(), 1);
  h.send("pointermove", { clientX: 75 });
  h.send("pointermove", { clientX: 150 });
  assert.equal(h.pending.size, 1);
  h.flush();
  assert.equal(h.changes.length, 1);
  assert(Math.abs(h.changes[0]!.yaw + Math.PI / 2) < 1e-9);
  h.advance(150);
  h.send("pointerup");
  assert.equal(h.surface.capture.size, 0);
  assert(!h.surface.attributes.has("data-dragging"));
  assert.equal(h.pending.size, 0);
  h.send("pointermove", { clientX: 300 });
  h.flush();
  assert.equal(h.changes.length, 1);
});
test("horizontal dragging can complete multiple revolutions while tilt remains bounded", () => {
  const h = harness();
  h.send("pointerdown", { pointerType: "touch" });
  for (let x = 50; x <= 1200; x += 50) h.send("pointermove", { clientX: x });
  h.flush();
  assert(Math.abs(h.orbit.view().yaw) < 1e-9);
  h.send("pointermove", { clientX: 1200, clientY: 5000 });
  assert.equal(h.orbit.view().elevation, 1.3);
  h.send("pointermove", { clientX: 1200, clientY: -5000 });
  assert.equal(h.orbit.view().elevation, 0.12);
});
test("secondary buttons and pointers cannot take over an active drag", () => {
  const h = harness();
  h.send("pointerdown", { button: 2 });
  h.send("pointerdown", { isPrimary: false });
  assert.equal(h.starts(), 0);
  h.send("pointerdown", { pointerType: "pen" });
  h.send("pointerdown", { pointerId: 2 });
  h.send("pointermove", { pointerId: 2, clientX: 100 });
  h.send("pointerup", { pointerId: 2 });
  assert.equal(h.starts(), 1);
  assert.equal(h.pending.size, 0);
  assert(h.surface.capture.has(1));
});
test("pointer cancellation and lost capture end the gesture without sticking", () => {
  for (const type of ["pointercancel", "lostpointercapture"]) {
    const h = harness();
    h.send("pointerdown");
    h.send(type);
    h.send("pointermove", { clientX: 100 });
    assert.equal(h.surface.capture.size, 0);
    assert.equal(h.pending.size, 0);
    assert(!h.surface.attributes.has("data-dragging"));
    h.send("pointerdown");
    assert.equal(h.starts(), 2);
  }
});
test("hiding or disposing releases capture and cancels queued interaction frames", () => {
  const h = harness();
  h.send("pointerdown");
  h.send("pointermove", { clientX: 100 });
  h.orbit.setEnabled(false);
  assert.equal(h.pending.size, 0);
  assert.equal(h.surface.capture.size, 0);
  h.send("pointerdown");
  h.send("keydown", { key: "ArrowLeft" });
  assert.equal(h.starts(), 1);
  const chosen = h.orbit.view();
  h.orbit.setEnabled(true);
  assert.deepEqual(h.orbit.view(), chosen);
  h.send("pointerdown");
  h.send("pointermove", { clientX: 150 });
  h.orbit.dispose();
  assert.equal(h.pending.size, 0);
  assert.equal(h.surface.capture.size, 0);
  h.send("pointerdown");
  h.send("keydown", { key: "Home" });
  h.flush();
  assert.equal(h.changes.length, 0);
  assert.equal(h.starts(), 2);
});
test("keyboard rotates and restores the home view without consuming unrelated shortcuts", () => {
  const h = harness();
  const home = h.orbit.view();
  assert(h.send("keydown", { key: "ArrowRight" }).defaultPrevented);
  assert(h.send("keydown", { key: "ArrowUp" }).defaultPrevented);
  h.flush();
  assert(h.orbit.view().yaw < 0);
  assert(h.orbit.view().elevation > home.elevation);
  assert(
    !h.send("keydown", { key: "ArrowLeft", metaKey: true }).defaultPrevented,
  );
  assert(!h.send("keydown", { key: "Tab" }).defaultPrevented);
  h.send("keydown", { key: "Home" });
  h.flush();
  assert.deepEqual(h.orbit.view(), home);
  assert.equal(h.pending.size, 0);
});

function fling(h: ReturnType<typeof harness>) {
  h.send("pointerdown");
  h.advance(16);
  h.send("pointermove", { clientX: 30 });
  h.advance(16);
  h.send("pointermove", { clientX: 70 });
  h.send("pointerup");
}
const distance = (from: number, to: number) =>
  Math.abs(Math.atan2(Math.sin(to - from), Math.cos(to - from)));

test("a flick glides with decreasing speed, then stops scheduling frames", () => {
  const h = harness();
  fling(h);
  const released = h.orbit.view().yaw;
  h.advance(100);
  const first = h.orbit.view().yaw;
  h.advance(100);
  const second = h.orbit.view().yaw;
  assert(distance(released, first) > 0.05, "release has visible momentum");
  assert(
    distance(first, second) < distance(released, first),
    "friction reduces angular speed",
  );
  h.advance(2000);
  assert.equal(h.pending.size, 0);
  const count = h.changes.length;
  h.advance(10000);
  assert.equal(
    h.changes.length,
    count,
    "no background animation after settling",
  );
});
test("momentum travels the same distance on 60Hz and 120Hz displays", () => {
  const slow = harness(),
    fast = harness();
  fling(slow);
  fling(fast);
  slow.advance(2000, 1000 / 60);
  fast.advance(2000, 1000 / 120);
  assert(distance(slow.orbit.view().yaw, fast.orbit.view().yaw) < 0.001);
  assert.equal(slow.pending.size + fast.pending.size, 0);
});
test("re-grabbing, reset, hiding, replay stop, and disposal interrupt the glide", () => {
  for (const action of ["grab", "Home", "hide", "stop", "dispose"]) {
    const h = harness();
    fling(h);
    h.advance(80);
    if (action === "grab") h.send("pointerdown");
    if (action === "Home") h.send("keydown", { key: "Home" });
    if (action === "hide") h.orbit.setEnabled(false);
    if (action === "stop") h.orbit.stop();
    if (action === "dispose") h.orbit.dispose();
    h.flush();
    const view = h.orbit.view(),
      count = h.changes.length;
    h.advance(3000);
    assert.deepEqual(h.orbit.view(), view, action);
    assert.equal(h.changes.length, count, action);
    assert.equal(h.pending.size, 0, action);
  }
});
test("reduced motion, taps and cancelled gestures never coast", () => {
  const reduced = harness(true);
  fling(reduced);
  reduced.flush();
  assert.equal(reduced.pending.size, 0);
  for (const end of ["pointerup", "pointercancel", "lostpointercapture"]) {
    const h = harness();
    h.send("pointerdown");
    if (end !== "pointerup") h.send("pointermove", { clientX: 100 });
    h.send(end);
    h.flush();
    assert.equal(h.pending.size, 0, end);
  }
});
test("momentum cannot carry the camera beyond its elevation limits", () => {
  for (const y of [-90, 90]) {
    const h = harness();
    h.send("pointerdown");
    h.advance(16);
    h.send("pointermove", { clientY: y });
    h.send("pointerup");
    h.advance(2000);
    assert(
      h.changes.every(
        (view) => view.elevation >= 0.12 && view.elevation <= 1.3,
      ),
    );
    assert.equal(h.pending.size, 0);
  }
});
test("pointer interaction suppresses the ring until keyboard input or blur", () => {
  const h = harness();
  h.send("pointerdown");
  assert.equal(h.surface.attributes.get("data-pointer-focus"), "true");
  h.send("pointerup");
  assert.equal(h.surface.attributes.get("data-pointer-focus"), "true");
  h.send("keydown", { key: "ArrowLeft" });
  assert(!h.surface.attributes.has("data-pointer-focus"));
  h.send("pointerdown");
  h.send("pointerup");
  h.send("blur");
  assert(!h.surface.attributes.has("data-pointer-focus"));
});
