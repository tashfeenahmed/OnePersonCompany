import test from "node:test";
import assert from "node:assert/strict";
import { workspaceRoutes } from "../routes/workspace.ts";
import { isWorkspacePreferences } from "../../../shared/workspace.ts";
import { runPage } from "../../../shared/runRoutes.ts";
const data = { workspace: { name: "Test", owner: "Owner", defaultVentureId: null }, sessions: [], dashboards: [{ id: "board", slug: "morning", name: "Morning", widgets: [{ id: "one", type: "stripe.mrr", w: 1 }] }] };
test("reject malformed workspace fields and duplicate IDs before persistence", async () => {
  for (const value of [{ ...data, workspace: { name: "x" } }, { ...data, sessions: [null] }, { ...data, dashboards: [data.dashboards[0], data.dashboards[0]] }, { ...data, dashboards: [{ ...data.dashboards[0], widgets: [{ id: "x", type: "x", w: 3 }] }] }]) {
    assert.equal(isWorkspacePreferences(value), false);
    const response = await workspaceRoutes.request("/", { method: "PUT", body: JSON.stringify({ revision: 0, data: value }) });
    assert.equal(response.status, 400);
  }
});
test("workspace synchronization rejects stale writes without losing saved settings", async () => {
  const put = (revision: number, owner: string) => workspaceRoutes.request("/", { method: "PUT", body: JSON.stringify({ revision, data: { ...data, workspace: { ...data.workspace, owner } } }) });
  assert.equal((await put(0, "first")).status, 200);
  assert.equal((await put(0, "stale")).status, 409);
  assert.equal((await (await workspaceRoutes.request("/")).json() as {data: typeof data}).data.workspace.owner, "first");
  assert.equal((await put(1, "second")).status, 200);
  const pinnedItems = [{ type: "page", path: "/board" }, { type: "session", sessionId: "chat / ü" }, { type: "page", path: "/mail/email" }];
  const withPins = { ...data, sessions: [{ id: "chat / ü", title: "Pinned session" }], pinnedItems };
  assert.equal((await workspaceRoutes.request("/", { method: "PUT", body: JSON.stringify({ revision: 2, data: withPins }) })).status, 200);
  const saved = await (await workspaceRoutes.request("/")).json() as { revision: number; data: typeof withPins };
  assert.deepEqual(saved.data.pinnedItems, pinnedItems);
  assert.equal((await workspaceRoutes.request("/", { method: "PUT", body: JSON.stringify({ revision: saved.revision, data: { ...withPins, pinnedItems: [pinnedItems[0], pinnedItems[0]] } }) })).status, 400);
  assert.deepEqual((await (await workspaceRoutes.request("/")).json() as typeof saved).data.pinnedItems, pinnedItems);
});
test("run completion links use actual page names", () => {
  assert.equal(runPage("geo", "r-1"), "/outputs/visibility/r-1");
  assert.equal(runPage("shotsqa", "r-2"), "/ops/r-2");
  assert.equal(runPage("video", "r-3"), "/social/video/r-3");
});
