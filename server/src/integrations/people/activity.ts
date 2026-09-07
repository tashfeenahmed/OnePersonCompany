/**
 * THE PUBLIC HALF OF A WATCHED PERSON'S FILE — pulled from sources that need
 * no credential, and failing into a sentence rather than into a blank page.
 *
 * FOUR KEYLESS SOURCES, AND THE KEYLESSNESS IS THE DESIGN. GitHub's public
 * API, Bluesky's public AppView, Algolia's Hacker News index and an RSS feed
 * all answer an anonymous GET. Nothing here has a token to expire, a quota
 * tied to an account, a cookie to refresh or a scraper to break — so the
 * feature either works on a box that was set up eight months ago and forgotten
 * or says exactly which source did not answer. The obvious missing source is
 * X, and it is missing for precisely this reason: there is no anonymous read
 * of it, and a watchlist that needed a paid API key to draw its own page would
 * be a watchlist that stops working the first time a card is declined.
 *
 * EVERY FETCH FAILS SOFT. A source that times out, 404s, rate-limits or
 * answers something that is not JSON pushes ONE SENTENCE into `warnings` and
 * the pull carries on. Three of four sources answering is three quarters of a
 * file; an exception thrown out of the middle would be none of it. The
 * warnings are stored on the row and shown on the document, because "GitHub
 * rate-limited this box at 14:02" is the answer to "why is the follower count
 * from yesterday" — and an unexplained stale number is the thing this
 * codebase's comments spend their length arguing against.
 *
 * A FAILED SOURCE DOES NOT BLANK A NUMBER. The metrics written are the ones
 * already on the row with whatever answered this time written over them, so an
 * outage costs freshness and never the figure itself. A source that is no
 * longer LINKED is different and does clear: a GitHub number under somebody
 * whose GitHub link was deleted is a number about nothing.
 *
 * NOTHING HERE MAY WRITE THE TYPED HALF. `name`, `company`, `role`, `email`
 * and `note` belong to the owner. This file writes `metrics`, events,
 * `activity_at` and `pull_warnings`, and if a public profile disagrees with
 * what he typed, what he typed stands.
 *
 * RATE LIMITS ARE RESPECTED BY DOING VERY LITTLE. At most six requests per
 * person, once every twenty hours, two seconds apart across a sweep. GitHub's
 * anonymous budget is sixty an hour per address; a watchlist of thirty people
 * spends under a fifth of it a day.
 */
import { now } from "../../db.ts";
import {
  handle,
  parseLinks,
  parseMetrics,
  saveEvents,
  watchRow,
  watchRows,
  writePull,
  type Metrics,
  type PulledEvent,
  type WatchRow,
} from "./watch.ts";

/** Twelve seconds. Long enough for a cold Algolia query, short enough that
 *  four dead sources cannot hold a request open for a minute. */
export const TIMEOUT_MS = 12_000;

/** WHO IS CALLING. GitHub refuses an anonymous request without one, and every
 *  other source deserves to be able to see who this is. */
const USER_AGENT = "onepersoncompany-watch/1.0 (+https://github.com/onepersoncompany)";

/** What a source is called on the page and in the event key. */
export const SOURCES = {
  github: "GitHub",
  bluesky: "Bluesky",
  hn: "Hacker News",
  rss: "RSS",
} as const;

/** How many items each source contributes to one pull. Forty is one page from
 *  every one of them, which is what their defaults happen to agree on. */
const PER_SOURCE = 40;

const say = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 140 characters is a line on a card. Whitespace is collapsed first so a
 *  post whose first 140 characters are newlines is not a blank title. */
export function line(raw: string, max = 140): string {
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/* ------------------------------------------------------------- the fetching */

async function readJson<T>(url: string, what: string, warnings: string[]): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      warnings.push(
        res.status === 403 || res.status === 429
          ? `${what} rate-limited this box (HTTP ${res.status}). The figures below are from the last pull that got through.`
          : `${what} answered HTTP ${res.status}.`,
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    warnings.push(`${what} could not be read: ${say(e)}.`);
    return null;
  }
}

async function readText(url: string, what: string, warnings: string[]): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      warnings.push(`${what} answered HTTP ${res.status}.`);
      return null;
    }
    return await res.text();
  } catch (e) {
    warnings.push(`${what} could not be read: ${say(e)}.`);
    return null;
  }
}

/** ISO or nothing. A date a source states in a format nobody can parse is not
 *  a date, and an event stamped with the time it was FETCHED would sort to the
 *  top of a timeline as if it were today's news. */
const iso = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/* --------------------------------------------------------------- the sources */

type GhUser = { followers?: unknown; public_repos?: unknown };
type GhEvent = {
  type?: string;
  created_at?: string;
  repo?: { name?: string };
  payload?: {
    size?: number;
    commits?: unknown[];
    ref?: string;
    ref_type?: string;
    release?: { tag_name?: string; html_url?: string };
  };
};

const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

/**
 * GitHub: the two numbers, and what they have been doing in public.
 *
 * WATCH EVENTS ARE DROPPED. Starring a repository is the cheapest action on
 * the site and a busy account produces dozens a week; letting them in would
 * bury the pushes and releases — the things that took work — under a list of
 * bookmarks. CREATE events survive only for a repository or a tag, for the
 * same reason: a branch is a keystroke.
 */
async function github(user: string, warnings: string[]) {
  const what = `GitHub (${user})`;
  const events: PulledEvent[] = [];
  const metrics: Partial<Metrics> = {};

  const profile = await readJson<GhUser>(`https://api.github.com/users/${encodeURIComponent(user)}`, what, warnings);
  if (profile) {
    metrics.ghFollowers = int(profile.followers);
    metrics.ghRepos = int(profile.public_repos);
  }

  const feed = await readJson<GhEvent[]>(
    `https://api.github.com/users/${encodeURIComponent(user)}/events/public?per_page=${PER_SOURCE}`,
    `${what} activity`,
    warnings,
  );
  for (const e of Array.isArray(feed) ? feed : []) {
    const at = iso(e.created_at);
    const repo = e.repo?.name ?? "";
    if (!at || !e.type) continue;
    const repoUrl = repo ? `https://github.com/${repo}` : null;
    const kind = e.type.toLowerCase().replace(/event$/, "");
    let title = "";
    let url = repoUrl;
    if (e.type === "PushEvent") {
      /*
        THE COUNT IS OFTEN NOT THERE, AND "0 commits" IS NOT THE ANSWER.
        GitHub's public events feed has stopped carrying `size` and `commits`
        on a good number of push events, and `int()` answering null rather
        than 0 is the difference between "pushed to t3code" and the false
        claim that somebody pushed nothing. The sentence changes shape rather
        than filling a hole with a number.

        A CONSEQUENCE WORTH KNOWING: with no count in it, every push to one
        repository produces the same title and the same URL, so `eventKey`
        folds them into ONE row carrying the newest push's time. The timeline
        then reads "last pushed to t3code on the 5th" rather than listing
        eleven identical lines, which is the more useful of the two and is not
        a claim that there was only one push.
      */
      const n = int(e.payload?.size) ?? (Array.isArray(e.payload?.commits) ? e.payload!.commits!.length : null);
      title = n === null ? `Pushed to ${repo}` : `Pushed ${n} commit${n === 1 ? "" : "s"} to ${repo}`;
    } else if (e.type === "CreateEvent") {
      if (e.payload?.ref_type === "repository") title = `Created ${repo}`;
      else if (e.payload?.ref_type === "tag") title = `Tagged ${e.payload.ref ?? ""} in ${repo}`.replace(/\s+/g, " ");
      else continue;
    } else if (e.type === "ReleaseEvent") {
      title = `Released ${e.payload?.release?.tag_name ?? ""} of ${repo}`.replace(/\s+/g, " ");
      url = e.payload?.release?.html_url ?? repoUrl;
    } else if (e.type === "PublicEvent") {
      title = `Made ${repo} public`;
    } else continue;
    if (title.trim()) events.push({ source: SOURCES.github, kind, title: line(title), url, at });
  }
  return { events, metrics };
}

type BskyProfile = { followersCount?: unknown; postsCount?: unknown };
type BskyFeed = { feed?: { post?: { uri?: string; record?: { text?: string; createdAt?: string } } }[] };

/** Bluesky, replies excluded. A reply is half a conversation and reads as a
 *  fragment on a timeline that has none of the other half. */
async function bluesky(who: string, warnings: string[]) {
  const what = `Bluesky (${who})`;
  const events: PulledEvent[] = [];
  const metrics: Partial<Metrics> = {};
  const actor = encodeURIComponent(who);

  const profile = await readJson<BskyProfile>(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${actor}`,
    what,
    warnings,
  );
  if (profile) {
    metrics.bskyFollowers = int(profile.followersCount);
    metrics.bskyPosts = int(profile.postsCount);
  }

  const feed = await readJson<BskyFeed>(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${actor}&limit=${PER_SOURCE}&filter=posts_no_replies`,
    `${what} posts`,
    warnings,
  );
  for (const item of feed?.feed ?? []) {
    const at = iso(item.post?.record?.createdAt);
    const text = line(item.post?.record?.text ?? "");
    /* A post with no text at all is an image or a quote with nothing said. It
       is real activity and it is an unreadable row, so it is left out rather
       than filed under an empty title. */
    if (!at || !text) continue;
    const rkey = (item.post?.uri ?? "").split("/").filter(Boolean).at(-1) ?? "";
    events.push({
      source: SOURCES.bluesky,
      kind: "post",
      title: text,
      url: rkey ? `https://bsky.app/profile/${who}/post/${rkey}` : null,
      at,
    });
  }
  return { events, metrics };
}

type HnUser = { karma?: unknown };
type HnHit = {
  objectID?: string;
  created_at?: string;
  title?: string | null;
  story_title?: string | null;
  comment_text?: string | null;
};

/** Tags out of an HTML fragment, entities back into characters. Algolia hands
 *  comments back as HTML and a title full of `&#x27;` is a title nobody typed. */
export function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      if (body.startsWith("#")) {
        const n = body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return named[body.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hacker News through Algolia's index.
 *
 * A COMMENT IS TITLED WITH THE COMMENT. Algolia carries the parent story's
 * title on every comment hit, and using it would file forty rows reading
 * "Show HN: something" under a person who wrote forty different sentences —
 * the row would name what they replied TO rather than what they said. So a
 * story hit is titled with its title and a comment hit with its own first
 * line, and `kind` says which of the two is being read.
 */
async function hackernews(user: string, warnings: string[]) {
  const what = `Hacker News (${user})`;
  const events: PulledEvent[] = [];
  const metrics: Partial<Metrics> = {};

  const profile = await readJson<HnUser>(
    `https://hn.algolia.com/api/v1/users/${encodeURIComponent(user)}`,
    what,
    warnings,
  );
  if (profile) metrics.hnKarma = int(profile.karma);

  const found = await readJson<{ hits?: HnHit[] }>(
    `https://hn.algolia.com/api/v1/search_by_date?tags=author_${encodeURIComponent(user)}&hitsPerPage=${PER_SOURCE}`,
    `${what} activity`,
    warnings,
  );
  for (const hit of found?.hits ?? []) {
    const at = iso(hit.created_at);
    if (!at || !hit.objectID) continue;
    const comment = (hit.comment_text ?? "").trim();
    const title = comment ? line(stripHtml(comment)) : line(hit.title ?? hit.story_title ?? "");
    if (!title) continue;
    events.push({
      source: SOURCES.hn,
      kind: comment ? "comment" : "story",
      title,
      url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      at,
    });
  }
  return { events, metrics };
}

/**
 * A FEED READ WITH REGULAR EXPRESSIONS, ON PURPOSE.
 *
 * NO XML LIBRARY, and this is not laziness dressed up. A parser would be a
 * dependency to audit and update on a box that pulls arbitrary URLs somebody
 * typed into a form — the class of input that has produced entity-expansion
 * and external-entity bugs in every general XML parser ever shipped. What is
 * needed here is three fields out of at most forty blocks, and a regex that
 * cannot be made to allocate a gigabyte or open a local file is the safer tool
 * for that job even though it is the cruder one.
 *
 * WHAT IT THEREFORE DOES NOT DO: namespaces, nested content, HTML inside a
 * title beyond stripping it, or anything at all with a feed whose items are
 * not `<item>` or `<entry>`. A feed it cannot read produces no events and no
 * error, which is the right failure for a blog that changed its software.
 *
 * AN ITEM WITH NO PARSEABLE DATE IS DROPPED. Stamping it with the time of the
 * fetch would put a post from 2019 at the top of the timeline as today's news.
 */
export function parseFeed(xml: string, limit = PER_SOURCE): { title: string; url: string | null; at: string | null }[] {
  const out: { title: string; url: string | null; at: string | null }[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    if (out.length >= limit) break;
    const tag = (names: string) => {
      const m = block.match(new RegExp(`<(?:[a-z0-9]+:)?(?:${names})\\b[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?(?:${names})>`, "i"));
      return m?.[1] ? stripHtml(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : "";
    };
    const title = line(tag("title"));
    if (!title) continue;
    /* Atom puts the link in an attribute of a self-closing tag; RSS puts it
       between two. The attribute is tried first because an Atom entry often
       has BOTH, and the one with the href is the real one. */
    const href = block.match(/<(?:[a-z0-9]+:)?link\b[^>]*\bhref=["']([^"']+)["']/i)?.[1];
    const url = (href ?? tag("link")).trim() || null;
    out.push({ title, url, at: iso(tag("pubDate|published|updated|date")) });
  }
  return out;
}

async function rss(url: string, warnings: string[]) {
  const events: PulledEvent[] = [];
  const body = await readText(url, `The feed at ${url}`, warnings);
  if (!body) return { events, metrics: {} as Partial<Metrics> };
  for (const item of parseFeed(body)) {
    if (!item.at) continue;
    events.push({ source: SOURCES.rss, kind: "post", title: item.title, url: item.url, at: item.at });
  }
  return { events, metrics: {} as Partial<Metrics> };
}

/* ----------------------------------------------------------------- the pull */

export type PullOutcome = { warnings: string[]; fresh: number; events: number; at: string };

/**
 * Read every public source this person has a link for, and file the answer.
 *
 * IN SERIES rather than in parallel, and the reason is not politeness. Four
 * concurrent requests would finish sooner and would also mean four sockets and
 * a burst against two hosts for every person in a sweep of thirty; in series,
 * a sweep is a slow trickle that no rate limiter notices. A pull of one person
 * takes a second or two, and nothing waits on it but the request that asked.
 *
 * A SOURCE WITH NO LINK CLEARS ITS OWN NUMBERS. Everything else is carried
 * forward from the last pull, so an outage costs freshness and not the figure.
 */
export async function pullPerson(row: WatchRow): Promise<PullOutcome> {
  const links = parseLinks(row.links);
  const warnings: string[] = [];
  const held = parseMetrics(row.metrics);
  const at = now();

  const gh = handle(links.github);
  const bsky = handle(links.bluesky);
  const hn = handle(links.hn);
  const feedUrl = (links.rss ?? "").trim();

  /* Cleared, not carried: a number about a source that is no longer on the
     card is a number about nothing. */
  const metrics: Metrics = {
    ghFollowers: gh ? held.ghFollowers : null,
    ghRepos: gh ? held.ghRepos : null,
    bskyFollowers: bsky ? held.bskyFollowers : null,
    bskyPosts: bsky ? held.bskyPosts : null,
    hnKarma: hn ? held.hnKarma : null,
    at,
  };

  const events: PulledEvent[] = [];
  const take = (r: { events: PulledEvent[]; metrics: Partial<Metrics> }) => {
    events.push(...r.events);
    for (const [k, v] of Object.entries(r.metrics))
      if (v !== undefined) (metrics as Record<string, unknown>)[k] = v;
  };

  if (gh) take(await github(gh, warnings));
  if (bsky) take(await bluesky(bsky, warnings));
  if (hn) take(await hackernews(hn, warnings));
  if (feedUrl) take(await rss(feedUrl, warnings));

  const fresh = saveEvents(row.id, events, at);
  writePull(row.id, { metrics, warnings, at });
  return { warnings, fresh, events: events.length, at };
}

/* ---------------------------------------------------------------- the sweep */

/** How stale a person's file may get before the sweep refetches it. Twenty
 *  hours rather than a day so the pull walks around the clock instead of
 *  always landing at the hour the box was last rebooted. */
export const SWEEP_AFTER_MS = 20 * 3_600_000;

/** Checked hourly, because a laptop that was shut for the night must pick the
 *  sweep up when it opens rather than at some fixed hour it slept through. */
const CHECK_EVERY_MS = 3_600_000;

/** Between people. The whole politeness budget of this feature. */
const GAP_MS = 2_000;

/** NOT unref'd, deliberately. The two timers that SCHEDULE the sweep are, so a
 *  box that wants to exit is never held open waiting for one to come round.
 *  This one is inside a sweep that is already running, and unref'ing it would
 *  let the process fall out from under a half-finished pass — leaving rows
 *  with a metrics write and no events, which is the one state this table has
 *  no way to notice. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function due(rows: WatchRow[], at = Date.now()): WatchRow[] {
  return rows.filter((r) => !r.activity_at || Date.parse(r.activity_at) < at - SWEEP_AFTER_MS);
}

/**
 * ONE LINE PER SWEEP, and only when there was a sweep.
 *
 * A timer that logged "nothing to do" every hour would push everything else
 * out of the log within a day, and the interesting fact — that four people
 * were refreshed and one source refused — is one line.
 */
export async function sweep(): Promise<{ pulled: number; warned: number }> {
  const rows = due(watchRows());
  if (!rows.length) return { pulled: 0, warned: 0 };
  let warned = 0;
  let pulled = 0;
  for (const row of rows) {
    try {
      /* Re-read: a sweep of thirty takes a minute, and the row may have been
         edited or deleted while it ran. */
      const live = watchRow(row.id);
      if (!live) continue;
      const out = await pullPerson(live);
      pulled++;
      if (out.warnings.length) warned++;
    } catch (e) {
      /* A pull that threw is one person's file, not the sweep's. */
      console.error("[people] watch pull:", row.name, say(e));
    }
    await sleep(GAP_MS);
  }
  return { pulled, warned };
}

export function startWatchSweep() {
  const tick = () => {
    void (async () => {
      try {
        const r = await sweep();
        if (r.pulled)
          console.log(
            `[people] watch sweep pulled ${r.pulled} ${r.pulled === 1 ? "person" : "people"}` +
              (r.warned ? `, ${r.warned} with a source that did not answer` : ""),
          );
      } catch (e) {
        /* onStart must not throw, and neither may a timer it started. */
        console.error("[people] watch sweep:", say(e));
      }
    })();
  };
  /* Two minutes after boot rather than at it: the box has a database to
     migrate and collectors to start, and nothing here is urgent. */
  setTimeout(tick, 120_000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}
