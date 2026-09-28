import { test } from "node:test";
import assert from "node:assert/strict";
import { carriedCards, groupAnchor } from "./boardSelection.ts";

const board = { columns: [
  { id: 1, cards: [{ id: 10 }, { id: 11 }, { id: 12 }] },
  { id: 2, cards: [{ id: 20 }, { id: 21 }] },
] };

test("grabbing a selected card carries the selection in board order", () => {
  assert.deepEqual(carriedCards(board, new Set([21, 11, 10]), 21), [10, 11, 21]);
  assert.deepEqual(carriedCards(board, new Set([11, 99]), 11), [11], "ids gone from the board drop out");
});

test("grabbing an unselected card carries only that card", () => {
  assert.deepEqual(carriedCards(board, new Set([10, 11]), 20), [20]);
  assert.deepEqual(carriedCards(board, new Set(), 12), [12]);
});

test("a drop onto the group lands above the next card that is not carried", () => {
  assert.equal(groupAnchor(board, 1, 12, [10, 11]), 12, "anchor outside the group is kept");
  assert.equal(groupAnchor(board, 1, null, [10, 11]), null);
  assert.equal(groupAnchor(board, 1, 10, [10, 11]), 12);
  assert.equal(groupAnchor(board, 1, 11, [11, 12]), null, "nothing after it: the foot");
});
