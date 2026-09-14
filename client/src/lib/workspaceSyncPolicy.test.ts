import test from "node:test";
import assert from "node:assert/strict";
import { syncFailureNotice, workspaceFingerprint, workspaceHydrationChoice } from "./workspaceSyncPolicy.ts";

test("brief network, server and throttling failures stay silent; sustained failures surface", () => {
  for (const status of [undefined, 408, 425, 429, 500, 502, 503]) {
    const first = syncFailureNotice({ message: "Unavailable", status }, null, 1_000);
    assert.deepEqual(first, { firstFailureAt: 1_000, message: "" });
    assert.equal(syncFailureNotice({ message: "Still unavailable", status }, first.firstFailureAt, 15_999).message, "");
    assert.equal(syncFailureNotice({ message: "Still unavailable", status }, first.firstFailureAt, 16_000).message, "Still unavailable");
  }
});

test("recovery resets the grace period; different network errors share one outage", () => {
  const first = syncFailureNotice({ message: "Failed to fetch" }, null, 0);
  assert.equal(syncFailureNotice({ message: "HTTP 503", status: 503 }, first.firstFailureAt, 15_000).message, "HTTP 503");
  // A successful sync resets the hook's firstFailureAt to null.
  assert.equal(syncFailureNotice({ message: "New outage", status: 503 }, null, 30_000).message, "");
});

test("conflicts, rejected saves and invalid documents appear immediately; sign-in redirects stay silent", () => {
  for (const status of [400, 403, 409, 413, 422]) {
    assert.equal(syncFailureNotice({ message: "Needs attention", status }, null, 0).message, "Needs attention");
  }
  assert.deepEqual(syncFailureNotice({ message: "Sign in", status: 401 }, 0, 30_000), { firstFailureAt: null, message: "" });
});

const base = {
  workspace: { name: "My workspace", owner: "Owner" },
  dashboards: [
    { id: "custom", widgets: [{ id: "a", w: 2 }, { id: "b", w: 4 }] },
    { id: "servers", widgets: [] },
  ],
};
const fingerprint = workspaceFingerprint(base);

test("key order and JSON's omitted undefined fields are equivalent; board order, deletions and widths are real edits", () => {
  assert.equal(workspaceFingerprint({ dashboards: base.dashboards, workspace: { owner: "Owner", name: "My workspace" }, palette: undefined }), fingerprint);
  for (const dashboards of [
    [...base.dashboards].reverse(),
    [base.dashboards[0]],
    [],
    [{ ...base.dashboards[0], widgets: [{ id: "a", w: 4 }, { id: "b", w: 4 }] }, base.dashboards[1]],
    [{ ...base.dashboards[0], widgets: [...base.dashboards[0]!.widgets].reverse() }, base.dashboards[1]],
  ]) assert.notEqual(workspaceFingerprint({ ...base, dashboards }), fingerprint);
});

const snapshot = { local: fingerprint, server: fingerprint, saved: fingerprint, initial: fingerprint, hasLocal: true, revision: 5, serverRevision: 5 };
test("unchanged and identical newer workspaces hydrate silently, including older browser metadata", () => {
  assert.equal(workspaceHydrationChoice(snapshot), "accept");
  assert.equal(workspaceHydrationChoice({ ...snapshot, serverRevision: 6, saved: null }), "accept");
  assert.equal(workspaceHydrationChoice({ ...snapshot, server: "newer", serverRevision: 6 }), "accept");
  assert.equal(workspaceHydrationChoice({ ...snapshot, hasLocal: false, saved: null, server: "newer" }), "accept");
});

test("pending edits may save against the same base, even if another tab advanced its revision", () => {
  assert.equal(workspaceHydrationChoice({ ...snapshot, local: "local edits" }), "write");
  assert.equal(workspaceHydrationChoice({ ...snapshot, local: "local edits", serverRevision: 6 }), "write");
  assert.equal(workspaceHydrationChoice({ ...snapshot, saved: null, server: null, hasLocal: false, revision: 0, serverRevision: 0, local: "edits while connecting" }), "write");
});

test("divergent edits and unknown legacy copies still require the owner's choice", () => {
  assert.equal(workspaceHydrationChoice({ ...snapshot, local: "local edits", server: "remote edits", serverRevision: 6 }), "conflict");
  assert.equal(workspaceHydrationChoice({ ...snapshot, saved: null, server: "remote edits" }), "conflict");
  const withoutServers = workspaceFingerprint({ ...base, dashboards: [base.dashboards[0]] });
  assert.equal(workspaceHydrationChoice({ ...snapshot, local: withoutServers, server: "remote edits", serverRevision: 6 }), "conflict");
});
