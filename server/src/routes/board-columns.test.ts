import { test } from "node:test";
import assert from "node:assert/strict";
import { boardRoutes } from "./board.ts";
import { db } from "../db.ts";

test("custom columns can be created, reordered and removed without losing live or archived cards", async () => {
  const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const created = await boardRoutes.request("/columns", json({ title: "Review" }));
  assert.equal(created.status, 201);
  const doc = await created.json() as { columns: { id: number; title: string; key: string; structural: boolean }[] };
  const review = doc.columns.find(c => c.title === "Review")!, backlog = doc.columns.find(c => c.key === "backlog")!;
  await boardRoutes.request("/cards", json({ title: "Keep live", column: review.id }));
  await boardRoutes.request("/cards", json({ title: "Keep archived", column: review.id }));
  db.prepare("UPDATE board_cards SET archived_at = ? WHERE title = 'Keep archived'").run(new Date().toISOString());
  assert.equal((await boardRoutes.request(`/columns/${review.id}/move`, json({ before: backlog.id }))).status, 200);
  assert.equal((await boardRoutes.request(`/columns/${review.id}`, { method: "DELETE" })).status, 200);
  const cards = db.prepare("SELECT title, column_id, archived_at FROM board_cards WHERE title LIKE 'Keep %'").all() as { title: string; column_id: number; archived_at: string | null }[];
  assert.equal(cards.length, 2); assert.ok(cards.every(c => c.column_id === backlog.id));
  assert.ok(cards.find(c => c.title === "Keep archived")?.archived_at);
  assert.equal((await boardRoutes.request(`/columns/${backlog.id}`, { method: "DELETE" })).status, 400);
  assert.equal((await boardRoutes.request("/columns", json({ title: " " }))).status, 400);
});
