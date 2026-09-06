/**
 * `/api/webanalytics` — the four documents this area publishes.
 *
 *   GET  /sites                          which websites have deep rows, and how stale
 *   GET  /segments/:websiteId            who the traffic was, raw AND adjusted
 *   GET  /events                         events with participants, and their properties
 *   GET  /events/funnel-inputs           the same rows shaped for conversion work
 *   GET  /campaigns                      the campaign → venture map and its suggestions
 *   GET  /campaigns/:ventureKey          one venture's joined performance
 *   POST /campaigns/link                 file a campaign to a venture
 *   POST /campaigns/unlink               un-file one
 *   GET  /creatives                      ad-level rows, fatigue and status
 *
 * THE RULES EVERY ONE OF THEM KEEPS, and each is a way to produce a confident
 * number that is wrong:
 *
 *   `raw` AND `adjusted` TRAVEL TOGETHER. No parameter removes the raw figure
 *   and no state of the data serves the adjusted one alone.
 *
 *   A PARTICIPANT IS A SESSION IDENTITY. Every event figure carries both the
 *   occurrence count and the participant count, and the document says the
 *   second is sessions rather than people.
 *
 *   REACH AND FREQUENCY ARE NEVER SUMMED OR AVERAGED. They appear only as
 *   Meta's own answer for a window Meta was asked about, with the dates.
 *
 *   AN EFFICIENCY RATIO IS BLENDED. Nothing here attributes revenue to an
 *   advertisement, and the word "ROAS" appears nowhere in an answer.
 *
 *   A `dry` PARAMETER IS NEVER READ FROM A REQUEST. There are two writes on
 *   this router, both of them a row in a mapping table, both reversible, and
 *   neither has a rehearsal mode to be confused about — see the skills proxy
 *   note in the manifest.
 */
import { Hono } from "hono";
import { ventureRow, ventureRows } from "../../db.ts";
import { umamiWebsites } from "../analytics/store.ts";
import * as umami from "../analytics/umami.ts";
import * as meta from "../../providers/meta.ts";
import { segmentsFor } from "./segments.ts";
import { fatigueRows, statusRows, MIN_IMPRESSIONS } from "./fatigue.ts";
import {
  blended,
  conversionSteps,
  joinFor,
  linkedUmamiSites,
  suggestions,
  CONVERSION_WINDOW_DAYS,
  type CampaignSuggestion,
} from "./attribution.ts";
import {
  adCreatives,
  adSets,
  adWindows,
  campaignVentures,
  clockAt,
  eventPropsOf,
  eventsOf,
  linkCampaign,
  unlinkCampaign,
} from "./store.ts";
import { unitFor, SITE_EVERY_HOURS } from "./settings.ts";

export const webAnalyticsRoutes = new Hono();

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/* ------------------------------------------------------------------ sites */

/**
 * The websites this area holds deep rows for, with how long ago each was read.
 *
 * THE ROTATION IS VISIBLE HERE ON PURPOSE. A site whose `readAt` is null has
 * never had its turn, and a card drawn from a site that was read eleven hours
 * ago is a card about eleven hours ago. Hiding the rotation would make an old
 * distribution look current.
 */
webAnalyticsRoutes.get("/sites", (c) => {
  const sites = umamiWebsites();
  const rows = sites.map((s) => {
    const readAt = clockAt("web-site", `${s.account_id}:${s.website_id}`);
    return {
      accountId: s.account_id,
      websiteId: s.website_id,
      name: s.name,
      domain: s.domain,
      readAt,
      staleHours:
        readAt === null ? null : Math.round(((Date.now() - Date.parse(readAt)) / 3_600_000) * 10) / 10,
      events: eventsOf(s.website_id, 30).length,
      ventures: ventureRows()
        .filter((v) => linkedUmamiSites(v.id).includes(s.website_id))
        .map((v) => ({ id: v.id, slug: v.slug, name: v.name })),
    };
  });
  return c.json({
    windowDays: 30,
    everyHours: SITE_EVERY_HOURS,
    sites: rows,
    notes: [
      `Each website is read in full about every ${SITE_EVERY_HOURS} hours, a few per collection pass — a full read is roughly fifty requests against your own analytics server.`,
      "`readAt: null` means this site has never had its turn yet, which is not the same as a site with no traffic.",
    ],
  });
});

/* --------------------------------------------------------------- segments */

webAnalyticsRoutes.get("/segments/:websiteId", (c) => {
  const websiteId = c.req.param("websiteId");
  const site = umamiWebsites().find((s) => s.website_id === websiteId);
  if (!site) return c.json({ error: "No Umami website with that id has been collected." }, 404);
  const days = Number(c.req.query("days") ?? 30) === 7 ? 7 : 30;
  const doc = segmentsFor(websiteId, days);
  return c.json({
    site: { websiteId, name: site.name, domain: site.domain },
    ...doc,
    rules: [
      "`raw` is what Umami said. `adjusted` is what one named heuristic would take off, and it is published beside the raw figure and never instead of it. Nothing stored on this box has been reduced.",
      "The adjusted figure subtracts the LARGEST single finding's population, never the sum of them: the populations overlap by an amount this API cannot measure, so it is a floor on the reduction.",
      "A share is of the DIMENSION'S own rows, not of the site's visitors. `unattributed` is the gap, which is sessions Umami had no value for.",
      "Visitor figures are de-duplicated over the window they were asked about. Two windows' visitors are not subtractable and the 30-day view therefore offers no week-on-week change.",
      "Days are the Umami INSTANCE'S days, in its own timezone, which this box does not know.",
    ],
  });
});

/* ----------------------------------------------------------------- events */

/** One site's events with the properties hung off them. */
function eventDocument(websiteId: string) {
  const events = eventsOf(websiteId, 30);
  const props = eventPropsOf(websiteId, 30);
  return events.map((e) => ({
    event: e.event_name,
    startDay: e.start_day,
    endDay: e.end_day,
    occurrences: e.occurrences,
    participants: e.participants,
    participantsSource: e.participants_source,
    participantsError: e.participants_error,
    /** Occurrences per participant. A figure above 1 means people repeated the
     *  action; it is NOT a step in a journey. */
    perParticipant:
      e.occurrences !== null && e.participants ? Math.round((e.occurrences / e.participants) * 100) / 100 : null,
    properties: props
      .filter((p) => p.event_name === e.event_name)
      .map((p) => ({
        property: p.property,
        type: p.data_type,
        records: p.records,
        distinctValues: p.distinct_values,
        truncated: p.truncated === 1,
        /* THE UNIT IS READ FRESH, not served from the row. It is a SETTING,
           and a setting the owner typed a minute ago must not wait twelve
           hours for the next rotation to appear beside the number it
           describes. The stored value is the fallback for a unit that was set
           and then cleared. */
        unit: unitFor(e.event_name, p.property) ?? p.unit,
        numeric:
          p.num_count === null
            ? null
            : { count: p.num_count, sum: p.num_sum, avg: p.num_avg, min: p.num_min, max: p.num_max },
        topValues: p.top_values ? (JSON.parse(p.top_values) as { value: string; count: number }[]) : null,
      })),
  }));
}

webAnalyticsRoutes.get("/events", (c) => {
  const websiteId = c.req.query("website");
  const sites = umamiWebsites().filter((s) => !websiteId || s.website_id === websiteId);
  if (websiteId && !sites.length)
    return c.json({ error: "No Umami website with that id has been collected." }, 404);
  return c.json({
    windowDays: 30,
    sites: sites.map((s) => ({
      websiteId: s.website_id,
      domain: s.domain,
      name: s.name,
      events: eventDocument(s.website_id),
    })),
    limits: {
      detailedEvents: umami.EVENT_DETAIL_LIMIT,
      propertyValues: umami.PROPERTY_VALUE_LIMIT,
    },
    rules: [
      "`occurrences` and `participants` are two different counts from two different endpoints. On the connected instance one event fired 5,978 times in 4,434 sessions; publishing the first as though it were people overstates that step by a third.",
      "A PARTICIPANT IS A SESSION IDENTITY, NOT A PERSON. Umami hashes the site, the address and the user agent: one person on two devices is two, one office behind one address may be one.",
      "`participants: null` with a `participantsError` means the figure was not asked for or the endpoint refused. It is not nought and it is not the occurrence count.",
      "A numeric property's sum, mean and range are computed from Umami's complete value list and are exact — unless `truncated` is true, in which case the aggregate is refused rather than published short.",
      "`unit: null` means nobody has said what the property is IN. Never assume a currency.",
      "`topValues` is a RANKING and sums to less than `records`. It is never a total.",
      "STEP COUNTS ARE NOT A USER JOURNEY. Two events with 100 and 40 participants do not mean 40 of those 100 people went on to the second: these are two independent counts over the same window, and no session-level path was read.",
    ],
  });
});

/**
 * The same rows, shaped as INPUTS to conversion work.
 *
 * WHY A SEPARATE VIEW RATHER THAN A FUNNEL. A funnel asserts that the people
 * at step two are a subset of the people at step one, and nothing in this data
 * says that: these are independent per-event participant counts over one
 * window. So this view publishes the ORDERED LIST the owner named as this
 * venture's conversion events, each with its own participants, plus the
 * denominator the site's visitor count gives — and it refuses to call the
 * ratios a drop-off.
 */
webAnalyticsRoutes.get("/events/funnel-inputs", (c) => {
  const key = c.req.query("venture");
  const wanted = key ? [ventureRow(key)].filter((v) => v !== undefined) : ventureRows();
  if (key && !wanted.length) return c.json({ error: "No venture with that slug or id." }, 404);

  return c.json({
    windowDays: CONVERSION_WINDOW_DAYS,
    ventures: wanted.map((v) => {
      /* THE ONE READER. The conversion-work view, the campaign join and the
         growth area's funnel all read these rows through `conversionSteps`, so
         a step quoted on one page is the same count as the step quoted on
         another. They used to be three reads of two tables with two
         populations. */
      const measured = conversionSteps(v!);
      return {
        venture: { id: v!.id, slug: v!.slug, name: v!.name, stage: v!.stage },
        websites: measured.websites,
        /** The window's own session figure per site — the only honest
         *  denominator for a step, and never a sum of daily sessions. */
        sessions: measured.sessions,
        steps: measured.steps.filter((s) => s.named),
        note: measured.note,
      };
    }),
    rules: [
      "THESE ARE INPUTS, NOT A FUNNEL. Each step is an independent count of sessions that fired that event in the window. Nothing here establishes that the sessions at step two are a subset of the sessions at step one.",
      "A ratio between two steps is a ratio of two independent counts. It may be quoted as that and must never be called a drop-off, a conversion rate or a user journey.",
      "The step ORDER is the owner's, typed into a setting. It is not evidence of an order in which anything happened.",
      "Participants are session identities. See /api/webanalytics/events.",
    ],
  });
});

/* -------------------------------------------------------------- campaigns */

const shapeSuggestion = (s: CampaignSuggestion) => ({
  platform: s.platform,
  campaignId: s.campaignId,
  campaignName: s.campaignName,
  adAccountId: s.adAccountId,
  venture: { id: s.ventureId, name: s.ventureName },
  via: s.via,
  evidence: s.evidence,
});

webAnalyticsRoutes.get("/campaigns", (c) => {
  const links = campaignVentures();
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));
  const proposed = suggestions();
  const contested = new Set(
    proposed
      .map((s) => s.campaignId)
      .filter((id, i, all) => all.indexOf(id) !== i),
  );
  return c.json({
    links: links.map((l) => ({
      platform: l.platform,
      campaignId: l.campaign_id,
      venture: { id: l.venture_id, name: names.get(l.venture_id) ?? null },
      source: l.source,
      evidence: l.evidence,
      createdAt: l.created_at,
    })),
    suggestions: proposed.map(shapeSuggestion),
    contested: [...contested],
    rules: [
      "A SUGGESTION IS NOT A LINK. Suggestions are recomputed on every read out of live rows and nothing is filed until somebody presses something.",
      "A campaign in `contested` matched more than one venture. Nothing is applied for those — pick one.",
      "`source: \"auto-by-link\"` means a URL in the campaign, its ad sets, its advertisements or its creative pointed at that venture's host. `manual` means somebody chose.",
      "The `utm-tag` evidence is a NAME match: the site was visited with utm_campaign equal to this campaign's name. Umami has never heard of a Meta campaign id.",
    ],
  });
});

webAnalyticsRoutes.get("/campaigns/:ventureKey", async (c) => {
  const venture = ventureRow(c.req.param("ventureKey"));
  if (!venture) return c.json({ error: "No venture with that slug or id." }, 404);
  const days = clamp(Number(c.req.query("days") ?? 30) || 30, 1, 90);
  const join = joinFor(venture, days);
  const month = (c.req.query("month") ?? new Date().toISOString().slice(0, 7)).slice(0, 7);
  const efficiency = await blended(venture, month, join.spend);
  return c.json({
    ...join,
    blended: efficiency,
    rules: [
      "SPEND, IMPRESSIONS AND CLICKS ARE JOINED BY CAMPAIGN ID and are exact sums of daily rows Meta issued.",
      "TAGGED VIEWS ARE JOINED BY NAME — the campaign's name against the utm_campaign text on the site. It is as good as the tagging was, and a campaign with spend and no tagged views means the links were not tagged, NOT that nobody arrived.",
      "`views` on a tagged row is Umami's own count for a pageview-keyed metric. It is not sessions and it is not people.",
      "REACH AND FREQUENCY ARE ABSENT ON PURPOSE. Both are de-duplicated per row and summing them over a venture's campaigns would count the same person once per campaign.",
      "The efficiency ratio is BLENDED: venture revenue over ad spend, with no attribution of any kind. It is not return on ad spend and it must never be called one.",
      "Nothing is added across currencies. A ratio exists only where revenue and spend are in the same one.",
    ],
  });
});

/**
 * File a campaign to a venture.
 *
 * NO `dry` PARAMETER EXISTS HERE and none is read. The write is one row in a
 * mapping table and it is reversible by the unlink route beside it; a
 * rehearsal mode would be a second code path for something that changes a
 * label. (The skills proxy sends every parameter as a STRING, which is exactly
 * how a `dry === true` check becomes a live write — so this route has nothing
 * boolean to get wrong.)
 */
webAnalyticsRoutes.post("/campaigns/link", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const campaignId = String(body.campaignId ?? "").trim();
  const ventureKey = String(body.venture ?? "").trim();
  const platform = String(body.platform ?? "meta").trim() || "meta";
  if (!campaignId || !ventureKey)
    return c.json({ error: "campaignId and venture are both required." }, 400);
  const venture = ventureRow(ventureKey);
  if (!venture) return c.json({ error: `No venture matches “${ventureKey}”.` }, 404);

  /* An accepted SUGGESTION keeps the sentence that produced it; anything else
     is the owner's own choice and is recorded as such. */
  const match = suggestions().find(
    (s) => s.campaignId === campaignId && s.ventureId === venture.id && s.platform === platform,
  );
  const source = match ? "auto-by-link" : "manual";
  const evidence = match?.evidence ?? (typeof body.evidence === "string" ? body.evidence.slice(0, 400) : null);
  linkCampaign(platform, campaignId, venture.id, source, evidence);
  return c.json({
    ok: true,
    platform,
    campaignId,
    venture: { id: venture.id, slug: venture.slug, name: venture.name },
    source,
    evidence,
  });
});

webAnalyticsRoutes.post("/campaigns/unlink", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const campaignId = String(body.campaignId ?? "").trim();
  const platform = String(body.platform ?? "meta").trim() || "meta";
  if (!campaignId) return c.json({ error: "campaignId is required." }, 400);
  const removed = unlinkCampaign(platform, campaignId);
  return c.json({ ok: removed, platform, campaignId, removed });
});

/* -------------------------------------------------------------- creatives */

webAnalyticsRoutes.get("/creatives", (c) => {
  const adAccountId = c.req.query("account");
  const ads = adCreatives(adAccountId ?? undefined);
  const sets = adSets(adAccountId ?? undefined);
  const rows = fatigueRows(ads, adWindows(), sets, meta.AD_COMPARE_DAYS);
  const statuses = statusRows(ads);
  const mapped = new Map(campaignVentures().map((l) => [l.campaign_id, l.venture_id]));
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));

  const counts = { fatigued: 0, tiring: 0, steady: 0, "no-verdict": 0 } as Record<string, number>;
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;

  return c.json({
    compareDays: meta.AD_COMPARE_DAYS,
    minImpressions: MIN_IMPRESSIONS,
    counts,
    adSets: sets.map((s) => ({
      adsetId: s.adset_id,
      adAccountId: s.ad_account_id,
      campaignId: s.campaign_id,
      name: s.name,
      status: s.status,
      optimizationGoal: s.optimization_goal,
      billingEvent: s.billing_event,
      bidStrategy: s.bid_strategy,
      /** MINOR UNITS of `currency`, as Meta sent them. */
      dailyBudgetMinor: s.daily_budget,
      lifetimeBudgetMinor: s.lifetime_budget,
      currency: s.currency,
      startTime: s.start_time,
      endTime: s.end_time,
      ads: ads.filter((a) => a.adset_id === s.adset_id).length,
    })),
    ads: rows.map((r) => ({
      ...r,
      venture:
        r.campaignId && mapped.has(r.campaignId)
          ? { id: mapped.get(r.campaignId)!, name: names.get(mapped.get(r.campaignId)!) ?? null }
          : null,
    })),
    statuses: statuses.filter((s) => s.issues.length || s.mismatched),
    rules: [
      "FATIGUE IS ONE SHAPE: frequency rising while click-through falls, over two matched weeks Meta answered separately. A rising frequency alone is a small audience and a falling click-through alone is an auction.",
      `Under ${MIN_IMPRESSIONS} impressions in either week there is NO VERDICT — not a cautious one, none — and \`why\` says so.`,
      "REACH AND FREQUENCY COME FROM META'S OWN WINDOW ROWS and were never derived from daily rows. They are de-duplicated per window and may not be summed or averaged.",
      "AN AD SET ID DOES NOT ESTABLISH LEARNING STATUS AND DOES NOT ESTABLISH AUDIENCE OVERLAP. Neither the delivery-insights call nor the targeting specification is read by this box.",
      "A high frequency is reported as its own finding, never as evidence of overlap.",
      "`issues` is META'S OWN issues_info, unedited. An advertisement with no issue is an advertisement Meta chose to report nothing about — which is not the same as one in good standing.",
      "`mismatched` means configured ACTIVE and effectively not delivering: it reads as live in the interface it was set up in.",
      "Budgets are in MINOR UNITS of the account's own currency, as Meta sends them. Nothing is added across accounts.",
      "Image URLs are SIGNED AND EXPIRE within days. Do not cache one and expect a 403 eventually.",
    ],
  });
});
