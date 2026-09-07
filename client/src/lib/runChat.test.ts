import test from "node:test";
import assert from "node:assert/strict";
import { chatView, signature, NEW_BRIEF } from "./runChat.ts";

const runs = [{ id: "r-newest" }, { id: "r-older" }];

test("the address wins when it names a run", () => {
  assert.deepEqual(chatView("r-older", runs, false), { run: "r-older", blank: false });
  /* Including on the analyst, whose default is a grid: a row was pressed. */
  assert.deepEqual(chatView("r-older", runs, true), { run: "r-older", blank: false });
});

test("no address opens the newest run, the way the chat opens the last one", () => {
  assert.deepEqual(chatView(null, runs, false), { run: "r-newest", blank: false });
});

test("a worker with no runs is the empty page rather than a missing one", () => {
  assert.deepEqual(chatView(null, [], false), { run: null, blank: true });
});

test("the analyst's own list stays its landing page", () => {
  assert.deepEqual(chatView(null, runs, true), { run: null, blank: false });
  assert.deepEqual(chatView(null, [], true), { run: null, blank: false });
});

test("New brief is an address, and it is blank on every worker", () => {
  assert.deepEqual(chatView(NEW_BRIEF, runs, false), { run: null, blank: true });
  assert.deepEqual(chatView(NEW_BRIEF, runs, true), { run: null, blank: true });
});

test("the signature leaves out what it does not know", () => {
  assert.deepEqual(
    signature({ worker: "Competitor Analyst", backend: "hermes · hermes-agent", took: "10m 2s", steps: 44, words: 5882, cards: 2 }),
    ["Competitor Analyst", "hermes · hermes-agent", "10m 2s", "44 tool calls", "5,882 words", "2 board suggestions"],
  );
  assert.deepEqual(
    signature({ worker: "Dossier writer", backend: "", took: null, steps: 0, words: 0, cards: 0 }),
    ["Dossier writer"],
  );
});

test("one of a thing is singular", () => {
  assert.deepEqual(
    signature({ worker: "W", backend: "", took: "", steps: 1, words: 1, cards: 1 }),
    ["W", "1 tool call", "1 word", "1 board suggestion"],
  );
});
