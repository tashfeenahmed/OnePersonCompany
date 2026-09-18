import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, now } from "../../db.ts";
import { cardsOf, fileRunCards, runCardOrigin, runCardsFiled } from "./cards.ts";
import { kindDef } from "./kinds.ts";

const fence = (cards: unknown) => `## Findings\n\nSomething.\n\n\`\`\`json cards\n${JSON.stringify(cards)}\n\`\`\`\n`;

function run(id: string, status: string, output: string, ventureId: string | null = "v-cards") {
  db.prepare(
    "INSERT INTO agent_runs(id,kind,venture_id,title,input,status,queued_at,started_at,finished_at,output,output_chars) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, "seo", ventureId, "SEO review — Cards", "{}", status, now(), now(), now(), output, output.length);
}

beforeEach(() => {
  db.exec("DELETE FROM agent_runs; DELETE FROM board_cards WHERE origin LIKE 'run:%'; DELETE FROM board_automation_filings WHERE origin LIKE 'run:%'; DELETE FROM ventures WHERE id='v-cards';");
  db.prepare("INSERT INTO ventures(id,slug,name,stage,color,color_source,created_at,updated_at,position,brand) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("v-cards", "cards", "Cards", "launched", "#334455", "owner", now(), now(), 0, "{}");
});

test("a finished run's cards land in Backlog once, under the venture, with the run named", () => {
  run("r-cards1", "done", fence([
    { title: "Rewrite the pricing page", body: "It ranks 14th.", urgency: 2 },
    { title: "Add FAQ schema", urgency: 9 },
  ]));
  assert.deepEqual(fileRunCards("r-cards1"), { filed: 2, total: 2 });
  const rows = db.prepare(
    "SELECT c.title, c.body, c.urgency, c.venture_id, c.origin, k.key AS col FROM board_cards c JOIN board_columns k ON k.id=c.column_id WHERE c.origin LIKE 'run:r-cards1:%' ORDER BY c.origin",
  ).all() as { title: string; body: string; urgency: number; venture_id: string; origin: string; col: string }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.col, "backlog");
  assert.equal(rows[0]!.venture_id, "v-cards");
  assert.equal(rows[0]!.origin, runCardOrigin("r-cards1", 0));
  assert.equal(rows[0]!.body, `It ranks 14th.\n\nFrom the ${kindDef("seo")!.name} run r-cards1.`);
  /* An urgency outside 0–3 is the client's default, not a refusal. */
  assert.equal(rows[1]!.urgency, 1);
  assert.equal(runCardsFiled("r-cards1"), 2);

  /* A second pass writes nothing — the origin is the receipt. */
  assert.deepEqual(fileRunCards("r-cards1"), { filed: 0, total: 2 });
  assert.equal(runCardsFiled("r-cards1"), 2);
});

test("a card the owner deleted stays deleted, and a run that is not done files nothing", () => {
  run("r-cards2", "done", fence([{ title: "One", urgency: 1 }, { title: "Two", urgency: 1 }]));
  fileRunCards("r-cards2");
  db.prepare("DELETE FROM board_cards WHERE origin = ?").run(runCardOrigin("r-cards2", 0));
  /* The board keeps its filings receipt, so the row is not re-made. */
  db.prepare("INSERT OR IGNORE INTO board_automation_filings(origin,card_id,source,filed_at) VALUES(?,?,?,?)")
    .run(runCardOrigin("r-cards2", 0), null, "run", now());
  assert.deepEqual(fileRunCards("r-cards2"), { filed: 0, total: 2 });
  assert.equal(runCardsFiled("r-cards2"), 1);

  run("r-cards3", "failed", fence([{ title: "Never", urgency: 1 }]));
  assert.deepEqual(fileRunCards("r-cards3"), { filed: 0, total: 0 });
  assert.equal(runCardsFiled("r-cards3"), 0);
});

test("cardsOf tolerates the labels models actually write and refuses what the page would not draw", () => {
  assert.equal(cardsOf("no fence here").length, 0);
  assert.equal(cardsOf("```json\n{\"cards\":[{\"title\":\"Wrapped\"}]}\n```").length, 1);
  assert.equal(cardsOf("```cards\n[{\"title\":\"  \"},{\"body\":\"no title\"},{\"title\":\"Kept\"}]\n```").length, 1);
  const many = Array.from({ length: 12 }, (_, i) => ({ title: `Card ${i}` }));
  assert.equal(cardsOf(fence(many)).length, 8);
});
