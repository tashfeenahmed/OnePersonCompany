/**
 * THE PARSERS — bytes to rows, and nothing else.
 *
 * Every function here is pure: it takes text that came out of a bucket or a
 * download and returns rows. No fetch, no database, no clock. That is what
 * makes them the only part of this area covered by unit tests with fixture
 * rows taken verbatim off the live account (see parsers.test.ts) — the shape
 * of Google's and Apple's CSVs is the thing that actually breaks, and it
 * breaks silently, six months later, when a column is renamed.
 *
 * COLUMNS ARE MATCHED BY NAME AND NEVER BY POSITION, for the reason
 * providers/play.ts gives at length: Google reorders and renames between eras
 * and Apple inserts columns in the middle. The one place that rule is relaxed
 * is the DIMENSION column of a sliced export, where a name this file has never
 * seen falls back to "the first column that is neither the date, the package,
 * nor a known metric" — in every export shape seen on the live account, that
 * column IS the slice.
 *
 * THE UNIT TRAVELS WITH THE NUMBER. Play's install slices count DEVICES; the
 * user columns beside them count USERS; Apple's download report counts
 * DOWNLOAD EVENTS with a privacy threshold under them. Three integers that
 * would look identical in a column called `installs`, so every row this file
 * emits carries the unit it was measured in and the tables store it.
 *
 * A LEVEL IS NOT AN EVENT. "Active device installs" and "Total average
 * rating" are states of the world on a day; installs and crashes are things
 * that happened. Summing the first kind over a window counts the same phone
 * once per day, so each metric declares its kind here and the routes read it
 * rather than guessing from the name.
 */
import { number, parseCsv } from "../../providers/play.ts";

/** "Daily Device Installs", "daily_device_installs" and "Package name" all
 *  normalise to one spelling. Same rule providers/play.ts uses. */
export const normHeader = (h: string) =>
  h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The first candidate this era's file actually carries, or -1. */
export function column(head: string[], candidates: readonly string[]): number {
  for (const c of candidates) {
    const i = head.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ metrics */

export type MetricKind = "event" | "level";

export type MetricSpec = {
  /** The column names this metric has been called, newest era first. */
  columns: readonly string[];
  /** What one unit of it is. Stored beside every row. */
  unit: string;
  /** Summable over a window, or a state of the world on one day. */
  kind: MetricKind;
};

/**
 * The install-export metrics, as the live bucket writes them (headers read off
 * `stats/installs/installs_<pkg>_202608_country.csv` on 2026-09-06).
 *
 * DEVICES AND USERS ARE BOTH HERE AND ARE NOT THE SAME COUNT. Google exports
 * both and they differ — one person with a phone and a tablet is two devices
 * and one user — so both are kept under their own names with their own unit
 * rather than one being chosen and the difference thrown away.
 */
export const INSTALL_METRICS: Record<string, MetricSpec> = {
  installs: { columns: ["daily device installs"], unit: "devices", kind: "event" },
  uninstalls: { columns: ["daily device uninstalls"], unit: "devices", kind: "event" },
  upgrades: { columns: ["daily device upgrades"], unit: "devices", kind: "event" },
  user_installs: { columns: ["daily user installs"], unit: "users", kind: "event" },
  user_uninstalls: { columns: ["daily user uninstalls"], unit: "users", kind: "event" },
  install_events: { columns: ["install events"], unit: "events", kind: "event" },
  update_events: { columns: ["update events"], unit: "events", kind: "event" },
  uninstall_events: { columns: ["uninstall events"], unit: "events", kind: "event" },
  active_devices: {
    columns: ["active device installs", "daily active devices"],
    unit: "devices",
    kind: "level",
  },
  total_user_installs: { columns: ["total user installs"], unit: "users", kind: "level" },
};

/** The ratings export's two columns. Both are levels: an average is a state,
 *  and thirty of them added is a number in no unit at all. */
export const RATING_METRICS: Record<string, MetricSpec> = {
  rating_daily: { columns: ["daily average rating"], unit: "stars", kind: "level" },
  rating_total: { columns: ["total average rating"], unit: "stars", kind: "level" },
};

/** The crash export's two columns. COUNTS, with no denominator — the rate
 *  lives in the Reporting API and is a different measurement. */
export const CRASH_METRICS: Record<string, MetricSpec> = {
  crashes: { columns: ["daily crashes", "crashes"], unit: "crashes", kind: "event" },
  anrs: { columns: ["daily anrs", "daily anr", "anrs"], unit: "anrs", kind: "event" },
};

/**
 * The dimension column, per slice, as the live files name it.
 *
 * `traffic_source` deliberately maps to the Traffic source column alone even
 * though that file carries four dimension columns (traffic source, search
 * term, UTM source, UTM campaign). The four together partition the same
 * visitors, so summing the rows of one traffic source over the other three is
 * the right total rather than a double count — and publishing all four as one
 * composite key would produce a slice nobody can read.
 */
export const DIMENSION_COLUMNS: Record<string, readonly string[]> = {
  country: ["country", "country region", "region"],
  device: ["device", "device model", "marketing name", "model"],
  os_version: ["android os version", "os version", "android version", "api level"],
  carrier: ["carrier"],
  language: ["language"],
  app_version: ["app version code", "app version"],
  traffic_source: ["traffic source"],
};

/** Columns that are never the slice. Everything a metric can be called, plus
 *  the date and the package, plus the store-performance columns. */
const NOT_A_DIMENSION = new Set<string>([
  "date",
  "package name",
  "package",
  "app",
  "app name",
  "store listing visitors",
  "store listing acquisitions",
  "store listing conversion rate",
  ...Object.values(INSTALL_METRICS).flatMap((m) => m.columns),
  ...Object.values(RATING_METRICS).flatMap((m) => m.columns),
  ...Object.values(CRASH_METRICS).flatMap((m) => m.columns),
]);

/* -------------------------------------------------------------- the objects */

/**
 * Every stats export in a listing, indexed by its own name.
 *
 * `stats/<folder>/<folder>_<package>_<yyyymm>_<slice>.csv`. The loose form
 * drops the assertion that the folder and the file prefix agree, because they
 * have not always. Capturing the SLICE rather than hardcoding `overview` is
 * the whole of the difference between this area and the one that came before
 * it: the bucket has carried `_country`, `_device`, `_os_version`,
 * `_carrier`, `_language` and `_app_version` all along.
 */
const REPORT_RE = /^stats\/([a-z_]+)\/[a-z_]+_(.+)_(\d{6})_([a-z0-9_]+)\.csv$/;

export type StatsReport = {
  kind: string;
  package: string;
  month: string;
  slice: string;
  object: string;
  updated?: string;
};

export function indexStatsReports(
  objects: { name: string; updated?: string }[],
): StatsReport[] {
  const out: StatsReport[] = [];
  for (const o of objects) {
    const m = REPORT_RE.exec(o.name);
    if (m)
      out.push({
        kind: m[1]!,
        package: m[2]!,
        month: m[3]!,
        slice: m[4]!,
        object: o.name,
        updated: o.updated,
      });
  }
  return out;
}

/* ----------------------------------------------------------- sliced exports */

export type DimensionRow = {
  day: string;
  value: string;
  metric: string;
  amount: number;
  unit: string;
};

/**
 * One sliced (or overview) CSV to (day, slice value, metric) rows.
 *
 * AN EMPTY SLICE CELL IS A REAL SLICE, not a row to drop. Play cannot always
 * resolve a country or a carrier and writes the cell blank; those installs
 * happened, so they are labelled `(not set)` and kept. Dropping them makes the
 * slices silently fail to add up to the overview.
 *
 * A BLANK OR "NA" NUMBER PRODUCES NO ROW AT ALL, which is how a metric this
 * era's file does not carry stays absent rather than becoming a measured zero.
 * A written zero is kept: Google means it.
 *
 * `dimension` of `"(all)"` is how an overview file is read by the same
 * function — one code path, and the overview is simply the export with one
 * slice in it.
 */
export function parseDimension(
  text: string,
  opts: {
    dimension: string;
    metrics: Record<string, MetricSpec>;
    /** Only rows on or after this day. Omitted, every dated row counts. */
    since?: string;
  },
): DimensionRow[] {
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map(normHeader);
  const di = column(head, ["date"]);
  if (di < 0) return [];

  let vi = -1;
  if (opts.dimension !== "(all)") {
    vi = column(head, DIMENSION_COLUMNS[opts.dimension] ?? [opts.dimension]);
    if (vi < 0)
      // Named differently in this era. The slice is the first column that is
      // neither the date, the package nor a metric — true of every export
      // shape seen. Giving up here would throw the whole file away over a
      // heading.
      vi = head.findIndex((h) => h && !NOT_A_DIMENSION.has(h));
    if (vi < 0) return [];
  }

  const found: [string, number, MetricSpec][] = [];
  for (const [key, spec] of Object.entries(opts.metrics)) {
    const i = column(head, spec.columns);
    if (i >= 0) found.push([key, i, spec]);
  }
  if (!found.length) return [];

  const out: DimensionRow[] = [];
  for (const row of rows) {
    const day = (row[di] ?? "").trim();
    if (!day) continue;
    if (opts.since && day < opts.since) continue;
    const value = vi < 0 ? "(all)" : (row[vi] ?? "").trim() || "(not set)";
    for (const [metric, i, spec] of found) {
      const amount = number(row[i]);
      if (amount === null) continue;
      /*
        ZERO STARS IS NOT THE AVERAGE OF NO RATINGS. Google writes `0.0` into
        "Daily Average Rating" on a day nobody rated the app — the fixture in
        parsers.test.ts has exactly that beside a running total of 4.5 — and a
        star rating cannot be zero on a scale that starts at one. So a rating
        of exactly zero is read as "nobody rated it" and produces no row at
        all, which is what `providers/play.ts` does with the same column in
        the overview export. This is the precise silent zero this area exists
        to prevent: an agent handed `rating_daily: 0 stars` will quote it.
      */
      if (spec.unit === "stars" && amount === 0) continue;
      out.push({ day, value, metric, amount, unit: spec.unit });
    }
  }
  return out;
}

/* --------------------------------------------------------- store performance */

export type StorePerformanceRow = {
  day: string;
  value: string;
  visitors: number | null;
  acquisitions: number | null;
  /** The rate GOOGLE wrote on that row, kept only so ours can be checked
   *  against it. Never averaged across days — see the table comment. */
  rate: number | null;
};

const VISITOR_COLS = [
  "store listing visitors",
  "store listing visitors unique users",
  "total store visitors",
  "listing visitors",
  "visitors",
];
const ACQUISITION_COLS = [
  "store listing acquisitions",
  "store listing acquisitions unique users",
  "total store acquisitions",
  "listing acquisitions",
  "installers",
  "acquisitions",
];

/**
 * `stats/store_performance/` to (day, slice) rows.
 *
 * THE ROWS ARE FOLDED ON (day, slice) BEFORE THEY LEAVE. The traffic-source
 * file is cut four ways — traffic source, search term, UTM source, UTM
 * campaign — so one traffic source appears on several rows of one day, and a
 * table keyed on (day, traffic source) would otherwise keep whichever row
 * happened to be written last. They partition the same visitors, so they add.
 */
export function parseStorePerformance(
  text: string,
  opts: { dimension: string; since?: string },
): StorePerformanceRow[] {
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map(normHeader);
  const di = column(head, ["date"]);
  if (di < 0) return [];
  let vi = column(head, DIMENSION_COLUMNS[opts.dimension] ?? [opts.dimension]);
  if (vi < 0) vi = head.findIndex((h) => h && !NOT_A_DIMENSION.has(h));
  const wi = column(head, VISITOR_COLS);
  const ai = column(head, ACQUISITION_COLS);
  const ri = column(head, ["store listing conversion rate", "conversion rate"]);
  if (wi < 0 && ai < 0) return [];

  const acc = new Map<string, StorePerformanceRow>();
  for (const row of rows) {
    const day = (row[di] ?? "").trim();
    if (!day) continue;
    if (opts.since && day < opts.since) continue;
    const value = vi < 0 ? "(all)" : (row[vi] ?? "").trim() || "(not set)";
    const key = `${day} ${value}`;
    const held =
      acc.get(key) ?? { day, value, visitors: null, acquisitions: null, rate: null };
    const v = wi >= 0 ? number(row[wi]) : null;
    const a = ai >= 0 ? number(row[ai]) : null;
    if (v !== null) held.visitors = (held.visitors ?? 0) + v;
    if (a !== null) held.acquisitions = (held.acquisitions ?? 0) + a;
    // Google's own rate is kept only from a row that HAS one, and only when
    // this (day, slice) is a single row — folded rows have no single rate.
    const r = ri >= 0 ? number(row[ri]) : null;
    held.rate = acc.has(key) ? null : r;
    acc.set(key, held);
  }
  return [...acc.values()];
}

/* ------------------------------------------------------------- retention */

export type RetentionRow = {
  day: string;
  offsetDays: number;
  retained: number | null;
  installers: number | null;
};

/** "Retained Installers (1 day)" and "Day 1 retained users" both mean day 1.
 *  Found by SHAPE because this is the least predictable header family in the
 *  whole export, and in either word order. */
const RETAIN_DAYS_RE = /(\d+)\s*days?\b|\bdays?\s*(\d+)\b/;

export function retainDay(header: string): number | null {
  if (!header.includes("retain")) return null;
  const m = RETAIN_DAYS_RE.exec(header);
  if (!m) return null;
  const n = Number(m[1] ?? m[2]);
  return Number.isInteger(n) ? n : null;
}

/**
 * `stats/retained_installers/` to (day, curve point) rows.
 *
 * THE DENOMINATOR COMES OUT OF THE SAME FILE. A retention rate computed
 * against the install count from a different export would be a ratio of two
 * different cohorts measured two different ways; the installers column beside
 * the retained one is the cohort those retained users came from.
 *
 * This returns [] on the account this was written against, because the bucket
 * has no such folder at all. That is reported as "report not present in
 * bucket" and never as a curve of zeroes.
 */
export function parseRetention(text: string, since?: string): RetentionRow[] {
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map(normHeader);
  const di = column(head, ["date"]);
  if (di < 0) return [];

  const cols: [number, number][] = [];
  head.forEach((h, i) => {
    const day = retainDay(h);
    if (day !== null) cols.push([day, i]);
  });
  if (!cols.length) return [];

  const ii = column(head, [
    "installers",
    "new installers",
    "store listing acquisitions",
    ...INSTALL_METRICS.installs!.columns,
  ]);

  const out: RetentionRow[] = [];
  for (const row of rows) {
    const day = (row[di] ?? "").trim();
    if (!day) continue;
    if (since && day < since) continue;
    const installers = ii >= 0 ? number(row[ii]) : null;
    for (const [offsetDays, i] of cols)
      out.push({ day, offsetDays, retained: number(row[i]), installers });
  }
  return out;
}

/* --------------------------------------------- App Store Connect analytics */

/**
 * The analytics reports this area asks Apple for, by Apple's EXACT report
 * name as `/v1/analyticsReportRequests/<id>/reports` lists them (read off the
 * live account on 2026-09-06, which offers 156 of them).
 *
 * Standard rather than Detailed where both exist: the same totals with fewer
 * dimensions, which is what a dashboard can draw. `App Crashes` is here for
 * stability; on the account this was written against it exists and has ZERO
 * instances, which is reported as such rather than as a crash count of zero.
 */
export const ANALYTICS_REPORTS: Record<
  string,
  { key: string; metrics: Record<string, MetricSpec>; dims: readonly string[] }
> = {
  "App Downloads Standard": {
    key: "downloads",
    metrics: { Counts: { columns: ["Counts"], unit: "downloads", kind: "event" } },
    dims: ["Download Type", "Source Type", "Territory", "Device", "App Version"],
  },
  "App Store Installation and Deletion Standard": {
    key: "installs",
    metrics: {
      Counts: { columns: ["Counts"], unit: "events", kind: "event" },
      "Unique Devices": { columns: ["Unique Devices"], unit: "devices", kind: "level" },
    },
    dims: ["Event", "Download Type", "Territory"],
  },
  "App Store Discovery and Engagement Standard": {
    key: "engagement",
    metrics: {
      Counts: { columns: ["Counts"], unit: "events", kind: "event" },
      "Unique Counts": { columns: ["Unique Counts"], unit: "unique users", kind: "level" },
    },
    dims: ["Event", "Page Type", "Source Type", "Territory"],
  },
  "App Store Purchases Standard": {
    key: "purchases",
    metrics: {
      Sales: { columns: ["Sales"], unit: "sales", kind: "event" },
      Purchases: { columns: ["Purchases"], unit: "purchases", kind: "event" },
      "Paying Users": { columns: ["Paying Users"], unit: "users", kind: "level" },
    },
    dims: ["Purchase Type", "Source Type", "Territory"],
  },
  "App Sessions Standard": {
    key: "sessions",
    metrics: {
      Sessions: { columns: ["Sessions"], unit: "sessions", kind: "event" },
      "Unique Devices": { columns: ["Unique Devices"], unit: "devices", kind: "level" },
    },
    dims: ["App Version", "Device"],
  },
  "App Crashes": {
    key: "crashes",
    metrics: {
      Crashes: { columns: ["Crashes"], unit: "crashes", kind: "event" },
      "Unique Devices": { columns: ["Unique Devices"], unit: "devices", kind: "level" },
    },
    dims: ["App Version", "Device"],
  },
};

/** "Unique Devices" -> "unique_devices". The spelling `mobile_dimensions`
 *  actually holds, so a route never has to guess whether Apple called a slice
 *  `Territory` or `territory`. */
export const snake = (s: string) =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * Every Apple analytics metric this area stores, keyed exactly as the table
 * holds it (`<report key>.<metric>`), with whether it may be summed over days.
 *
 * DERIVED FROM ANALYTICS_REPORTS rather than written out, so a metric added
 * above cannot be forgotten here — which is how `engagement.unique_counts`
 * came to be summed as an event in the first place.
 */
export const ANALYTICS_METRIC_KINDS: Record<string, MetricKind> = Object.fromEntries(
  Object.values(ANALYTICS_REPORTS).flatMap((r) =>
    Object.entries(r.metrics).map(([m, spec]) => [`${r.key}.${snake(m)}`, spec.kind] as const),
  ),
);

/** Apple's analytics CSVs are tab separated with a header row. Headers are
 *  normalised the same way `providers/appstore.ts` normalises report headers,
 *  so "Download Type" and "Platform Version" survive punctuation drift. */
export const normAnalytics = (h: string) =>
  h.replace(/\(.*?\)/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export type AnalyticsRow = Record<string, string>;

export function parseAnalyticsTsv(text: string): AnalyticsRow[] {
  const lines = text.split(/\r?\n/);
  const head = lines.shift();
  if (!head) return [];
  const keys = head.split("\t").map(normAnalytics);
  const out: AnalyticsRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    if (cells[0]?.trim().toLowerCase().startsWith("total")) continue;
    const row: AnalyticsRow = {};
    keys.forEach((k, i) => (row[k] = (cells[i] ?? "").trim()));
    out.push(row);
  }
  return out;
}

export type AnalyticsFold = {
  day: string;
  dimension: string;
  value: string;
  metric: string;
  amount: number;
  /** What one of these is — devices, sessions, downloads, users. Per METRIC,
   *  never per report: one Apple report carries both a count of events and a
   *  count of the distinct devices behind them. */
  unit: string;
  /** Whether it may be summed over days at all. See below. */
  kind: MetricKind;
};

/**
 * One report's rows folded onto (day, dimension, value, metric).
 *
 * THE DIMENSIONS ARE CROSSED IN THE FILE AND ARE PUBLISHED SEPARATELY. Apple
 * writes one row per combination — territory × device × source × download type
 * — so each dimension's rows are summed over the others independently. Summing
 * a dimension gives the day's total for that metric; summing ACROSS two
 * dimensions counts every row twice, and nothing in this area does it.
 *
 * A UNIQUE COUNT IS A LEVEL AND MUST NOT BE ADDED ACROSS DAYS. Apple's
 * `Unique Devices`, `Unique Counts` and `Paying Users` are distinct WITHIN A
 * DAY: thirty of them added counts one device up to thirty times, which is
 * exactly the arithmetic this area's own stability rule forbids for
 * `distinctUsers`. So the metric declares its kind here and the routes read
 * it; a report-wide unit would also have labelled `Unique Devices` as
 * "sessions" or "crashes" depending on which file it came out of.
 *
 * WITHIN ONE DAY THEY DO ADD ACROSS A DIMENSION'S SLICES — which is Apple's
 * own arithmetic and is not exact for a unique count (one device can appear in
 * two territories). That is a property of a privacy-thresholded export and is
 * why the `(all)` row is published beside the breakdown: it is Apple's own
 * per-day figure, not our sum of its slices.
 *
 * A row with no readable date is dropped: Apple's files carry a footer in some
 * eras and a dateless row cannot be filed anywhere honest.
 */
export function foldAnalytics(
  rows: AnalyticsRow[],
  spec: { metrics: Record<string, MetricSpec>; dims: readonly string[] },
): { folded: AnalyticsFold[]; missingColumns: string[] } {
  const metricKeys = Object.entries(spec.metrics).map(
    ([m, s]) => [normAnalytics(s.columns[0] ?? m), m, s] as const,
  );
  const dimKeys = spec.dims.map((d) => [normAnalytics(d), d] as const);
  const acc = new Map<string, AnalyticsFold>();
  const missing = new Set<string>();

  for (const r of rows) {
    const day = (r.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const [mk, metric, ms] of metricKeys) {
      if (!(mk in r)) {
        missing.add(metric);
        continue;
      }
      const amount = Number((r[mk] ?? "").replace(/,/g, ""));
      if (!Number.isFinite(amount)) continue;
      // The day's own total, under the synthetic "(all)" dimension, so a
      // series can be drawn without re-summing a breakdown that may have been
      // thresholded differently.
      add(acc, day, "(all)", "(all)", metric, amount, ms);
      for (const [dk, dim] of dimKeys) {
        if (!(dk in r)) continue;
        add(acc, day, dim, (r[dk] ?? "").trim() || "(blank)", metric, amount, ms);
      }
    }
  }
  return { folded: [...acc.values()], missingColumns: [...missing].sort() };
}

function add(
  acc: Map<string, AnalyticsFold>,
  day: string,
  dimension: string,
  value: string,
  metric: string,
  amount: number,
  spec: MetricSpec,
) {
  const key = `${day} ${dimension} ${value} ${metric}`;
  const held = acc.get(key);
  if (held) held.amount = Number((held.amount + amount).toFixed(4));
  else acc.set(key, { day, dimension, value, metric, amount, unit: spec.unit, kind: spec.kind });
}

/* ------------------------------------------------- Play Developer Reporting */

/**
 * One `MetricValue` to a plain number.
 *
 * The API wraps values in a typed box — decimalValue / int64Value /
 * doubleValue — and each box is `{ "value": "0.0000" }` with the number as a
 * STRING. Which box it uses depends on the metric, so all of them are tried
 * rather than one being assumed.
 */
export function metricValue(m: Record<string, unknown>): number | null {
  for (const key of ["decimalValue", "int64Value", "doubleValue", "value"]) {
    let v: unknown = m[key];
    if (v && typeof v === "object") v = (v as { value?: unknown }).value;
    if (v === null || v === undefined || typeof v === "boolean") continue;
    const n = typeof v === "number" ? v : Number(String(v));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export type ReportingRow = {
  day: string;
  dimension: string;
  value: string;
  metrics: Record<string, number>;
};

type ApiDate = { year?: number; month?: number; day?: number };

/** `{year, month, day}` to `YYYY-MM-DD`, or null when the API sent a partial
 *  date (it does, for periods coarser than a day). */
export function apiDay(d: ApiDate | undefined): string | null {
  if (!d?.year || !d.month || !d.day) return null;
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** A `:query` response to dated rows. Rows with no usable date or no readable
 *  metric are dropped rather than filed under a guess. */
export function parseReportingRows(doc: {
  rows?: {
    startTime?: ApiDate;
    dimensions?: { dimension?: string; stringValue?: string; int64Value?: string }[];
    metrics?: Record<string, unknown>[];
  }[];
}): ReportingRow[] {
  const out: ReportingRow[] = [];
  for (const r of doc.rows ?? []) {
    const day = apiDay(r.startTime);
    if (!day) continue;
    const dim = r.dimensions?.[0];
    const metrics: Record<string, number> = {};
    for (const m of r.metrics ?? []) {
      const name = m.metric;
      if (typeof name !== "string") continue;
      const v = metricValue(m);
      if (v !== null) metrics[name] = v;
    }
    if (!Object.keys(metrics).length) continue;
    out.push({
      day,
      dimension: dim?.dimension ?? "(all)",
      value: dim?.stringValue ?? dim?.int64Value ?? "(all)",
      metrics,
    });
  }
  return out;
}

/**
 * The day a metric set's DAILY data actually ends.
 *
 * The window does not end today and saying so is the point: a reader comparing
 * a crash rate against yesterday's release needs to know the vitals stop
 * several days back. Null when the API publishes no DAILY freshness, and the
 * caller then says the window end was guessed rather than pretending it knew.
 */
export function dailyFreshness(doc: {
  freshnessInfo?: { freshnesses?: { aggregationPeriod?: string; latestEndTime?: ApiDate }[] };
}): string | null {
  for (const f of doc.freshnessInfo?.freshnesses ?? [])
    if (f.aggregationPeriod === "DAILY") return apiDay(f.latestEndTime);
  return null;
}

/* -------------------------------------------------------------- versions */

/** Apple's two state vocabularies reduced to one word a person can act on.
 *  DERIVED, and labelled as derived everywhere it is published. */
export function versionPhase(state: string | null | undefined): string {
  const s = (state ?? "").toUpperCase();
  if (!s) return "unknown";
  if (s === "READY_FOR_SALE" || s === "READY_FOR_DISTRIBUTION") return "live";
  if (s.includes("REJECT") || s === "INVALID_BINARY") return "rejected";
  if (s.includes("IN_REVIEW") || s === "PENDING_APPLE_RELEASE") return "in review";
  if (
    s === "READY_FOR_REVIEW" ||
    s.includes("WAITING") ||
    s.includes("PREPARE") ||
    s.includes("PENDING") ||
    s === "PROCESSING_FOR_APP_STORE" ||
    s === "PROCESSING_FOR_DISTRIBUTION"
  )
    return "pending";
  if (s.includes("REMOVED") || s === "DEVELOPER_REMOVED_FROM_SALE") return "off sale";
  return "other";
}

/* --------------------------------------------------------------- reviews */

export type ReviewRecord = {
  store: "play" | "appstore";
  app: string;
  id: string;
  rating: number | null;
  title: string | null;
  body: string | null;
  author: string | null;
  language: string | null;
  territory: string | null;
  appVersion: string | null;
  device: string | null;
  created: string | null;
  updated: string | null;
  reply: string | null;
  repliedAt: string | null;
};

const clean = (v: unknown) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
};

/** Seconds since the epoch, as Play sends them (a string), to an ISO instant. */
export function epochSeconds(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/**
 * One `androidpublisher` review to a stored row.
 *
 * A Play review is a THREAD: `comments[]` holds the user's comment and, if
 * somebody answered it in the console, the developer's reply. Both are read —
 * the reply so a triage list does not re-file something already answered — and
 * neither is ever written by this area.
 */
export function playReview(app: string, r: Record<string, unknown>): ReviewRecord | null {
  const id = clean(r.reviewId);
  if (!id) return null;
  const comments = Array.isArray(r.comments) ? (r.comments as Record<string, unknown>[]) : [];
  const user = (comments.find((c) => c.userComment)?.userComment ?? {}) as Record<string, unknown>;
  const dev = (comments.find((c) => c.developerComment)?.developerComment ?? {}) as Record<
    string,
    unknown
  >;
  const rating = typeof user.starRating === "number" ? user.starRating : null;
  return {
    store: "play",
    app,
    id,
    rating,
    title: null,
    body: clean(user.text),
    author: clean(r.authorName),
    language: clean(user.reviewerLanguage),
    territory: null,
    appVersion: clean(user.appVersionName),
    device: clean(user.device),
    created: epochSeconds((user.lastModified as { seconds?: unknown })?.seconds),
    updated: epochSeconds((user.lastModified as { seconds?: unknown })?.seconds),
    reply: clean(dev.text),
    repliedAt: epochSeconds((dev.lastModified as { seconds?: unknown })?.seconds),
  };
}

/** One App Store Connect `customerReviews` resource to a stored row. */
export function appStoreReview(
  app: string,
  r: { id?: unknown; attributes?: Record<string, unknown> },
): ReviewRecord | null {
  const id = clean(r.id);
  if (!id) return null;
  const a = r.attributes ?? {};
  const rating = typeof a.rating === "number" ? a.rating : null;
  const created = clean(a.createdDate);
  return {
    store: "appstore",
    app,
    id,
    rating,
    title: clean(a.title),
    body: clean(a.body),
    author: clean(a.reviewerNickname),
    language: null,
    territory: clean(a.territory),
    appVersion: null,
    device: null,
    created,
    updated: created,
    reply: null,
    repliedAt: null,
  };
}

/** Stars 1–5, always all five keys. A breakdown that omits the stars nobody
 *  gave makes "no one-star reviews" and "we did not look" the same shape. */
export function starHistogram(rows: { rating: number | null }[]): Record<string, number> {
  const hist: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  for (const r of rows) {
    const n = r.rating;
    if (typeof n !== "number") continue;
    const b = String(Math.round(n));
    if (b in hist) hist[b] = hist[b]! + 1;
  }
  return hist;
}
