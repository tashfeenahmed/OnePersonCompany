import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { ReadCache } from "./read-cache.ts";

test("reads coalesce, expire, bypass on refresh and do not retain failures", async () => {
  const cache = new ReadCache<number>(15);
  let calls = 0;
  const load = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get("a", load), cache.get("a", load)]), [1, 1]);
  assert.equal(await cache.get("a", load), 1);
  assert.equal(await cache.get("a", load, true), 2);
  await setTimeout(25);
  assert.equal(await cache.get("a", load), 3);
  await assert.rejects(cache.get("bad", async () => { throw new Error("offline"); }));
  assert.equal(await cache.get("bad", load), 4);
  cache.clear();
});

test("invalidated or evicted in-flight reads cannot restore stale data", async () => {
  const cache = new ReadCache<string>(1000, 2);
  let complete!: (value: string) => void;
  const old = cache.get("account:a", () => new Promise(resolve => { complete = resolve; }));
  await Promise.resolve();
  cache.clear("account:");
  assert.equal(await cache.get("account:a", async () => "new"), "new");
  complete("old");
  assert.equal(await old, "old");
  assert.equal(await cache.get("account:a", async () => "wrong"), "new");
  await cache.get("b", async () => "b");
  await cache.get("c", async () => "c");
  assert.equal(await cache.get("account:a", async () => "reloaded"), "reloaded");
  cache.clear();
});
