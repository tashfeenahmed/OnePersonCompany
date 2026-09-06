/**
 * The run vocabulary, which lives in the repo-root `shared/` because the
 * client's run pages are the other half of it. Tested from the server side, as
 * `shared/workspace.ts` and `shared/runRoutes.ts` already are.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CANCELLING,
  RUN_STATUSES,
  isFinal,
  isLive,
  isRunStatus,
  type RunStatus,
} from "../../../shared/runStatus.ts";

test("five statuses, in lifecycle order, and nothing else", () => {
  assert.deepEqual([...RUN_STATUSES], ["queued", "running", "done", "failed", "cancelled"]);
  assert.equal(RUN_STATUSES.length, 5);
});

test("a status off the wire is checked before it is trusted", () => {
  for (const status of RUN_STATUSES) assert.equal(isRunStatus(status), true);
  /* `paused` is the state that was added to a table without any of the five
     declarations noticing. It is not a status here either — but now there is
     one place to add it. */
  for (const value of ["paused", "cancelling", "", "DONE", null, undefined, 3, {}])
    assert.equal(isRunStatus(value), false, `expected false for ${JSON.stringify(value)}`);
});

test("two statuses mean keep asking, three mean stop", () => {
  const live = RUN_STATUSES.filter((s) => isLive(s));
  assert.deepEqual([...live], ["queued", "running"]);
  const final = RUN_STATUSES.filter((s) => isFinal(s));
  assert.deepEqual([...final], ["done", "failed", "cancelled"]);
});

test("one word for a cancel that has been asked for and has not landed", () => {
  assert.equal(CANCELLING, "cancelling");
  /* It is not a status: the run is still running until it lands, and a page
     that drew `cancelled` here would be showing an outcome that has not
     happened. */
  assert.equal(isRunStatus(CANCELLING), false);
  assert.equal(isLive(CANCELLING), true);
  assert.equal(isFinal(CANCELLING), false);
});

test("the union is assignable from the constant, so the two cannot drift apart", () => {
  const status: RunStatus = RUN_STATUSES[0];
  assert.equal(status, "queued");
});
