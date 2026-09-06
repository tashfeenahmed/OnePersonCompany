/**
 * The three pieces of this area that are pure arithmetic or pure rules, and
 * are therefore the three that can be wrong silently: the baseline delta
 * maths, the validators that stand between a model and the database, and the
 * forward-only rule the directory ledger's whole credibility rests on.
 *
 * Nothing here touches Search Console, a browser or a model. That is the point
 * — a rule table whose behaviour can only be observed by waiting a fortnight
 * for a page to move is a rule table nobody checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FLAT_BAND_PCT,
  MIN_BASELINE_IMPRESSIONS,
  deltas,
  diagnose,
  expectedCtr,
  pct,
  validateModelDiagnosis,
  type Side,
} from "./diagnose.ts";
import { detectionMay } from "./listings.ts";
import { safeAssetUrl, safeCount, safeFontName, safeHex, shapeReading, validateRaw } from "./brand.ts";
import { imageTokens, pngSize } from "./vision.ts";
import { isInternalHost, normaliseWebsite } from "../../ventures/enrich.ts";
import { reachableOffsets, type BaselineRow } from "./followup.ts";
import { validateVisionAnswer } from "./vision.ts";
import { parseOffsets, parseVentureList, sameHost, hostOf } from "./settings.ts";
import { resolveProperty } from "./gsc.ts";
import { tagged, urlsIn } from "./followup.ts";

const side = (over: Partial<Side> = {}): Side => ({
  measured: true,
  clicks: 100,
  impressions: 1000,
  ctr: 10,
  position: 5,
  siteImpressions: 50_000,
  ...over,
});

const unmeasured: Side = {
  measured: false,
  clicks: null,
  impressions: null,
  ctr: null,
  position: null,
  siteImpressions: null,
};

/* ------------------------------------------------------- the delta maths */

test("pct is null when the base is zero rather than Infinity", () => {
  assert.equal(pct(50, 0), null);
  assert.equal(pct(50, null), null);
  assert.equal(pct(null, 50), null);
  assert.equal(pct(150, 100), 50);
  assert.equal(pct(50, 100), -50);
});

test("deltas are all null when either side was not measured", () => {
  const d = deltas(unmeasured, side());
  assert.equal(d.clicks, null);
  assert.equal(d.clicksPct, null);
  assert.equal(d.impressions, null);
  assert.equal(d.impressionsPct, null);
  assert.equal(d.position, null);
  assert.equal(d.siteImpressionsPct, null);

  const other = deltas(side(), unmeasured);
  assert.equal(other.clicks, null);
  assert.equal(other.impressionsPct, null);
});

test("deltas subtract in the right direction and keep position as a rank", () => {
  const before = side({ clicks: 100, impressions: 1000, ctr: 10, position: 8 });
  const after = side({ clicks: 150, impressions: 1200, ctr: 12.5, position: 5.5 });
  const d = deltas(before, after);
  assert.equal(d.clicks, 50);
  assert.equal(d.clicksPct, 50);
  assert.equal(d.impressions, 200);
  assert.equal(d.impressionsPct, 20);
  assert.equal(d.ctr, 2.5);
  /* NEGATIVE is an improvement: 8th to 5.5th is -2.5. */
  assert.equal(d.position, -2.5);
});

test("a zero before with a positive after keeps the delta and drops the percentage", () => {
  const d = deltas(side({ clicks: 0, impressions: 0 }), side({ clicks: 12, impressions: 400 }));
  assert.equal(d.clicks, 12);
  assert.equal(d.clicksPct, null);
  assert.equal(d.impressions, 400);
  assert.equal(d.impressionsPct, null);
});

/* ------------------------------------------------------- the rule table */

test("an unmeasured side is `unmeasured`, never a fall to zero", () => {
  const j = diagnose(side(), unmeasured);
  assert.equal(j.verdict, "unmeasured");
  assert.equal(j.rule, 1);
  assert.equal(j.delta.clicksPct, null);

  const other = diagnose(unmeasured, side({ clicks: 0, impressions: 0 }));
  assert.equal(other.verdict, "unmeasured");
});

test("a thin before-window is `thin` and not a movement", () => {
  const before = side({ clicks: 1, impressions: MIN_BASELINE_IMPRESSIONS - 1 });
  const after = side({ clicks: 4, impressions: 90 });
  const j = diagnose(before, after);
  assert.equal(j.verdict, "thin");
  assert.equal(j.rule, 2);
});

test("clicks up beyond the band from the top three with a normal CTR is up/conversion", () => {
  const before = side({ clicks: 100, impressions: 1000, position: 2, ctr: 10 });
  const after = side({ clicks: 200, impressions: 1200, position: 2, ctr: 16.7 });
  const j = diagnose(before, after);
  assert.equal(j.verdict, "up");
  assert.equal(j.diagnosis, "conversion");
  assert.equal(j.rule, 3);
});

test("clicks up beyond the band from deeper down is up/wait", () => {
  const j = diagnose(side({ clicks: 100, position: 14 }), side({ clicks: 200, position: 12, ctr: 12 }));
  assert.equal(j.verdict, "up");
  assert.equal(j.diagnosis, "wait");
  assert.equal(j.rule, 4);
});

test("a page that fell with its whole property is down/demand, not a page problem", () => {
  const before = side({ impressions: 1000, clicks: 100, siteImpressions: 100_000 });
  const after = side({ impressions: 600, clicks: 60, siteImpressions: 60_000 });
  const j = diagnose(before, after);
  assert.equal(j.verdict, "down");
  assert.equal(j.diagnosis, "demand");
  assert.equal(j.rule, 5);
});

test("a page that fell while its property held is down/ranking", () => {
  const before = side({ impressions: 1000, clicks: 100, siteImpressions: 100_000 });
  const after = side({ impressions: 600, clicks: 60, siteImpressions: 101_000 });
  const j = diagnose(before, after);
  assert.equal(j.verdict, "down");
  assert.equal(j.diagnosis, "ranking");
  assert.equal(j.rule, 6);
});

test("shown for much more and clicked no more, at the same rank, is flat/intent", () => {
  const before = side({ impressions: 1000, clicks: 100, position: 6 });
  const after = side({ impressions: 1300, clicks: 103, position: 6.2, ctr: 7.9 });
  const j = diagnose(before, after);
  assert.equal(j.verdict, "flat");
  assert.equal(j.diagnosis, "intent");
  assert.equal(j.rule, 7);
});

test("nothing moved and it sits on page two is flat/content", () => {
  const before = side({ clicks: 100, impressions: 1000, position: 15, ctr: 10 });
  const after = side({ clicks: 101, impressions: 1010, position: 15, ctr: 10 });
  const j = diagnose(before, after);
  assert.equal(j.verdict, "flat");
  assert.equal(j.diagnosis, "content");
  assert.equal(j.rule, 14);
});

test("the table always answers, and every answer carries its next action", () => {
  const j = diagnose(side({ position: 40, ctr: 0.2, clicks: 2, impressions: 1000 }), side({ position: 40, ctr: 0.2, clicks: 2, impressions: 1000 }));
  assert.ok(j.rule > 0);
  assert.ok(j.next.length > 20);
});

test("the flat band is the same number the generic outcomes use", () => {
  assert.equal(FLAT_BAND_PCT, 10);
});

test("the expected-CTR curve falls monotonically with position", () => {
  const points = [1, 2, 3, 5, 10, 20, 40].map((p) => expectedCtr(p)!);
  for (let i = 1; i < points.length; i++) assert.ok(points[i]! <= points[i - 1]!);
  assert.equal(expectedCtr(null), null);
});

/* ------------------------------------------- the model diagnosis validator */

test("a diagnosis outside the closed list is thrown away whole", () => {
  const out = validateModelDiagnosis('{"diagnosis":"vibes","why":"clicks fell 40% over 28 days"}');
  assert.ok("unreadable" in out);
});

test("a diagnosis with no reasoning, or reasoning with no figure, is refused", () => {
  assert.ok("unreadable" in validateModelDiagnosis('{"diagnosis":"ranking","why":"bad"}'));
  assert.ok(
    "unreadable" in
      validateModelDiagnosis('{"diagnosis":"ranking","why":"the page seems to have lost some ground lately"}'),
  );
});

test("a good diagnosis survives, fences and surrounding prose included", () => {
  const out = validateModelDiagnosis(
    'Here you go:\n```json\n{"diagnosis":"snippet","why":"impressions rose 22% while clicks moved 1% at position 6"}\n```',
  );
  assert.ok(!("unreadable" in out));
  if (!("unreadable" in out)) {
    assert.equal(out.diagnosis, "snippet");
    assert.match(out.why, /22%/);
  }
});

test("a non-object answer is refused rather than coerced", () => {
  assert.ok("unreadable" in validateModelDiagnosis("ranking"));
  assert.ok("unreadable" in validateModelDiagnosis(null));
  assert.ok("unreadable" in validateModelDiagnosis(["ranking"]));
});

/* --------------------------------------------- the vision result validator */

test("a verdict outside ok/broken/unsure is thrown away whole", () => {
  assert.ok("unreadable" in validateVisionAnswer('{"verdict":"suspicious","issues":[]}'));
  assert.ok("unreadable" in validateVisionAnswer('{"verdict":"","issues":[]}'));
});

test("`broken` with no surviving issue is refused — the rule the contract exists for", () => {
  assert.ok("unreadable" in validateVisionAnswer('{"verdict":"broken","issues":[]}'));
  /* An issue that is dropped by validation must not leave a bare `broken`. */
  assert.ok(
    "unreadable" in
      validateVisionAnswer('{"verdict":"broken","issues":[{"kind":"weirdness","where":"the header area","confidence":0.9}]}'),
  );
});

test("`ok` with an empty issues list is the common and correct answer", () => {
  const out = validateVisionAnswer('{"verdict":"ok","issues":[]}');
  assert.ok(!("unreadable" in out));
  if (!("unreadable" in out)) {
    assert.equal(out.verdict, "ok");
    assert.deepEqual(out.issues, []);
  }
});

test("an issue that names no part of the page, hedges, or writes an address is dropped", () => {
  const out = validateVisionAnswer(
    JSON.stringify({
      verdict: "unsure",
      issues: [
        { kind: "overlap", where: "something is off", confidence: 0.5 },
        { kind: "overlap", where: "it may be that the footer is wrong", confidence: 0.5 },
        { kind: "overlap", where: "see https://example.com/pricing in the header", confidence: 0.5 },
        { kind: "overlap", where: "the footer sits on top of the last paragraph", confidence: 0.8 },
      ],
    }),
  );
  assert.ok(!("unreadable" in out));
  if (!("unreadable" in out)) {
    assert.equal(out.issues.length, 1);
    assert.equal(out.issues[0]!.kind, "overlap");
    assert.equal(out.dropped.length, 3);
  }
});

test("confidence must be a number in [0,1] or the issue is dropped", () => {
  const out = validateVisionAnswer(
    JSON.stringify({
      verdict: "unsure",
      issues: [
        { kind: "blank", where: "the whole page below the header", confidence: "high" },
        { kind: "blank", where: "the whole page below the header", confidence: 4 },
        { kind: "blank", where: "the area below the header is white", confidence: 0.66 },
      ],
    }),
  );
  assert.ok(!("unreadable" in out));
  if (!("unreadable" in out)) {
    assert.equal(out.issues.length, 1);
    assert.equal(out.issues[0]!.confidence, 0.66);
  }
});

test("issues are capped and de-duplicated", () => {
  const one = { kind: "overflow", where: "the table runs off the right edge", confidence: 0.7 };
  const out = validateVisionAnswer(JSON.stringify({ verdict: "unsure", issues: Array(9).fill(one) }));
  assert.ok(!("unreadable" in out));
  if (!("unreadable" in out)) assert.equal(out.issues.length, 1);
});

/* ------------------------------------------------ the forward-only ledger */

test("detection may only ever say `detected`", () => {
  for (const to of ["confirmed", "submitted", "skipped", "not_listed", "pending"] as const)
    assert.equal(detectionMay(null, to), false, `detection must not be able to say ${to}`);
  assert.equal(detectionMay(null, "detected"), true);
});

test("detection may move an untouched or already-detected row forward and no other", () => {
  assert.equal(detectionMay("not_listed", "detected"), true);
  assert.equal(detectionMay("pending", "detected"), true);
  assert.equal(detectionMay("detected", "detected"), true);
  /* The rows a person owns. A probe that disagrees with a person is wrong
     more often than the person is. */
  assert.equal(detectionMay("confirmed", "detected"), false);
  assert.equal(detectionMay("submitted", "detected"), false);
  assert.equal(detectionMay("skipped", "detected"), false);
});

/* --------------------------------------------------------- small helpers */

test("the SEO tag matches as a whole token", () => {
  assert.equal(tagged("Rewrote the pricing page #seo", "#seo"), true);
  assert.equal(tagged("#seo at the very start", "#seo"), true);
  assert.equal(tagged("Notes on #seowriting for later", "#seo"), false);
  assert.equal(tagged("nothing tagged here", "#seo"), false);
  assert.equal(tagged("case insensitive #SEO", "#seo"), true);
});

test("URLs are pulled out of card text with their trailing punctuation trimmed", () => {
  const urls = urlsIn("Rewrote https://example.com/pricing, then https://example.com/docs. #seo");
  assert.deepEqual(urls, ["https://example.com/pricing", "https://example.com/docs"]);
  assert.deepEqual(urlsIn("no links here"), []);
  /* De-duplicated, because two mentions of one page are one page. */
  assert.deepEqual(urlsIn("https://a.com/x and again https://a.com/x"), ["https://a.com/x"]);
});

test("a URL is matched to the longest Search Console property that covers it", () => {
  const rows = [
    { property: "sc-domain:example.com", account_id: 1 },
    { property: "https://example.com/docs/", account_id: 2 },
    { property: "sc-domain:other.com", account_id: 3 },
  ];
  assert.equal(resolveProperty("https://example.com/docs/api", rows)?.property, "https://example.com/docs/");
  assert.equal(resolveProperty("https://example.com/pricing", rows)?.property, "sc-domain:example.com");
  assert.equal(resolveProperty("https://blog.example.com/post", rows)?.property, "sc-domain:example.com");
  assert.equal(resolveProperty("https://nobody.test/x", rows), null);
  assert.equal(resolveProperty("not a url", rows), null);
});

test("a URL-prefix property does not cover a different scheme", () => {
  const rows = [{ property: "https://example.com/", account_id: 1 }];
  assert.equal(resolveProperty("http://example.com/x", rows), null);
  assert.equal(resolveProperty("https://example.com/x", rows)?.property, "https://example.com/");
});

test("offsets parse, de-duplicate, sort and fall back", () => {
  assert.deepEqual(parseOffsets("28, 14, 14, 56"), [14, 28, 56]);
  assert.deepEqual(parseOffsets(""), [14, 28, 56]);
  assert.deepEqual(parseOffsets("nonsense"), [14, 28, 56]);
  assert.deepEqual(parseOffsets("0, -3, 900, 7"), [7]);
});

test("the venture opt-in list understands `all` and an empty default", () => {
  assert.equal(parseVentureList("all"), "all");
  assert.equal(parseVentureList("example-app-1, ALL"), "all");
  assert.deepEqual(parseVentureList(""), []);
  assert.deepEqual(parseVentureList("Example App 1, example-support"), ["example-app-1", "example-support"]);
});

test("hosts fold to a comparable form and subdomains count as the same site", () => {
  assert.equal(hostOf("https://www.Example.com/path?x=1"), "example.com");
  assert.equal(hostOf("localhost"), null);
  assert.equal(sameHost("blog.example.com", "example.com"), true);
  assert.equal(sameHost("example.com", "example.org"), false);
  assert.equal(sameHost(null, "example.com"), false);
});


/* ------------------------------------------- the follow-up schedule (P1 #4) */

/**
 * The failure this guards: a card finished six months ago is still worth a
 * baseline, but its baseline is read TODAY. Every offset is then instantly
 * elapsed, and one nightly would file 14, 28 and 56 out of a single identical
 * window — three model calls and a time series that never happened.
 */
const baseline = (over: Partial<BaselineRow> = {}): BaselineRow => ({
  id: "sb-test",
  venture_id: null,
  source: "card",
  source_ref: "1",
  url: "https://example.com/page",
  property: null,
  tag: "#seo",
  title: "t",
  action_at: "2026-01-01T00:00:00.000Z",
  offsets: JSON.stringify([14, 28, 56]),
  outcome_id: null,
  created_at: "2026-09-01T00:00:00.000Z",
  closed_at: null,
  ...over,
});

test("an offset that elapsed before the URL was tracked is unreachable, not due", () => {
  /* Tracked eight months after the work: all three slots are already past. */
  const old = reachableOffsets(baseline());
  assert.deepEqual(old.reachable, []);
  assert.deepEqual(old.missed, [14, 28, 56]);
});

test("an offset still in the future when tracking began is reachable", () => {
  /* Swept the day the card was finished: every slot is still ahead. */
  const fresh = reachableOffsets(
    baseline({ action_at: "2026-09-01T00:00:00.000Z", created_at: "2026-09-01T00:10:00.000Z" }),
  );
  assert.deepEqual(fresh.reachable, [14, 28, 56]);
  assert.deepEqual(fresh.missed, []);
});

test("a partially-late sweep keeps the offsets it can still answer", () => {
  /* Work done on the 1st, tracked on the 20th: day 14 is gone, 28 and 56 are not. */
  const some = reachableOffsets(
    baseline({ action_at: "2026-09-01T00:00:00.000Z", created_at: "2026-09-20T00:00:00.000Z" }),
  );
  assert.deepEqual(some.missed, [14]);
  assert.deepEqual(some.reachable, [28, 56]);
});

/* ------------------------------------- the rendered reading's shape (P1 #5) */

/**
 * The reading comes back from a browser pointed at a URL somebody typed. It
 * runs in an isolated world, and this is the second defence: what the DOM SAYS
 * is still the page's to choose, and a colour is written into a `style`
 * attribute on the venture page.
 */
const hostile = {
  title: "A title\u0000with a null in it",
  finalUrl: "javascript:alert(1)",
  bodyFont: 'url(http://attacker.example/beacon.woff) , "Real Font"',
  pageBg: "url(http://attacker.example/bg)",
  pageInk: "#171717",
  colours: [
    { hex: "#064923", kind: "bg", area: 1000 },
    { hex: "url(http://attacker.example/x)", kind: "bg", area: 999 },
    { hex: "#GGGGGG", kind: "bg", area: 998 },
    { hex: "#064923", kind: "bg", area: Number.POSITIVE_INFINITY },
    { hex: "#89001A", kind: "not-a-kind", area: -5 },
  ],
  vars: [{ name: "--brand", hex: "#00458C" }, { name: "--bad", hex: "expression(x)" }],
  buttons: [{ hex: "#064923", n: 2 }, { hex: "nope", n: 1 }],
  fonts: [
    { tag: "h1", family: "Figtree", weight: 700, sizePx: 32 },
    { tag: "h2", family: "url(http://attacker.example/f)", weight: 400, sizePx: 24 },
  ],
  logos: [
    { src: "javascript:alert(1)", kind: "img", alt: "logo", score: 9, widthPx: 100 },
    { src: "https://example.com/logo.svg", kind: "img", alt: "logo", score: 8, widthPx: 100 },
  ],
  counted: 339,
  notes: ["a real note", 42, { not: "a string" }],
};

test("a colour that is not six hex digits never reaches the stored document", () => {
  const { raw, dropped } = validateRaw(hostile);
  assert.deepEqual(raw.colours.map((c) => c.hex), ["#064923"]);
  assert.equal(raw.pageBg, null, "a url() page background is dropped, not stored");
  assert.equal(raw.pageInk, "#171717");
  assert.ok(dropped.length >= 3);
  /* The one thing that must be impossible: a `url(` reaching a style attribute. */
  for (const c of raw.colours) assert.match(c.hex, /^#[0-9A-F]{6}$/);
});

test("every hex the shaped reading publishes is six hex digits", () => {
  const doc = shapeReading("https://example.com/", hostile);
  for (const c of doc.colours) assert.match(c.hex, /^#[0-9A-F]{6}$/);
  for (const b of doc.buttons) assert.match(b.hex, /^#[0-9A-F]{6}$/);
  assert.equal(doc.background, null);
  assert.equal(doc.ink, "#171717");
  for (const value of Object.values(doc.palette))
    if (typeof value === "string") assert.match(value, /^#[0-9A-F]{6}$/);
});

test("a font family is bounded and loses url( and its parentheses", () => {
  assert.equal(safeFontName('url(http://x/y.woff) , "Real"'), 'http://x/y.woff , "Real"'.replace("url(", "").trim());
  assert.ok(!safeFontName('url(http://x/y.woff)')?.includes("url("));
  assert.ok(!safeFontName("Fig(tree)")?.includes("("));
  assert.equal(safeFontName("x".repeat(500))?.length, 200);
  assert.equal(safeFontName(""), null);
  assert.equal(safeFontName(42), null);
});

test("counts must be finite and non-negative", () => {
  assert.equal(safeCount(10), 10);
  assert.equal(safeCount(0), 0);
  assert.equal(safeCount(-1), null);
  assert.equal(safeCount(Number.POSITIVE_INFINITY), null);
  assert.equal(safeCount(Number.NaN), null);
  assert.equal(safeCount("10"), null);
  assert.equal(safeCount(1e15, 1000), 1000);
});

test("a logo source that is not http(s) is dropped rather than rendered", () => {
  const { raw } = validateRaw(hostile);
  assert.deepEqual(raw.logos.map((l) => l.src), ["https://example.com/logo.svg"]);
  assert.equal(safeAssetUrl("javascript:alert(1)"), null);
  assert.equal(safeAssetUrl("data:text/html,x"), null);
  assert.equal(safeAssetUrl("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(safeHex("#abcdef"), "#ABCDEF");
  assert.equal(safeHex("#abc"), null);
});

test("notes that are not strings never become sentences on the page", () => {
  const { raw } = validateRaw(hostile);
  for (const n of raw.notes) assert.equal(typeof n, "string");
  assert.ok(raw.notes.includes("a real note"));
});

test("the shaped reading survives an answer that is not an object at all", () => {
  for (const junk of [null, undefined, "text", 42, []]) {
    const doc = shapeReading("https://example.com/", junk);
    assert.equal(doc.method, "rendered");
    assert.deepEqual(doc.colours, []);
    assert.equal(doc.elementsMeasured, 0);
  }
});

test("a reading that ran in the page's own world says so", () => {
  const isolated = shapeReading("https://example.com/", { ...hostile, isolated: true });
  const main = shapeReading("https://example.com/", { ...hostile, isolated: false });
  assert.ok(!isolated.notes.some((n) => n.includes("isolated world")));
  assert.ok(main.notes.some((n) => n.includes("isolated world")));
});

/* ------------------------------------------- addresses on the inside (P1 #6) */

/**
 * A venture website is a string the owner types, and the rendered pass drives a
 * browser at it WITH SCRIPT ENABLED from the machine the dashboard runs on —
 * which can reach the owner's router, this API on loopback, and the cloud
 * metadata endpoint that hands out instance credentials.
 */
test("loopback, private, link-local and metadata addresses are refused", () => {
  for (const host of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.9",
    "100.64.1.2",
    "169.254.169.254",
    "0.0.0.0",
    "0.1.2.3",
    "fd00::1",
    "fe80::1",
  ])
    assert.equal(isInternalHost(host), true, `${host} must be refused`);
});

test("ordinary public hosts are still accepted", () => {
  for (const host of ["example.com", "example-app-1.example.test", "8.8.8.8", "203.0.113.7", "2606:4700::1111"])
    assert.equal(isInternalHost(host), false, `${host} must be accepted`);
});

test("normaliseWebsite refuses an internal address outright", () => {
  assert.equal(normaliseWebsite("http://169.254.169.254/latest/meta-data/"), null);
  assert.equal(normaliseWebsite("http://127.0.0.1:8787/api/plugins"), null);
  assert.equal(normaliseWebsite("https://192.168.1.1/"), null);
  /* Already refused before this change, and still refused. */
  assert.equal(normaliseWebsite("localhost"), null);
  assert.equal(normaliseWebsite("file:///etc/passwd"), null);
  assert.equal(normaliseWebsite(""), null);
});

test("normaliseWebsite still takes a real site, with or without a scheme", () => {
  assert.deepEqual(normaliseWebsite("example-app-1.example.test"), {
    website: "https://example-app-1.example.test/",
    host: "example-app-1.example.test",
  });
  assert.equal(normaliseWebsite("https://www.Example.com/x")?.host, "example.com");
});

/* -------------------------------------- the vision budget estimate (P2 #8) */

test("an image is priced by its tiles rather than by its bytes", () => {
  /* 1280x800 is three tiles by two: 85 + 170*6. A 300 KB PNG measured by byte
     length would have reserved four hundred thousand. */
  assert.equal(imageTokens(1280, 800), 85 + 170 * 6);
  assert.equal(imageTokens(1, 1), 85 + 170);
  /* Unknown dimensions are priced as the largest thing this will send, not the
     smallest: guessing low is how a budget stops being a budget. */
  assert.equal(imageTokens(null, null), imageTokens(2048, 2048));
  assert.ok(imageTokens(1280, 800) < 5_000);
});

test("a PNG's dimensions are read from its header, and a non-PNG is null", () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(1280, 16);
  png.writeUInt32BE(800, 20);
  assert.deepEqual(pngSize(png), { width: 1280, height: 800 });
  assert.equal(pngSize(Buffer.from("not a png at all, really not")), null);
  assert.equal(pngSize(Buffer.alloc(4)), null);
});
