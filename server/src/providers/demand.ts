/**
 * Demand signals — Reddit and Hacker News.
 *
 * TWO SERVICES BEHIND ONE MODULE, the way stock.ts holds Pexels and Pixabay,
 * and for the same reason: they answer the same question in two vocabularies.
 * Everything else this box collects measures something the owner OWNS — a
 * fleet, a portfolio, a book of subscriptions, an ad account. These two
 * measure what strangers said in public about a phrase somebody named, which
 * is the one input to a roadmap that cannot be derived from a dashboard.
 *
 * The rules are lifted from the collector this replaces, which is the
 * version that has actually been run against these endpoints.
 *
 * NEITHER HAS A CREDENTIAL, AND THE TWO REASONS ARE DIFFERENT.
 *
 * Hacker News simply does not have one: `hn.algolia.com/api/v1/search` is
 * free, unauthenticated and generous, and it is the only one of these sources
 * that serves COMMENTS as first-class search results — which is where the "I
 * wish something did X" sentences actually are. What it needs instead is a
 * LIST of phrases to watch, exactly as npm needs a list of packages: with no
 * list there is nothing to ask, and nothing here invents one.
 *
 * Reddit has no credential because there is no longer one to get. Self-serve
 * API app registration closed on 2025-11-11, and the unauthenticated `.json`
 * endpoints were deprecated in May 2026 — measured on a residential
 * connection with the exact user agent Reddit's rules ask for,
 * every `www.reddit.com/*.json` request answers 403 Blocked. So the endpoint
 * everybody's example code uses is shut, and the approval queue behind the
 * replacement declines read-only personal scripts by design.
 *
 * WHAT IS STILL OPEN IS THE ATOM SEARCH FEED, and it is what this runs on.
 * Probed from this box on 2026-09-04:
 *
 *     GET /search.rss?q=…&sort=relevance&t=year   200, atom+xml, 10 entries
 *     x-ratelimit-remaining: 0.0, x-ratelimit-reset: 27   ← one a minute
 *     the same with ?user=…&feed=…                200, and NO rate-limit
 *                                                 headers at all
 *
 * That second line is the whole reason a credential exists here at all. Reddit
 * issues every ACCOUNT a personal RSS token at reddit.com/prefs/feeds — the
 * thing you paste into a feed reader to follow your own front page — and a
 * search URL carrying its `user=` and `feed=` parameters is served without the
 * anonymous throttle. Two queries eight seconds apart both answered 200 with
 * the counter absent entirely. No app, no approval queue: an ordinary account
 * and one settings page. It is optional, and the plugin works without it — it
 * is the difference between the whole watch list every collection and one
 * phrase at a time.
 *
 * THREE TIERS, AND WHICH ONE ANSWERED IS PART OF THE MEASUREMENT.
 *
 *   1. ATOM FEED    the default. A real search: relevance-ordered threads with
 *                   the subreddit and the post date. Sort order is
 *                   load-bearing and was measured previously — logged
 *                   out, `sort=new` ignores the query and returns the sitewide
 *                   firehose, which answers 200 and looks exactly like data.
 *   2. + THE TOKEN  the same feed with the account's own prefs/feeds
 *                   parameters. Same rows, no throttle.
 *   3. SEARXNG      `site:reddit.com` through the self-hosted node, when the
 *                   feed refuses. Honestly worse and says so on every row: a
 *                   web index knows a thread's title and URL and NOTHING about
 *                   when it was posted or how many people agreed, so those
 *                   rows carry a null date and a null score. It exists so that
 *                   the day Reddit closes the feeds too, this degrades instead
 *                   of dying — and the card can say which happened.
 *
 * "12 posts from the Atom feed" and "12 posts from SearXNG, unscored and
 * unaged" are different claims. Every row carries the tier that produced it,
 * every query carries the tier that answered it, and the card names both.
 *
 * NULL IS "WE COULD NOT ASK" AND ZERO IS "WE ASKED AND NOBODY SAID ANYTHING".
 * A throttled query and a query nobody has posted about must never look the
 * same, so each one is recorded with its own status — `ok` (asked and
 * answered, possibly with nothing), `throttled`, `failed`, `skipped` — and
 * never as an empty list.
 *
 * THE ATOM FEED HAS NOWHERE TO PUT AN UPVOTE COUNT. Not "Reddit withholds it":
 * the format has fields for a title, a link and a date and that is all. So the
 * counts come from the Arctic Shift archive — the maintained Pushshift
 * successor — in ONE batched lookup per query, read only by id and never
 * searched. Probed on 2026-09-04: 200 in 248ms for three ids, with `score`,
 * `num_comments`, `created_utc` and `over_18`. When it does not answer the
 * rows go out with a null score rather than a fabricated zero.
 *
 * UNTRUSTED TEXT. Everything here is user-generated content from a third
 * party. Titles are stored as text, stripped of markup, and links are kept
 * only when they are https on the source's own host. No body text is stored at
 * all — a card shows a title and a link, and the thread is one click away, so
 * a copy of somebody else's prose would be weight with no reader.
 *
 * WHAT IS DELIBERATELY NOT PORTED from the collector this replaces: its keyword
 * classifier (feature-request / complaint / question) and its cross-platform
 * convergence fold. Both are ranking machinery for a page that ranks, and both
 * make a claim about somebody's sentence that a card here has no room to show
 * its working for. These cards rank by engagement and recency, which are
 * figures the sources published themselves.
 */
import * as accounts from "../accounts.ts";
import * as searxng from "./searxng.ts";

const TIMEOUT_MS = 25_000;

/**
 * Reddit's own user-agent shape.
 *
 * Their API rules ask for `<platform>:<app id>:<version>`, and a string that
 * does not parse as one is refused 403 with no hint of the reason. The Atom
 * tier answers this string exactly as readily as it answers a browser's — it
 * was tested both ways previously — so there is nothing to buy by
 * pretending to be Chrome, and a collector that lies about what it is when it
 * does not have to is a collector nobody can hold to account.
 */
const REDDIT_UA = "linux:onepersoncompany-dashboard:v1.0";

/** What the feed wants beside it: a statement about the FORMAT, which is not
 *  a statement about who is asking. */
const REDDIT_ACCEPT =
  "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7";

const HN_UA = searxng.USER_AGENT;

/**
 * One year. Older than that and a thread is archaeology: the product it was
 * about has shipped three versions since, and on raw upvotes it would outrank
 * this week's thread forever.
 */
export const WINDOW_DAYS = 365;

/**
 * How many phrases the list may hold.
 *
 * Each one costs a request per source per collection, and Reddit's is a
 * request that may take a minute of wall clock. Twenty is generous for a
 * portfolio of about twenty products asked one phrase each, and the cap is
 * refused at the point it is typed rather than silently trimming the tail —
 * bing's rule, for bing's reason.
 */
export const MAX_TERMS = 20;

/**
 * The watch list, from one text field. Commas or newlines, because both are
 * what a person pastes.
 *
 * Case-insensitive de-duplication: "Free LLM API" and "free llm api" are one
 * search on both of these engines, and two rows for them would be two
 * requests a run to learn the same thing twice.
 */
export function parseTerms(raw: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(/[,\n]+/)) {
    const term = part.trim().replace(/\s+/g, " ");
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/* ------------------------------------------------------------------ shapes */

/** How a row was learned. On the wire and on the card, because the three are
 *  not the same claim. */
export type Tier = "feed" | "feed+token" | "searxng" | "algolia";

/**
 * The tier names as a person reads them, for run notes and cards.
 *
 * Written out in full rather than abbreviated, because the whole point of the
 * field is that "the Atom feed" and "SearXNG, unscored and unaged" are
 * different claims — and a label that hid the second one behind a shorter word
 * would be the abbreviation doing the lying.
 */
export const TIER_LABEL: Record<Tier, string> = {
  feed: "the public Atom search feed",
  "feed+token": "the Atom feed with the account's own prefs/feeds token",
  searxng: "SearXNG site:reddit.com, unscored and unaged",
  algolia: "the Hacker News search index",
};

export type Signal = {
  source: "reddit" | "hn";
  /** The source's own id — `t3_…` for a Reddit thread, the Algolia objectID
   *  for a Hacker News item. It is the source's, not ours, so the same thread
   *  found by the feed and by SearXNG is ONE row that changes tier rather than
   *  two rows that look like two threads. */
  id: string;
  term: string;
  title: string;
  url: string;
  /** "r/selfhosted" for Reddit; "story" or "comment" for Hacker News. */
  context: string | null;
  /** ISO, or NULL where the tier cannot date the thread. A web index's own
   *  idea of a date is when it crawled, which is not when anybody posted. */
  createdAt: string | null;
  points: number | null;
  comments: number | null;
  tier: Tier;
};

/**
 * What happened when one phrase was asked of one source.
 *
 * FOUR STATUSES, BECAUSE FOUR THINGS HAPPEN AND ONLY ONE OF THEM IS ABOUT
 * DEMAND. This is bing_keyword_state's rule, arrived at independently by
 * the previous system for the same reason: an empty answer and a refused
 * question are indistinguishable in the response body, so the difference has
 * to be carried outside it.
 *
 *   ok        the source answered. `items` may be 0, and that is a finding.
 *   throttled the source refused on rate grounds. Unmeasured, never a zero.
 *   failed    the call failed, with the source's own reason.
 *   skipped   this run deliberately did not ask — the Reddit budget was spent
 *             and this phrase is next in line. Not a failure and not a zero.
 */
export type QueryStatus = "ok" | "throttled" | "failed" | "skipped";

export type Outcome = {
  source: "reddit" | "hn";
  term: string;
  status: QueryStatus;
  /** Which tier answered. Null when none did. */
  tier: Tier | null;
  /** Rows this phrase produced, or null when it was not measured. Zero and
   *  null are different answers and the column keeps them apart. */
  items: number | null;
  error: string | null;
};

/* -------------------------------------------------------------------- http */

class Paced {
  private next = 0;
  private readonly gapMs: number;
  constructor(gapMs: number) {
    this.gapMs = gapMs;
  }
  /** Milliseconds until this host may be asked again. */
  waitFor(): number {
    return Math.max(0, this.next - Date.now());
  }
  async wait() {
    const ms = this.waitFor();
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    this.next = Date.now() + this.gapMs;
  }
}

async function text(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new Error(
      name === "TimeoutError"
        ? `no answer within ${TIMEOUT_MS / 1000} seconds`
        : `could not reach the host (${name})`,
    );
  }
  return { status: res.status, body: await res.text(), headers: res.headers };
}

/* ------------------------------------------------------------------ reddit */

/**
 * One request a minute, anonymously. MEASURED, NOT GUESSED: a 200 from
 * search.rss carries `x-ratelimit-remaining: 0.0` and an `x-ratelimit-reset`
 * counting down to the next minute boundary, and a second request inside that
 * window is a 429. 62 seconds clears the boundary with two to spare.
 *
 * With the account's own feed token Reddit sends no counter at all and two
 * queries eight seconds apart were both served, so six is politeness rather
 * than arithmetic — the number the previous system settled on for the same tier.
 */
export const REDDIT_GAP_MS = 62_000;
export const REDDIT_GAP_TOKEN_MS = 6_000;

/**
 * How much wall clock one collection may spend on Reddit.
 *
 * THE PACING IS NOT PORTED FROM THE PI AND IT MUST NOT BE. Over there this is
 * a systemd timer with eighty minutes to play with, so it paces at 62 seconds
 * a query and takes most of an hour. Here a collection runs inside the HTTP
 * request that stored the credential and again on the process's own clock, and
 * a route that holds a browser open for forty minutes is not a route.
 *
 * So the LIST is spread across runs instead of the run being stretched across
 * the list. Each collection asks the phrases whose answers are stalest, in
 * order, until the next request would not fit in this budget; the rest are
 * recorded `skipped` — asked for by name, with the reason, and first in line
 * next time. Anonymously that is one phrase every six hours; with the feed
 * token it is four a run, which is the whole list for any sane list.
 */
export const REDDIT_BUDGET_MS = 24_000;

/** A Reddit thread URL, and the two things it carries: the subreddit and the
 *  thread's own id36. Matching it is what lets a row found by SearXNG collapse
 *  onto the same row the feed produced instead of arriving as a second
 *  thread. */
const REDDIT_THREAD =
  /^https?:\/\/(?:www\.|old\.|new\.|np\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,32})\/comments\/([a-z0-9]{4,10})\b/;

/** Reddit renders every feed entry's body with its own footer links and a
 *  byline. None of it is what the person wrote. Kept for the title cleaner
 *  below, which is the only place body text is touched at all. */
const FEED_CHROME = /\s*(?:\[link\]|\[comments\]|submitted by\s+\/u\/\S+)\s*/gi;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  "#x27": "'",
  nbsp: " ",
};

/** Atom carries titles entity-encoded, and Reddit double-encodes an ampersand
 *  in a subreddit name often enough to matter. Decoded once here so a card
 *  never prints `&amp;#39;`. */
function decode(raw: string): string {
  return raw
    .replace(/&([a-z]+|#x?[0-9a-f]+);/gi, (whole, name: string) => {
      const key = name.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key]!;
      const num = /^#x/i.test(name)
        ? Number.parseInt(name.slice(2), 16)
        : /^#/.test(name)
          ? Number.parseInt(name.slice(1), 10)
          : NaN;
      return Number.isFinite(num) && num > 0 && num < 0x110000
        ? String.fromCodePoint(num)
        : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]!.replace(/<[^>]+>/g, " ")) : null;
};

type AtomHit = {
  id: string;
  title: string;
  url: string;
  sub: string | null;
  createdAt: string | null;
};

/**
 * Entries out of Reddit's Atom search feed, or null.
 *
 * NULL MEANS "THAT WAS NOT THE FEED" AND BECOMES A FAULT UPSTREAM, never an
 * empty result. Reddit's block page is an HTML 200; read as a feed it yields
 * zero entries, which this would otherwise publish as "nobody is talking about
 * this" — the single worst answer available here. The Atom root element is
 * what tells the two apart, so its absence is a refusal rather than a silence.
 */
function atomHits(body: string): AtomHit[] | null {
  if (!/<feed[^>]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom["']/i.test(body))
    return null;

  const hits: AtomHit[] = [];
  for (const match of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = match[1]!;
    const id = tag(block, "id") ?? "";
    /*
      The same feed answers with SUBREDDITS whose names matched the words
      (`t5_…`) alongside the posts (`t3_…`). A subreddit is not a demand
      signal: nobody wrote it this year and nobody upvoted it, and its
      `updated` is the date it was founded.
    */
    if (!id.startsWith("t3_")) continue;
    const href = block.match(/<link[^>]*href="([^"]+)"/)?.[1];
    const title = tag(block, "title");
    if (!href || !title) continue;
    const url = decode(href);
    if (!REDDIT_THREAD.test(url)) continue;
    const updated = tag(block, "updated");
    hits.push({
      id,
      title: title.replace(FEED_CHROME, " ").trim().slice(0, 220),
      url,
      sub: block.match(/<category[^>]*term="([^"]+)"/)?.[1] ?? null,
      /* Atom's `updated`; for a post Reddit sets it to the creation time,
         which is the only date the feed carries at all. */
      createdAt: updated && !Number.isNaN(Date.parse(updated))
        ? new Date(updated).toISOString()
        : null,
    });
  }
  return hits;
}

/* ---------------------------------------------------------- arctic shift */

const ARCTIC_URL = "https://arctic-shift.photon-reddit.com/api/posts/ids";

/**
 * THE ARCHIVE'S OWN BLIND SPOT, and the reason this number exists.
 *
 * Arctic Shift files a post the moment it appears and re-reads it about a day
 * and a half later; until it does, the `score` it hands back is 1 and
 * `num_comments` is 0 — which is what the post genuinely looked like the
 * instant it was posted. Those are placeholders, not measurements, and
 * importing them would tell the page that yesterday's thread, the most
 * actionable row on it, got one upvote and no replies. Inside this window the
 * archive's engagement figures are dropped and the row carries null.
 */
const ARCTIC_LAG_DAYS = 1.5;

type ArcticRow = {
  score: number | null;
  comments: number | null;
  createdAt: string | null;
  over18: boolean;
};

/**
 * Upvote and comment counts for as many of these thread ids as the archive
 * knows. Best effort by construction: a failure here costs the counts and
 * nothing else, and the rows go out unscored rather than unpublished.
 *
 * READ ONLY BY ID, NEVER SEARCHED. That is the distinction that makes it safe
 * to depend on — the threads are found by Reddit itself and this only fills in
 * the two fields Atom has no room for, so the archive is never in a position
 * to decide what the dashboard sees.
 */
async function arcticEnrich(ids: string[]): Promise<Map<string, ArcticRow>> {
  const out = new Map<string, ArcticRow>();
  if (!ids.length) return out;
  let body: string;
  try {
    const res = await text(`${ARCTIC_URL}?ids=${encodeURIComponent(ids.join(","))}`, {
      "User-Agent": searxng.USER_AGENT,
      Accept: "application/json",
    });
    if (res.status !== 200) return out;
    body = res.body;
  } catch {
    return out;
  }
  let rows: unknown;
  try {
    const doc = JSON.parse(body) as { data?: unknown };
    rows = Array.isArray(doc) ? doc : doc.data;
  } catch {
    return out;
  }
  if (!Array.isArray(rows)) return out;

  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const name =
      typeof row.name === "string"
        ? row.name
        : typeof row.id === "string"
          ? `t3_${row.id}`
          : null;
    if (!name) continue;
    const created =
      typeof row.created_utc === "number"
        ? new Date(row.created_utc * 1000).toISOString()
        : null;
    const fresh =
      created !== null &&
      (Date.now() - Date.parse(created)) / 86_400_000 < ARCTIC_LAG_DAYS;
    out.set(name, {
      score: !fresh && typeof row.score === "number" ? row.score : null,
      comments: !fresh && typeof row.num_comments === "number" ? row.num_comments : null,
      createdAt: created,
      over18: row.over_18 === true,
    });
  }
  return out;
}

/* -------------------------------------------------------- the feed token */

export type FeedToken = { user: string; feed: string };

/**
 * The prefs/feeds credential, from whatever the owner pasted.
 *
 * TWO SHAPES, BECAUSE THERE ARE TWO THINGS IN FRONT OF A PERSON. The previous
 * system keeps `{"user": "…", "feed": "…"}` in a file, so a copy from the Pi is a
 * paste of that JSON; reddit.com/prefs/feeds itself offers a whole URL with
 * the two parameters in its query string, so that is the other paste. Both are
 * the same credential and refusing either would be refusing a correct answer
 * on a technicality.
 *
 * Null for anything else — and a null here is a REFUSAL at the door rather
 * than a value stored unchecked, because a feed token that does not parse is a
 * throttle that never lifts and a run that takes six times as long for a
 * reason nothing on the page could state.
 */
export function parseFeed(raw: string): FeedToken | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith("{")) {
    try {
      const doc = JSON.parse(value) as Record<string, unknown>;
      const user = typeof doc.user === "string" ? doc.user.trim() : "";
      const feed = typeof doc.feed === "string" ? doc.feed.trim() : "";
      return user && feed ? { user, feed } : null;
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(value);
    if (!/(^|\.)reddit\.com$/.test(url.hostname)) return null;
    const user = (url.searchParams.get("user") ?? "").trim();
    const feed = (url.searchParams.get("feed") ?? "").trim();
    return user && feed ? { user, feed } : null;
  } catch {
    return null;
  }
}

/** The token of the first Reddit account that has one, or null for the
 *  anonymous tier — which is an ordinary state and not a failure. */
function redditToken(reader: string): {
  token: FeedToken;
  account: { id: number; label: string };
} | null {
  const { ready } = accounts.credentialed("reddit", ["feed"], reader);
  for (const { account, values } of ready) {
    const token = parseFeed(values.feed ?? "");
    /* The first account that parses, and there is deliberately no attempt to
       rotate between several: a second token would double the throughput of a
       phase that already finishes inside its budget, at the price of a run
       whose pacing depends on which account answered. */
    if (token) return { token, account: { id: account.id, label: account.label } };
  }
  return null;
}

/**
 * Does this token get the feed served without the anonymous throttle?
 *
 * THAT IS THE QUESTION THIS CAN ANSWER, AND IT IS NOT "IS THE TOKEN REAL".
 * Both halves were measured on 2026-09-04 and the second one is the
 * uncomfortable half:
 *
 *   with no feed parameters      200, `x-ratelimit-remaining: 0.0` and a
 *                                reset counting down to the next minute
 *   with the owner's own token   200, no rate-limit headers at all, and
 *                                queries eight seconds apart both served
 *   with a MADE-UP token         200, no rate-limit headers either, and three
 *                                queries five seconds apart all served
 *
 * So `search.rss` does not appear to check the token at all: carrying
 * `user=`/`feed=` is what puts the request on the un-throttled path. Nothing
 * here can therefore prove a token belongs to the owner's account, and this
 * function does not claim to — it proves the exchange works and that the
 * throttle counter is gone, which is the whole of what the credential is for.
 *
 * The check that remains is worth keeping and is a real one: a 200 that STILL
 * carries the counter means Reddit did not take those parameters as feed
 * parameters, and storing that would leave the owner believing the throttle
 * had lifted while every collection went on asking one phrase at a time for a
 * reason nothing on the page could state. That is refused with the sentence.
 */
export async function verifyFeed(
  token: FeedToken,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let got: Awaited<ReturnType<typeof redditFeedSearch>>;
  try {
    got = await redditFeedSearch("self hosted", token, 5);
  } catch (err) {
    return {
      ok: false,
      error: `Reddit did not accept that request — ${
        err instanceof Error ? err.message : String(err)
      }.`,
    };
  }

  if ("throttled" in got)
    return {
      ok: false,
      error:
        "Reddit throttled the request, which a query carrying feed parameters " +
        "is not. Check the user and feed values came from " +
        "reddit.com/prefs/feeds — and try again in a minute, because the " +
        "anonymous window this fell back into is a minute wide.",
    };

  if (got.limit)
    return {
      ok: false,
      error:
        "Reddit served that search ANONYMOUSLY — its throttle counter came " +
        "back on the response, which does not happen when the feed parameters " +
        "are taken. They were ignored rather than refused, so storing this " +
        "would look like a lifted throttle that is still there.",
    };

  return { ok: true };
}

/* -------------------------------------------------------------- reddit run */

export type RedditRun = {
  signals: Signal[];
  outcomes: Outcome[];
  /** The account whose feed token paced the run, or null for the anonymous
   *  tier. Named on the card, because it is the difference between four
   *  phrases a run and one. */
  account: { id: number; label: string } | null;
  /** What the run actually spent, so a card can say "4 of 7 asked" rather
   *  than leaving three phrases unexplained. */
  asked: number;
  skipped: number;
  gapMs: number;
  /** Queries whose rows got real upvote counts out of the archive, over the
   *  queries the feed answered. */
  enriched: number;
  enrichable: number;
  /** Reddit's own throttle counter as it stood on the last feed response.
   *  Null with a token, because Reddit sends no counter to one — which is
   *  precisely what the token buys and is worth saying on the card. */
  limit: { remaining: number | null; resetSeconds: number | null } | null;
  warnings: string[];
};

/**
 * One phrase, through the Atom feed.
 *
 * `sort=relevance` and `t=year` are both load-bearing. Logged out, `sort=new`
 * ignores the query entirely and returns the sitewide firehose — twenty-five
 * posts from the last four minutes about nothing that was asked for — which is
 * the worst kind of failure available, because it is a 200 that looks like
 * data.
 */
async function redditFeedSearch(
  term: string,
  token: FeedToken | null,
  limit: number,
): Promise<{
  hits: AtomHit[];
  limit: RedditRun["limit"];
} | { throttled: true; retryAfter: number | null }> {
  const params = new URLSearchParams({
    /* A multi-word phrase is quoted, so "free llm api" is that phrase rather
       than three common words in any order. */
    q: term.includes(" ") ? `"${term}"` : term,
    sort: "relevance",
    t: "year",
    limit: String(Math.min(100, limit)),
    type: "link",
    include_over_18: "off",
  });
  if (token) {
    params.set("user", token.user);
    params.set("feed", token.feed);
  }

  const res = await text(`https://www.reddit.com/search.rss?${params}`, {
    "User-Agent": REDDIT_UA,
    Accept: REDDIT_ACCEPT,
  });

  if (res.status === 429 || res.status === 503) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    return { throttled: true, retryAfter: Number.isFinite(reset) ? reset : null };
  }
  if (res.status !== 200) throw new Error(`Reddit answered HTTP ${res.status}`);

  const hits = atomHits(res.body);
  if (hits === null)
    throw new Error(
      "Reddit answered 200 with something that is not the Atom feed — usually its block page",
    );

  const remaining = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return {
    hits,
    limit: res.headers.has("x-ratelimit-remaining")
      ? {
          remaining: Number.isFinite(remaining) ? remaining : null,
          resetSeconds: Number.isFinite(reset) ? reset : null,
        }
      : null,
  };
}

/**
 * The safety net: `site:reddit.com` through the SearXNG node.
 *
 * EVERY ROW FROM HERE IS UNSCORED AND UNAGED, and it says so on the wire. A
 * web index knows a thread's title and its URL; it does not know when it was
 * posted or how many people agreed with it, and a `publishedDate` from an
 * index is the date it crawled. Feeding a guess into a card that sorts by
 * recency would manufacture a ranking out of nothing, so the date is null and
 * the score is null and the tier travels with the row.
 */
async function redditSearxngSearch(
  term: string,
  searx: { url: string; key: string },
  limit: number,
): Promise<AtomHit[]> {
  const answer = await searxng.search(searx.url, searx.key, `site:reddit.com ${term}`);
  const out: AtomHit[] = [];
  for (const result of answer.results) {
    const matched = REDDIT_THREAD.exec(result.url);
    if (!matched) continue;
    out.push({
      /* The thread's own id36, turned into Reddit's own `t3_` name — so a
         thread the feed already found is the SAME row with a new tier rather
         than a duplicate that would count twice in every total. */
      id: `t3_${matched[2]!}`,
      title: result.title.slice(0, 220),
      url: result.url,
      sub: matched[1]!,
      createdAt: null,
    });
    if (out.length >= limit) break;
  }

  /*
    A NET THAT CAUGHT NOTHING IS NOT AN ANSWER OF NOTHING, and this is the one
    place that distinction could have been lost. Measured on this node on
    2026-09-04: `site:reddit.com free llm api` came back with ten links about
    free browser games, because the single engine still answering had ignored
    both the site restriction and the query. Returning an empty list here would
    have been recorded as "asked and nobody said anything" — about a phrase
    Reddit refused and a web index never really looked for.
  */
  if (!out.length)
    throw new Error(
      answer.results.length
        ? `the node answered with ${answer.results.length} links and not one was a Reddit thread — its engines are not honouring site:reddit.com`
        : "the node returned no results at all",
    );
  return out;
}

/**
 * Reddit, for as many of these phrases as the run's budget allows.
 *
 * `terms` arrives STALEST FIRST — the collector orders it, because staleness
 * is a fact about the database rather than about Reddit — and this walks it
 * until the next request would not fit inside the budget. Everything after
 * that point is `skipped`, by name, with the reason.
 */
export async function collectReddit(
  terms: string[],
  opts: {
    searx: { url: string; key: string } | null;
    perTerm?: number;
    reader?: string;
  },
): Promise<RedditRun> {
  const held = redditToken(opts.reader ?? "collect_reddit");
  const gapMs = held ? REDDIT_GAP_TOKEN_MS : REDDIT_GAP_MS;
  const pace = new Paced(gapMs);
  const perTerm = opts.perTerm ?? 25;
  const started = Date.now();

  const signals: Signal[] = [];
  const outcomes: Outcome[] = [];
  const warnings: string[] = [];
  let asked = 0;
  let skipped = 0;
  let enriched = 0;
  let enrichable = 0;
  let limit: RedditRun["limit"] = null;
  /* Once Reddit has refused on rate grounds, asking it again inside the same
     run is both rude and pointless: the window is a minute wide and the budget
     is not. The remaining phrases go to the safety net if there is one. */
  let refusing = false;

  for (const term of terms) {
    /* Once Reddit is refusing, the only cost left is the fallback's own round
       trip — but the budget still governs it. A node on the owner's own box is
       cheap and not free, and a run that quietly took four times as long
       because Reddit was throttled would be a collection whose duration
       depended on somebody else's mood. */
    const wait = refusing ? 0 : pace.waitFor();
    if (Date.now() + wait - started > REDDIT_BUDGET_MS) {
      skipped += 1;
      outcomes.push({
        source: "reddit",
        term,
        status: "skipped",
        tier: null,
        items: null,
        error:
          `not asked — this run's ${Math.round(REDDIT_BUDGET_MS / 1000)}s budget ` +
          `was spent${refusing ? " on a Reddit that was refusing" : ` at ${gapMs / 1000}s a query`}. ` +
          `It is first in line next time.`,
      });
      continue;
    }

    let hits: AtomHit[] | null = null;
    let tier: Tier | null = null;
    let feedError: string | null = null;
    let throttled = false;

    if (!refusing) {
      await pace.wait();
      asked += 1;
      try {
        const got = await redditFeedSearch(term, held?.token ?? null, perTerm);
        if ("throttled" in got) {
          throttled = true;
          refusing = true;
          feedError =
            `Reddit refused on rate grounds` +
            (got.retryAfter ? ` — its counter resets in ${got.retryAfter}s` : "") +
            (held ? "." : ". The anonymous feed allows one query a minute.");
        } else {
          hits = got.hits;
          tier = held ? "feed+token" : "feed";
          limit = got.limit ?? limit;
        }
      } catch (err) {
        feedError = err instanceof Error ? err.message : String(err);
      }
    } else {
      feedError = "Reddit refused an earlier query in this run on rate grounds.";
      throttled = true;
    }

    /*
      THE SAFETY NET FIRES ON A REFUSAL AND NEVER ON A SKIP. A phrase this run
      chose not to ask is not a phrase Reddit would not answer, and routing it
      to the unscored tier would quietly downgrade the whole list for a reason
      that was ours rather than Reddit's.
    */
    if (hits === null && opts.searx) {
      try {
        hits = await redditSearxngSearch(term, opts.searx, perTerm);
        tier = "searxng";
        warnings.push(
          `${term}: answered by SearXNG rather than Reddit — those rows are unscored and unaged`,
        );
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        warnings.push(`${term}: SearXNG could not stand in either — ${why}`);
      }
    }

    if (hits === null || tier === null) {
      outcomes.push({
        source: "reddit",
        term,
        status: throttled ? "throttled" : "failed",
        tier: null,
        items: null,
        error: feedError ?? "Reddit did not answer.",
      });
      if (feedError) warnings.push(`${term}: ${feedError}`);
      continue;
    }

    /*
      THE COUNTS, IN ONE BATCHED LOOKUP PER QUERY. Only for the feed tiers:
      SearXNG's rows have no thread id worth enriching beyond the one parsed
      out of the URL, and enriching them would put a real score beside a null
      date, which reads as a measured thread that nobody can place in time.
    */
    let archive = new Map<string, ArcticRow>();
    if (tier !== "searxng" && hits.length) {
      enrichable += 1;
      archive = await arcticEnrich(hits.map((h) => h.id));
      if (archive.size) enriched += 1;
    }

    let kept = 0;
    for (const hit of hits) {
      const extra = archive.get(hit.id);
      /* `include_over_18=off` is Reddit's own filter and is trusted for rows
         nobody could second-guess; where the archive answered, its answer
         wins. */
      if (extra?.over18) continue;
      const createdAt = hit.createdAt ?? extra?.createdAt ?? null;
      signals.push({
        source: "reddit",
        id: hit.id,
        term,
        title: hit.title,
        url: hit.url,
        context: hit.sub ? `r/${hit.sub}` : null,
        createdAt,
        points: extra?.score ?? null,
        comments: extra?.comments ?? null,
        tier,
      });
      kept += 1;
    }

    outcomes.push({ source: "reddit", term, status: "ok", tier, items: kept, error: null });
  }

  return {
    signals,
    outcomes,
    account: held?.account ?? null,
    asked,
    skipped,
    gapMs,
    enriched,
    enrichable,
    limit,
    warnings,
  };
}

/* -------------------------------------------------------------- hacker news */

/** Algolia is free and generous and asks for nothing. A second between
 *  queries is politeness to somebody else's free endpoint rather than a
 *  published budget. */
export const HN_GAP_MS = 1_200;

export type HnRun = {
  signals: Signal[];
  outcomes: Outcome[];
  warnings: string[];
};

/**
 * Hacker News, every phrase, every collection.
 *
 * `tags=(story,comment)` asks for both, and the comments are the reason this
 * source is here at all: they are where somebody says what they wish existed,
 * and no other source on this list serves them as search results.
 *
 * COMMENTS CARRY NO SCORE, and that is Algolia's index rather than a decision
 * here — a comment's points are not in the document. So every comment row has
 * a null score and sorts among the unmeasured rather than at the bottom of a
 * ranking it never entered. Inventing a zero would put the only uncounted
 * number on the page beside counted ones.
 */
export async function collectHn(
  terms: string[],
  opts: { perTerm?: number } = {},
): Promise<HnRun> {
  const pace = new Paced(HN_GAP_MS);
  const perTerm = opts.perTerm ?? 25;
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86_400;
  const signals: Signal[] = [];
  const outcomes: Outcome[] = [];
  const warnings: string[] = [];

  for (const term of terms) {
    await pace.wait();
    const url =
      "https://hn.algolia.com/api/v1/search?" +
      new URLSearchParams({
        query: term,
        tags: "(story,comment)",
        hitsPerPage: String(Math.min(100, perTerm)),
        numericFilters: `created_at_i>${cutoff}`,
      });

    let doc: { hits?: unknown };
    try {
      const res = await text(url, { "User-Agent": HN_UA, Accept: "application/json" });
      if (res.status === 429) {
        outcomes.push({
          source: "hn",
          term,
          status: "throttled",
          tier: null,
          items: null,
          error: "Algolia rate-limited this query.",
        });
        warnings.push(`${term}: Algolia rate-limited the query`);
        continue;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      doc = JSON.parse(res.body) as { hits?: unknown };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      outcomes.push({
        source: "hn",
        term,
        status: "failed",
        tier: null,
        items: null,
        error: why,
      });
      warnings.push(`${term}: ${why}`);
      continue;
    }

    if (!Array.isArray(doc.hits)) {
      outcomes.push({
        source: "hn",
        term,
        status: "failed",
        tier: null,
        items: null,
        error: "Algolia answered in an unrecognised shape.",
      });
      continue;
    }

    let kept = 0;
    for (const raw of doc.hits) {
      if (!raw || typeof raw !== "object") continue;
      const hit = raw as Record<string, unknown>;
      const objectId = typeof hit.objectID === "string" ? hit.objectID : null;
      if (!objectId) continue;
      const isComment = typeof hit.comment_text === "string" && !hit.title;
      const title =
        (typeof hit.title === "string" && hit.title) ||
        (typeof hit.story_title === "string" && hit.story_title) ||
        null;
      if (!title) continue;
      const created =
        typeof hit.created_at_i === "number"
          ? new Date(hit.created_at_i * 1000).toISOString()
          : typeof hit.created_at === "string" && !Number.isNaN(Date.parse(hit.created_at))
            ? new Date(hit.created_at).toISOString()
            : null;
      signals.push({
        source: "hn",
        id: objectId,
        term,
        title: decode(title).slice(0, 220),
        /* ALWAYS THE HN PERMALINK, never the story's outbound link. The
           discussion is the signal; the article it points at is somebody
           else's page and says nothing about demand. */
        url: `https://news.ycombinator.com/item?id=${objectId}`,
        context: isComment ? "comment" : "story",
        createdAt: created,
        points: !isComment && typeof hit.points === "number" ? hit.points : null,
        comments:
          !isComment && typeof hit.num_comments === "number" ? hit.num_comments : null,
        tier: "algolia",
      });
      kept += 1;
    }

    outcomes.push({
      source: "hn",
      term,
      status: "ok",
      tier: "algolia",
      items: kept,
      error: null,
    });
  }

  return { signals, outcomes, warnings };
}

/* ------------------------------------------------------------------ cannot */

/**
 * What these two sources will not say, as the exchange rather than as a
 * conclusion — the shape Replicate's and Cloudflare's blocks carry, and it
 * earns its place here more than in either: three of these lines are the
 * reason a figure a reader expects to find is missing.
 */
export const CANNOT = {
  checkedOn: "2026-09-04",
  asked: [
    {
      asked: "Reddit: an API key",
      answer:
        "None to be had — self-serve app registration closed 2025-11-11 and the .json endpoints answer 403.",
    },
    {
      asked: "Reddit: is this feed token the owner's?",
      answer:
        "Unanswerable — search.rss served a made-up token identically, so only the throttle lift can be verified.",
    },
    {
      asked: "Reddit: an upvote count in the Atom feed",
      answer:
        "The format has no field for one. The counts come from the Arctic Shift archive or are null.",
    },
    {
      asked: "Reddit through SearXNG: a post date or a score",
      answer:
        "A web index knows neither. Those rows are unscored and unaged, and say so.",
    },
    {
      asked: "Hacker News: a comment's points",
      answer: "Not in Algolia's index. Comment rows carry a null score, never a zero.",
    },
    {
      asked: "Either source: how many people saw a thread",
      answer: "Neither publishes impressions. Upvotes and replies are what exist.",
    },
  ],
} as const;
