import assert from "node:assert/strict";
import { test } from "node:test";
import { compactNumber, parsePlayPage, runChecks, type Listing } from "./aso.ts";

/**
 * A PLAY PAGE, REDUCED TO ITS ANCHORS. The shape of each fragment is the one
 * the live page had on 2026-09-21 (see `parsePlayPage`'s header), with the
 * noise the real page carries around them — a similar-app card with its own
 * star and thumbnail — kept in, because the whole point of the anchors is
 * that the noise is not read.
 */
const PAGE = `<!doctype html><html><head>
<meta property="og:title" content="Acme Planner: Build &amp; Plan - Apps on Google Play">
</head><body>
<div class="similar"><img alt="Icon image" src="x"><img alt="Thumbnail image" src="y"><div>4.9</div><div>12K reviews</div></div>
<div itemprop="starRating"><div class="jILTFe">4.3</div><div aria-label="Rated 4.3 stars out of five stars"></div><div class="g1rdde">1.2K reviews</div></div>
<div class="ClM7O">500+</div><div class="g1rdde">Downloads</div>
<span itemprop="genre"><a href="/cat">Productivity</a></span>
<div class="bARER" data-g-id="description" inert>Acme Planner brings your plans together.<br><br>Plan &amp; build in one place &#39;fast&#39;.<br>Second paragraph.</div>
<div><img alt="Screenshot image" src="a"><img alt="Screenshot image" src="b"><img alt="Screenshot image" src="c"></div>
<div class="lXlx5">Updated on</div><div class="xg1aie">Sep 17, 2026</div>
<span>In-app purchases</span>
</body></html>`;

test("the Play page is read at its anchors and nothing else", () => {
  const p = parsePlayPage(PAGE);
  assert.equal(p.name, "Acme Planner: Build & Plan", "the og:title without Play's suffix, entities decoded");
  assert.equal(p.description, "Acme Planner brings your plans together.\n\nPlan & build in one place 'fast'.\nSecond paragraph.", "the description div, <br> as newlines, entities decoded");
  assert.equal(p.screenshots, 3, "only the images whose alt is 'Screenshot image' — not the similar-app icon or thumbnail");
  assert.equal(p.updatedAt, "2026-09-17", "the 'Updated on' value as an ISO date");
  assert.equal(p.rating, 4.3, "the star block's own average, not the similar-app card's 4.9");
  assert.equal(p.ratingCount, 1200, "the reviews count beside that star, not the card's 12K");
  assert.equal(p.downloads, "500+");
  assert.equal(p.genre, "Productivity");
  assert.equal(p.inAppPurchases, true);
  assert.equal(p.containsAds, false);
});

test("a page with no star block yields null rating and count, never zero", () => {
  const p = parsePlayPage(PAGE.replace(/<div itemprop="starRating">[\s\S]*?reviews<\/div><\/div>/, ""));
  assert.equal(p.rating, null);
  assert.equal(p.ratingCount, null);
  assert.equal(p.screenshots, 3, "the rest of the page still reads");
});

test("compact review counts read as numbers", () => {
  assert.equal(compactNumber("244M"), 244_000_000);
  assert.equal(compactNumber("1.2K"), 1200);
  assert.equal(compactNumber("37"), 37);
  assert.equal(compactNumber("1,204"), 1204);
  assert.equal(compactNumber("lots"), null);
  assert.equal(compactNumber(null), null);
});

test("a Play listing read at its anchors is scored on visuals, description and freshness, with what has no anchor left unscored", () => {
  const p = parsePlayPage(PAGE);
  const listing: Listing = {
    store: "play", appId: "com.acme.planner", name: p.name, subtitle: null, description: p.description,
    descriptionChars: p.description!.length, screenshots: p.screenshots, rating: p.rating, ratingCount: p.ratingCount,
    ratingFrom: "the star shown on the Play page", updatedAt: p.updatedAt, version: null, genres: ["Productivity"],
    url: "https://play.google.com/store/apps/details?id=com.acme.planner", notes: [], error: null,
  };
  const by = Object.fromEntries(runChecks(listing).map((c) => [c.id, c]));
  assert.equal(by["screenshot-count"]!.result, "warn", "3 screenshots: under the floor of 5, not under 3");
  assert.equal(by["screenshot-depth"]!.result, "fail");
  assert.equal(by["title-length"]!.result, "pass");
  assert.equal(by["description-present"]!.result, "pass");
  assert.equal(by["description-length"]!.result, "fail", "under 500 characters on Play, where the description is indexed");
  assert.match(by["description-length"]!.detail, /Play INDEXES this field/);
  assert.equal(by["rating-level"]!.result, "pass", "4.3 from the page's star");
  assert.equal(by["rating-volume"]!.result, "pass", "1,200 ratings");
  assert.equal(by["subtitle-present"]!.result, null, "the short description has no anchor and stays unscored");
  assert.match(by["subtitle-present"]!.detail, /no anchor/);
  assert.equal(typeof by["freshness"]!.result, "string", "an update date makes freshness scorable");
});
