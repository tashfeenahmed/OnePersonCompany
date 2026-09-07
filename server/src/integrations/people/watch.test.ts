/**
 * The two rules the watchlist rests on, tested where they can be tested
 * without a database.
 *
 * `attaches` and `composeBrief` are two halves of one mechanism and they are
 * tested together for that reason: the brief decides what the run's title
 * becomes, and `attaches` decides which titles come back. Nothing else in
 * watch.ts is worth a unit test — it is SQL and a call into another area's
 * dispatch, and neither is a thing a unit test tells the truth about.
 *
 * The round trip at the bottom is the one that matters: brief → title →
 * attaches. Either function could be changed on its own and stay correct by
 * its own lights while the pair stopped working.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attaches, composeBrief } from "./watch.ts";
import { dossierTitle } from "../runs/kinds.ts";

/* --------------------------------------------------------------- attaches */

test("a dossier attaches to the person it is titled after", () => {
  assert.ok(attaches("Dossier — Jane Doe", "Jane Doe"));
  /* Casing is not identity: the owner types a name twice and gets it slightly
     different, and the record must not split in half over it. */
  assert.ok(attaches("Dossier — jane doe", "JANE DOE"));
  assert.ok(attaches("Dossier — Jane Doe", "  Jane Doe  "));
});

test("the qualifying clause after a comma is kept and still attaches", () => {
  /* `dossierTitle` deliberately keeps the comma clause, because it is how one
     Jane Doe is told from another. A watch row named for the person alone must
     still find those runs. */
  assert.ok(attaches("Dossier — Jane Doe, founder of Acme", "Jane Doe"));
  assert.ok(attaches("Dossier — Jane Doe, CTO", "Jane Doe"));
});

test("a longer name that merely starts the same is a different person", () => {
  /* The reason the prefix rule ends at a COMMA and not at any character: a
     `startsWith` on the bare name would file every Doe-Smith dossier under
     Doe. */
  assert.ok(!attaches("Dossier — Jane Doe-Smith", "Jane Doe"));
  assert.ok(!attaches("Dossier — Jane Doerr", "Jane Doe"));
  assert.ok(!attaches("Dossier — Janet Doe", "Jane Doe"));
});

test("a title without the prefix is compared whole, and an empty name matches nothing", () => {
  /* A run titled from somewhere else is not silently reinterpreted. */
  assert.ok(attaches("Jane Doe", "Jane Doe"));
  assert.ok(!attaches("Research — Jane Doe", "Jane Doe"));
  /* The one that would otherwise attach EVERY dossier to a blank row. */
  assert.ok(!attaches("Dossier — Jane Doe", ""));
  assert.ok(!attaches("Dossier — Jane Doe", "   "));
});

/* ----------------------------------------------------------- the composer */

test("the first line is the name and nothing else", () => {
  const brief = composeBrief({ name: "Jane Doe", role: "Founder", company: "Acme" });
  assert.equal(brief.split("\n")[0], "Jane Doe");
  /* And a blank line under it, so the identity lines are their own paragraph
     and `dossierTitle` cannot reach them. */
  assert.equal(brief.split("\n")[1], "");
});

test("only the lines that were typed appear — nothing says “unknown”", () => {
  const brief = composeBrief({ name: "Jane Doe", company: "Acme", note: "Met at a conference." });
  assert.equal(
    brief,
    ["Jane Doe", "", "Company: Acme", "Note: Met at a conference."].join("\n"),
  );
  assert.ok(!brief.includes("Role:"));
  assert.ok(!brief.includes("Email:"));
  assert.ok(!/unknown/i.test(brief));
});

test("a person with nothing but a name is a brief of one line", () => {
  assert.equal(composeBrief({ name: "Jane Doe" }), "Jane Doe");
});

test("the links are labelled the way a person writes them, in a fixed order", () => {
  const brief = composeBrief({
    name: "Jane Doe",
    links: {
      bluesky: "jane.bsky.social",
      website: "https://jane.example",
      x: "@jane",
      github: "janedoe",
      linkedin: "in/janedoe",
    },
  });
  assert.deepEqual(brief.split("\n").slice(2), [
    "Website: https://jane.example",
    "GitHub: janedoe",
    "X: @jane",
    "LinkedIn: in/janedoe",
    "Bluesky: jane.bsky.social",
  ]);
});

test("an empty link or a blank field is left out rather than written empty", () => {
  const brief = composeBrief({
    name: "Jane Doe",
    company: "   ",
    email: "",
    links: { website: "  ", github: "janedoe" },
  });
  assert.equal(brief, ["Jane Doe", "", "GitHub: janedoe"].join("\n"));
});

test("the focus is a paragraph of its own at the end, never a first-line clause", () => {
  const brief = composeBrief({ name: "Jane Doe", role: "Founder" }, "What has she shipped since March?");
  assert.equal(
    brief,
    ["Jane Doe", "", "Role: Founder", "", "Look into: What has she shipped since March?"].join("\n"),
  );
  /* A blank focus adds nothing at all — no dangling heading. */
  assert.equal(composeBrief({ name: "Jane Doe" }, "   "), "Jane Doe");
});

/* ------------------------------------------------------- the round trip */

test("the brief a watch entry composes titles a run that attaches back to it", () => {
  /* THE PAIR. This is the whole feature: compose, title, find again. Either
     half could be changed alone and stay correct by its own lights while the
     dossiers stopped appearing on the person's card. */
  for (const person of [
    { name: "Jane Doe" },
    { name: "Jane Doe", company: "Acme", role: "Founder", email: "jane@acme.io" },
    { name: "Jane Doe, founder of Acme", note: "Introduced by Peter." },
  ]) {
    const title = dossierTitle(composeBrief(person, "Anything new this quarter?"));
    assert.ok(attaches(title, person.name), `${title} did not attach to ${person.name}`);
  }
  /* And the name as typed on the row finds the run titled after the longer
     form, which is the case the comma rule exists for. */
  const longer = dossierTitle(composeBrief({ name: "Jane Doe, founder of Acme" }));
  assert.equal(longer, "Dossier — Jane Doe, founder of Acme");
  assert.ok(attaches(longer, "Jane Doe"));
});
