import test from "node:test";
import assert from "node:assert/strict";
import { db, now } from "../db.ts";
import { actionInboxRoutes, inboxItems } from "../routes/actionInbox.ts";
import { runRoutes } from "../integrations/runs/routes.ts";
import { insertRun } from "../integrations/runs/store.ts";
import { setQueuePaused } from "../runtime/budgets.ts";
setQueuePaused(true);
insertRun({ id: "failed-job", kind: "geo", ventureId: null, title: "Test failure", input: { prompt: "saved input" } });
db.prepare("UPDATE agent_runs SET status='failed',finished_at=?,error='test failure' WHERE id='failed-job'").run(now());
db.prepare("INSERT INTO people_commitments (id,mailbox,thread_id,message_id,what,sentence,found_at) VALUES ('promise','test','thread','message','Send proposal','I will send a proposal',?)").run(now());
const post = (path: string) => actionInboxRoutes.request(path, { method: "POST", body: "{}" });
test("action inbox resolves the authoritative commitment record", async () => {
  assert.ok(inboxItems().some(i => i.id === "commitment:promise"));
  assert.equal((await post("/commitment%3Apromise/resolve")).status, 200);
  assert.equal((db.prepare("SELECT status FROM people_commitments WHERE id='promise'").get() as {status: string}).status, "done");
  assert.ok(!inboxItems().some(i => i.id === "commitment:promise"));
});
test("board handoff is idempotent and includes the correct source link", async () => {
  await post("/run%3Afailed-job/board"); await post("/run%3Afailed-job/board");
  const rows = db.prepare("SELECT body FROM board_cards WHERE origin='inbox:run:failed-job'").all() as {body: string}[];
  assert.equal(rows.length, 1); assert.match(rows[0]!.body, /\/outputs\/visibility\/failed-job/);
});
test("snoozed items stay out of the action inbox until their due time", async () => {
  assert.equal((await post("/run%3Afailed-job/snooze")).status, 200);
  assert.ok(!inboxItems().some(i => i.id === "run:failed-job"));
});
test("retry preserves the original report and copies the saved inputs", async () => {
  const response = await runRoutes.request("/failed-job/retry", { method: "POST" });
  assert.equal(response.status, 201);
  const next = await response.json() as {id: string; status: string}; assert.notEqual(next.id, "failed-job"); assert.equal(next.status, "queued");
  const rows = db.prepare("SELECT id,input,status FROM agent_runs").all() as {id: string; input: string; status: string}[];
  assert.equal(rows.find(r => r.id === "failed-job")!.status, "failed");
  assert.equal(rows.find(r => r.id === next.id)!.input, JSON.stringify({ prompt: "saved input" }));
});
test("unauthed code cannot loosen owner budget controls", async () => {
  const response = await runRoutes.request("/controls", { method: "PUT", body: JSON.stringify({ budgets: {} }) });
  assert.equal(response.status, 403);
});
