import assert from "node:assert/strict";
import { test } from "node:test";
import { randomId } from "./id.ts";

test("HTTP LAN pages can create distinct v4 IDs without crypto.randomUUID", () => {
  const source = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
  const ids = Array.from({ length: 100 }, () => randomId(source));
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
