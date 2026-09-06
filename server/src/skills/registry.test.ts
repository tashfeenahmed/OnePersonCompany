/**
 * THE REGISTRY'S OWN INVARIANTS — the ones whose breach is a wrong answer
 * rather than a crash.
 *
 * `entry()` resolves an id by FIRST MATCH with no collision detection, and the
 * proxy routes `<id>/<action>` the same way. So a clash is not an error
 * anywhere: the loser becomes unreachable and every agent asking for it is
 * served the winner's document with the winner's rules attached. Sixteen areas
 * contribute entries and none can see the others, which is exactly the
 * condition under which two of them pick `analytics`.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ENTRIES, entry } from "./registry.ts";

const duplicates = (ids: string[]): string[] => {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const id of ids) (seen.has(id) ? twice : seen).add(id);
  return [...twice].sort();
};

test("every skill id is unique across every area", () => {
  assert.deepEqual(duplicates(ENTRIES.map((s) => s.id)), []);
});

test("an id resolves to the entry that declares it", () => {
  for (const s of ENTRIES) assert.equal(entry(s.id), s, `entry("${s.id}") resolved elsewhere`);
});

test("action keys are unique within their entry", () => {
  for (const s of ENTRIES)
    assert.deepEqual(duplicates((s.actions ?? []).map((a) => a.key)), [], `in "${s.id}"`);
});

test("view keys are unique within their entry", () => {
  for (const s of ENTRIES)
    assert.deepEqual(duplicates(s.views.map((v) => v.key)), [], `in "${s.id}"`);
});

test("an action that spends the run slot declares itself destructive", () => {
  /* `destructive` is published as MCP's `destructiveHint`, and a client reading
     none may call without asking. All three dispatch model work on the owner's
     account, which cancelling the run does not refund. */
  for (const [id, key] of [
    ["runs", "start"],
    ["subagents", "dispatch"],
    ["rounds", "start_now"],
  ] as const) {
    const action = entry(id)?.actions?.find((a) => a.key === key);
    assert.ok(action, `${id}.${key} is gone — move this assertion rather than deleting it`);
    assert.equal(action.destructive, true, `${id}.${key} spends tokens and is unflagged`);
  }
});
