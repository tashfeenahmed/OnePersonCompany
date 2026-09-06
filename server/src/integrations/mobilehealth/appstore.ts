/**
 * iOS HEALTH — the analytics pipeline, the version history, and the reviews.
 *
 * providers/appstore.ts reads the money (sales and finance reports) and one
 * summary of each app's newest version. This file reads the three things that
 * are not money and are not derivable from it.
 *
 * THE ANALYTICS PIPELINE IS FOUR RESOURCES DEEP and every level has its own
 * way of being empty:
 *
 *   /v1/apps/<id>/analyticsReportRequests   an ONGOING request, or none
 *   /v1/analyticsReportRequests/<id>/reports  156 report names on the live
 *                                             account; six are wanted
 *   /v1/analyticsReports/<id>/instances     one per DAY, once Apple makes one
 *   /v1/analyticsReportInstances/<id>/segments  the download URLs
 *
 * Probed live on 2026-09-06: "App Downloads Standard" had 11 daily instances
 * and "App Store Discovery and Engagement Standard" had 12, while "App
 * Crashes", "App Sessions Standard", "App Store Purchases Standard" and "App
 * Store Installation and Deletion Standard" each had ZERO. That is four
 * different reports in the same request with the same permission answering
 * differently, which is exactly why readiness is recorded PER REPORT rather
 * than per account:
 *
 *   not_requested  no ONGOING request exists — nothing will ever arrive
 *   processing     the report is listed and Apple has produced no instance
 *   available      instances exist and were downloaded
 *   delayed        instances exist but the newest is older than Apple's own
 *                  two-day lag allows for
 *   unauthorized   the key was refused for this resource
 *
 * THE REQUEST IS A WRITE AND IS NOT MADE BY A TIMER. Creating an
 * analyticsReportRequest changes the owner's Apple account, and a background
 * pass that quietly opts an account into ongoing reporting is a surprise. So
 * the collector only ever READS the requests that exist; creating one is an
 * explicit action on /api/mobilehealth, published as a skill action, and it is
 * the only write this area makes to any store.
 *
 * APPLE'S ANALYTICS ARE PRIVACY-THRESHOLDED. Rows under five users or devices
 * are dropped and noise is added, so a small app's day is often empty — and an
 * empty day here is Apple withholding, not a measured zero. Every route that
 * publishes these figures repeats that sentence.
 *
 * iOS CRASHES: the report is named "App Crashes" and its metrics are `Crashes`
 * and `Unique Devices`. It is asked for on every pass. On the account this was
 * written against it has produced no instance, so the crash figure for iOS is
 * NULL with "Apple has generated no instance of App Crashes for this app"
 * beside it, and never a zero.
 */
import * as accounts from "../../accounts.ts";
import {
  AppStoreError,
  apiRequest,
  listApps,
  mintToken,
  reportText,
  type App,
  type Identity,
} from "../../providers/appstore.ts";
import {
  ANALYTICS_REPORTS,
  appStoreReview,
  foldAnalytics,
  snake,
  parseAnalyticsTsv,
  versionPhase,
} from "./parsers.ts";
import * as store from "./store.ts";

const API = "https://api.appstoreconnect.apple.com";
const USER_AGENT = "onepersoncompany-collector/1.0";
const TIMEOUT_MS = 60_000;

/** How many analytics instance CSVs one pass will download, across every app
 *  and report. A first run on a busy account would otherwise be hundreds of
 *  requests; what is deferred is picked up by the next pass, and the run note
 *  says how many were left. */
export const MAX_INSTANCE_DOWNLOADS = 40;

/** Apple's own stated lag: a day's analytics are complete two days later. An
 *  instance older than this plus a little slack is `delayed` rather than
 *  `available`, and the card says which. */
export const ANALYTICS_LAG_DAYS = 2;
const DELAYED_AFTER_DAYS = 5;

/** How many pages of reviews are walked per app per pass. Apple pages back to
 *  the app's first review; 20 × 200 is 4,000, which is every review this
 *  account has several times over and bounded for one that is bigger. */
export const REVIEW_PAGES = 20;

export type AppStoreHealthResult = {
  accountId: number;
  label: string;
  ok: boolean;
  error?: string;
  apps: { id: string; name: string }[];
  wrote: Record<string, number>;
  probes: { probe: string; ok: boolean; error?: string | null }[];
  notes: string[];
};

const isoDay = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

type Doc = {
  data?: { id: string; attributes?: Record<string, unknown> }[];
  links?: { next?: string };
  meta?: { paging?: { total?: number } };
};

/** A paginated JSON collection, with Apple's refusal carried back as data
 *  rather than thrown — this file records refusals per resource. */
async function pages(
  token: string,
  path: string,
  max: number,
): Promise<{ ok: true; rows: NonNullable<Doc["data"]> } | { ok: false; status: number; detail: string }> {
  const rows: NonNullable<Doc["data"]> = [];
  let next: string | undefined = path;
  for (let i = 0; i < max && next; i++) {
    const res = await apiRequest(token, next.startsWith(API) ? next.slice(API.length) : next);
    if (!res.ok) return res;
    let doc: Doc;
    try {
      doc = JSON.parse(res.body.toString("utf8")) as Doc;
    } catch {
      return { ok: false, status: 0, detail: "Apple's answer was not JSON" };
    }
    rows.push(...(doc.data ?? []));
    next = doc.links?.next;
  }
  return { ok: true, rows };
}

/* ------------------------------------------------------------- versions */

/**
 * Every version Apple lists, stamped with the day it was observed in this
 * state.
 *
 * THE API PUBLISHES A STATE, NOT A HISTORY. Nothing in it says when a version
 * entered review or when it was approved, so the history is built by writing
 * down what was true each day this box looked — which is why the column is
 * `observed_on`. A gap is a day nobody collected.
 */
async function ingestVersions(
  token: string,
  accountId: number,
  app: App,
  wrote: Record<string, number>,
) {
  const res = await pages(
    token,
    `/v1/apps/${app.id}/appStoreVersions?limit=50&fields[appStoreVersions]=versionString,appStoreState,appVersionState,createdDate,platform`,
    2,
  );
  if (!res.ok) {
    store.writeReportState({
      store: "appstore",
      accountId,
      app: app.id,
      report: "appStoreVersions",
      state: res.status === 401 || res.status === 403 ? "unauthorized" : "error",
      detail: res.detail,
    });
    return;
  }
  const observedOn = store.today();
  const rows = res.rows.map((v) => {
    const a = v.attributes ?? {};
    const state = (a.appVersionState as string | undefined) ?? null;
    const storeState = (a.appStoreState as string | undefined) ?? null;
    return {
      store: "appstore",
      accountId,
      app: app.id,
      version: String(a.versionString ?? v.id),
      observedOn,
      platform: (a.platform as string | undefined) ?? null,
      state,
      storeState,
      phase: versionPhase(state ?? storeState),
      created: ((a.createdDate as string | undefined) ?? "").slice(0, 10) || null,
    };
  });
  const n = store.writeVersions(rows);
  wrote.versions = (wrote.versions ?? 0) + n;
  store.writeReportState({
    store: "appstore",
    accountId,
    app: app.id,
    report: "appStoreVersions",
    state: n ? "present" : "empty",
    rows: n,
    period: observedOn,
  });
}

/* -------------------------------------------------------------- reviews */

async function ingestReviews(
  token: string,
  accountId: number,
  app: App,
  wrote: Record<string, number>,
) {
  const res = await pages(
    token,
    `/v1/apps/${app.id}/customerReviews?limit=200&sort=-createdDate` +
      `&fields[customerReviews]=rating,title,body,reviewerNickname,createdDate,territory`,
    REVIEW_PAGES,
  );
  if (!res.ok) {
    store.writeReportState({
      store: "appstore",
      accountId,
      app: app.id,
      report: "customerReviews",
      state: res.status === 401 || res.status === 403 ? "unauthorized" : "error",
      detail: res.detail,
    });
    return;
  }
  const rows = res.rows
    .map((r) => appStoreReview(app.id, r))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => ({ ...r, accountId }));
  const n = store.writeReviews(rows);
  wrote.reviews = (wrote.reviews ?? 0) + n;
  store.writeReportState({
    store: "appstore",
    accountId,
    app: app.id,
    report: "customerReviews",
    state: n ? "present" : "empty",
    rows: n,
    detail:
      "customerReviews pages back to the app's first review, all territories. " +
      "The territory and the star are Apple's; there is no app version on this resource.",
  });
}

/* ------------------------------------------------------------ analytics */

/** The ONGOING request for an app, if one exists. Never created here — see
 *  the file header; creating one is an explicit action. */
async function ongoingRequest(
  token: string,
  appId: string,
): Promise<{ ok: true; id: string | null } | { ok: false; status: number; detail: string }> {
  const res = await pages(token, `/v1/apps/${appId}/analyticsReportRequests?limit=50`, 1);
  if (!res.ok) return res;
  for (const r of res.rows) {
    const a = r.attributes ?? {};
    if (a.accessType === "ONGOING" && !a.stoppedDueToInactivity) return { ok: true, id: r.id };
  }
  return { ok: true, id: null };
}

/**
 * Create the ONGOING analytics request for an app.
 *
 * THE ONE WRITE THIS AREA MAKES TO A STORE, and it is behind a route rather
 * than a timer. It is also deliberately NOT retried: a POST that succeeded and
 * answered late would, on a retry, create a second request against the same
 * app. Apple then takes 24–48 hours to produce the first instance, which is
 * why the reply says so rather than implying data is now available.
 */
export async function createAnalyticsRequest(
  token: string,
  appId: string,
): Promise<{ ok: true; id: string; created: boolean } | { ok: false; status: number; detail: string }> {
  const existing = await ongoingRequest(token, appId);
  if (!existing.ok) return existing;
  if (existing.id) return { ok: true, id: existing.id, created: false };

  let res: Response;
  try {
    res = await fetch(`${API}/v1/analyticsReportRequests`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        data: {
          type: "analyticsReportRequests",
          attributes: { accessType: "ONGOING" },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      }),
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
    let detail = text.slice(0, 300);
    try {
      const errs = (JSON.parse(text) as { errors?: { detail?: string; title?: string }[] }).errors;
      if (errs?.length) detail = errs[0]!.detail ?? errs[0]!.title ?? detail;
    } catch {
      /* the raw body is the best sentence available */
    }
    return { ok: false, status: res.status, detail };
  }
  const id = (JSON.parse(text) as { data?: { id?: string } }).data?.id;
  if (!id) return { ok: false, status: res.status, detail: "Apple returned no request id" };
  return { ok: true, id, created: true };
}

async function downloadSegments(token: string, instanceId: string): Promise<string> {
  const segs = await pages(token, `/v1/analyticsReportInstances/${instanceId}/segments?limit=50`, 1);
  if (!segs.ok) throw new AppStoreError(segs.status, segs.detail);
  let text = "";
  for (const s of segs.rows) {
    const url = (s.attributes ?? {}).url as string | undefined;
    if (!url) continue;
    /*
      THE SEGMENT URL IS A PRE-SIGNED S3 LINK AND CARRIES NO BEARER. Sending
      the App Store Connect token to it would be handing Apple's credential to
      Amazon; the URL is the authorisation and it expires on its own.
    */
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new AppStoreError(res.status, `segment download answered HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const body = reportText(buf);
    text += body.endsWith("\n") ? body : `${body}\n`;
  }
  return text;
}

async function ingestAnalytics(
  token: string,
  accountId: number,
  app: App,
  budget: { left: number; deferred: number },
  wrote: Record<string, number>,
  notes: string[],
) {
  const request = await ongoingRequest(token, app.id);
  if (!request.ok) {
    for (const name of Object.keys(ANALYTICS_REPORTS))
      store.writeReportState({
        store: "appstore",
        accountId,
        app: app.id,
        report: `analytics/${name}`,
        state: request.status === 401 || request.status === 403 ? "unauthorized" : "error",
        detail: request.detail,
      });
    return;
  }
  if (!request.id) {
    for (const name of Object.keys(ANALYTICS_REPORTS))
      store.writeReportState({
        store: "appstore",
        accountId,
        app: app.id,
        report: `analytics/${name}`,
        state: "not_requested",
        detail:
          "no ONGOING analyticsReportRequest exists for this app, so Apple generates nothing. " +
          "POST /api/mobilehealth/ios/request with this app id to create one; the first report " +
          "arrives 24–48 hours later.",
      });
    notes.push(`${app.name}: no ongoing analytics request — nothing will arrive until one is made`);
    return;
  }

  const reports = await pages(token, `/v1/analyticsReportRequests/${request.id}/reports?limit=200`, 5);
  if (!reports.ok) {
    for (const name of Object.keys(ANALYTICS_REPORTS))
      store.writeReportState({
        store: "appstore",
        accountId,
        app: app.id,
        report: `analytics/${name}`,
        state: reports.status === 401 || reports.status === 403 ? "unauthorized" : "error",
        detail: reports.detail,
      });
    return;
  }

  const byName = new Map<string, string>();
  for (const r of reports.rows) {
    const name = (r.attributes ?? {}).name as string | undefined;
    if (name && name in ANALYTICS_REPORTS) byName.set(name, r.id);
  }

  const known = store.knownInstances(accountId, app.id);

  for (const [name, spec] of Object.entries(ANALYTICS_REPORTS)) {
    const reportId = byName.get(name);
    if (!reportId) {
      store.writeReportState({
        store: "appstore",
        accountId,
        app: app.id,
        report: `analytics/${name}`,
        state: "absent",
        detail: `Apple does not list a report named "${name}" for this request`,
      });
      continue;
    }

    const instances = await pages(
      token,
      `/v1/analyticsReports/${reportId}/instances?limit=200&filter[granularity]=DAILY`,
      2,
    );
    if (!instances.ok) {
      store.writeReportState({
        store: "appstore",
        accountId,
        app: app.id,
        report: `analytics/${name}`,
        state: instances.status === 401 || instances.status === 403 ? "unauthorized" : "error",
        detail: instances.detail,
      });
      continue;
    }

    const list = instances.rows
      .map((i) => ({ id: i.id, processed: ((i.attributes ?? {}).processingDate as string) ?? null }))
      .sort((a, b) => (b.processed ?? "").localeCompare(a.processed ?? ""));

    if (!list.length) {
      /*
        THE REPORT EXISTS AND APPLE HAS MADE NOTHING. On the live account this
        is the state of App Crashes, App Sessions, Purchases and Installation
        and Deletion — four reports with the same permission as the two that
        do answer. It is `processing`, never a zero.
      */
      store.writeReportState({
        store: "appstore",
        accountId,
        app: app.id,
        report: `analytics/${name}`,
        state: "processing",
        detail:
          "Apple lists this report and has generated no DAILY instance of it. Reports are " +
          "privacy-thresholded: a report stays empty until the app has enough users for Apple " +
          "to publish rows. This is Apple withholding, not a measured zero.",
        rows: 0,
      });
      continue;
    }

    let rows = 0;
    let downloaded = 0;
    let lastError: string | null = null;
    const missing = new Set<string>();
    for (const inst of list) {
      if (known.has(inst.id)) continue;
      if (budget.left <= 0) {
        budget.deferred += 1;
        continue;
      }
      budget.left -= 1;
      let text: string;
      try {
        text = await downloadSegments(token, inst.id);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }
      const parsed = parseAnalyticsTsv(text);
      const { folded, missingColumns } = foldAnalytics(parsed, spec);
      for (const m of missingColumns) missing.add(m);
      const n = store.writeDimensions(
        folded.map((f) => ({
          store: "appstore",
          accountId,
          app: app.id,
          day: f.day,
          dimension: f.dimension === "(all)" ? "(all)" : snake(f.dimension),
          value: f.value,
          metric: `${spec.key}.${snake(f.metric)}`,
          amount: f.amount,
          /* THE UNIT IS THE METRIC'S, NOT THE REPORT'S. One Apple report
             carries a count of events and a count of the distinct devices
             behind them; stamping the report's name on both would have
             labelled `Unique Devices` as "sessions" or "crashes". */
          unit: f.unit,
          report: name,
        })),
      );
      /*
        THE CRASHES REPORT ALSO LANDS IN mobile_stability, under its own source
        and unit, so a stability card can read one table for both stores. The
        dimensional copy stays as well: it is the same rows answering a
        different question (which version, which device).
      */
      if (spec.key === "crashes")
        store.writeStability(
          folded
            .filter((f) => f.metric === "Crashes")
            .map((f) => ({
              store: "appstore",
              accountId,
              app: app.id,
              day: f.day,
              source: `appstore-analytics:${name}`,
              metric: "crashes",
              dimension: f.dimension === "(all)" ? "(all)" : snake(f.dimension),
              value: f.value,
              amount: f.amount,
              unit: "crashes",
            })),
        );
      rows += n;
      downloaded += 1;
      store.writeInstance({
        accountId,
        app: app.id,
        report: name,
        instanceId: inst.id,
        processed: inst.processed,
        rows: n,
        bytes: text.length,
      });
    }
    wrote.dimensions = (wrote.dimensions ?? 0) + rows;

    const newest = list[0]?.processed ?? null;
    const stale = newest !== null && newest < isoDay(DELAYED_AFTER_DAYS);
    store.writeReportState({
      store: "appstore",
      accountId,
      app: app.id,
      report: `analytics/${name}`,
      state: lastError ? "error" : stale ? "delayed" : "available",
      detail:
        lastError ??
        (stale
          ? `the newest DAILY instance Apple has is ${newest}; a day's analytics are normally complete ${ANALYTICS_LAG_DAYS} days later, so this report has stopped being produced or is running late`
          : missing.size
            ? `columns Apple's file did not carry: ${[...missing].sort().join(", ")}`
            : null),
      rows,
      period: newest,
    });
    if (downloaded) notes.push(`${app.name}: ${name} — ${downloaded} new instance(s), ${rows} rows`);
  }
}

/* ------------------------------------------------------------- the pass */

export function identityOf(values: Record<string, string>): Identity {
  return {
    keyId: (values["key-id"] ?? "").trim(),
    issuerId: (values["issuer-id"] ?? "").trim(),
    vendor: (values.vendor ?? "").trim(),
    p8: values["key.p8"] ?? "",
  };
}

/** Every connected App Store Connect account's identity, for a route that has
 *  to act on one (the analytics-request action). */
export function appStoreIdentities(): { accountId: number; label: string; identity: Identity }[] {
  const { ready } = accounts.credentialed(
    "appstore",
    ["key-id", "issuer-id", "vendor", "key.p8"],
    "mobilehealth",
  );
  return ready.map(({ account, values }) => ({
    accountId: account.id,
    label: account.label,
    identity: identityOf(values),
  }));
}

export async function collectAppStoreHealth(): Promise<AppStoreHealthResult[]> {
  const { ready, broken } = accounts.credentialed(
    "appstore",
    ["key-id", "issuer-id", "vendor", "key.p8"],
    "mobilehealth",
  );
  const out: AppStoreHealthResult[] = [];

  for (const { account, missing } of broken)
    out.push({
      accountId: account.id,
      label: account.label,
      ok: false,
      error: `Missing ${missing.join(", ")}.`,
      apps: [],
      wrote: {},
      probes: [],
      notes: [],
    });

  for (const { account, values } of ready) {
    const wrote: Record<string, number> = {};
    const probes: AppStoreHealthResult["probes"] = [];
    const notes: string[] = [];
    try {
      const token = mintToken(identityOf(values));
      const apps = await listApps(token);
      store.writeProbe({ store: "appstore", accountId: account.id, probe: "appstoreconnect", ok: true });
      probes.push({ probe: "appstoreconnect", ok: true });

      const budget = { left: MAX_INSTANCE_DOWNLOADS, deferred: 0 };
      for (const app of apps) {
        await ingestVersions(token, account.id, app, wrote);
        await ingestReviews(token, account.id, app, wrote);
        await ingestAnalytics(token, account.id, app, budget, wrote, notes);
      }
      if (budget.deferred)
        notes.push(
          `${budget.deferred} analytics instance(s) left for the next pass — the per-pass download budget is ${MAX_INSTANCE_DOWNLOADS}`,
        );

      out.push({
        accountId: account.id,
        label: account.label,
        ok: true,
        apps: apps.map((a) => ({ id: a.id, name: a.name })),
        wrote,
        probes,
        notes,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      store.writeProbe({
        store: "appstore",
        accountId: account.id,
        probe: "appstoreconnect",
        ok: false,
        status: err instanceof AppStoreError ? err.status : null,
        error,
      });
      out.push({
        accountId: account.id,
        label: account.label,
        ok: false,
        error,
        apps: [],
        wrote,
        probes: [{ probe: "appstoreconnect", ok: false, error }],
        notes,
      });
    }
  }
  return out;
}
