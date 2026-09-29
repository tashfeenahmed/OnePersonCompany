/**
 * THE MATCHER — the whole-phrase rule, tested against the false positives it
 * was written for.
 *
 * The three refusals at the top are the exact pairs measured on demand run
 * r-1edbgc and reported by the owner: "trending in my niche" (18 HN threads)
 * fed by a Python tutorial and a Claude release, "trying to conceive app"
 * (9) fed by an AI-criticism story, "planning permission ireland" (1) fed by
 * a paint article. A matcher change that fixed the counts but broke the
 * legitimate rows below would be a matcher that measures less, which is not
 * the ticket.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { matchesPhrase, isStaleMatch } from "./demand.ts";

/* ------------------------------------------------ the ticket's false hits */

test("the three counts the ticket named are refused", () => {
  assert.equal(matchesPhrase("trending in my niche", "Jev in 25 Lines of Python"), false);
  assert.equal(matchesPhrase("trending in my niche", "Claude Opus 5.5"), false);
  assert.equal(matchesPhrase("trying to conceive app", "Feds Target AI Critics"), false);
  assert.equal(matchesPhrase("planning permission ireland", "A new line of interior paint"), false);
});

test("a substring that is not a word never matches", () => {
  /* The old failure shape: 'plant' inside 'planning', a title that shares
     letters rather than words. */
  assert.equal(matchesPhrase("plant planning", "Planning permission for a garden shed"), false);
  assert.equal(matchesPhrase("app", "Appendicitis and what the ER did next"), false);
});

/* --------------------------------------------------- what must still pass */

test("the whole phrase inside a sentence matches", () => {
  assert.equal(
    matchesPhrase("planning permission ireland", "Ask HN: Who understands planning permission in Ireland?"),
    true,
  );
});

test("phrase words split by a clause still match, in any order", () => {
  /* 'trying to conceive … app' is the demand the phrase names; requiring an
     adjacent phrase at the engine level killed exactly this row. */
  assert.equal(
    matchesPhrase("trying to conceive app", "We're trying to conceive — is there an app that tracks this?"),
    true,
  );
  assert.equal(matchesPhrase("free llm api", "An API for LLMs that is free"), true);
});

test("punctuation and case do not break a match", () => {
  assert.equal(matchesPhrase("AI Group Call", "Introducing “AI Group Call” — beta"), true);
  assert.equal(matchesPhrase("c++", "What happened to C++?"), true);
});

/* ---------------------------------------------------------- the body tier */

test("a comment matches on its own text when the parent title is off-phrase", () => {
  assert.equal(
    matchesPhrase("trending in my niche", "Show HN: My analytics dashboard", "I want to know what's trending in my niche without opening ten tabs."),
    true,
  );
});

test("a comment whose title and text both miss the phrase is refused", () => {
  assert.equal(matchesPhrase("trending in my niche", "Show HN: My analytics dashboard", "nice work, shipping this!"), false);
});

/* ------------------------------------------------------------ the purge */

const row = (over: Record<string, unknown> = {}) => ({
  source: "hn",
  id: "1",
  term: "trending in my niche",
  title: "Jev in 25 Lines of Python",
  url: "https://news.ycombinator.com/item?id=1",
  context: "story",
  created_at: null,
  points: null,
  comments: null,
  tier: "algolia",
  first_seen_at: "",
  seen_at: "",
  ...over,
});

test("the purge drops algolia rows off the phrase", () => {
  assert.equal(isStaleMatch(row()), true);
  assert.equal(
    isStaleMatch(row({ title: "What's trending in my niche?", id: "2" })),
    false,
  );
});

test("the purge never touches the quoted feed tier", () => {
  /* Reddit's Atom feed queries the exact quoted phrase, so its rows may
     legitimately miss the phrase in the TITLE — the body is what it matched.
     A purge that deleted those would delete the evidence. */
  assert.equal(isStaleMatch(row({ source: "reddit", tier: "feed" })), false);
  assert.equal(isStaleMatch(row({ source: "reddit", tier: "feed+token" })), false);
});

test("the purge never judges a comment by its parent title", () => {
  /* A comment row's title is its parent story's; it was kept on its own text,
     which is not stored, so an off-phrase title proves nothing. */
  assert.equal(isStaleMatch(row({ context: "comment", title: "Show HN: My analytics dashboard" })), false);
});

test("a searxng row off the phrase is purged", () => {
  assert.equal(
    isStaleMatch(row({ source: "reddit", tier: "searxng", context: "r/paint" })),
    true,
  );
});
