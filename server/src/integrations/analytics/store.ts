/**
 * The analytics area's tables, read and written in one place.
 *
 * WHY A FILE OF ITS OWN rather than SQL inside each collector and each route.
 * Every table here is written by exactly one collector and read by exactly one
 * route, and both need to agree about what a partial write means. Keeping the
 * pair of statements side by side is what makes "a failed account keeps the
 * rows it wrote last time" a property of the schema's use rather than a habit
 * two files happen to share.
 *
 * THE TWO WRITE SHAPES, and every function below is one of them:
 *
 *   A REPLACEMENT is scoped as narrowly as the thing being replaced — one
 *   account's websites, one website's ranking. A website deleted in Umami
 *   leaves the table on the next run; an account that could not answer is not
 *   emptied by its neighbour's success.
 *
 *   AN ACCUMULATION is keyed by its own day (or its own window) and is upsert
 *   only. A run that dies half way leaves fewer days rather than a wrong
 *   picture, and the next run fills them in.
 *
 * NOTHING HERE COMPUTES. There is no total, no average, no rate and no delta
 * in this file: those are all read-time work, in the routes, for the reason
 * routes/npm.ts and routes/gsc.ts give at length — a stored derived figure is
 * one that decays, and it disagrees with the table beside it the moment the
 * source revises a day.
 */
import { db, now } from "../../db.ts";

/* ------------------------------------------------------------ slow clocks */

/** When this collector last actually READ its source for this key, or null.
 *  See migration 030 for why it is not the `runs` table. */
export function clockAt(plugin: string, key: string): string | null {
  const row = db
    .prepare("SELECT at FROM analytics_clocks WHERE plugin = ? AND key = ?")
    .get(plugin, key) as { at: string } | undefined;
  return row?.at ?? null;
}

export function markClock(plugin: string, key: string) {
  db.prepare(
    `INSERT INTO analytics_clocks (plugin, key, at) VALUES (?, ?, ?)
     ON CONFLICT(plugin, key) DO UPDATE SET at = excluded.at`,
  ).run(plugin, key, now());
}

/** True when this key has never been read, or was read longer ago than the
 *  clock allows. Never-read is DUE, whatever the clock says: the point of
 *  connecting something is to see it. */
export function due(plugin: string, key: string, everyHours: number): boolean {
  const at = clockAt(plugin, key);
  if (!at) return true;
  return Date.now() - Date.parse(at) >= everyHours * 3_600_000;
}

/**
 * Forget the clocks of keys that are no longer watched.
 *
 * A row here outlives the thing it timed — a deleted account, a package taken
 * off the list — and a stale one is harmless in itself (a key nobody asks
 * about is never read). It is removed anyway, because a clock table that only
 * grows is a table where "when did we last read X" stops being answerable by
 * looking: the answer would be buried among rows for things that no longer
 * exist. Callers pass the keys that are still real.
 */
export function pruneClocks(plugin: string, keep: string[]) {
  for (const row of db
    .prepare("SELECT key FROM analytics_clocks WHERE plugin = ?")
    .all(plugin) as unknown as { key: string }[]) {
    if (!keep.includes(row.key))
      db.prepare("DELETE FROM analytics_clocks WHERE plugin = ? AND key = ?").run(
        plugin,
        row.key,
      );
  }
}

/* ----------------------------------------------------------------- umami */

export type UmamiWebsiteRow = {
  account_id: number;
  website_id: string;
  name: string | null;
  domain: string | null;
  seen_at: string;
};

/** One account's websites, replaced. See the two write shapes above. */
export function replaceUmamiWebsites(
  accountId: number,
  sites: { id: string; name: string | null; domain: string | null }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM umami_websites WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO umami_websites (account_id, website_id, name, domain, seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const s of sites) ins.run(accountId, s.id, s.name, s.domain, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function umamiWebsites(): UmamiWebsiteRow[] {
  return db
    .prepare("SELECT * FROM umami_websites ORDER BY account_id, name, website_id")
    .all() as unknown as UmamiWebsiteRow[];
}

export function writeUmamiDays(
  accountId: number,
  websiteId: string,
  days: { day: string; pageviews: number; sessions: number }[],
): number {
  const ins = db.prepare(
    `INSERT INTO umami_days (account_id, website_id, day, pageviews, sessions)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, website_id, day) DO UPDATE SET
       pageviews = excluded.pageviews, sessions = excluded.sessions`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const d of days) {
      ins.run(accountId, websiteId, d.day, d.pageviews, d.sessions);
      n++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

export type UmamiDayRow = {
  account_id: number;
  website_id: string;
  day: string;
  pageviews: number;
  sessions: number;
};

/** The last `days` day-labels held, inclusive of the newest. `days - 1` back
 *  rather than `days`, so a caller asking for thirty gets thirty rather than
 *  thirty-one — an off-by-one in a window length is how a chart's own caption
 *  stops being true. */
export function umamiDaysSince(days: number): UmamiDayRow[] {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare("SELECT * FROM umami_days WHERE day >= ? ORDER BY day ASC")
    .all(since) as unknown as UmamiDayRow[];
}

export type UmamiStatFigures = {
  pageviews: number | null;
  visitors: number | null;
  visits: number | null;
  bounces: number | null;
  totaltime: number | null;
};

export type UmamiWindowRow = {
  account_id: number;
  website_id: string;
  window_days: number;
  start_day: string;
  end_day: string;
  seen_at: string;
} & UmamiStatFigures & {
    prev_pageviews: number | null;
    prev_visitors: number | null;
    prev_visits: number | null;
    prev_bounces: number | null;
    prev_totaltime: number | null;
  };

export function writeUmamiWindow(
  accountId: number,
  websiteId: string,
  windowDays: number,
  bounds: { start: string; end: string },
  current: UmamiStatFigures,
  previous: UmamiStatFigures,
) {
  db.prepare(
    `INSERT INTO umami_windows
       (account_id, website_id, window_days, start_day, end_day,
        pageviews, visitors, visits, bounces, totaltime,
        prev_pageviews, prev_visitors, prev_visits, prev_bounces, prev_totaltime,
        seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id, website_id, window_days) DO UPDATE SET
       start_day = excluded.start_day, end_day = excluded.end_day,
       pageviews = excluded.pageviews, visitors = excluded.visitors,
       visits = excluded.visits, bounces = excluded.bounces,
       totaltime = excluded.totaltime,
       prev_pageviews = excluded.prev_pageviews,
       prev_visitors = excluded.prev_visitors,
       prev_visits = excluded.prev_visits,
       prev_bounces = excluded.prev_bounces,
       prev_totaltime = excluded.prev_totaltime,
       seen_at = excluded.seen_at`,
  ).run(
    accountId, websiteId, windowDays, bounds.start, bounds.end,
    current.pageviews, current.visitors, current.visits, current.bounces, current.totaltime,
    previous.pageviews, previous.visitors, previous.visits, previous.bounces,
    previous.totaltime, now(),
  );
}

export function umamiWindows(): UmamiWindowRow[] {
  return db
    .prepare("SELECT * FROM umami_windows")
    .all() as unknown as UmamiWindowRow[];
}

export type UmamiTopRow = {
  account_id: number;
  website_id: string;
  kind: string;
  name: string;
  count: number;
  window_days: number;
  seen_at: string;
};

/** One website's ranking of one kind, replaced. A ranking merged across two
 *  runs is a ranking of two different days. */
export function replaceUmamiTop(
  accountId: number,
  websiteId: string,
  kind: string,
  windowDays: number,
  rows: { name: string; count: number }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare(
      `DELETE FROM umami_top
        WHERE account_id = ? AND website_id = ? AND kind = ? AND window_days = ?`,
    ).run(accountId, websiteId, kind, windowDays);
    const ins = db.prepare(
      `INSERT INTO umami_top
         (account_id, website_id, kind, name, count, window_days, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, website_id, kind, window_days, name)
         DO UPDATE SET count = excluded.count, seen_at = excluded.seen_at`,
    );
    for (const r of rows)
      ins.run(accountId, websiteId, kind, r.name, r.count, windowDays, seen);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function umamiTop(): UmamiTopRow[] {
  return db
    .prepare("SELECT * FROM umami_top ORDER BY count DESC")
    .all() as unknown as UmamiTopRow[];
}

/* -------------------------------------------------------------- calendar */

export type CalendarRow = {
  account_id: number;
  calendar_id: string;
  summary: string | null;
  timezone: string | null;
  is_primary: number;
  selected: number;
  access_role: string | null;
  seen_at: string;
};

export function replaceCalendars(
  accountId: number,
  rows: {
    id: string;
    summary: string | null;
    timezone: string | null;
    primary: boolean;
    selected: boolean;
    accessRole: string | null;
  }[],
) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM calendar_calendars WHERE account_id = ?").run(accountId);
    const ins = db.prepare(
      `INSERT INTO calendar_calendars
         (account_id, calendar_id, summary, timezone, is_primary, selected,
          access_role, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows)
      ins.run(
        accountId, r.id, r.summary, r.timezone, r.primary ? 1 : 0,
        r.selected ? 1 : 0, r.accessRole, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function calendars(): CalendarRow[] {
  return db
    .prepare("SELECT * FROM calendar_calendars ORDER BY is_primary DESC, summary")
    .all() as unknown as CalendarRow[];
}

export type CalendarEventRow = {
  account_id: number;
  calendar_id: string;
  event_id: string;
  summary: string | null;
  starts_at: string | null;
  ends_at: string | null;
  all_day: number;
  status: string | null;
  location: string | null;
  attendees: number | null;
  organizer_self: number | null;
  response: string | null;
  updated_at: string | null;
};

export type CalendarEventInput = {
  id: string;
  summary: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  status: string | null;
  location: string | null;
  attendees: number | null;
  organizerSelf: boolean | null;
  response: string | null;
  updated: string | null;
};

/**
 * One calendar's events over the window, replaced.
 *
 * A REPLACEMENT SCOPED TO THE WINDOW, not to the calendar: rows outside
 * [from, to) are left alone, so last month's events survive a collection that
 * only ever asks about the next three weeks — and an event CANCELLED or
 * deleted inside the window disappears, which an upsert-only write could never
 * express. Google returns cancelled instances explicitly when asked with
 * singleEvents, and those are written with status 'cancelled' rather than
 * dropped, because "that meeting was called off" is news.
 */
export function replaceCalendarEvents(
  accountId: number,
  calendarId: string,
  from: string,
  to: string,
  events: CalendarEventInput[],
) {
  db.exec("BEGIN");
  try {
    db.prepare(
      `DELETE FROM calendar_events
        WHERE account_id = ? AND calendar_id = ?
          AND starts_at IS NOT NULL AND starts_at >= ? AND starts_at < ?`,
    ).run(accountId, calendarId, from, to);
    const ins = db.prepare(
      `INSERT INTO calendar_events
         (account_id, calendar_id, event_id, summary, starts_at, ends_at,
          all_day, status, location, attendees, organizer_self, response,
          updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_id, calendar_id, event_id) DO UPDATE SET
         summary = excluded.summary, starts_at = excluded.starts_at,
         ends_at = excluded.ends_at, all_day = excluded.all_day,
         status = excluded.status, location = excluded.location,
         attendees = excluded.attendees,
         organizer_self = excluded.organizer_self,
         response = excluded.response, updated_at = excluded.updated_at`,
    );
    for (const e of events)
      ins.run(
        accountId, calendarId, e.id, e.summary, e.start, e.end,
        e.allDay ? 1 : 0, e.status, e.location, e.attendees,
        e.organizerSelf === null ? null : e.organizerSelf ? 1 : 0,
        e.response, e.updated,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Events whose start string sorts inside [from, to). Both bounds are the
 *  same shape Google gave us — see migration 032 on why they are not UTC. */
export function calendarEventsBetween(from: string, to: string): CalendarEventRow[] {
  return db
    .prepare(
      `SELECT * FROM calendar_events
        WHERE starts_at IS NOT NULL AND starts_at >= ? AND starts_at < ?
        ORDER BY starts_at ASC`,
    )
    .all(from, to) as unknown as CalendarEventRow[];
}

/** Everything older than the window the collector maintains, forgotten. The
 *  collector calls this: a calendar is a rolling window, and events from six
 *  months ago answer no question this route asks. */
export function pruneCalendarEvents(before: string): number {
  const info = db
    .prepare("DELETE FROM calendar_events WHERE starts_at IS NULL OR starts_at < ?")
    .run(before);
  return Number(info.changes);
}

/* ------------------------------------------------------------------ pypi */

export type PypiDayRow = { package: string; day: string; downloads: number };

export function writePypiDays(
  pkg: string,
  days: { day: string; downloads: number }[],
): number {
  const ins = db.prepare(
    `INSERT INTO pypi_days (package, day, downloads) VALUES (?, ?, ?)
     ON CONFLICT(package, day) DO UPDATE SET downloads = excluded.downloads`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const d of days) {
      ins.run(pkg, d.day, d.downloads);
      n++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

export function pypiDaysSince(days: number): PypiDayRow[] {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare("SELECT * FROM pypi_days WHERE day >= ? ORDER BY day ASC")
    .all(since) as unknown as PypiDayRow[];
}

export type PypiPackageRow = {
  package: string;
  version: string | null;
  summary: string | null;
  home_page: string | null;
  project_urls: string | null;
  last_day: number | null;
  last_week: number | null;
  last_month: number | null;
  recent_at: string | null;
  meta_at: string | null;
  seen_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
};

/** Whatever this run learned, merged onto the row. Every field is optional
 *  because the two upstream services fail independently: metadata that 404s
 *  must not blank the download counters, and vice versa. */
export function writePypiPackage(
  pkg: string,
  patch: {
    version?: string | null;
    summary?: string | null;
    homePage?: string | null;
    projectUrls?: string | null;
    lastDay?: number | null;
    lastWeek?: number | null;
    lastMonth?: number | null;
    recentAt?: string | null;
    metaAt?: string | null;
    error?: string | null;
    ok?: boolean;
  },
) {
  const ts = now();
  db.prepare(
    `INSERT INTO pypi_packages (package, seen_at) VALUES (?, ?)
     ON CONFLICT(package) DO UPDATE SET seen_at = excluded.seen_at`,
  ).run(pkg, ts);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const put = (col: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${col} = ?`);
    args.push(value);
  };
  put("version", patch.version);
  put("summary", patch.summary);
  put("home_page", patch.homePage);
  put("project_urls", patch.projectUrls);
  put("last_day", patch.lastDay);
  put("last_week", patch.lastWeek);
  put("last_month", patch.lastMonth);
  put("recent_at", patch.recentAt);
  put("meta_at", patch.metaAt);
  put("last_error", patch.error);
  if (patch.ok) put("last_ok_at", ts);
  if (!sets.length) return;
  args.push(pkg);
  db.prepare(`UPDATE pypi_packages SET ${sets.join(", ")} WHERE package = ?`).run(...args);
}

export function pypiPackages(): PypiPackageRow[] {
  return db
    .prepare("SELECT * FROM pypi_packages ORDER BY package")
    .all() as unknown as PypiPackageRow[];
}

/** A name taken off the list takes its downloads with it — collectNpm's rule,
 *  for its reason: otherwise it goes on counting inside every total while
 *  appearing nowhere on the page. */
export function forgetPypiPackages(keep: string[]) {
  pruneClocks("pypi", keep);
  const held = pypiPackages().map((p) => p.package);
  for (const pkg of held) {
    if (keep.includes(pkg)) continue;
    db.prepare("DELETE FROM pypi_days WHERE package = ?").run(pkg);
    db.prepare("DELETE FROM pypi_packages WHERE package = ?").run(pkg);
  }
}

/* --------------------------------------------------------------- bluesky */

export type BlueskyProfileRow = {
  handle: string;
  did: string | null;
  display_name: string | null;
  followers: number | null;
  follows: number | null;
  posts: number | null;
  avatar: string | null;
  seen_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
};

export function writeBlueskyProfile(
  handle: string,
  patch: {
    did?: string | null;
    displayName?: string | null;
    followers?: number | null;
    follows?: number | null;
    posts?: number | null;
    avatar?: string | null;
    error?: string | null;
    ok?: boolean;
  },
) {
  const ts = now();
  db.prepare(
    `INSERT INTO bluesky_profiles (handle, seen_at) VALUES (?, ?)
     ON CONFLICT(handle) DO UPDATE SET seen_at = excluded.seen_at`,
  ).run(handle, ts);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const put = (col: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${col} = ?`);
    args.push(value);
  };
  put("did", patch.did);
  put("display_name", patch.displayName);
  put("followers", patch.followers);
  put("follows", patch.follows);
  put("posts", patch.posts);
  put("avatar", patch.avatar);
  put("last_error", patch.error);
  if (patch.ok) put("last_ok_at", ts);
  if (!sets.length) return;
  args.push(handle);
  db.prepare(`UPDATE bluesky_profiles SET ${sets.join(", ")} WHERE handle = ?`).run(...args);
}

export function blueskyProfiles(): BlueskyProfileRow[] {
  return db
    .prepare("SELECT * FROM bluesky_profiles ORDER BY handle")
    .all() as unknown as BlueskyProfileRow[];
}

export type BlueskyWindowRow = {
  handle: string;
  window_days: number;
  posts: number;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  truncated: number;
  oldest_seen: string | null;
  seen_at: string;
};

export function writeBlueskyWindow(
  handle: string,
  windowDays: number,
  w: {
    posts: number;
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    truncated: boolean;
    oldestSeen: string | null;
  },
) {
  db.prepare(
    `INSERT INTO bluesky_windows
       (handle, window_days, posts, likes, reposts, replies, quotes,
        truncated, oldest_seen, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(handle, window_days) DO UPDATE SET
       posts = excluded.posts, likes = excluded.likes,
       reposts = excluded.reposts, replies = excluded.replies,
       quotes = excluded.quotes, truncated = excluded.truncated,
       oldest_seen = excluded.oldest_seen, seen_at = excluded.seen_at`,
  ).run(
    handle, windowDays, w.posts, w.likes, w.reposts, w.replies, w.quotes,
    w.truncated ? 1 : 0, w.oldestSeen, now(),
  );
}

export function blueskyWindows(): BlueskyWindowRow[] {
  return db
    .prepare("SELECT * FROM bluesky_windows")
    .all() as unknown as BlueskyWindowRow[];
}

export type BlueskyPostRow = {
  handle: string;
  uri: string;
  created_at: string | null;
  text: string | null;
  image: string | null;
  url: string | null;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  is_reply: number;
  seen_at: string;
};

/**
 * The handle's own posts, as the last read found them.
 *
 * REPLACE RATHER THAN MERGE, and the delete is the reason: a post the author
 * has since taken down would otherwise sit in this table for ever, drawn on a
 * board with a link that 404s. What the feed returned IS the handle's recent
 * timeline, so the table is made to say exactly that. The counts move on every
 * write because they are current state — see the migration.
 */
export function writeBlueskyPosts(
  handle: string,
  posts: {
    uri: string;
    createdAt: string | null;
    text: string | null;
    image: string | null;
    url: string | null;
    likes: number;
    reposts: number;
    replies: number;
    quotes: number;
    isReply: boolean;
  }[],
) {
  const ts = now();
  /* One transaction, for the reason the domain portfolio takes one: a handle
     whose posts were deleted and not re-inserted is a timeline that reads as
     empty, which is worse than one reading of it being stale. */
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM bluesky_posts WHERE handle = ?").run(handle);
    const insert = db.prepare(
      `INSERT INTO bluesky_posts
         (handle, uri, created_at, text, image, url, likes, reposts, replies, quotes, is_reply, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const p of posts)
      insert.run(
        handle, p.uri, p.createdAt, p.text, p.image, p.url,
        p.likes, p.reposts, p.replies, p.quotes, p.isReply ? 1 : 0, ts,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Every stored post, newest first. Bounded, because a route that returns a
 *  whole timeline is a route that grows without anybody noticing. */
export function blueskyPosts(limit = 100): BlueskyPostRow[] {
  return db
    .prepare("SELECT * FROM bluesky_posts ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(300, Math.floor(limit)))) as unknown as BlueskyPostRow[];
}

export function forgetBlueskyHandles(keep: string[]) {
  pruneClocks("bluesky", keep);
  for (const row of blueskyProfiles()) {
    if (keep.includes(row.handle)) continue;
    db.prepare("DELETE FROM bluesky_posts WHERE handle = ?").run(row.handle);
    db.prepare("DELETE FROM bluesky_windows WHERE handle = ?").run(row.handle);
    db.prepare("DELETE FROM bluesky_profiles WHERE handle = ?").run(row.handle);
  }
}
