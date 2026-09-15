import test from "node:test";
import assert from "node:assert/strict";
import { chatView, runBelongsToWorker, signature, NEW_BRIEF } from "./runChat.ts";
import { subagentPage } from "../../../shared/runRoutes.ts";

const runs = [{ id: "r-newest" }, { id: "r-older" }];

test("each worker run has a distinct, encoded path including portfolio workers", () => {
  assert.equal(subagentPage("seo", "cedar", "r-one"), "/ventures/cedar/team/seo/runs/r-one");
  assert.notEqual(subagentPage("seo", "cedar", "r-one"), subagentPage("seo", "cedar", "r-two"));
  assert.equal(subagentPage("people", null, "r-one"), "/team/people/runs/r-one");
  assert.equal(subagentPage("role /x", "a/b", "r ?#"), "/ventures/a%2Fb/team/role%20%2Fx/runs/r%20%3F%23");
});

test("a worker only displays runs for its own kind and venture", () => {
  const run = { kind: "seo", ventureId: "v-one" };
  assert.ok(runBelongsToWorker(run, run));
  assert.equal(runBelongsToWorker(run, { ...run, kind: "geo" }), false);
  assert.equal(runBelongsToWorker(run, { ...run, ventureId: "v-two" }), false);
  assert.equal(runBelongsToWorker(run, { ...run, ventureId: null }), false);
  assert.ok(runBelongsToWorker({ kind: "dossier", ventureId: null }, { kind: "dossier", ventureId: null }));
});

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
