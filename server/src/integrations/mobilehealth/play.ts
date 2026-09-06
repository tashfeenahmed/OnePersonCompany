/**
 * ANDROID HEALTH — three grants against one key file, probed apart.
 *
 * providers/play.ts reads the console's report bucket and says, in its own
 * header, that it deliberately calls neither the Android Publisher API nor the
 * Play Developer Reporting API: each is a separate enablement on the Cloud
 * project and a separate grant in the Play Console, and either can be missing
 * on its own. This file is the other three quarters of that sentence — and it
 * keeps the promise the same way, by minting a SEPARATE TOKEN PER SCOPE.
 *
 *   devstorage.read_only      the bucket: install slices, store performance,
 *                             retained installers, crash and ANR COUNTS
 *   playdeveloperreporting    crash and ANR RATES, daily, by version code
 *   androidpublisher          reviews, last seven days and no further
 *
 * WHY SEPARATE TOKENS AND NOT ONE WITH THREE SCOPES. A single assertion asking
 * for a scope the project has not enabled fails at Google's token endpoint,
 * and the failure takes every scope on it down together. One token per scope
 * means the worst an unavailable API can do is cost its own block: a project
 * with the Reporting API switched off still gets its installs, its segments,
 * its store performance and its reviews, and the exact refusal is written into
 * `mobile_health_probes` where a card can read it back.
 *
 * THE BUCKET IS THE ONLY PLACE ANDROID CRASH COUNTS EXIST FOR A SMALL APP.
 * Probed on 2026-09-06 against the live account, `stats/crashes/` carries
 * daily crash and ANR counts sliced by app version, device and OS version for
 * an app whose Reporting-API rate is 0.0000 with a confidence interval up to
 * 0.0345 — the count is the concrete fact and the rate is the modelled one.
 * Both are ingested, under different `source` and different `unit`, and
 * nothing puts them on one axis.
 *
 * SEVEN DAYS IS ALL THE REVIEWS API WILL EVER RETURN. `reviews.list` has no
 * date parameter and no way to page backwards; Google's own documentation and
 * the live account agree. So `mobile_reviews` is an ACCUMULATOR on the Android
 * side and every count drawn from it is "what the runs have caught", never the
 * app's all-time review count. The skill rules say so in those words.
 */
import * as accounts from "../../accounts.ts";
import {
  accessToken,
  decodeReport,
  fetchObject,
  listObjects,
  normaliseBucket,
  readServiceAccount,
  PlayError,
  type GcsObject,
} from "../../providers/play.ts";
import {
  CRASH_METRICS,
  INSTALL_METRICS,
  RATING_METRICS,
  dailyFreshness,
  indexStatsReports,
  parseDimension,
  parseReportingRows,
  parseRetention,
  parseStorePerformance,
  playReview,
  type MetricSpec,
  type StatsReport,
} from "./parsers.ts";
import * as store from "./store.ts";

const REPORTING = "https://playdeveloperreporting.googleapis.com/v1beta1";
const PUBLISHER = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const REPORTING_SCOPE = "https://www.googleapis.com/auth/playdeveloperreporting";
const PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TIMEOUT_MS = 45_000;
const USER_AGENT = "onepersoncompany-collector/1.0";

/**
 * How far back the sliced exports are read.
 *
 * Sixty days rather than the whole bucket: Google rewrites the running month
 * daily and revises the previous one for a few days, and every card here is
 * drawn over thirty. Two months of files, filtered to sixty days of rows.
 */
export const HEALTH_DAYS = 60;

/** The slices asked for, per folder. A slice the bucket does not carry is not
 *  an error — it is written down as `absent` and the route says so. */
const INSTALL_SLICES = [
  "country",
  "device",
  "os_version",
  "carrier",
  "language",
  "app_version",
] as const;
const CRASH_SLICES = ["overview", "app_version", "device", "os_version"] as const;
const PERFORMANCE_SLICES = ["country", "traffic_source"] as const;

/**
 * The crash/ANR window asked of the Reporting API, in days.
 *
 * Twenty-eight is Play's own vitals unit — the console's headline crash rate
 * is a 28-day user-weighted figure — so asking for the same span makes this
 * box's daily rows and the console's headline talk about the same period.
 */
export const VITALS_DAYS = 28;

export type PlayHealthResult = {
  accountId: number;
  label: string;
  ok: boolean;
  error?: string;
  packages: string[];
  /** Rows written, per block, so a run note can say what actually landed. */
  wrote: Record<string, number>;
  probes: { probe: string; ok: boolean; status?: number | null; error?: string | null }[];
  notes: string[];
};

const isoDay = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** A `YYYY-MM` list covering the window, newest last, in the bucket's own
 *  `YYYYMM` spelling. */
function monthsInWindow(days: number): string[] {
  const out = new Set<string>();
  for (let i = 0; i <= days; i += 1)
    out.add(isoDay(i).slice(0, 7).replace("-", ""));
  return [...out].sort();
}

/* ------------------------------------------------------------------ tokens */

/** A token for one scope, or the refusal as data. Never throws: a scope the
 *  project has not enabled is a finding, and the caller records it. */
async function tokenFor(
  sa: Parameters<typeof accessToken>[0],
  scope: string,
): Promise<{ token: string } | { error: string; status: number | null }> {
  try {
    return { token: await accessToken(sa, scope) };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
      status: err instanceof PlayError ? err.status : null,
    };
  }
}

async function callJson(
  url: string,
  token: string,
  body?: unknown,
): Promise<{ ok: true; doc: Record<string, unknown> } | { ok: false; status: number; detail: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : "the request did not complete",
    };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    /*
      GOOGLE'S OWN SENTENCE, VERBATIM AND UNWRAPPED. The refusals this file
      exists to survive read "Google Play Developer Reporting API has not been
      used in project N before or it is disabled" and name the enable URL. That
      is the sentence that makes the next fix a click, and any paraphrase of it
      is worse than the original.
    */
    let detail = text.slice(0, 400);
    try {
      const e = (JSON.parse(text) as { error?: { message?: string; status?: string } }).error;
      if (e?.message) detail = e.message;
    } catch {
      /* not JSON — the body is the best sentence available */
    }
    return { ok: false, status: res.status, detail };
  }
  try {
    return { ok: true, doc: JSON.parse(text || "{}") as Record<string, unknown> };
  } catch {
    return { ok: false, status: res.status, detail: "the answer was not JSON" };
  }
}

/* ------------------------------------------------------------ the bucket */

/**
 * The sliced exports for one package.
 *
 * A ZERO EVENT ROW IS NOT STORED and this is the one place that rule is
 * relaxed on purpose. The device slice of one month of one app is 1,326 rows,
 * nearly all of them a phone model that saw no install that day; a table of
 * those is megabytes of nothing and makes every read slower for no answer.
 * Events are additive, so a (day, slice) that is absent contributed nothing —
 * which is recoverable, unlike a null. LEVELS (active devices, ratings) keep
 * their zeroes, because a level of zero is a real state of the world.
 */
function keepRow(metric: string, metrics: Record<string, MetricSpec>, amount: number): boolean {
  return metrics[metric]?.kind === "level" || amount !== 0;
}

async function ingestSlices(
  token: string,
  bucket: string,
  accountId: number,
  reports: StatsReport[],
  pkg: string,
  months: string[],
  since: string,
  kind: string,
  slices: readonly string[],
  metrics: Record<string, MetricSpec>,
  wrote: Record<string, number>,
) {
  for (const slice of slices) {
    const files = reports.filter(
      (r) => r.kind === kind && r.package === pkg && r.slice === slice && months.includes(r.month),
    );
    if (!files.length) {
      store.writeReportState({
        store: "play",
        accountId,
        app: pkg,
        report: `stats/${kind}/${slice}`,
        state: "absent",
        detail: `report not present in bucket ${bucket} for the months ${months.join(", ")}`,
      });
      continue;
    }
    /* THE WINDOW IS CLEARED BEFORE IT IS REWRITTEN. Only non-zero event rows
       are stored, so without this a day Google revises DOWN to zero — or a
       slice it stops reporting — would keep its old figure for ever and the
       table would be a high-water mark rather than a copy of the report. */
    const dimension = slice === "overview" ? "(all)" : slice;
    store.clearDimensions({ store: "play", accountId, app: pkg, dimension, since });
    let rows = 0;
    let failure: string | null = null;
    for (const file of files) {
      let raw: Buffer | null = null;
      try {
        raw = await fetchObject(token, bucket, file.object);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        continue;
      }
      if (!raw) continue;
      const parsed = parseDimension(decodeReport(raw), { dimension, metrics, since });
      const writes = parsed
        .filter((p) => keepRow(p.metric, metrics, p.amount))
        .map((p) => ({
          store: "play",
          accountId,
          app: pkg,
          day: p.day,
          dimension,
          value: p.value,
          metric: p.metric,
          amount: p.amount,
          unit: p.unit,
          report: file.object,
        }));
      rows += store.writeDimensions(writes);
    }
    wrote.dimensions = (wrote.dimensions ?? 0) + rows;
    store.writeReportState({
      store: "play",
      accountId,
      app: pkg,
      report: `stats/${kind}/${slice}`,
      state: failure ? "error" : rows ? "present" : "empty",
      detail: failure,
      rows,
      period: months.join(","),
    });
  }
}

async function ingestPerformance(
  token: string,
  bucket: string,
  accountId: number,
  reports: StatsReport[],
  pkg: string,
  months: string[],
  since: string,
  wrote: Record<string, number>,
) {
  for (const slice of PERFORMANCE_SLICES) {
    const files = reports.filter(
      (r) =>
        r.kind === "store_performance" &&
        r.package === pkg &&
        r.slice === slice &&
        months.includes(r.month),
    );
    if (!files.length) {
      store.writeReportState({
        store: "play",
        accountId,
        app: pkg,
        report: `stats/store_performance/${slice}`,
        state: "absent",
        detail: `report not present in bucket ${bucket} for the months ${months.join(", ")}`,
      });
      continue;
    }
    // Same rule as the install slices: cleared before rewritten, so a slice
    // Google stops reporting stops being reported here too.
    store.clearPerformance({ accountId, app: pkg, dimension: slice, since });
    let rows = 0;
    for (const file of files) {
      const raw = await fetchObject(token, bucket, file.object).catch(() => null);
      if (!raw) continue;
      const parsed = parseStorePerformance(decodeReport(raw), { dimension: slice, since });
      rows += store.writePerformance(
        parsed.map((p) => ({
          accountId,
          app: pkg,
          day: p.day,
          dimension: slice,
          value: p.value,
          visitors: p.visitors,
          acquisitions: p.acquisitions,
          rate: p.rate,
          report: file.object,
        })),
      );
    }
    wrote.performance = (wrote.performance ?? 0) + rows;
    store.writeReportState({
      store: "play",
      accountId,
      app: pkg,
      report: `stats/store_performance/${slice}`,
      state: rows ? "present" : "empty",
      rows,
      period: months.join(","),
    });
  }
}

async function ingestRetention(
  token: string,
  bucket: string,
  accountId: number,
  reports: StatsReport[],
  pkg: string,
  months: string[],
  since: string,
  wrote: Record<string, number>,
) {
  const files = reports.filter(
    (r) => r.kind === "retained_installers" && r.package === pkg && months.includes(r.month),
  );
  if (!files.length) {
    /*
      THE ACCOUNT THIS WAS WRITTEN AGAINST HAS NO SUCH FOLDER. That is what a
      retention curve of nulls means here and it is written down as a sentence
      rather than inferred from an empty table — "report not present in bucket"
      and "everybody churned" are opposite findings with the same shape.
    */
    store.writeReportState({
      store: "play",
      accountId,
      app: pkg,
      report: "stats/retained_installers",
      state: "absent",
      detail:
        `report not present in bucket ${bucket}. Play writes stats/retained_installers/ ` +
        `only for developer accounts the console generates it for; nothing here can create it.`,
    });
    return;
  }
  store.clearRetention({ accountId, app: pkg, since });
  let rows = 0;
  for (const file of files) {
    const raw = await fetchObject(token, bucket, file.object).catch(() => null);
    if (!raw) continue;
    const parsed = parseRetention(decodeReport(raw), since);
    rows += store.writeRetention(
      parsed.map((p) => ({
        accountId,
        app: pkg,
        day: p.day,
        offsetDays: p.offsetDays,
        retained: p.retained,
        installers: p.installers,
        report: file.object,
      })),
    );
  }
  wrote.retention = (wrote.retention ?? 0) + rows;
  store.writeReportState({
    store: "play",
    accountId,
    app: pkg,
    report: "stats/retained_installers",
    state: rows ? "present" : "empty",
    rows,
    period: months.join(","),
  });
}

/** The crash export's counts, filed into mobile_stability rather than into the
 *  dimensional table: a crash is a health measurement and belongs beside the
 *  rate it will be compared with, under its own source and unit. */
async function ingestCrashCounts(
  token: string,
  bucket: string,
  accountId: number,
  reports: StatsReport[],
  pkg: string,
  months: string[],
  since: string,
  wrote: Record<string, number>,
) {
  for (const slice of CRASH_SLICES) {
    const files = reports.filter(
      (r) => r.kind === "crashes" && r.package === pkg && r.slice === slice && months.includes(r.month),
    );
    if (!files.length) {
      store.writeReportState({
        store: "play",
        accountId,
        app: pkg,
        report: `stats/crashes/${slice}`,
        state: "absent",
        detail: `report not present in bucket ${bucket} for the months ${months.join(", ")}`,
      });
      continue;
    }
    const dimension = slice === "overview" ? "(all)" : slice;
    store.clearStability({
      store: "play",
      accountId,
      app: pkg,
      source: "play-bucket",
      dimension,
      since,
    });
    let rows = 0;
    for (const file of files) {
      const raw = await fetchObject(token, bucket, file.object).catch(() => null);
      if (!raw) continue;
      const parsed = parseDimension(decodeReport(raw), {
        dimension,
        metrics: CRASH_METRICS,
        since,
      });
      rows += store.writeStability(
        parsed.map((p) => ({
          store: "play",
          accountId,
          app: pkg,
          day: p.day,
          source: "play-bucket",
          metric: p.metric,
          dimension,
          value: p.value,
          amount: p.amount,
          unit: p.unit,
        })),
      );
    }
    wrote.stability = (wrote.stability ?? 0) + rows;
    store.writeReportState({
      store: "play",
      accountId,
      app: pkg,
      report: `stats/crashes/${slice}`,
      state: rows ? "present" : "empty",
      rows,
      period: months.join(","),
    });
  }
}

/* ------------------------------------------------- the Reporting API vitals */

/**
 * Crash and ANR rates for one package.
 *
 * TWO METRIC SETS, TWO RESOURCES, AND A HARD SHORT CIRCUIT. The API answers
 * identically for every app on a project, so the first refusal switches the
 * whole block off for this run and the remaining packages cost nothing: worst
 * case for an unavailable API is one request.
 *
 * `crashRate` AND `distinctUsers` RATHER THAN THE PRE-WEIGHTED NAMES. The
 * `crashRate28dUserWeighted` family is the part of this API most likely to
 * drift, and asking for a metric name it does not know fails the WHOLE query
 * with a 400. The plain daily metrics have been in every version, and the
 * weighting is arithmetic this box can do itself.
 *
 * THE WINDOW ENDS AT THE METRIC SET'S OWN FRESHNESS, NOT TODAY. Probed live,
 * DAILY freshness on this account ended four days back. A reader comparing a
 * crash rate against yesterday's release has to know that, so the freshness
 * day is recorded as the report state's `period` and published.
 */
async function ingestVitals(
  token: string,
  accountId: number,
  pkg: string,
  wrote: Record<string, number>,
  off: { stopped: boolean; reason: string | null },
): Promise<void> {
  for (const [metricSet, rateMetric] of [
    ["crashRateMetricSet", "crashRate"],
    ["anrRateMetricSet", "anrRate"],
  ] as const) {
    if (off.stopped) {
      store.writeReportState({
        store: "play",
        accountId,
        app: pkg,
        report: `reporting/${metricSet}`,
        state: "unauthorized",
        detail: off.reason,
      });
      continue;
    }

    const fresh = await callJson(`${REPORTING}/apps/${encodeURIComponent(pkg)}/${metricSet}`, token);
    if (!fresh.ok) {
      if (fresh.status === 401 || fresh.status === 403 || fresh.status === 404) {
        off.stopped = true;
        off.reason = fresh.detail;
      }
      store.writeReportState({
        store: "play",
        accountId,
        app: pkg,
        report: `reporting/${metricSet}`,
        state: fresh.status === 401 || fresh.status === 403 || fresh.status === 404 ? "unauthorized" : "error",
        detail: fresh.detail,
      });
      continue;
    }

    const end = dailyFreshness(fresh.doc as Parameters<typeof dailyFreshness>[0]);
    // No published DAILY freshness: three days back is the documented lag and
    // the guess is declared rather than hidden.
    const endDay = end ?? isoDay(3);
    const startDay = new Date(Date.parse(endDay) - VITALS_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const [sy, sm, sd] = startDay.split("-").map(Number);
    const [ey, em, ed] = endDay.split("-").map(Number);

    const query = await callJson(
      `${REPORTING}/apps/${encodeURIComponent(pkg)}/${metricSet}:query`,
      token,
      {
        timelineSpec: {
          aggregationPeriod: "DAILY",
          startTime: { year: sy, month: sm, day: sd },
          endTime: { year: ey, month: em, day: ed },
        },
        dimensions: ["versionCode"],
        metrics: [rateMetric, "distinctUsers"],
        pageSize: 500,
      },
    );
    if (!query.ok) {
      store.writeReportState({
        store: "play",
        accountId,
        app: pkg,
        report: `reporting/${metricSet}`,
        state: query.status === 401 || query.status === 403 ? "unauthorized" : "error",
        detail: query.detail,
        period: endDay,
      });
      continue;
    }

    /* Cleared before rewritten, for the reason the bucket slices are: a
       version code that stops reporting would otherwise keep its last rate
       for ever and go on being the worst one on the card. */
    store.clearStability({
      store: "play",
      accountId,
      app: pkg,
      source: "play-reporting",
      dimension: "app_version_code",
      since: startDay,
    });
    const parsed = parseReportingRows(query.doc as Parameters<typeof parseReportingRows>[0]);
    const writes = parsed.flatMap((r) => {
      const out: Parameters<typeof store.writeStability>[0] = [];
      const rate = r.metrics[rateMetric];
      const users = r.metrics.distinctUsers;
      const common = {
        store: "play",
        accountId,
        app: pkg,
        day: r.day,
        source: "play-reporting",
        dimension: r.dimension === "(all)" ? "(all)" : "app_version_code",
        value: r.value,
      };
      if (rate !== undefined)
        out.push({ ...common, metric: rateMetric, amount: rate, unit: "rate" });
      /*
        DISTINCT USERS IS THE DENOMINATOR AND IS STORED AS ONE. It is distinct
        PER DAY, so summing it over the window counts the same person up to
        twenty-eight times; the routes weight the rate by it and never add it.
      */
      if (users !== undefined)
        out.push({ ...common, metric: "distinctUsers", amount: users, unit: "users" });
      return out;
    });
    const n = store.writeStability(writes);
    wrote.stability = (wrote.stability ?? 0) + n;
    store.writeReportState({
      store: "play",
      accountId,
      app: pkg,
      report: `reporting/${metricSet}`,
      state: n ? "present" : "empty",
      detail: end
        ? null
        : "the metric set published no DAILY freshness; the window end was guessed at three days back",
      rows: n,
      period: endDay,
    });
  }
}

/* -------------------------------------------------------------- reviews */

async function ingestReviews(
  token: string,
  accountId: number,
  pkg: string,
  wrote: Record<string, number>,
  off: { stopped: boolean; reason: string | null },
) {
  if (off.stopped) {
    store.writeReportState({
      store: "play",
      accountId,
      app: pkg,
      report: "publisher/reviews",
      state: "unauthorized",
      detail: off.reason,
    });
    return;
  }
  let page: string | undefined;
  let caught = 0;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ maxResults: "100" });
    if (page) q.set("token", page);
    const res = await callJson(
      `${PUBLISHER}/applications/${encodeURIComponent(pkg)}/reviews?${q}`,
      token,
    );
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        off.stopped = true;
        off.reason = res.detail;
      }
      store.writeReportState({
        store: "play",
        accountId,
        app: pkg,
        report: "publisher/reviews",
        state: res.status === 401 || res.status === 403 || res.status === 404 ? "unauthorized" : "error",
        detail: res.detail,
      });
      return;
    }
    const list = (res.doc.reviews as Record<string, unknown>[] | undefined) ?? [];
    const rows = list
      .map((r) => playReview(pkg, r))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({ ...r, accountId }));
    caught += store.writeReviews(rows);
    page = (res.doc.tokenPagination as { nextPageToken?: string } | undefined)?.nextPageToken;
    if (!page) break;
  }
  wrote.reviews = (wrote.reviews ?? 0) + caught;
  store.writeReportState({
    store: "play",
    accountId,
    app: pkg,
    report: "publisher/reviews",
    state: caught ? "present" : "empty",
    rows: caught,
    detail:
      "reviews.list returns only the last seven days and has no way to page further back; " +
      "mobile_reviews is an accumulator of what the runs have caught",
  });
}

/* ------------------------------------------------------------- the pass */

export async function collectPlayHealth(): Promise<PlayHealthResult[]> {
  const { ready, broken } = accounts.credentialed(
    "playstore",
    ["key.json", "developer-id"],
    "mobilehealth",
  );
  const out: PlayHealthResult[] = [];

  for (const { account, missing } of broken)
    out.push({
      accountId: account.id,
      label: account.label,
      ok: false,
      error: `Missing ${missing.join(", ")}.`,
      packages: [],
      wrote: {},
      probes: [],
      notes: [],
    });

  for (const { account, values } of ready) {
    const wrote: Record<string, number> = {};
    const probes: PlayHealthResult["probes"] = [];
    const notes: string[] = [];
    try {
      const sa = readServiceAccount(values["key.json"] ?? "");
      const bucket = normaliseBucket(values["developer-id"] ?? "");

      /* ---- the bucket, which is the block everything else must not cost ---- */
      const bucketToken = await tokenFor(sa, "https://www.googleapis.com/auth/devstorage.read_only");
      if ("error" in bucketToken) {
        store.writeProbe({
          store: "play",
          accountId: account.id,
          probe: "gcs",
          ok: false,
          status: bucketToken.status,
          error: bucketToken.error,
        });
        throw new Error(bucketToken.error);
      }
      store.writeProbe({ store: "play", accountId: account.id, probe: "gcs", ok: true });
      probes.push({ probe: "gcs", ok: true });

      let objects: GcsObject[] = [];
      try {
        objects = await listObjects(bucketToken.token, bucket, "stats/");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        store.writeProbe({
          store: "play",
          accountId: account.id,
          probe: "gcs",
          ok: false,
          status: err instanceof PlayError ? err.status : null,
          error: message,
        });
        throw err;
      }

      const reports = indexStatsReports(objects);
      const months = monthsInWindow(HEALTH_DAYS);
      const since = isoDay(HEALTH_DAYS);
      // Packages are discovered from the installs folder, exactly as
      // providers/play.ts discovers them — a hand-kept list misses the launch
      // an owner most wants to see.
      const packages = [
        ...new Set(reports.filter((r) => r.kind === "installs").map((r) => r.package)),
      ].sort();

      for (const pkg of packages) {
        await ingestSlices(
          bucketToken.token, bucket, account.id, reports, pkg, months, since,
          "installs", INSTALL_SLICES, INSTALL_METRICS, wrote,
        );
        await ingestSlices(
          bucketToken.token, bucket, account.id, reports, pkg, months, since,
          "ratings", ["overview", "country", "device"], RATING_METRICS, wrote,
        );
        await ingestPerformance(bucketToken.token, bucket, account.id, reports, pkg, months, since, wrote);
        await ingestRetention(bucketToken.token, bucket, account.id, reports, pkg, months, since, wrote);
        await ingestCrashCounts(bucketToken.token, bucket, account.id, reports, pkg, months, since, wrote);
      }

      /* ---- the Reporting API, on its own grant ---- */
      const reportingToken = await tokenFor(sa, REPORTING_SCOPE);
      const vitalsOff = { stopped: false, reason: null as string | null };
      if ("error" in reportingToken) {
        vitalsOff.stopped = true;
        vitalsOff.reason = reportingToken.error;
        store.writeProbe({
          store: "play",
          accountId: account.id,
          probe: "playdeveloperreporting",
          ok: false,
          status: reportingToken.status,
          error: reportingToken.error,
        });
        probes.push({ probe: "playdeveloperreporting", ok: false, error: reportingToken.error });
        notes.push(`crash and ANR rates unavailable: ${reportingToken.error}`);
        for (const pkg of packages)
          await ingestVitals("", account.id, pkg, wrote, vitalsOff);
      } else {
        for (const pkg of packages)
          await ingestVitals(reportingToken.token, account.id, pkg, wrote, vitalsOff);
        store.writeProbe({
          store: "play",
          accountId: account.id,
          probe: "playdeveloperreporting",
          ok: !vitalsOff.stopped,
          error: vitalsOff.reason,
        });
        probes.push({ probe: "playdeveloperreporting", ok: !vitalsOff.stopped, error: vitalsOff.reason });
        if (vitalsOff.reason) notes.push(`crash and ANR rates unavailable: ${vitalsOff.reason}`);
      }

      /* ---- androidpublisher, on its own grant ---- */
      const publisherToken = await tokenFor(sa, PUBLISHER_SCOPE);
      const reviewsOff = { stopped: false, reason: null as string | null };
      if ("error" in publisherToken) {
        reviewsOff.stopped = true;
        reviewsOff.reason = publisherToken.error;
        store.writeProbe({
          store: "play",
          accountId: account.id,
          probe: "androidpublisher",
          ok: false,
          status: publisherToken.status,
          error: publisherToken.error,
        });
        probes.push({ probe: "androidpublisher", ok: false, error: publisherToken.error });
        notes.push(`reviews unavailable: ${publisherToken.error}`);
        for (const pkg of packages) await ingestReviews("", account.id, pkg, wrote, reviewsOff);
      } else {
        for (const pkg of packages)
          await ingestReviews(publisherToken.token, account.id, pkg, wrote, reviewsOff);
        store.writeProbe({
          store: "play",
          accountId: account.id,
          probe: "androidpublisher",
          ok: !reviewsOff.stopped,
          error: reviewsOff.reason,
        });
        probes.push({ probe: "androidpublisher", ok: !reviewsOff.stopped, error: reviewsOff.reason });
        if (reviewsOff.reason) notes.push(`reviews unavailable: ${reviewsOff.reason}`);
      }

      out.push({ accountId: account.id, label: account.label, ok: true, packages, wrote, probes, notes });
    } catch (err) {
      out.push({
        accountId: account.id,
        label: account.label,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        packages: [],
        wrote,
        probes,
        notes,
      });
    }
  }
  return out;
}
