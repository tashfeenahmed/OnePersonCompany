/**
 * App Store Connect.
 *
 * FOUR VALUES, AND ONLY ONE OF THEM IS A SECRET. Apple issues a team API key
 * as a `.p8` private key plus a key id and an issuer id, and the report
 * endpoints want a fifth thing that is not in the API at all — the VENDOR
 * NUMBER off the Payments and Financial Reports page. The p8 is the credential;
 * the other three are identifiers, printed in Apple's own console, and they are
 * ordinary text fields here so the owner can read back what the collector is
 * actually using. A write-only field you can never check is a field that
 * eventually holds a typo forever.
 *
 * THE JWT IS THE WHOLE OF THE AUTH, and it has one trap in it. Apple wants
 * ES256 with the signature in the JOSE form — r and s as 32 raw bytes each —
 * and Node's default is DER, which is the same signature wrapped in ASN.1
 * length prefixes. Hand Apple the DER and it answers 401, which reads exactly
 * like a bad key and sends you to regenerate one that was never wrong.
 * `dsaEncoding: "ieee-p1363"` is the one-word fix; it is spelled out below
 * because the failure it prevents costs an afternoon.
 *
 * THE TWO MONEY ENDPOINTS ARE NOT THE SAME MONEY, and keeping them apart is
 * the reason this file is shaped the way it is:
 *
 *   /v1/salesReports    one gzip'd TSV per DAY. Units, and Apple's ESTIMATED
 *                       developer proceeds per unit per storefront currency.
 *                       A preview of the money, before settlement.
 *   /v1/financeReports  one gzip'd TSV per closed fiscal MONTH. The partner
 *                       share Apple actually pays, per currency. This is the
 *                       only figure anything downstream may call revenue.
 *
 * They are never added, never averaged and never fall back to one another.
 *
 * READING APPLE'S 404s IS PART OF THE INTEGRATION. Probed live on 2026-09-04
 * against this account, the sales endpoint answers three different ways with
 * the same status code:
 *
 *   404 "There were no sales for the date specified."   -> a real ZERO day
 *   404 "Report is not available yet. …"                -> not generated YET
 *   410 "Report is no longer available. …"              -> past Apple's horizon
 *
 * A zero day is a measurement and is stored as one. A day that has not been
 * generated is an absence and is asked for again tomorrow. Treating the second
 * as the first draws a cliff in a chart on the day Apple happened to be slow.
 *
 * THE FINANCE ENDPOINT CANNOT MAKE THAT DISTINCTION AND SAYS SO. Every month
 * probed — closed, current, and one in the future — answered 404 with the same
 * "no sales for the date specified" sentence. So a missing finance report is
 * recorded as "Apple issued none", never as a payout of zero: the API does not
 * distinguish "you earned nothing" from "that month is not settled", and a
 * zero on a revenue card is a claim neither this file nor Apple can support.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";
import { createPrivateKey, sign } from "node:crypto";
import { gunzipSync } from "node:zlib";

const API = "https://api.appstoreconnect.apple.com";
const LOOKUP = "https://itunes.apple.com/lookup";
const TIMEOUT_MS = 45_000;
const USER_AGENT = "onepersoncompany-collector/1.0";

/** How much of the daily sales history is kept in view. Apple serves daily
 *  reports for about a year; thirty days is what every card on the board is
 *  drawn over, and days already stored are not re-fetched. */
export const SALES_DAYS = 30;

/** Closed fiscal months asked about for a payout. Apple names the report after
 *  the calendar month its fiscal period falls in, which is what a card labels. */
export const FINANCE_MONTHS = 6;

/** Days Apple has not generated yet are re-asked; a day already answered is
 *  never asked twice, except the newest two — Apple revises a fresh day. */
export const REVISE_DAYS = 2;

export class AppStoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AppStoreError";
    this.status = status;
  }
}

/* -------------------------------------------------------------------- auth */

export type Identity = {
  keyId: string;
  issuerId: string;
  vendor: string;
  /** The .p8, PEM text exactly as Apple downloaded it. */
  p8: string;
};

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * A twenty-minute ES256 token for this key.
 *
 * Minted per collection rather than cached across runs: a run is seconds long
 * and a token that outlives the process it was made for is a credential
 * sitting in memory for no reason. `aud` is Apple's fixed literal — it is not
 * a URL and does not vary by endpoint.
 */
export function mintToken(id: Identity): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(
    JSON.stringify({ alg: "ES256", kid: id.keyId, typ: "JWT" }),
  );
  const payload = b64url(
    JSON.stringify({
      iss: id.issuerId,
      iat: now,
      exp: now + 20 * 60,
      aud: "appstoreconnect-v1",
    }),
  );

  let key;
  try {
    key = createPrivateKey(id.p8);
  } catch {
    throw new AppStoreError(
      400,
      "That is not a readable private key. Paste the .p8 file whole, including the BEGIN and END lines.",
    );
  }

  // ieee-p1363 IS THE LOAD-BEARING OPTION. Without it Node emits DER and
  // Apple answers 401 — a failure that looks like a rejected key rather than
  // a mis-encoded signature, which is why it is named here rather than left
  // to the reader to notice.
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${b64url(signature)}`;
}

/* ------------------------------------------------------------------ fetch */

type Fetched = { ok: true; body: Buffer } | { ok: false; status: number; detail: string };

/**
 * One request, with Apple's own error sentence carried back rather than
 * flattened into "HTTP 404".
 *
 * The detail string is the whole distinction between a zero day and a day
 * that does not exist yet, so it is returned as data rather than thrown —
 * the caller decides which 404s are findings and which are failures.
 */
async function request(
  token: string,
  path: string,
  accept: string,
): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new AppStoreError(
      0,
      err instanceof Error && err.name === "TimeoutError"
        ? "App Store Connect did not answer within 45 seconds."
        : "Could not reach App Store Connect.",
    );
  }

  if (res.ok) return { ok: true, body: Buffer.from(await res.arrayBuffer()) };

  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 200);
  try {
    const errs = (JSON.parse(text) as { errors?: { detail?: string; title?: string }[] }).errors;
    if (errs?.length) detail = errs[0]!.detail ?? errs[0]!.title ?? detail;
  } catch {
    /* not JSON — the raw body is the best sentence available */
  }
  return { ok: false, status: res.status, detail };
}

/**
 * The same request, exported, with the status and Apple's own sentence intact.
 *
 * The mobilehealth area needs exactly this and not `json()`: its whole job is
 * to tell "the key cannot read this report" apart from "Apple has not made one
 * yet", and both arrive as an HTTP status with a sentence in the body. A
 * thrown Error flattens that distinction into a string, so the area that must
 * record the distinction reads the pair.
 */
export async function apiRequest(
  token: string,
  path: string,
  accept = "application/json",
): Promise<Fetched> {
  return request(token, path, accept);
}

/** A gzip'd report body as text, for a caller that has one. Exported for the
 *  same area, whose analytics segments arrive gzip'd from S3 rather than from
 *  this API and are otherwise decoded identically. */
export function reportText(body: Buffer): string {
  return ungzip(body);
}

async function json<T>(token: string, path: string): Promise<T> {
  const res = await request(token, path, "application/json");
  if (!res.ok) {
    if (res.status === 401 || res.status === 403)
      throw new AppStoreError(
        res.status,
        `App Store Connect refused the key (HTTP ${res.status}). Check the key id, the issuer id, and that the key still exists under Users and Access → Integrations.`,
      );
    throw new AppStoreError(res.status, `App Store Connect answered HTTP ${res.status}: ${res.detail}`);
  }
  return JSON.parse(res.body.toString("utf8")) as T;
}

/** The report endpoints answer 406 to `application/json` — they speak only
 *  `application/a-gzip`, and the body is a gzip'd TSV in UTF-8. */
function ungzip(body: Buffer): string {
  try {
    return gunzipSync(body).toString("utf8");
  } catch {
    // Some eras answer with the TSV uncompressed. Reading it anyway is
    // strictly better than failing on a report that arrived.
    return body.toString("utf8");
  }
}

/* ---------------------------------------------------------------- parsing */

/** "Developer Proceeds (per unit)" -> "developerproceeds". Apple's headers
 *  drift in punctuation between eras; the letters survive. Never positional:
 *  columns are added in the middle. */
const norm = (header: string) =>
  header.replace(/\(.*?\)/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

export type ReportRow = Record<string, string>;

/** A tab-separated report as rows keyed by normalised header. Apple's files
 *  end with blank lines and, in some eras, a "Total" footer; both are dropped
 *  because a footer summed with the rows doubles the report. */
export function parseTsv(text: string): ReportRow[] {
  const lines = text.split(/\r?\n/);
  const head = lines.shift();
  if (!head) return [];
  const keys = head.split("\t").map(norm);
  const rows: ReportRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    if (cells[0]?.trim().toLowerCase().startsWith("total")) continue;
    const row: ReportRow = {};
    keys.forEach((k, i) => (row[k] = (cells[i] ?? "").trim()));
    rows.push(row);
  }
  return rows;
}

/** A report cell as a number, or null. Apple writes "1,234.56" in some columns
 *  and bare integers in others; an empty cell is not a zero. */
export function num(v: string | undefined): number | null {
  const s = (v ?? "").trim().replace(/,/g, "");
  if (!s || s === "-" || s === "—") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sales-report product types.
 *
 * A first download of the app is one of the "1" family (plus the Mac F1
 * twins); the "7" family is updates and the "3" family re-downloads — neither
 * is a new user, and adding them to downloads would inflate the top of the
 * funnel with people who were already there. Anything beginning IA or FI is an
 * in-app purchase or a subscription and counts as units, never as a download.
 */
const DOWNLOAD_TYPES = new Set(["1", "1-B", "1E", "1EP", "1EU", "1F", "1T", "F1", "F1-B"]);
const UPDATE_TYPES = new Set(["7", "7F", "7T", "F7", "3", "3F", "3T"]);

/** Version states that mean "people can get it" against "it is on its way".
 *  Both the newer appVersionState vocabulary and the older appStoreState one
 *  appear on the same resource, and both are read. */
const LIVE_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);
const REJECTED_STATES = new Set([
  "REJECTED",
  "DEVELOPER_REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

/* ------------------------------------------------------------------ shapes */

export type App = {
  id: string;
  bundleId: string;
  name: string;
  sku: string;
  primaryLocale: string;
  /** The newest version's state, and whether that state means "on the store". */
  state: string | null;
  version: string | null;
  onStore: boolean;
  /** From the public iTunes listing, which is where ratings live — they are
   *  not in the API at all. Null means nobody has rated it, which is not zero
   *  stars. */
  ratingAverage: number | null;
  ratingCount: number | null;
  /** The storefront the rating was read from: ratings are per country. */
  storefront: string | null;
  /** False when the app is not listed on that storefront — for an app in
   *  review that is the whole finding. */
  listed: boolean | null;
  releasedAt: string | null;
};

/** What Apple said about one day of sales. */
export type SalesDay = {
  day: string;
  /** reported: rows arrived · zero: Apple says there were no sales ·
   *  absent: not generated yet · gone: past Apple's retention horizon. */
  state: "reported" | "zero" | "absent" | "gone";
  apps: { appId: string; downloads: number; updates: number; inAppUnits: number }[];
  /** ESTIMATED developer proceeds, per app per currency. Never a payout. */
  proceeds: { appId: string; currency: string; amount: number }[];
};

export type FinanceMonth = {
  month: string;
  /** reported: Apple issued a financial report · none: it did not, and the API
   *  gives no way to tell "nothing was earned" from "not settled yet". */
  state: "reported" | "none";
  rows: { appId: string | null; currency: string; amount: number }[];
};

export type AccountResult = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  keyId?: string;
  issuerId?: string;
  vendor?: string;
  apps?: App[];
  sales?: SalesDay[];
  finance?: FinanceMonth[];
  /** Days Apple has not generated yet, so a run note can say why a window is
   *  short without a reader assuming the collector is broken. */
  absentDays?: string[];
};

export type CollectResult = {
  accounts: AccountResult[];
  accountsTried: number;
  warnings: string[];
};

/* ------------------------------------------------------------------- calls */

type AppsDoc = {
  data?: { id: string; attributes?: Record<string, string | null> }[];
  links?: { next?: string };
};

export async function listApps(token: string): Promise<App[]> {
  const out: App[] = [];
  let path = "/v1/apps?limit=100&fields[apps]=name,bundleId,sku,primaryLocale";
  for (let page = 0; page < 5 && path; page++) {
    const doc = await json<AppsDoc>(token, path);
    for (const row of doc.data ?? []) {
      const a = row.attributes ?? {};
      out.push({
        id: String(row.id),
        bundleId: a.bundleId ?? "",
        name: a.name ?? a.bundleId ?? String(row.id),
        sku: a.sku ?? "",
        primaryLocale: a.primaryLocale ?? "en-US",
        state: null,
        version: null,
        onStore: false,
        ratingAverage: null,
        ratingCount: null,
        storefront: null,
        listed: null,
        releasedAt: null,
      });
    }
    const next = doc.links?.next;
    path = next ? (next.startsWith(API) ? next.slice(API.length) : next) : "";
  }
  return out;
}

/**
 * Whether an app is actually ON the store.
 *
 * This is the finding the money cannot express: an app sitting at
 * WAITING_FOR_REVIEW earns nothing and is not failing to earn — it is not on
 * sale. A revenue board with no such card invites the reader to read "no
 * proceeds" as a market verdict about an app nobody could buy.
 */
export async function appState(token: string, appId: string) {
  const doc = await json<{
    data?: { attributes?: Record<string, string | null> }[];
  }>(
    token,
    `/v1/apps/${appId}/appStoreVersions?limit=10&fields[appStoreVersions]=versionString,appStoreState,appVersionState,createdDate,platform`,
  );
  const versions = (doc.data ?? []).map((v) => ({
    version: v.attributes?.versionString ?? null,
    state: v.attributes?.appVersionState ?? v.attributes?.appStoreState ?? "UNKNOWN",
  }));
  const live = versions.find((v) => LIVE_STATES.has(v.state));
  const rejected = versions.find((v) => REJECTED_STATES.has(v.state));
  const current = live ?? rejected ?? versions[0];
  return {
    state: current?.state ?? null,
    version: current?.version ?? null,
    onStore: Boolean(live),
  };
}

/** "en-GB" -> "gb". Ratings are per storefront and the primary locale's region
 *  is the one the owner sees in the console. */
export function storefrontOf(locale: string): string {
  const m = /^[a-z]{2}[-_]([A-Za-z]{2})$/.exec(locale ?? "");
  return (m ? m[1]! : "us").toLowerCase();
}

/**
 * Stars, from the public listing.
 *
 * RATINGS ARE NOT IN THE APP STORE CONNECT API. The iTunes lookup endpoint has
 * them per storefront and needs no auth, which is why this one call leaves the
 * bearer behind. Apple reports `averageUserRating: 0` for an app nobody has
 * rated — the average of no ratings is not zero stars, it is no rating, so a
 * count of zero produces a null average and a card that says "no ratings yet".
 */
export async function lookupRating(appId: string, storefront: string) {
  const res = await fetch(
    `${LOOKUP}?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(storefront)}`,
    { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) return null;
  const doc = (await res.json()) as {
    results?: { averageUserRating?: number; userRatingCount?: number; version?: string; currentVersionReleaseDate?: string }[];
  };
  const r = doc.results?.[0];
  if (!r) return { listed: false, average: null, count: null, releasedAt: null };
  const count = typeof r.userRatingCount === "number" ? r.userRatingCount : null;
  return {
    listed: true,
    average:
      typeof r.averageUserRating === "number" && count ? Number(r.averageUserRating.toFixed(2)) : null,
    count,
    releasedAt: (r.currentVersionReleaseDate ?? "").slice(0, 10) || null,
  };
}

/* ------------------------------------------------------------------- sales */

/** Apple's own sentences, matched on the phrase rather than the whole string —
 *  the tail of each carries a support URL that changes. */
const NO_SALES = "no sales for the date";
const NOT_YET = "not available yet";

export async function salesDay(
  token: string,
  vendor: string,
  day: string,
  apps: App[],
): Promise<SalesDay> {
  const path =
    `/v1/salesReports?filter[frequency]=DAILY&filter[reportSubType]=SUMMARY` +
    `&filter[reportType]=SALES&filter[version]=1_1&filter[vendorNumber]=${encodeURIComponent(vendor)}` +
    `&filter[reportDate]=${day}`;
  const res = await request(token, path, "application/a-gzip");

  if (!res.ok) {
    const detail = res.detail.toLowerCase();
    if (res.status === 410) return { day, state: "gone", apps: [], proceeds: [] };
    if (res.status === 404 && detail.includes(NO_SALES))
      return { day, state: "zero", apps: [], proceeds: [] };
    if (res.status === 404 && detail.includes(NOT_YET))
      return { day, state: "absent", apps: [], proceeds: [] };
    if (res.status === 401 || res.status === 403)
      throw new AppStoreError(
        res.status,
        "This key cannot read sales reports — it needs the Sales and Reports (or Finance) role in Users and Access.",
      );
    if (res.status >= 500)
      throw new AppStoreError(
        res.status,
        `Apple answered HTTP ${res.status} for vendor number ${vendor}. A vendor number that does not belong to this key's team answers exactly this way.`,
      );
    throw new AppStoreError(res.status, `Sales report for ${day}: ${res.detail}`);
  }

  return attributeSales(day, parseTsv(ungzip(res.body)), apps);
}

/**
 * One day's rows folded onto the apps they belong to.
 *
 * An in-app purchase carries its OWN Apple identifier and names its app
 * through Parent Identifier, which holds the app's SKU. A row that matches
 * nothing is dropped rather than added to an arbitrary app — a subscription
 * from a deleted app landing in a neighbour's total is worse than a total that
 * is short.
 */
export function attributeSales(day: string, rows: ReportRow[], apps: App[]): SalesDay {
  const byId = new Set(apps.map((a) => a.id));
  const bySku = new Map(apps.filter((a) => a.sku).map((a) => [a.sku, a.id]));

  const units = new Map<string, { downloads: number; updates: number; inAppUnits: number }>();
  const proceeds = new Map<string, number>();

  for (const r of rows) {
    const appleId = r.appleidentifier ?? "";
    const appId =
      (byId.has(appleId) ? appleId : null) ??
      bySku.get(r.parentidentifier ?? "") ??
      bySku.get(r.sku ?? "") ??
      null;
    if (!appId) continue;

    const n = Math.round(num(r.units) ?? 0);
    const type = r.producttypeidentifier ?? "";
    const bucket =
      units.get(appId) ?? { downloads: 0, updates: 0, inAppUnits: 0 };
    if (DOWNLOAD_TYPES.has(type)) bucket.downloads += n;
    else if (UPDATE_TYPES.has(type)) bucket.updates += n;
    else if (type.startsWith("IA") || type.startsWith("FI")) bucket.inAppUnits += n;
    units.set(appId, bucket);

    /*
      Proceeds are PER UNIT in this report, so the row's contribution is the
      per-unit figure times the units. A zero-proceeds row is not recorded at
      all: every free download carries one, and a table full of 0.00 EUR rows
      would turn "this app has never earned" into a currency breakdown of
      nothing.
    */
    const per = num(r.developerproceeds) ?? 0;
    const currency = (r.currencyofproceeds ?? "").toUpperCase();
    if (per && currency) {
      const key = `${appId} ${currency}`;
      proceeds.set(key, (proceeds.get(key) ?? 0) + per * n);
    }
  }

  return {
    day,
    state: "reported",
    apps: [...units].map(([appId, v]) => ({ appId, ...v })),
    proceeds: [...proceeds].map(([key, amount]) => {
      const [appId, currency] = key.split(" ");
      return { appId: appId!, currency: currency!, amount: Number(amount.toFixed(2)) };
    }),
  };
}

/* ----------------------------------------------------------------- finance */

export async function financeMonth(
  token: string,
  vendor: string,
  month: string,
  apps: App[],
): Promise<FinanceMonth> {
  const path =
    `/v1/financeReports?filter[regionCode]=ZZ&filter[reportType]=FINANCIAL` +
    `&filter[vendorNumber]=${encodeURIComponent(vendor)}&filter[reportDate]=${month}`;
  const res = await request(token, path, "application/a-gzip");

  if (!res.ok) {
    /*
      EVERY MISS HERE IS "NONE ISSUED", AND THAT IS AS FAR AS APPLE WILL GO.
      Probed on 2026-09-04, the finance endpoint answered 404 "There were no
      sales for the date specified." for a closed month, for the current month
      and for a month in the future alike — so unlike the daily reports there
      is no sentence that separates "nothing was earned" from "not settled
      yet". Recording it as a payout of zero would be inventing the half of the
      answer Apple withheld.
    */
    if (res.status === 404 || res.status === 410) return { month, state: "none", rows: [] };
    if (res.status === 401 || res.status === 403)
      throw new AppStoreError(
        res.status,
        "This key cannot read finance reports — it needs the Finance role in Users and Access.",
      );
    throw new AppStoreError(res.status, `Finance report for ${month}: ${res.detail}`);
  }

  const rows = parseTsv(ungzip(res.body));
  const byId = new Set(apps.map((a) => a.id));
  const bySku = new Map(apps.filter((a) => a.sku).map((a) => [a.sku, a.id]));
  const sums = new Map<string, number>();

  for (const r of rows) {
    const appleId = r.appleidentifier ?? "";
    const appId =
      (byId.has(appleId) ? appleId : null) ?? bySku.get(r.vendoridentifier ?? "") ?? null;
    const share = num(r.extendedpartnershare);
    const currency = (r.partnersharecurrency ?? "").toUpperCase();
    if (share === null || !currency) continue;
    // A row that matches no app is kept under a null app rather than dropped:
    // it is money that was paid, and a payout total that quietly omits it
    // would disagree with the statement Apple sent.
    const key = `${appId ?? ""} ${currency}`;
    sums.set(key, (sums.get(key) ?? 0) + share);
  }

  return {
    month,
    state: "reported",
    rows: [...sums].map(([key, amount]) => {
      const [appId, currency] = key.split(" ");
      return { appId: appId || null, currency: currency!, amount: Number(amount.toFixed(2)) };
    }),
  };
}

/* ------------------------------------------------------------------ verify */

/**
 * Are these four values real, and do they belong together?
 *
 * TWO CALLS, BECAUSE THERE ARE TWO WAYS TO BE WRONG. `/v1/apps` proves the
 * key, the key id and the issuer id are a working set; it says nothing at all
 * about the vendor number, which is not part of the JWT and lives on a
 * different page of the console. A wrong vendor number answers HTTP 500 on the
 * report endpoint — probed with a made-up one on 2026-09-04 — so the second
 * call is what turns "the dashboard is mysteriously empty" into a sentence
 * said at the moment the number was typed.
 */
export async function verify(
  id: Identity,
): Promise<{ ok: true; apps: number; teamName: string | null } | { ok: false; error: string }> {
  try {
    const token = mintToken(id);
    const apps = await listApps(token);

    // Yesterday rather than today: today's report does not exist yet, and its
    // "not available yet" is a valid answer that proves the vendor number was
    // accepted just as well as a report would.
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await salesDay(token, id.vendor, day, apps);

    return { ok: true, apps: apps.length, teamName: apps[0]?.name ?? null };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof AppStoreError ? err.message : "Could not reach App Store Connect.",
    };
  }
}

/* ----------------------------------------------------------------- collect */

export type Known = {
  /** Days already answered, so a run costs one request per NEW day rather
   *  than thirty every half hour. */
  answeredDays: Set<string>;
  /** Months already reported. A closed month's payout does not change. */
  reportedMonths: Set<string>;
};

const isoDay = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** The last N calendar months, newest first, never including this one — a
 *  month still running has no payout to report. */
export function closedMonths(n: number, today = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  for (let i = 0; i < n; i++) {
    d.setUTCMonth(d.getUTCMonth() - 1);
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/**
 * One account, collected.
 *
 * The order is deliberate: the apps first, because everything below attributes
 * rows to them; then the store state and the ratings, which are the findings
 * the money cannot express; then sales; then finance. A failure in any later
 * block costs its own rows and leaves the earlier ones standing — an app list
 * with no payout is a partial answer, an empty page is not an answer at all.
 */
export async function collectAccount(
  account: Account,
  id: Identity,
  known: Known,
): Promise<AccountResult> {
  const token = mintToken(id);
  const apps = await listApps(token);

  for (const app of apps) {
    try {
      const state = await appState(token, app.id);
      app.state = state.state;
      app.version = state.version;
      app.onStore = state.onStore;
    } catch {
      // A version listing that failed leaves the app's state null — which is
      // "not known", and reads on the card as such rather than as "not live".
    }
    try {
      const storefront = storefrontOf(app.primaryLocale);
      const rating = await lookupRating(app.id, storefront);
      if (rating) {
        app.storefront = storefront;
        app.listed = rating.listed;
        app.ratingAverage = rating.average;
        app.ratingCount = rating.count;
        app.releasedAt = rating.releasedAt;
      }
    } catch {
      /* the public listing is a courtesy; its absence costs one field */
    }
  }

  /*
    WHICH DAYS ARE WORTH A REQUEST. A day already answered is never asked
    again — Apple's closed daily reports do not change — except the newest
    couple, which it does revise. Everything else is a day that was absent last
    time and may exist now. Thirty requests on the first run, one or two a day
    after that.
  */
  const sales: SalesDay[] = [];
  const absentDays: string[] = [];
  for (let i = 1; i <= SALES_DAYS; i++) {
    const day = isoDay(i);
    if (known.answeredDays.has(day) && i > REVISE_DAYS) continue;
    const result = await salesDay(token, id.vendor, day, apps);
    sales.push(result);
    if (result.state === "absent") absentDays.push(day);
    // Past Apple's retention horizon there is nothing older to find, so the
    // walk stops rather than spending the rest of the window on 410s.
    if (result.state === "gone") break;
  }

  const finance: FinanceMonth[] = [];
  for (const month of closedMonths(FINANCE_MONTHS)) {
    if (known.reportedMonths.has(month)) continue;
    finance.push(await financeMonth(token, id.vendor, month, apps));
  }

  return {
    id: account.id,
    label: account.label,
    ok: true,
    keyId: id.keyId,
    issuerId: id.issuerId,
    vendor: id.vendor,
    apps,
    sales,
    finance,
    absentDays,
  };
}

/** Every connected account, each failing on its own. */
export async function collect(
  known: (accountId: number) => Known,
  reader = "collect_appstore",
): Promise<CollectResult> {
  const { ready, broken } = accounts.credentialed(
    "appstore",
    ["key-id", "issuer-id", "vendor", "key.p8"],
    reader,
  );
  const out: AccountResult[] = [];
  const warnings: string[] = [];

  for (const { account, missing } of broken) {
    const error = `Missing ${missing.join(", ")}.`;
    out.push({ id: account.id, label: account.label, ok: false, error });
    warnings.push(`${account.label}: ${error}`);
  }

  for (const { account, values } of ready) {
    const id: Identity = {
      keyId: (values["key-id"] ?? "").trim(),
      issuerId: (values["issuer-id"] ?? "").trim(),
      vendor: (values.vendor ?? "").trim(),
      p8: values["key.p8"] ?? "",
    };
    try {
      out.push(await collectAccount(account, id, known(account.id)));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      out.push({ id: account.id, label: account.label, ok: false, error });
      warnings.push(`${account.label}: ${error}`);
    }
  }

  return { accounts: out, accountsTried: ready.length + broken.length, warnings };
}
