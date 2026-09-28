import { test } from "node:test";
import assert from "node:assert/strict";
import { boardRoutes } from "./board.ts";

type Doc = { columns: { id: number; key: string; cards: { id: number; title: string; doneAt: string | null }[] }[] };
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const titles = (doc: Doc, key: string) => doc.columns.find(c => c.key === key)!.cards.map(c => c.title).filter(t => t.startsWith("MM "));

test("a group move lands every card as one block, in the order sent, above the anchor", async () => {
  let doc: Doc | undefined;
  for (const title of ["MM a", "MM b", "MM c", "MM d"]) doc = await (await boardRoutes.request("/cards", json({ title }))).json() as Doc;
  for (const title of ["MM x", "MM y"]) doc = await (await boardRoutes.request("/cards", json({ title, column: "done" }))).json() as Doc;
  const id = (t: string) => doc!.columns.flatMap(c => c.cards).find(c => c.title === t)!.id;

  // Carry d and b (in that order) into Done, above y.
  const moved = await boardRoutes.request("/cards/move-many", json({ ids: [id("MM d"), id("MM b")], columnId: "done", before: id("MM y") }));
  assert.equal(moved.status, 200);
  const after = await moved.json() as Doc;
  assert.deepEqual(titles(after, "backlog"), ["MM a", "MM c"]);
  assert.deepEqual(titles(after, "done"), ["MM x", "MM d", "MM b", "MM y"]);
  assert.ok(after.columns.find(c => c.key === "done")!.cards.filter(c => c.title === "MM d" || c.title === "MM b").every(c => c.doneAt));

  // Back to the foot of Backlog: Done's stamp is cleared.
  const back = await (await boardRoutes.request("/cards/move-many", json({ ids: [id("MM b"), id("MM d")], columnId: "backlog", before: null }))).json() as Doc;
  assert.deepEqual(titles(back, "backlog"), ["MM a", "MM c", "MM b", "MM d"]);
  assert.ok(back.columns.find(c => c.key === "backlog")!.cards.filter(c => c.title.startsWith("MM ")).every(c => c.doneAt === null));

  // Refusals: an anchor inside the group, a duplicate, an unknown card, an anchor in another column.
  assert.equal((await boardRoutes.request("/cards/move-many", json({ ids: [id("MM a"), id("MM c")], columnId: "backlog", before: id("MM c") }))).status, 400);
  assert.equal((await boardRoutes.request("/cards/move-many", json({ ids: [id("MM a"), id("MM a")], columnId: "done" }))).status, 400);
  assert.equal((await boardRoutes.request("/cards/move-many", json({ ids: [999999], columnId: "done" }))).status, 404);
  assert.equal((await boardRoutes.request("/cards/move-many", json({ ids: [id("MM a")], columnId: "done", before: id("MM c") }))).status, 409);
  assert.equal((await boardRoutes.request("/cards/move-many", json({ ids: [], columnId: "done" }))).status, 400);
});
