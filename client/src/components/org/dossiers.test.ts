import test from "node:test";
import assert from "node:assert/strict";
import { attaches, dayLabel, dossierWho, runLabel } from "./dossiers.ts";

/* THE ONE RULE ON THIS SIDE THAT HAS A SECOND IMPLEMENTATION. The server files
   a dossier run against a watched person by the same comparison; a drift
   between the two shows up as a person whose own page is empty while their
   card counts three dossiers. */

test("the prefix comes off and the name is what is left", () => {
  assert.equal(dossierWho("Dossier — Jane Doe"), "Jane Doe");
  assert.equal(dossierWho("dossier – Jane Doe"), "Jane Doe");
  assert.equal(dossierWho("Dossier - Jane Doe"), "Jane Doe");
  assert.equal(dossierWho("Jane Doe"), "Jane Doe");
});

test("a title that is only the prefix keeps itself rather than becoming nobody", () => {
  assert.equal(dossierWho("Dossier — "), "Dossier —");
});

test("a name matches its own runs, in any casing", () => {
  assert.ok(attaches("Dossier — Jane Doe", "jane doe"));
  assert.ok(attaches("Dossier — jane doe", "Jane Doe"));
  assert.ok(!attaches("Dossier — Jane Doer", "Jane Doe"));
  assert.ok(!attaches("Dossier — Doe, Jane", "Jane Doe"));
});

test("a comma qualifies a name and does not change who it is", () => {
  assert.ok(attaches("Dossier — Jane Doe, founder of Acme", "Jane Doe"));
  /* And only a comma. A second word with no comma is a different person. */
  assert.ok(!attaches("Dossier — Jane Doe Smith", "Jane Doe"));
});

test("an empty name attaches to nothing rather than to everything", () => {
  assert.ok(!attaches("Dossier — Jane Doe", ""));
  assert.ok(!attaches("Dossier — Jane Doe", "   "));
});

test("the rail's label loses the kind and nothing else", () => {
  assert.equal(runLabel("Dossier — Jane Doe"), "Jane Doe");
  assert.equal(runLabel("SEO — losing pages on acme.com"), "losing pages on acme.com");
  assert.equal(runLabel("A run with no prefix at all"), "A run with no prefix at all");
  /* A long clause before a dash is punctuation, not a kind. */
  assert.equal(
    runLabel("What the twenty best pages have in common — and what they do not"),
    "What the twenty best pages have in common — and what they do not",
  );
});

test("today and yesterday are local days, not 24-hour steps", () => {
  const now = new Date(2026, 8, 7, 1, 0, 0);
  assert.equal(dayLabel(new Date(2026, 8, 7, 0, 30), now), "Today");
  /* Two hours earlier, and a different day: the subtraction would say today. */
  assert.equal(dayLabel(new Date(2026, 8, 6, 23, 0), now), "Yesterday");
  assert.equal(dayLabel(new Date(2026, 8, 5, 23, 0), now), null);
});

test("a stamp that is not a date has no day", () => {
  assert.equal(dayLabel(null), "Undated");
  assert.equal(dayLabel(""), "Undated");
  assert.equal(dayLabel("not a date"), "Undated");
});
