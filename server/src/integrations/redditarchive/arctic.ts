/**
 * ARCTIC SHIFT — how an agent on this box reads Reddit.
 *
 * WHY NOT REDDIT ITSELF. Measured from demand runs on the Dell, 20–22 Sep 2026:
 * `web_extract` on a www.reddit.com thread times out, the browser tool lands on
 * a CAPTCHA, old.reddit answers a "network security" block page and every
 * `*.json` endpoint answers 403 (see providers/demand.ts for the history). The
 * run then writes a demand report out of search-result titles, which is the one
 * thing a demand report must not be. The Atom search feed the collector uses is
 * still open, but it carries a title, a link and a date — no body, no comments,
 * no score — so it cannot answer "what did people actually say in that thread".
 *
 * Arctic Shift (https://arctic-shift.photon-reddit.com, the maintained
 * Pushshift successor) archives every post and comment as it is posted and
 * re-reads it about a day and a half later, so it serves bodies, comment trees,
 * dates and scores with no account. It is already the collector's score source
 * (`arcticEnrich` in providers/demand.ts, by id only). This module is the
 * search-and-read half, behind `/api/reddit` and the `reddit` skill.
 *
 * WHAT WAS MEASURED ON 22 SEP 2026, and what the code does about each:
 *
 *   - keyword post search (`query`/`title`/`selftext` with `subreddit`)
 *     answered 422 "Timeout. Maybe slow down a bit" in 0.3–5 s for every
 *     subreddit tried, while a plain date-window listing of the same subreddit
 *     answered 100 posts in ~1 s. So a keyword search that the archive refuses
 *     falls back to SCANNING the listing and matching locally, and the answer
 *     says which of the two produced it and how much of the window was read.
 *   - comment full-text search (`body` with `subreddit`) answered 200 in 1–3 s.
 *   - both searches REQUIRE a subreddit or an author; a sitewide keyword search
 *     is refused 400. That is surfaced as a plain error naming the fix.
 *   - `permalink` and `_meta` are not selectable fields; permalinks are built
 *     from subreddit + id, which is how Reddit builds them.
 *
 * THE SCORE IS A PLACEHOLDER FOR ABOUT 36 HOURS. The archive files a post at
 * the moment it appears (score 1, comments 0) and re-reads it later. Inside
 * that window a row's score is published as null with `scoreSettled: false`,
 * never as the placeholder — the collector's rule, for the collector's reason.
 *
 * BEING A GOOD CITIZEN OF A FREE SERVICE. Requests are serialised with a
 * minimum gap, a 429 blocks further requests until the archive's own
 * `X-RateLimit-Reset`, and answers are cached in memory for a quarter of an
 * hour (an agent re-reading the same thread twice in one run is the common
 * case). Every failure is a typed error with a sentence an agent can act on;
 * nothing here returns an empty list for a request that was not answered.
 *
 * UNTRUSTED TEXT. Every title, body and comment is a stranger's words. They
 * are returned as text for an agent to quote, and the skill's rules say they
 * are evidence and never instructions.
 */

export const ARCTIC_BASE = "https://arctic-shift.photon-reddit.com/api";
const USER_AGENT = "onepersoncompany/1.0 (+https://github.com/tashfeenahmed/OnePersonCompany)";

/** Per request. Their keyword search has been seen to take 8 s when it works. */
export const TIMEOUT_MS = 20_000;
/** Between two requests from this process. "A couple of requests per second"
 *  is the archive's own line for a normal user; one a second is under it. */
let minGapMs = 1_000;
/** A 429 asking for a longer wait than this is reported rather than waited
 *  out — an agent's command has a 60 s clock of its own. */
const MAX_WAIT_MS = 20_000;
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 300;
/** Inside this many days the archive's score is still its placeholder. */
export const SETTLE_DAYS = 1.5;

export type ArcticErrorKind = "rate-limited" | "timeout" | "refused" | "unreachable" | "not-found";

export class ArcticError extends Error {
  kind: ArcticErrorKind;
  status: number;
  /** Seconds until the archive will answer again, when it said. */
  retryAfter: number | null;
  constructor(kind: ArcticErrorKind, message: string, status = 502, retryAfter: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/* ------------------------------------------------------------ the wire */

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);

/** Tests swap the network out, and the gap with it. */
export function setTransportForTests(f: Fetcher | null, gapMs = 0): void {
  fetcher = f ?? ((url, init) => fetch(url, init));
  minGapMs = f ? gapMs : 1_000;
  cache.clear();
  lastAt = 0;
  blockedUntil = 0;
  indexDownUntil = 0;
}

const cache = new Map<string, { at: number; data: unknown }>();
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
let blockedUntil = 0;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One GET, serialised behind every other one, cached on its URL. */
export async function arcticGet(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const url = `${ARCTIC_BASE}${path}?${q.toString()}`;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const run = chain.then(() => once(url));
  /* The chain must survive a failure, or one refused request would refuse
     every request after it. */
  chain = run.catch(() => undefined);
  const data = await run;
  cache.set(url, { at: Date.now(), data });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return data;
}

async function once(url: string): Promise<unknown> {
  const wait = Math.max(lastAt + minGapMs, blockedUntil) - Date.now();
  if (blockedUntil - Date.now() > MAX_WAIT_MS)
    throw new ArcticError(
      "rate-limited",
      `The Reddit archive (Arctic Shift) asked this box to wait ${Math.ceil((blockedUntil - Date.now()) / 1000)} s. Try again after that; do not hammer it.`,
      429,
      Math.ceil((blockedUntil - Date.now()) / 1000),
    );
  if (wait > 0) await pause(wait);

  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    lastAt = Date.now();
    const why = err instanceof Error ? err.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : err.message : String(err);
    throw new ArcticError("unreachable", `The Reddit archive (Arctic Shift) could not be reached: ${why}.`, 504);
  }
  lastAt = Date.now();

  const reset = Number(res.headers.get("x-ratelimit-reset"));
  let body: { data?: unknown; error?: unknown } | null = null;
  try {
    body = (await res.json()) as { data?: unknown; error?: unknown };
  } catch {
    body = null;
  }
  const said = body && typeof body.error === "string" ? body.error : null;

  if (res.status === 429) {
    const secs = Number.isFinite(reset) && reset > 0 ? reset : 60;
    blockedUntil = Date.now() + secs * 1000;
    throw new ArcticError("rate-limited", `The Reddit archive (Arctic Shift) rate-limited this box for ${secs} s.`, 429, secs);
  }
  if (res.status === 422 || (said && /time(d)? ?out/i.test(said)))
    throw new ArcticError("timeout", `The Reddit archive timed out on that query${said ? ` ("${said}")` : ""}.`, 504);
  if (res.status !== 200 || !body || said)
    throw new ArcticError(
      res.status === 404 ? "not-found" : "refused",
      `The Reddit archive answered HTTP ${res.status}${said ? `: ${said}` : ""}.`,
      res.status >= 400 && res.status < 500 ? 400 : 502,
    );
  return body.data ?? null;
}

/* ------------------------------------------------------------ references */

const ID = /^[a-z0-9]{3,12}$/i;

/**
 * A thread reference as an agent will paste it: a bare id, `t3_…`, any
 * reddit.com thread URL (www, old, new, np, m, with or without the scheme),
 * a comment permalink, or a redd.it short link. The share links Reddit's app
 * makes (`/r/<sub>/s/<code>`) carry no id and are resolved through the
 * archive's short-link table. Null for anything that is not one of those.
 */
export function parseThreadRef(raw: string): { postId: string; commentId: string | null } | { shortPath: string } | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/^t3_[a-z0-9]{3,12}$/i.test(value)) return { postId: value.slice(3).toLowerCase(), commentId: null };
  if (ID.test(value)) return { postId: value.toLowerCase(), commentId: null };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value.replace(/^\/+/, "")}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "redd.it" || host === "www.redd.it") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return ID.test(id) ? { postId: id.toLowerCase(), commentId: null } : null;
  }
  if (!/(^|\.)reddit\.com$/.test(host)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("comments");
  if (at >= 0) {
    const post = parts[at + 1] ?? "";
    if (!ID.test(post)) return null;
    /* /comments/<post>/<slug>/<comment>/ — or /comments/<post>/_/<comment>/ */
    const comment = parts[at + 3] ?? "";
    return { postId: post.toLowerCase(), commentId: ID.test(comment) ? comment.toLowerCase() : null };
  }
  if (parts[0] === "r" && parts[2] === "s" && parts[3]) return { shortPath: `/r/${parts[1]}/s/${parts[3]}` };
  return null;
}

/** "r/Tutoring", "/r/tutoring/", "tutoring" → "tutoring"; null if it is not a subreddit name. */
export function parseSubreddit(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim().replace(/^\/?r\//i, "").replace(/\/+$/, "");
  return /^[A-Za-z0-9_]{2,32}$/.test(v) ? v : null;
}

/** "u/name" → "name". */
export function parseAuthor(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim().replace(/^\/?u(ser)?\//i, "");
  return /^[A-Za-z0-9_-]{2,40}$/.test(v) ? v : null;
}

/**
 * A date bound as the owner or an agent will write it: `2026-06-01`, an ISO
 * timestamp, or epoch seconds. Returned as epoch seconds so the scan can
 * compare it with `created_utc`.
 */
export function parseDate(raw: string | undefined | null): number | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (/^\d{9,10}$/.test(v)) return Number(v);
  if (/^\d{12,13}$/.test(v)) return Math.floor(Number(v) / 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/* ------------------------------------------------------------ shapes */

export type Post = {
  id: string;
  subreddit: string;
  title: string;
  author: string | null;
  createdAt: string | null;
  /** Null while the archive still holds its placeholder — see SETTLE_DAYS. */
  score: number | null;
  comments: number | null;
  scoreSettled: boolean;
  permalink: string;
  /** The link a link-post points at; null for a text post. */
  link: string | null;
  text: string;
  textTruncated: boolean;
  removed: boolean;
};

export type Comment = {
  id: string;
  parentId: string | null;
  depth: number;
  author: string | null;
  createdAt: string | null;
  score: number | null;
  scoreSettled: boolean;
  permalink: string;
  text: string;
  textTruncated: boolean;
  replies: Comment[];
  /** Replies the archive collapsed or this answer left out. */
  moreReplies: number;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function settled(created: number | null, nowSec: number): boolean {
  return created !== null && nowSec - created > SETTLE_DAYS * 86_400;
}

/** Reddit stores markdown with `&amp;`, `&lt;`, `&gt;` escaped and zero-width
 *  spaces as `&#x200B;`; a quote should read as it was typed. */
export function unescapeReddit(text: string): string {
  return text
    .replace(/&#x200B;|&#8203;/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function clip(text: string, max: number): { text: string; truncated: boolean } {
  const t = unescapeReddit(text).replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (max <= 0) return { text: "", truncated: t.length > 0 };
  if (t.length <= max) return { text: t, truncated: false };
  return { text: `${t.slice(0, max).trimEnd()}…`, truncated: true };
}

const iso = (sec: number | null) => (sec === null ? null : new Date(sec * 1000).toISOString());
const author = (v: unknown) => {
  const a = str(v);
  return a && a !== "[deleted]" ? a : null;
};

export function shapePost(raw: Record<string, unknown>, textChars: number, nowSec = Date.now() / 1000): Post {
  const id = str(raw.id).toLowerCase();
  const sub = str(raw.subreddit);
  const created = num(raw.created_utc);
  const ok = settled(created, nowSec);
  const selftext = str(raw.selftext);
  const removed = selftext === "[removed]" || selftext === "[deleted]" || !!raw.removed_by_category;
  const body = clip(removed ? "" : selftext, textChars);
  const url = str(raw.url);
  const self = !url || /^https?:\/\/(www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(url) || url.startsWith("/r/");
  return {
    id,
    subreddit: sub,
    title: unescapeReddit(str(raw.title)),
    author: author(raw.author),
    createdAt: iso(created),
    score: ok ? num(raw.score) : null,
    comments: ok ? num(raw.num_comments) : null,
    scoreSettled: ok,
    permalink: `https://www.reddit.com/r/${sub}/comments/${id}/`,
    link: self ? null : url,
    text: body.text,
    textTruncated: body.truncated,
    removed,
  };
}

function shapeComment(
  raw: Record<string, unknown>,
  sub: string,
  postId: string,
  depth: number,
  textChars: number,
  nowSec: number,
): Comment {
  const id = str(raw.id).toLowerCase();
  const created = num(raw.created_utc);
  const ok = settled(created, nowSec);
  const bodyRaw = str(raw.body);
  const body = clip(bodyRaw === "[removed]" || bodyRaw === "[deleted]" ? "" : bodyRaw, textChars);
  const parent = str(raw.parent_id);
  return {
    id,
    parentId: parent || null,
    depth,
    author: author(raw.author),
    createdAt: iso(created),
    score: ok ? num(raw.score) : null,
    scoreSettled: ok,
    permalink: `https://www.reddit.com/r/${sub || str(raw.subreddit)}/comments/${postId}/_/${id}/`,
    text: body.text,
    textTruncated: body.truncated,
    replies: [],
    moreReplies: 0,
  };
}

/* ------------------------------------------------------------ search */

/** Quoted phrases, words and `-exclusions` out of a query, lower-cased. */
export function queryTerms(q: string): { need: string[]; not: string[] } {
  const need: string[] = [];
  const not: string[] = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const neg = (m[1] || m[3]) === "-";
    const term = (m[2] ?? m[4] ?? "").toLowerCase().trim();
    if (!term || term === "or" || term === "and") continue;
    (neg ? not : need).push(term);
  }
  return { need, not };
}

export function matches(text: string, terms: { need: string[]; not: string[] }): boolean {
  const t = text.toLowerCase();
  return terms.need.every((w) => t.includes(w)) && !terms.not.some((w) => t.includes(w));
}

const POST_FIELDS = "id,title,selftext,created_utc,score,num_comments,author,subreddit,url,over_18";
const COMMENT_FIELDS = "id,body,created_utc,score,author,subreddit,link_id,parent_id";

/** After the keyword index times out it is not asked again for this long:
 *  every search in between goes straight to the scan instead of spending a
 *  request (and the archive's patience) on a refusal it has just given. */
const INDEX_RETRY_MS = 10 * 60_000;
let indexDownUntil = 0;

export type SearchOptions = {
  subreddit: string | null;
  author: string | null;
  q: string | null;
  after: number;
  before: number | null;
  limit: number;
  sort: "new" | "old" | "top";
  textChars: number;
  /** How many listing pages a fallback scan may read. */
  scanPages?: number;
  /** Wall clock for the whole call; the CLI gives up at 60 s. */
  budgetMs?: number;
};

export type SearchResult = {
  method: "index" | "scan" | "listing";
  posts: Post[];
  /** Scan only: how many posts were read and whether the scan reached the window's start. */
  scanned: number | null;
  scanComplete: boolean | null;
  note: string | null;
};

/**
 * Posts in one subreddit (or by one author) inside a date window, optionally
 * matching a keyword query. See the file header for why a refused keyword
 * search becomes a scan.
 */
export async function searchPosts(o: SearchOptions): Promise<SearchResult> {
  const nowSec = Date.now() / 1000;
  const base = {
    subreddit: o.subreddit ?? undefined,
    author: o.author ?? undefined,
    before: o.before ?? undefined,
    fields: POST_FIELDS,
  };
  const order = (posts: Post[]) =>
    o.sort === "top" ? [...posts].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : posts;

  if (!o.q) {
    const rows = (await arcticGet("/posts/search", {
      ...base,
      after: o.after,
      limit: Math.min(100, o.sort === "top" ? 100 : o.limit),
      sort: o.sort === "old" ? "asc" : "desc",
    })) as Record<string, unknown>[] | null;
    const posts = order((rows ?? []).map((r) => shapePost(r, o.textChars, nowSec))).slice(0, o.limit);
    return {
      method: "listing",
      posts,
      scanned: null,
      scanComplete: null,
      note: o.sort === "top" ? "Sorted by score within the newest 100 posts of the window, not across the whole window." : null,
    };
  }

  if (Date.now() >= indexDownUntil) try {
    const rows = (await arcticGet("/posts/search", {
      ...base,
      query: o.q,
      after: o.after,
      limit: 100,
      sort: o.sort === "old" ? "asc" : "desc",
    })) as Record<string, unknown>[] | null;
    return {
      method: "index",
      posts: order((rows ?? []).map((r) => shapePost(r, o.textChars, nowSec))).slice(0, o.limit),
      scanned: null,
      scanComplete: null,
      note: null,
    };
  } catch (err) {
    if (!(err instanceof ArcticError) || err.kind !== "timeout") throw err;
    indexDownUntil = Date.now() + INDEX_RETRY_MS;
  }

  /* THE SCAN. Newest first, a page of 100 at a time, each page's oldest post
     the next page's `before`, until the window's start, the page cap or the
     clock. Matching is on the title and the WHOLE selftext (before clipping). */
  const terms = queryTerms(o.q);
  const pages = o.scanPages ?? 8;
  const deadline = Date.now() + (o.budgetMs ?? 40_000);
  const found: Post[] = [];
  let cursor = o.before;
  let scanned = 0;
  let complete = false;
  for (let page = 0; page < pages && Date.now() < deadline; page++) {
    const rows = ((await arcticGet("/posts/search", {
      ...base,
      before: cursor ?? undefined,
      after: o.after,
      limit: 100,
      sort: "desc",
    })) ?? []) as Record<string, unknown>[];
    scanned += rows.length;
    for (const r of rows)
      if (matches(`${str(r.title)}\n${str(r.selftext)}`, terms)) found.push(shapePost(r, o.textChars, nowSec));
    const oldest = rows.length ? num(rows[rows.length - 1]!.created_utc) : null;
    if (rows.length < 100 || oldest === null || oldest <= o.after) {
      complete = true;
      break;
    }
    cursor = oldest;
  }
  const ordered = o.sort === "old" ? [...found].reverse() : order(found);
  return {
    method: "scan",
    posts: ordered.slice(0, o.limit),
    scanned,
    scanComplete: complete,
    note:
      `The archive's keyword index is timing out, so this is a scan of ${scanned} posts in the window (newest first) matched on title and body` +
      (complete ? `, which reached the start of the window.` : `, which STOPPED before the start of the window — older matches may exist; narrow the window with --after/--before to see them.`) +
      ` ${found.length} matched.`,
  };
}

export type CommentHit = Omit<Comment, "replies" | "moreReplies" | "depth"> & { subreddit: string; threadId: string; thread: string };

/** Comments whose body matches a full-text query, in a subreddit, by an author or under one thread. */
export async function searchComments(o: {
  subreddit: string | null;
  author: string | null;
  threadId: string | null;
  q: string | null;
  after: number;
  before: number | null;
  limit: number;
  sort: "new" | "old" | "top";
  textChars: number;
}): Promise<CommentHit[]> {
  const nowSec = Date.now() / 1000;
  const rows = ((await arcticGet("/comments/search", {
    subreddit: o.subreddit ?? undefined,
    author: o.author ?? undefined,
    link_id: o.threadId ? `t3_${o.threadId}` : undefined,
    body: o.q ?? undefined,
    after: o.after,
    before: o.before ?? undefined,
    limit: o.sort === "top" ? 100 : Math.min(100, o.limit),
    sort: o.sort === "old" ? "asc" : "desc",
    fields: COMMENT_FIELDS,
  })) ?? []) as Record<string, unknown>[];
  const hits = rows.map((r) => {
    const threadId = str(r.link_id).replace(/^t3_/, "");
    const sub = str(r.subreddit);
    const c = shapeComment(r, sub, threadId, 0, o.textChars, nowSec);
    const { replies: _r, moreReplies: _m, depth: _d, ...rest } = c;
    return { ...rest, subreddit: sub, threadId, thread: `https://www.reddit.com/r/${sub}/comments/${threadId}/` };
  });
  if (o.sort === "top") hits.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return hits.slice(0, o.limit);
}

/* ------------------------------------------------------------ one thread */

export type Thread = {
  post: Post;
  comments: Comment[];
  /** Comments in the archive's tree for this post (collapsed stubs counted). */
  archived: number;
  returned: number;
  /** archived − returned: left out by the `comments` cap or collapsed by the archive. */
  omitted: number;
  focus: string | null;
};

type TreeNode = { kind?: string; data?: Record<string, unknown> };

function childrenOf(data: Record<string, unknown>): TreeNode[] {
  const r = data.replies as unknown;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const kids = (r as { data?: { children?: unknown } }).data?.children;
    return Array.isArray(kids) ? (kids as TreeNode[]) : [];
  }
  return Array.isArray(r) ? (r as TreeNode[]) : [];
}

/**
 * One post and its comment tree. Siblings are ordered by score, highest first
 * (unsettled scores last), and the tree is cut at `maxComments` in that order,
 * so a long thread returns its most-agreed-with branches rather than its
 * oldest ones. Every cut is counted on the parent as `moreReplies`.
 */
export async function readThread(ref: string, o: { maxComments: number; textChars: number; postChars: number }): Promise<Thread> {
  let parsed = parseThreadRef(ref);
  if (!parsed)
    throw new ArcticError(
      "refused",
      `"${ref}" is not a Reddit thread reference. Pass a post id (e.g. 1w8su8w or t3_1w8su8w) or a reddit.com/r/<sub>/comments/<id>/… URL.`,
      400,
    );
  if ("shortPath" in parsed) {
    const rows = (await arcticGet("/short_links", { paths: parsed.shortPath })) as unknown;
    const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
    const full = first ? str(first.resolved_path) || str(first.url) : "";
    const again = full ? parseThreadRef(full.startsWith("/") ? `https://www.reddit.com${full}` : full) : null;
    if (!again || "shortPath" in again)
      throw new ArcticError("not-found", `The share link ${parsed.shortPath} could not be resolved to a thread.`, 404);
    parsed = again;
  }
  const { postId, commentId } = parsed;
  const nowSec = Date.now() / 1000;

  const rows = (await arcticGet("/posts/ids", { ids: postId, fields: POST_FIELDS })) as Record<string, unknown>[] | null;
  const raw = rows?.[0];
  if (!raw) throw new ArcticError("not-found", `The archive has no post with id ${postId}.`, 404);
  const post = shapePost(raw, o.postChars, nowSec);

  const tree = ((await arcticGet("/comments/tree", {
    link_id: `t3_${postId}`,
    parent_id: commentId ? `t1_${commentId}` : undefined,
    limit: 500,
    start_breadth: 100,
    start_depth: 10,
  })) ?? []) as TreeNode[];

  let archived = 0;
  const byScore = (a: Comment, b: Comment) => (b.score ?? -1) - (a.score ?? -1);
  const build = (nodes: TreeNode[], depth: number): { list: Comment[]; more: number } => {
    const list: Comment[] = [];
    let more = 0;
    for (const n of nodes) {
      if (!n?.data) continue;
      if (n.kind === "more") {
        const c = num(n.data.count) ?? (Array.isArray(n.data.children) ? n.data.children.length : 0);
        more += c;
        archived += c;
        continue;
      }
      archived++;
      const c = shapeComment(n.data, post.subreddit, postId, depth, o.textChars, nowSec);
      const kids = build(childrenOf(n.data), depth + 1);
      c.replies = kids.list;
      c.moreReplies = kids.more;
      list.push(c);
    }
    list.sort(byScore);
    return { list, more };
  };
  const whole = build(tree, 0);

  /* Cut to the budget in a breadth-first pass: every top-level comment gets a
     slot before any reply does, so the answer shows the range of what was said
     before the depth of any one argument. */
  let left = o.maxComments;
  const keep = new Set<Comment>();
  let frontier = whole.list;
  while (frontier.length && left > 0) {
    const next: Comment[] = [];
    for (const c of frontier) {
      if (left <= 0) break;
      keep.add(c);
      left--;
      next.push(...c.replies);
    }
    frontier = next.sort(byScore);
  }
  const prune = (list: Comment[]): { list: Comment[]; dropped: number } => {
    const out: Comment[] = [];
    let dropped = 0;
    for (const c of list) {
      if (!keep.has(c)) {
        dropped += 1 + count(c.replies) + c.moreReplies;
        continue;
      }
      const inner = prune(c.replies);
      c.replies = inner.list;
      c.moreReplies += inner.dropped;
      out.push(c);
    }
    return { list: out, dropped };
  };
  const count = (list: Comment[]): number => list.reduce((n, c) => n + 1 + count(c.replies), 0);
  const top = prune(whole.list);

  return { post, comments: top.list, archived, returned: keep.size, omitted: Math.max(0, archived - keep.size), focus: commentId };
}
