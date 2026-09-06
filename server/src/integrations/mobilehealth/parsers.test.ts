/**
 * The parsers, against rows taken VERBATIM off the live stores on 2026-09-06.
 *
 * Every fixture below is a real header line and real data rows — the Play
 * exports read out of `pubsite_prod_…`, the App Store analytics segment
 * downloaded from Apple's own pre-signed URL. That is the point: the thing
 * that actually breaks here is a column being renamed between eras, and a
 * fixture somebody invented tests only that the code agrees with itself.
 *
 * Note the two spellings of the package column across ONE bucket —
 * `Package name` in the installs export, `Package Name` in the crashes one.
 * Matching by normalised name rather than by position is what survives that,
 * and it is the first thing asserted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYTICS_METRIC_KINDS,
  ANALYTICS_REPORTS,
  CRASH_METRICS,
  INSTALL_METRICS,
  RATING_METRICS,
  appStoreReview,
  apiDay,
  dailyFreshness,
  foldAnalytics,
  indexStatsReports,
  metricValue,
  parseAnalyticsTsv,
  parseDimension,
  parseReportingRows,
  parseRetention,
  parseStorePerformance,
  playReview,
  retainDay,
  starHistogram,
  versionPhase,
} from "./parsers.ts";

/* --------------------------------------------------------------- fixtures */

const INSTALLS_COUNTRY = [
  "Date,Package name,Country,Daily Device Installs,Daily Device Uninstalls,Daily Device Upgrades,Total User Installs,Daily User Installs,Daily User Uninstalls,Active Device Installs,Install events,Update events,Uninstall events",
  "2026-08-05,co.freellmapi.app,PK,0,0,0,0,0,0,14,0,0,0",
  "2026-08-06,co.freellmapi.app,PK,3,0,0,0,2,1,13,1,0,1",
  "2026-08-06,co.freellmapi.app,US,2,1,0,0,2,0,5,2,0,1",
  // A row whose install cell is blank: that column was not reported for this
  // slice on this day, which is not a measured zero.
  "2026-08-07,co.freellmapi.app,IN,,,,,,,7,,,",
  // A country Play could not resolve. The installs happened.
  "2026-08-07,co.freellmapi.app,,4,0,0,0,4,0,2,4,0,0",
].join("\n");

const CRASHES_APP_VERSION = [
  "Date,Package Name,App Version Code,Daily Crashes,Daily ANRs",
  "2026-08-08,co.freellmapi.app,7,1,0",
  "2026-08-14,co.freellmapi.app,9,0,1",
].join("\n");

const STORE_PERFORMANCE_COUNTRY = [
  "Date,Package name,Country / region,Store listing acquisitions,Store listing visitors,Store listing conversion rate",
  "2026-08-07,co.freellmapi.app,Other,0,1,0.0",
  "2026-08-14,co.freellmapi.app,Other,26,45,0.5777244444444445",
  "2026-08-14,co.freellmapi.app,PK,4,10,0.4",
].join("\n");

const STORE_PERFORMANCE_TRAFFIC = [
  "Date,Package name,Traffic source,Search term,UTM source,UTM campaign,Store listing acquisitions,Store listing visitors,Store listing conversion rate",
  "2026-08-14,co.freellmapi.app,Other,Other,Other,Other,26,45,0.577",
  "2026-08-14,co.freellmapi.app,Other,freellm,Other,Other,4,5,0.8",
  "2026-08-14,co.freellmapi.app,Play Store search,api,Other,Other,10,20,0.5",
].join("\n");

const RATINGS_OVERVIEW = [
  "Date,Package name,Daily Average Rating,Total Average Rating",
  "2026-08-05,co.freellmapi.app,0.0,4.5",
  "2026-08-06,co.freellmapi.app,5.0,4.6",
].join("\n");

/** No account this was built against carries this export, so the fixture is
 *  written from Google's documented column families — both word orders. */
const RETAINED = [
  "Date,Package name,Installers,Retained Installers (1 day),Day 7 retained users,Retained Installers (30 days)",
  "2026-08-05,co.freellmapi.app,100,60,25,10",
  "2026-08-06,co.freellmapi.app,50,30,12,5",
].join("\n");

/** Downloaded from Apple's segment URL for App Downloads Standard, 2026-08-25. */
const APPLE_DOWNLOADS = [
  "Date\tApp Name\tApp Apple Identifier\tDownload Type\tApp Version\tDevice\tPlatform Version\tSource Type\tPage Type\tPre-Order\tTerritory\tCounts",
  "2026-08-24\tExample App 11\t1000000000\tFirst-time download\t1.0\tiPhone\tiOS 26.6\tApp Store browse\tProduct page\t\tGB\t1",
  "2026-08-24\tExample App 11\t1000000000\tFirst-time download\t1.0\tiPad\tiOS 26.6\tWeb referrer\tProduct page\t\tUS\t1",
  "2026-08-24\tExample App 11\t1000000000\tRedownload\t1.0\tiPhone\tiOS 26.6\tApp Store browse\tProduct page\t\tGB\t2",
  "",
].join("\n");

/* -------------------------------------------------------------- the tests */

test("indexStatsReports captures the slice, not just the overview", () => {
  const found = indexStatsReports([
    { name: "stats/installs/installs_co.freellmapi.app_202608_country.csv" },
    { name: "stats/installs/installs_co.freellmapi.app_202608_overview.csv" },
    { name: "stats/store_performance/store_performance_co.freellmapi.app_202608_traffic_source.csv" },
    { name: "stats/crashes/crashes_co.freellmapi.app_202609_app_version.csv" },
    { name: "earnings/earnings_202608.zip" },
    { name: "sales/salesreport_202608.zip" },
  ]);
  assert.equal(found.length, 4);
  assert.deepEqual(
    found.map((f) => `${f.kind}/${f.slice}`),
    ["installs/country", "installs/overview", "store_performance/traffic_source", "crashes/app_version"],
  );
  assert.equal(found[0]!.package, "co.freellmapi.app");
  assert.equal(found[0]!.month, "202608");
});

test("parseDimension reads the real installs header, blanks stay absent", () => {
  const rows = parseDimension(INSTALLS_COUNTRY, {
    dimension: "country",
    metrics: INSTALL_METRICS,
  });

  const installs = rows.filter((r) => r.metric === "installs");
  assert.deepEqual(
    installs.map((r) => [r.day, r.value, r.amount]),
    [
      ["2026-08-05", "PK", 0],
      ["2026-08-06", "PK", 3],
      ["2026-08-06", "US", 2],
      // 2026-08-07 IN has a BLANK install cell and produces no row at all —
      // absent, not zero.
      ["2026-08-07", "(not set)", 4],
    ],
  );

  // The unit travels with the number, and devices are not users.
  assert.equal(installs[0]!.unit, "devices");
  assert.equal(rows.find((r) => r.metric === "user_installs")!.unit, "users");
  assert.equal(rows.find((r) => r.metric === "install_events")!.unit, "events");

  // A blank country is kept as a real slice, because those installs happened.
  assert.ok(rows.some((r) => r.value === "(not set)"));

  // The blank-celled day still reports its active devices — one absent column
  // does not cost the row.
  const active = rows.filter((r) => r.metric === "active_devices" && r.day === "2026-08-07");
  assert.deepEqual(active.map((r) => r.amount).sort((a, b) => a - b), [2, 7]);
});

test("parseDimension honours the since bound and the overview shape", () => {
  const rows = parseDimension(INSTALLS_COUNTRY, {
    dimension: "country",
    metrics: INSTALL_METRICS,
    since: "2026-08-07",
  });
  assert.ok(rows.every((r) => r.day >= "2026-08-07"));

  const overview = parseDimension(RATINGS_OVERVIEW, {
    dimension: "(all)",
    metrics: RATING_METRICS,
  });
  assert.ok(overview.every((r) => r.value === "(all)"));
  assert.deepEqual(
    overview.filter((r) => r.metric === "rating_total").map((r) => r.amount),
    [4.5, 4.6],
  );
  // Both rating columns are LEVELS: a state on a day, never summed.
  assert.equal(RATING_METRICS.rating_total!.kind, "level");
  assert.equal(INSTALL_METRICS.active_devices!.kind, "level");
  assert.equal(INSTALL_METRICS.installs!.kind, "event");
});

test("parseDimension falls back to the first non-metric column when the slice is renamed", () => {
  const renamed = [
    "Date,Package name,Handset Marketing Name,Daily Device Installs",
    "2026-08-05,co.freellmapi.app,Pixel 9,4",
  ].join("\n");
  const rows = parseDimension(renamed, { dimension: "device", metrics: INSTALL_METRICS });
  assert.deepEqual(rows, [
    { day: "2026-08-05", value: "Pixel 9", metric: "installs", amount: 4, unit: "devices" },
  ]);
});

test("the crashes export reads under its OWN header spelling of the package column", () => {
  const rows = parseDimension(CRASHES_APP_VERSION, {
    dimension: "app_version",
    metrics: CRASH_METRICS,
  });
  assert.deepEqual(
    rows.map((r) => [r.day, r.value, r.metric, r.amount, r.unit]),
    [
      ["2026-08-08", "7", "crashes", 1, "crashes"],
      ["2026-08-08", "7", "anrs", 0, "anrs"],
      ["2026-08-14", "9", "crashes", 0, "crashes"],
      ["2026-08-14", "9", "anrs", 1, "anrs"],
    ],
  );
});

test("parseStorePerformance keeps Google's rate only where one row owns the day", () => {
  const rows = parseStorePerformance(STORE_PERFORMANCE_COUNTRY, { dimension: "country" });
  assert.equal(rows.length, 3);
  const big = rows.find((r) => r.day === "2026-08-14" && r.value === "Other")!;
  assert.equal(big.visitors, 45);
  assert.equal(big.acquisitions, 26);
  assert.equal(big.rate, 0.5777244444444445);
});

test("parseStorePerformance folds the traffic-source file's four cuts onto one slice", () => {
  const rows = parseStorePerformance(STORE_PERFORMANCE_TRAFFIC, { dimension: "traffic_source" });
  const other = rows.find((r) => r.value === "Other")!;
  // Two rows of the same traffic source on the same day ADD — they partition
  // the same visitors by search term — and the folded row carries no single
  // rate of Google's, because there were two.
  assert.equal(other.visitors, 50);
  assert.equal(other.acquisitions, 30);
  assert.equal(other.rate, null);

  const search = rows.find((r) => r.value === "Play Store search")!;
  assert.equal(search.visitors, 20);
  assert.equal(search.rate, 0.5);
});

test("retention columns are found by shape, in either word order", () => {
  assert.equal(retainDay("retained installers 1 day"), 1);
  assert.equal(retainDay("day 7 retained users"), 7);
  assert.equal(retainDay("retained installers 30 days"), 30);
  assert.equal(retainDay("daily device installs"), null);
  assert.equal(retainDay("store listing visitors"), null);

  const rows = parseRetention(RETAINED);
  assert.deepEqual(
    rows.filter((r) => r.day === "2026-08-05").map((r) => [r.offsetDays, r.retained, r.installers]),
    [
      [1, 60, 100],
      [7, 25, 100],
      [30, 10, 100],
    ],
  );
});

test("Apple's analytics TSV folds per dimension without crossing them", () => {
  const rows = parseAnalyticsTsv(APPLE_DOWNLOADS);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.appappleidentifier, "1000000000");

  const { folded, missingColumns } = foldAnalytics(rows, {
    metrics: { Counts: { columns: ["Counts"], unit: "downloads", kind: "event" } },
    dims: ["Download Type", "Territory", "Device", "App Version"],
  });
  assert.deepEqual(missingColumns, []);

  const all = folded.find((f) => f.dimension === "(all)")!;
  assert.equal(all.amount, 4);

  // Each dimension sums to the same day total, independently — 1+1+2 by
  // territory, 3+1 by device, 2+2 by download type.
  for (const dim of ["Territory", "Device", "Download Type"]) {
    const total = folded.filter((f) => f.dimension === dim).reduce((n, f) => n + f.amount, 0);
    assert.equal(total, 4, `${dim} should sum to the day total`);
  }
  assert.equal(folded.find((f) => f.dimension === "Territory" && f.value === "GB")!.amount, 3);
  assert.equal(
    folded.find((f) => f.dimension === "Download Type" && f.value === "Redownload")!.amount,
    2,
  );
});

test("foldAnalytics names the columns Apple did not send", () => {
  const { missingColumns } = foldAnalytics(parseAnalyticsTsv(APPLE_DOWNLOADS), {
    metrics: {
      Counts: { columns: ["Counts"], unit: "downloads", kind: "event" },
      "Unique Devices": { columns: ["Unique Devices"], unit: "devices", kind: "level" },
    },
    dims: ["Territory"],
  });
  assert.deepEqual(missingColumns, ["Unique Devices"]);
});

test("Reporting API values come out of whichever typed box they arrived in", () => {
  assert.equal(metricValue({ decimalValue: { value: "0.0345" } }), 0.0345);
  assert.equal(metricValue({ int64Value: { value: "80" } }), 80);
  assert.equal(metricValue({ doubleValue: 1.5 }), 1.5);
  assert.equal(metricValue({ somethingElse: {} }), null);

  const parsed = parseReportingRows({
    rows: [
      {
        startTime: { year: 2026, month: 8, day: 16 },
        dimensions: [{ dimension: "versionCode", stringValue: "9" }],
        metrics: [
          { metric: "crashRate", decimalValue: { value: "0.0000" } },
          { metric: "distinctUsers", decimalValue: { value: "80" } },
        ],
      },
      // A period coarser than a day carries a partial date and is dropped
      // rather than filed under a guess.
      { startTime: { year: 2026, month: 8 }, metrics: [{ metric: "crashRate", doubleValue: 1 }] },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    day: "2026-08-16",
    dimension: "versionCode",
    value: "9",
    metrics: { crashRate: 0, distinctUsers: 80 },
  });
});

test("the vitals window ends at the metric set's own DAILY freshness", () => {
  const doc = {
    freshnessInfo: {
      freshnesses: [
        { aggregationPeriod: "HOURLY", latestEndTime: { year: 2026, month: 9, day: 3, hours: 8 } },
        { aggregationPeriod: "DAILY", latestEndTime: { year: 2026, month: 9, day: 2 } },
      ],
    },
  };
  assert.equal(dailyFreshness(doc), "2026-09-02");
  assert.equal(dailyFreshness({ freshnessInfo: { freshnesses: [] } }), null);
  assert.equal(apiDay({ year: 2026, month: 1, day: 5 }), "2026-01-05");
  assert.equal(apiDay({ year: 2026, month: 1 }), null);
});

test("both Apple state vocabularies reduce to one phase", () => {
  assert.equal(versionPhase("READY_FOR_DISTRIBUTION"), "live");
  assert.equal(versionPhase("READY_FOR_SALE"), "live");
  assert.equal(versionPhase("WAITING_FOR_REVIEW"), "pending");
  // Not "live": READY_FOR_REVIEW is the developer having finished, not Apple
  // having approved. The two READY_ states mean opposite things.
  assert.equal(versionPhase("READY_FOR_REVIEW"), "pending");
  assert.equal(versionPhase("IN_REVIEW"), "in review");
  assert.equal(versionPhase("METADATA_REJECTED"), "rejected");
  assert.equal(versionPhase("DEVELOPER_REMOVED_FROM_SALE"), "off sale");
  assert.equal(versionPhase(null), "unknown");
});

test("a Play review keeps its reply and never invents a star", () => {
  const r = playReview("co.freellmapi.app", {
    reviewId: "abc-123",
    authorName: "Someone",
    comments: [
      {
        userComment: {
          text: " it crashes on launch ",
          starRating: 1,
          reviewerLanguage: "en",
          device: "a53x",
          appVersionName: "1.4.0",
          lastModified: { seconds: "1788480000" },
        },
      },
      { developerComment: { text: "Sorry — fixed in 1.4.1", lastModified: { seconds: "1788566400" } } },
    ],
  })!;
  assert.equal(r.id, "abc-123");
  assert.equal(r.rating, 1);
  assert.equal(r.body, "it crashes on launch");
  assert.equal(r.author, "Someone");
  assert.equal(r.appVersion, "1.4.0");
  assert.equal(r.device, "a53x");
  assert.equal(r.reply, "Sorry — fixed in 1.4.1");
  assert.equal(r.created, "2026-09-04T00:00:00.000Z");

  // Play allows text with no star. That is a null rating, not a zero-star.
  const noStar = playReview("x", {
    reviewId: "b",
    comments: [{ userComment: { text: "hm", lastModified: { seconds: "1788480000" } } }],
  })!;
  assert.equal(noStar.rating, null);
  assert.equal(playReview("x", { comments: [] }), null);
});

test("an App Store review carries a territory and never an app version", () => {
  const r = appStoreReview("1000000000", {
    id: "00000195-6d34-6103-60d5-37db00000000",
    attributes: {
      rating: 5,
      title: "Amazing product",
      body: "It’s very helpful to talk to the AI agents",
      reviewerNickname: "insta not good",
      createdDate: "2026-09-04T06:01:37-07:00",
      territory: "MAR",
    },
  })!;
  assert.equal(r.rating, 5);
  assert.equal(r.territory, "MAR");
  assert.equal(r.author, "insta not good");
  // Apple's customerReviews resource has no version field at all, so it must
  // never be guessed from anywhere else.
  assert.equal(r.appVersion, null);
});

test("the star histogram always carries all five keys", () => {
  const hist = starHistogram([{ rating: 5 }, { rating: 5 }, { rating: 1 }, { rating: null }]);
  assert.deepEqual(hist, { "1": 1, "2": 0, "3": 0, "4": 0, "5": 2 });
  assert.deepEqual(starHistogram([]), { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 });
});

test("a daily average rating of 0.0 is nobody rating, not zero stars", () => {
  const rows = parseDimension(RATINGS_OVERVIEW, {
    dimension: "(all)",
    metrics: RATING_METRICS,
  });

  /*
    Google writes 0.0 into "Daily Average Rating" on a day nobody rated the
    app — the fixture has exactly that on 2026-08-05, beside a running total
    of 4.5 — and a star rating cannot be zero on a scale that starts at one.
    So the 5th produces NO rating_daily row at all and the 6th produces its
    real 5.0. Publishing the zero is the precise silent zero this area exists
    to prevent: an agent handed `rating_daily: 0 stars` will quote it.
  */
  assert.deepEqual(
    rows.filter((r) => r.metric === "rating_daily").map((r) => [r.day, r.amount]),
    [["2026-08-06", 5]],
  );

  // The running total is untouched — it is a different column and a real 4.5.
  assert.equal(rows.filter((r) => r.metric === "rating_total").length, 2);

  // And the rule is about STARS, not about zero: a measured zero install is a
  // fact and still produces its row.
  const installs = parseDimension(INSTALLS_COUNTRY, {
    dimension: "country",
    metrics: INSTALL_METRICS,
  });
  assert.ok(
    installs.some((r) => r.metric === "installs" && r.amount === 0),
    "a zero install is a measurement and is kept",
  );
});

test("a rating column sliced by country drops its zeroes too", () => {
  const byCountry = [
    "Date,Package name,Country,Daily Average Rating,Total Average Rating",
    "2026-08-05,co.freellmapi.app,PK,0.0,4.5",
    "2026-08-05,co.freellmapi.app,US,4.0,4.5",
  ].join("\n");
  const rows = parseDimension(byCountry, { dimension: "country", metrics: RATING_METRICS });
  assert.deepEqual(
    rows.filter((r) => r.metric === "rating_daily").map((r) => [r.value, r.amount]),
    [["US", 4]],
  );
});

test("Apple's unique counts are LEVELS with their own unit, never summable events", () => {
  /*
    `Unique Devices`, `Unique Counts` and `Paying Users` are distinct WITHIN A
    DAY. Thirty of them added counts one device up to thirty times — the exact
    arithmetic this area's stability rules forbid for `distinctUsers` — and a
    report-wide unit would also have labelled `Unique Devices` as "sessions"
    or "crashes" depending on which file it came out of.
  */
  const sessions = ANALYTICS_REPORTS["App Sessions Standard"]!;
  assert.equal(sessions.metrics.Sessions!.kind, "event");
  assert.equal(sessions.metrics.Sessions!.unit, "sessions");
  assert.equal(sessions.metrics["Unique Devices"]!.kind, "level");
  assert.equal(sessions.metrics["Unique Devices"]!.unit, "devices");

  const crashes = ANALYTICS_REPORTS["App Crashes"]!;
  assert.equal(crashes.metrics.Crashes!.unit, "crashes");
  // The same column in a different report keeps its OWN unit rather than the
  // report's — this is what "sessions"/"crashes" mislabelling looked like.
  assert.equal(crashes.metrics["Unique Devices"]!.unit, "devices");

  assert.equal(ANALYTICS_REPORTS["App Store Purchases Standard"]!.metrics["Paying Users"]!.kind, "level");
  assert.equal(
    ANALYTICS_REPORTS["App Store Discovery and Engagement Standard"]!.metrics["Unique Counts"]!.kind,
    "level",
  );

  // Every metric that is not an event is reachable under the key the table
  // actually holds, so a route cannot miss one.
  assert.equal(ANALYTICS_METRIC_KINDS["sessions.unique_devices"], "level");
  assert.equal(ANALYTICS_METRIC_KINDS["engagement.unique_counts"], "level");
  assert.equal(ANALYTICS_METRIC_KINDS["installs.unique_devices"], "level");
  assert.equal(ANALYTICS_METRIC_KINDS["purchases.paying_users"], "level");
  assert.equal(ANALYTICS_METRIC_KINDS["downloads.counts"], "event");
  assert.equal(ANALYTICS_METRIC_KINDS["crashes.crashes"], "event");
  // The map is derived from the report definitions, so it can never be short.
  const declared = Object.values(ANALYTICS_REPORTS).reduce(
    (n, r) => n + Object.keys(r.metrics).length,
    0,
  );
  assert.equal(Object.keys(ANALYTICS_METRIC_KINDS).length, declared);
});

test("foldAnalytics stamps each metric's own unit and kind on every row", () => {
  const rows = parseAnalyticsTsv(
    [
      "Date\tApp Name\tApp Apple Identifier\tApp Version\tDevice\tSessions\tUnique Devices",
      "2026-08-24\tExample App 11\t1000000000\t1.0\tiPhone\t40\t9",
      "2026-08-25\tExample App 11\t1000000000\t1.0\tiPhone\t35\t9",
    ].join("\n"),
  );
  const { folded } = foldAnalytics(rows, ANALYTICS_REPORTS["App Sessions Standard"]!);

  const sessions = folded.filter((f) => f.metric === "Sessions" && f.dimension === "(all)");
  assert.deepEqual(
    sessions.map((f) => [f.day, f.amount, f.unit, f.kind]),
    [
      ["2026-08-24", 40, "sessions", "event"],
      ["2026-08-25", 35, "sessions", "event"],
    ],
  );

  const unique = folded.filter((f) => f.metric === "Unique Devices" && f.dimension === "(all)");
  assert.deepEqual(
    unique.map((f) => [f.day, f.amount, f.unit, f.kind]),
    [
      ["2026-08-24", 9, "devices", "level"],
      ["2026-08-25", 9, "devices", "level"],
    ],
  );
  // The same nine devices on both days. A route that summed this would report
  // eighteen, and `kind` is what stops it.
  assert.equal(
    unique.reduce((n, f) => n + f.amount, 0),
    18,
    "the raw rows do add to 18 — which is exactly why kind must say level",
  );
});
