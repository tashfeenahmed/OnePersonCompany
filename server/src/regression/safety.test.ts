import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { db, now, setConfig, upsertPlugin } from "../db.ts";
import * as accounts from "../accounts.ts";
import * as owner from "../integrations/security/owner.ts";
import { ownerGate } from "../integrations/security/gate.ts";
import { securityRoutes } from "../integrations/security/security-routes.ts";
import { outboxRoutes } from "../integrations/mailflow/outbox-routes.ts";
import { approveDraft, approvalKey, recoverInterruptedSends, row, sendApproved } from "../integrations/mailflow/outbox.ts";
import { serviceHeaders } from "../auth.ts";
upsertPlugin("gmail", true, null); upsertPlugin("outbox", true, null);
const account = accounts.create("gmail", "Test Gmail");
accounts.writeCredentials(account, "gmail", ["client-id", "client-secret", "refresh-token"], { "client-id": "test", "client-secret": "test", "refresh-token": "test" });
db.prepare("INSERT INTO gmail_mailboxes (account_id,account_label,address,seen_at) VALUES (?,?,?,?)").run(account.id, account.label, "owner@example.test", now());
const app = new Hono(); app.use("/api/*", ownerGate); app.route("/api/outbox", outboxRoutes); app.route("/api/security", securityRoutes); app.get("/api/private", c => c.json({ ok: true }));
owner.setPassword("test-owner-password");
const session = owner.createSession("test browser"), cookie = `opc_session=${session.token}`;
let number = 0;
function draft() {
  return Number(db.prepare("INSERT INTO mailflow_outbox (account_id,to_address,subject,body,status,created_by,created_at) VALUES (?,?,?,?,'draft','agent',?)")
    .run(account.id, `recipient${++number}@example.test`, "Reviewed subject", "Reviewed body", now()).lastInsertRowid);
}
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
test("service key cannot approve email, regardless of the skills header", async () => {
  const id = draft();
  for (const headers of [serviceHeaders(), { ...serviceHeaders(), "x-opc-via": "skills" }]) {
    const response = await post(`/api/outbox/${id}/approve`, { approvalKey: approvalKey(row(id)!) }, headers);
    assert.equal(response.status, 403); assert.equal(row(id)!.status, "draft");
  }
});
test("service credentials cannot mint owner sessions or change the owner password", async () => {
  const headers = serviceHeaders();
  assert.equal((await post("/api/security/login", { password: "test-owner-password" }, headers)).status, 403);
  assert.equal((await post("/api/security/password", { current: "test-owner-password", password: "replacement-password" }, headers)).status, 403);
  assert.ok(owner.verifyPassword("test-owner-password"));
  assert.equal((await app.request(`/api/security/sessions/${session.id}`, { method: "DELETE", headers })).status, 403);
  assert.ok(owner.liveSession(session.token));
});
test("owner can approve only the exact preview they reviewed", async () => {
  const id = draft(), key = approvalKey(row(id)!);
  db.prepare("UPDATE mailflow_outbox SET body='changed' WHERE id=?").run(id);
  assert.equal((await post(`/api/outbox/${id}/approve`, { approvalKey: key }, { cookie })).status, 409);
  assert.equal((await post(`/api/outbox/${id}/approve`, { approvalKey: approvalKey(row(id)!) }, { cookie })).status, 200);
});
test("session IDs exposed by the API are not usable login tokens; sessions expire", async () => {
  const status = await (await app.request("/api/security/status", { headers: serviceHeaders() })).json();
  assert.ok(!JSON.stringify(status).includes(session.token));
  assert.equal(owner.liveSession(session.id), undefined);
  assert.ok(owner.liveSession(session.token));
  const old = owner.createSession("old");
  db.prepare("UPDATE security_sessions SET created_at='2020-01-01T00:00:00Z' WHERE id=?").run(old.id);
  assert.equal(owner.liveSession(old.token), undefined);
  const idle = owner.createSession("idle");
  db.prepare("UPDATE security_sessions SET last_seen_at='2020-01-01T00:00:00Z' WHERE id=?").run(idle.id);
  assert.equal(owner.liveSession(idle.token), undefined);
});
test("outbox defaults to a useful page and supports stable offsets", async () => {
  draft(); draft(); draft();
  const all = await (await app.request("/api/outbox", { headers: { cookie } })).json() as {items: {id: number}[]; pagination: {limit: number}};
  assert.ok(all.items.length >= 3); assert.equal(all.pagination.limit, 100);
  const next = await (await app.request("/api/outbox?limit=1&offset=1", { headers: { cookie } })).json() as {items: {id: number}[]};
  assert.equal(next.items[0]!.id, all.items[1]!.id);
});
test("concurrent sends contact Gmail once and preserve the approved text", async () => {
  setConfig("outbox", "gap-days", "0"); setConfig("outbox", "daily-cap", "20");
  const id = draft(); approveDraft(id); let sends = 0, wire = "";
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("oauth2.googleapis.com")) return Response.json({ access_token: "test", scope: "https://www.googleapis.com/auth/gmail.modify" });
    if (String(input).endsWith("/messages/send")) { sends++; wire = Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString(); await new Promise(r => setTimeout(r, 10)); return Response.json({ id: "sent-test", threadId: "thread-test" }); }
    throw new Error("Unexpected external request in test");
  };
  try {
    const results = await Promise.allSettled([sendApproved(id), sendApproved(id)]);
    assert.equal(sends, 1); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.match(wire, /Reviewed subject/); assert.equal(Buffer.from(wire.split("\r\n\r\n")[1]!, "base64").toString(), "Reviewed body"); assert.equal(row(id)!.status, "sent");
  } finally { globalThis.fetch = original; }
});
test("daily cap zero prevents delivery before any external request", async () => {
  setConfig("outbox", "daily-cap", "0"); const id = draft(); approveDraft(id);
  await assert.rejects(sendApproved(id), /allowance/); assert.equal(row(id)!.status, "approved");
});
test("interrupted sends become uncertain and cannot be edited or retried blindly", async () => {
  const id = draft(); db.prepare("UPDATE mailflow_outbox SET status='sending' WHERE id=?").run(id); recoverInterruptedSends();
  assert.equal(row(id)!.status, "uncertain"); await assert.rejects(sendApproved(id), /approved/);
  const response = await app.request(`/api/outbox/${id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "edit" }) });
  assert.equal(response.status, 409);
});
test("authentication storage failure never exposes protected routes", async () => {
  db.exec("ALTER TABLE security_owner RENAME TO security_owner_unavailable");
  try { assert.equal((await app.request("/api/private")).status, 503); }
  finally { db.exec("ALTER TABLE security_owner_unavailable RENAME TO security_owner"); }
});
