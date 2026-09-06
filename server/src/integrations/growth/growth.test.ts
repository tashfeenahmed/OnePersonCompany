/**
 * The pure half of the growth area, asserted without a database.
 *
 * WHAT IS TESTED HERE AND WHAT IS NOT. Everything in `pages.ts` is a pure
 * function over a string — the relevance self-check, the HTML reader and the
 * gap arithmetic — and every one of them is a place a quiet mistake would
 * become a confident sentence in a report. The registrable domain moved to
 * `shared/host.ts` and is asserted there, once, for every area that folds a
 * hostname. The library is
 * data, and the things that can go wrong with data are duplicate ids and a
 * stage nobody buckets anything under, so both are asserted.
 *
 * The rest of the area — authority, CRO, indexing, ASO, ads — reads rows, and
 * a test of those would have to open the live database beside a running server.
 * They are verified against the real box instead, and the evidence is in
 * README's Growth section.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStructure, gapsAgainst, median, relevance, tokens, unmeasurable } from "./pages.ts";
import { EXPERIMENTS, STAGES, forStage } from "./cro-library.ts";
import { fortnight, type DayRow } from "./ads.ts";

test("tokens drop stop words and short words", () => {
  assert.deepEqual(tokens("What is the planning permission search"), ["planning", "permission", "search"]);
});

test("a search that answered the question is not degraded", () => {
  const results = [
    { title: "Planning permission search Ireland", content: "search planning applications" },
    { title: "Find a planning application", content: "permission" },
  ];
  const r = relevance("planning permission search ireland", results);
  assert.equal(r.degraded, false);
  assert.equal(r.of, 4);
});

test("a search that answered something else is degraded", () => {
  const results = [{ title: "Free browser games", content: "play now" }];
  const r = relevance("planning permission search ireland", results);
  assert.equal(r.degraded, true);
  assert.equal(r.matched, 0);
});

test("a query of nothing but stop words is unmeasurable rather than degraded", () => {
  assert.deepEqual(relevance("what is the", []), { ratio: null, degraded: false, matched: 0, of: 0 });
  assert.match(unmeasurable("what is the") ?? "", /stop word/);
});

test("one countable word cannot be checked, and an identifier says so", () => {
  assert.match(unmeasurable("acmeproduct") ?? "", /single word/);
  assert.match(unmeasurable("d14a5r2") ?? "", /identifier/);
  assert.equal(unmeasurable("planning permission ireland"), null);
});

test("the HTML reader counts what a search engine sees", () => {
  const html = `<html><head><title>A vs B — the comparison</title>
    <meta name="description" content="Which one to pick">
    <script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question"}]}</script>
    </head><body><h1>A vs B</h1><h2>Price</h2><h2>Speed</h2><h3>Detail</h3>
    <table><tr><td>x</td></tr></table>
    <a href="/inside">one</a><a href="https://example.com/inside">two</a>
    <a href="https://other.test/out">three</a><img src="a.png">
    <p>${"word ".repeat(200)}</p></body></html>`;
  const s = extractStructure(html, "https://example.com/page");
  assert.equal(s.title, "A vs B — the comparison");
  assert.equal(s.description, "Which one to pick");
  assert.deepEqual(s.h2, ["Price", "Speed"]);
  assert.equal(s.h3Count, 1);
  assert.equal(s.internalLinks, 2, "a same-host absolute link is internal");
  assert.equal(s.externalLinks, 1);
  assert.equal(s.images, 1);
  assert.equal(s.table, true);
  assert.equal(s.faq, true);
  assert.equal(s.comparison, true);
  assert.deepEqual(s.schema, ["FAQPage", "Question"]);
  assert.equal(s.thin, false);
});

test("a page with almost no text is thin and is left out of every median", () => {
  const thin = extractStructure("<html><body>Checking your browser</body></html>", "https://wall.test/");
  assert.equal(thin.thin, true);
  const fat = (words: number, url: string) => extractStructure(`<html><body><p>${"word ".repeat(words)}</p></body></html>`, url);
  const gaps = gapsAgainst(fat(100, "https://ours.test/"), [thin, fat(300, "https://a.test/"), fat(500, "https://b.test/")]);
  const words = gaps.find((g) => g.field === "words")!;
  assert.equal(words.of, 2, "the thin page is out of the denominator");
  assert.equal(words.theirs, 400, "the median of the two pages that were read");
  assert.equal(words.ours, 100);
});

test("a failed page contributes nothing and ours can be null", () => {
  const gaps = gapsAgainst(null, []);
  assert.equal(gaps.every((g) => g.ours === null && g.theirs === null), true, "no page read is null everywhere, never zero");
});

test("median is a median and never a mean", () => {
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 100]), 2.5);
  assert.equal(median([]), null);
});

test("the experiment library has unique ids and every stage is bucketed", () => {
  const ids = new Set(EXPERIMENTS.map((e) => e.id));
  assert.equal(ids.size, EXPERIMENTS.length, "two experiments share an id");
  for (const stage of STAGES) assert.ok(forStage(stage.id).length > 0, `${stage.id} has no experiments`);
  for (const e of EXPERIMENTS) {
    assert.ok(STAGES.some((s) => s.id === e.stage), `${e.id} is in a stage nothing knows about`);
    assert.ok(e.rank >= 1 && e.rank <= 7, `${e.id} has a rank outside the seven dimensions`);
    assert.ok(e.hypothesis && e.change && e.measure && e.effort, `${e.id} is missing one of its four fields`);
  }
});

test("a stage's bucket comes back biggest lever first", () => {
  const ranks = forStage("landing").map((e) => e.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

/* --------------------------------------------------- the two matched weeks */

/**
 * The failure this guards: an advertising platform writes no daily row for a
 * day with no delivery, so cutting the fortnight by ROW COUNT let a paused
 * weekend drag "last week" ten days back — two windows of seven rows each,
 * neither of them a week, while the fatigue verdict next door was comparing
 * the platform's own two explicit weeks. The two could then disagree over what
 * both called the same fortnight.
 */
const day = (d: string, impressions: number, clicks: number): DayRow => ({
  day: d,
  spend: 10,
  impressions,
  clicks,
  leads: null,
});

test("the fortnight is cut by date, so a gap shortens a week instead of sliding it", () => {
  /* Fourteen consecutive days: the halves are 7 and 7. */
  const full = Array.from({ length: 14 }, (_, i) =>
    day(`2026-09-${String(i + 1).padStart(2, "0")}`, 1000, 10),
  );
  const a = fortnight(full);
  assert.equal(a.recent.days, 7);
  assert.equal(a.prior.days, 7);

  /* Three days of the recent week are missing. The recent half must be four
     days long — NOT seven days reaching back into the earlier week. */
  const gapped = full.filter((r) => !["2026-09-09", "2026-09-10", "2026-09-11"].includes(r.day));
  const b = fortnight(gapped);
  assert.equal(b.recent.days, 4);
  assert.equal(b.prior.days, 7);
  /* And nothing from the earlier week has been counted twice. */
  assert.equal(b.recent.impressions + b.prior.impressions, 11_000);
});

test("a fortnight with no rows at all is two empty weeks, not a crash", () => {
  const empty = fortnight([]);
  assert.equal(empty.recent.days, 0);
  assert.equal(empty.recent.ctr, null);
  assert.equal(empty.prior.ctr, null);
});
