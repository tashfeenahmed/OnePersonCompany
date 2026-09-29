/**
 * The public-TikTok tables (migrations 496–499), read and written in one
 * place — store.ts's rules, in a file of their own so the Bluesky half of that
 * file is not interleaved with a second network.
 *
 * NOTHING HERE COMPUTES. Views gained per day, engagement rates and "new this
 * week" are read-time work in tiktok-route.ts.
 */
import { db, now } from "../../db.ts";
import type { DiscoverItem, Profile, Term, Video } from "./tiktok.ts";

/** The box's UTC date — the key every daily table here is written under. */
export const today = () => new Date().toISOString().slice(0, 10);

function tx(fn: () => void) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/* --------------------------------------------------------------- profiles */

export type TiktokProfileRow = {
  handle: string;
  user_id: string | null;
  sec_uid: string | null;
  nickname: string | null;
  avatar: string | null;
  bio: string | null;
  bio_host: string | null;
  followers: number | null;
  following: number | null;
  likes: number | null;
  videos: number | null;
  seen_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
};

export function writeTiktokProfile(p: Profile) {
  const ts = now();
  db.prepare(
    `INSERT INTO tiktok_profiles
       (handle, user_id, sec_uid, nickname, avatar, bio, bio_host, followers, following, likes, videos, seen_at, last_ok_at, last_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT(handle) DO UPDATE SET
       user_id = excluded.user_id, sec_uid = excluded.sec_uid, nickname = excluded.nickname,
       avatar = excluded.avatar, bio = excluded.bio, bio_host = excluded.bio_host,
       followers = excluded.followers, following = excluded.following, likes = excluded.likes,
       videos = excluded.videos, seen_at = excluded.seen_at, last_ok_at = excluded.last_ok_at,
       last_error = NULL`,
  ).run(
    p.handle, p.userId, p.secUid, p.nickname, p.avatar, p.bio, p.bioHost,
    p.followers, p.following, p.likes, p.videos, ts, ts,
  );
}

/** A failed read: the reason, and nothing else touched. */
export function writeTiktokError(handle: string, error: string) {
  db.prepare(
    `INSERT INTO tiktok_profiles (handle, last_error) VALUES (?, ?)
     ON CONFLICT(handle) DO UPDATE SET last_error = excluded.last_error`,
  ).run(handle, error);
}

export function tiktokProfiles(): TiktokProfileRow[] {
  return db.prepare("SELECT * FROM tiktok_profiles ORDER BY handle").all() as unknown as TiktokProfileRow[];
}

/* ------------------------------------------------------------- daily rows */

export type TiktokDayRow = {
  handle: string;
  day: string;
  followers: number | null;
  likes: number | null;
  videos: number | null;
  views: number | null;
  views_complete: number;
  videos_read: number | null;
  seen_at: string;
};

export function writeTiktokDay(
  handle: string,
  p: Pick<Profile, "followers" | "likes" | "videos">,
  read: { views: number | null; complete: boolean; count: number } | null,
) {
  db.prepare(
    `INSERT INTO tiktok_profile_days (handle, day, followers, likes, videos, views, views_complete, videos_read, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(handle, day) DO UPDATE SET
       followers = excluded.followers, likes = excluded.likes, videos = excluded.videos,
       views = COALESCE(excluded.views, tiktok_profile_days.views),
       views_complete = CASE WHEN excluded.views IS NULL THEN tiktok_profile_days.views_complete ELSE excluded.views_complete END,
       videos_read = COALESCE(excluded.videos_read, tiktok_profile_days.videos_read),
       seen_at = excluded.seen_at`,
  ).run(
    handle, today(), p.followers, p.likes, p.videos,
    read?.views ?? null, read?.complete ? 1 : 0, read?.count ?? null, now(),
  );
}

export function tiktokDaysSince(days: number): TiktokDayRow[] {
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare("SELECT * FROM tiktok_profile_days WHERE day >= ? ORDER BY handle, day")
    .all(from) as unknown as TiktokDayRow[];
}

/* ----------------------------------------------------------------- videos */

export type TiktokVideoRow = {
  handle: string;
  video_id: string;
  created_at: string | null;
  caption: string | null;
  cover: string | null;
  url: string | null;
  duration: number | null;
  is_photo: number;
  pinned: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  seen_at: string;
};

/** Replace the handle's videos when the read was complete; upsert otherwise.
 *  See migration 497. */
export function writeTiktokVideos(handle: string, videos: Video[], complete: boolean) {
  const ts = now();
  tx(() => {
    if (complete) db.prepare("DELETE FROM tiktok_videos WHERE handle = ?").run(handle);
    const up = db.prepare(
      `INSERT INTO tiktok_videos
         (handle, video_id, created_at, caption, cover, url, duration, is_photo, pinned, views, likes, comments, shares, saves, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(handle, video_id) DO UPDATE SET
         created_at = excluded.created_at, caption = excluded.caption, cover = excluded.cover,
         url = excluded.url, duration = excluded.duration, is_photo = excluded.is_photo,
         pinned = excluded.pinned, views = excluded.views, likes = excluded.likes,
         comments = excluded.comments, shares = excluded.shares, saves = excluded.saves,
         seen_at = excluded.seen_at`,
    );
    for (const v of videos)
      up.run(
        handle, v.id, v.createdAt, v.caption, v.cover, v.url, v.duration,
        v.isPhoto ? 1 : 0, v.pinned ? 1 : 0, v.views, v.likes, v.comments, v.shares, v.saves, ts,
      );
  });
}

export function tiktokVideos(limit = 400): TiktokVideoRow[] {
  return db
    .prepare("SELECT * FROM tiktok_videos ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as TiktokVideoRow[];
}

/** Rows for handles no longer on the list leave with them — pypi's rule. */
export function forgetTiktokHandles(keep: string[]) {
  for (const table of ["tiktok_profiles", "tiktok_profile_days", "tiktok_videos"]) {
    const rows = db.prepare(`SELECT DISTINCT handle FROM ${table}`).all() as unknown as { handle: string }[];
    for (const r of rows)
      if (!keep.includes(r.handle)) db.prepare(`DELETE FROM ${table} WHERE handle = ?`).run(r.handle);
  }
}

/* --------------------------------------------------------------- searches */

export type TiktokSearchRow = {
  seed: string;
  term: string;
  day: string;
  score: number;
  rank: number;
  hits: number;
  seen_at: string;
};

/** Today's list for one seed, replaced whole — a list merged across two
 *  reads is a ranking of two different moments. */
export function writeTiktokSearches(seed: string, terms: Term[]) {
  const ts = now();
  const day = today();
  tx(() => {
    db.prepare("DELETE FROM tiktok_searches WHERE seed = ? AND day = ?").run(seed, day);
    const ins = db.prepare(
      "INSERT INTO tiktok_searches (seed, term, day, score, rank, hits, seen_at) VALUES (?,?,?,?,?,?,?)",
    );
    for (const t of terms) ins.run(seed, t.term, day, t.score, t.rank, t.hits, ts);
  });
}

export function tiktokSearchesSince(days: number): TiktokSearchRow[] {
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare("SELECT * FROM tiktok_searches WHERE day >= ? ORDER BY seed, day, rank")
    .all(from) as unknown as TiktokSearchRow[];
}

/* --------------------------------------------------------------- discover */

export type TiktokDiscoverRow = {
  kind: string;
  item_id: string;
  day: string;
  rank: number;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  link: string | null;
  cover: string | null;
  views: number | null;
  followers: number | null;
  likes: number | null;
  videos: number | null;
  verified: number | null;
  region: string | null;
  seen_at: string;
};

export function writeTiktokDiscover(region: string | null, items: DiscoverItem[]) {
  const ts = now();
  const day = today();
  tx(() => {
    db.prepare("DELETE FROM tiktok_discover WHERE day = ?").run(day);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO tiktok_discover
         (kind, item_id, day, rank, title, subtitle, description, link, cover, views, followers, likes, videos, verified, region, seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const i of items)
      ins.run(
        i.kind, i.id, day, i.rank, i.title, i.subtitle, i.description, i.link, i.cover,
        i.views, i.followers, i.likes, i.videos, i.verified === null ? null : i.verified ? 1 : 0, region, ts,
      );
  });
}

export function tiktokDiscoverSince(days: number): TiktokDiscoverRow[] {
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return db
    .prepare("SELECT * FROM tiktok_discover WHERE day >= ? ORDER BY day, kind, rank")
    .all(from) as unknown as TiktokDiscoverRow[];
}

/** Trend history is kept for four months; older days are not read by anything. */
export function pruneTiktokTrends(keepDays = 120) {
  const from = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
  db.prepare("DELETE FROM tiktok_searches WHERE day < ?").run(from);
  db.prepare("DELETE FROM tiktok_discover WHERE day < ?").run(from);
}

/* ------------------------------------------------------------ venture map */

/** handle → venture id, from the owner's own links (plugin `tiktok-public`). */
export function tiktokVentureLinks(): Map<string, string> {
  const rows = db
    .prepare("SELECT entity, venture_id FROM venture_links WHERE plugin = 'tiktok-public'")
    .all() as unknown as { entity: string; venture_id: string }[];
  return new Map(rows.map((r) => [r.entity, r.venture_id]));
}
