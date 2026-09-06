/**
 * /api/mobilehealth — what the apps DO, where /api/mobile has what they EARN.
 *
 * SEVEN VIEWS OF ONE THING AND NO TOTALS ACROSS THEM. Segments, listing
 * conversion, retention, stability, reviews, versions and readiness are seven
 * different measurements taken in five different units by two stores that
 * count differently. There is no document here that adds an Android device
 * install to an iOS download event, and there cannot be: Google counts DEVICES
 * from the console's own export while Apple counts DOWNLOAD EVENTS with a
 * privacy threshold under them, and one number spanning both would be a number
 * in no unit.
 *
 * EVERY TOTAL IS COMPUTED ON THE READ, exactly as /api/mobile does it — the
 * tables hold days and slices, and a window is summed when somebody asks.
 *
 * FOUR RULES THIS DOCUMENT EXISTS TO KEEP:
 *
 *   1. A LEVEL IS NOT AN EVENT. Active devices and average ratings are states
 *      of the world on a day; installs, crashes and store visitors are things
 *      that happened. The first kind is read from the newest day that carried
 *      one, never summed. `metricKind` on every series says which it is.
 *   2. A RATE IS NOT AVERAGED ACROSS DAYS. Listing conversion over a window is
 *      acquisitions over visitors for that window; the mean of thirty daily
 *      rates gives a Sunday with four visitors the same weight as a Monday
 *      with four thousand. Crash rates are weighted by the distinct users
 *      each day actually had, for the same reason, and say so.
 *   3. A MISSING REPORT IS NULL WITH A SENTENCE, NEVER ZERO. `readiness` is
 *      the whole of this area's honesty: a Play folder that is not in the
 *      bucket, an Apple report with no instance, and a grant the credential
 *      does not carry are three different absences and each carries the
 *      provider's own words.
 *   4. THE ANDROID REVIEW WINDOW IS SEVEN DAYS AND THE iOS ONE IS NOT.
 *      `reviews.list` returns the last seven days and cannot page further
 *      back, so the Android rows are what this box has ACCUMULATED since it
 *      was switched on; Apple's page back to the first review. Every count
 *      says which basis it is on.
 */
import { Hono } from "hono";
import { PORT } from "../../config.ts";
import { serviceHeaders } from "../../auth.ts";
import { getPlugin } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { mintToken } from "../../providers/appstore.ts";
import { INSTALL_METRICS, RATING_METRICS, CRASH_METRICS, ANALYTICS_REPORTS, starHistogram } from "./parsers.ts";
import * as store from "./store.ts";
import { appStoreIdentities, createAnalyticsRequest } from "./appstore.ts";
import { collectNow, passRunning } from "./collect.ts";
import { HEALTH_DAYS, VITALS_DAYS } from "./play.ts";

export const mobileHealthRoutes = new Hono();

const connected = (id: string) => getPlugin(id)?.connected === 1;
const round = (n: number, p = 2) => Number(n.toFixed(p));
const isoDay = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** Windows are in days, default 30, clamped to the span this area actually
 *  ingests — a window wider than HEALTH_DAYS would be a floor, not a total,
 *  and the clamp is published so nothing captions an answer with the number it
 *  sent rather than the number that was used. */
function window(c: { req: { query: (k: string) => string | undefined } }) {
  const asked = Number(c.req.query("days") ?? 30) || 30;
  const days = Math.min(Math.max(asked, 1), HEALTH_DAYS);
  return { days, since: isoDay(days), clamped: asked !== days ? asked : null };
}

/** Which kind a metric is, so the reader never has to guess from its name. */
function metricKind(metric: string): "event" | "level" | "rate" | "unknown" {
  const bare = metric.includes(".") ? metric.split(".")[1]! : metric;
  const spec =
    INSTALL_METRICS[bare] ?? RATING_METRICS[bare] ?? CRASH_METRICS[bare] ?? null;
  if (spec) return spec.kind;
  if (metric === "crashRate" || metric === "anrRate") return "rate";
  if (metric === "distinctUsers") return "level";
  // An App Store analytics metric ("downloads.counts", "sessions.sessions").
  if (metric.includes(".")) return "event";
  return "unknown";
}

const storeOf = (c: { req: { query: (k: string) => string | undefined } }) => {
  const v = (c.req.query("store") ?? "").toLowerCase();
  return v === "play" || v === "appstore" ? v : undefined;
};

/* ------------------------------------------------------------- readiness */

/**
 * WHAT WAS ASKED FOR AND WHAT EACH STORE SAID — the first route to read when
 * a figure elsewhere is null.
 *
 * The probes are about the CREDENTIAL and the report states are about the
 * DATA, and they are published apart because that is the distinction this
 * whole area exists to keep: the Play Developer Reporting API can be switched
 * off for a whole Cloud project while every install export in the bucket is
 * perfectly readable, and the first fact must never blank out the second.
 */
function readinessDoc() {
  const states = store.reportStates();
  const byState = new Map<string, number>();
  for (const s of states) byState.set(s.state, (byState.get(s.state) ?? 0) + 1);

  return {
    stores: {
      play: { connected: connected("playstore") },
      appstore: { connected: connected("appstore") },
    },
    lastCollected: store.lastSeen(),
    collecting: passRunning(),
    /** The credential's reach, per grant. A false here explains every null in
     *  the block that grant feeds and nothing else. */
    probes: store.probes().map((p) => ({
      store: p.store,
      accountId: p.account_id,
      probe: p.probe,
      ok: p.ok === 1,
      status: p.status,
      /** The provider's OWN sentence, unedited. Google's names the API and the
       *  URL that enables it; Apple's names the role that is missing. */
      error: p.error,
      checkedAt: p.checked_at,
    })),
    counts: Object.fromEntries(byState),
    reports: states.map((s) => ({
      store: s.store,
      app: s.app,
      report: s.report,
      state: s.state,
      detail: s.detail,
      rows: s.rows,
      period: s.period,
      checkedAt: s.checked_at,
    })),
    states: {
      present: "rows arrived and were ingested",
      absent: "the report is not in the bucket, or Apple lists no report by that name",
      empty: "the report exists and carried no rows for the window",
      requested: "no ongoing analytics request exists — Apple will generate nothing until one is made",
      processing: "Apple lists the report and has produced no instance of it yet",
      available: "instances exist and were downloaded",
      delayed: "instances exist but the newest is older than Apple's own two-day lag allows",
      unauthorized: "the credential was refused for this resource specifically",
      error: "something else went wrong; `detail` carries the provider's own words",
    },
    note:
      "A report that is absent, empty, processing or unauthorized produces NULL " +
      "everywhere else in this area — never a zero. Revenue and installs on " +
      "/api/mobile are a different credential path and are unaffected by anything here.",
  };
}

mobileHealthRoutes.get("/readiness", (c) => c.json(readinessDoc()));

/* -------------------------------------------------------------- segments */

/**
 * WHICH SEGMENTS ACQUIRE — the question the overview exports cannot answer.
 *
 * Ranked, with the remainder named. A top-ten list whose share does not add to
 * one is a chart that invites the reader to assume ten slices are everything,
 * so `other` is published beside them and is a real figure.
 */
mobileHealthRoutes.get("/segments", (c) => {
  const w = window(c);
  const dimension = c.req.query("dimension") ?? undefined;
  const app = c.req.query("app") ?? undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 12) || 12, 1), 100);
  const rows = store.dimensions({ since: w.since, store: storeOf(c), app, dimension });

  type Bucket = { value: string; amount: number; days: Set<string>; unit: string };
  const groups = new Map<string, Map<string, Bucket>>();
  const levels = new Map<string, Map<string, { day: string; amount: number; unit: string }>>();

  for (const r of rows) {
    const key = `${r.store} ${r.app} ${r.dimension} ${r.metric}`;
    if (metricKind(r.metric) === "level") {
      /* A LEVEL IS READ FROM THE NEWEST DAY THAT CARRIED ONE. Thirty days of
         "active devices" added counts the same phone thirty times. */
      const held = levels.get(key) ?? new Map();
      const cur = held.get(r.value);
      if (!cur || r.day > cur.day) held.set(r.value, { day: r.day, amount: r.amount, unit: r.unit });
      levels.set(key, held);
      continue;
    }
    const held = groups.get(key) ?? new Map<string, Bucket>();
    const b = held.get(r.value) ?? { value: r.value, amount: 0, days: new Set<string>(), unit: r.unit };
    b.amount += r.amount;
    b.days.add(r.day);
    held.set(r.value, b);
    groups.set(key, held);
  }

  const out: unknown[] = [];
  for (const [key, values] of groups) {
    const [st, app_, dim, metric] = key.split(" ");
    const ranked = [...values.values()].sort((a, b) => b.amount - a.amount);
    const total = ranked.reduce((n, r) => n + r.amount, 0);
    const top = ranked.slice(0, limit);
    out.push({
      store: st,
      app: app_,
      dimension: dim,
      metric,
      metricKind: "event",
      unit: top[0]?.unit ?? ranked[0]?.unit ?? null,
      total: round(total, 4),
      slices: ranked.length,
      top: top.map((r) => ({
        value: r.value,
        amount: round(r.amount, 4),
        days: r.days.size,
        share: total ? round(r.amount / total, 4) : null,
      })),
      other: round(total - top.reduce((n, r) => n + r.amount, 0), 4),
    });
  }
  for (const [key, values] of levels) {
    const [st, app_, dim, metric] = key.split(" ");
    const ranked = [...values].sort((a, b) => b[1].amount - a[1].amount);
    out.push({
      store: st,
      app: app_,
      dimension: dim,
      metric,
      metricKind: "level",
      unit: ranked[0]?.[1].unit ?? null,
      /** The sum of the newest reading per slice, which IS a valid total for a
       *  level: each slice is counted once, on its own newest day. */
      total: round(ranked.reduce((n, [, v]) => n + v.amount, 0), 4),
      slices: ranked.length,
      top: ranked.slice(0, limit).map(([value, v]) => ({
        value,
        amount: round(v.amount, 4),
        at: v.day,
        share: null,
      })),
      other: null,
    });
  }

  return c.json({
    window: { days: w.days, from: w.since, to: isoDay(0), clampedFrom: w.clamped },
    available: store.dimensionIndex(),
    groups: out,
    units: {
      play: "Google's install exports count DEVICES; the user columns beside them count USERS. Both are kept under their own names.",
      appstore:
        "Apple's analytics reports count download and engagement EVENTS, privacy-thresholded: rows under five users or devices are dropped and noise is added, so a small app's day is often empty.",
    },
    rules: [
      "Nothing here is added across stores. A Play device install and an App Store download event are different counts of different things.",
      "A `metricKind` of `level` is a state on a day and is never summed over days; its total is one reading per slice.",
      "A slice absent from an event metric contributed nothing that day — the table stores non-zero event rows only, and zero rows are recoverable by their absence.",
    ],
    generatedAt: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------ conversion */

/**
 * LISTING CONVERSION — store listing visitors, acquisitions, and the rate.
 *
 * THE RATE IS ACQUISITIONS OVER VISITORS FOR THE WHOLE WINDOW, computed here,
 * never the mean of the daily rates Google writes into the file. Those are
 * kept per row for one day's spot check and are not averaged anywhere.
 */
mobileHealthRoutes.get("/conversion", (c) => {
  const w = window(c);
  const app = c.req.query("app") ?? undefined;
  const rows = store.performance(w.since, app);

  const rate = (a: number | null, v: number | null) =>
    a !== null && v !== null && v > 0 ? round(a / v, 4) : null;

  const perApp = new Map<string, { visitors: number | null; acquisitions: number | null }>();
  const perDay = new Map<string, { visitors: number | null; acquisitions: number | null }>();
  const perSlice = new Map<string, Map<string, { visitors: number | null; acquisitions: number | null }>>();

  for (const r of rows) {
    // Only ONE dimension is summed into the totals, because the slices of two
    // different cuts of the same report are the same visitors counted twice.
    // `country` is the cut every era of this export carries.
    if (r.dimension === "country") {
      const a = perApp.get(r.app) ?? { visitors: null, acquisitions: null };
      if (r.visitors !== null) a.visitors = (a.visitors ?? 0) + r.visitors;
      if (r.acquisitions !== null) a.acquisitions = (a.acquisitions ?? 0) + r.acquisitions;
      perApp.set(r.app, a);
      const d = perDay.get(r.day) ?? { visitors: null, acquisitions: null };
      if (r.visitors !== null) d.visitors = (d.visitors ?? 0) + r.visitors;
      if (r.acquisitions !== null) d.acquisitions = (d.acquisitions ?? 0) + r.acquisitions;
      perDay.set(r.day, d);
    }
    const bucket = perSlice.get(r.dimension) ?? new Map();
    const s = bucket.get(r.value) ?? { visitors: null, acquisitions: null };
    if (r.visitors !== null) s.visitors = (s.visitors ?? 0) + r.visitors;
    if (r.acquisitions !== null) s.acquisitions = (s.acquisitions ?? 0) + r.acquisitions;
    bucket.set(r.value, s);
    perSlice.set(r.dimension, bucket);
  }

  const reports = store
    .reportStates("play")
    .filter((s) => s.report.startsWith("stats/store_performance"));

  return c.json({
    window: { days: w.days, from: w.since, to: isoDay(0), clampedFrom: w.clamped },
    /** Null with a reason rather than an empty chart: the reason is in
     *  `readiness`, and it is repeated here so a caller reading one route
     *  cannot mistake absence for a conversion of zero. */
    measured: rows.length > 0,
    reason: rows.length
      ? null
      : reports.length
        ? reports.map((r) => `${r.app} ${r.report}: ${r.state}${r.detail ? ` — ${r.detail}` : ""}`).join("; ")
        : "nothing has been collected yet — run POST /api/mobilehealth/collect",
    apps: [...perApp].map(([app_, v]) => ({
      app: app_,
      visitors: v.visitors,
      acquisitions: v.acquisitions,
      rate: rate(v.acquisitions, v.visitors),
    })),
    days: [...perDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({
        day,
        visitors: v.visitors,
        acquisitions: v.acquisitions,
        rate: rate(v.acquisitions, v.visitors),
      })),
    by: Object.fromEntries(
      [...perSlice].map(([dim, values]) => [
        dim,
        [...values]
          .map(([value, v]) => ({
            value,
            visitors: v.visitors,
            acquisitions: v.acquisitions,
            rate: rate(v.acquisitions, v.visitors),
          }))
          .sort((a, b) => (b.visitors ?? 0) - (a.visitors ?? 0))
          .slice(0, 25),
      ]),
    ),
    source: "Google Play Console stats/store_performance/ — Android only. The App Store has no equivalent export.",
    rules: [
      "The rate is acquisitions divided by visitors OVER THE WINDOW. Never the mean of the daily rates in the file.",
      "`by.country` and `by.traffic_source` are two cuts of the SAME visitors. Never add them together.",
      "A visitor is a store listing visit, not a website visit, and an acquisition is a first install from that listing.",
    ],
    generatedAt: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------- retention */

mobileHealthRoutes.get("/retention", (c) => {
  const w = window(c);
  const app = c.req.query("app") ?? undefined;
  const rows = store.retention(w.since, app);
  const reports = store
    .reportStates("play")
    .filter((s) => s.report === "stats/retained_installers");

  const curves = new Map<string, Map<number, { retained: number; installers: number }>>();
  for (const r of rows) {
    const held = curves.get(r.app) ?? new Map<number, { retained: number; installers: number }>();
    const p = held.get(r.offsetDays) ?? { retained: 0, installers: 0 };
    p.retained += r.retained ?? 0;
    p.installers += r.installers ?? 0;
    held.set(r.offsetDays, p);
    curves.set(r.app, held);
  }

  return c.json({
    window: { days: w.days, from: w.since, to: isoDay(0), clampedFrom: w.clamped },
    measured: rows.length > 0,
    /*
      NULL WITH THE REASON, and the reason on the account this was built
      against is that the bucket has no such folder. "Report not present in
      bucket" and "everybody churned" are opposite findings with the same
      shape, so the sentence is mandatory.
    */
    reason: rows.length
      ? null
      : reports.length
        ? reports.map((r) => `${r.app}: ${r.detail ?? r.state}`).join("; ")
        : "nothing has been collected yet — run POST /api/mobilehealth/collect",
    apps: [...curves].map(([app_, points]) => ({
      app: app_,
      curve: [...points]
        .sort(([a], [b]) => a - b)
        .map(([offsetDays, p]) => ({
          day: offsetDays,
          retained: p.retained,
          installers: p.installers,
          /** Against the cohort from the SAME file. A rate computed against an
           *  install count from a different export would be a ratio of two
           *  different cohorts measured two different ways. */
          rate: p.installers ? round(p.retained / p.installers, 4) : null,
        })),
    })),
    source:
      "Google Play Console stats/retained_installers/ — Android only, and only for developer accounts the console generates it for. Nothing here can create it.",
    generatedAt: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------- stability */

/**
 * CRASHES AND ANRs, with the three sources kept apart.
 *
 * A COUNT AND A RATE ARE NOT THE SAME MEASUREMENT and are never put on one
 * axis. Play's bucket export gives daily COUNTS with no denominator; the Play
 * Developer Reporting API gives daily RATES as a fraction of distinct users;
 * Apple's App Crashes report gives counts again, when it exists at all. Each
 * series carries its source and its unit.
 *
 * THE WINDOW RATE IS WEIGHTED BY THE USERS EACH DAY HAD. An unweighted mean
 * lets a quiet Sunday with four users outvote a Monday with four thousand.
 */
function stabilityDoc(days: number, appFilter?: string, storeFilter?: string) {
  const since = isoDay(days);
  const rows = store.stability({ since, store: storeFilter, app: appFilter });

  type Series = {
    store: string;
    app: string;
    source: string;
    metric: string;
    unit: string;
    days: Map<string, number>;
    byVersion: Map<string, number>;
  };
  const series = new Map<string, Series>();
  const users = new Map<string, Map<string, number>>();

  for (const r of rows) {
    if (r.amount === null) continue;
    if (r.metric === "distinctUsers") {
      const held = users.get(`${r.store} ${r.app}`) ?? new Map<string, number>();
      // Distinct users are distinct PER DAY. The busiest day is the honest
      // headline; adding them counts one person up to VITALS_DAYS times.
      held.set(r.day, Math.max(held.get(r.day) ?? 0, r.amount));
      users.set(`${r.store} ${r.app}`, held);
      continue;
    }
    const key = `${r.store} ${r.app} ${r.source} ${r.metric}`;
    const s =
      series.get(key) ??
      {
        store: r.store,
        app: r.app,
        source: r.source,
        metric: r.metric,
        unit: r.unit,
        days: new Map<string, number>(),
        byVersion: new Map<string, number>(),
      };
    if (r.dimension === "(all)")
      s.days.set(r.day, (s.days.get(r.day) ?? 0) + (r.unit === "rate" ? r.amount : r.amount));
    else if (r.dimension === "app_version" || r.dimension === "app_version_code")
      s.byVersion.set(r.value, (s.byVersion.get(r.value) ?? 0) + r.amount);
    series.set(key, s);
  }

  /* THE RATE SERIES HAS NO "(all)" ROW: the Reporting API is asked by version
     code, so the day's overall rate is the per-version rates weighted by the
     users behind them. Recomputed here rather than asked for twice. */
  const rateRows = rows.filter(
    (r) => r.unit === "rate" && r.amount !== null && r.dimension === "app_version_code",
  );
  const rateByDay = new Map<string, { num: number; den: number; plain: number[] }>();
  for (const r of rateRows) {
    const key = `${r.store} ${r.app} ${r.metric} ${r.day}`;
    const held = rateByDay.get(key) ?? { num: 0, den: 0, plain: [] };
    const w = users.get(`${r.store} ${r.app}`)?.get(r.day) ?? 0;
    held.plain.push(r.amount!);
    held.num += r.amount! * w;
    held.den += w;
    rateByDay.set(key, held);
  }

  const rates: {
    store: string;
    app: string;
    metric: string;
    days: { day: string; rate: number }[];
    window: number | null;
    weightedBy: string;
  }[] = [];
  const grouped = new Map<string, { day: string; rate: number }[]>();
  for (const [key, v] of rateByDay) {
    const [st, app_, metric, day] = key.split(" ");
    const rate = v.den ? v.num / v.den : v.plain.length ? v.plain.reduce((a, b) => a + b, 0) / v.plain.length : null;
    if (rate === null) continue;
    const g = `${st} ${app_} ${metric}`;
    const list = grouped.get(g) ?? [];
    list.push({ day: day!, rate: round(rate, 6) });
    grouped.set(g, list);
  }
  for (const [g, list] of grouped) {
    const [st, app_, metric] = g.split(" ");
    list.sort((a, b) => a.day.localeCompare(b.day));
    const userDays = users.get(`${st} ${app_}`) ?? new Map<string, number>();
    let num = 0;
    let den = 0;
    for (const d of list) {
      const w = userDays.get(d.day) ?? 0;
      num += d.rate * w;
      den += w;
    }
    rates.push({
      store: st!,
      app: app_!,
      metric: metric!,
      days: list,
      window: den ? round(num / den, 6) : null,
      weightedBy: "distinct users on each day, as the Reporting API reported them",
    });
  }

  const reports = store
    .reportStates()
    .filter((s) => s.report.startsWith("reporting/") || s.report.startsWith("stats/crashes") || s.report === "analytics/App Crashes");

  /*
    THE ONE SCALAR AN ALERT RULE CAN WATCH, and it is a separate block because
    a JSON path into a ranked array would name a different app the week after
    the ranking moved. `worstCrashRate` is the highest window crash rate across
    every (app, version) that reported one; the object beside it names WHICH,
    so a narration can say so. Both are NULL when nothing measured a rate —
    which the alerts engine records as "unreadable" rather than as a rate of
    zero, because a crash rate of zero and no crash data at all are opposite
    findings.
  */
  const crashRates = rates.filter((r) => r.metric === "crashRate" && r.window !== null);
  const worst = crashRates.sort((a, b) => (b.window ?? 0) - (a.window ?? 0))[0] ?? null;
  const countedCrashes = [...series.values()]
    .filter((s) => s.metric === "crashes")
    .reduce((n, s) => n + [...s.days.values()].reduce((m, v) => m + v, 0), 0);
  const anyCountReport = reports.some(
    (r) => (r.report.startsWith("stats/crashes") || r.report === "analytics/App Crashes") && r.state === "present",
  );

  return {
    window: { days, from: since, to: isoDay(0) },
    vitalsWindowDays: VITALS_DAYS,
    alerting: {
      /** The highest window crash rate any app reported, as a fraction of
       *  distinct users. Null when no rate was measured at all. */
      worstCrashRate: worst?.window ?? null,
      worstCrashRateApp: worst ? { store: worst.store, app: worst.app } : null,
      /** Counted crashes over the window, across every source that reported
       *  one. Null — not zero — when no crash COUNT report answered. */
      crashCount: anyCountReport ? countedCrashes : null,
      note:
        "These two scalars exist so an alert rule can name a figure that does not move when a ranking does. " +
        "Null means no report answered, which the alerts engine records as unreadable rather than as zero.",
    },
    counts: [...series.values()]
      .filter((s) => s.unit !== "rate")
      .map((s) => ({
        store: s.store,
        app: s.app,
        source: s.source,
        metric: s.metric,
        unit: s.unit,
        total: [...s.days.values()].reduce((n, v) => n + v, 0),
        days: [...s.days].sort(([a], [b]) => a.localeCompare(b)).map(([day, amount]) => ({ day, amount })),
        byVersion: [...s.byVersion]
          .sort((a, b) => b[1] - a[1])
          .map(([version, amount]) => ({ version, amount })),
      })),
    rates,
    /** Every report that feeds this document, and what it said. A null crash
     *  figure is explained here rather than left to be read as a zero. */
    readiness: reports.map((r) => ({
      store: r.store,
      app: r.app,
      report: r.report,
      state: r.state,
      detail: r.detail,
      period: r.period,
    })),
    sources: {
      "play-bucket":
        "Google Play Console stats/crashes/ — daily crash and ANR COUNTS, sliced by app version, device and OS version. No denominator.",
      "play-reporting":
        "Play Developer Reporting API crashRateMetricSet / anrRateMetricSet — daily RATES as a fraction of distinct users, by version code. A separate API enablement and a separate grant from the bucket.",
      appstore:
        "The App Store Connect analytics report named \"App Crashes\" (metrics Crashes and Unique Devices, by App Version and Device). Privacy-thresholded; where Apple has produced no instance the figure is null.",
    },
    rules: [
      "A count and a rate are never put on one axis and never converted into one another.",
      "The window rate is weighted by the distinct users each day had, not the mean of the daily rates.",
      "Distinct users are distinct PER DAY and are never summed across days.",
      "The Reporting API's window ends at its own published freshness, several days back — not today.",
      "A null crash figure means the report was absent, processing or refused. It is never a crash count of zero.",
    ],
    generatedAt: new Date().toISOString(),
  };
}

mobileHealthRoutes.get("/stability", (c) => {
  const w = window(c);
  return c.json(stabilityDoc(w.days, c.req.query("app") ?? undefined, storeOf(c)));
});

/* --------------------------------------------------------------- reviews */

function reviewDoc(opts: {
  days: number;
  limit: number;
  store?: string;
  app?: string;
  minRating?: number;
  maxRating?: number;
}) {
  const since = isoDay(opts.days);
  const rows = store.reviews({
    store: opts.store,
    app: opts.app,
    minRating: opts.minRating,
    maxRating: opts.maxRating,
    since,
    limit: opts.limit,
  });
  const all = store.reviews({ store: opts.store, app: opts.app, since, limit: 5000 });

  const rated = all.filter((r) => typeof r.rating === "number");
  const perDay = new Map<string, Record<string, number>>();
  for (const r of rated) {
    const day = (r.created ?? r.first_seen).slice(0, 10);
    const held = perDay.get(day) ?? { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    const b = String(r.rating);
    if (b in held) held[b] = held[b]! + 1;
    perDay.set(day, held);
  }

  const byVersion = new Map<string, { n: number; sum: number }>();
  for (const r of rated) {
    if (!r.app_version) continue;
    const held = byVersion.get(r.app_version) ?? { n: 0, sum: 0 };
    held.n += 1;
    held.sum += r.rating!;
    byVersion.set(r.app_version, held);
  }

  const filed = new Set(store.filedReviews(all.map((r) => r.id)).map((f) => f.review_id));

  return {
    window: { days: opts.days, from: since, to: isoDay(0) },
    counts: store.reviewCounts(),
    inWindow: all.length,
    /** All five keys, always. A breakdown that omits the stars nobody gave
     *  makes "no one-star reviews" and "we did not look" the same shape. */
    stars: starHistogram(rated),
    average: rated.length
      ? round(rated.reduce((n, r) => n + r.rating!, 0) / rated.length, 2)
      : null,
    perDay: [...perDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, stars]) => ({ day, stars })),
    /** Android only in practice: Apple's customerReviews resource carries no
     *  app version at all, so an iOS review can never be attributed to one. */
    byVersion: [...byVersion]
      .map(([version, v]) => ({ version, reviews: v.n, average: round(v.sum / v.n, 2) }))
      .sort((a, b) => b.reviews - a.reviews),
    reviews: rows.map((r) => ({
      store: r.store,
      app: r.app,
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      author: r.author,
      language: r.language,
      territory: r.territory,
      appVersion: r.app_version,
      device: r.device,
      created: r.created,
      updated: r.updated,
      /** The developer reply the STORE already holds, read only. */
      reply: r.reply,
      filed: filed.has(r.id),
    })),
    basis: {
      play:
        "Android reviews come from androidpublisher reviews.list, which returns ONLY the last seven days and cannot page further back. These rows are what this box has accumulated since the area was switched on — never the app's all-time review count.",
      appstore:
        "iOS reviews come from App Store Connect customerReviews, paginated back to the app's first review, all territories. It carries a territory and a star; it carries no app version.",
    },
    rules: [
      "Never quote an Android review count as the app's total. The API's window is seven days and the table is an accumulator.",
      "A null rating is a review with no star, not a zero-star review.",
      "`byVersion` is Android-only: Apple's review resource has no app version field.",
      "Replying to a review is not possible from this box. There is no route, no action and no skill here that writes one.",
    ],
    generatedAt: new Date().toISOString(),
  };
}

mobileHealthRoutes.get("/reviews", (c) => {
  const w = window(c);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
  const min = c.req.query("minRating");
  const max = c.req.query("maxRating");
  return c.json(
    reviewDoc({
      days: w.days,
      limit,
      store: storeOf(c),
      app: c.req.query("app") ?? undefined,
      minRating: min ? Number(min) : undefined,
      maxRating: max ? Number(max) : undefined,
    }),
  );
});

/**
 * THE TREND SUMMARY — ratings by version, and the themes a model read out of
 * the actual review texts.
 *
 * EVERY THEME CITES THE REVIEW IDS IT CAME FROM. That is the whole design: a
 * model summarising complaints will otherwise produce a plausible sentence
 * about a complaint nobody made, and there is no way to check it. With ids, a
 * reader clicks through to the review and the claim either survives or does
 * not. A theme that cites nothing is dropped here rather than published.
 *
 * The model is optional. With no provider configured this route still answers
 * with the arithmetic — ratings by version, the star distribution, the
 * movement — and says the themes were not computed and why.
 */
mobileHealthRoutes.get("/reviews/trend", async (c) => {
  const w = window(c);
  const n = Math.min(Math.max(Number(c.req.query("n") ?? 40) || 40, 1), 200);
  const doc = reviewDoc({
    days: w.days,
    limit: n,
    store: storeOf(c),
    app: c.req.query("app") ?? undefined,
  });
  const withText = doc.reviews.filter((r) => (r.body ?? "").trim() || (r.title ?? "").trim());

  let themes: { theme: string; sentiment: string; reviewIds: string[] }[] = [];
  let themeNote: string | null = null;
  let model: string | null = null;

  if (!withText.length) {
    themeNote = `No review in the last ${w.days} days carries any text, so there is nothing to read themes out of.`;
  } else if (c.req.query("themes") === "off") {
    themeNote = "Themes were not asked for (themes=off).";
  } else {
    const lines = withText.map(
      (r) =>
        `${r.id} | ${r.store} | ${r.rating ?? "no star"}★ | ${r.appVersion ?? "no version"} | ${(
          `${r.title ?? ""} ${r.body ?? ""}`
        ).replace(/\s+/g, " ").trim().slice(0, 400)}`,
    );
    const system =
      "You group app store reviews into themes. You are given one review per line as " +
      "`id | store | stars | version | text`. Answer with ONE JSON object: " +
      '{"themes":[{"theme":"...","sentiment":"complaint|praise|request","reviewIds":["..."]}]}. ' +
      "Rules you must not break: every theme cites the ids of the reviews it came from, and " +
      "an id you cite must appear in the input verbatim. Do not invent a theme that no cited " +
      "review supports. Do not summarise the app; summarise what these reviewers said. " +
      "At most eight themes. No prose outside the JSON.";
    try {
      const reply = await complete(
        [
          { role: "system", content: system },
          { role: "user", content: lines.join("\n") },
        ],
        { signal: AbortSignal.timeout(60_000) },
      );
      model = reply.model ?? null;
      const known = new Set(withText.map((r) => r.id));
      const text = reply.text;
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      const parsed =
        start >= 0 && end > start
          ? (JSON.parse(text.slice(start, end + 1)) as {
              themes?: { theme?: unknown; sentiment?: unknown; reviewIds?: unknown }[];
            })
          : null;
      themes = (parsed?.themes ?? [])
        .map((t) => ({
          theme: String(t.theme ?? "").trim(),
          sentiment: String(t.sentiment ?? "").trim() || "unknown",
          /* AN ID THE MODEL DID NOT GET IS DROPPED. This is the check that
             makes the citation worth anything: a hallucinated id names no
             review, and a theme left with no real citation is not published. */
          reviewIds: (Array.isArray(t.reviewIds) ? t.reviewIds : [])
            .map(String)
            .filter((id) => known.has(id)),
        }))
        .filter((t) => t.theme && t.reviewIds.length)
        .slice(0, 8);
      if (!themes.length)
        themeNote =
          "The model answered but cited no review id that appears in the input, so nothing was published.";
    } catch (err) {
      themeNote = `Themes were not computed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return c.json({
    window: doc.window,
    average: doc.average,
    stars: doc.stars,
    perDay: doc.perDay,
    byVersion: doc.byVersion,
    counts: doc.counts,
    read: withText.length,
    themes,
    themeNote,
    model,
    basis: doc.basis,
    rules: [
      ...doc.rules,
      "Themes are a MODEL'S reading of the review texts, not a measurement. Every theme cites the review ids it came from and an id that was not in the input is dropped before publication.",
      `Themes are computed over the ${n} most recent reviews with text in the window, no more.`,
    ],
    generatedAt: new Date().toISOString(),
  });
});

/**
 * SEND REVIEWS TO THE BOARD.
 *
 * The card is created through the board's OWN route over loopback rather than
 * by an INSERT here: the board owns its columns, its positions and its
 * validation, and a second writer reaching into `board_cards` is how two
 * cards end up at position 3. The review ids are recorded against the card so
 * the same complaint does not become five identical cards over five runs.
 */
mobileHealthRoutes.post("/reviews/triage", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    reviewIds?: unknown;
    title?: unknown;
    ventureId?: unknown;
    column?: unknown;
  } | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const ids = Array.isArray(body.reviewIds) ? body.reviewIds.map(String).filter(Boolean) : [];
  if (!ids.length)
    return c.json({ error: "reviewIds is required — a list of review ids from /api/mobilehealth/reviews." }, 400);
  if (ids.length > 25) return c.json({ error: "At most 25 reviews on one card." }, 400);

  const rows = store.reviewsByIds(ids);
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (!rows.length)
    return c.json(
      { error: `No review on this box has any of those ids. Unknown: ${missing.slice(0, 5).join(", ")}` },
      404,
    );

  const already = store.filedReviews(rows.map((r) => r.id));
  if (already.length === rows.length)
    return c.json(
      {
        error: `Every one of those reviews is already on card ${already[0]!.card_id}.`,
        cardId: already[0]!.card_id,
      },
      409,
    );

  const title =
    typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 200)
      : `${rows.length} app review${rows.length === 1 ? "" : "s"} to answer`;

  const text = [
    `From /api/mobilehealth/reviews. ${rows.length} review${rows.length === 1 ? "" : "s"}.`,
    "",
    ...rows.map(
      (r) =>
        `- **${r.rating ?? "no star"}★** ${r.store} · ${r.app}${r.app_version ? ` · v${r.app_version}` : ""}${
          r.territory ? ` · ${r.territory}` : ""
        } · ${(r.created ?? r.first_seen).slice(0, 10)}\n` +
        `  ${(r.title ? `${r.title} — ` : "") + (r.body ?? "(no text)")}`.replace(/\s+/g, " ").slice(0, 600) +
        `\n  id: \`${r.id}\``,
    ),
    "",
    "Replying to a review is not something this box can do — the reply is written in the store console.",
  ].join("\n");

  let card: { id?: number } | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/board/cards`, {
      method: "POST",
      headers: serviceHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        title,
        body: text,
        ventureId: typeof body.ventureId === "string" ? body.ventureId : undefined,
        column: typeof body.column === "string" ? body.column : undefined,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const doc = (await res.json().catch(() => ({}))) as {
      error?: string;
      columns?: { cards?: { id: number; title: string }[] }[];
    };
    if (!res.ok) return c.json({ error: doc.error ?? `The board answered HTTP ${res.status}.` }, 502);
    // The board answers with the whole board; the new card is the newest one
    // carrying this title.
    const cards = (doc.columns ?? []).flatMap((col) => col.cards ?? []);
    card = cards.filter((x) => x.title === title).at(-1) ?? null;
  } catch (err) {
    return c.json(
      { error: `Could not reach the board: ${err instanceof Error ? err.message : String(err)}` },
      502,
    );
  }

  if (!card?.id) return c.json({ error: "The board created no card this route could identify." }, 502);
  store.fileReviews(
    rows.map((r) => ({ store: r.store, app: r.app, reviewId: r.id })),
    card.id,
  );

  return c.json(
    {
      cardId: card.id,
      title,
      filed: rows.map((r) => r.id),
      alreadyFiled: already.map((a) => a.review_id),
      notFound: missing,
      note: "The card holds the review ids so the same reviews are not filed twice. Replying to a review is out of scope for this box.",
    },
    201,
  );
});

/* -------------------------------------------------------------- versions */

/**
 * THE VERSION HISTORY THE API DOES NOT PUBLISH.
 *
 * Apple says what each version's state IS and never when it changed, so the
 * history is what this box wrote down each day it looked. `observedOn` is
 * therefore the honest column name: a run of days at WAITING_FOR_REVIEW is
 * evidence a review took that long, and a GAP is a day nobody collected rather
 * than a day the state was unknown.
 */
mobileHealthRoutes.get("/versions", (c) => {
  const w = window(c);
  const rows = store.versions(w.since, c.req.query("app") ?? undefined);

  const byApp = new Map<string, Map<string, typeof rows>>();
  for (const r of rows) {
    const app = byApp.get(r.app) ?? new Map<string, typeof rows>();
    const list = app.get(r.version) ?? [];
    list.push(r);
    app.set(r.version, list);
    byApp.set(r.app, app);
  }

  return c.json({
    window: { days: w.days, from: w.since, to: isoDay(0), clampedFrom: w.clamped },
    measured: rows.length > 0,
    apps: [...byApp].map(([app, versions]) => ({
      app,
      versions: [...versions]
        .map(([version, obs]) => {
          const sorted = [...obs].sort((a, b) => a.observed_on.localeCompare(b.observed_on));
          const newest = sorted.at(-1)!;
          const phases = [...new Set(sorted.map((o) => o.phase))];
          return {
            version,
            platform: newest.platform,
            created: newest.created,
            /** Apple's newer vocabulary, then the older one, both verbatim. */
            state: newest.state,
            storeState: newest.store_state,
            /** DERIVED by this box from the two above — live | pending |
             *  in review | rejected | off sale | other. */
            phase: newest.phase,
            firstObserved: sorted[0]!.observed_on,
            lastObserved: newest.observed_on,
            daysObserved: sorted.length,
            /** More than one phase over the window means the state moved while
             *  this box was watching, and these are the days it was seen in. */
            phasesSeen: phases.map((p) => ({
              phase: p,
              days: sorted.filter((o) => o.phase === p).map((o) => o.observed_on),
            })),
          };
        })
        .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? "")),
    })),
    phases: {
      live: "READY_FOR_SALE / READY_FOR_DISTRIBUTION — people can get it",
      pending: "waiting for review, prepare for submission, processing, pending release",
      "in review": "in review with Apple, or pending Apple release",
      rejected: "rejected, developer rejected, metadata rejected, invalid binary",
      "off sale": "removed from sale",
      other: "a state this box has no reduction for; `state` and `storeState` carry Apple's own words",
    },
    rules: [
      "`observedOn` is the day this box LOOKED, not the day the state changed. Apple publishes no change dates.",
      "A gap in the observed days is a day nobody collected, not a day the version had no state.",
      "`phase` is derived by this box. `state` and `storeState` are Apple's own two vocabularies, unedited.",
      "Android has no equivalent: the Play Console publishes no version-state resource to this credential, so every row here is iOS.",
    ],
    generatedAt: new Date().toISOString(),
  });
});

/* ------------------------------------------------------------- the actions */

mobileHealthRoutes.post("/collect", async (c) => {
  const result = await collectNow();
  if (result.error && !result.ok) return c.json({ error: result.error, runId: result.runId }, 409);
  return c.json({
    ok: result.ok,
    runId: result.runId,
    note: result.note,
    play: result.play.map((a) => ({
      account: a.label,
      ok: a.ok,
      error: a.error ?? null,
      packages: a.packages,
      wrote: a.wrote,
      probes: a.probes,
      notes: a.notes,
    })),
    appstore: result.appstore.map((a) => ({
      account: a.label,
      ok: a.ok,
      error: a.error ?? null,
      apps: a.apps,
      wrote: a.wrote,
      probes: a.probes,
      notes: a.notes,
    })),
  });
});

/**
 * ASK APPLE TO START GENERATING ANALYTICS FOR AN APP.
 *
 * THE ONLY WRITE THIS AREA MAKES TO ANY STORE, and it is here rather than in
 * the collector because it changes the owner's Apple account: an ONGOING
 * request opts the app into continuous report generation. It is idempotent —
 * an app that already has one gets its existing id back and nothing is created
 * — and the first report arrives 24 to 48 hours later, which the reply says so
 * that nobody reads a 201 as "the data is here".
 */
mobileHealthRoutes.post("/ios/request", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { app?: unknown } | null;
  const appId = typeof body?.app === "string" ? body.app.trim() : "";
  if (!appId)
    return c.json({ error: "app is required — the Apple app id, as /api/mobile lists it." }, 400);

  const identities = appStoreIdentities();
  if (!identities.length) return c.json({ error: "No App Store Connect account is connected." }, 400);

  const problems: string[] = [];
  for (const { label, identity } of identities) {
    let token: string;
    try {
      token = mintToken(identity);
    } catch (err) {
      problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const res = await createAnalyticsRequest(token, appId);
    if (res.ok)
      return c.json(
        {
          app: appId,
          account: label,
          requestId: res.id,
          created: res.created,
          note: res.created
            ? "Apple accepted the ongoing analytics request. The first report arrives 24–48 hours later, and rows under five users or devices are dropped, so a small app may stay empty."
            : "An ongoing analytics request already existed for this app; nothing was created.",
        },
        res.created ? 201 : 200,
      );
    problems.push(`${label}: HTTP ${res.status} ${res.detail}`);
  }
  return c.json({ error: problems.join("; ") || "No account could act on that app." }, 502);
});

/* -------------------------------------------------------------- overview */

mobileHealthRoutes.get("/", (c) => {
  const w = window(c);
  const readiness = readinessDoc();
  const stability = stabilityDoc(w.days);
  const reviews = reviewDoc({ days: w.days, limit: 5 });

  return c.json({
    window: { days: w.days, from: w.since, to: isoDay(0), clampedFrom: w.clamped },
    stores: readiness.stores,
    lastCollected: readiness.lastCollected,
    collecting: readiness.collecting,
    probes: readiness.probes,
    readinessCounts: readiness.counts,
    dimensions: store.dimensionIndex(),
    analyticsReports: Object.entries(ANALYTICS_REPORTS).map(([name, spec]) => ({
      name,
      key: spec.key,
      metrics: spec.metrics,
      dimensions: spec.dims,
    })),
    stability: {
      counts: stability.counts.map((s) => ({
        store: s.store,
        app: s.app,
        source: s.source,
        metric: s.metric,
        unit: s.unit,
        total: s.total,
      })),
      rates: stability.rates.map((r) => ({
        store: r.store,
        app: r.app,
        metric: r.metric,
        window: r.window,
      })),
    },
    reviews: {
      counts: reviews.counts,
      inWindow: reviews.inWindow,
      average: reviews.average,
      stars: reviews.stars,
      latest: reviews.reviews,
    },
    separation:
      "This document measures what the apps DO. /api/mobile measures what they EARN, on a different " +
      "credential path: nothing that fails here can blank out a payout, an install total or a rating there.",
    generatedAt: new Date().toISOString(),
  });
});
