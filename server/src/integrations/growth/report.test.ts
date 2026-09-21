import assert from "node:assert/strict";
import { test } from "node:test";
import { db, now, ventureRowById } from "../../db.ts";
import { looksLikeHtmlReport, splitTrailingFence } from "../runs/html.ts";
import { fileRunCards } from "../runs/cards.ts";
import { cardsFence, readAnalysis, type Analysis } from "./report.ts";
import { serpDocument, type SerpRow } from "./serp.ts";
import { asoDocument } from "./aso.ts";
import type { PageStructure } from "./pages.ts";

function venture(slug: string) {
  const id = `v-${slug}`;
  db.prepare(
    "INSERT INTO ventures(id,slug,name,description,website,host,stage,color,color_source,created_at,updated_at,position,brand) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(id, slug, "PlanIntel", "PlanIntel is a planning permission search for Ireland", "https://planintel.ie", "planintel.ie", "launched", "#123456", "owner", now(), now(), 0, "{}");
  return ventureRowById(id)!;
}

function pageOf(url: string, words: number, extra: Partial<PageStructure> = {}): PageStructure {
  return {
    url, domain: null, title: `Title of ${url}`, description: null, h1: ["h1"], h2: ["a", "b"], h3Count: 3, words,
    internalLinks: 10, externalLinks: 2, images: 4, schema: ["FAQPage"], faq: true, table: false, comparison: false,
    chars: words * 6, thin: false, error: null, ...extra,
  } as PageStructure;
}

const ANALYSIS: Analysis = {
  headline: "The pages above us all carry an FAQ block and ours does not",
  verdict: "Every page that outranks planintel.ie for its striking-distance query has an FAQ; ours has **none**.",
  sections: [{ title: "They answer the question on the page; we link to it", paragraphs: ["Three of four pages read carry FAQPage schema.", "Ours has 412 words to their median 1,900."] }],
  recommendations: [{ title: "Add an FAQ block to /planning-permission", why: "3 of 4 pages read carry one", cost: "an afternoon", change: "the FAQ marker on our row" }],
  cards: [{ title: "Write the FAQ", body: "Six questions people ask about planning permission, on the page.", urgency: 2 }],
  failed: null,
};

test("the analysis block is read strictly: the shape asked for, or a stated failure", () => {
  const good = readAnalysis("```json report\n" + JSON.stringify({ headline: "H", verdict: "V", sections: [{ title: "S", paragraphs: ["p"] }, { title: "no paragraphs" }], recommendations: [{ title: "R", why: "w" }, { why: "no title" }], cards: [{ title: "C", body: "b", urgency: 9 }, { title: "no body" }] }) + "\n```");
  assert.equal(good.failed, null);
  assert.equal(good.sections.length, 1, "a section without paragraphs is dropped");
  assert.equal(good.recommendations.length, 1, "a recommendation without a title is dropped");
  assert.deepEqual(good.cards, [{ title: "C", body: "b", urgency: 3 }], "urgency is clamped and a card without a body is dropped");
  const prose = readAnalysis("I think the pages above are longer.");
  assert.match(prose.failed!, /did not answer with the report block/);
  const empty = readAnalysis("```json report\n{}\n```");
  assert.match(empty.failed!, /nothing usable/);
});

test("the SERP teardown is one designed HTML document with the measured tables, the analysis and the cards fence after it", () => {
  const v = venture("serp-page");
  const rows: SerpRow[] = [
    {
      query: "planning permission search", source: "gsc", gscPosition: 7.4, gscImpressions: 120, ourRank: 3, ourUrl: "https://planintel.ie/search",
      ours: pageOf("https://planintel.ie/search", 412, { faq: false, schema: [] }),
      competitors: [pageOf("https://www.gov.ie/planning", 1900), pageOf("https://example.org/blocked", 0, { error: "403 from a firewall" })],
      relevance: 0.8, degraded: false, unmeasurable: null, refused: [{ engine: "google", reason: "CAPTCHA" }],
      gaps: [{ field: "words", what: "readable words on the page", ours: 412, theirs: 1900, of: 1 }],
      error: null,
    },
    { query: "will they let me build it", source: "description", gscPosition: null, gscImpressions: null, ourRank: null, ourUrl: null, ours: null, competitors: [], relevance: 0.1, degraded: true, unmeasurable: null, refused: [], gaps: [], error: null },
    { query: "x", source: "typed", gscPosition: null, gscImpressions: null, ourRank: null, ourUrl: null, ours: null, competitors: [], relevance: null, degraded: false, unmeasurable: null, refused: [], gaps: [], error: "the node was down" },
  ];
  const out = serpDocument(v, rows, ANALYSIS, "2026-09-21T10:00:00.000Z") + cardsFence(ANALYSIS.cards);
  const { doc, tail } = splitTrailingFence(out);
  assert.ok(looksLikeHtmlReport(doc), "the page is an HTML report the client frames");
  assert.match(doc, /<title>The pages above us all carry an FAQ block and ours does not<\/title>/, "the title is the finding");
  assert.match(doc, /<h1>The pages above us all carry an FAQ block/);
  assert.match(doc, /SERP teardown · PlanIntel · 3 queries · 2026-09-21/, "the dateline");
  assert.match(doc, /<p class="verdict">Every page that outranks planintel\.ie[^<]*<strong>none<\/strong>\./, "the verdict is under the header with bold honoured");
  assert.match(doc, /<td class="num">#3<\/td>/, "our rank is in the summary table");
  assert.match(doc, /<td class="num">7\.4<\/td>/, "Google's position is printed as measured");
  assert.match(doc, /degraded \(0\.1\)/, "a degraded query says so");
  assert.match(doc, /search failed/, "a failed search says so");
  assert.match(doc, /<tr class="ours"><td><a href="https:\/\/planintel\.ie\/search"[^>]*>planintel\.ie<\/a>/, "our page is the highlighted row, linked by host");
  assert.match(doc, /not read — 403 from a firewall/, "a blocked page is not counted as short");
  assert.match(doc, /<td class="num warn">412<\/td><td class="num">1900<\/td>/, "the gap table marks where we are behind");
  assert.match(doc, /google \(CAPTCHA\)/, "refused engines are named");
  assert.match(doc, /<span class="badge badge-warn">description<\/span>/, "a derived query is flagged");
  assert.match(doc, /<h2>They answer the question on the page; we link to it<\/h2>/, "the analysis sections are the model's headings");
  assert.match(doc, /<ol class="recs">[\s\S]*Add an FAQ block to \/planning-permission/, "the recommendations are a ranked list");
  assert.match(doc, /<footer>Written 2026-09-21 from 2 pages this server read and 2 searches/);
  assert.doesNotMatch(doc, /<script/i);
  assert.match(tail, /```json cards/, "the cards fence sits after the document");

  /* The cards file into the board the same way every other kind's do. */
  db.prepare("INSERT INTO agent_runs(id,kind,venture_id,title,input,status,queued_at,output) VALUES(?,?,?,?,?,?,?,?)").run("r-serp-page", "serp", v.id, "t", "{}", "done", now(), out);
  const filed = fileRunCards("r-serp-page");
  assert.equal(filed.total, 1);
});

test("a SERP teardown whose analysis failed still carries every measurement and says the model did not answer", () => {
  const v = venture("serp-noanalysis");
  const rows: SerpRow[] = [
    { query: "planning permission search", source: "gsc", gscPosition: 7.4, gscImpressions: 120, ourRank: null, ourUrl: null, ours: pageOf("https://planintel.ie/", 300), competitors: [pageOf("https://www.gov.ie/planning", 1900)], relevance: 0.8, degraded: false, unmeasurable: null, refused: [], gaps: [], error: null },
  ];
  const doc = serpDocument(v, rows, { headline: null, verdict: null, sections: [], recommendations: [], cards: [], failed: "the model did not answer with the report block it was asked for" }, "2026-09-21T10:00:00.000Z");
  assert.ok(looksLikeHtmlReport(doc));
  assert.match(doc, /<h1>PlanIntel is in the results for 0 of 1 query torn down<\/h1>/, "a computed finding stands in for the model's");
  assert.match(doc, /ours · front page — not in these results/, "the front-page comparison is labelled");
  assert.match(doc, /the model did not answer with the report block[\s\S]*The measurement above is unaffected/);
  assert.doesNotMatch(doc, /<ol class="recs">/);
});

test("the store-listing audit is one designed HTML document with the score's arithmetic, every check, the rivals and the analysis", () => {
  const v = venture("aso-page");
  const audited = [
    {
      ref: { store: "appstore" as const, appId: "123", name: "PlanIntel", storefront: "ie" },
      listing: { store: "appstore" as const, appId: "123", name: "PlanIntel — planning search", subtitle: null, description: "d", descriptionChars: 1200, screenshots: 5, rating: 4.6, ratingCount: 31, ratingFrom: "lookup", updatedAt: "2026-08-01", version: "2.1", genres: ["Utilities"], url: "https://apps.apple.com/ie/app/id123", notes: ["Apple's lookup document carries no subtitle, so the subtitle check was not answered."], error: null },
      checks: [
        { id: "title-length", dim: "metadata", result: "pass" as const, detail: "27 characters of 30" },
        { id: "subtitle", dim: "metadata", result: null, detail: "not in the lookup document" },
        { id: "screenshots", dim: "creative", result: "warn" as const, detail: "5 of the 10 allowed" },
      ],
      scored: { score: 71, grade: "B", coverage: 0.8, refusal: null, dimensions: { metadata: { weight: 0.5, score: 100, coverage: 0.5, reason: null }, creative: { weight: 0.5, score: 50, coverage: 1, reason: null } }, arithmetic: ["metadata: 1 of 1 answered → 100", "creative: 0.5 of 1 → 50", "weighted 0.5×100 + 0.5×50 = 75 → 71 after coverage"] },
      rivals: [{ name: "Rival Planner", url: "https://apps.apple.com/ie/app/id999", store: "appstore", screenshots: 10, descriptionChars: 3000, rating: 4.8, titleChars: 29, note: null }],
      rivalNote: "Two rivals were read from the same storefront.",
    },
    {
      ref: { store: "play" as const, appId: "ie.planintel", name: "PlanIntel", storefront: null },
      listing: { store: "play" as const, appId: "ie.planintel", name: null, subtitle: null, description: null, descriptionChars: null, screenshots: null, rating: null, ratingCount: null, ratingFrom: null, updatedAt: null, version: null, genres: [], url: null, notes: [], error: "the Play page answered 404" },
      checks: [],
      scored: { score: null, grade: null, coverage: 0, refusal: "nothing read", dimensions: {}, arithmetic: [] },
      rivals: [],
      rivalNote: "The listing could not be read, so no comparison was made.",
    },
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = asoDocument(v, audited as any, { ...ANALYSIS, headline: null }, "2026-09-21T10:00:00.000Z");
  assert.ok(looksLikeHtmlReport(doc));
  assert.match(doc, /<h1>PlanIntel — planning search on the App Store scores 71 \(B\) on this app's rubric<\/h1>/, "the computed finding names the one listing that was read");
  assert.match(doc, /Store listing audit · PlanIntel · 2 listings · 2026-09-21/);
  assert.match(doc, /<div class="big">71<span class="of"> B<\/span><\/div>/, "the score is the big number");
  assert.match(doc, /weighted 0\.5×100 \+ 0\.5×50 = 75 → 71 after coverage/, "the arithmetic is printed in full");
  assert.match(doc, /<td>subtitle<\/td><td><span class="nul">not scored<\/span><\/td><td>not in the lookup document<\/td>/, "an unanswered check is not scored");
  assert.match(doc, /<span class="warn">warn<\/span><\/td><td>5 of the 10 allowed/);
  assert.match(doc, /Apple's lookup document carries no subtitle/, "what could not be read is part of the reading");
  assert.match(doc, /<a href="https:\/\/apps\.apple\.com\/ie\/app\/id999"[^>]*>apps\.apple\.com<\/a> Rival Planner<\/td><td>appstore<\/td><td class="num">29<\/td><td class="num">10<\/td>/, "rivals are read the same way");
  assert.match(doc, /The listing could not be read: the Play page answered 404/);
  assert.match(doc, /<h2>They answer the question on the page; we link to it<\/h2>/);
  assert.match(doc, /<footer>Written 2026-09-21 from 1 listing this server read and 1 rival listings/);
  assert.doesNotMatch(doc, /<script/i);
});
