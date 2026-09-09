/**
 * WHAT IS ACTUALLY WORTH ASSERTING ABOUT A TABLE OF PROSE.
 *
 * Not the prose. Three behaviours, and each of them is a promise made to a
 * caller that cannot see the SQL:
 *
 *   THE MERGE. An agent is handed one field to change and must not wipe the
 *   other eight to do it. That is the rule in the skill's own text and it is
 *   one `COALESCE` away from being false.
 *
 *   UNWRITTEN IS NOT EMPTY. `written: false` with nine nulls has to survive a
 *   round trip, because every rule about how to report a guide hangs off it and
 *   a saved blank form must not read as an opinion.
 *
 *   THE PROMPT BLOCK IS NULL WHEN THERE IS NOTHING TO SAY. Three generators
 *   call `guidePrompt` on every run; a version that returned a header over
 *   empty space would put a heading in every prompt on this box asking a model
 *   to fill it in.
 *
 * The database is a fresh temporary one per test worker — see test/setup.mjs —
 * so nothing here touches a developer's rows.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, now } from "../../db.ts";
import { GUIDE_LIMITS, guidePrompt, guideVisuals, saveGuide, shapeGuide, guideRow } from "./guide.ts";

function venture(id: string, slug: string) {
  const ts = now();
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color, color_source, position, brand, created_at, updated_at)
     VALUES (?,?,'A venture','A test','https://t.invalid','t.invalid','launched','#123456','default',0,'{}',?,?)`,
  ).run(id, slug, ts, ts);
  return id;
}

test("a guide nobody has written is unwritten rather than empty, and adds nothing to a prompt", () => {
  const id = venture("v-ref-a", "ref-a");
  const guide = shapeGuide(id, guideRow(id));
  assert.equal(guide.written, false);
  assert.equal(guide.tone, null);
  assert.equal(guidePrompt(id), null);
  assert.deepEqual(guideVisuals(id), { colours: null, fonts: null });
});

test("saving one field leaves the others exactly as they were", () => {
  const id = venture("v-ref-b", "ref-b");
  const first = saveGuide(id, { tone: "Plain and unhurried.", audience: "Shop owners." });
  assert.ok(first.ok);
  const second = saveGuide(id, { donts: "Never say “revolutionise”." });
  assert.ok(second.ok);
  assert.equal(second.guide.tone, "Plain and unhurried.");
  assert.equal(second.guide.audience, "Shop owners.");
  assert.equal(second.guide.donts, "Never say “revolutionise”.");
  assert.equal(second.guide.written, true);
});

test("an empty string clears a field, which is how a field is deliberately unwritten again", () => {
  const id = venture("v-ref-c", "ref-c");
  saveGuide(id, { tone: "Loud." });
  const cleared = saveGuide(id, { tone: "" });
  assert.ok(cleared.ok);
  assert.equal(cleared.guide.tone, null);
  assert.equal(cleared.guide.written, false);
  /* And with nothing written the prompt block is gone again, not a heading
     over a blank. */
  assert.equal(guidePrompt(id), null);
});

test("a field over its ceiling is refused whole, and nothing is half-saved", () => {
  const id = venture("v-ref-d", "ref-d");
  saveGuide(id, { tone: "Plain." });
  const refused = saveGuide(id, {
    audience: "x".repeat(GUIDE_LIMITS.audience + 1),
    tone: "Loud.",
  });
  assert.equal(refused.ok, false);
  assert.match((refused as { error: string }).error, /audience/);
  /* The tone in the same rejected call was NOT written. */
  assert.equal(shapeGuide(id, guideRow(id)).tone, "Plain.");
});

test("the prompt block names its author and carries only the writers' fields", () => {
  const id = venture("v-ref-e", "ref-e");
  saveGuide(id, {
    tone: "Plain and unhurried.",
    audience: "Shop owners.",
    language: "English.",
    colours: "Use the navy, not the green.",
    notes: "A note to myself.",
  });
  const block = guidePrompt(id)!;
  assert.match(block, /owner's own style guide/i);
  /* It says what it is NOT: instruction rather than evidence. Three prompts
     forbid inventing a fact, and a tone of voice must not read as an
     exemption from that. */
  assert.match(block, /instruction, not evidence/);
  assert.match(block, /Plain and unhurried\./);
  assert.match(block, /Shop owners\./);
  assert.match(block, /English\./);
  /* The two that go elsewhere are absent: a caption writer cannot act on a
     colour, and the note was never meant for a model at all. */
  assert.ok(!block.includes("navy"));
  assert.ok(!block.includes("A note to myself."));
  assert.equal(guideVisuals(id).colours, "Use the navy, not the green.");
});

test("a guide cannot be written against a venture that does not exist", () => {
  const res = saveGuide("v-nobody", { tone: "Plain." });
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /no venture/);
});
