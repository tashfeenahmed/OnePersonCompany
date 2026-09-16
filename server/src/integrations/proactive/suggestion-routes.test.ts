import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { db, now } from "../../db.ts";
import { suggestionRoutes } from "./suggestion-routes.ts";
import type { HomeSuggestions } from "../../../../shared/homeSuggestions.ts";

beforeEach(() => {
  db.exec("DELETE FROM agent_runs; DELETE FROM board_cards; DELETE FROM activity_events; DELETE FROM work_journal; DELETE FROM subagents; DELETE FROM ventures;");
  db.prepare(`INSERT INTO ventures(id,slug,name,stage,color,color_source,created_at,updated_at,position)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("v-home", "cedar", "Cedar", "launched", "#334455", "owner", now(), now(), 0);
});

async function read(query = "") {
  const response = await suggestionRoutes.request(`/suggestions${query}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return await response.json() as HomeSuggestions;
}

test("home reads only local records, validates scope/timezone, and excludes completed or archived board work", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Home must not contact remote services"); });
  const col = db.prepare("SELECT id FROM board_columns WHERE key = 'backlog'").get() as { id: number };
  const insert = db.prepare(`INSERT INTO board_cards(id,column_id,position,title,urgency,venture_id,created_at,updated_at,done_at,archived_at)
    VALUES(?,?,0,?,3,'v-home',?,?,?,?)`);
  insert.run(1, col.id, "Open work", now(), now(), null, null);
  insert.run(2, col.id, "Already done", now(), now(), now(), null);
  insert.run(3, col.id, "Archived", now(), now(), null, now());
  const doc = await read("?venture=v-home&timezone=Pacific/Auckland");
  assert.equal(doc.suggestions.length, 6);
  assert.ok(doc.suggestions.some(s => s.id === "board:1"));
  assert.ok(!doc.suggestions.some(s => ["board:2", "board:3"].includes(s.id)));
  db.prepare("UPDATE board_cards SET done_at = ? WHERE id = 1").run(now());
  assert.ok(!(await read()).suggestions.some(s => s.id === "board:1"));
  assert.equal((await suggestionRoutes.request("/suggestions?venture=missing")).status, 404);
  assert.equal((await suggestionRoutes.request("/suggestions?timezone=bad-zone")).status, 400);
});

test("latest run replaces old failure and exact report routing is preserved", async () => {
  const insert = db.prepare(`INSERT INTO agent_runs(id,kind,venture_id,title,status,queued_at,finished_at)
    VALUES(?,'seo','v-home',?,?,?,?)`);
  insert.run("r-old", "Old failed report", "failed", "2026-01-01T00:00:00Z", now());
  insert.run("r-new", "Latest review", "done", now(), now());
  const doc = await read();
  assert.ok(!doc.suggestions.some(s => s.id === "report:r-old"));
  const report = doc.suggestions.find(s => s.id === "report:r-new");
  assert.equal(report?.source.href, "/ventures/cedar/team/seo/runs/r-new");
  db.prepare("UPDATE agent_runs SET status = 'running', finished_at = NULL WHERE id = 'r-new'").run();
  assert.ok(!(await read()).suggestions.some(s => s.kind === "report"));
});

test("dismissed and stale activity cannot become new work, and disabled agents are not offered", async () => {
  const at = now();
  db.prepare(`INSERT INTO subagents(id,venture_id,role,name,title,instructions,enabled,created_at,updated_at)
    VALUES('sa-disabled','v-home','seo','Disabled worker','SEO','',0,?,?)`).run(at, at);
  db.prepare("INSERT INTO activity_events(key,ts,exact,kind,venture_id,title,source,found_at) VALUES('signup',?,1,'signup','v-home','New user','users',?)").run(at, at);
  db.prepare("INSERT INTO activity_events(key,ts,exact,kind,venture_id,title,source,found_at) VALUES('old','2020-01-01',1,'push','v-home','Old work','github',?)").run(at);
  db.prepare("INSERT INTO work_journal(day,kind,text,venture_id,created_at,updated_at) VALUES(?,'dismissed','Not doing this','v-home',?,?)").run(at.slice(0, 10), at, at);
  const doc = await read();
  assert.ok(doc.suggestions.some(s => s.id === "activity:v-home:signup"));
  assert.ok(!doc.suggestions.some(s => s.id === "activity:v-home:push" || s.kind === "journal"));
  assert.ok(doc.suggestions.every(s => !s.prompt.includes("sa-disabled")));
});
