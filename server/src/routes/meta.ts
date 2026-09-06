/**
 * Meta: the Pages, the ad account, and the Instagram account that is not there.
 *
 * ONE ROUTE FOR BOTH HALVES, the way /api/mobile is one route for both app
 * stores: one token reaches the Pages and the ads, one credential file feeds
 * both collectors, and a page that had to fetch two documents and join them is
 * a page that eventually joins them wrongly.
 *
 * INSTAGRAM IS IN THIS DOCUMENT AND HAS NO ROUTE OF ITS OWN, because Instagram
 * is not an API this dashboard talks to — it is a FIELD on a Facebook Page
 * (`instagram_business_account`), reached with the same token, in the same
 * call. A second route would be a second fetch to re-read a field the first one
 * already had.
 *
 * AND ITS ANSWER, ON THIS ACCOUNT, IS THE MOST IMPORTANT THING HERE. The
 * credential works — the token is live, it is a system user token that never
 * expires, and it lists three Pages by name. Every one of those three Pages
 * reports NO linked Instagram Business account. That is a third state and the
 * `instagram` block below exists to keep it apart from the other two:
 *
 *     connected, 9,412 followers      a measurement
 *     not connected / token refused   a failure, with a sentence
 *     connected, nothing linked       <- this. Neither of the above.
 *
 * Reporting it as "0 followers" would put a real-looking zero on a board for an
 * account that does not exist; reporting it as an error would send somebody to
 * re-paste a credential that is perfectly good. It is reported as what it is,
 * with the one step that changes it: link an Instagram Business or Creator
 * account to a Page in Meta Business Suite.
 *
 * `meta_ad_days` IS AUTHORITATIVE FOR AN ACCOUNT'S DELIVERY, and it is worth
 * saying because there are two tables of the same insights at two grains. The
 * account-level daily read asks for one row per day and gets all of them; the
 * ad-level read is capped at a row limit and nothing follows the paging, so it
 * UNDER-COUNTS silently on a busy account. Nothing used to compare the two.
 * `totals.adLevel` below derives the same account-day totals from the ad-level
 * rows and publishes the shortfall, so an account whose ad-level figures are
 * short says so instead of quietly disagreeing with this page. The ad-level
 * rows remain the grain for anything needing a campaign or an advertisement,
 * because this table has no such column.
 *
 * EVERY TOTAL IS COMPUTED ON THE READ, except the two that provably cannot be.
 * Spend, impressions, clicks and leads are summed from `meta_ad_days` when
 * somebody asks. REACH AND FREQUENCY ARE NOT AND CANNOT BE: Meta de-duplicates
 * reach over the row's own window, so thirty daily reaches do not add up to a
 * thirty-day reach and no arithmetic here can recover one. Meta's own window
 * figure is stored with the dates it covers and served with them attached,
 * which is what stops a card captioning it as a window it is not.
 *
 * NOTHING IS ADDED ACROSS CURRENCIES. The one ad account here bills in EUR and
 * the rest of this dashboard's money is EUR and USD; converting would need a
 * real, dated exchange rate this box does not fetch. `currency.combined` is
 * null with the reason attached — the same contract /api/costs keeps between
 * Hetzner's euro and OpenAI's dollars, and /api/mobile keeps across ten.
 */
import { Hono } from "hono";
import {
  metaAdAccounts,
  metaAdDays,
  metaCampaigns,
  metaPages,
  metaState,
  type MetaAdDayRow,
} from "../db.ts";
import {
  ATTRIBUTION_LABEL,
  CANNOT,
  GRAPH_VERSION,
  WINDOW_DAYS,
} from "../providers/meta.ts";
import { SOCIAL_EVERY_HOURS } from "../collector.ts";
import { adDayAccountTotals } from "../integrations/webanalytics/store.ts";

export const metaRoutes = new Hono();

/** A stored 0/1 as the boolean it was written as. */
const bool = (v: number | null): boolean => v === 1;

/** Sum a column, or null when not one row carried it. Null is "nothing
 *  reported it", which is not the same as a total of nothing. */
function total(rows: MetaAdDayRow[], pick: (r: MetaAdDayRow) => number | null) {
  const seen = rows.map(pick).filter((v): v is number => v !== null);
  return seen.length ? seen.reduce((a, b) => a + b, 0) : null;
}

metaRoutes.get("/", (c) => {
  const days = Math.min(
    400,
    Math.max(1, Number(c.req.query("days") ?? WINDOW_DAYS) || WINDOW_DAYS),
  );

  const pageRows = metaPages();
  const adRows = metaAdAccounts();
  const campaignRows = metaCampaigns();
  const dayRows = metaAdDays(days);
  const stateRows = metaState();

  const pages = pageRows.map((p) => ({
    id: p.page_id,
    accountId: p.account_id,
    accountLabel: p.account_label,
    name: p.name,
    /** Null is "Meta did not report it", never nought. A Page with one
     *  follower and a Page whose count could not be read are different facts. */
    followers: p.followers,
    fans: p.fans,
    /** Which of Meta's two fields the number above came from. `fan_count` is
     *  page LIKES and `followers_count` is people following; they agree on this
     *  portfolio and there is no promise they will elsewhere. */
    followersSource: p.followers_source,
    link: p.link,
    category: p.category,
    about: p.about,
    /** A SIGNED, EXPIRING scontent URL — Meta stamps an `oe=` deadline a few
     *  days out. Only as good as the last collection; nothing may cache it and
     *  whatever renders it survives a 403 without drawing a broken frame. */
    picture: p.picture,
    instagram: {
      /* The question was asked of this Page. `checked: true, id: null` is Meta
         answering "nothing is linked"; without this flag that is
         indistinguishable from nobody having looked. */
      checked: bool(p.ig_checked),
      id: p.ig_id,
      username: p.ig_username,
      followers: p.ig_followers,
    },
  }));

  /* ------------------------------------------------------------ instagram */

  const linked = pages.filter((p) => p.instagram.id);
  const checked = pages.filter((p) => p.instagram.checked);
  /**
   * THE THREE-STATE ANSWER THE INSTAGRAM CARDS ARE BUILT ON.
   *
   *   "no-plugin"   nothing is connected; there is no Meta token here at all.
   *   "no-pages"    the token is connected and listed no Pages, so the question
   *                 could not be asked. Not the same as asking and hearing no.
   *   "none-linked" every Page was asked and every Page has no Instagram
   *                 Business account. THE CREDENTIAL WORKS AND THERE IS
   *                 NOTHING TO READ, which is a real state and not an error.
   *   "linked"      at least one account, with followers to report.
   */
  const igState = !stateRows.length
    ? "no-plugin"
    : !checked.length
      ? "no-pages"
      : linked.length
        ? "linked"
        : "none-linked";

  const instagram = {
    state: igState,
    pagesChecked: checked.length,
    accounts: linked.map((p) => ({
      pageId: p.id,
      pageName: p.name,
      id: p.instagram.id,
      username: p.instagram.username,
      followers: p.instagram.followers,
    })),
    /**
     * Followers across the linked accounts, or null when there are none.
     *
     * NULL RATHER THAN 0 IS THE WHOLE POINT OF THIS FIELD. Zero would be a
     * measurement of an audience; this is the absence of an account to measure.
     * A Page with no Instagram account and a Page with no followers must never
     * look the same, and a summed zero here is exactly how they would.
     */
    followers: linked.length
      ? linked.reduce((n, p) => n + (p.instagram.followers ?? 0), 0)
      : null,
    /** What to do about it, on the wire rather than in a card's hard-coded
     *  string — a reader who goes looking for a follower count should find the
     *  fix rather than a guess about why the collector is broken. */
    fix:
      igState === "none-linked"
        ? "Link an Instagram Business or Creator account to one of these Pages: " +
          "Meta Business Suite → Settings → Accounts → Instagram accounts → " +
          "Connect. Nothing needs re-pasting here; the same token reads it the " +
          "next collection."
        : igState === "no-pages"
          ? "This token lists no Pages, so no Page could be asked about " +
            "Instagram. Assign the Pages to the system user in Business settings."
          : null,
  };

  /* ----------------------------------------------------------- ad accounts */

  /* The ad-level rows summed to this page's grain, for the shortfall check.
     `dayRows` is bounded by `days`, so the comparison is made over the same
     span: the earliest day this page is showing. */
  const earliest = dayRows.map((d) => d.day).sort()[0] ?? "9999-12-31";
  const derived = new Map(adDayAccountTotals(earliest).map((r) => [r.ad_account_id, r]));

  const adAccounts = adRows.map((a) => {
    const mine = dayRows.filter((d) => d.ad_account_id === a.ad_account_id);
    const campaigns = campaignRows
      .filter((c) => c.ad_account_id === a.ad_account_id)
      .map((c) => ({
        id: c.campaign_id,
        name: c.name,
        /* effective_status — an ad left ACTIVE inside a paused campaign is not
           running, and only this field folds the parents in. */
        status: c.status,
        objective: c.objective,
        window: c.window_from
          ? {
              from: c.window_from,
              to: c.window_to,
              spend: c.spend,
              impressions: c.impressions,
              clicks: c.clicks,
              ctr: c.ctr,
              reach: c.reach,
              frequency: c.frequency,
              leads: c.leads,
              costPerLead: c.cost_per_lead,
            }
          : null,
      }));

    return {
      id: a.ad_account_id,
      accountId: a.account_id,
      accountLabel: a.account_label,
      name: a.name,
      currency: a.currency,
      status: a.status,
      active: bool(a.active),
      timezone: a.timezone,
      createdAt: a.created_at,
      lifetimeSpend: a.lifetime_spend,
      /**
       * META'S OWN ANSWER FOR ITS OWN WINDOW, dated.
       *
       * Stored rather than recomputed, which is the one place this codebase
       * departs from "sum it on the read" — and the data forces it. Spend,
       * impressions and clicks could be summed from `daily` below and would
       * agree to the cent. Reach and frequency could not: Meta de-duplicates
       * people over the row's own window, so thirty daily reaches are not a
       * thirty-day reach and nothing here can derive one. The dates travel with
       * the figures so a card can say the window it means instead of assuming
       * one that ends today.
       */
      window: a.window_from
        ? {
            from: a.window_from,
            to: a.window_to,
            spend: a.spend,
            impressions: a.impressions,
            clicks: a.clicks,
            cpc: a.cpc,
            ctr: a.ctr,
            reach: a.reach,
            frequency: a.frequency,
            leads: a.leads,
            costPerLead: a.cost_per_lead,
            /**
             * ALWAYS NULL ON THIS ACCOUNT, and the reason is not a gap in the
             * integration. ROAS is revenue over spend; `purchase_roas` is asked
             * for on every call and this account has never returned it, because
             * it buys lead-form submissions and there is no purchase event for
             * Meta to attach a value to. Null is "asked and not told". It is
             * not 0×, and it is not a verdict on the campaigns.
             */
            roas: a.roas,
          }
        : null,
      note: a.note,
      campaigns,
      /**
       * The days Meta actually reported, and only those.
       *
       * A DAY WITH NO ROW IS A DAY THE ACCOUNT DID NOT DELIVER, not a day
       * measured at zero, and it is left out rather than drawn flat. `days`
       * beside `windowDays` is what lets a card say "12 delivering days of 30"
       * instead of captioning a gap as a collapse.
       */
      daily: mine.map((d) => ({
        day: d.day,
        spend: d.spend,
        impressions: d.impressions,
        clicks: d.clicks,
        leads: d.leads,
      })),
      /** Summed from the rows above, on the read. These three DO add across
       *  days; the two above them do not. */
      totals: {
        days: mine.length,
        spend: total(mine, (d) => d.spend),
        impressions: total(mine, (d) => d.impressions),
        clicks: total(mine, (d) => d.clicks),
        leads: total(mine, (d) => d.leads),
        /**
         * THE SAME FIGURES DERIVED FROM THE AD-LEVEL ROWS, and the gap.
         *
         * Published so the ad-level cap is visible rather than silent. A
         * shortfall means advertisements the ad-level read did not see, NOT a
         * correction to the figures above it: this page's totals are the
         * account-level read's and stay so. Null where no ad-level row has
         * been collected for the account at all.
         */
        adLevel: (() => {
          const d = derived.get(a.ad_account_id);
          if (!d) return null;
          const own = total(mine, (r) => r.impressions);
          return {
            days: d.days,
            spend: d.spend,
            impressions: d.impressions,
            clicks: d.clicks,
            impressionShortfall:
              own === null || d.impressions === null ? null : own - d.impressions,
            note:
              "Derived by summing the per-advertisement daily rows. The ad-level read is capped at a row limit and does not page, so this figure is a FLOOR; where it falls short of the totals above, the difference is advertisements it did not see.",
          };
        })(),
      },
    };
  });

  /* -------------------------------------------------------------- currency */

  const currencies = [
    ...new Set(adAccounts.map((a) => a.currency).filter((c): c is string => !!c)),
  ];
  /** Spend per currency, which is the only total that can be right. Two ad
   *  accounts in one currency add; two in two do not, and there is no field
   *  below where they could. */
  const spendByCurrency = currencies.map((currency) => ({
    currency,
    adAccounts: adAccounts.filter((a) => a.currency === currency).length,
    windowSpend: adAccounts
      .filter((a) => a.currency === currency)
      .reduce((n, a) => n + (a.window?.spend ?? 0), 0),
    lifetimeSpend: adAccounts
      .filter((a) => a.currency === currency)
      .reduce((n, a) => n + (a.lifetimeSpend ?? 0), 0),
  }));

  const state = stateRows.map((s) => ({
    accountId: s.account_id,
    accountLabel: s.account_label,
    /** Who the token is, from `/me` — the only thing that names one Meta
     *  credential apart from another. */
    user: s.graph_user,
    userId: s.graph_user_id,
    /** Whether the calls carried `appsecret_proof`. False means no app pair is
     *  stored; the token reads everything either way. */
    proofed: bool(s.proofed),
    pages: s.pages,
    pagesChecked: s.pages_checked,
    instagramLinked: s.ig_linked,
    adAccounts: s.ad_accounts,
    note: s.note,
    seenAt: s.seen_at,
  }));

  return c.json({
    generatedAt: new Date().toISOString(),
    /** When Meta was last actually READ. The document is rebuilt on every
     *  request, so its own timestamp would say "just now" over figures
     *  collected six hours ago — the same distinction /api/cloudflare draws. */
    seenAt: state.map((s) => s.seenAt).sort().at(-1) ?? null,
    graphVersion: GRAPH_VERSION,
    everyHours: SOCIAL_EVERY_HOURS,
    windowDays: WINDOW_DAYS,
    /** Requested and echoed rather than left to Meta's account default: the
     *  same twelve leads are a different number at a different window, and a
     *  conversion count whose window is not stated is not a measurement. */
    attribution: ATTRIBUTION_LABEL,
    /** One row per connected Meta credential: who the token is, whether its
     *  calls were proofed, and what it could see. A plugin-level "connected"
     *  cannot say "connected and administering nothing". */
    state,
    pages,
    instagram,
    adAccounts,
    spendByCurrency,
    currency: {
      seen: currencies,
      /**
       * NO TOTAL ACROSS CURRENCIES, AND THE REASON TRAVELS WITH THE NULL.
       *
       * This ad account bills in EUR; the rest of this dashboard's money is EUR
       * and USD. A combined figure needs a real, dated exchange rate and this
       * box fetches none — one confident number spanning two currencies is
       * worth less than two numbers that are each right. Same contract
       * /api/costs and /api/mobile keep.
       */
      combined: null,
      note:
        "Ad spend is reported in each account's own currency. No total across " +
        "currencies is offered: it would need a dated exchange rate this box " +
        "does not fetch.",
    },
    /**
     * REACH IS NEVER ADDED, said in words rather than enforced by deleting the
     * number the frequency beside it means anything over. Meta de-duplicates
     * reach and frequency over each ROW's own window: two campaigns that both
     * reached the same person each count them once, so summing counts that
     * person twice, and averaging two frequencies does the same in reverse.
     */
    reachNote:
      "`reach` and `frequency` are de-duplicated per row over that row's own " +
      "window. Read each beside its own spend; never add reach across " +
      "campaigns or accounts, and never average frequency.",
    leadNote:
      `Leads are counted over ${ATTRIBUTION_LABEL} attribution, one action per ` +
      "row (Meta reports the same lead under several names). null means the " +
      "actions field never answered; 0 means the row delivered and produced none.",
    /** What was asked for and what came back, dated — the evidence rather than
     *  the verdict, the same shape Replicate's and Cloudflare's carry. */
    cannot: CANNOT,
  });
});
