import test from "node:test";
import assert from "node:assert/strict";
import { inboxEmpty } from "./inboxView.ts";

test("rows on the screen are not an empty state at all", () => {
  assert.deepEqual(inboxEmpty(3, { total: 3, handled: 0, filtered: false }), { kind: "list" });
});

test("a server with nothing to report is a clear inbox, not a dead end", () => {
  assert.deepEqual(inboxEmpty(0, { total: 0, handled: 0, filtered: false }), { kind: "clear" });
  /* A filter on a genuinely empty inbox is still "nothing anywhere": the
     filter cannot be blamed for rows that never existed. */
  assert.deepEqual(inboxEmpty(0, { total: 0, handled: 0, filtered: true }), { kind: "clear" });
});

test("a filtered view hiding every row is the view's fault, not the inbox's", () => {
  assert.deepEqual(inboxEmpty(0, { total: 7, handled: 0, filtered: true }), { kind: "view-empty", hidden: 7 });
});

test("clearing the inbox from this screen still knows rows existed", () => {
  /* The server sent 4, the page resolved all 4 since the load: the honest
     sentence is "you have handled these", not "nothing was ever here". */
  assert.deepEqual(inboxEmpty(0, { total: 4, handled: 4, filtered: false }), { kind: "view-empty", hidden: 4 });
});

test("hidden never goes negative even if the page's handled set races the load", () => {
  assert.deepEqual(inboxEmpty(0, { total: 1, handled: 3, filtered: false }), { kind: "view-empty", hidden: 1 });
});

test("a filter's hidden count leaves out rows already handled from this screen", () => {
  /* 7 rows came in, 2 were resolved or snoozed here, and the filter hides the
     other 5. Clearing the filter brings back 5, so the sentence says 5. */
  assert.deepEqual(inboxEmpty(0, { total: 7, handled: 2, filtered: true }), { kind: "view-empty", hidden: 5 });
  /* Every row handled and a filter still typed: the filter hides nothing. */
  assert.deepEqual(inboxEmpty(0, { total: 4, handled: 4, filtered: true }), { kind: "view-empty", hidden: 0 });
});
