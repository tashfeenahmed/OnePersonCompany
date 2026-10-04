import { test } from "node:test";
import assert from "node:assert/strict";
import { db, demandOrderedTerms, demandQueries, demandQueryOwed, writeDemandQuery } from "../db.ts";

const row = (term: string, status: string, items: number | null = null) => ({
  source: "reddit",
  term,
  status,
  tier: status === "ok" ? "feed+token" : null,
  items,
  error: status === "skipped" ? "not asked — budget" : null,
});
const get = (term: string) => demandQueries("reddit").find((q) => q.term === term)!;

test("a deferral keeps the phrase's last real answer and only stamps deferred_at", () => {
  db.exec("DELETE FROM demand_queries");
  writeDemandQuery(row("long video to shorts", "ok", 7));
  const answered = get("long video to shorts");
  writeDemandQuery(row("long video to shorts", "skipped"));
  const after = get("long video to shorts");
  assert.equal(after.status, "ok");
  assert.equal(after.items, 7);
  assert.equal(after.tier, "feed+token");
  assert.equal(after.asked_at, answered.asked_at);
  assert.ok(after.deferred_at);
  assert.equal(demandQueryOwed(after), true);
});

test("a phrase never answered is still written as skipped", () => {
  db.exec("DELETE FROM demand_queries");
  writeDemandQuery(row("fidget app", "skipped"));
  const q = get("fidget app");
  assert.equal(q.status, "skipped");
  assert.ok(q.deferred_at);
  assert.equal(demandQueryOwed(q), true);
});

test("a real answer clears the deferral", () => {
  db.exec("DELETE FROM demand_queries");
  writeDemandQuery(row("ai group call", "ok", 2));
  writeDemandQuery(row("ai group call", "skipped"));
  writeDemandQuery(row("ai group call", "ok", 3));
  const q = get("ai group call");
  assert.equal(q.items, 3);
  assert.equal(q.deferred_at, null);
  assert.equal(demandQueryOwed(q), false);
});

test("deferred phrases go first in line, ahead of fresher answers", () => {
  db.exec("DELETE FROM demand_queries");
  writeDemandQuery(row("a", "ok", 1));
  writeDemandQuery(row("b", "ok", 1));
  writeDemandQuery(row("b", "skipped"));
  writeDemandQuery(row("c", "ok", 1));
  assert.deepEqual(demandOrderedTerms("reddit", ["a", "c", "b", "d"]), ["b", "d", "a", "c"]);
});
