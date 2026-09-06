/**
 * THE WEB ANALYTICS TABLES, READ AND WRITTEN.
 *
 * One module for the SQL so nothing else in the area composes a statement, and
 * so the three write shapes are decided once rather than per caller:
 *
 *   A DISTRIBUTION IS REPLACED, scoped to (account, website, dimension,
 *   window). A distribution merged across two runs is a distribution of two
 *   different fortnights, and every share drawn from it is wrong.
 *
 *   A WINDOW FIGURE IS UPSERTED by its own key, so a run that dies half way
 *   leaves fewer windows rather than a mixture.
 *
 *   A DAY IS UPSERTED AND NEVER DELETED. Meta revises recent days; history
 *   older than the window this box currently asks for is kept, which is how
 *   this database quietly ends up holding more than any single read would
 *   show.
 *
 * NOTHING HERE COMPUTES A RATE. Bounce rates, click-through, cost per click,
 * shares and averages are divisions and are done at read time by the route, on
 * the codebase's standing rule: a stored division is a figure that decays and
 * then disagrees with the table beside it. The one exception is the numeric
 * property aggregate, which is computed once at COLLECT time because the raw
 * value list it is computed from is not stored — and that is written down on
 * the table.
 */
import { db, now } from "../../db.ts";

/* ------------------------------------------------------------------- rows */

export type DimensionRow = {
  account_id: number;
  website_id: string;
  dimension: string;
  value: string;
  window_days: number;
  offset_days: number;
  start_day: string;
  end_day: string;
  count: number;
  counts: string;
  /** 1 when Umami answered exactly the row limit, so this block is a FLOOR
   *  rather than a distribution. See migration 317. */
  capped: number;
  seen_at: string;
};

export type SiteWindowRow = {
  account_id: number;
  website_id: string;
  window_days: number;
  offset_days: number;
  start_day: string;
  end_day: string;
  pageviews: number | null;
  visitors: number | null;
  visits: number | null;
  bounces: number | null;
  totaltime: number | null;
  seen_at: string;
  /** WHICH TABLE ANSWERED. See `siteWindows` — two collectors on two clocks
   *  write the same 30-day span, and a reader that cannot say which one it
   *  read cannot explain why two pages differed. */
  source: "umami_windows" | "web_site_windows";
};

export type EventRow = {
  account_id: number;
  website_id: string;
  event_name: string;
  window_days: number;
  start_day: string;
  end_day: string;
  occurrences: number | null;
  participants: number | null;
  participants_source: string | null;
  participants_error: string | null;
  seen_at: string;
};

export type EventPropRow = {
  account_id: number;
  website_id: string;
  event_name: string;
  property: string;
  data_type: string;
  window_days: number;
  start_day: string;
  end_day: string;
  records: number;
  distinct_values: number;
  truncated: number;
  num_count: number | null;
  num_sum: number | null;
  num_avg: number | null;
  num_min: number | null;
  num_max: number | null;
  unit: string | null;
  top_values: string | null;
  seen_at: string;
};

export type UtmRow = {
  account_id: number;
  website_id: string;
  window_days: number;
  offset_days: number;
  start_day: string;
  end_day: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  views: number;
  seen_at: string;
};

export type AdSetRow = {
  adset_id: string;
  ad_account_id: string;
  campaign_id: string | null;
  name: string | null;
  status: string | null;
  optimization_goal: string | null;
  billing_event: string | null;
  bid_strategy: string | null;
  daily_budget: number | null;
  lifetime_budget: number | null;
  currency: string | null;
  start_time: string | null;
  end_time: string | null;
  seen_at: string;
};

export type AdCreativeRow = {
  ad_id: string;
  ad_account_id: string;
  adset_id: string | null;
  campaign_id: string | null;
  name: string | null;
  status: string | null;
  configured_status: string | null;
  creative_id: string | null;
  creative_name: string | null;
  title: string | null;
  body: string | null;
  call_to_action: string | null;
  link_url: string | null;
  image_url: string | null;
  thumbnail_url: string | null;
  issues: string | null;
  created_time: string | null;
  updated_time: string | null;
  seen_at: string;
};

export type AdDayRow = {
  ad_id: string;
  ad_account_id: string;
  adset_id: string | null;
  campaign_id: string | null;
  day: string;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  spend: number | null;
  ctr: number | null;
  cpm: number | null;
  actions: string | null;
  seen_at: string;
};

export type AdWindowRow = {
  ad_id: string;
  ad_account_id: string;
  window_days: number;
  offset_days: number;
  start_day: string;
  end_day: string;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  spend: number | null;
  ctr: number | null;
  cpm: number | null;
  seen_at: string;
};

export type CampaignVentureRow = {
  platform: string;
  campaign_id: string;
  venture_id: string;
  source: string;
  evidence: string | null;
  created_at: string;
};

export type BotFindingRow = {
  account_id: number;
  website_id: string;
  heuristic: string;
  fingerprint: string;
  first_seen: string;
  last_seen: string;
  excluded: number | null;
};

/* ------------------------------------------------------------- dimensions */

/** One dimension's whole distribution for one window, replaced. See the
 *  header for why a merge is not on offer. */
export function replaceDimensions(
  accountId: number,
  websiteId: string,
  dimension: string,
  windowDays: number,
  offsetDays: number,
  span: { startDay: string; endDay: string },
  counts: "visitors" | "views",
  rows: { name: string; count: number }[],
  capped: boolean,
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare(
      `DELETE FROM web_dimensions
        WHERE account_id = ? AND website_id = ? AND dimension = ?
          AND window_days = ? AND offset_days = ?`,
    ).run(accountId, websiteId, dimension, windowDays, offsetDays);
    const stmt = db.prepare(
      `INSERT INTO web_dimensions
         (account_id, website_id, dimension, value, window_days, offset_days,
          start_day, end_day, count, counts, capped, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows)
      stmt.run(
        accountId,
        websiteId,
        dimension,
        r.name,
        windowDays,
        offsetDays,
        span.startDay,
        span.endDay,
        r.count,
        counts,
        capped ? 1 : 0,
        seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function dimensionsOf(websiteId: string, windowDays: number, offsetDays: number): DimensionRow[] {
  return db
    .prepare(
      `SELECT * FROM web_dimensions
        WHERE website_id = ? AND window_days = ? AND offset_days = ?
        ORDER BY dimension, count DESC`,
    )
    .all(websiteId, windowDays, offsetDays) as unknown as DimensionRow[];
}

export function writeSiteWindow(row: Omit<SiteWindowRow, "seen_at" | "source">) {
  db.prepare(
    `INSERT INTO web_site_windows
       (account_id, website_id, window_days, offset_days, start_day, end_day,
        pageviews, visitors, visits, bounces, totaltime, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, website_id, window_days, offset_days) DO UPDATE SET
       start_day = excluded.start_day, end_day = excluded.end_day,
       pageviews = excluded.pageviews, visitors = excluded.visitors,
       visits = excluded.visits, bounces = excluded.bounces,
       totaltime = excluded.totaltime, seen_at = excluded.seen_at`,
  ).run(
    row.account_id,
    row.website_id,
    row.window_days,
    row.offset_days,
    row.start_day,
    row.end_day,
    row.pageviews,
    row.visitors,
    row.visits,
    row.bounces,
    row.totaltime,
    now(),
  );
}

/**
 * ONE WEBSITE'S WINDOW FIGURES, FROM WHICHEVER TABLE HOLDS THEM.
 *
 * TWO TABLES HELD THE SAME 30-DAY SPAN ON TWO CLOCKS, and that is the bug this
 * accessor closes. `umami_windows` is written by the traffic collector every
 * six hours for every website; `web_site_windows` is written by this area's
 * own collector on a twelve-hour ROTATION that reaches a few sites a pass. Both
 * ask the same analytics instance for the last 30 complete days, so the rows
 * are read hours to days apart and the two surfaces that publish them —
 * a traffic headline and an audience breakdown, both registered as agent skills
 * on the same plugin — reported different visitor counts for one site and one
 * window. An agent's answer depended on which skill it happened to pick.
 *
 * THE 30-DAY HEADLINE IS `umami_windows`', because it is the fresher and the
 * complete one: every site, four times a day, against a rotation that may not
 * have reached this site yet. Everything else — the last 7 days and the 7
 * before them, which only this area collects — is `web_site_windows`'.
 *
 * `source` says which answered, on every row, so a reader can tell.
 *
 * THE TABLES THEMSELVES STILL NEED MERGING: one `site_windows` keyed
 * (account, website, window_days, offset_days) written by one collector. That
 * is a migration and a collector change; this is the read half, and it is what
 * stops the two surfaces disagreeing in the meantime.
 */
export function siteWindows(websiteId?: string): SiteWindowRow[] {
  const where = websiteId ? "WHERE website_id = ?" : "";
  const args = websiteId ? [websiteId] : [];
  const rows = db
    .prepare(
      `SELECT account_id, website_id, window_days, 0 AS offset_days, start_day, end_day,
              pageviews, visitors, visits, bounces, totaltime, seen_at,
              'umami_windows' AS source
         FROM umami_windows ${where}
       UNION ALL
       SELECT account_id, website_id, window_days, offset_days, start_day, end_day,
              pageviews, visitors, visits, bounces, totaltime, seen_at,
              'web_site_windows' AS source
         FROM web_site_windows ${where}`,
    )
    .all(...args, ...args) as unknown as SiteWindowRow[];

  /* One row per (account, website, window, offset), the authoritative table
     winning wherever both wrote one. */
  const best = new Map<string, SiteWindowRow>();
  for (const r of rows) {
    const k = `${r.account_id}:${r.website_id}:${r.window_days}:${r.offset_days}`;
    const held = best.get(k);
    if (!held || (held.source !== "umami_windows" && r.source === "umami_windows")) best.set(k, r);
  }
  return [...best.values()];
}

/* ----------------------------------------------------------- bot findings */

/**
 * Note that a heuristic fired, keeping the FIRST date it ever did.
 *
 * `first_seen` is never updated — that is the whole value of the row. A
 * heuristic that stops firing keeps its row, so a fingerprint that came back
 * in November is visibly the same one that was there in September rather than
 * a new discovery.
 */
export function noteFinding(
  accountId: number,
  websiteId: string,
  heuristic: string,
  fingerprint: string,
  excluded: number | null,
) {
  const at = now();
  db.prepare(
    `INSERT INTO web_bot_findings
       (account_id, website_id, heuristic, fingerprint, first_seen, last_seen, excluded)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, website_id, heuristic, fingerprint) DO UPDATE SET
       last_seen = excluded.last_seen, excluded = excluded.excluded`,
  ).run(accountId, websiteId, heuristic, fingerprint, at, at, excluded);
}

export function findingsOf(websiteId: string): BotFindingRow[] {
  return db
    .prepare("SELECT * FROM web_bot_findings WHERE website_id = ? ORDER BY heuristic, fingerprint")
    .all(websiteId) as unknown as BotFindingRow[];
}

/* ----------------------------------------------------------------- events */

export function writeEvent(row: Omit<EventRow, "seen_at">) {
  db.prepare(
    `INSERT INTO web_events
       (account_id, website_id, event_name, window_days, start_day, end_day,
        occurrences, participants, participants_source, participants_error, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, website_id, event_name, window_days) DO UPDATE SET
       start_day = excluded.start_day, end_day = excluded.end_day,
       occurrences = excluded.occurrences, participants = excluded.participants,
       participants_source = excluded.participants_source,
       participants_error = excluded.participants_error, seen_at = excluded.seen_at`,
  ).run(
    row.account_id,
    row.website_id,
    row.event_name,
    row.window_days,
    row.start_day,
    row.end_day,
    row.occurrences,
    row.participants,
    row.participants_source,
    row.participants_error,
    now(),
  );
}

export function eventsOf(websiteId: string, windowDays: number): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM web_events WHERE website_id = ? AND window_days = ?
        ORDER BY occurrences DESC`,
    )
    .all(websiteId, windowDays) as unknown as EventRow[];
}

export function writeEventProp(row: Omit<EventPropRow, "seen_at">) {
  db.prepare(
    `INSERT INTO web_event_props
       (account_id, website_id, event_name, property, data_type, window_days,
        start_day, end_day, records, distinct_values, truncated,
        num_count, num_sum, num_avg, num_min, num_max, unit, top_values, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, website_id, event_name, property, window_days) DO UPDATE SET
       data_type = excluded.data_type, start_day = excluded.start_day,
       end_day = excluded.end_day, records = excluded.records,
       distinct_values = excluded.distinct_values, truncated = excluded.truncated,
       num_count = excluded.num_count, num_sum = excluded.num_sum,
       num_avg = excluded.num_avg, num_min = excluded.num_min, num_max = excluded.num_max,
       unit = excluded.unit, top_values = excluded.top_values, seen_at = excluded.seen_at`,
  ).run(
    row.account_id,
    row.website_id,
    row.event_name,
    row.property,
    row.data_type,
    row.window_days,
    row.start_day,
    row.end_day,
    row.records,
    row.distinct_values,
    row.truncated,
    row.num_count,
    row.num_sum,
    row.num_avg,
    row.num_min,
    row.num_max,
    row.unit,
    row.top_values,
    now(),
  );
}

export function eventPropsOf(websiteId: string, windowDays: number): EventPropRow[] {
  return db
    .prepare(
      `SELECT * FROM web_event_props WHERE website_id = ? AND window_days = ?
        ORDER BY event_name, property`,
    )
    .all(websiteId, windowDays) as unknown as EventPropRow[];
}

/** Everything one collection learned about a site's events is replaced
 *  wholesale, because an event that stopped firing must leave the table. */
export function forgetEvents(accountId: number, websiteId: string, windowDays: number) {
  db.prepare(
    "DELETE FROM web_events WHERE account_id = ? AND website_id = ? AND window_days = ?",
  ).run(accountId, websiteId, windowDays);
  db.prepare(
    "DELETE FROM web_event_props WHERE account_id = ? AND website_id = ? AND window_days = ?",
  ).run(accountId, websiteId, windowDays);
}

/* -------------------------------------------------------------------- utm */

export function replaceUtm(
  accountId: number,
  websiteId: string,
  windowDays: number,
  offsetDays: number,
  span: { startDay: string; endDay: string },
  rows: {
    source: string;
    medium: string;
    campaign: string;
    content: string;
    term: string;
    views: number;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare(
      `DELETE FROM web_utm WHERE account_id = ? AND website_id = ?
        AND window_days = ? AND offset_days = ?`,
    ).run(accountId, websiteId, windowDays, offsetDays);
    const stmt = db.prepare(
      `INSERT INTO web_utm
         (account_id, website_id, window_days, offset_days, start_day, end_day,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term, views, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows)
      stmt.run(
        accountId,
        websiteId,
        windowDays,
        offsetDays,
        span.startDay,
        span.endDay,
        r.source,
        r.medium,
        r.campaign,
        r.content,
        r.term,
        r.views,
        seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function utmOf(websiteIds: string[], windowDays: number, offsetDays: number): UtmRow[] {
  if (!websiteIds.length) return [];
  const q = websiteIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM web_utm
        WHERE website_id IN (${q}) AND window_days = ? AND offset_days = ?
        ORDER BY views DESC`,
    )
    .all(...websiteIds, windowDays, offsetDays) as unknown as UtmRow[];
}

/* -------------------------------------------------------------- meta rows */

export function replaceAdSets(adAccountId: string, rows: Omit<AdSetRow, "seen_at">[]) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM ad_sets WHERE ad_account_id = ?").run(adAccountId);
    const stmt = db.prepare(
      `INSERT INTO ad_sets
         (adset_id, ad_account_id, campaign_id, name, status, optimization_goal,
          billing_event, bid_strategy, daily_budget, lifetime_budget, currency,
          start_time, end_time, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows)
      stmt.run(
        r.adset_id,
        r.ad_account_id,
        r.campaign_id,
        r.name,
        r.status,
        r.optimization_goal,
        r.billing_event,
        r.bid_strategy,
        r.daily_budget,
        r.lifetime_budget,
        r.currency,
        r.start_time,
        r.end_time,
        seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function replaceAdCreatives(adAccountId: string, rows: Omit<AdCreativeRow, "seen_at">[]) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM ad_creatives WHERE ad_account_id = ?").run(adAccountId);
    const stmt = db.prepare(
      `INSERT INTO ad_creatives
         (ad_id, ad_account_id, adset_id, campaign_id, name, status, configured_status,
          creative_id, creative_name, title, body, call_to_action, link_url,
          image_url, thumbnail_url, issues, created_time, updated_time, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows)
      stmt.run(
        r.ad_id,
        r.ad_account_id,
        r.adset_id,
        r.campaign_id,
        r.name,
        r.status,
        r.configured_status,
        r.creative_id,
        r.creative_name,
        r.title,
        r.body,
        r.call_to_action,
        r.link_url,
        r.image_url,
        r.thumbnail_url,
        r.issues,
        r.created_time,
        r.updated_time,
        seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Days are upserted, never replaced: Meta revises the recent ones and the
 *  older ones are history this box now holds. */
export function writeAdDays(rows: Omit<AdDayRow, "seen_at">[]) {
  const seen = now();
  const stmt = db.prepare(
    `INSERT INTO ad_days
       (ad_id, ad_account_id, adset_id, campaign_id, day, impressions, reach,
        frequency, clicks, spend, ctr, cpm, actions, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ad_id, day) DO UPDATE SET
       ad_account_id = excluded.ad_account_id, adset_id = excluded.adset_id,
       campaign_id = excluded.campaign_id, impressions = excluded.impressions,
       reach = excluded.reach, frequency = excluded.frequency, clicks = excluded.clicks,
       spend = excluded.spend, ctr = excluded.ctr, cpm = excluded.cpm,
       actions = excluded.actions, seen_at = excluded.seen_at`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.ad_id,
        r.ad_account_id,
        r.adset_id,
        r.campaign_id,
        r.day,
        r.impressions,
        r.reach,
        r.frequency,
        r.clicks,
        r.spend,
        r.ctr,
        r.cpm,
        r.actions,
        seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function writeAdWindows(rows: Omit<AdWindowRow, "seen_at">[]) {
  const seen = now();
  const stmt = db.prepare(
    `INSERT INTO ad_windows
       (ad_id, ad_account_id, window_days, offset_days, start_day, end_day,
        impressions, reach, frequency, clicks, spend, ctr, cpm, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ad_id, window_days, offset_days) DO UPDATE SET
       ad_account_id = excluded.ad_account_id, start_day = excluded.start_day,
       end_day = excluded.end_day, impressions = excluded.impressions,
       reach = excluded.reach, frequency = excluded.frequency, clicks = excluded.clicks,
       spend = excluded.spend, ctr = excluded.ctr, cpm = excluded.cpm,
       seen_at = excluded.seen_at`,
  );
  db.exec("BEGIN");
  try {
    for (const r of rows)
      stmt.run(
        r.ad_id,
        r.ad_account_id,
        r.window_days,
        r.offset_days,
        r.start_day,
        r.end_day,
        r.impressions,
        r.reach,
        r.frequency,
        r.clicks,
        r.spend,
        r.ctr,
        r.cpm,
        seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export const adSets = (adAccountId?: string): AdSetRow[] =>
  (adAccountId
    ? db.prepare("SELECT * FROM ad_sets WHERE ad_account_id = ? ORDER BY name").all(adAccountId)
    : db.prepare("SELECT * FROM ad_sets ORDER BY ad_account_id, name").all()) as unknown as AdSetRow[];

export const adCreatives = (adAccountId?: string): AdCreativeRow[] =>
  (adAccountId
    ? db.prepare("SELECT * FROM ad_creatives WHERE ad_account_id = ? ORDER BY name").all(adAccountId)
    : db.prepare("SELECT * FROM ad_creatives ORDER BY ad_account_id, name").all()) as unknown as AdCreativeRow[];

export const adWindows = (): AdWindowRow[] =>
  db.prepare("SELECT * FROM ad_windows").all() as unknown as AdWindowRow[];

/**
 * ACCOUNT-DAY TOTALS DERIVED FROM THE AD-LEVEL ROWS.
 *
 * WHICH GRAIN IS AUTHORITATIVE, SAID OUT LOUD. The same insights for the same
 * days come back from the same token at two grains, and they are NOT
 * interchangeable: the account-level daily read asks for one row per day and
 * gets all of them, while the ad-level read is capped at a row limit and
 * nothing here follows the platform's paging. So the ACCOUNT-LEVEL table is
 * authoritative for an account's spend, impressions and clicks, and this
 * derivation exists so the ad-level shortfall is a published number instead of
 * a silent one. Where the two disagree, the difference is rows the ad-level
 * read did not see — never a correction to the account figure.
 *
 * The ad-level rows stay the grain for anything that needs a campaign or an
 * advertisement, because the account-level table has no such column.
 */
export function adDayAccountTotals(
  sinceDay: string,
): { ad_account_id: string; days: number; spend: number | null; impressions: number | null; clicks: number | null }[] {
  return db
    .prepare(
      `SELECT ad_account_id,
              COUNT(DISTINCT day) AS days,
              SUM(spend) AS spend,
              SUM(impressions) AS impressions,
              SUM(clicks) AS clicks
         FROM ad_days WHERE day >= ?
        GROUP BY ad_account_id`,
    )
    .all(sinceDay) as unknown as {
    ad_account_id: string;
    days: number;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
  }[];
}

export function adDaysSince(day: string): AdDayRow[] {
  return db
    .prepare("SELECT * FROM ad_days WHERE day >= ? ORDER BY day")
    .all(day) as unknown as AdDayRow[];
}

/* ------------------------------------------------------- campaign mapping */

export const campaignVentures = (): CampaignVentureRow[] =>
  db
    .prepare("SELECT * FROM campaign_ventures ORDER BY venture_id, campaign_id")
    .all() as unknown as CampaignVentureRow[];

export function linkCampaign(
  platform: string,
  campaignId: string,
  ventureId: string,
  source: "auto-by-link" | "manual",
  evidence: string | null,
) {
  db.prepare(
    `INSERT INTO campaign_ventures (platform, campaign_id, venture_id, source, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, campaign_id) DO UPDATE SET
       venture_id = excluded.venture_id, source = excluded.source,
       evidence = excluded.evidence, created_at = excluded.created_at`,
  ).run(platform, campaignId, ventureId, source, evidence, now());
}

export function unlinkCampaign(platform: string, campaignId: string): boolean {
  const info = db
    .prepare("DELETE FROM campaign_ventures WHERE platform = ? AND campaign_id = ?")
    .run(platform, campaignId);
  return Number(info.changes) > 0;
}

/* ----------------------------------------------------------------- clocks */

/** Is this unit due? A unit never collected is always due, which is what makes
 *  a site added this morning read on the next tick. */
export function due(kind: string, key: string, everyHours: number): boolean {
  const row = db
    .prepare("SELECT at FROM web_clocks WHERE kind = ? AND key = ?")
    .get(kind, key) as { at: string } | undefined;
  if (!row) return true;
  const at = Date.parse(row.at);
  return !Number.isFinite(at) || Date.now() - at >= everyHours * 3_600_000;
}

export function markClock(kind: string, key: string) {
  db.prepare(
    `INSERT INTO web_clocks (kind, key, at) VALUES (?, ?, ?)
     ON CONFLICT(kind, key) DO UPDATE SET at = excluded.at`,
  ).run(kind, key, now());
}

/** When this unit was last read, for the document that says how stale a
 *  rotation's oldest site is. */
export function clockAt(kind: string, key: string): string | null {
  const row = db
    .prepare("SELECT at FROM web_clocks WHERE kind = ? AND key = ?")
    .get(kind, key) as { at: string } | undefined;
  return row?.at ?? null;
}
