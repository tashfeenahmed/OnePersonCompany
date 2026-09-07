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
 * `activity_at`, `pull_warnings`, `public_bio` and one row of
 * `people_watch_history` a day, and if a public profile disagrees with what he
 * typed, what he typed stands.
 *
 * AND IT WRITES ONE KIND OF EVENT NOBODY PUBLISHED. Beside the posts and the
 * pushes, a pull files SIGNALS — "Bio changed", "GitHub followers +2,300",
 * "3 new public repos" — under the source `watch` and the kind `change`.
 * These are not things the person did; they are things this box NOTICED, by
 * holding the last pull's figures and subtracting. The distinction is carried
 * in the source rather than left to a reader, because a timeline that blurred
 * "they posted this" into "we worked this out" would be inventing quotes. The
 * thresholds are in watch.ts and every one of them needs BOTH readings: a
 * person pulled for the first time gets no signals at all, because a first
 * sighting is not a change.
 *
 * THE ONE THING THIS FILE DOWNLOADS RATHER THAN READS IS A FACE, and it does
 * so precisely so that nobody else has to be asked for it later. GitHub and
 * Bluesky both hand back an avatar URL on the profile call that is already
 * being made; the alternative to fetching those bytes here is a card that
 * points an `<img>` at somebody else's CDN, which would tell that CDN the hour
 * of every morning the owner opened a watched person's file. The picture is
 * pulled once, kept on this box, and served from loopback — see watch.ts's
 * "the face". At most seven requests per person, then, and the seventh happens
 * about once a week.
 *
 * RATE LIMITS ARE RESPECTED BY DOING VERY LITTLE. At most six requests per
 * person, once every twenty hours, two seconds apart across a sweep. GitHub's
 * anonymous budget is sixty an hour per address; a watchlist of thirty people
 * spends under a fifth of it a day.
 */
import { now } from "../../db.ts";
import {
  CHANGE_KIND,
  CHANGE_SOURCE,
  MAX_AVATAR_BYTES,
  avatarDue,
  avatarGate,
  bioSignal,
  changeKey,
  dayOf,
  handle,
  hasAvatar,
  parseLinks,
  parseMetrics,
  pickAvatar,
  repoSignal,
  saveEvents,
  spikeSignal,
  watchRow,
  watchRows,
  writeAvatar,
  writeHistory,
  writePull,
  type AvatarPick,
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

type GhUser = { followers?: unknown; public_repos?: unknown; avatar_url?: unknown; bio?: unknown };
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
  /* The address of their picture, taken off a profile call that was happening
     anyway. Nothing is downloaded here: `pullPerson` decides whether it is
     worth fetching, because the choice is between GitHub's and Bluesky's and
     neither source can make it alone. */
  let avatar: string | null = null;
  /* The sentence under their name. Read off the profile call that is already
     happening, kept only so the NEXT pull can notice it is different — see
     `bioSignal`. Nothing draws it. */
  let bio: string | null = null;

  const profile = await readJson<GhUser>(`https://api.github.com/users/${encodeURIComponent(user)}`, what, warnings);
  if (profile) {
    metrics.ghFollowers = int(profile.followers);
    metrics.ghRepos = int(profile.public_repos);
    avatar = typeof profile.avatar_url === "string" ? profile.avatar_url : null;
    bio = typeof profile.bio === "string" ? profile.bio : null;
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
  return { events, metrics, avatar, bio };
}

type BskyProfile = {
  followersCount?: unknown;
  postsCount?: unknown;
  avatar?: unknown;
  description?: unknown;
};
type BskyFeed = { feed?: { post?: { uri?: string; record?: { text?: string; createdAt?: string } } }[] };

/** Bluesky, replies excluded. A reply is half a conversation and reads as a
 *  fragment on a timeline that has none of the other half. */
async function bluesky(who: string, warnings: string[]) {
  const what = `Bluesky (${who})`;
  const events: PulledEvent[] = [];
  const metrics: Partial<Metrics> = {};
  const actor = encodeURIComponent(who);
  let avatar: string | null = null;
  /* Bluesky calls it `description`; it is the same sentence, and it is the
     fallback when there is no GitHub link to read one from. */
  let bio: string | null = null;

  const profile = await readJson<BskyProfile>(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${actor}`,
    what,
    warnings,
  );
  if (profile) {
    metrics.bskyFollowers = int(profile.followersCount);
    metrics.bskyPosts = int(profile.postsCount);
    /* Absent on an account that never set one, which is a real answer and not
       a failure — it simply loses to GitHub, or leaves the card with initials. */
    avatar = typeof profile.avatar === "string" ? profile.avatar : null;
    bio = typeof profile.description === "string" ? profile.description : null;
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
  return { events, metrics, avatar, bio };
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

/* ----------------------------------------------------------------- the face */

/**
 * READ A BODY UNTIL THE CAP SAYS STOP, and one byte past it so the caller can
 * tell "exactly at the limit" from "over it".
 *
 * THE CAP IS ON THE STREAM AND NOT ON `content-length`. That header is a claim
 * by a server this box did not write: it can be absent on a chunked response,
 * it can be wrong, and it can be a small number in front of a very large body.
 * Counting what actually arrives is the only version of this that bounds
 * memory, and bounding memory is the entire point of a cap on a fetch of an
 * address somebody else supplied.
 */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let n = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      n += value.length;
      if (n > cap) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/**
 * FETCH ONE FACE AND STORE IT, OR SAY IN ONE SENTENCE WHY NOT.
 *
 * A FAILURE HERE IS A WARNING AND NEVER AN ERROR, and it must never cost the
 * bytes already held. A picture is the least important thing on a watched
 * person's file — the numbers, the timeline and the dossiers are what the page
 * is for — so a 404 from somebody's CDN pushes a sentence into `warnings` and
 * the pull carries on with the face it already had. Throwing from here would
 * lose a whole pull over a profile photograph.
 *
 * REDIRECTS ARE FOLLOWED because both of the sources that produce these URLs
 * use them: GitHub's avatar host redirects between its own buckets, and
 * Bluesky's CDN redirects by blob reference. `avatar_source` records the
 * address that was ASKED FOR rather than the one that answered, so a CDN that
 * shuffles its own storage does not read as the person changing their picture.
 */
async function fetchAvatar(
  personId: string,
  face: AvatarPick,
  warnings: string[],
  at: string,
): Promise<boolean> {
  const failed = (why: string) =>
    warnings.push(`Avatar from ${face.from} could not be fetched: ${why}.`);
  try {
    const res = await fetch(face.url, {
      redirect: "follow",
      headers: { Accept: "image/*", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      failed(`HTTP ${res.status}`);
      return false;
    }
    const bytes = await readCapped(res, MAX_AVATAR_BYTES);
    const gate = avatarGate(res.headers.get("content-type"), bytes.length);
    if ("error" in gate) {
      failed(gate.error);
      return false;
    }
    writeAvatar(personId, { source: face.url, mime: gate.mime, bytes, at });
    return true;
  } catch (e) {
    failed(say(e));
    return false;
  }
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

  let ghFace: string | null = null;
  let bskyFace: string | null = null;
  /* GitHub's wins where there is one, Bluesky's is the fallback — one held
     sentence per person, because "how they describe themselves changed" does
     not become two facts because there are two places to read it. */
  let ghBio: string | null = null;
  let bskyBio: string | null = null;
  if (gh) {
    const r = await github(gh, warnings);
    take(r);
    ghFace = r.avatar;
    ghBio = r.bio;
  }
  if (bsky) {
    const r = await bluesky(bsky, warnings);
    take(r);
    bskyFace = r.avatar;
    bskyBio = r.bio;
  }
  if (hn) take(await hackernews(hn, warnings));
  if (feedUrl) take(await rss(feedUrl, warnings));

  /*
    THE FACE, AND IT IS THE ONE PART OF A PULL THAT USUALLY DOES NOTHING.
    GitHub's URL wins, Bluesky's is second, and the address an import wrote
    down is the fallback for somebody with neither link — see `pickAvatar`.
    `avatarDue` then refuses to download anything unless the address changed,
    the bytes are missing, or the copy has stood a week, so the common case is
    two comparisons and no traffic at all. No link and no source is no picture:
    nothing is invented and nothing already stored is thrown away.
  */
  const face = pickAvatar({ github: ghFace, bluesky: bskyFace, imported: row.avatar_source });
  if (
    face &&
    avatarDue({ source: row.avatar_source, at: row.avatar_at, stored: hasAvatar(row.id) }, face.url)
  )
    await fetchAvatar(row.id, face, warnings, at);

  /*
    TODAY'S POINT ON THE SERIES, written before the signals are worked out and
    regardless of what any of it says. A pull that reached nobody still writes
    a row of nulls: the row is the record that the box LOOKED, and a series
    with a gap in it cannot be told apart from a series where nothing happened.
    One row per day, replaced if today already has one — see the 116 migration.
  */
  const day = dayOf(at);
  writeHistory(row.id, {
    day,
    at,
    ghFollowers: metrics.ghFollowers,
    ghRepos: metrics.ghRepos,
    bskyFollowers: metrics.bskyFollowers,
    bskyPosts: metrics.bskyPosts,
    hnKarma: metrics.hnKarma,
  });

  /*
    THE SIGNALS — what MOVED, said as a sentence and filed on the timeline
    beside the things this person actually published.

    MEASURED AGAINST THE PREVIOUS PULL (`held`) AND NOT AGAINST THE SERIES.
    The series is one row a day and today's row has already been overwritten by
    the numbers above; comparing against it would be comparing today with
    today. `held` is what the row said before this function touched it, which
    is the last reading whatever hour it was taken at.

    A CARRIED-FORWARD FIGURE CANNOT PRODUCE ONE, and that falls out for free:
    a source that failed leaves `metrics.x` equal to `held.x`, so the
    difference is zero and every rule below stays quiet. An outage costs
    freshness and never invents an event.

    THE SOURCE IS `watch` AND THE KIND IS `change`. Nobody published any of
    these — they exist because this box held last week's reading and compared,
    and a reader must be able to tell that from a post. The key carries the DAY
    (see `changeKey`), so the refresh button pressed four times in an afternoon
    files each sentence once.
  */
  const signal = (raw: string) => {
    const title = line(raw, 200);
    events.push({
      source: CHANGE_SOURCE,
      kind: CHANGE_KIND,
      title,
      url: null,
      at,
      key: changeKey(title, day),
    });
  };

  const bio = (ghBio ?? "").trim() || (bskyBio ?? "").trim() || null;
  const changed = bioSignal(bio, row.public_bio);
  if (changed) signal(changed);
  for (const [label, current, before] of [
    ["GitHub followers", metrics.ghFollowers, held.ghFollowers],
    ["Bluesky followers", metrics.bskyFollowers, held.bskyFollowers],
    ["HN karma", metrics.hnKarma, held.hnKarma],
  ] as const) {
    const moved = spikeSignal(label, current, before);
    if (moved) signal(moved);
  }
  const repos = repoSignal(metrics.ghRepos, held.ghRepos);
  if (repos) signal(repos);

  const fresh = saveEvents(row.id, events, at);
  writePull(row.id, { metrics, warnings, at, bio });
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

/**
 * WHEN A ROW WAS LAST PULLED, as a number, or null for "never".
 *
 * NULL FOR AN UNPARSEABLE STAMP AS WELL AS FOR A MISSING ONE, and that is not
 * pedantry — it is the bug this function exists to make impossible. Comparing
 * a NaN against anything is false, so `Date.parse(junk) < cutoff` answers
 * "not due", and a single row whose `activity_at` was written by hand or by a
 * half-finished import would drop out of every sweep from then on, silently,
 * for as long as the box ran. A stamp nobody can read is exactly as good as no
 * stamp at all: pull them.
 */
const pulledAt = (row: { activity_at: string | null }): number | null => {
  if (!row.activity_at) return null;
  const t = Date.parse(row.activity_at);
  return Number.isFinite(t) ? t : null;
};

export function due(rows: WatchRow[], at = Date.now()): WatchRow[] {
  return rows.filter((r) => {
    const when = pulledAt(r);
    return when === null || when < at - SWEEP_AFTER_MS;
  });
}

/**
 * WHERE THE SWEEP HAS GOT TO, FOR THE WHOLE LIST AT ONCE — the answer to
 * "pulled for everyone 3h ago · next in 17h".
 *
 * `lastAt` IS THE OLDEST STAMP ON THE LIST AND NOT THE NEWEST, and this is the
 * one decision in here worth arguing about. The newest is trivially "a few
 * seconds ago" the instant any single person is refreshed, which would let a
 * page say "pulled 10 seconds ago" while nine of ten people had not been read
 * since Tuesday. The oldest is the moment by which EVERYBODY had been read,
 * which is the only thing a list-level stamp can honestly claim.
 *
 * IT IS NULL UNLESS EVERYBODY HAS BEEN PULLED, for the same reason: with one
 * never-pulled row there is no instant at which the list was ever complete,
 * and quoting the oldest of the rest would be a claim about people the
 * sentence was not counting.
 *
 * `nextDueAt` IS NULL WHEN SOMEBODY IS DUE ALREADY rather than a stamp in the
 * past. "Next in −4h" is not a sentence; "somebody is due now" is, and it is
 * also true for the ordinary case of a box that has just booted and has not
 * reached its first sweep yet.
 *
 * AN EMPTY WATCHLIST IS NOT "everyone has been pulled". It is vacuously true
 * and reads as a lie on a page, so it answers false with two nulls: nothing
 * has been pulled, because there is nobody.
 */
export type SweepState = {
  lastAt: string | null;
  nextDueAt: string | null;
  everyonePulled: boolean;
};

export function sweepState(rows: { activity_at: string | null }[], at = Date.now()): SweepState {
  if (!rows.length) return { lastAt: null, nextDueAt: null, everyonePulled: false };
  let oldest = Infinity;
  let everyonePulled = true;
  for (const row of rows) {
    const when = pulledAt(row);
    if (when === null) everyonePulled = false;
    else if (when < oldest) oldest = when;
  }
  if (!everyonePulled || !Number.isFinite(oldest))
    return { lastAt: null, nextDueAt: null, everyonePulled: false };
  const next = oldest + SWEEP_AFTER_MS;
  return {
    lastAt: new Date(oldest).toISOString(),
    nextDueAt: next > at ? new Date(next).toISOString() : null,
    everyonePulled: true,
  };
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

/**
 * ONE SWEEP AT A TIME.
 *
 * The hourly timer does not know how long the last tick took, and a long list
 * of slow sources can take the better part of an hour: six requests a person
 * at a twelve-second timeout, two seconds apart. A second sweep starting on
 * top of the first would re-read people the first one has already reached —
 * `due()` is evaluated once, at the start — spending somebody else's rate
 * limit twice to write the same row. The flag is cleared in a `finally` so a
 * sweep that throws does not switch the timer off for the life of the process.
 */
let sweeping = false;

export function startWatchSweep() {
  const tick = () => {
    if (sweeping) return;
    sweeping = true;
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
      } finally {
        sweeping = false;
      }
    })();
  };
  /* Two minutes after boot rather than at it: the box has a database to
     migrate and collectors to start, and nothing here is urgent. */
  setTimeout(tick, 120_000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}
