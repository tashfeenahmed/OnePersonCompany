import { test } from "node:test";
import assert from "node:assert/strict";
import { readingPresentation } from "./readingPresentation.ts";
const old = { window: 30, loading: false, value: 300, error: null as string | null };
test("range switches retain complete figures and their original date label", () => {
  assert.deepEqual(readingPresentation(old, old, 7), { ...old, loading: true, pendingWindow: 7 });
  const partial = { ...old, window: 7, loading: true, value: 12 };
  assert.equal(readingPresentation(partial, old, 7).value, 300);
  assert.equal(readingPresentation(partial, old, 7).window, 30);
});
test("same-range refreshes can update incrementally; completed failures do not hide behind old readings", () => {
  const refresh = { ...old, loading: true, value: 301 };
  assert.equal(readingPresentation(refresh, old, 30), refresh);
  const failed = { window: 7, loading: false, value: 0, error: "Unavailable" };
  assert.equal(readingPresentation(failed, old, 7), failed);
});
test("changing range again during collection does not expose partial readings", () => {
  assert.equal(readingPresentation({ ...old, window: 7, loading: true, value: 12 }, old, 90).window, 30);
  assert.equal(readingPresentation({ ...old, loading: true }, null, 30).loading, true);
});
