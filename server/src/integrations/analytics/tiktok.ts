/**
 * TikTok — PUBLIC profiles, their videos, and what the network says is being
 * searched and featured. No key, no account, no browser.
 *
 * THE POSTING PLUGIN IS A DIFFERENT THING. `providers/tiktok.ts` publishes
 * through the Content Posting API with a pasted token; this file only READS
 * what tiktok.com shows a logged-out visitor, which is why it is its own
 * plugin (`tiktok-public`) with a list of handles instead of a credential —
 * Bluesky's shape, not Meta's.
 *
 * PORTED FROM THE TIKTOK AGENT PROJECT, AND SLIMMED. That project reads a
 * profile with Playwright and the post catalogue with yt-dlp. Neither is on
 * this box and neither is needed: every figure it takes from them is in two
 * plain HTTP answers, probed from a laptop and from a home server on
 * 2026-09-29:
 *
 *   GET www.tiktok.com/@<handle>
 *     The server-rendered page carries `__UNIVERSAL_DATA_FOR_REHYDRATION__`,
 *     whose `webapp.user-detail` holds the account's id, secUid, bio and
 *     `statsV2` — followers, following, total likes and video count as exact
 *     strings (`stats` rounds large ones, so V2 wins).
 *
 *   GET www.tiktok.com/api/creator/item_list/?secUid=…&type=1&count=15&cursor=<ms>
 *     The profile grid's own endpoint. Unsigned, cookie-free. It returns the
 *     account's videos OLDER THAN `cursor` with their play, like, comment,
 *     share and save counts. It never says `hasMore`, so paging is by the
 *     oldest createTime seen; count above 15 is refused (statusCode 10201),
 *     and the exact parameter set below is the one that was answered — a
 *     trimmed list was refused too.
 *
 * AND THE TWO TREND SOURCES, both what TikTok Agent itself uses or could:
 *
 *   GET www.tiktok.com/api/search/general/preview/?keyword=<phrase>
 *     TikTok's search box suggestions. TikTok Agent's search-demand collector
 *     probes a seed with modifiers and letters and ranks what comes back by
 *     reciprocal rank; the same arithmetic is here. THESE ARE NOT VOLUMES.
 *     TikTok publishes no search counts anywhere — a score says "surfaced
 *     often and high", nothing more, and no card calls it a number of searches.
 *
 *   GET www.tiktok.com/node/share/discover
 *     The Discover page: suggested creators with follower counts and featured
 *     hashtags with view counts, for the REGION THE REQUEST CAME FROM (a server
 *     is answered as its own country). The sounds section comes back empty.
 *
 * WHAT DOES NOT WORK FROM A SERVER, so nobody wires it later expecting data:
 * Creative Center's trend lists (`ads.tiktok.com/creative_radar_api/...`)
 * answer `40101 no permission` without a signed-in session, and the page now
 * redirects into "TikTok One"; `/api/post/item_list` and `/api/explore/*` want
 * a signed request and answer empty.
 *
 * NO SLA. Every one of these is unofficial. Each reader below turns an odd
 * answer into an error with a reason rather than into zeroes: a figure that
 * could not be read is absent, never 0.
 */

export const PLUGIN = "tiktok-public";

const WEB = "https://www.tiktok.com";
const TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Fifteen is the most the grid endpoint will return in one answer. */
const PAGE_SIZE = 15;
/** Seven pages is 105 videos — the whole catalogue of both accounts this was
 *  written for, with room. A bigger account is read to its newest 105, and
 *  the collector records that the read was not complete. */
export const MAX_PAGES = 7;

/* ----------------------------------------------------------------- names */

/** A TikTok username: letters, digits, `_` and `.`, 2–24 long. */
export function validHandle(handle: string): boolean {
  return /^[a-z0-9._]{2,24}$/.test(handle) && !handle.endsWith(".");
}

/** Handles out of what the owner typed — `@name`, a profile URL, or a bare
 *  name — lower-cased and de-duplicated. Anything else is dropped here rather
 *  than becoming a failure on every run. */
export function parseHandles(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const handle = part
      .trim()
      .replace(/^(?:https?:\/\/)?(?:www\.)?tiktok\.com\//i, "")
      .replace(/^@/, "")
      .replace(/[/?#].*$/, "")
      .toLowerCase();
    if (handle && validHandle(handle) && !out.includes(handle)) out.push(handle);
  }
  return out;
}

/** Search seeds: phrases, one per line or comma, lower-cased, at most ten. */
export function parseSeeds(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\n,]+/)) {
    const seed = part.trim().toLowerCase().replace(/\s+/g, " ");
    if (seed && seed.length <= 60 && !out.includes(seed)) out.push(seed);
  }
  return out.slice(0, 10);
}

export const profileUrl = (handle: string) => `${WEB}/@${handle}`;
export const videoUrl = (handle: string, id: string, photo = false) =>
  `${WEB}/@${handle}/${photo ? "photo" : "video"}/${id}`;

/* ------------------------------------------------------------------ http */

type Fetched = { status: number; text: string; cookies: string };

async function get(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        ...headers,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new Error(
      name === "TimeoutError"
        ? "TikTok did not answer within 20 seconds"
        : `could not reach TikTok (${name})`,
    );
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`TikTok answered HTTP ${res.status}`);
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { status: res.status, text, cookies };
}

/** A count out of TikTok's JSON: a number, or a numeric string (statsV2).
 *  Anything else is null — not measured, never zero. */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/* --------------------------------------------------------------- profile */

export type Profile = {
  handle: string;
  userId: string | null;
  secUid: string | null;
  nickname: string | null;
  avatar: string | null;
  bio: string | null;
  /** The website the account names in its bio, as a hostname — the account's
   *  own claim, and the only thing a venture suggestion may be made from. */
  bioHost: string | null;
  followers: number | null;
  following: number | null;
  likes: number | null;
  videos: number | null;
};

/** The first domain-looking word in a bio ("More: ExampleApp.com"), or null. */
export function bioHost(bio: string | null | undefined): string | null {
  const m = /\b((?:[a-z0-9-]+\.)+(?:com|co|io|app|ai|dev|net|org|so|ie|me|fyi|uk))\b/i.exec(bio ?? "");
  return m ? m[1]!.toLowerCase().replace(/^www\./, "") : null;
}

/**
 * The profile out of the page's rehydration JSON.
 *
 * `statusCode` 10221 is what an unknown handle answers — a 200 page with no
 * user — and it is reported as that, because it is the one failure here the
 * owner can fix.
 */
export function parseProfileHtml(html: string, handle: string): Profile {
  const m = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("TikTok's page carried no profile data (blocked or changed)");
  let scope: Record<string, unknown>;
  try {
    scope = (JSON.parse(m[1]!) as { __DEFAULT_SCOPE__?: Record<string, unknown> }).__DEFAULT_SCOPE__ ?? {};
  } catch {
    throw new Error("TikTok's profile data was not readable JSON");
  }
  const detail = scope["webapp.user-detail"] as
    | {
        statusCode?: number;
        userInfo?: {
          user?: {
            id?: string;
            uniqueId?: string;
            secUid?: string;
            nickname?: string;
            avatarMedium?: string;
            avatarThumb?: string;
            signature?: string;
            bioLink?: { link?: string };
          };
          stats?: Record<string, unknown>;
          statsV2?: Record<string, unknown>;
        };
      }
    | undefined;
  const user = detail?.userInfo?.user;
  if (!user?.secUid) {
    if (detail?.statusCode === 10221 || detail?.statusCode === 10202)
      throw new Error("no TikTok account has that handle");
    throw new Error(`TikTok returned no user (status ${detail?.statusCode ?? "unknown"})`);
  }
  const v2 = detail?.userInfo?.statsV2 ?? {};
  const v1 = detail?.userInfo?.stats ?? {};
  const pick = (k: string) => num(v2[k]) ?? num(v1[k]);
  const bio = user.signature?.trim() || null;
  return {
    handle: (user.uniqueId ?? handle).toLowerCase(),
    userId: user.id ?? null,
    secUid: user.secUid,
    nickname: user.nickname ?? null,
    avatar: user.avatarMedium ?? user.avatarThumb ?? null,
    bio,
    bioHost: bioHost(user.bioLink?.link) ?? bioHost(bio),
    followers: pick("followerCount"),
    following: pick("followingCount"),
    likes: pick("heartCount") ?? pick("heart"),
    videos: pick("videoCount"),
  };
}

export async function profile(handle: string): Promise<{ profile: Profile; cookies: string }> {
  const res = await get(profileUrl(handle));
  return { profile: parseProfileHtml(res.text, handle), cookies: res.cookies };
}

/* ---------------------------------------------------------------- videos */

export type Video = {
  id: string;
  createdAt: string | null;
  caption: string | null;
  cover: string | null;
  url: string;
  duration: number | null;
  isPhoto: boolean;
  pinned: boolean;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
};

type RawItem = {
  id?: string;
  createTime?: number;
  desc?: string;
  isPinnedItem?: boolean;
  imagePost?: { cover?: { imageURL?: { urlList?: string[] } } };
  video?: { cover?: string; originCover?: string; duration?: number };
  stats?: Record<string, unknown>;
  statsV2?: Record<string, unknown>;
};

/** One page of the grid endpoint as videos. Items without an id are dropped. */
export function parseItemList(doc: unknown, handle: string): Video[] {
  const items = (doc as { itemList?: RawItem[] } | null)?.itemList ?? [];
  const out: Video[] = [];
  for (const it of items) {
    if (!it?.id) continue;
    const s2 = it.stats ?? {};
    const v2 = it.statsV2 ?? {};
    const pick = (k: string) => num(v2[k]) ?? num(s2[k]);
    const photo = !!it.imagePost;
    out.push({
      id: String(it.id),
      createdAt: typeof it.createTime === "number" ? new Date(it.createTime * 1000).toISOString() : null,
      caption: it.desc?.trim() || null,
      cover:
        it.video?.cover ||
        it.video?.originCover ||
        it.imagePost?.cover?.imageURL?.urlList?.[0] ||
        null,
      url: videoUrl(handle, String(it.id), photo),
      /* A photo post reports a duration of 0, which is not a length. */
      duration: photo ? null : num(it.video?.duration) || null,
      isPhoto: photo,
      pinned: !!it.isPinnedItem,
      views: pick("playCount"),
      likes: pick("diggCount"),
      comments: pick("commentCount"),
      shares: pick("shareCount"),
      saves: pick("collectCount"),
    });
  }
  return out;
}

function itemListUrl(secUid: string, cursor: number): string {
  /* THE EXACT SET THE ENDPOINT ANSWERED. Dropping the "browser" fields got
     statusCode 10201 back on 2026-09-29, so they stay even though none of
     them is true of this box. */
  const q = [
    "aid=1988",
    "app_language=en",
    "app_name=tiktok_web",
    "browser_language=en-US",
    "browser_name=Mozilla",
    "browser_online=true",
    "browser_platform=MacIntel",
    "channel=tiktok_web",
    "cookie_enabled=true",
    `count=${PAGE_SIZE}`,
    `cursor=${cursor}`,
    "device_platform=web_pc",
    "focus_state=true",
    "from_page=user",
    "history_len=2",
    "is_fullscreen=false",
    "is_page_visible=true",
    "language=en",
    "os=mac",
    "priority_region=",
    "referer=",
    "region=US",
    "screen_height=1080",
    "screen_width=1920",
    `secUid=${encodeURIComponent(secUid)}`,
    "type=1",
    "tz_name=UTC",
    "verifyFp=verify_",
    "webcast_language=en",
  ].join("&");
  return `${WEB}/api/creator/item_list/?${q}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The account's videos, newest first, paged by the oldest one seen.
 *
 * `complete` is true only when a page came back short (or empty) — the end of
 * the catalogue. A read that stopped at MAX_PAGES, or on an error after the
 * first page, is NOT complete: its view total is a floor and the collector
 * must not delete videos it simply did not reach.
 */
export async function videos(
  handle: string,
  secUid: string,
  cookies: string,
  gapMs = 400,
): Promise<{ videos: Video[]; complete: boolean }> {
  const seen = new Map<string, Video>();
  let cursor = Date.now();
  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Fetched;
    try {
      res = await get(itemListUrl(secUid, cursor), {
        Referer: profileUrl(handle),
        ...(cookies ? { Cookie: cookies } : {}),
      });
    } catch (err) {
      if (page === 0) throw err;
      return { videos: [...seen.values()], complete: false };
    }
    if (!res.text.trim()) {
      if (page === 0) throw new Error("TikTok's video list came back empty (blocked or changed)");
      return { videos: [...seen.values()], complete: false };
    }
    let doc: { statusCode?: number; itemList?: unknown[] };
    try {
      doc = JSON.parse(res.text) as typeof doc;
    } catch {
      throw new Error("TikTok's video list was not JSON");
    }
    if (doc.statusCode && doc.statusCode !== 0) {
      if (page === 0) throw new Error(`TikTok refused the video list (status ${doc.statusCode})`);
      return { videos: [...seen.values()], complete: false };
    }
    const batch = parseItemList(doc, handle);
    for (const v of batch) seen.set(v.id, v);
    if (batch.length < PAGE_SIZE) return { videos: [...seen.values()], complete: true };
    /* PINNED VIDEOS SIT AT THE TOP OF PAGE ONE WHATEVER THEIR AGE, so the
       cursor is the oldest UNPINNED video's time. Pages overlap by a video at
       the boundary; the map above is what de-duplicates them. */
    const times = batch
      .filter((v) => !v.pinned && v.createdAt)
      .map((v) => Date.parse(v.createdAt!));
    if (!times.length) return { videos: [...seen.values()], complete: false };
    const next = Math.min(...times);
    if (next >= cursor) return { videos: [...seen.values()], complete: false };
    cursor = next;
    await sleep(gapMs);
  }
  return { videos: [...seen.values()], complete: false };
}

/* ------------------------------------------------------ search suggestions */

/** The modifiers probed after each seed. TikTok Agent's list is for shops
 *  ("haul", "cheap"); these are for software products. */
export const MODIFIERS = [" app", " free", " ai", " how to", " tutorial", " alternative", " review", " hack"];
export const LETTERS = "abc";
/** A term surfaced by fewer distinct probes than this is an echo, not demand. */
export const MIN_HITS = 2;

export function buildProbes(seed: string): string[] {
  const probes = [seed, ...MODIFIERS.map((m) => `${seed}${m}`), ...[...LETTERS].map((l) => `${seed} ${l}`)];
  return [...new Set(probes)];
}

export function parseSuggestions(text: string): string[] {
  try {
    const doc = JSON.parse(text) as { sug_list?: { content?: string }[] };
    return (doc.sug_list ?? [])
      .map((s) => String(s?.content ?? "").trim().toLowerCase().replace(/\s+/g, " "))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export type Term = { term: string; score: number; hits: number; rank: number };

/**
 * TikTok Agent's ranking, kept: a term at position i of a probe's list scores
 * 1/(i+1), summed over probes; `hits` counts distinct probes. A term's score
 * from the probe that IS the term is left out (asking for a string verbatim
 * must not inflate it), and a term only one probe surfaced is dropped.
 */
export function rankTerms(results: { probe: string; terms: string[] }[]): Term[] {
  const agg = new Map<string, { score: number; probes: Set<string> }>();
  for (const { probe, terms } of results)
    terms.forEach((term, i) => {
      const row = agg.get(term) ?? { score: 0, probes: new Set<string>() };
      row.probes.add(probe);
      if (term !== probe) row.score += 1 / (i + 1);
      agg.set(term, row);
    });
  return [...agg.entries()]
    .filter(([term, r]) => r.probes.size >= MIN_HITS && !(r.probes.size === 1 && r.probes.has(term)))
    .map(([term, r]) => ({ term, score: Math.round(r.score * 1000) / 1000, hits: r.probes.size }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || b.hits - a.hits || a.term.localeCompare(b.term))
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

/** Probe one seed. Probes that fail are skipped; none answering is an error. */
export async function searchTerms(seed: string, gapMs = 400): Promise<Term[]> {
  const results: { probe: string; terms: string[] }[] = [];
  let answered = 0;
  for (const probe of buildProbes(seed)) {
    try {
      const res = await get(`${WEB}/api/search/general/preview/?keyword=${encodeURIComponent(probe)}`, {
        Referer: `${WEB}/`,
      });
      answered++;
      results.push({ probe, terms: parseSuggestions(res.text) });
    } catch {
      /* one probe failing is one fewer vote, not a failed seed */
    }
    await sleep(gapMs);
  }
  if (!answered) throw new Error("TikTok's search suggestions did not answer");
  return rankTerms(results);
}

/* -------------------------------------------------------------- discover */

export type DiscoverItem = {
  kind: "creator" | "hashtag" | "sound";
  id: string;
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
  verified: boolean | null;
};

const KIND: Record<number, DiscoverItem["kind"]> = { 1: "sound", 2: "creator", 3: "hashtag" };

export function parseDiscover(doc: unknown): { region: string | null; items: DiscoverItem[] } {
  const body = (doc as { body?: { exploreList?: { cardItem?: Record<string, unknown> }[]; pageState?: { region?: string } }[] } | null)?.body;
  if (!Array.isArray(body)) throw new Error("TikTok's discover page had no sections");
  const items: DiscoverItem[] = [];
  let region: string | null = null;
  for (const section of body) {
    region ??= section.pageState?.region ?? null;
    let rank = 0;
    for (const entry of section.exploreList ?? []) {
      const c = entry.cardItem ?? {};
      const kind = KIND[Number(c.type)];
      if (!kind || !c.id) continue;
      const x = (c.extraInfo ?? {}) as Record<string, unknown>;
      const link = typeof c.link === "string" ? (c.link.startsWith("/") ? `${WEB}${c.link}` : c.link) : null;
      items.push({
        kind,
        id: String(c.id),
        rank: ++rank,
        title: typeof c.title === "string" ? c.title.trim() : null,
        subtitle: typeof c.subTitle === "string" ? c.subTitle : null,
        description: typeof c.description === "string" ? c.description.trim() || null : null,
        link,
        cover: typeof c.cover === "string" ? c.cover : null,
        views: num(x.views),
        followers: num(x.fans),
        likes: num(x.likes) ?? num(x.heart),
        videos: num(x.video),
        verified: typeof x.verified === "boolean" ? x.verified : null,
      });
    }
  }
  return { region, items };
}

export async function discover(): Promise<{ region: string | null; items: DiscoverItem[] }> {
  const res = await get(`${WEB}/node/share/discover`, { Referer: `${WEB}/` });
  let doc: unknown;
  try {
    doc = JSON.parse(res.text);
  } catch {
    throw new Error("TikTok's discover page was not JSON");
  }
  return parseDiscover(doc);
}
