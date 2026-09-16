import { test } from "node:test";
import assert from "node:assert/strict";
import { completedBoardMove, isCompletionColumn } from "./boardCompletion.ts";

const column = (id: number, title: string, ids: number[] = [], key = `custom-${id}`) => ({
  id, key, title, cards: ids.map(id => ({ id })),
});

test("recognizes completion titles and a renamed structural Done lane", () => {
  for (const title of ["Done", " COMPLETE ", "Completed", "✅ Completed!", "Finished", "Shipped", "Resolved", "Closed", "Delivered", "Published"]) {
    assert.equal(isCompletionColumn(column(1, title)), true, title);
  }
  assert.equal(isCompletionColumn(column(1, "Released to customers", [], "done")), true);
  for (const title of ["Not done", "Incomplete", "Done later", "To be completed", "Closed beta testing", "Doing", ""]) {
    assert.equal(isCompletionColumn(column(1, title)), false, title);
  }
});

test("celebrates only an existing card crossing from open to completed", () => {
  const before = { columns: [column(1, "Doing", [7]), column(2, "Completed")] };
  const after = { columns: [column(1, "Doing"), column(2, "Completed", [7])] };
  assert.equal(completedBoardMove(before, after, 7), true);
  assert.equal(completedBoardMove(after, before, 7), false, "Reopening isn't completion");
  assert.equal(completedBoardMove(before, before, 7), false, "Unchanged server reply");
  assert.equal(completedBoardMove(before, after, 99), false, "Missing card");
  assert.equal(completedBoardMove({ columns: [] }, after, 7), false, "Initial load or new card");
});

test("renaming, reordering and moving between completed columns do not replay", () => {
  const before = { columns: [column(1, "Doing", [7])] };
  assert.equal(completedBoardMove(before, { columns: [column(1, "Completed", [7])] }, 7), false);
  const done = { columns: [column(1, "Done", [7, 8]), column(2, "Shipped")] };
  assert.equal(completedBoardMove(done, { columns: [column(1, "Done", [8, 7]), column(2, "Shipped")] }, 7), false);
  assert.equal(completedBoardMove(done, { columns: [column(1, "Done", [8]), column(2, "Shipped", [7])] }, 7), false);
});
