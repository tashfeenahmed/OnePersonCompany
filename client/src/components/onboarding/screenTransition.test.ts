import test from "node:test";
import assert from "node:assert/strict";
import { screenTransition } from "./screenTransition.ts";

function fixture() {
  const animations: {
    finish: () => void;
    cancel: () => void;
    cancelled: boolean;
  }[] = [];
  const node = {
    animate() {
      const gate = Promise.withResolvers<void>();
      const animation = {
        finished: gate.promise,
        cancelled: false,
        finish: () => gate.resolve(),
        cancel() {
          this.cancelled = true;
          gate.reject(new Error("cancelled"));
        },
      };
      animations.push(animation);
      return animation;
    },
  } as unknown as HTMLElement;
  return { animations, node };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a screen changes only after its exit, rejects double navigation, and releases animation styles", async () => {
  const { animations, node } = fixture();
  const motion = screenTransition(
    () => node,
    () => false,
  );
  let page = "welcome";
  const running = motion.run(() => {
    page = "name";
  });
  await motion.run(() => {
    page = "unexpected";
  });
  assert.equal(page, "welcome");
  animations[0].finish();
  await tick();
  assert.equal(page, "name");
  assert.equal(animations.length, 2);
  animations[1].finish();
  await running;
  assert(animations.every((a) => a.cancelled));
});
test("leaving onboarding during a fade never commits the stale screen", async () => {
  const { animations, node } = fixture();
  const motion = screenTransition(
    () => node,
    () => false,
  );
  let commits = 0;
  const running = motion.run(() => {
    commits++;
  });
  motion.dispose();
  await running;
  await motion.run(() => {
    commits++;
  });
  assert.equal(commits, 0);
  assert.equal(animations.length, 1);
  assert(animations[0].cancelled);
});
test("reduced motion and missing animation support navigate without animations", async () => {
  const { animations, node } = fixture();
  let commits = 0;
  await screenTransition(
    () => node,
    () => true,
  ).run(() => {
    commits++;
  });
  await screenTransition(
    () => ({}) as HTMLElement,
    () => false,
  ).run(() => {
    commits++;
  });
  assert.equal(commits, 2);
  assert.equal(animations.length, 0);
});
test("switching to reduced motion finishes the current fade and skips the entrance", async () => {
  const { animations, node } = fixture();
  let reduced = false;
  let committed = false;
  const motion = screenTransition(
    () => node,
    () => reduced,
  );
  const running = motion.run(() => {
    committed = true;
  });
  reduced = true;
  motion.finish();
  await running;
  assert(committed);
  assert.equal(animations.length, 1);
  assert(animations[0].cancelled);
});
