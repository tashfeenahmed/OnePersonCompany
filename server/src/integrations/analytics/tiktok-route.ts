/**
 * Public TikTok — the watched accounts, every video's counts, the daily
 * history this box has kept of them, and the two trend reads.
 *
 * THE COUNTS ARE AS OF THE LAST READ. A video's views are TikTok's running
 * total, so "views in the last 7 days" on a board means views on videos
 * POSTED in those days, as they stand now. The one per-day figure that is a
 * real daily figure is `days[].views` differenced between two consecutive
 * COMPLETE days — views gained — and the route leaves that subtraction to the
 * reader with `viewsComplete` beside every row so a partial read is never
 * differenced against a whole one.
 *
 * THE VENTURE A HANDLE BELONGS TO is the owner's link when there is one, and
 * otherwise the venture whose own host the account names in its bio
 * ("More: ExampleApp.com"). The second is the account's own claim about
 * itself, not a guess from its name, and `ventureVia` says which it was.
 */
import { Hono } from "hono";
import { configValue, db } from "../../db.ts";
import { ventureForHost } from "../../shared/host.ts";
import { PLUGIN, parseHandles, parseSeeds, profileUrl } from "./tiktok.ts";
import { clockAt } from "./store.ts";
import {
  tiktokDaysSince,
  tiktokDiscoverSince,
  tiktokProfiles,
  tiktokSearchesSince,
  tiktokVentureLinks,
  tiktokVideos,
} from "./tiktok-store.ts";

export const tiktokRoutes = new Hono();

const DEFAULT_DAYS = 90;
const MAX_DAYS = 400;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** How far back the trend reads look when deciding what is new. */
const TREND_DAYS = 30;

tiktokRoutes.get("/", (c) => {
  const days = clamp(Number(c.req.query("days") ?? DEFAULT_DAYS) || DEFAULT_DAYS, 1, MAX_DAYS);
  const configured = parseHandles(configValue(PLUGIN, "handles"));
  const seeds = parseSeeds(configValue(PLUGIN, "searches"));
  const profiles = tiktokProfiles();
  const dayRows = tiktokDaysSince(days);
  const videoRows = tiktokVideos(400);
  const links = tiktokVentureLinks();
  const ventures = db.prepare("SELECT id, host, website FROM ventures").all() as unknown as {
    id: string;
    host: string | null;
    website: string | null;
  }[];

  const handles = configured.map((handle) => {
    const p = profiles.find((x) => x.handle === handle);
    const linked = links.get(handle) ?? null;
    const byBio = linked ? null : (ventureForHost(p?.bio_host, ventures)?.id ?? null);
    return {
      handle,
      entity: handle,
      url: profileUrl(handle),
      nickname: p?.nickname ?? null,
      avatar: p?.avatar ?? null,
      bioHost: p?.bio_host ?? null,
      ventureId: linked ?? byBio,
      ventureVia: linked ? ("link" as const) : byBio ? ("bio" as const) : null,
      profile: {
        followers: p?.followers ?? null,
        following: p?.following ?? null,
        likes: p?.likes ?? null,
        videos: p?.videos ?? null,
        seenAt: p?.seen_at ?? null,
      },
      days: dayRows
        .filter((d) => d.handle === handle)
        .map((d) => ({
          day: d.day,
          followers: d.followers,
          likes: d.likes,
          videos: d.videos,
          views: d.views,
          viewsComplete: d.views_complete === 1,
          videosRead: d.videos_read,
        })),
      videos: videoRows
        .filter((v) => v.handle === handle)
        .map((v) => ({
          id: v.video_id,
          url: v.url,
          cover: v.cover,
          caption: v.caption,
          createdAt: v.created_at,
          duration: v.duration,
          isPhoto: v.is_photo === 1,
          pinned: v.pinned === 1,
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          shares: v.shares,
          saves: v.saves,
          seenAt: v.seen_at,
        })),
      lastOkAt: p?.last_ok_at ?? null,
      lastError: p?.last_error ?? null,
      lastReadAt: clockAt(PLUGIN, handle),
    };
  });

  /* SEARCHES: each seed's newest list, with how long each term has been on
     it. `firstSeen` inside the trend window is what "new" means on a card. */
  const searchRows = tiktokSearchesSince(TREND_DAYS);
  const searches = seeds.map((seed) => {
    const own = searchRows.filter((r) => r.seed === seed);
    const latestDay = own.map((r) => r.day).sort().at(-1) ?? null;
    const history = new Map<string, string[]>();
    for (const r of own) history.set(r.term, [...(history.get(r.term) ?? []), r.day]);
    const reads = new Set(own.map((r) => r.day)).size;
    return {
      seed,
      day: latestDay,
      reads,
      lastReadAt: clockAt(PLUGIN, `search:${seed}`),
      terms: own
        .filter((r) => r.day === latestDay)
        .map((r) => {
          const seen = (history.get(r.term) ?? []).sort();
          return {
            term: r.term,
            score: r.score,
            rank: r.rank,
            hits: r.hits,
            firstSeen: seen[0] ?? r.day,
            daysSeen: seen.length,
          };
        }),
    };
  });

  /* DISCOVER: the newest day's page, and when each item first appeared on it. */
  const disc = tiktokDiscoverSince(TREND_DAYS);
  const discDay = disc.map((r) => r.day).sort().at(-1) ?? null;
  const firstOnPage = new Map<string, string>();
  for (const r of disc) {
    const k = `${r.kind}:${r.item_id}`;
    if (!firstOnPage.has(k) || r.day < firstOnPage.get(k)!) firstOnPage.set(k, r.day);
  }
  const latest = disc.filter((r) => r.day === discDay);
  const item = (r: (typeof latest)[number]) => ({
    id: r.item_id,
    rank: r.rank,
    title: r.title,
    subtitle: r.subtitle,
    description: r.description,
    link: r.link,
    cover: r.cover,
    views: r.views,
    followers: r.followers,
    likes: r.likes,
    videos: r.videos,
    verified: r.verified === null ? null : r.verified === 1,
    firstSeen: firstOnPage.get(`${r.kind}:${r.item_id}`) ?? r.day,
  });

  return c.json({
    generatedAt: new Date().toISOString(),
    window: { days },
    handles,
    searches,
    discover: {
      day: discDay,
      region: latest[0]?.region ?? null,
      lastReadAt: clockAt(PLUGIN, "discover"),
      hashtags: latest.filter((r) => r.kind === "hashtag").map(item),
      creators: latest.filter((r) => r.kind === "creator").map(item),
      sounds: latest.filter((r) => r.kind === "sound").map(item),
    },
    notes: {
      views:
        "A video's views are TikTok's running total as of the last read. Views gained on a day " +
        "are the difference between two consecutive days whose reads were both complete.",
      searches:
        "Search suggestions ranked by reciprocal rank over probes of each phrase. Ordinal only — " +
        "TikTok publishes no search volumes.",
      discover:
        "TikTok's Discover page as served to this box's region. Featured hashtags include paid " +
        "TikTok Shop campaigns.",
      auth: "Public pages, unauthenticated. No credential is held and none is needed.",
    },
  });
});

tiktokRoutes.get("/entities", (c) => {
  const profiles = tiktokProfiles();
  return c.json({
    entities: parseHandles(configValue(PLUGIN, "handles")).map((handle) => {
      const p = profiles.find((x) => x.handle === handle);
      return {
        plugin: PLUGIN,
        entity: handle,
        label: p?.nickname && p.nickname !== handle ? `${p.nickname} (@${handle})` : `@${handle}`,
        /* The site the account names in its own bio — its claim, not ours. */
        host: p?.bio_host ?? null,
      };
    }),
  });
});
