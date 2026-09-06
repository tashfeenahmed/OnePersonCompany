import test from "node:test";
import assert from "node:assert/strict";
import { qs } from "./qs.ts";

test("null never reaches a route as the word null", () => {
  /* The bug this file exists for: four of the seven copies filtered undefined
     but not null, and the client's own idiom for "no venture selected" is
     `?? null`, so the route was asked for a venture named "null" and answered
     with an empty list and no error. */
  assert.equal(qs({ venture: null }), "");
  assert.equal(qs({ venture: null, days: 30 }), "?days=30");
  assert.equal(qs({ venture: undefined, kind: "" , days: 7 }), "?days=7");
});

test("nothing to send is the empty string, so the bare path keeps no trailing ?", () => {
  assert.equal(qs({}), "");
  assert.equal(qs({ a: null, b: undefined, c: "" }), "");
});

test("false is a real answer and is sent", () => {
  assert.equal(qs({ bots: false }), "?bots=false");
  assert.equal(qs({ bots: true }), "?bots=true");
});

test("zero is a real answer and is sent", () => {
  assert.equal(qs({ offset: 0 }), "?offset=0");
});

test("values that would break the query string are encoded", () => {
  assert.equal(qs({ q: "a&b=c" }), "?q=a%26b%3Dc");
  assert.equal(qs({ q: "two words" }), "?q=two+words");
  assert.equal(qs({ q: "#tag" }), "?q=%23tag");
});

test("order follows the object, so a URL is stable between renders", () => {
  assert.equal(qs({ venture: "acme", days: 30, limit: 50 }), "?venture=acme&days=30&limit=50");
});
