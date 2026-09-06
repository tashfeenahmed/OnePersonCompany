/**
 * Google Search Console.
 *
 * ONE CREDENTIAL — a Google Cloud service account JSON, added as a user on
 * each property — and one API surface: the Search Console v3 endpoints under
 * `webmasters/v3`. Nothing here calls the URL Inspection API and nothing calls
 * the Indexing API: the first is quota'd at a couple of hundred URLs a day and
 * answers a question about ONE page, and the second is a write. This reads
 * performance, and it reads it for every property the account can see.
 *
 * THE SCOPE IS `webmasters.readonly` AND NOTHING ELSE, which is the honest
 * scope for a dashboard: it cannot submit a sitemap, cannot request indexing
 * and cannot add or remove a user, and none of that is a promise in a comment
 * — Google refuses those calls to a token minted with this scope.
 *
 * `searchAnalytics.query` IS A POST, AND IT IS A READ. That is worth naming
 * because this codebase's other providers are GET-only by construction and
 * Stripe's says so in as many words. Google made this one a POST for a
 * mechanical reason: the request carries a filter document — dimensions, row
 * limits, date ranges, dimension filter groups — that does not fit in a query
 * string. It returns aggregates, it creates nothing, and there is no
 * corresponding resource to have been modified. The exception is therefore
 * exactly one path, `sites/{property}/searchAnalytics/query`, and every other
 * call in this file is a GET.
 *
 * THE TWO THINGS GOOGLE WILL NOT TELL YOU STRAIGHT, both of which have shaped
 * everything downstream:
 *
 *   THE LAST FEW DAYS ARE NOT FINISHED. Search Console finalises a day over
 *   roughly two to three days. Ask for today and you get a real row carrying a
 *   fraction of what today will eventually have been — which draws as a
 *   collapse in traffic that never happened. So every window here ends
 *   LAG_DAYS back AND is asked with `dataState: "final"`. Belt and braces on
 *   purpose: the flag is Google's own promise, the offset is ours, and the one
 *   that costs nothing is the one that keeps working when the other changes.
 *
 *   THE QUERY ROWS DO NOT ADD UP TO THE PROPERTY. Google withholds queries
 *   too rare to be anonymised and caps the rows it returns. Probed across all
 *   nineteen properties on this account on 2026-09-04, the ranked query rows
 *   carried between 0% and 77% of their property's impressions — 2% on
 *   example-app-1.example.test, where two hundred rows out of a long tail is a rounding
 *   error. So the property's own total is asked for SEPARATELY, as a
 *   dimensionless query, and the two figures are never mixed: the ranked rows
 *   are a ranking, and the total is the total. `queryCoverage` on every
 *   property says what fraction one is of the other, so a card can print the
 *   caveat with the number rather than in a footnote.
 *
 * The daily rows are the happy exception. Summed over the same window they
 * matched Google's dimensionless total EXACTLY on the property that was
 * checked (23,157 against 23,157) — a date is not a thing that can be
 * anonymised — which is why every window figure the board draws is summed from
 * the stored days rather than stored as a total that would age.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";
import { createPrivateKey, sign } from "node:crypto";

const BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TIMEOUT_MS = 45_000;
const USER_AGENT = "onepersoncompany-collector/1.0";

/**
 * How far back a window ends. Three days, which is the far edge of Google's
 * own "2-3 days" and the one that is never a partial bucket.
 */
export const LAG_DAYS = 3;

/**
 * How much daily history one run asks for.
 *
 * NINETY DAYS COSTS EXACTLY WHAT TWENTY-EIGHT DOES — one call — because the
 * date breakdown returns a row per day inside a single request. So the wider
 * window is free, and it is what makes a chart worth drawing on the first
 * collection instead of in three months' time. The row limit has to cover it:
 * the API sorts by CLICKS, so a window asked for with a cap below its own
 * length comes back as the best-clicking days and the rest read as measured
 * zeroes. 500 is comfortably over ninety and Google's own ceiling is 25,000.
 */
export const HISTORY_DAYS = 90;
export const DATE_ROW_LIMIT = 500;

/**
 * The window the ranked breakdowns describe.
 *
 * TWENTY-EIGHT DAYS AND NOT THIRTY, because 28 is Search Console's own window
 * and the figure the owner will see if they open the console to check. A
 * dashboard that quietly says 30 disagrees with Google by two days of traffic
 * for no reason anybody can find later.
 */
export const WINDOW_DAYS = 28;

/** Rows asked for on the two ranked breakdowns. Queries wide because the tail
 *  is the interesting part; pages narrow because a property with a thousand
 *  URLs has ten that matter. */
export const QUERY_ROWS = 200;
export const PAGE_ROWS = 25;

/**
 * How many properties are asked at once.
 *
 * Nineteen properties at five calls each is ninety-five requests, and
 * sequentially that measured 12.8 seconds for seventy-six of them — slow
 * enough to be felt inside the HTTP request that stores a credential. Four at
 * a time brings it to a few seconds and is nowhere near Search Console's
 * 1,200-queries-a-minute ceiling. It is deliberately not ten: this shares a
 * quota with nothing and has all day.
 */
const CONCURRENCY = 4;

export class GscError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GscError";
    this.status = status;
  }
}

/* -------------------------------------------------------------------- auth */

export type ServiceAccount = {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
  project_id?: string;
};

/**
 * The JSON, parsed and checked for the two fields that make it usable.
 *
 * A key file missing `private_key` is refused here rather than three frames
 * away, where the failure reads as "Google rejected the signature" and sends
 * the owner off to mint a key that was never the problem.
 */
export function readServiceAccount(text: string): ServiceAccount {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new GscError(400, "That is not JSON. Paste the service account key file whole.");
  }
  const sa = doc as ServiceAccount;
  if (!sa?.client_email || !sa?.private_key)
    throw new GscError(
      400,
      "That JSON has no client_email and private_key — it does not look like a service account key.",
    );
  return sa;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * An access token, by the JWT-bearer grant.
 *
 * A self-signed RS256 assertion posted to Google's token endpoint — the whole
 * of what `google-auth` does for a service account, written out rather than
 * depended on, because this server has two runtime dependencies and both of
 * them are Hono.
 *
 * WRITTEN AGAIN HERE RATHER THAN SHARED WITH providers/play.ts, which does the
 * same dance. The scope is the reason: play.ts's own comment argues at length
 * that its token must carry `devstorage.read_only` AND NOTHING ELSE, and a
 * shared helper taking a scope argument is a helper whose most important
 * property is one edit away from being changed by somebody working on Search
 * Console. Forty lines of duplication buys each integration a scope that is a
 * constant in the file that depends on it.
 */
export async function accessToken(sa: ServiceAccount): Promise<string> {
  const uri = sa.token_uri ?? TOKEN_URI;
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: sa.private_key_id }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: uri, iat, exp: iat + 3600 }),
  );

  let key;
  try {
    key = createPrivateKey(sa.private_key);
  } catch {
    throw new GscError(400, "The private_key in that JSON is not a readable PEM key.");
  }
  const assertion = `${header}.${claims}.${b64url(
    sign("sha256", Buffer.from(`${header}.${claims}`), key),
  )}`;

  let res: Response;
  try {
    res = await fetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GscError(
      0,
      err instanceof Error && err.name === "TimeoutError"
        ? "Google's token endpoint did not answer within 45 seconds."
        : "Could not reach Google's token endpoint.",
    );
  }

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token)
    throw new GscError(
      res.status,
      // Google's own sentence, which is usually exact ("Invalid JWT Signature")
      // and always better than a paraphrase of it.
      `Google refused the service account: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`,
    );
  return body.access_token;
}

/* -------------------------------------------------------------------- http */

async function call(
  token: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new GscError(
      0,
      err instanceof Error && err.name === "TimeoutError"
        ? "Search Console did not answer within 45 seconds."
        : "Could not reach Search Console.",
    );
  }

  if (res.status === 401 || res.status === 403) {
    const doc = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; status?: string };
    };
    const message = doc.error?.message ?? `HTTP ${res.status}`;
    /*
      THE TWO 403s THAT MEAN OPPOSITE THINGS. `SERVICE_DISABLED` is the Search
      Console API simply not switched on for the Cloud project the key belongs
      to — the grant is fine and one click fixes it. Everything else at 403 is
      "this service account is not a user on that property", which is fixed in
      Search Console rather than in Cloud. Naming them apart is the difference
      between a fix and an afternoon.
    */
    throw new GscError(
      res.status,
      doc.error?.status === "SERVICE_DISABLED"
        ? `The Search Console API is not enabled for this Cloud project. ${message}`
        : message,
    );
  }
  if (!res.ok) {
    const doc = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new GscError(res.status, doc.error?.message ?? `Search Console answered HTTP ${res.status}.`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/* ------------------------------------------------------------------- dates */

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** N days back from today, as a calendar day. */
export function dayBack(n: number): string {
  return iso(new Date(Date.now() - n * 86_400_000));
}

/** The window every call in one run shares: it ends LAG_DAYS back, and both
 *  ends are inclusive, which is why the start is `days - 1` further back. */
export function window(days: number): { start: string; end: string } {
  return { start: dayBack(LAG_DAYS + days - 1), end: dayBack(LAG_DAYS) };
}

/* ------------------------------------------------------------------- reads */

export type SiteEntry = { property: string; permission: string | null };

/** Every property the service account can see. One call for the whole run. */
export async function listSites(token: string): Promise<SiteEntry[]> {
  const doc = (await call(token, "sites")) as {
    siteEntry?: { siteUrl?: string; permissionLevel?: string }[];
  };
  return (doc.siteEntry ?? [])
    .filter((s) => !!s.siteUrl)
    .map((s) => ({ property: s.siteUrl!, permission: s.permissionLevel ?? null }));
}

export type ApiRow = {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
};

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const real = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* EXPORTED so a caller that needs ONE page's row rather than a property's can
   send its own filter document without re-implementing the auth, the timeout
   and the `dataState: "final"` rule below. integrations/seoops/gsc.ts is that
   caller; nothing about this function changed to let it in. */
export async function searchAnalytics(
  token: string,
  property: string,
  body: Record<string, unknown>,
): Promise<ApiRow[]> {
  const doc = (await call(
    token,
    `sites/${encodeURIComponent(property)}/searchAnalytics/query`,
    /* `dataState: "final"` on every single query. Google's default is "all",
       which folds the unfinished last days in and is exactly the shape of
       wrongness this integration is arranged to avoid. */
    { ...body, dataState: "final" },
  )) as { rows?: ApiRow[] };
  return doc.rows ?? [];
}

export type Totals = {
  clicks: number;
  impressions: number;
  /** Null with no impressions. Google answers 0.0 there, and an average
   *  position of zero is not a rank — it is the absence of one. */
  position: number | null;
};

export type DayRow = { day: string; clicks: number; impressions: number; position: number | null };
export type RankedRow = {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
};

export type SitemapReport = {
  /** 'reported' — Google listed some. 'none' — Google listed none, which is a
   *  real and common state. 'failed' — the call did not answer, which is not
   *  the same thing at all and must never render as "no sitemaps". */
  state: "reported" | "none" | "failed";
  count: number | null;
  submitted: number | null;
  errors: number | null;
  warnings: number | null;
  pending: number | null;
  lastDownloaded: string | null;
  error: string | null;
};

export type PropertyResult = {
  property: string;
  permission: string | null;
  window: { start: string; end: string; days: number };
  /** Google's own dimensionless answer for the ranked window. */
  totals: Totals;
  days: DayRow[];
  queries: RankedRow[];
  pages: RankedRow[];
  sitemaps: SitemapReport;
  error: string | null;
};

/**
 * What the property has SUBMITTED, which is not what the crawler found.
 *
 * `submitted` and `indexed` are sums over `contents[]`, where Search Console
 * splits one sitemap by resource type. `indexed` has been reported as 0 by
 * this API for years and is not read here at all: carrying a field whose only
 * value is a zero that means nothing would put a "0 indexed" on a card.
 *
 * The counts arrive as JSON STRINGS — they are int64 on Google's side — hence
 * a Number() on every one of them.
 */
export async function sitemaps(token: string, property: string): Promise<SitemapReport> {
  const blank = {
    count: null,
    submitted: null,
    errors: null,
    warnings: null,
    pending: null,
    lastDownloaded: null,
  };
  try {
    const doc = (await call(token, `sites/${encodeURIComponent(property)}/sitemaps`)) as {
      sitemap?: {
        path?: string;
        errors?: string | number;
        warnings?: string | number;
        isPending?: boolean;
        lastDownloaded?: string;
        contents?: { submitted?: string | number }[];
      }[];
    };
    const list = doc.sitemap ?? [];
    if (!list.length) return { state: "none", ...blank, error: null };

    const n = (v: unknown) => Number(v ?? 0) || 0;
    return {
      state: "reported",
      count: list.length,
      submitted: list.reduce(
        (a, s) => a + (s.contents ?? []).reduce((b, c) => b + n(c.submitted), 0),
        0,
      ),
      errors: list.reduce((a, s) => a + n(s.errors), 0),
      warnings: list.reduce((a, s) => a + n(s.warnings), 0),
      pending: list.filter((s) => s.isPending === true).length,
      lastDownloaded:
        list
          .map((s) => s.lastDownloaded)
          .filter((d): d is string => !!d)
          .sort()
          .at(-1) ?? null,
      error: null,
    };
  } catch (err) {
    /*
      A property that refuses the sitemaps endpoint keeps every other field it
      earned. The permission is separate from the performance one and some
      properties do answer 403 here — degrading the whole property for it would
      lose nineteen properties' worth of traffic to one missing grant.
    */
    return {
      state: "failed",
      ...blank,
      error: err instanceof Error ? err.message.slice(0, 200) : "Sitemaps could not be read.",
    };
  }
}

/**
 * One property, in five calls.
 *
 * The order matters only in that the daily rows come first: they are the ones
 * everything downstream is summed from, and a property whose ranked
 * breakdowns fail should still contribute its traffic to the board. Each of
 * the five is allowed to fail on its own, and what could not be read is null
 * rather than empty — "we could not ask" and "there is nothing there" are
 * different answers, and only one of them is a finding about the property.
 */
export async function collectProperty(
  token: string,
  site: SiteEntry,
): Promise<PropertyResult> {
  const w = window(WINDOW_DAYS);
  const hist = window(HISTORY_DAYS);
  const empty: PropertyResult = {
    property: site.property,
    permission: site.permission,
    window: { ...w, days: WINDOW_DAYS },
    totals: { clicks: 0, impressions: 0, position: null },
    days: [],
    queries: [],
    pages: [],
    sitemaps: { state: "failed", count: null, submitted: null, errors: null, warnings: null, pending: null, lastDownloaded: null, error: null },
    error: null,
  };

  let totals: Totals;
  let days: DayRow[];
  try {
    const dayRows = await searchAnalytics(token, site.property, {
      startDate: hist.start,
      endDate: hist.end,
      dimensions: ["date"],
      rowLimit: DATE_ROW_LIMIT,
    });
    days = dayRows
      .filter((r) => (r.keys ?? []).length > 0)
      .map((r) => ({
        day: r.keys![0]!,
        clicks: int(r.clicks),
        impressions: int(r.impressions),
        // Null when nobody saw anything that day, for the reason on Totals.
        position: int(r.impressions) > 0 ? real(r.position) : null,
      }));

    const totalRows = await searchAnalytics(token, site.property, {
      startDate: w.start,
      endDate: w.end,
      rowLimit: 1,
    });
    const t = totalRows[0];
    totals = {
      clicks: int(t?.clicks),
      impressions: int(t?.impressions),
      position: int(t?.impressions) > 0 ? real(t?.position) : null,
    };
  } catch (err) {
    // Without the daily rows there is no property here worth writing, so this
    // one failure IS the property's failure — and it costs the other eighteen
    // nothing, which is the whole shape of per-account failure one level down.
    return {
      ...empty,
      error: err instanceof Error ? err.message.slice(0, 200) : "Search Console did not answer.",
    };
  }

  /*
    A PROPERTY NOBODY SAW HAS NOTHING TO BREAK DOWN, and asking anyway is two
    calls per property per run spent to be told so. Nineteen properties, most
    of them quiet, is where a collector's cost actually lives. The ranked lists
    are EMPTY rather than null in that case, because that is knowledge: Google
    answered, and there was nothing shown to rank.
  */
  const ranked = { queries: [] as RankedRow[], pages: [] as RankedRow[] };
  if (totals.impressions > 0) {
    const shape = (rows: ApiRow[]): RankedRow[] =>
      rows
        .filter((r) => (r.keys ?? []).length > 0)
        .map((r) => ({
          key: r.keys![0]!,
          clicks: int(r.clicks),
          impressions: int(r.impressions),
          // CTR as a percentage, because every other rate on this dashboard is
          // one. Google sends a fraction.
          ctr: real(r.ctr) === null ? null : Number((real(r.ctr)! * 100).toFixed(2)),
          position: real(r.position),
        }));
    try {
      ranked.queries = shape(
        await searchAnalytics(token, site.property, {
          startDate: w.start,
          endDate: w.end,
          dimensions: ["query"],
          rowLimit: QUERY_ROWS,
        }),
      );
    } catch {
      /* The ranking degrades alone: the property keeps its traffic. */
    }
    try {
      ranked.pages = shape(
        await searchAnalytics(token, site.property, {
          startDate: w.start,
          endDate: w.end,
          dimensions: ["page"],
          rowLimit: PAGE_ROWS,
        }),
      );
    } catch {
      /* likewise */
    }
  }

  return {
    property: site.property,
    permission: site.permission,
    window: { ...w, days: WINDOW_DAYS },
    totals,
    days,
    queries: ranked.queries,
    pages: ranked.pages,
    sitemaps: await sitemaps(token, site.property),
    error: null,
  };
}

/** A tiny worker pool. Four at a time, in order, with no dependency added to
 *  a server whose whole argument is that it has two. */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ verify */

/**
 * Is this key real, and can it see anything?
 *
 * TWO CALLS, because the credential and the access are two different things
 * that fail apart. A perfectly good service account that has not been added as
 * a user on any property mints a token happily and then reports an empty
 * dashboard — the most expensive shape of failure here, because it looks like
 * an answer. So the property list is fetched too, and a key that can see
 * nothing is refused with the sentence that says what to do about it.
 */
export async function verify(
  json: string,
): Promise<{ ok: true; email: string; properties: number } | { ok: false; error: string }> {
  try {
    const sa = readServiceAccount(json);
    const token = await accessToken(sa);
    const sites = await listSites(token);
    if (!sites.length)
      return {
        ok: false,
        error:
          `The key works, but ${sa.client_email} is not a user on any property. ` +
          `Add that address in Search Console → Settings → Users and permissions, on each property.`,
      };
    return { ok: true, email: sa.client_email, properties: sites.length };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof GscError
          ? err.message
          : err instanceof Error && err.name === "TimeoutError"
            ? "Search Console did not answer within 45 seconds."
            : "Could not reach Search Console.",
    };
  }
}

/* ----------------------------------------------------------------- collect */

export type AccountResult = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  email?: string;
  properties?: PropertyResult[];
};

export type CollectResult = {
  accounts: AccountResult[];
  accountsTried: number;
  warnings: string[];
};

/**
 * Every account, every property.
 *
 * Per-account failure is that account's own, the way it is everywhere else
 * here — and one level below that, per-PROPERTY failure is the property's own:
 * eighteen properties with traffic and one that 403s is a better answer than
 * no answer, which is exactly the trade github.ts makes for a repo without
 * push access.
 */
export async function collect(reader = "collect_gsc"): Promise<CollectResult> {
  const { ready, broken } = accounts.credentialed("gsc", ["json"], reader);
  const out: AccountResult[] = [];
  const warnings: string[] = [];

  for (const { account } of broken) {
    out.push({ id: account.id, label: account.label, ok: false, error: "No service account JSON stored." });
    warnings.push(`${account.label}: no key stored`);
  }

  for (const { account, values } of ready) {
    try {
      const sa = readServiceAccount(values.json ?? "");
      const token = await accessToken(sa);
      const sites = await listSites(token);
      const properties = await pooled(sites, CONCURRENCY, (s) => collectProperty(token, s));
      const failed = properties.filter((p) => p.error);
      if (failed.length)
        warnings.push(
          `${account.label}: ${failed.length} of ${properties.length} properties did not answer`,
        );
      out.push({
        id: account.id,
        label: account.label,
        ok: true,
        email: sa.client_email,
        properties,
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : "Error").slice(0, 220);
      out.push({ id: account.id, label: account.label, ok: false, error: message });
      warnings.push(`${account.label}: ${message}`);
    }
  }

  return { accounts: out, accountsTried: ready.length + broken.length, warnings };
}

export type { Account };
