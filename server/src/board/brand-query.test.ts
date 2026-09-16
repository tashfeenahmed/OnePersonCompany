import { test } from "node:test";
import assert from "node:assert/strict";
import { brandTokens, editDistance, isBrandQuery } from "./brand-query.ts";

const freellmapi = { name: "FreeLLMAPI", slug: "freellmapi", host: "freellmapi.co" };

test("the venture's own name, its misspellings and its navigational variants are brand", () => {
  const brand = [
    /* The name itself, however it is spelled or punctuated. */
    "freellmapi", "FreeLLMAPI", "freellmapi.co",
    /* The typos Search Console actually returned for this property. */
    "freelmapi", "frellmapi", "freellmap", "freellampi", "freellmpi", "freelllmapi", "feellmapi",
    /* Navigational, with a modifier in front or behind. */
    "freellmapi github", "github freellmapi", "freellmapi pricing", "freellmapi login",
    "tashfeenahmed/freellmapi", "site:freellmapi.co",
  ];
  for (const query of brand) assert.equal(isBrandQuery(query, freellmapi), true, `expected brand: ${query}`);
});

test("the generic phrase a venture is named after is not brand", () => {
  for (const query of ["free llm api", "best free llm api", "openrouter alternative", "llm router"]) {
    assert.equal(isBrandQuery(query, freellmapi), false, `expected non-brand: ${query}`);
  }
});

test("a query is brand only for the venture it names", () => {
  const neu = { name: "Neu", slug: "neu", host: "neu.ie" };
  assert.equal(isBrandQuery("freellmapi", neu), false);
  assert.equal(isBrandQuery("free llm api", neu), false);
  /* `neu` is three characters, so it contributes no token at all: a
     three-letter brand at distance 1 would swallow most short queries. */
  assert.deepEqual(brandTokens(neu), []);
  assert.equal(isBrandQuery("neu", neu), false);
});

test("brand tokens come from name, slug and host label, and drop the suffix", () => {
  assert.deepEqual(brandTokens(freellmapi), ["freellmapi"]);
  assert.deepEqual(brandTokens({ name: "Jot the Spot", slug: "jotthespot", host: "jotthespot.com" }), ["jotthespot"]);
  assert.deepEqual(brandTokens({ name: "UX Pickle", slug: "uxpickle", host: "www.uxpickle.co.uk" }), ["uxpickle"]);
  assert.deepEqual(brandTokens({ name: null, slug: null, host: "sc-domain:example.test" }), ["example"]);
});

test("a short brand tolerates one edit, a long one tolerates two", () => {
  const tells = { name: "Tells Well", slug: "tellswell", host: "tellswell.app" };
  assert.equal(isBrandQuery("tellswel", tells), true);
  const sosho = { name: "Sosho", slug: "sosho", host: "sosho.app" };
  assert.equal(isBrandQuery("soshu", sosho), true);
  /* Two edits away from a five-letter token is a different word. */
  assert.equal(isBrandQuery("sushi", sosho), false);
});

test("the whole-query rule joins at most two words", () => {
  /* A name split by a stray space is still the name... */
  assert.equal(isBrandQuery("freell mapi", freellmapi), true);
  /* ...but three generic words that happen to concatenate to it are not. */
  assert.equal(isBrandQuery("free llm api", freellmapi), false);
});

test("the edit distance counts an adjacent transposition as one and bails out at the cap", () => {
  assert.equal(editDistance("freellmapi", "freellampi", 2), 1);
  assert.equal(editDistance("freellmapi", "freellmapi", 2), 0);
  assert.equal(editDistance("kitten", "sitting", 3), 3);
  assert.equal(editDistance("free", "freellmapi", 2), 3, "over the cap reports cap+1, not the true distance");
  assert.equal(isBrandQuery("", freellmapi), false);
});
