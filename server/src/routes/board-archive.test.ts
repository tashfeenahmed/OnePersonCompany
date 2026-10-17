import { test } from "node:test";
import assert from "node:assert/strict";
import { boardRoutes } from "./board.ts";

type Doc = { columns: { key: string; cards: { id: number; title: string }[] }[]; totals: { archived: number } };
type ArchiveDoc = { cards: { id: number; title: string; archivedAt: string | null }[] };
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const live = (doc: Doc, title: string) => doc.columns.some((c) => c.cards.some((card) => card.title === title));

test("the archive is readable and a card comes back to the column it left from", async () => {
  const made = await (await boardRoutes.request("/cards", json({ title: "ARC one" }))).json() as Doc;
  const id = made.columns.flatMap((c) => c.cards).find((c) => c.title === "ARC one")!.id;

  // Moving it into Done, then archiving, must restore it to Done — archive is
  // "out of the way", and the card keeps its column while it is out.
  await boardRoutes.request(`/cards/${id}/move`, json({ columnId: "done", before: null }));
  const gone = await (await boardRoutes.request(`/cards/${id}/archive`, { method: "POST" })).json() as Doc;
  assert.ok(!live(gone, "ARC one"));
  assert.equal(gone.totals.archived, 1);

  // The read that did not exist before this route: what did I archive?
  const list = await (await boardRoutes.request("/archive")).json() as ArchiveDoc;
  const row = list.cards.find((c) => c.id === id);
  assert.ok(row, "the archived card appears in the archive list");
  assert.ok(row!.archivedAt, "each row carries when it was archived");

  // Back onto the board, in the column it left from.
  const back = await (await boardRoutes.request(`/cards/${id}/unarchive`, { method: "POST" })).json() as Doc;
  assert.ok(live(back, "ARC one"));
  assert.ok(back.columns.find((c) => c.key === "done")!.cards.some((c) => c.title === "ARC one"));
  assert.equal(back.totals.archived, 0);

  // Unarchiving a live card is the board, unchanged; an unknown id is a 404.
  assert.equal((await boardRoutes.request(`/cards/${id}/unarchive`, { method: "POST" })).status, 200);
  assert.equal((await boardRoutes.request("/cards/999999/unarchive", { method: "POST" })).status, 404);
});
