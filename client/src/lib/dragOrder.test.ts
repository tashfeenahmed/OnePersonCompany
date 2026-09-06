import { test } from "node:test";
import assert from "node:assert/strict";
import { moveTo, slotFor, type Rect } from "./dragOrder.ts";

/* Two rows of two, 100 wide, 50 tall, 10 apart. */
const R: Rect[] = [
  { id: "a", left: 0, top: 0, width: 100, height: 50 },
  { id: "b", left: 110, top: 0, width: 100, height: 50 },
  { id: "c", left: 0, top: 60, width: 100, height: 50 },
  { id: "d", left: 110, top: 60, width: 100, height: 50 },
];

test("left half of a card inserts before it, right half after the row's last", () => {
  assert.deepEqual(slotFor(R, 20, 25), { index: 0, mark: { id: "a", side: "before" } });
  assert.deepEqual(slotFor(R, 130, 25), { index: 1, mark: { id: "b", side: "before" } });
  assert.deepEqual(slotFor(R, 190, 25), { index: 2, mark: { id: "b", side: "after" } });
});

test("empty space below the last row is the end", () => {
  assert.deepEqual(slotFor(R, 300, 400), { index: 4, mark: { id: "d", side: "after" } });
});

test("between rows picks the nearer row", () => {
  assert.deepEqual(slotFor(R, 20, 53), { index: 0, mark: { id: "a", side: "before" } });
  assert.deepEqual(slotFor(R, 20, 57), { index: 2, mark: { id: "c", side: "before" } });
});

test("no cards: index 0, nothing to mark", () => {
  assert.deepEqual(slotFor([], 10, 10), { index: 0, mark: null });
});

test("moveTo reinserts among the others", () => {
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(moveTo(list, "a", 2).map((w) => w.id), ["b", "c", "a"]);
  assert.deepEqual(moveTo(list, "c", 0).map((w) => w.id), ["c", "a", "b"]);
  assert.deepEqual(moveTo(list, "b", 1).map((w) => w.id), ["a", "b", "c"]);
});
