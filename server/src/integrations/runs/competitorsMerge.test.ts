/**
 * THE RULES THE COMPETITOR REGISTER RESTS ON, CHECKED EXACTLY.
 *
 * Every function in `competitorsMerge.ts` fails as a PLAUSIBLE WRONG ANSWER
 * rather than as a crash, which is why it is a leaf and why this file exists.
 * A change note that fires on a synonym swap fills the table with badges
 * nobody reads; one that never fires makes the feature look like it is not
 * running. A merge that stamps `firstSeen` on every write turns "we have known
 * about this one since March" into "since tonight" on the first
 * re-verification — which is the bug this whole change was written to fix, and
 * it is the first thing asserted below. A source gate that lets a rival
 * through with no page behind it puts an invented company on the owner's
 * dashboard. None of them touch a database and none of them throw, so all of
 * them are checked here against strings.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changesBetween,
  daysSince,
  hostOf,
  mergeRegistry,
  mergeSources,
  priceMove,
  priceSignature,
  proseOverlap,
  readAnswer,
  type Found,
  type Known,
} from "./competitorsMerge.ts";

const JULY = "2026-07-01T00:00:00.000Z";
const NOW = "2026-09-07T12:00:00.000Z";

const known = (over: Partial<Known>): Known => ({
  name: "Opus Clip",
  domain: "opus.pro",
  url: "https://opus.pro",
  positioning: "AI clipper with virality scoring for podcasts and webinars.",
  pricing: "Free $0; Starter $15/mo; Pro $29/mo",
  strengths: ["virality score"],
  weaknesses: ["web only"],
  sources: ["https://opus.pro/pricing"],
  lastVerified: JULY,
  firstSeen: JULY,
  changes: [],
  ...over,
});

const found = (over: Partial<Found>): Found => ({
  name: "Opus Clip",
  domain: "opus.pro",
  url: "https://opus.pro",
  positioning: "AI clipper with virality scoring for podcasts and webinars.",
  pricing: "Free $0; Starter $15/mo; Pro $29/mo",
  strengths: ["virality score"],
  weaknesses: ["web only"],
  sources: ["https://opus.pro/pricing"],
  ...over,
});

/* ------------------------------------------------------------- the domain */

test("hostOf folds every way a model writes a host to one key", () => {
  assert.equal(hostOf("https://www.Opus.pro/pricing?ref=x"), "opus.pro");
  assert.equal(hostOf("opus.pro"), "opus.pro");
  assert.equal(hostOf("http://klap.app/"), "klap.app");
  assert.equal(hostOf("HTTPS://KLAP.APP"), "klap.app");
  assert.equal(hostOf("sub.example.co.uk/a/b"), "sub.example.co.uk");
  assert.equal(hostOf(null), null);
  assert.equal(hostOf(""), null);
  /* A product name in the domain field is not a host, and turning it into one
     would be a key nothing can ever match. */
  assert.equal(hostOf("Opus Clip"), null);
  assert.equal(hostOf("unknown"), null);
});

/* --------------------------------------------------- what counts as a change */

test("priceSignature counts money and ignores the specifications that churn", () => {
  assert.deepEqual(priceSignature("Starter $15/mo, Pro $29/mo"), ["$15", "$29"]);
  /* The churn this was written for: the same price with the feature counts
     renumbered is the SAME signature. */
  assert.deepEqual(
    priceSignature("Starter $15/mo, 50 workflow executions/mo, 500+ models"),
    priceSignature("Starter $15/mo, 50 workflow executions/month, 800+ models"),
  );
  /* "$0" and the word "free" are one claim. */
  assert.deepEqual(priceSignature("Free: $0, 25 models"), ["free"]);
  assert.deepEqual(priceSignature("Free tier available"), ["free"]);
  assert.deepEqual(priceSignature("$1.5k/year"), ["$1500"]);
  assert.deepEqual(priceSignature("29 USD per seat"), ["$29"]);
  assert.deepEqual(priceSignature("a 5.5% platform fee"), ["5.5%"]);
  assert.deepEqual(priceSignature(null), []);
});

test("priceMove says which number moved, and says nothing when none did", () => {
  assert.equal(priceMove("Starter $15/mo", "Starter tier is $15 a month"), null, "wording is not a move");
  assert.equal(priceMove("Basic $14/mo", "Basic $19/mo"), "price moved, $14 → $19");
  assert.equal(priceMove("unknown", "Basic $19/mo"), "price published for the first time: $19");
  assert.equal(priceMove("Basic $14/mo", "pricing is not published"), "the published price is gone — it was $14");
  assert.equal(priceMove("$15/mo", "$15/mo, Pro $29/mo"), "price gained $29");
  assert.equal(priceMove("$15/mo, Pro $29/mo", "$15/mo"), "price dropped $29");
});

test("proseOverlap separates a rewrite from a different claim", () => {
  /* The failure this threshold was calibrated against: a sentence that lost a
     leading article did not change what it claims. */
  assert.ok(
    proseOverlap(
      "A fast AI clipper for podcasts and webinars.",
      "Fast AI clipper for podcasts and webinars",
    ) >= 0.6,
  );
  /* And the one it must catch: the same company now selling something else. */
  assert.ok(
    proseOverlap(
      "A managed gateway that routes requests to other providers.",
      "A neocloud selling its own inference hardware to enterprises.",
    ) < 0.6,
  );
});

test("changesBetween records a real move, a first recording, and nothing else", () => {
  const old = known({});

  assert.deepEqual(changesBetween(old, found({}), NOW), [], "the same reading is not a change");

  const reworded = changesBetween(old, found({ pricing: "Free $0; Starter $15 a month; Pro $29 a month" }), NOW);
  assert.deepEqual(reworded, [], "the same prices written differently is not a change");

  const moved = changesBetween(old, found({ pricing: "Free $0; Starter $19/mo; Pro $29/mo" }), NOW);
  assert.equal(moved.length, 1);
  assert.equal(moved[0]?.field, "pricing");
  assert.equal(moved[0]?.note, "price moved, $15 → $19");
  assert.equal(moved[0]?.from, old.pricing);
  assert.equal(moved[0]?.at, NOW);

  const first = changesBetween(known({ pricing: null }), found({}), NOW);
  assert.equal(first[0]?.note, "pricing recorded for the first time");

  /* AN EMPTY ANSWER IS "I DID NOT LOOK", not "it went away". */
  assert.deepEqual(changesBetween(old, found({ pricing: null, positioning: null }), NOW), []);

  const rewritten = changesBetween(
    old,
    found({ positioning: "Enterprise video infrastructure sold to broadcasters by seat." }),
    NOW,
  );
  assert.equal(rewritten.length, 1);
  assert.match(rewritten[0]?.note ?? "", /^positioning rewritten — \d+% of its words are different$/);
});

/* -------------------------------------------------------------- the merge */

test("a re-verified rival keeps its firstSeen and moves its lastVerified", () => {
  const before = [known({})];
  const { rows, touched, counts } = mergeRegistry(before, [found({ pricing: "Starter $19/mo" })], NOW);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.firstSeen, JULY, "first seen never moves — this is the bug the old upsert had");
  assert.equal(rows[0]?.lastVerified, NOW);
  assert.equal(rows[0]?.changes.length, 1);
  assert.deepEqual(counts, { verified: 1, added: 1 - 1, changed: 1, untouched: 0 });
  assert.equal(touched.length, 1);
  /* The row the caller must not touch is not in `touched` at all — the
     guarantee is structural rather than a rule somebody has to remember. */
  assert.equal(touched[0]?.name, "Opus Clip");
});

test("a rival nobody mentioned is kept, with its old date untouched", () => {
  const before = [known({}), known({ name: "Klap", domain: "klap.app", url: "https://klap.app" })];
  const { rows, touched, counts } = mergeRegistry(before, [found({})], NOW);

  assert.equal(rows.length, 2, "silence does not delete");
  const klap = rows.find((r) => r.name === "Klap");
  assert.equal(klap?.lastVerified, JULY, "silence is not verification");
  assert.equal(counts.untouched, 1);
  assert.equal(touched.length, 1);
  assert.ok(!touched.some((t) => t.name === "Klap"));
});

test("a new domain arrives with firstSeen set and no change notes", () => {
  const { rows, counts } = mergeRegistry([], [found({ name: "Vizard", domain: "vizard.ai" })], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.firstSeen, NOW);
  assert.equal(rows[0]?.lastVerified, NOW);
  /* Everything about a rival nobody had heard of is new; twelve notes saying
     so would stand where the first real movement should. */
  assert.deepEqual(rows[0]?.changes, []);
  assert.equal(counts.added, 1);
  assert.equal(counts.changed, 0);
});

test("the merge keys on the domain, so a renamed rival is one row and not two", () => {
  const before = [known({ name: "Vidyo.ai", domain: "quso.ai", url: "https://quso.ai" })];
  const { rows, touched } = mergeRegistry(
    before,
    [found({ name: "Quso.ai", domain: "quso.ai", url: "https://quso.ai" })],
    NOW,
  );
  assert.equal(rows.length, 1, "a rename is a move, not a fork");
  assert.equal(rows[0]?.name, "Quso.ai");
  assert.equal(rows[0]?.firstSeen, JULY, "and it keeps the history it had under the old name");
  assert.equal(touched[0]?.previousName, "Vidyo.ai", "so the caller's UPDATE can find the row it replaces");
});

test("a row with no domain still merges, by its folded name", () => {
  const before = [known({ name: "Opus Clip", domain: null, url: null })];
  const { rows } = mergeRegistry(before, [found({ name: "opus  clip" })], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.domain, "opus.pro", "and it learns the domain it was missing");
});

test("a thin answer does not erase a good row", () => {
  const before = [known({})];
  const { rows } = mergeRegistry(
    before,
    [found({ positioning: null, pricing: null, strengths: [], weaknesses: [] })],
    NOW,
  );
  assert.equal(rows[0]?.positioning, known({}).positioning);
  assert.equal(rows[0]?.pricing, known({}).pricing);
  assert.deepEqual(rows[0]?.strengths, ["virality score"]);
  assert.equal(rows[0]?.lastVerified, NOW, "it was still verified — the sweep just had little to add");
});

test("the same rival listed twice in one answer is one rival", () => {
  const { rows, counts } = mergeRegistry(
    [],
    [found({ name: "Opus Clip" }), found({ name: "Opus Clip (Pro)", pricing: "Starter $99/mo" })],
    NOW,
  );
  assert.equal(rows.length, 1);
  assert.equal(counts.added, 1);
  assert.deepEqual(rows[0]?.changes, [], "and the second entry does not record a change against the first");
});

test("changes are capped at twelve, oldest off the front", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    at: `2026-0${(i % 9) + 1}-01T00:00:00.000Z`,
    field: "pricing" as const,
    from: `$${i}`,
    to: `$${i + 1}`,
    note: `note ${i}`,
  }));
  const { rows } = mergeRegistry([known({ changes: many })], [found({ pricing: "Starter $99/mo" })], NOW);
  assert.equal(rows[0]?.changes.length, 12);
  assert.equal(rows[0]?.changes[0]?.note, "note 1", "the oldest fell off");
  assert.equal(rows[0]?.changes[11]?.at, NOW, "and tonight's is on the end");
});

test("mergeSources puts tonight's pages first and caps at six", () => {
  assert.deepEqual(mergeSources(["https://a", "https://b"], ["https://c", "https://a"]), [
    "https://c",
    "https://a",
    "https://b",
  ]);
  assert.equal(mergeSources([], Array.from({ length: 20 }, (_, i) => `https://p${i}`)).length, 6);
});

/* ------------------------------------------------------------- the answer */

const ANSWER = {
  competitors: [
    {
      name: "Opus Clip",
      domain: "opus.pro",
      url: "https://opus.pro/pricing",
      positioning: "AI clipper.",
      pricing: "Starter $15/mo",
      strengths: ["virality score"],
      weaknesses: ["web only"],
      sources: ["https://opus.pro/pricing", "https://opus.pro"],
    },
  ],
  focusDone: [{ title: "Check whether Klap still charges $14", note: "It is $19 now." }],
  focusNext: [{ title: "Find out what Vizard's enterprise tier costs", detail: "Not on the public page." }],
  cards: [{ title: "Match Opus Clip's free tier", body: "…", urgency: 2 }],
};

test("readAnswer digs the object out of whatever the model wrapped it in", () => {
  const bare = readAnswer(JSON.stringify(ANSWER));
  assert.ok(bare);
  assert.equal(bare.answer.competitors.length, 1);
  assert.equal(bare.answer.focusDone.length, 1);
  assert.equal(bare.answer.focusNext.length, 1);
  assert.equal(bare.answer.cards.length, 1);

  const fenced = readAnswer("```json\n" + JSON.stringify(ANSWER) + "\n```");
  assert.equal(fenced?.answer.competitors[0]?.name, "Opus Clip");

  const chatty = readAnswer(`Here is what I found.\n\n${JSON.stringify(ANSWER)}\n\nLet me know.`);
  assert.equal(chatty?.answer.competitors[0]?.domain, "opus.pro");

  assert.equal(readAnswer("I could not find anything useful tonight."), null);
  assert.equal(readAnswer(""), null);
});

test("readAnswer's brace scan survives a closing brace inside a string", () => {
  const tricky = {
    ...ANSWER,
    competitors: [{ ...ANSWER.competitors[0], positioning: 'Charges "{price} per seat}" on request.' }],
  };
  const parsed = readAnswer(`Here you go:\n${JSON.stringify(tricky)}`);
  assert.equal(parsed?.answer.competitors.length, 1, "a lazy regex would have truncated this");
  assert.match(parsed?.answer.competitors[0]?.positioning ?? "", /per seat/);
});

test("a rival with no https source is dropped and said so", () => {
  const parsed = readAnswer(
    JSON.stringify({
      ...ANSWER,
      competitors: [
        ...ANSWER.competitors,
        { name: "Ghostly AI", domain: "ghostly.ai", url: null, positioning: "Something plausible.", sources: [] },
        { name: "Insecure Co", url: "http://insecure.example", sources: ["http://insecure.example"] },
      ],
    }),
  );
  assert.equal(parsed?.answer.competitors.length, 1, "only the sourced one survives");
  assert.deepEqual(parsed?.dropped, ["Ghostly AI", "Insecure Co"]);
});

test("readAnswer derives a domain from the url when the model forgot the field", () => {
  const parsed = readAnswer(
    JSON.stringify({
      competitors: [{ name: "Klap", url: "https://www.klap.app/pricing", sources: ["https://www.klap.app/pricing"] }],
    }),
  );
  assert.equal(parsed?.answer.competitors[0]?.domain, "klap.app");
  assert.deepEqual(parsed?.answer.focusDone, [], "and the missing lists are empty rather than absent");
  assert.deepEqual(parsed?.answer.cards, []);
});

test("a focusDone entry with no note still closes the item", () => {
  const parsed = readAnswer(JSON.stringify({ competitors: [], focusDone: [{ title: "Check Klap" }] }));
  assert.equal(parsed?.answer.focusDone[0]?.title, "Check Klap");
  assert.match(parsed?.answer.focusDone[0]?.note ?? "", /nothing was written down/);
});

/* --------------------------------------------------------------- the ages */

test("daysSince counts whole days and never goes negative", () => {
  const from = new Date("2026-09-07T12:00:00.000Z");
  assert.equal(daysSince("2026-09-07T00:00:00.000Z", from), 0);
  assert.equal(daysSince("2026-09-06T00:00:00.000Z", from), 1);
  assert.equal(daysSince("2026-08-08T12:00:00.000Z", from), 30);
  assert.equal(daysSince("2026-09-08T12:00:00.000Z", from), 0, "a clock that ran backwards is not negative days");
  assert.equal(daysSince(null, from), null);
  assert.equal(daysSince("not a date", from), null);
});
