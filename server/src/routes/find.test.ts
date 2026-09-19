import { test } from "node:test";
import assert from "node:assert/strict";
import { findRoutes, readableText, snippetAround, type FindHit } from "./find.ts";
import { db } from "../db.ts";

const find = async (q: string) =>
  ((await (await findRoutes.request(`/?q=${encodeURIComponent(q)}`)).json()) as { hits: FindHit[] }).hits;

test("find reads conversations, cards, reports and ventures, and every word must match", async () => {
  const now = new Date().toISOString();
  const say = db.prepare("INSERT INTO chat_messages (session_id, ts, role, content, channel) VALUES (?, ?, ?, ?, 'web')");
  say.run("find-a", now, "user", "What happened with the Zanzibar refund?");
  say.run("find-a", now, "assistant", "The zanzibar refund cleared on Tuesday.");
  say.run("find-b", now, "user", "Zanzibar flights only");
  const column = (db.prepare("SELECT id FROM board_columns ORDER BY position LIMIT 1").get() as { id: number }).id;
  const card = db.prepare("INSERT INTO board_cards (column_id, position, title, body, created_at, updated_at) VALUES (?, 999, ?, ?, ?, ?)");
  card.run(column, "Chase the zanzibar invoice", null, now, now);
  card.run(column, "Unrelated", "mentions 100%_zanzibar in the notes", now, now);
  db.prepare(`INSERT INTO agent_runs (id, kind, title, status, queued_at, output) VALUES
    ('find-r1', 'research', 'Market read', 'done', ?, '<html><style>.zanzibar{}</style><p>Nothing here</p></html>'),
    ('find-r2', 'research', 'Island read', 'done', ?, '<html><p>Demand in Zanzibar &amp; Pemba is rising</p></html>')`).run(now, now);

  const hits = await find("zanzibar");
  const chats = hits.filter(h => h.group === "chat");
  assert.deepEqual(chats.map(h => h.id).sort(), ["find-a", "find-b"]);
  assert.equal(chats.find(h => h.id === "find-a")?.matches, 2);
  assert.match(chats.find(h => h.id === "find-a")!.to, /^\/chat\/find-a\?m=\d+$/);
  assert.equal(chats.find(h => h.id === "find-a")?.title, "What happened with the Zanzibar refund?");

  const cards = hits.filter(h => h.group === "card");
  assert.equal(cards[0]?.title, "Chase the zanzibar invoice", "a title match comes first");
  assert.match(cards[0]!.to, /^\/board\?card=\d+$/);
  assert.equal(cards.length, 2);

  const reports = hits.filter(h => h.group === "report");
  assert.deepEqual(reports.map(h => h.id), ["find-r2"], "a match inside markup alone is not a match");
  assert.equal(reports[0]?.snippet, "Demand in Zanzibar & Pemba is rising");

  assert.deepEqual((await find("zanzibar refund")).filter(h => h.group === "chat").map(h => h.id), ["find-a"]);
  assert.equal((await find("100%_zan")).filter(h => h.group === "card").length, 1, "% and _ are literal");
  assert.equal((await find("%")).length, 0);
  assert.equal((await find(" ")).length, 0);
});

test("a snippet starts on a word and says when it was cut", () => {
  const text = `${"lorem ipsum ".repeat(20)}the needle is here ${"dolor sit ".repeat(30)}`;
  const snippet = snippetAround(text, ["needle"])!;
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"));
  assert.ok(snippet.includes("needle"));
  assert.ok(!/^…\S*m /.test(snippet) || snippet.startsWith("…lorem") || snippet.startsWith("…ipsum"));
  assert.equal(snippetAround("nothing", ["needle"]), null);
  assert.equal(readableText("plain < text"), "plain < text");
});
