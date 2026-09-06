import { test } from "node:test";
import assert from "node:assert/strict";
import { pinKey, reorderPins, sidebarPins, togglePin, type SidebarPin } from "../../../shared/sidebarPins.ts";
import { isWorkspacePreferences } from "../../../shared/workspace.ts";

const board: SidebarPin = { type: "page", path: "/board" };
const session: SidebarPin = { type: "session", sessionId: "chat / ü" };
const email: SidebarPin = { type: "page", path: "/mail/email" };

test("old favorites retain order and migrate aliases without duplicates or resurrecting cleared pins", () => {
  assert.deepEqual(sidebarPins({ favoritePaths: ["/apps", "/board", "/outputs"] }), [
    { type: "page", path: "/outputs" }, board,
  ]);
  assert.deepEqual(sidebarPins({ favoritePaths: ["/board"], pinnedItems: [] }), []);
  assert.deepEqual(togglePin({ favoritePaths: ["/board"] }, session), [board, session]);
});

test("pages and sessions share an order while their identities stay distinct", () => {
  const sameId: SidebarPin = { type: "session", sessionId: "/board" };
  const pinnedItems = togglePin({ pinnedItems: [board, session] }, sameId);
  assert.equal(pinnedItems.length, 3);
  assert.deepEqual(togglePin({ pinnedItems }, session), [board, sameId]);
  assert.deepEqual(reorderPins({ pinnedItems: [board, session, email] }, [pinKey(email), pinKey(session), pinKey(board)]), [email, session, board]);
});

test("reordering preserves concurrent additions and ignores deleted or duplicate keys", () => {
  assert.deepEqual(reorderPins({ pinnedItems: [session, email] }, [pinKey(board), pinKey(session), pinKey(session)]), [session, email]);
});

test("workspace import accepts mixed pins and rejects malformed, duplicate, or unsafe destinations", () => {
  const data = { workspace: { name: "Test", owner: "Owner" }, sessions: [{ id: session.sessionId, title: "Chat" }], dashboards: [] };
  assert.equal(isWorkspacePreferences(data), true);
  assert.equal(isWorkspacePreferences({ ...data, pinnedItems: [board, session, email] }), true);
  for (const pinnedItems of [null, [null], [board, board], [{ type: "session", sessionId: "" }], [{ type: "session", sessionId: 3 }], [{ type: "page", path: "https://example.com" }], [{ type: "page", path: "//example.com" }], [{ type: "unknown", path: "/board" }]]) {
    assert.equal(isWorkspacePreferences({ ...data, pinnedItems }), false);
  }
});
