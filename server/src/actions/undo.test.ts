import test from "node:test";
import assert from "node:assert/strict";
import { db, now } from "../db.ts";
import { actionInboxRoutes } from "../routes/actionInbox.ts";
import { alertRoutes } from "../integrations/proactive/alerts-routes.ts";
import { insertRule, insertEvent, event, openEvents } from "../integrations/proactive/store.ts";
import { undoable, undoAction, UndoError } from "./undo.ts";
const post = (id: string, action: string) => actionInboxRoutes.request(`/${encodeURIComponent(id)}/${action}`, { method: "POST" });
const incident = () => {
  const rule = insertRule({ name: "Test disk", skill: "fleet", view: "default", params: {}, path: "disk", op: ">", threshold: 85, windowMinutes: null, enabled: true, ventureId: null, cooldownMinutes: 0 });
  return insertEvent({ ruleId: rule.id, kind: "trip", observed: 95, previous: 80, message: "Test server disk at 95%" });
};
test("acknowledgement writes immediately; Undo restores it without losing recovery history", async () => {
  const e = incident();
  const response = await alertRoutes.request(`/events/${e.id}/ack`, { method: "POST" });
  assert.equal(response.status, 200);
  const { undo } = await response.json() as { undo: { token: string } };
  assert.ok(event(e.id)?.acknowledged_at);
  const recovered = now();
  db.prepare("UPDATE alert_events SET cleared_at = ? WHERE id = ?").run(recovered, e.id);
  undoAction(undo.token);
  assert.equal(event(e.id)?.acknowledged_at, null);
  assert.equal(event(e.id)?.cleared_at, recovered);
  assert.ok(!openEvents().some(row => row.id === e.id));
  undoAction(undo.token); // A retry after a lost response is idempotent.
});
test("inbox resolves and restores commitments using the source disposition fields", async () => {
  const id = "undo-commitment";
  db.prepare("INSERT INTO people_commitments(id,mailbox,thread_id,message_id,what,sentence,found_at) VALUES(?,?,?,?,?,?,?)").run(id,"test","thread","message","Review draft","I will review the draft",now());
  const res = await post(`commitment:${id}`, "resolve"); assert.equal(res.status, 200);
  assert.equal(db.prepare("SELECT status FROM people_commitments WHERE id=?").get(id)?.status,"done");
  const { undo } = await res.json() as { undo: { token: string } };
  undoAction(undo.token);
  assert.equal(db.prepare("SELECT status FROM people_commitments WHERE id=?").get(id)?.status,"open");
});
test("email IDs containing colons resolve and snooze the exact thread; Undo retains content", async () => {
  db.prepare("INSERT INTO mailflow_triage(account_id,thread_id,score,reason,scored_at) VALUES(?,?,?,?,?)").run(991,"thread:part:2","needs_reply","A reply is needed",now());
  for (const action of ["resolve", "snooze"]) {
    const res = await post("triage:991:thread:part:2", action); assert.equal(res.status,200);
    const { undo } = await res.json() as { undo: { token: string } };
    const row = db.prepare("SELECT * FROM mailflow_triage WHERE account_id=991 AND thread_id='thread:part:2'").get()!;
    assert.ok(row[action === "resolve" ? "done_at" : "snoozed_until"]);
    undoAction(undo.token);
    const restored = db.prepare("SELECT * FROM mailflow_triage WHERE account_id=991 AND thread_id='thread:part:2'").get()!;
    assert.equal(restored.done_at,null); assert.equal(restored.snoozed_until,null); assert.equal(restored.reason,"A reply is needed");
  }
});
test("inbox fallback snooze restores a missing row, and receipts expire", async () => {
  const e = incident();
  const res = await post(`alert:${e.id}`, "snooze"); assert.equal(res.status,200);
  const { undo } = await res.json() as { undo: { token: string } };
  assert.ok(db.prepare("SELECT * FROM action_inbox_state WHERE id=?").get(`alert:${e.id}`));
  undoAction(undo.token);
  assert.equal(db.prepare("SELECT * FROM action_inbox_state WHERE id=?").get(`alert:${e.id}`), undefined);
  const expired = await post(`alert:${e.id}`, "snooze");
  const next = await expired.json() as { undo: { token: string } };
  db.prepare("UPDATE action_undo SET expires_at=0 WHERE token=?").run(next.undo.token);
  const expiredResponse = await post("undo", next.undo.token);
  assert.equal(expiredResponse.status,410);
  assert.ok(db.prepare("SELECT * FROM action_inbox_state WHERE id=?").get(`alert:${e.id}`));
});
test("Undo refuses to overwrite a newer disposition, and never grants arbitrary row writes", () => {
  const e = incident();
  db.exec("BEGIN IMMEDIATE");
  const { undo } = undoable("alert", [e.id], () => db.prepare("UPDATE alert_events SET acknowledged_at=? WHERE id=?").run("first",e.id));
  db.exec("COMMIT");
  db.prepare("UPDATE alert_events SET acknowledged_at=? WHERE id=?").run("newer",e.id);
  assert.throws(() => undoAction(undo!.token), (error: unknown) => error instanceof UndoError && error.status === 409);
  assert.equal(event(e.id)?.acknowledged_at,"newer");
  assert.throws(() => undoAction("not-a-receipt"), (error: unknown) => error instanceof UndoError && error.status === 404);
});
