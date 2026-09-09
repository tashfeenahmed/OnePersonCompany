import { test } from "node:test";
import assert from "node:assert/strict";
import { orderNav } from "../../../shared/sidebarNav.ts";
import { isWorkspacePreferences } from "../../../shared/workspace.ts";

const defaults = ["/board", "/ventures", "/calendar", "/mail"];

test("no saved order is the build's order", () => {
  assert.deepEqual(orderNav(defaults), defaults);
  assert.deepEqual(orderNav(defaults, []), defaults);
});

test("the owner's order leads; unplaced and new pages follow in the build's order", () => {
  assert.deepEqual(orderNav(defaults, ["/mail", "/calendar"]), ["/mail", "/calendar", "/board", "/ventures"]);
});

test("paths that no longer exist and repeats are dropped at read time", () => {
  assert.deepEqual(orderNav(defaults, ["/apps", "/calendar", "/calendar", "/gone"]), ["/calendar", "/board", "/ventures", "/mail"]);
});

test("navOrder is validated as a unique list of paths", () => {
  const base = { workspace: { name: "w", owner: "o" }, sessions: [], dashboards: [] };
  assert.equal(isWorkspacePreferences(base), true);
  assert.equal(isWorkspacePreferences({ ...base, navOrder: ["/board", "/mail"] }), true);
  assert.equal(isWorkspacePreferences({ ...base, navOrder: ["/board", "/board"] }), false);
  assert.equal(isWorkspacePreferences({ ...base, navOrder: ["board"] }), false);
  assert.equal(isWorkspacePreferences({ ...base, navOrder: "/board" }), false);
});
