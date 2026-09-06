/**
 * THE BUDGET'S EDGES, WHICH ARE THE WHOLE OF IT.
 *
 * A shaper that works on the easy document and fails on the exact-size one is
 * a shaper that produces an unparseable answer roughly once a week, at a size
 * nobody will reproduce by hand. So: a document one byte under the limit, one
 * byte over, arrays inside arrays, an array of mixed scalars and objects, a
 * multi-byte string on a boundary, and a body that is not JSON at all.
 *
 * Every assertion about a bounded JSON document ends by PARSING it. That is
 * the property the file exists for and it is the one a reader should see
 * checked, rather than a byte count that happens to be right.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundResponse, byteLength, sliceBytes } from "./bound.ts";

const HOW = "pass limit and offset";

test("a document inside the budget comes back byte for byte", () => {
  const body = JSON.stringify({ total: 3, rows: [1, 2, 3] });
  const r = boundResponse(body, { budget: 1024, how: HOW });
  assert.equal(r.text, body);
  assert.equal(r.bounded, false);
  assert.equal(r.note, null);
  assert.equal(r.trimmed.length, 0);
});

test("a document exactly on the budget is not touched", () => {
  const body = JSON.stringify({ rows: Array.from({ length: 40 }, (_, i) => i) });
  const exact = byteLength(body);
  const r = boundResponse(body, { budget: exact, how: HOW });
  assert.equal(r.bounded, false);
  assert.equal(r.text, body);
});

test("one byte under the budget is shortened, and stays valid JSON", () => {
  const body = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => i) });
  const exact = byteLength(body);
  const r = boundResponse(body, { budget: exact - 1, how: HOW });
  assert.equal(r.bounded, true);
  assert.ok(r.bytes <= exact - 1, `${r.bytes} should be within ${exact - 1}`);
  const doc = JSON.parse(r.text) as { rows: unknown[] };
  const marker = doc.rows[doc.rows.length - 1] as {
    truncated: boolean;
    shown: number;
    total: number;
  };
  assert.equal(marker.truncated, true);
  assert.equal(marker.total, 400);
  assert.equal(marker.shown, doc.rows.length - 1);
  /* The way out is written ONCE, at the root — a marker that carried the whole
     sentence cost more than the rows it replaced. */
  assert.equal((doc as unknown as { _bounded: { next: string } })._bounded.next, HOW);
});

test("scalars and summary fields survive; only rows are dropped", () => {
  const body = JSON.stringify({
    window: "30 days",
    unit: "GBP",
    total: 1234.5,
    measured: null,
    rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row ${i}`, amount: i * 3 })),
  });
  const r = boundResponse(body, { budget: 900, how: HOW });
  const doc = JSON.parse(r.text) as Record<string, unknown>;
  assert.equal(doc.window, "30 days");
  assert.equal(doc.unit, "GBP");
  assert.equal(doc.total, 1234.5);
  assert.equal(doc.measured, null);
  assert.ok(byteLength(r.text) <= 900);
  const rows = doc.rows as unknown[];
  assert.ok(rows.length < 500);
  assert.equal((rows[rows.length - 1] as { total: number }).total, 500);
});

test("nested arrays are each marked with their own totals", () => {
  const body = JSON.stringify({
    groups: Array.from({ length: 6 }, (_, g) => ({
      key: `g${g}`,
      items: Array.from({ length: 60 }, (_, i) => ({ i, blurb: `item ${i} of group ${g}` })),
    })),
  });
  const r = boundResponse(body, { budget: 1200, how: HOW });
  const doc = JSON.parse(r.text) as {
    groups: ({ key?: string; items?: unknown[]; truncated?: boolean; total?: number } | undefined)[];
  };
  assert.ok(byteLength(r.text) <= 1200);
  /* Whatever was dropped, every surviving marker tells the truth about the
     list it ends: an inner one says 60, the outer one says 6. */
  const outerMarker = doc.groups[doc.groups.length - 1]!;
  if (outerMarker.truncated) assert.equal(outerMarker.total, 6);
  for (const g of doc.groups) {
    if (!g || !g.items) continue;
    const last = g.items[g.items.length - 1] as { truncated?: boolean; total?: number };
    if (last && last.truncated) assert.equal(last.total, 60);
  }
  assert.ok(r.trimmed.length >= 1);
  assert.ok(r.note && r.note.includes("truncated"));
});

test("a mixed array of scalars, objects and nulls keeps its order and parses", () => {
  const mixed: unknown[] = [];
  for (let i = 0; i < 200; i++) {
    mixed.push(i % 4 === 0 ? i : i % 4 === 1 ? `text ${i}` : i % 4 === 2 ? null : { i, deep: [i, i + 1] });
  }
  const body = JSON.stringify({ note: "mixed", mixed });
  const r = boundResponse(body, { budget: 700, how: HOW });
  const doc = JSON.parse(r.text) as { note: string; mixed: unknown[] };
  assert.equal(doc.note, "mixed");
  assert.deepEqual(doc.mixed[0], 0);
  assert.deepEqual(doc.mixed[1], "text 1");
  assert.deepEqual(doc.mixed[2], null);
  assert.equal((doc.mixed[doc.mixed.length - 1] as { total: number }).total, 200);
});

test("a top-level array is shortened in place", () => {
  const body = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ i, s: `value ${i}` })));
  const r = boundResponse(body, { budget: 600, how: HOW });
  const doc = JSON.parse(r.text) as unknown[];
  assert.ok(Array.isArray(doc));
  assert.equal((doc[doc.length - 1] as { total: number }).total, 300);
  assert.equal(r.trimmed[0]!.path, "$");
});

test("fields picks top-level keys, keeps `error`, and names what it did not find", () => {
  const body = JSON.stringify({ a: 1, b: [1, 2, 3], error: "half of this is missing", c: 3 });
  const r = boundResponse(body, { budget: 4096, fields: ["a", "zzz"], how: HOW });
  const doc = JSON.parse(r.text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(doc).sort(), ["a", "error"]);
  assert.equal(r.bounded, true);
  assert.deepEqual(r.unknownFields, ["zzz"]);
});

test("a single huge string is abridged rather than cut, and still parses", () => {
  const body = JSON.stringify({ id: 7, body: "x".repeat(50_000) });
  const r = boundResponse(body, { budget: 1000, how: HOW });
  assert.ok(byteLength(r.text) <= 1000);
  const doc = JSON.parse(r.text) as { id: number; body: string };
  assert.equal(doc.id, 7);
  assert.ok(doc.body.endsWith("… [abridged]"));
});

test("multi-byte characters are never cut in half", () => {
  /* Four bytes each, so a byte budget lands inside a character unless the
     slicer is doing its job. */
  const s = "🙂".repeat(500);
  for (let budget = 40; budget < 60; budget++) {
    const cut = sliceBytes(s, budget);
    assert.ok(byteLength(cut) <= budget);
    assert.equal(cut.includes("�"), false);
    /* Re-encoding and decoding a well-formed string is the identity; a broken
       surrogate pair would come back as a replacement character. */
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(cut)), cut);
  }
});

test("a body that is not JSON is cut as text and says so", () => {
  const body = `hello ${"word ".repeat(5000)}`;
  const r = boundResponse(body, { budget: 500, how: HOW });
  assert.equal(r.json, false);
  assert.equal(r.bounded, true);
  assert.ok(byteLength(r.text) <= 500);
  assert.ok(r.text.includes("[cut here"));
  assert.ok(r.note && r.note.includes("not JSON"));
});

test("short non-JSON is left completely alone", () => {
  const r = boundResponse("not json at all", { budget: 500, how: HOW });
  assert.equal(r.text, "not json at all");
  assert.equal(r.bounded, false);
  assert.equal(r.json, false);
});

test("the pretty form is measured against what it prints", () => {
  const body = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i })) });
  const r = boundResponse(body, { budget: 800, how: HOW, pretty: true });
  assert.ok(byteLength(r.text) <= 800);
  assert.ok(r.text.includes("\n  "));
  JSON.parse(r.text);
});

test("the input document is not edited", () => {
  const doc = { rows: Array.from({ length: 400 }, (_, i) => ({ i, s: `row ${i}` })) };
  const body = JSON.stringify(doc);
  boundResponse(body, { budget: 500, how: HOW });
  assert.equal(JSON.parse(body).rows.length, 400);
});

test("an empty document and an empty array are both left alone", () => {
  assert.equal(boundResponse("{}", { budget: 512, how: HOW }).bounded, false);
  assert.equal(boundResponse("[]", { budget: 512, how: HOW }).bounded, false);
  assert.equal(boundResponse("null", { budget: 512, how: HOW }).text, "null");
});

/* ======================================================================
   REGRESSIONS FROM REVIEW. Each of these failed before the fix beside it,
   and each is a shape a real skill document actually has.
   ====================================================================== */

test("regression: many small arrays are shortened, not thrown away", () => {
  /* Two hundred ten-integer lists. Every marker used to carry the whole "here
     is how to page" sentence, so a marker cost more than the rows it replaced
     and the document could not be fitted however many rows were dropped — it
     fell through to a bail that answered with no data at all. */
  const doc: Record<string, unknown> = {};
  for (let i = 0; i < 200; i++) doc[`series${i}`] = Array.from({ length: 10 }, (_, k) => k);
  const body = JSON.stringify(doc);
  assert.ok(byteLength(body) > 4096);

  const r = boundResponse(body, { budget: 4096, how: HOW });
  assert.ok(byteLength(r.text) <= 4096);
  const out = JSON.parse(r.text) as Record<string, unknown>;
  /* Real data came back — not an error object. */
  assert.ok(Object.keys(out).length > 20, `only ${Object.keys(out).length} keys survived`);
  assert.deepEqual(out.series0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal((out._bounded as { next: string }).next, HOW);
  assert.ok(!("error" in out), "this is not a document with one oversized value");
});

test("regression: a document of many short scalar fields keeps its head and counts what it dropped", () => {
  /* Four hundred short strings: no rows to shorten, no string long enough to
     abridge, and five times the budget. The old code bailed with a sentence
     claiming a single value was too big, which was false, and returned nothing
     the agent could use. */
  const doc: Record<string, unknown> = {};
  for (let i = 0; i < 400; i++) doc[`field_number_${i}`] = `value ${i}`;
  const body = JSON.stringify(doc);
  const r = boundResponse(body, { budget: 2048, how: HOW });

  assert.ok(byteLength(r.text) <= 2048);
  const out = JSON.parse(r.text) as Record<string, unknown>;
  assert.equal(out.field_number_0, "value 0", "the head of the document survives");
  assert.ok(typeof out._omitted === "number" && (out._omitted as number) > 0);
  assert.ok(r.note && r.note.includes("_omitted"));
  assert.ok(!("error" in out));
});

test("regression: `pretty` is honoured for a document that fits", () => {
  /* `opc` prints indented JSON, and the fix that bounded the answer used to
     hand back the route's own compact bytes whenever the document fitted — so
     every small document printed as one long line and `--raw` did nothing. */
  const body = JSON.stringify({ a: 1, rows: [1, 2, 3] });
  const pretty = boundResponse(body, { budget: 8192, how: HOW, pretty: true });
  assert.ok(pretty.text.includes("\n  "), "a fitting document is still indented");
  assert.equal(pretty.bounded, false);
  assert.deepEqual(JSON.parse(pretty.text), JSON.parse(body));

  const raw = boundResponse(body, { budget: 8192, how: HOW, pretty: false });
  assert.equal(raw.text, body, "--raw still gets the bytes the route sent");
});

test("regression: `fields` against an array root says so instead of claiming a subset", () => {
  const r = boundResponse("[1,2,3]", { budget: 4096, fields: ["a"], how: HOW });
  assert.equal(r.text, "[1,2,3]");
  assert.ok(r.note && r.note.includes("no top-level keys"));
  assert.equal(r.unknownFields.length, 0, "an array has no field to be missing");
});

test("the guidance survives every pass that shortens the document", () => {
  const doc = {
    summary: { total: 9 },
    prose: "x".repeat(20_000),
    rows: Array.from({ length: 500 }, (_, i) => ({ i, s: `row ${i}` })),
  };
  const r = boundResponse(JSON.stringify(doc), { budget: 1500, how: HOW });
  assert.ok(byteLength(r.text) <= 1500);
  const out = JSON.parse(r.text) as Record<string, unknown>;
  assert.equal((out._bounded as { next: string }).next, HOW, "never abridged, never dropped");
});

test("a budget too small for its own footer still answers within it", () => {
  /* The function's floor is 64 bytes; the non-JSON footer alone was longer. */
  const r = boundResponse(`prose ${"and more ".repeat(200)}`, { budget: 64, how: HOW });
  assert.ok(byteLength(r.text) <= 64, `${byteLength(r.text)} bytes`);
  assert.equal(r.bounded, true);
});
