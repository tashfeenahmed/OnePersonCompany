import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateThreads, invalidateMailboxPages, listThreads, modify, type Session } from "./gmail.ts";

const session: Session = {
  account: { id: 901, pluginId: "gmail", label: "Test", connected: true, createdAt: "", updatedAt: "", lastOkAt: null, lastError: null },
  token: "test-token", cacheScope: "credentials-a", scopes: ["https://www.googleapis.com/auth/gmail.modify"],
};

test("mail list caching coalesces requests, isolates accounts and queries, refreshes and invalidates after read changes", async (t) => {
  let lists = 0, summaries = 0, writes = 0, unread = true, failSummary = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/modify")) { writes++; unread = false; return Response.json({}); }
    if (url.pathname.endsWith("/threads")) { lists++; return Response.json({ threads: [{ id: "abc123", snippet: "test", historyId: "1" }] }); }
    assert.ok(url.pathname.endsWith("/threads/abc123"));
    summaries++;
    if (failSummary) return new Response("Unavailable", { status: 500 });
    return Response.json({ messages: [{ id: "msg", internalDate: "1000", labelIds: unread ? ["UNREAD"] : [], payload: { headers: [{ name: "Subject", value: "Test" }] } }] });
  });
  const opts = { q: "in:inbox", max: 25, cache: true };
  const [first, duplicate] = await Promise.all([listThreads(session, opts), listThreads(session, opts)]);
  assert.deepEqual(first, duplicate);
  assert.equal(first.threads[0]?.unread, true);
  assert.deepEqual([lists, summaries], [1, 1]);
  await listThreads(session, opts);
  assert.equal(lists, 1);
  await listThreads(session, { ...opts, q: "is:starred" });
  await listThreads(session, { ...opts, pageToken: "next" });
  await listThreads({ ...session, account: { ...session.account, id: 902 } }, opts);
  await listThreads({ ...session, cacheScope: "rotated-credentials" }, opts);
  assert.equal(lists, 5);
  await listThreads(session, { ...opts, fresh: true });
  assert.equal(lists, 6);
  await modify(session, "abc123", false);
  assert.equal(writes, 1);
  const after = await listThreads(session, opts);
  assert.equal(lists, 7);
  assert.equal(after.threads[0]?.unread, false);
  await listThreads(session, { ...opts, cache: false });
  assert.equal(lists, 8, "collectors and agent reads do not use cached pages");
  invalidateMailboxPages(session);
  failSummary = true;
  assert.equal((await listThreads(session, opts)).dropped, 1);
  failSummary = false;
  assert.equal((await listThreads(session, opts)).dropped, 0, "partial failures are not cached");
  invalidateMailboxPages(session);
});

test("summary reuse requires the same account and Gmail revision; refresh and missing revisions read again", async t => {
  let reads = 0;
  const current = { ...session, account: { ...session.account, id: 903 } };
  t.mock.method(globalThis, "fetch", async () => {
    reads++;
    return Response.json({ messages: [{ id: "msg", internalDate: "1000", labelIds: [], payload: { headers: [] } }] });
  });
  const stub = { id: "abc123", snippet: "test", historyId: "1" };
  await hydrateThreads(current, [stub], { cache: true });
  await hydrateThreads(current, [stub], { cache: true });
  assert.equal(reads, 1);
  await hydrateThreads(current, [{ ...stub, historyId: "2" }], { cache: true });
  assert.equal(reads, 2, "a changed conversation cannot reuse an old summary");
  await hydrateThreads(current, [stub], { cache: true, fresh: true });
  assert.equal(reads, 3);
  await hydrateThreads(current, [{ ...stub, historyId: null }], { cache: true });
  await hydrateThreads(current, [{ ...stub, historyId: null }], { cache: true });
  assert.equal(reads, 5);
  await hydrateThreads({ ...current, cacheScope: "other-credentials" }, [stub], { cache: true });
  assert.equal(reads, 6);
  invalidateMailboxPages(current);
  await hydrateThreads(current, [stub], { cache: true });
  assert.equal(reads, 7);
  invalidateMailboxPages(current);
});
