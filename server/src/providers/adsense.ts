/**
 * Google AdSense — earnings per site, per day.
 *
 * NOTHING HAS EVER AUTHORISED THIS, AND THAT IS THE FIRST THING TO KNOW.
 * There is no `adsense-token` in the vault on the Pi, no `adsense-token.json`
 * beside workdash's collectors, and no consent has ever been granted for this
 * dashboard. The plugin catalog said "Connected" because it was seeded from a
 * list of integrations workdash INTENDS to have, and that entry was a mock
 * value presented as a measurement — the one thing this codebase refuses. It
 * now says not connected, and every widget below it falls back to its sample
 * and wears no live dot.
 *
 * So this file is written from the published API and from workdash's
 * `collect_adsense.py`, which is the version that has actually run against a
 * live publisher account (pub-6120735587215325, example-app-13.example.test). It has NEVER
 * been run against a live grant from here. That is why every reader below is
 * tolerant: a missing header, an absent row and an unexpected shape produce
 * nulls and empty lists rather than confident zeros, and the route says
 * "not authorised" rather than "$0 this month".
 *
 * WHY IT CANNOT BE CONNECTED FROM HERE. AdSense is OAuth2 and minting a
 * refresh token requires a human approving a consent screen in a browser
 * signed in as the AdSense account owner. No process can do that on the
 * owner's behalf, and faking one would be inventing a credential. What IS
 * built is everything on the other side of that consent: paste the client id,
 * the client secret and the refresh token and the whole integration works on
 * the next collection. See the plugin page for exactly how to mint one.
 *
 * WHAT IT READS, and nothing else:
 *   POST https://oauth2.googleapis.com/token   (grant_type=refresh_token)
 *   GET  /v2/accounts
 *   GET  /v2/{account}/reports:generate
 *
 * THE ONE POST IS THE OAUTH HANDSHAKE and mutates nothing: a refresh grant
 * exchanges a long-lived token for an hour-long access token and is a POST
 * because that is how OAuth2 is specified, not because anything is being
 * changed. Every AdSense call itself is a GET, and the scope asked for is
 * `adsense.readonly` — a credential that cannot change an ad unit is a
 * credential that cannot be made to.
 *
 * NOT AUTHORISED IS A STATE, NOT A FAILURE. `collect_adsense.py` writes
 * `{"error": "not-authorised", "hint": …}` and EXITS 0 for exactly this
 * reason: a daily timer must never go red for a consent nobody has given. The
 * same instinct is carried across here — a refusal comes back as a `Refusal`
 * object rather than as a thrown error, so the collector can record it against
 * the account without turning it into a broken run, and the card can print
 * Google's own words with the console link beside them.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

export const ADSENSE_API = "https://adsense.googleapis.com/v2";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 60_000;

/** The one scope this asks for. Read-only, and the collector only ever issues
 *  GETs against reports — see the header. */
export const SCOPE = "https://www.googleapis.com/auth/adsense.readonly";

/** How many days of the daily report are fetched. AdSense's own
 *  `LAST_30_DAYS` range, which is what the published collector uses. */
export const WINDOW_DAYS = 30;

/** Calendar months fetched, including the running one — so there is always a
 *  complete month to quote beside a month-to-date that is not one. */
export const MONTHS_BACK = 3;

/** Where the Cloud console enables the API, for the SERVICE_DISABLED case. */
export const CONSOLE_ENABLE =
  "https://console.developers.google.com/apis/api/adsense.googleapis.com/overview";

/* ------------------------------------------------------------------ shapes */

/**
 * A refusal, pulled apart so a card can show the FIX rather than paraphrase
 * the failure.
 *
 * The three failures a fresh grant actually hits, in the order they happen:
 *
 *   1. The refresh token is dead. A Google Cloud app still in "Testing" issues
 *      refresh tokens that expire after SEVEN DAYS, so an integration that
 *      worked all week stops on the eighth day with `invalid_grant`. The fix
 *      is to publish the app, not to mint another token that will also die.
 *   2. The API is not enabled on the Cloud project. Google answers 403 with
 *      reason SERVICE_DISABLED, the message naming the project and an
 *      `activationUrl` in the error details. That link is the entire fix and
 *      is carried through verbatim.
 *   3. The Google account signed in has no AdSense account attached, which is
 *      a different mistake — the right consent screen approved by the wrong
 *      person.
 */
export type Refusal = {
  /** Google's own words, prefixed with the status. */
  detail: string;
  /** SERVICE_DISABLED, invalid_grant, … or null where Google named none. */
  reason: string | null;
  /** The console link that turns the API on, when this is that failure. */
  enableUrl: string | null;
  /** What to do, in one sentence. */
  hint: string;
};

export type AdSenseDay = {
  accountId: number;
  accountLabel: string;
  day: string;
  site: string;
  currency: string;
  usd: number;
  pageViews: number;
  impressions: number;
  clicks: number;
};

export type AdSenseMonth = {
  accountId: number;
  accountLabel: string;
  /** "2026-08", as AdSense's MONTH dimension reports it. */
  month: string;
  site: string;
  currency: string;
  usd: number;
  pageViews: number;
  impressions: number;
  clicks: number;
};

export type AccountOutcome = {
  id: number;
  label: string;
  ok: boolean;
  /**
   * Whether Google would talk to us at all. FALSE with a refusal is the
   * honest, expected state of an integration nobody has consented to; false
   * with an `error` is a network problem. They are different rows in a run log
   * and different sentences on a card.
   */
  authorised: boolean;
  refusal?: Refusal;
  error?: string;
  /** "accounts/pub-…", once the accounts call has answered. */
  publisher: string | null;
  /** The reporting currency the report header named. Never assumed to be USD:
   *  the field names say `usd` because that is what the revenue contract calls
   *  a per-month figure, and a non-USD account would make the label wrong and
   *  the number right — which is what this field exists to say. */
  currency: string | null;
  rows: number;
};

export type CollectResult = {
  days: AdSenseDay[];
  months: AdSenseMonth[];
  accounts: AccountOutcome[];
  accountsTried: number;
  warnings: string[];
  /** Where the daily report's own window began and ended, as AdSense reported
   *  it — not as this code computed it. */
  window: { start: string | null; end: string | null };
};

/* -------------------------------------------------------------------- http */

export class AdSenseError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.name = "AdSenseError";
    this.status = status;
    this.body = body;
  }
}

/**
 * A fresh access token, or a refusal.
 *
 * The refresh grant is the one POST in this file. It is refused rather than
 * thrown when Google says no, because "the grant has been revoked" and "the
 * network is down" are not the same event: the first is a consent problem the
 * owner has to fix in a browser, and the second is a bad minute.
 */
async function accessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ ok: true; token: string } | { ok: false; refusal: Refusal }> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason: string | null = null;
    let description = text.slice(0, 300);
    try {
      const doc = JSON.parse(text) as { error?: string; error_description?: string };
      reason = doc.error ?? null;
      description = doc.error_description ?? description;
    } catch {
      /* not JSON; the body is all there is */
    }
    return {
      ok: false,
      refusal: {
        detail: `HTTP ${res.status} ${description}`,
        reason,
        enableUrl: null,
        hint:
          reason === "invalid_grant"
            ? "Google has stopped accepting that refresh token. The usual cause is a Cloud " +
              "app still in Testing, whose refresh tokens expire after seven days — publish " +
              "the app, then mint a new token and paste it here."
            : "The OAuth client or the refresh token was refused. Check the client id and " +
              "secret belong to the same Cloud project the token was minted from.",
      },
    };
  }
  const doc = JSON.parse(text) as { access_token?: string };
  if (!doc.access_token)
    return {
      ok: false,
      refusal: {
        detail: "Google returned no access_token for that refresh grant.",
        reason: null,
        enableUrl: null,
        hint: "Mint the refresh token again with prompt=consent and access_type=offline.",
      },
    };
  return { ok: true, token: doc.access_token };
}

/** GET only, by construction — there is no other request shape in this file
 *  beyond the token refresh above. */
async function get<T>(
  path: string,
  token: string,
  params: [string, string][] = [],
): Promise<T> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${ADSENSE_API}/${path}${qs.toString() ? `?${qs}` : ""}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new AdSenseError(res.status, await res.text());
  return (await res.json()) as T;
}

/**
 * Google's own words for a 401 or 403, pulled apart so the dashboard can print
 * them WITH the link.
 *
 * The failure the first collection after a fresh consent is likeliest to hit
 * reads: "AdSense Management API has not been used in project N before or it
 * is disabled. Enable it by visiting https://console.developers.google.com/…
 * then retry." — with reason SERVICE_DISABLED and the activation URL in the
 * error's details. All three are lifted out; the raw body is the fallback when
 * the shape is not the documented one, because a truncated body a reader can
 * paste into a search box beats a category this code invented.
 */
export function refusalFrom(err: AdSenseError): Refusal {
  let message = err.body.slice(0, 600);
  let reason: string | null = null;
  let enableUrl: string | null = null;
  try {
    const doc = JSON.parse(err.body) as {
      error?: {
        message?: string;
        details?: { reason?: string; metadata?: { activationUrl?: string } }[];
      };
    };
    const e = doc.error ?? {};
    if (e.message) message = e.message.slice(0, 600);
    for (const d of e.details ?? []) {
      reason ??= d.reason ?? null;
      enableUrl ??= d.metadata?.activationUrl ?? null;
    }
  } catch {
    /* not the documented shape; the body stands */
  }
  if (!enableUrl) {
    const m = /https:\/\/console\.developers\.google\.com\/\S+/.exec(message);
    if (m) enableUrl = m[0].replace(/[.,)]+$/, "");
  }
  if (!reason && /has not been used in project|is disabled/.test(message))
    reason = "SERVICE_DISABLED";
  if (!enableUrl && reason === "SERVICE_DISABLED") {
    const m = /project (\S+?)\b/.exec(message);
    enableUrl = CONSOLE_ENABLE + (m ? `?project=${m[1]}` : "");
  }
  return {
    detail: `HTTP ${err.status} ${message}`,
    reason,
    enableUrl,
    hint:
      reason === "SERVICE_DISABLED"
        ? "Enable the AdSense Management API on the Cloud project — the link is in enableUrl — then collect again. The token itself is fine."
        : "The grant was refused. Re-connect AdSense with a token minted by the AdSense account owner.",
  };
}

/* ------------------------------------------------------------------ verify */

/**
 * Is this OAuth client + refresh token real, and does it reach an AdSense
 * account?
 *
 * Both halves, because neither proves anything alone: a valid client with a
 * revoked token and a live token under the wrong client fail the same way from
 * the outside, and only the exchange can tell them apart. Then one GET for the
 * publisher account, because a grant that refreshes and reaches no AdSense
 * account is the wrong Google login — which would otherwise connect happily
 * and report nothing forever.
 */
export async function verify(values: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ ok: true; publisher: string | null } | { ok: false; error: string }> {
  try {
    const token = await accessToken(
      values.clientId,
      values.clientSecret,
      values.refreshToken,
    );
    if (!token.ok) return { ok: false, error: `${token.refusal.hint} (${token.refusal.detail})` };

    const doc = await get<{ accounts?: { name?: string }[] }>("accounts", token.token);
    const publisher = doc.accounts?.[0]?.name ?? null;
    if (!publisher)
      return {
        ok: false,
        error:
          "That grant works, but no AdSense account is attached to the Google login it " +
          "belongs to. Mint the token while signed in as the AdSense account owner.",
      };
    return { ok: true, publisher };
  } catch (err) {
    if (err instanceof AdSenseError) {
      const r = refusalFrom(err);
      return { ok: false, error: `${r.hint} (${r.detail})` };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "Google did not answer within 60 seconds."
          : `Could not reach Google (${name}).`,
    };
  }
}

/* ----------------------------------------------------------------- reports */

type ReportCell = { value?: string };
type ReportDate = { year?: number; month?: number; day?: number };
type Report = {
  headers?: { name?: string; currencyCode?: string }[];
  rows?: { cells?: ReportCell[] }[];
  startDate?: ReportDate;
  endDate?: ReportDate;
};

const ymd = (d: ReportDate | undefined): string | null =>
  d?.year
    ? `${String(d.year).padStart(4, "0")}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}`
    : null;

const num = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Rows as objects keyed by the header names, which is the only join AdSense
 *  offers between a cell and what it means. */
function readReport(doc: Report) {
  const headers = (doc.headers ?? []).map((h) => h.name ?? "");
  const currency =
    (doc.headers ?? []).find((h) => h.currencyCode)?.currencyCode ?? null;
  const rows = (doc.rows ?? []).map((r) => {
    const out: Record<string, string> = {};
    (r.cells ?? []).forEach((cell, i) => {
      out[headers[i] ?? String(i)] = cell.value ?? "";
    });
    return out;
  });
  return { rows, currency, start: ymd(doc.startDate), end: ymd(doc.endDate) };
}

/**
 * The four metrics asked for, and the one deliberately NOT asked for.
 *
 * ESTIMATED_EARNINGS, PAGE_VIEWS, IMPRESSIONS and CLICKS are all ADDITIVE —
 * every one of them sums across days and across sites, so a window total and a
 * per-site total are the same arithmetic over the same rows.
 * IMPRESSIONS_RPM is not: it is earnings per thousand impressions, and adding
 * or averaging thirty daily RPMs gives a figure no report of Google's would
 * agree with. workdash's collector stores it per row; this does not, and the
 * route divides earnings by impressions when somebody asks for an RPM. Same
 * rule as every other derived figure here — computed on the read, so it cannot
 * be a stale number that no longer matches the two figures beside it.
 */
const METRICS: [string, string][] = [
  ["metrics", "ESTIMATED_EARNINGS"],
  ["metrics", "PAGE_VIEWS"],
  ["metrics", "IMPRESSIONS"],
  ["metrics", "CLICKS"],
];

/* ----------------------------------------------------------------- collect */

export function tokenAccounts(
  reader: string,
): { account: Account; values: Record<string, string> }[] {
  return accounts.credentialed(
    "adsense",
    ["client-id", "client-secret", "refresh-token"],
    reader,
  ).ready;
}

/**
 * Every connected AdSense grant, one after another.
 *
 * A grant that Google refuses costs that account its rows and NOTHING else —
 * no thrown error, no failed run, and no zero. The collector above turns that
 * into an account marked not authorised with Google's sentence on it, which is
 * the state this integration is designed to be honest about.
 */
export async function collect(reader = "collect_adsense"): Promise<CollectResult> {
  const pairs = tokenAccounts(reader);
  const out: CollectResult = {
    days: [],
    months: [],
    accounts: [],
    accountsTried: pairs.length,
    warnings: [],
    window: { start: null, end: null },
  };

  for (const { account, values } of pairs) {
    const label = account.label;
    const before = out.days.length + out.months.length;

    const refused = (refusal: Refusal, publisher: string | null = null) => {
      out.accounts.push({
        id: account.id,
        label,
        ok: false,
        authorised: false,
        refusal,
        publisher,
        currency: null,
        rows: 0,
      });
      out.warnings.push(`${label}: ${refusal.detail}`);
    };

    try {
      const token = await accessToken(
        values["client-id"]!,
        values["client-secret"]!,
        values["refresh-token"]!,
      );
      if (!token.ok) {
        refused(token.refusal);
        continue;
      }

      const list = await get<{ accounts?: { name?: string }[] }>("accounts", token.token);
      const publisher = list.accounts?.[0]?.name ?? null;
      if (!publisher) {
        refused({
          detail: "The accounts call returned no AdSense account.",
          reason: "NO_ACCOUNT",
          enableUrl: null,
          hint: "This Google login has no AdSense account. Mint the token as the AdSense account owner.",
        });
        continue;
      }

      const daily = readReport(
        await get<Report>(`${publisher}/reports:generate`, token.token, [
          ["dateRange", "LAST_30_DAYS"],
          ["dimensions", "DATE"],
          ["dimensions", "DOMAIN_NAME"],
          ...METRICS,
        ]),
      );

      /*
        THREE CALENDAR MONTHS, INCLUDING THE RUNNING ONE. The month-to-date is
        fetched because it is real and interesting, and marked incomplete when
        it is read — never stored as a flag, which would be true on the day it
        was written and wrong on the first of the next month. A part month
        printed as a monthly figure silently halves it, which is the trap
        workdash's own `latestPlayMonth` documents.
      */
      const now = new Date();
      const firstMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS_BACK - 1), 1),
      );
      const monthly = readReport(
        await get<Report>(`${publisher}/reports:generate`, token.token, [
          ["dateRange", "CUSTOM"],
          ["startDate.year", String(firstMonth.getUTCFullYear())],
          ["startDate.month", String(firstMonth.getUTCMonth() + 1)],
          ["startDate.day", "1"],
          ["endDate.year", String(now.getUTCFullYear())],
          ["endDate.month", String(now.getUTCMonth() + 1)],
          ["endDate.day", String(now.getUTCDate())],
          ["dimensions", "MONTH"],
          ["dimensions", "DOMAIN_NAME"],
          ...METRICS,
        ]),
      );

      const currency = daily.currency ?? monthly.currency ?? null;
      // An unattributed row keeps its own name rather than being folded into
      // whichever domain sorts first: "(unknown)" is a real bucket at AdSense
      // and hiding it would move money onto a site that did not earn it.
      const site = (r: Record<string, string>) =>
        (r.DOMAIN_NAME ?? "").trim().toLowerCase() || "(unknown)";

      for (const r of daily.rows) {
        if (!r.DATE) continue;
        out.days.push({
          accountId: account.id,
          accountLabel: label,
          day: r.DATE,
          site: site(r),
          currency: currency ?? "USD",
          usd: num(r.ESTIMATED_EARNINGS),
          pageViews: Math.round(num(r.PAGE_VIEWS)),
          impressions: Math.round(num(r.IMPRESSIONS)),
          clicks: Math.round(num(r.CLICKS)),
        });
      }
      for (const r of monthly.rows) {
        if (!r.MONTH) continue;
        out.months.push({
          accountId: account.id,
          accountLabel: label,
          month: r.MONTH,
          site: site(r),
          currency: currency ?? "USD",
          usd: num(r.ESTIMATED_EARNINGS),
          pageViews: Math.round(num(r.PAGE_VIEWS)),
          impressions: Math.round(num(r.IMPRESSIONS)),
          clicks: Math.round(num(r.CLICKS)),
        });
      }

      out.window = { start: daily.start, end: daily.end };
      out.accounts.push({
        id: account.id,
        label,
        ok: true,
        authorised: true,
        publisher,
        currency,
        rows: out.days.length + out.months.length - before,
      });
    } catch (err) {
      if (err instanceof AdSenseError && (err.status === 401 || err.status === 403)) {
        refused(refusalFrom(err));
        continue;
      }
      // A transport failure IS a failure — this is the one thing here that
      // should make a run go red, because it is the only one a retry fixes.
      const error =
        err instanceof AdSenseError
          ? `HTTP ${err.status} ${err.body.slice(0, 200)}`
          : err instanceof Error && err.name === "TimeoutError"
            ? "Google did not answer within 60 seconds."
            : `Could not reach Google (${err instanceof Error ? err.name : "Error"}).`;
      out.warnings.push(`${label}: ${error}`);
      out.accounts.push({
        id: account.id,
        label,
        ok: false,
        authorised: true,
        error,
        publisher: null,
        currency: null,
        rows: 0,
      });
    }
  }

  return out;
}

export type { Account };
