/**
 * Ad earnings per site — and, until somebody grants consent in a browser, an
 * honest account of why there are none.
 *
 * NOT AUTHORISED IS THE FIRST-CLASS ANSWER HERE. This route always responds,
 * connected or not, and the shape it responds with says which of four states
 * the integration is in:
 *
 *   not-connected  no OAuth grant has ever been stored. `connect` carries the
 *                  steps that would change that.
 *   refused        a grant exists and Google will not honour it — a revoked
 *                  consent, or a Testing-mode token that died at seven days.
 *                  Google's own sentence is in `detail`.
 *   service-disabled  the grant is fine and the AdSense Management API has
 *                  not been switched on for the Cloud project. `enableUrl` is
 *                  the link that switches it on, lifted out of Google's error.
 *   authorised     it works, and the figures below are real.
 *
 * That is copied deliberately from `collect_adsense.py`, which writes
 * `{"error": "not-authorised", "hint": …}` and exits ZERO rather than letting
 * a daily timer go red for a consent nobody has given. A card that can show
 * the fix beats one that paraphrases the failure.
 *
 * EVERY FIGURE IS ESTIMATED AND SAYS SO. AdSense's ESTIMATED_EARNINGS is
 * revised for days afterwards; recent days move. Nothing here presents one as
 * settled money, and nothing anywhere adds an AdSense figure to a Stripe one —
 * one is an ad network's estimate and the other is a bank settlement.
 */
import { Hono } from "hono";
import { adSenseDays, adSenseMonths, db, getPlugin } from "../db.ts";
import { CONSOLE_ENABLE, SCOPE, WINDOW_DAYS } from "../providers/adsense.ts";
import * as accounts from "../accounts.ts";
/* Four places, not two. This route published AdSense dollars at two while the
   finance area added the same rows at four, so a month never tied out between
   the two documents. Rendering to cents is the page's job. */
import { currencyCode, money } from "../shared/money.ts";

export const adsenseRoutes = new Hono();

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * RPM, DIVIDED OUT ON THE READ AND NEVER STORED.
 *
 * Revenue per thousand impressions does not add up: thirty daily RPMs averaged
 * give a figure no report of Google's would agree with, because the days are
 * not equally weighted. The two numbers it is made of DO add, so it is a
 * division over whatever set of rows the caller asked about — and null, not
 * zero, where nothing was served: a site with no impressions has no RPM, which
 * is a different fact from an RPM of nothing.
 */
const rpm = (usd: number, impressions: number): number | null =>
  impressions > 0 ? Number(((usd / impressions) * 1000).toFixed(2)) : null;

/**
 * How to get the token, in the order it has to happen.
 *
 * This lives on the wire rather than only in the catalog because it is the
 * answer to the question the route is most often going to be asked: there is
 * no data, why not, and what do I do. A card that can print these four lines
 * is worth more than one that says "not connected".
 */
const CONNECT_STEPS = [
  "In Google Cloud, on the project you will use: APIs & Services → Library → enable the AdSense Management API.",
  "APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app. Keep the client ID and client secret.",
  `Run an OAuth consent for scope ${SCOPE} with access_type=offline and prompt=consent, signed in as the AdSense account owner, and keep the refresh_token it returns. workdash's adsense_auth.py does exactly this in a terminal and prints the URL to open.`,
  "Publish the Cloud app. While it is in Testing, Google expires every refresh token after seven days, so an integration that works all week stops on the eighth day.",
  "Paste the client ID, client secret and refresh token into this plugin. Nothing else is needed — the collector refreshes its own access token from then on.",
] as const;

function everCollected(pluginId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM runs WHERE plugin_id = ? AND ok = 1 LIMIT 1").get(pluginId),
  );
}

adsenseRoutes.get("/", (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? WINDOW_DAYS) || WINDOW_DAYS, 1), 400);
  const from = utcDay(Date.now() - (days - 1) * 86_400_000);
  const rows = adSenseDays(from);
  const monthRows = adSenseMonths();
  const list = accounts.list("adsense");
  const connected = getPlugin("adsense")?.connected === 1 && list.length > 0;

  /*
    THE STATE, DECIDED FROM WHAT IS ACTUALLY THERE rather than from a flag
    somebody set. An account exists or it does not; it has answered or it
    carries the error that says why not. `lastError` is written by the
    collector from Google's own words, which is why it is worth surfacing here
    verbatim rather than being replaced with a category.
  */
  const failing = list.filter((a) => !a.connected || a.lastError);
  const working = list.filter((a) => a.connected && !a.lastError);
  const state = !connected
    ? ("not-connected" as const)
    : working.length
      ? ("authorised" as const)
      : ("refused" as const);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const currencies = [...new Set(rows.map((r) => currencyCode(r.currency)))];

  const bySite = new Map<
    string,
    { usd: number; views: number; impressions: number; clicks: number; last7: number }
  >();
  const cut7 = utcDay(Date.now() - 6 * 86_400_000);
  const byDay = new Map<string, { usd: number; impressions: number; clicks: number }>();
  for (const r of rows) {
    const s = bySite.get(r.site) ?? {
      usd: 0, views: 0, impressions: 0, clicks: 0, last7: 0,
    };
    s.usd += r.usd;
    s.views += r.page_views;
    s.impressions += r.impressions;
    s.clicks += r.clicks;
    if (r.day >= cut7) s.last7 += r.usd;
    bySite.set(r.site, s);

    const d = byDay.get(r.day) ?? { usd: 0, impressions: 0, clicks: 0 };
    d.usd += r.usd;
    d.impressions += r.impressions;
    d.clicks += r.clicks;
    byDay.set(r.day, d);
  }

  const byMonth = new Map<string, { usd: number; impressions: number; clicks: number }>();
  for (const r of monthRows) {
    const m = byMonth.get(r.month) ?? { usd: 0, impressions: 0, clicks: 0 };
    m.usd += r.usd;
    m.impressions += r.impressions;
    m.clicks += r.clicks;
    byMonth.set(r.month, m);
  }
  /*
    THE NEWEST COMPLETE CALENDAR MONTH, decided against today's month when it
    is read. A month-to-date printed as a monthly figure silently halves it,
    and a stored `complete` flag would be true the day it was written and wrong
    on the first of the next month. Only an account whose entire history is the
    running month falls back to it, and then it says so.
  */
  const months = [...byMonth.entries()]
    .map(([month, v]) => ({
      month,
      usd: money(v.usd),
      rpm: rpm(v.usd, v.impressions),
      complete: month < thisMonth,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const complete = months.filter((m) => m.complete);
  const latestMonth = (complete.length ? complete : months).at(-1) ?? null;

  const total = rows.reduce((n, r) => n + r.usd, 0);
  const impressions = rows.reduce((n, r) => n + r.impressions, 0);

  return c.json({
    window: { days },
    connected,
    /** authorised | refused | not-connected. The one field a card should
     *  branch on before drawing anything. */
    state,
    accounts: list.map((a) => ({
      id: a.id,
      label: a.label,
      connected: a.connected,
      lastOkAt: a.lastOkAt,
      /** Google's own sentence, with the console link where there was one.
       *  Written by the collector; not rephrased here. */
      lastError: a.lastError,
    })),
    /*
      `error` and `hint` exist ONLY in the states that are not authorised, and
      they are the same two field names workdash's document uses — so a reader
      who knows one knows the other.
    */
    ...(state === "authorised"
      ? {}
      : {
          error: "not-authorised" as const,
          hint:
            state === "not-connected"
              ? "AdSense has never been connected here. It needs an OAuth refresh token, which only a human signed in as the AdSense account owner can mint."
              : (failing[0]?.lastError ??
                "The stored grant was refused. Re-connect with a token minted by the AdSense account owner."),
          enableUrl: CONSOLE_ENABLE,
          connect: CONNECT_STEPS,
        }),
    /*
      null is "asked and not told" — no rows and no successful collection. A
      collection that succeeded and found nothing is a real, empty month and
      that is a zero. Reported as `earnings` rather than `usd` at the top
      level, with the currency beside it, because the account's reporting
      currency is Google's choice and not an assumption.
    */
    earnings: rows.length || everCollected("adsense") ? money(total) : null,
    currency: currencies.length === 1 ? currencies[0] : null,
    /** More than one reporting currency across accounts means nothing above
     *  is a legitimate total, and this says so rather than hiding it. */
    currencies,
    estimated:
      "AdSense reports ESTIMATED earnings and revises recent days for some time afterwards, so the last few days move. Nothing here is settled money and none of it is added to Stripe's.",
    rpm: rpm(total, impressions),
    impressions,
    clicks: rows.reduce((n, r) => n + r.clicks, 0),
    pageViews: rows.reduce((n, r) => n + r.page_views, 0),
    days: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({
        day,
        usd: money(v.usd),
        impressions: v.impressions,
        clicks: v.clicks,
        rpm: rpm(v.usd, v.impressions),
      })),
    sites: [...bySite.entries()]
      .map(([site, v]) => ({
        site,
        usd: money(v.usd),
        last7Usd: money(v.last7),
        pageViews: v.views,
        impressions: v.impressions,
        clicks: v.clicks,
        /** Divided out of this site's own rows, never averaged from days. */
        rpm: rpm(v.usd, v.impressions),
      }))
      .sort((a, b) => b.usd - a.usd),
    months,
    latestMonth,
    /** What this API will not answer, so no card promises it. */
    cannot: [
      "settled earnings — AdSense reports estimates and revises them; the figure for a recent day is not final.",
      "a total with Stripe — one is an ad network's estimate and the other is a bank settlement, and adding them would describe neither.",
      "anything at all without a browser — the refresh token can only be minted by a human approving a consent screen as the AdSense account owner.",
    ],
    seenAt: rows.map((r) => r.seen_at).sort().at(-1) ?? null,
    generatedAt: new Date().toISOString(),
  });
});
