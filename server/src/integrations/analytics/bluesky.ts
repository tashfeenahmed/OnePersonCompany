/**
 * Bluesky — the public AppView, no key, no account.
 *
 * `public.api.bsky.app` answers `app.bsky.actor.getProfile` and
 * `app.bsky.feed.getAuthorFeed` to anybody, unauthenticated, for any handle on
 * the network. So there is nothing to seal in the vault and nothing to verify
 * before storing: what this needs is a LIST of handles, which is configuration
 * for the reason the npm package list is — public by design, readable back,
 * corrected by the owner rather than discovered by the code.
 *
 * IT WATCHES ANY HANDLE, NOT ONLY THE OWNER'S, and that is a property rather
 * than an oversight: the endpoint has no notion of "mine". The list is
 * therefore exactly what the owner typed, and every figure below is captioned
 * with the handle it belongs to.
 *
 * THE FEED IS READ ONE PAGE DEEP AND THAT IS THE WHOLE HONESTY PROBLEM HERE.
 * Fifty posts is one request. For a quiet account that covers a year; for an
 * account posting five times a day it covers ten. When the oldest post on the
 * page is NEWER than a window's start, the window did not fit and every figure
 * for it is a FLOOR — `truncated` rides with the row, the route refuses to
 * hide it, and the skill's rules say a floor is never quoted as a total. A
 * busy month reported as a quiet one is the exact failure this dashboard
 * refuses everywhere else.
 *
 * REPOSTS BY THE HANDLE ARE NOT ITS POSTS. The author feed carries them with a
 * `reason` of `#reasonRepost`; the post underneath is somebody else's and its
 * likes are somebody else's likes. They are excluded from every count and
 * counted separately as `reposted`, so "you shared 12 things" is still
 * answerable without it inflating "your posts got 400 likes".
 *
 * ENGAGEMENT COUNTS ARE AS OF NOW, NOT AS OF THE POST. A like arriving today
 * on a post from three weeks ago is in this week's read of that post and in
 * next week's too. That makes the window's engagement a CURRENT TOTAL over
 * posts made in the window, which is what it is called everywhere downstream,
 * and never "engagement earned this week".
 *
 * WHAT IT READS, and nothing else:
 *   GET public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=
 *   GET public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=&limit=50
 */

const API = "https://public.api.bsky.app/xrpc";
const TIMEOUT_MS = 20_000;
const USER_AGENT = "onepersoncompany-collector/1.0";

/** One page. See the header: this cap is the reason `truncated` exists. */
export const FEED_LIMIT = 50;

/** The two windows every handle is reported over. */
export const WINDOWS = [7, 30] as const;

export type Profile = {
  handle: string;
  did: string | null;
  displayName: string | null;
  followers: number | null;
  follows: number | null;
  posts: number | null;
  avatar: string | null;
};

export type FeedPost = {
  uri: string;
  createdAt: string | null;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  isReply: boolean;
  /** A repost BY this handle of somebody else's post. Excluded from every
   *  engagement figure — see the header. */
  isRepostByAuthor: boolean;
  /**
   * WHAT WAS ACTUALLY WRITTEN, and where it can be read.
   *
   * The three fields below carry no arithmetic and are here for one reason:
   * a board that quotes "seven likes" without the words that earned them is
   * a board nobody can act on. `text` is the record's own, whole; `image` is
   * the CDN thumbnail of the first picture in the embed, a URL and never a
   * download; `url` is the https address a person can open, derived from the
   * at:// uri rather than fetched — see `postUrl`.
   */
  text: string | null;
  image: string | null;
  url: string | null;
};

/**
 * The web address of a post, from its at:// uri.
 *
 * DERIVED, NEVER FETCHED. An at:// uri is `at://<did>/app.bsky.feed.post/<rkey>`
 * and bsky.app addresses the same post as `/profile/<handle-or-did>/post/<rkey>`,
 * so the record key is the whole join and no second request is needed to get a
 * link. The handle is preferred over the did because it is what a person
 * recognises; a renamed handle breaks the link, which is a broken link rather
 * than a wrong post.
 */
export function postUrl(handle: string, uri: string): string | null {
  const rkey = /\/app\.bsky\.feed\.post\/([^/]+)$/.exec(uri)?.[1];
  return rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
}

export type WindowTotals = {
  days: number;
  posts: number;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  /** The page did not reach back to this window's start. Every figure above
   *  is a floor. */
  truncated: boolean;
  oldestSeen: string | null;
};

/* ----------------------------------------------------------------- names */

/**
 * A Bluesky handle is a DOMAIN — `alice.bsky.social`, `bsky.app`, a vanity
 * domain somebody verified. A leading `@` is what a person types and is
 * stripped; anything that is not a hostname is dropped here rather than
 * becoming a 400 on every run.
 */
export function validHandle(handle: string): boolean {
  return (
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      handle,
    ) && handle.length <= 253
  );
}

export function parseHandles(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const handle = part.trim().replace(/^@/, "").toLowerCase();
    if (handle && validHandle(handle) && !out.includes(handle)) out.push(handle);
  }
  return out;
}

/* ------------------------------------------------------------------ http */

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/${path}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new Error(
      name === "TimeoutError"
        ? "Bluesky did not answer within 20 seconds"
        : `could not reach Bluesky (${name})`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let reason = text.slice(0, 200);
    try {
      const doc = JSON.parse(text) as { error?: string; message?: string };
      /* `InvalidRequest` with "Profile not found" is what a mistyped handle
         looks like, and it is worth saying as that rather than as an HTTP
         code — it is the one failure here the owner can actually fix. */
      if (doc.error === "InvalidRequest" && /not found/i.test(doc.message ?? ""))
        reason = "no account on Bluesky has that handle";
      else reason = doc.message ?? doc.error ?? reason;
    } catch {
      /* not JSON; the body is all there is */
    }
    throw new Error(`Bluesky answered HTTP ${res.status}: ${reason}`);
  }
  return JSON.parse(text) as T;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/* --------------------------------------------------------------- readers */

export async function profile(handle: string): Promise<Profile> {
  const doc = await get<{
    did?: string;
    handle?: string;
    displayName?: string;
    avatar?: string;
    followersCount?: number;
    followsCount?: number;
    postsCount?: number;
  }>(`app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`);
  return {
    /* Bluesky's own spelling of the handle wins: an owner who typed a handle
       that has since been renamed gets told what it is now, rather than two
       rows for one account. */
    handle: (doc.handle ?? handle).toLowerCase(),
    did: doc.did ?? null,
    displayName: doc.displayName ?? null,
    followers: num(doc.followersCount),
    follows: num(doc.followsCount),
    posts: num(doc.postsCount),
    avatar: doc.avatar ?? null,
  };
}

export async function authorFeed(handle: string): Promise<FeedPost[]> {
  const doc = await get<{
    feed?: {
      post?: {
        uri?: string;
        author?: { did?: string; handle?: string };
        record?: { createdAt?: string; reply?: unknown; text?: string };
        /* The embed as the AppView already resolved it. Only the thumbnail is
           read: `images[].thumb` is a CDN url that renders at card size, and
           an external link card's `thumb` is the same thing for a link post. */
        embed?: {
          images?: { thumb?: string }[];
          external?: { thumb?: string };
          media?: { images?: { thumb?: string }[] };
        };
        likeCount?: number;
        repostCount?: number;
        replyCount?: number;
        quoteCount?: number;
        indexedAt?: string;
      };
      reason?: { $type?: string };
      reply?: unknown;
    }[];
  }>(
    `app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}` +
      `&limit=${FEED_LIMIT}&filter=posts_with_replies`,
  );

  const out: FeedPost[] = [];
  for (const item of doc.feed ?? []) {
    const post = item.post;
    if (!post?.uri) continue;
    const repost = typeof item.reason?.$type === "string" && /reasonRepost/.test(item.reason.$type);
    out.push({
      uri: post.uri,
      /* The record's own createdAt is the author's claim and `indexedAt` is
         the network's. The author's is used because it is what "posted on"
         means to the person who posted it; a post whose record has no date
         falls back to the index, and a post with neither is outside every
         window rather than inside all of them. */
      createdAt: post.record?.createdAt ?? post.indexedAt ?? null,
      likes: num(post.likeCount) ?? 0,
      reposts: num(post.repostCount) ?? 0,
      replies: num(post.replyCount) ?? 0,
      quotes: num(post.quoteCount) ?? 0,
      isReply: !!post.record?.reply,
      isRepostByAuthor: repost,
      text: post.record?.text?.trim() || null,
      image:
        post.embed?.images?.[0]?.thumb ??
        post.embed?.media?.images?.[0]?.thumb ??
        post.embed?.external?.thumb ??
        null,
      url: postUrl(post.author?.handle ?? handle, post.uri),
    });
  }
  return out;
}

/* --------------------------------------------------------------- windows */

/**
 * The totals over one window, and whether the page reached back far enough.
 *
 * `truncated` is true when the feed came back FULL and its oldest own post is
 * newer than the window's start: a full page means there is more behind it,
 * and an oldest post inside the window means the window extends past what was
 * read. A short page reached the end of the account's history and is complete
 * however old its oldest post is.
 */
export function windowTotals(
  posts: FeedPost[],
  days: number,
  now = new Date(),
): WindowTotals {
  const since = now.getTime() - days * 86_400_000;
  const own = posts.filter((p) => !p.isRepostByAuthor);
  const dated = own.filter((p) => p.createdAt && Date.parse(p.createdAt) >= since);

  const oldest = own
    .map((p) => p.createdAt)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;

  const full = posts.length >= FEED_LIMIT;
  const truncated = full && !!oldest && Date.parse(oldest) > since;

  return {
    days,
    posts: dated.length,
    likes: dated.reduce((n, p) => n + p.likes, 0),
    reposts: dated.reduce((n, p) => n + p.reposts, 0),
    replies: dated.reduce((n, p) => n + p.replies, 0),
    quotes: dated.reduce((n, p) => n + p.quotes, 0),
    truncated,
    oldestSeen: oldest,
  };
}
