/**
 * THE PURE HALF OF THE WEB ANALYTICS AREA, ASSERTED AGAINST FIXTURES.
 *
 * WHAT IS TESTED HERE, AND WHY IT IS THESE THINGS. Three kinds of arithmetic in
 * this area can be quietly wrong in a way that becomes a confident sentence:
 *
 *   THE BOT HEURISTICS. Every threshold is a judgement, and the failure that
 *   matters is a heuristic firing on a real audience — so the fixtures include
 *   the near misses as well as the hits, and the "never subtract more than the
 *   largest finding" rule is asserted directly, because summing overlapping
 *   populations is the mistake that would turn an audience into a crawler.
 *
 *   THE JOIN LOGIC. `hostsIn` decides which business a campaign belongs to
 *   from text somebody typed into Meta, and `creativeLink` digs a destination
 *   out of four different creative shapes. Both are string work over other
 *   people's data and both are asserted against the exact shapes the live
 *   account returns.
 *
 *   THE PROPERTY AGGREGATE. The sum of a numeric event property is
 *   Σ(value × occurrences) and NOT the sum of the distinct values; the two
 *   differ by a lot when one value dominates, and the second would be wrong.
 *
 * WHAT IS NOT TESTED HERE: everything that reads a row. Those need a database
 * beside a running server and are verified against the real box instead — the
 * evidence is in README's Web analytics section.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adjust,
  findings,
  refusals,
  screenTrigger,
  HEURISTICS,
  SCREEN_MIN_VISITORS,
  type BotInput,
} from "./bots.ts";
import { fatigueOf, MIN_IMPRESSIONS } from "./fatigue.ts";
import { hostsIn, ventureHosts } from "./attribution.ts";
import { boundedError, summariseProperties, MAX_ERROR_CHARS } from "./umami-collect.ts";
import { creativeLink } from "../../providers/meta.ts";
import { parseUtm, windowAt } from "../analytics/umami.ts";
import {
  checkRevenue,
  checkUnits,
  checkVentureLists,
  parseRevenue,
  parseUnits,
  parseVentureLists,
} from "./settings.ts";
import { span } from "./ads-collect.ts";
import type { AdCreativeRow, AdWindowRow, DimensionRow, SiteWindowRow } from "./store.ts";

/* --------------------------------------------------------------- fixtures */

const window_ = (
  windowDays: number,
  offsetDays: number,
  over: Partial<SiteWindowRow> = {},
): SiteWindowRow => ({
  account_id: 1,
  website_id: "w",
  window_days: windowDays,
  offset_days: offsetDays,
  start_day: "2026-08-07",
  end_day: "2026-09-05",
  pageviews: 1000,
  visitors: 900,
  visits: 950,
  bounces: 500,
  totaltime: 12_000,
  seen_at: "",
  source: "web_site_windows",
  ...over,
});

const dim = (
  dimension: string,
  windowDays: number,
  offsetDays: number,
  counts: "visitors" | "views",
  rows: [string, number][],
  capped = false,
): DimensionRow[] =>
  rows.map(([value, count]) => ({
    account_id: 1,
    website_id: "w",
    dimension,
    value,
    window_days: windowDays,
    offset_days: offsetDays,
    start_day: "2026-08-30",
    end_day: "2026-09-05",
    count,
    counts,
    capped: capped ? 1 : 0,
    seen_at: "",
  }));

function input(parts: {
  windows?: [string, SiteWindowRow][];
  dimensions?: [string, DimensionRow[]][];
}): BotInput {
  return {
    windows: new Map(parts.windows ?? [["30:0", window_(30, 0)]]),
    dimensions: new Map(parts.dimensions ?? []),
  };
}

/* ------------------------------------------------------------- the screen */

test("screenTrigger names headless defaults and square screens, and leaves real monitors alone", () => {
  assert.equal(screenTrigger("800x600"), "headless-default");
  assert.equal(screenTrigger("1024x768"), "headless-default");
  assert.equal(screenTrigger("1280x1200"), "square");
  assert.equal(screenTrigger("1600x1600"), "square");
  /* 1280x1024 is 1.25 — a real 5:4 monitor and outside the band. */
  assert.equal(screenTrigger("1280x1024"), null);
  assert.equal(screenTrigger("1920x1080"), null);
  assert.equal(screenTrigger("390x844"), null);
  assert.equal(screenTrigger("(none)"), null);
});

test("headless-screen fires on a headless default above the share and volume bars", () => {
  const found = findings(
    input({
      windows: [["30:0", window_(30, 0, { pageviews: 1000, visits: 950, visitors: 900 })]],
      dimensions: [
        [
          "screen:30:0",
          dim("screen", 30, 0, "visitors", [
            ["800x600", 400],
            ["1920x1080", 300],
            ["390x844", 200],
          ]),
        ],
      ],
    }),
  );
  const hit = found.find((f) => f.heuristic === "headless-screen");
  assert.ok(hit, "expected a headless-screen finding");
  assert.equal(hit.fingerprint, "screen:800x600");
  assert.equal(hit.excluded, 400);
  assert.equal(hit.population, "visitors");
  assert.ok(hit.evidence.some((e) => e.includes("SITE-WIDE")), "the weaker gate must be stated");
});

test("headless-screen does NOT fire on a site whose audience reads several pages", () => {
  const found = findings(
    input({
      /* 3.0 pageviews a visit — well past the 1.3 gate. */
      windows: [["30:0", window_(30, 0, { pageviews: 2850, visits: 950 })]],
      dimensions: [["screen:30:0", dim("screen", 30, 0, "visitors", [["800x600", 400], ["1920x1080", 300]])]],
    }),
  );
  assert.equal(found.filter((f) => f.heuristic === "headless-screen").length, 0);
});

test("headless-screen does NOT fire below the volume bar even at a huge share", () => {
  const found = findings(
    input({
      windows: [["30:0", window_(30, 0, { pageviews: 40, visits: 39 })]],
      dimensions: [
        ["screen:30:0", dim("screen", 30, 0, "visitors", [["800x600", SCREEN_MIN_VISITORS - 1], ["1920x1080", 2]])],
      ],
    }),
  );
  assert.equal(found.filter((f) => f.heuristic === "headless-screen").length, 0);
});

/* --------------------------------------------------------------- surges */

test("country-surge fires on a five-fold week and excludes only the excess", () => {
  const found = findings(
    input({
      dimensions: [
        ["country:7:0", dim("country", 7, 0, "visitors", [["SG", 500], ["IE", 100], ["US", 90]])],
        ["country:7:7", dim("country", 7, 7, "visitors", [["SG", 50], ["IE", 95], ["US", 88]])],
      ],
    }),
  );
  const hit = found.find((f) => f.heuristic === "country-surge");
  assert.ok(hit);
  assert.equal(hit.value, "SG");
  assert.equal(hit.excluded, 450, "the excess over the previous week, not the whole country");
  assert.ok(hit.evidence.some((e) => e.includes("EXCESS")));
});

test("country-surge ignores a small absolute rise and a small share", () => {
  const found = findings(
    input({
      dimensions: [
        /* 10× but only 40 visitors — under the absolute bar. */
        ["country:7:0", dim("country", 7, 0, "visitors", [["SG", 40], ["IE", 900]])],
        ["country:7:7", dim("country", 7, 7, "visitors", [["SG", 4], ["IE", 880]])],
      ],
    }),
  );
  assert.equal(found.filter((f) => f.heuristic === "country-surge").length, 0);
});

test("a value absent last week surges only if it is also big and dominant", () => {
  const found = findings(
    input({
      dimensions: [
        ["referrer:7:0", dim("referrer", 7, 0, "views", [["scraper.example", 300], ["google.com", 100]])],
        ["referrer:7:7", dim("referrer", 7, 7, "views", [["google.com", 110]])],
      ],
    }),
  );
  const hit = found.find((f) => f.heuristic === "referrer-surge");
  assert.ok(hit);
  assert.equal(hit.population, "views");
  assert.equal(hit.excluded, 300);
  assert.ok(hit.evidence.some((e) => e.includes("absent from the previous week")));
});

/* ------------------------------------------------------- the diagnostic */

test("flat-single-view is a diagnostic that excludes nothing", () => {
  const found = findings(
    input({
      windows: [["30:0", window_(30, 0, { pageviews: 1000, visits: 990, bounces: 950, visitors: 980 })]],
    }),
  );
  const hit = found.find((f) => f.heuristic === "flat-single-view");
  assert.ok(hit);
  assert.equal(hit.excluded, null);
  assert.equal(hit.population, null);
});

test("every heuristic publishes how it can be wrong", () => {
  for (const h of HEURISTICS) assert.ok(h.wrong.length > 40, `${h.id} has no "how this is wrong"`);
  assert.equal(new Set(HEURISTICS.map((h) => h.id)).size, HEURISTICS.length, "duplicate heuristic id");
});

/* --------------------------------------------------------------- adjust */

test("adjust subtracts the LARGEST finding and never the sum of them", () => {
  const found = findings(
    input({
      windows: [["30:0", window_(30, 0, { pageviews: 1000, visits: 950, visitors: 900 })]],
      dimensions: [
        ["screen:30:0", dim("screen", 30, 0, "visitors", [["800x600", 400], ["1920x1080", 300]])],
        ["country:7:0", dim("country", 7, 0, "visitors", [["SG", 500], ["IE", 100]])],
        ["country:7:7", dim("country", 7, 7, "visitors", [["SG", 50], ["IE", 95]])],
      ],
    }),
  );
  const visitorFindings = found.filter((f) => f.population === "visitors");
  assert.equal(visitorFindings.length, 2, "fixture should produce two visitor findings");
  /* Both findings are 30-day here so the 30-day adjust sees both. */
  const found30 = found.map((f) => ({ ...f, windowDays: 30, offsetDays: 0 }));
  const a = adjust(900, "visitors", found30, 30, 0);
  /* 400 and 450 are the two exclusions; 850 would be the sum and is wrong. */
  assert.equal(a.excluded, 450);
  assert.equal(a.value, 450);
  assert.ok(a.basis.includes("NOT added"));
});

test("adjust with no finding returns the raw figure and says so", () => {
  const a = adjust(900, "visitors", [], 30, 0);
  assert.equal(a.value, 900);
  assert.equal(a.excluded, 0);
  assert.equal(a.heuristic, null);
  assert.ok(a.basis.includes("IS the raw figure"));
});

test("adjust never turns an unmeasured figure into a number", () => {
  const a = adjust(null, "visitors", [], 30, 0);
  assert.equal(a.value, null);
  assert.ok(a.basis.includes("not measured"));
});

/**
 * THE REGRESSION THAT MATTERS MOST IN THIS FILE.
 *
 * `adjust` used to filter on population alone, so the 30-day screen exclusion
 * of 382 was subtracted from the SEVEN-DAY raw of 352 and `Math.max(0, …)`
 * published the result as "adjusted visitors 0" — a fabricated measurement on
 * the page and in the skill. A finding may only adjust its own window.
 */
test("adjust never subtracts a finding from a window it was not computed over", () => {
  const found = findings(
    input({
      windows: [["30:0", window_(30, 0, { pageviews: 1000, visits: 950, visitors: 1042 })]],
      dimensions: [
        ["screen:30:0", dim("screen", 30, 0, "visitors", [["1280x1200", 382], ["1920x1080", 300]])],
      ],
    }),
  );
  const hit = found.find((f) => f.heuristic === "headless-screen");
  assert.ok(hit);
  assert.equal(hit.windowDays, 30);

  /* The live shape: raw 352 over 7 days, a 382-visitor finding over 30. */
  const week = adjust(352, "visitors", found, 7, 0);
  assert.equal(week.value, 352, "a 30-day exclusion may not touch a 7-day figure");
  assert.equal(week.excluded, 0);
  assert.equal(week.heuristic, null);
  assert.ok(week.basis.includes("OTHER windows"), week.basis);

  /* And the same finding still applies to its own window. */
  const month = adjust(1042, "visitors", found, 30, 0);
  assert.equal(month.value, 660);
  assert.equal(month.excluded, 382);
});

test("a 7-day surge may not be subtracted from the 30-day figure either", () => {
  const found = findings(
    input({
      dimensions: [
        ["country:7:0", dim("country", 7, 0, "visitors", [["SG", 500], ["IE", 100]])],
        ["country:7:7", dim("country", 7, 7, "visitors", [["SG", 50], ["IE", 95]])],
      ],
    }),
  );
  assert.equal(found[0]?.windowDays, 7);
  assert.equal(adjust(2000, "visitors", found, 30, 0).value, 2000);
  assert.equal(adjust(600, "visitors", found, 7, 0).value, 150);
});

test("an exclusion larger than the raw figure is REFUSED, never floored to zero", () => {
  const found = findings(
    input({
      windows: [["30:0", window_(30, 0, { pageviews: 100, visits: 99, visitors: 50 })]],
      dimensions: [["screen:30:0", dim("screen", 30, 0, "visitors", [["800x600", 400], ["1920x1080", 10]])]],
    }),
  );
  const a = adjust(50, "visitors", found, 30, 0);
  assert.equal(a.value, null, "a contradiction must not be published as a measurement of nought");
  assert.equal(a.excluded, 400);
  assert.ok(a.basis.startsWith("REFUSED"), a.basis);
});

/* ------------------------------------------------------- the request cap */

test("a capped dimension produces no finding and a stated refusal", () => {
  const capped = input({
    windows: [["30:0", window_(30, 0, { pageviews: 1000, visits: 950, visitors: 900 })]],
    dimensions: [
      ["screen:30:0", dim("screen", 30, 0, "visitors", [["800x600", 400], ["1920x1080", 300]], true)],
    ],
  });
  assert.equal(findings(capped).length, 0, "a share against a floor is not a share");
  const refused = refusals(capped);
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.heuristic, "headless-screen");
  assert.ok(refused[0]?.reason.includes("floor"));

  /* The identical rows, uncapped, DO produce the finding — so the refusal is
     the cap and not the data. */
  const whole = input({
    windows: [["30:0", window_(30, 0, { pageviews: 1000, visits: 950, visitors: 900 })]],
    dimensions: [
      ["screen:30:0", dim("screen", 30, 0, "visitors", [["800x600", 400], ["1920x1080", 300]])],
    ],
  });
  assert.equal(findings(whole).length, 1);
  assert.deepEqual(refusals(whole), []);
});

test("a capped surge window is refused on both halves", () => {
  const rows: [string, number][] = [["SG", 500], ["IE", 100]];
  const prior: [string, number][] = [["SG", 50], ["IE", 95]];
  const cappedNow = input({
    dimensions: [
      ["country:7:0", dim("country", 7, 0, "visitors", rows, true)],
      ["country:7:7", dim("country", 7, 7, "visitors", prior)],
    ],
  });
  assert.equal(findings(cappedNow).filter((f) => f.heuristic === "country-surge").length, 0);
  assert.equal(refusals(cappedNow).length, 1);

  const cappedBefore = input({
    dimensions: [
      ["country:7:0", dim("country", 7, 0, "visitors", rows)],
      ["country:7:7", dim("country", 7, 7, "visitors", prior, true)],
    ],
  });
  assert.equal(findings(cappedBefore).filter((f) => f.heuristic === "country-surge").length, 0);
});

/* ------------------------------------------------- the bounded error string */

test("the run row's error string is bounded and says how many it dropped", () => {
  const many = Array.from({ length: 200 }, (_, i) => `site-${i}: something went wrong on a read`);
  const out = boundedError(many);
  assert.ok(out);
  assert.ok(out.length <= MAX_ERROR_CHARS, `${out.length} > ${MAX_ERROR_CHARS}`);
  assert.match(out, /and \d+ more warning\(s\) not shown\.$/);
  assert.equal(boundedError([]), null);
  assert.equal(boundedError(["one thing"]), "one thing");
});

/* --------------------------------------------- the settings checks accept */

test("two lines for one venture are valid input, not a parse failure", () => {
  const value = "alpha = signup-cta-clicked\nalpha = checkout-clicked\nbeta = a";
  assert.equal(checkVentureLists(value), null);
  assert.deepEqual(parseVentureLists(value).get("alpha"), [
    "signup-cta-clicked",
    "checkout-clicked",
  ]);
  /* And a line that genuinely cannot be read is still reported. */
  assert.match(checkVentureLists("alpha = a\nnot a setting line") ?? "", /1 line/);
  assert.equal(checkRevenue("alpha = payment-completed.revenue\nbeta = x.y"), null);
  assert.match(checkRevenue("alpha = payment-completed") ?? "", /alpha/);
  assert.equal(checkUnits("a.b = USD\nc.d = seconds"), null);
});

/* -------------------------------------------------------------- fatigue */

const ad = (over: Partial<AdCreativeRow> = {}): AdCreativeRow => ({
  ad_id: "a1",
  ad_account_id: "act_1",
  adset_id: "s1",
  campaign_id: "c1",
  name: "Ad one",
  status: "ACTIVE",
  configured_status: "ACTIVE",
  creative_id: null,
  creative_name: null,
  title: null,
  body: null,
  call_to_action: null,
  link_url: null,
  image_url: null,
  thumbnail_url: null,
  issues: null,
  created_time: null,
  updated_time: null,
  seen_at: "",
  ...over,
});

const win = (offset: number, over: Partial<AdWindowRow> = {}): AdWindowRow => ({
  ad_id: "a1",
  ad_account_id: "act_1",
  window_days: 7,
  offset_days: offset,
  start_day: "2026-08-30",
  end_day: "2026-09-05",
  impressions: 20_000,
  reach: 10_000,
  frequency: 2,
  clicks: 200,
  spend: 40,
  ctr: 1,
  cpm: 2,
  seen_at: "",
  ...over,
});

test("fatigue needs BOTH a rising frequency and a falling click-through", () => {
  const fatigued = fatigueOf(ad(), win(0, { frequency: 2.6, ctr: 0.7 }), win(7, { frequency: 2.0, ctr: 1.0 }), null);
  assert.equal(fatigued.verdict, "fatigued");

  /* Click-through fell hard, frequency flat: an auction or a season, not fatigue. */
  const auction = fatigueOf(ad(), win(0, { frequency: 2.0, ctr: 0.7 }), win(7, { frequency: 2.0, ctr: 1.0 }), null);
  assert.equal(auction.verdict, "steady");

  /* Frequency rose, click-through held: a small audience, not fatigue. */
  const small = fatigueOf(ad(), win(0, { frequency: 3.4, ctr: 1.0 }), win(7, { frequency: 2.0, ctr: 1.0 }), null);
  assert.equal(small.verdict, "steady");
  assert.ok(small.evidence.some((e) => e.includes("NOT a claim about audience overlap")));
});

test("fatigue has a middle band before it is called", () => {
  const tiring = fatigueOf(ad(), win(0, { frequency: 2.3, ctr: 0.87 }), win(7, { frequency: 2.0, ctr: 1.0 }), null);
  assert.equal(tiring.verdict, "tiring");
});

test("under the impression floor there is no verdict at all", () => {
  const row = fatigueOf(
    ad(),
    win(0, { impressions: MIN_IMPRESSIONS - 1, frequency: 3, ctr: 0.1 }),
    win(7, { frequency: 1, ctr: 5 }),
    null,
  );
  assert.equal(row.verdict, "no-verdict");
  assert.ok(row.why?.includes(String(MIN_IMPRESSIONS)));
  assert.deepEqual(row.evidence, []);
});

test("a missing comparison week is no verdict, never steady", () => {
  const row = fatigueOf(ad(), win(0), undefined, null);
  assert.equal(row.verdict, "no-verdict");
  assert.ok(row.why?.includes("previous week"));
});

/* ---------------------------------------------------------------- joins */

test("hostsIn finds hosts in the exact campaign-name shapes ad platforms produce", () => {
  assert.deepEqual(hostsIn("Promoting website: https://api.whatsapp.com/send"), ["api.whatsapp.com"]);
  assert.deepEqual(
    hostsIn("[8/4/2026] Promoting https://example.com/become-a-tutor/apply"),
    ["example.com"],
  );
  assert.deepEqual(
    hostsIn("Promoting https://example.co/?utm_source=meta&utm_medium=paid"),
    ["example.co"],
  );
  assert.deepEqual(hostsIn("Leads — example.ie — August"), ["example.ie"]);
  assert.deepEqual(hostsIn("Summer sale, no links here"), []);
});

test("ventureHosts folds the record's host and its website into one set", () => {
  const v = {
    id: "v1",
    slug: "acme",
    name: "Acme",
    description: "",
    website: "https://www.acme.ie/",
    host: "acme.ie",
    stage: "launched",
    color: "",
    color_source: "",
    position: 0,
    brand: "{}",
    created_at: "",
    updated_at: "",
  };
  assert.deepEqual(ventureHosts(v), ["acme.ie"]);
});

test("creativeLink digs the destination out of each creative shape Meta uses", () => {
  assert.equal(creativeLink({ link_data: { link: "https://a.example/x" } }), "https://a.example/x");
  assert.equal(
    creativeLink({ video_data: { call_to_action: { value: { link: "https://b.example/y" } } } }),
    "https://b.example/y",
  );
  assert.equal(
    creativeLink({ link_data: { child_attachments: [{ link: "https://c.example/z" }] } }),
    "https://c.example/z",
  );
  assert.equal(creativeLink({ template_data: { link: "https://d.example" } }), "https://d.example");
  assert.equal(creativeLink({ link_data: { link: "not-a-url" } }), null);
  assert.equal(creativeLink(null), null);
});

/* ------------------------------------------------------------------ utm */

test("parseUtm lowercases the key and the value, and decodes the query", () => {
  assert.deepEqual(parseUtm("utm_Source=GitHub&utm_medium=readme&utm_campaign=Premium"), {
    source: "github",
    medium: "readme",
    campaign: "premium",
    content: null,
    term: null,
  });
  assert.deepEqual(parseUtm("utm_campaign=summer+sale"), {
    source: null,
    medium: null,
    campaign: "summer sale",
    content: null,
    term: null,
  });
  assert.deepEqual(parseUtm("provider=navy&type=chat"), {
    source: null,
    medium: null,
    campaign: null,
    content: null,
    term: null,
  });
});

/* -------------------------------------------------- the property aggregate */

test("a numeric property's sum is value × occurrences, not the sum of the values", () => {
  const [row] = summariseProperties([
    { property: "revenue", dataType: 2, value: "19.0000", total: 213 },
    { property: "revenue", dataType: 2, value: "49.0000", total: 145 },
  ]);
  assert.ok(row);
  assert.equal(row.dataType, "number");
  assert.equal(row.records, 358);
  assert.equal(row.num?.count, 358);
  assert.equal(row.num?.sum, 19 * 213 + 49 * 145);
  assert.equal(row.num?.min, 19);
  assert.equal(row.num?.max, 49);
  /* 34 would be the mean of the two DISTINCT values, which is not the mean. */
  assert.equal(row.num?.avg, Math.round(((19 * 213 + 49 * 145) / 358) * 10_000) / 10_000);
});

test("an unparseable value refuses the aggregate rather than publishing it short", () => {
  const [row] = summariseProperties([
    { property: "revenue", dataType: 2, value: "19.0000", total: 10 },
    { property: "revenue", dataType: 2, value: "n/a", total: 3 },
  ]);
  assert.ok(row);
  assert.equal(row.truncated, true);
  assert.equal(row.num, null);
});

test("a string property gets a capped ranking and no arithmetic", () => {
  const [row] = summariseProperties([
    { property: "plan", dataType: 1, value: "annual", total: 215 },
    { property: "plan", dataType: 1, value: "lifetime", total: 143 },
  ]);
  assert.ok(row);
  assert.equal(row.dataType, "string");
  assert.equal(row.num, null);
  assert.deepEqual(row.topValues, [
    { value: "annual", count: 215 },
    { value: "lifetime", count: 143 },
  ]);
});

/* ------------------------------------------------------------- settings */

test("the settings parsers keep the shapes the hints promise", () => {
  const conv = parseVentureLists("alpha = a, b\n# comment\nbeta = c");
  assert.deepEqual(conv.get("alpha"), ["a", "b"]);
  assert.deepEqual(conv.get("beta"), ["c"]);

  const rev = parseRevenue("alpha = payment-completed.revenue");
  assert.deepEqual(rev.get("alpha"), { event: "payment-completed", property: "revenue" });

  const units = parseUnits("payment-completed.revenue = USD\nnonsense");
  assert.equal(units.get("payment-completed.revenue"), "USD");
  assert.equal(units.size, 1);
});

/* -------------------------------------------------------------- windows */

test("no window ever contains today", () => {
  const from = new Date("2026-09-06T13:00:00Z");
  const w = windowAt(7, 0, from);
  assert.equal(w.endDay, "2026-09-05");
  assert.equal(w.startDay, "2026-08-30");
  const before = windowAt(7, 7, from);
  assert.equal(before.endDay, "2026-08-29");
  assert.equal(before.startDay, "2026-08-23");
  /* The two windows must abut and not overlap. */
  assert.ok(before.endDay < w.startDay);

  const meta = span(7, 0, from);
  assert.deepEqual(meta, { since: "2026-08-30", until: "2026-09-05" });
  assert.deepEqual(span(7, 7, from), { since: "2026-08-23", until: "2026-08-29" });
});

/* ==========================================================================
 * THE ONE TEST HERE THAT TOUCHES A DATABASE.
 *
 * Everything above is pure. `joinFor` is not — it reads six tables — and the
 * decision it makes about `taggedViews` is exactly the kind that cannot be
 * asserted any other way: NULL means "this venture's site has never had its
 * turn in the rotation" and 0 means "it has, and nothing carried a campaign
 * tag". Publishing the second figure for the first case is a silent zero, and
 * a silent zero is what this area's whole contract is against.
 *
 * The setup runner points OPC_DATA_DIR at a temporary directory, so this opens
 * an empty database with the migrations applied and never the developer's.
 * ======================================================================= */
import { db, now as dbNow } from "../../db.ts";
import { joinFor } from "./attribution.ts";
import { replaceUtm } from "./store.ts";

function seedVenture(id: string, slug: string) {
  db.prepare(
    `INSERT INTO ventures (id, slug, name, description, website, host, stage, color,
                           color_source, position, brand, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, 'launched', '#000', 'default', 0, '{}', ?, ?)`,
  ).run(id, slug, slug, `https://${slug}.example`, `${slug}.example`, dbNow(), dbNow());
  return db.prepare("SELECT * FROM ventures WHERE id = ?").get(id) as never;
}

/** A real `plugin_accounts` row, because the UTM table's foreign key is
 *  enforced in this process and the whole point of the key is that a row
 *  cannot outlive the credential that fetched it. */
function seedAccount(): number {
  db.prepare(
    "INSERT OR IGNORE INTO plugins (id, connected, updated_at) VALUES ('umami', 1, ?)",
  ).run(dbNow());
  const info = db
    .prepare(
      "INSERT INTO plugin_accounts (plugin_id, label, connected, created_at, updated_at) VALUES ('umami', 'test', 1, ?, ?)",
    )
    .run(dbNow(), dbNow());
  return Number(info.lastInsertRowid);
}

function linkSite(ventureId: string, websiteId: string) {
  db.prepare(
    `INSERT INTO venture_links (venture_id, plugin, entity, label, source, created_at)
     VALUES (?, 'umami', ?, ?, 'owner', ?)`,
  ).run(ventureId, websiteId, websiteId, dbNow());
}

test("taggedViews is null when no UTM row was ever collected, and 0 only when rows exist", () => {
  const unread = seedVenture("v-unread", "unread");
  linkSite("v-unread", "site-unread");
  const a = joinFor(unread, 30);
  assert.equal(a.taggedViews, null, "a site that has not had its rotation turn is NOT a measured nought");
  assert.ok(
    a.notes.some((n) => n.includes("NOT MEASURED")),
    a.notes.join(" | "),
  );

  /* Rows exist, and none of them carries a utm_campaign — a real nought. */
  const read = seedVenture("v-read", "read");
  linkSite("v-read", "site-read");
  const accountId = seedAccount();
  replaceUtm(
    accountId,
    "site-read",
    30,
    0,
    { startDay: "2026-08-07", endDay: "2026-09-05" },
    [{ source: "github", medium: "readme", campaign: "", content: "", term: "", views: 40 }],
  );
  const b = joinFor(read, 30);
  assert.equal(b.taggedViews, 0, "rows present and none tagged IS a measured nought");
  assert.ok(
    b.notes.some((n) => n.includes("measured nought")),
    b.notes.join(" | "),
  );

  /* And a tagged row is counted. */
  const tagged = seedVenture("v-tagged", "tagged");
  linkSite("v-tagged", "site-tagged");
  replaceUtm(
    accountId,
    "site-tagged",
    30,
    0,
    { startDay: "2026-08-07", endDay: "2026-09-05" },
    [{ source: "meta", medium: "paid", campaign: "summer", content: "", term: "", views: 120 }],
  );
  const c = joinFor(tagged, 30);
  assert.equal(c.taggedViews, 120);
  assert.equal(c.tagged[0]?.campaign, "summer");
  assert.equal(c.tagged[0]?.matchedCampaignId, null, "no campaign is mapped, so nothing matched by name");
});
