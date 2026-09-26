import test from "node:test";
import assert from "node:assert/strict";
import { clickPicks, keyAction, toggle } from "./railPick.ts";

/* The rails pick rows with a mouse already (shift-click). These pin that the
   keyboard reaches the SAME set of decisions, and that nothing about the
   mouse rules moved. See railPick.ts for the gesture contract. */

test("a plain click picks nothing — it navigates", () => {
  assert.equal(clickPicks({}), false);
});

test("shift, ⌘ and Ctrl each pick", () => {
  assert.equal(clickPicks({ shiftKey: true }), true);
  assert.equal(clickPicks({ metaKey: true }), true);
  assert.equal(clickPicks({ ctrlKey: true }), true);
});

test("Space on a focused row picks it; Enter navigates", () => {
  assert.equal(keyAction({ key: " " }), "pick");
  assert.equal(keyAction({ key: "Enter" }), "navigate");
});

test("Shift+Enter picks, matching Shift+click", () => {
  assert.equal(keyAction({ key: "Enter", shiftKey: true }), "pick");
});

test("Space with a modifier is not a pick — an odd chord does nothing here", () => {
  /* A browser may give ⌘Space to the OS and never show it; the ones it does
     show with a modifier are someone's shortcut, not this row's gesture. */
  assert.equal(keyAction({ key: " ", metaKey: true }), "navigate");
  assert.equal(keyAction({ key: " ", shiftKey: true }), "navigate");
  assert.equal(keyAction({ key: " ", ctrlKey: true }), "navigate");
});

test("any other key is left alone", () => {
  assert.equal(keyAction({ key: "a" }), "navigate");
  assert.equal(keyAction({ key: "Tab" }), "navigate");
});

test("toggle adds, removes, and keeps the order rows were picked in", () => {
  let keys: string[] = [];
  keys = toggle(keys, "a");
  keys = toggle(keys, "b");
  assert.deepEqual(keys, ["a", "b"]);
  keys = toggle(keys, "a");
  assert.deepEqual(keys, ["b"]);
  keys = toggle(keys, "b");
  assert.deepEqual(keys, []);
});
