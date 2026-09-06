/**
 * The two dedup keys, on the cases the four copies disagreed about.
 *
 * The pair of assertions that matter most are the ones about digits: a
 * commitment differing only by a number is two commitments, and a measurement
 * differing only by a number is one measurement read twice. Getting those the
 * same way round was the whole disagreement.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FINGERPRINT_MAX, fingerprint, textKey } from "./textkey.ts";

test("the same sentence in different clothes is one key", () => {
  assert.equal(textKey("Revenue up 12%"), "revenue up 12");
  assert.equal(textKey("  REVENUE, up 12%!  "), "revenue up 12");
  assert.equal(textKey("Revenue\tup\n12%"), "revenue up 12");
  /* A model that turned a curly apostrophe straight has not changed what was
     said. */
  assert.equal(textKey("I’ll send it"), textKey("I'll send it"));
  assert.equal(textKey(""), "");
  assert.equal(textKey(null), "");
});

test("the strict key keeps digits, because a number is part of what was said", () => {
  assert.notEqual(textKey("send the 3 files"), textKey("send the 4 files"));
});

test("the fingerprint folds digits, because a figure that moves is one fact", () => {
  const a = fingerprint("Play listing has 4,100 installs");
  const b = fingerprint("Play listing has 4,180 installs");
  assert.equal(a, b);
  assert.equal(a, "play listing has # installs");
  /* Separators and decimal points inside a number fold to ONE marker, not
     three. */
  assert.equal(fingerprint("visits 1_000.5 today"), "visits # today");
  assert.equal(fingerprint("12.5% of 200"), "# of #");
});

test("the fingerprint still separates two different sentences", () => {
  assert.notEqual(
    fingerprint("Play listing has 4,100 installs"),
    fingerprint("App Store listing has 4,100 installs"),
  );
});

test("a fingerprint is capped so it stays an index-sized string", () => {
  const long = "word ".repeat(200);
  assert.equal(fingerprint(long).length, FINGERPRINT_MAX);
  assert.equal(fingerprint(long, 20).length, 20);
  assert.equal(FINGERPRINT_MAX, 200);
});

test("neither key is a similarity measure — a restatement is a different key", () => {
  assert.notEqual(textKey("reply to the reviews"), textKey("reply to reviews"));
  assert.notEqual(fingerprint("reply to the reviews"), fingerprint("reply to reviews"));
});
