/**
 * THE WATCHLIST — the people the owner is keeping an eye on, and the dossiers
 * written about them.
 *
 * THIS IS THE ONE TABLE IN THIS AREA NOBODY COLLECTS. Contacts are a fold of
 * Gmail headers, commitments a fold of the owner's own sent mail, the brief a
 * fold of both. This list is typed. No scan can add a row to it, no timer can
 * refresh one, and a name on it does not become more or less true because the
 * mailbox went quiet. Most of these people have never written to the owner at
 * all — an investor worth reading up on, a founder in the same market, the
 * person on the other side of a deal — and that is exactly why the list is not
 * a filter over people_contacts: "who do I correspond with" and "who am I
 * watching" are two questions, and the second one's answer is mostly people
 * the first one has never heard of.
 *
 * THE NAME IS THE ONLY REQUIRED FIELD, and it is also the join. A dossier's
 * title comes out of `dossierTitle`, which takes the first naming clause of a
 * brief — so a dispatch whose brief begins with the person's name produces
 * `Dossier — <name>`, and every later dossier on the same person produces the
 * same string. That string is the whole of the tie between this month's
 * dossier and last month's, in the runs area as much as here. `attaches` is
 * the rule in one place, exported so the client draws the same set of runs on
 * a person's card as this file counts.
 *
 * NOTHING DERIVED IS STORED. The dossier record — how many, whether one is
 * running, when the last one went in — is counted out of `agent_runs` on every
 * read, for the same reason contacts.ts computes temperature on the read: a
 * stored count is wrong the moment a run finishes, and it would outlive a run
 * that was deleted. The cost is one indexed scan of the dossier runs per list
 * request, which is a table of tens.
 *
 * A DISPATCH FROM HERE IS THE SAME DISPATCH AS EVERYWHERE ELSE. This file
 * composes a brief and hands it to `dispatch()` in the subagents area — it
 * does not insert a run. A second INSERT would skip the switched-off check,
 * the standing instructions and the session filing, and would produce runs
 * that look like the People Analyst's and were never given to it.
 *
 * DELETING A WATCH ROW DELETES NO RUN. Taking somebody off the list is losing
 * interest in them; it is not a claim that the reports were never written, and
 * the ledger is the box's record rather than this list's property. Its EVENTS
 * do die with it, and the asymmetry is the point: a dossier is work this box
 * did, an event is a copy of somebody else's public timeline.
 *
 * ONE THING HAS CHANGED SINCE THAT FIRST PARAGRAPH WAS WRITTEN, and it is
 * worth stating rather than quietly amending. The LIST is still typed — no
 * scan adds a row, no timer invents a name — but a row now has a second half
 * that IS collected: follower counts, karma, and a timeline of public posts
 * and pushes, in `metrics`, `people_watch_events` and `activity_at`. The two
 * halves never touch. Nothing pulled can write `name`, `company`, `role`,
 * `email` or `note`, and nothing typed is overwritten by a pull — including
 * on import, where an existing non-empty field always wins. Read a blank
 * identity line as "he did not write it down" and a null metric as "not
 * known"; neither is ever a measurement of the person.
 */
import { createHash } from "node:crypto";
import { db, now } from "../../db.ts";
import { people, type Person } from "./contacts.ts";
import { shapeRun, type RunRow } from "../runs/store.ts";
import { dispatch, type DispatchBody } from "../subagents/routes.ts";
import { ensureTeam, subagentId, subagentRow } from "../subagents/store.ts";

/** The identity lines. Short on purpose: this is a card, not a CRM record —
 *  anything longer than a line belongs in the note or in a dossier. */
export const MAX_NAME = 120;
export const MAX_EMAIL = 200;
export const MAX_NOTE = 4000;
export const MAX_LINK = 500;

/** The tags. Twelve of forty characters is a shelf label — "investor",
 *  "ai", "same market" — and not a second note: a person carrying thirty of
 *  them has been described rather than filed. */
export const MAX_TAGS = 12;
export const MAX_TAG = 40;

/**
 * THE NINE PLACES, AND NO TENTH.
 *
 * A closed list rather than a free-form map because these are what a dossier
 * run is told to go and read, and an open map would let a caller put anything
 * at all into a brief handed to an agent with a browser. Unknown keys are
 * DROPPED rather than refused: the client's fields and this list will drift by
 * one for as long as it takes to deploy both halves, and a 400 in that window
 * would lose the whole edit rather than the one field nobody here knows.
 *
 * FOUR OF THE NINE ARE NOW ALSO ADDRESSES THIS BOX ITSELF READS. `github`,
 * `bluesky`, `hn` and `rss` are what activity.ts pulls a public timeline from,
 * which is why they are worth their own keys rather than a line in the note —
 * and why `handle()` exists below. The other five are still only ever quoted
 * into a brief: there is no keyless public API behind X, LinkedIn, Substack, a
 * YouTube channel or somebody's own site, and a watchlist that needed a token
 * for each would stop working one credential at a time.
 */
export const LINK_KEYS = [
  "website",
  "github",
  "x",
  "linkedin",
  "bluesky",
  "hn",
  "rss",
  "substack",
  "youtube",
] as const;
export type LinkKey = (typeof LINK_KEYS)[number];
export type Links = Partial<Record<LinkKey, string>>;

/** How each link is labelled in a brief. Sentence-cased the way a person
 *  writes them, because the brief is read by a model as prose. */
const LINK_LABEL: Record<LinkKey, string> = {
  website: "Website",
  github: "GitHub",
  x: "X",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
  hn: "Hacker News",
  rss: "RSS",
  substack: "Substack",
  youtube: "YouTube",
};

/**
 * THE HANDLE INSIDE WHATEVER WAS TYPED.
 *
 * STORED AS TYPED, USED NORMALISED, and the split is the whole point. What the
 * owner writes in the GitHub box is his own note about where to find somebody
 * — "@t3dotgg", "https://github.com/pc", "karpathy" are all the same fact
 * written three ways — and rewriting his field on save would be this box
 * arguing with him about his own notes. But `api.github.com/users/@t3dotgg`
 * is a 404, so the moment the string is used as an ARGUMENT it has to be one
 * shape.
 *
 * The rule: drop a query string, drop a scheme, and where anything is left
 * with a slash in it take the LAST segment — which is the user in
 * github.com/pc, in x.com/theo/ and in bsky.app/profile/karpathy.bsky.social
 * alike. A bare string with no slash is returned as it stands minus any
 * leading @, because a Bluesky handle IS a hostname ("t3.gg") and a rule that
 * stripped hostnames would eat it.
 */
export function handle(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  /* A tracking parameter is not part of a name. */
  const bare = trimmed.split(/[?#]/)[0]!.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const parts = bare.split("/").filter((p) => p.trim());
  const last = parts.length > 1 ? parts[parts.length - 1]! : (parts[0] ?? "");
  return last.replace(/^@+/, "").trim();
}

export type WatchRow = {
  id: string;
  name: string;
  company: string;
  role: string;
  email: string;
  note: string;
  links: string;
  /** JSON string[]. */
  tags: string;
  /** JSON, and every figure in it nullable — see `Metrics`. */
  metrics: string;
  /** When the last pull RAN. NULL is "never pulled", which is a different
   *  thing from "pulled and found nothing". */
  activity_at: string | null;
  /** JSON string[] — what the last pull could not read. */
  pull_warnings: string;
  /** WHERE THE STORED FACE CAME FROM, or NULL for "nobody here has ever had
   *  an address to try". An address, never a picture — the bytes are in
   *  `people_watch_avatars`. */
  avatar_source: string | null;
  /** When those bytes were read. NULL alongside a non-null `avatar_source` is
   *  an import that recorded a URL and a pull that has not run yet. */
  avatar_at: string | null;
  created_at: string;
  updated_at: string;
};

export type EventRow = {
  person_id: string;
  key: string;
  source: string;
  kind: string;
  title: string;
  url: string | null;
  at: string;
  first_seen_at: string;
};

export type WatchEvent = {
  key: string;
  source: string;
  kind: string;
  title: string;
  url: string | null;
  at: string;
  firstSeenAt: string;
};

/**
 * THE TRACKED NUMBERS, AND EVERY ONE OF THEM MAY BE null.
 *
 * NULL IS "NOT KNOWN" AND IS NEVER 0. There is no GitHub link on the row, or
 * there is one and the API did not answer — either way nobody here knows the
 * number, and a 0 would be a claim that they have no followers. An account
 * that genuinely has none reports 0, and the two must stay distinguishable or
 * the card lies about the quietest people on it.
 *
 * `at` IS WHEN THE PULL RAN, not when each figure was read. A source that
 * failed leaves the number it last gave standing — blanking a known figure
 * because a public API was down would be the page going empty over somebody
 * else's outage — and says so in `pullWarnings`.
 */
export type Metrics = {
  ghFollowers: number | null;
  ghRepos: number | null;
  bskyFollowers: number | null;
  bskyPosts: number | null;
  hnKarma: number | null;
  at: string | null;
};

export const NO_METRICS: Metrics = {
  ghFollowers: null,
  ghRepos: null,
  bskyFollowers: null,
  bskyPosts: null,
  hnKarma: null,
  at: null,
};

export type DossierRecord = {
  /** DONE runs only. A dossier that failed is not a dossier. */
  count: number;
  running: boolean;
  queued: number;
  /** The newest by `queued_at` WHATEVER its status — including a failure,
   *  which is the state a reader most needs to see. */
  last: { id: string; status: string; finishedAt: string | null; queuedAt: string } | null;
};

export type WatchPerson = {
  id: string;
  name: string;
  company: string;
  role: string;
  email: string;
  note: string;
  links: Links;
  /** His own shelf labels. Not a taxonomy and not derived from anything. */
  tags: string[];
  metrics: Metrics;
  /** When the public sources were last read. NULL means never. */
  activityAt: string | null;
  /**
   * EVENTS THIS BOX FIRST SAW IN THE LAST SEVEN DAYS — which is NOT the same
   * as events that happened in the last seven days, and the difference is the
   * whole reason `first_seen_at` is a column. A person pulled for the first
   * time has a timeline going back years and all of it is new TO THIS BOX, so
   * the number reads high on the day they are added. That is what it measures
   * — what changed here — and it must never be reported as "they published 40
   * things this week".
   */
  newEvents: number;
  /**
   * A RELATIVE URL ON THIS BOX, or null.
   *
   * `/api/people/watch/<id>/avatar`, and never the address the picture came
   * from. A page handed `https://avatars.githubusercontent.com/…` would draw
   * the same face and would also tell GitHub every time the owner opened this
   * person's file — which is a record of his attention, held by somebody else,
   * about somebody he is quietly watching. The bytes are fetched once by the
   * pull and served from here; see `AVATAR_PATH`.
   *
   * NULL IS "NO FACE STORED" and it is the ordinary answer for anybody with no
   * GitHub or Bluesky link, anybody imported without one, and anybody who has
   * never been pulled. It is never a claim that the person has no photograph.
   */
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
  dossiers: DossierRecord;
};

/* ------------------------------------------------------------------ the id */

/** `pw-` and six characters of base 36, minted until one is free — the shape
 *  and the loop `mintRunId` uses, for the same reason: an id the owner can
 *  read out loud, and no sequence anybody can count rows off. */
export function mintWatchId(): string {
  for (;;) {
    const id = `pw-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!watchRow(id)) return id;
  }
}

/* -------------------------------------------------------------- the joining */

/** What `dossierTitle` puts in front of the person. Written once here rather
 *  than matched loosely, because a title that does not start with it is a
 *  title from somewhere else and is compared whole. */
const TITLE_PREFIX = "Dossier — ";

/**
 * DOES THIS RUN'S TITLE NAME THIS PERSON?
 *
 * ONE FUNCTION, EXPORTED, because the client draws the same set of runs on a
 * person's card that this file counts into `dossiers`. Two copies of this rule
 * would disagree the first time either was tightened, and the disagreement
 * would look like a missing dossier rather than like a bug.
 *
 * The comma case is the whole of why this is not an equality test.
 * `dossierTitle` deliberately KEEPS the qualifying clause — "Jane Doe, founder
 * of Acme" is how one Jane Doe is told from another, and it is what the run
 * shelf groups by — so a watch row named "Jane Doe" must still find the
 * dossiers filed under the longer form. The prefix must end at a COMMA and
 * nowhere else: matching on `startsWith(name)` alone would attach every
 * dossier on "Jane Doe-Smith" to Jane Doe.
 */
export function attaches(title: string, name: string): boolean {
  const who = (title.startsWith(TITLE_PREFIX) ? title.slice(TITLE_PREFIX.length) : title)
    .trim()
    .toLowerCase();
  const person = name.trim().toLowerCase();
  if (!person) return false;
  return who === person || who.startsWith(`${person},`);
}

type DossierRunRow = {
  id: string;
  title: string;
  status: string;
  queued_at: string;
  finished_at: string | null;
};

/**
 * Every portfolio-wide dossier run, newest first.
 *
 * `venture_id IS NULL` is not a tidiness filter: the People Analyst belongs to
 * no venture, and a dossier filed under one is a different kind of run — the
 * run app's own form can start one against a venture — which this list has no
 * claim on. Read once per request and filtered in JavaScript rather than
 * joined per person, because `attaches` is the rule and it is not SQL.
 */
function dossierRuns(): DossierRunRow[] {
  return db
    .prepare(
      `SELECT id, title, status, queued_at, finished_at
         FROM agent_runs
        WHERE kind = 'dossier' AND venture_id IS NULL
        ORDER BY queued_at DESC`,
    )
    .all() as unknown as DossierRunRow[];
}

/** The record for one person out of an already-read list of runs. */
function record(runs: DossierRunRow[], name: string): DossierRecord {
  const mine = runs.filter((r) => attaches(r.title, name));
  /* `dossierRuns` is ordered newest first, so the first match is the newest —
     whatever became of it. A `last` that skipped failures would answer "the
     last dossier finished in March" on a person whose three attempts since
     have all broken, which is the one thing a reader needs to know. */
  const last = mine[0] ?? null;
  return {
    count: mine.filter((r) => r.status === "done").length,
    running: mine.some((r) => r.status === "running"),
    queued: mine.filter((r) => r.status === "queued").length,
    last: last
      ? { id: last.id, status: last.status, finishedAt: last.finished_at, queuedAt: last.queued_at }
      : null,
  };
}

/* ---------------------------------------------------------------- the store */

export function watchRow(id: string): WatchRow | undefined {
  return db.prepare("SELECT * FROM people_watch WHERE id = ?").get(id) as WatchRow | undefined;
}

export function watchRows(): WatchRow[] {
  return db.prepare("SELECT * FROM people_watch").all() as unknown as WatchRow[];
}

/** The duplicate check, and it is case-insensitive because "jane doe" and
 *  "Jane Doe" are one person with two dossier piles otherwise — the join is on
 *  the name, so a second row under a different casing would silently split the
 *  record in half. `exceptId` lets a rename keep its own row. */
export function watchByName(name: string, exceptId?: string): WatchRow | undefined {
  const wanted = name.trim().toLowerCase();
  return watchRows().find((r) => r.name.trim().toLowerCase() === wanted && r.id !== exceptId);
}

/**
 * The JSON columns, each read defensively and each answering EMPTY rather than
 * throwing. A row whose JSON will not parse is a row somebody edited with a
 * shell; taking the whole list down over it would be the page going blank on
 * one bad field, which is the failure mode this codebase spends its comments
 * arguing against.
 */
export function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v !== "string") continue;
      const t = v.trim().slice(0, MAX_TAG);
      /* Case-folded uniqueness: "AI" and "ai" are one shelf. The first
         spelling wins, because it is the one he typed first. */
      if (t && !out.some((held) => held.toLowerCase() === t.toLowerCase())) out.push(t);
    }
    return out.slice(0, MAX_TAGS);
  } catch {
    return [];
  }
}

export function parseMetrics(raw: string): Metrics {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p !== "object" || p === null || Array.isArray(p)) return { ...NO_METRICS };
    return {
      ghFollowers: num(p.ghFollowers),
      ghRepos: num(p.ghRepos),
      bskyFollowers: num(p.bskyFollowers),
      bskyPosts: num(p.bskyPosts),
      hnKarma: num(p.hnKarma),
      at: typeof p.at === "string" && p.at ? p.at : null,
    };
  } catch {
    return { ...NO_METRICS };
  }
}

export function parseWarnings(raw: string): string[] {
  try {
    const p = JSON.parse(raw) as unknown;
    return Array.isArray(p) ? p.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function parseLinks(raw: string): Links {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Links = {};
    for (const key of LINK_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) out[key] = v.trim();
    }
    return out;
  } catch {
    /* A row whose JSON will not parse is a row somebody edited with a shell.
       No links is the honest answer; throwing would take the whole list down
       over one field nothing depends on. */
    return {};
  }
}

/* ------------------------------------------------------------------ the face */

/**
 * THE PICTURE IS FETCHED ONCE AND SERVED FROM HERE. IT IS NEVER HOTLINKED.
 *
 * This is the only rule in this section and everything else follows from it. A
 * card that drew `<img src="https://avatars.githubusercontent.com/u/6983">`
 * would look identical, cost this box nothing, and hand GitHub a hit every
 * time the owner opened Patrick Collison's file — the hour, the frequency, the
 * address it came from. On a feature whose whole subject is people he is
 * quietly keeping an eye on, that is his attention logged by a third party. So
 * the pull downloads the bytes on the box's own schedule and every reader is
 * sent to `/api/people/watch/<id>/avatar`, which is loopback.
 *
 * THE CONSEQUENCE, STATED PLAINLY: a face can be up to a week out of date, and
 * a person nobody has pulled has none at all. Both are cheap next to the
 * alternative.
 */

/** Two megabytes. An avatar is tens of kilobytes; anything at this size is
 *  either not an avatar or is something being pushed at this box, and the cap
 *  is enforced on the STREAM rather than on a `content-length` a server is
 *  free to lie about. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** How long a stored face stands before the pull looks again. Seven days
 *  rather than every pull, because the source URL almost never changes and
 *  re-downloading the same 40 KB every twenty hours would be this box making
 *  traffic to learn nothing. A person who changes their photo AND keeps the
 *  same URL is a week late; a person who changes it and gets a new URL — which
 *  is what GitHub and Bluesky both do — is picked up on the next pull. */
export const AVATAR_FRESH_MS = 7 * 86_400_000;

/** Where a stored face is read from. RELATIVE, so it is right behind whatever
 *  hostname or tunnel the client reached this box through. */
export const AVATAR_PATH = (id: string): string => `/api/people/watch/${id}/avatar`;

export type AvatarRow = {
  person_id: string;
  mime: string;
  bytes: Uint8Array;
  fetched_at: string;
};

export function avatarRow(personId: string): AvatarRow | undefined {
  return db.prepare("SELECT * FROM people_watch_avatars WHERE person_id = ?").get(personId) as
    | AvatarRow
    | undefined;
}

/**
 * WHO HAS BYTES STORED — the whole list in one query, for the reason
 * `newEventCounts` is one query. The list is a table of tens and shaping one
 * person must not reach into the database on its own, or drawing a page
 * becomes N+1 the next time somebody adds a field.
 *
 * Only the ids are read. `SELECT person_id` rather than `SELECT *` is not
 * tidiness here: the rows are images, and the whole store would otherwise be
 * loaded into memory to answer a question about which keys exist.
 */
export function avatarIds(): Set<string> {
  const rows = db.prepare("SELECT person_id FROM people_watch_avatars").all() as unknown as {
    person_id: string;
  }[];
  return new Set(rows.map((r) => r.person_id));
}

export function hasAvatar(personId: string): boolean {
  return !!db.prepare("SELECT 1 FROM people_watch_avatars WHERE person_id = ?").get(personId);
}

/**
 * WHICH ADDRESS THE FACE COMES FROM, AND WHAT TO CALL IT IN A WARNING.
 *
 * GITHUB FIRST, THEN BLUESKY, THEN WHATEVER AN IMPORT WROTE DOWN, and the
 * order is an argument rather than an accident. A GitHub avatar is the one
 * most of the people on this list actually maintain — it is on their commits,
 * their profile and their releases — and it is the one a reader is most likely
 * to recognise. Bluesky is second because a person with both usually keeps the
 * same face on each, and where they differ the professional one is the one
 * this list wants. The imported URL is LAST and is a fallback rather than a
 * source: it is a third party's record of where somebody's picture used to be,
 * and a live profile read this minute beats it every time.
 *
 * IT IS ALSO WHY THE IMPORTED URL IS NOT DISCARDED once a link exists. A
 * GitHub source that fails to answer THIS pull yields nothing, and falling
 * back to the address already on the row is how the face survives an outage
 * instead of disappearing over one.
 *
 * NON-HTTP ADDRESSES ARE REFUSED. A `data:` or `file:` URL in this position
 * would be a source somebody typed pointing the fetcher at this box's own
 * disk, and there is no shape of avatar URL for which that is the right
 * answer.
 */
export type AvatarPick = { url: string; from: "GitHub" | "Bluesky" | "the import" };

const webUrl = (raw: string | null | undefined): string | null => {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return /^https?:\/\/\S+$/i.test(v) ? v : null;
};

export function pickAvatar(candidates: {
  github?: string | null;
  bluesky?: string | null;
  imported?: string | null;
}): AvatarPick | null {
  const gh = webUrl(candidates.github);
  if (gh) return { url: gh, from: "GitHub" };
  const bsky = webUrl(candidates.bluesky);
  if (bsky) return { url: bsky, from: "Bluesky" };
  const held = webUrl(candidates.imported);
  if (held) return { url: held, from: "the import" };
  return null;
}

/**
 * IS IT WORTH DOWNLOADING THIS AGAIN?
 *
 * THREE REASONS AND NO FOURTH: the address changed, there are no bytes to
 * show, or the ones there are have stood a week. Everything else — a pull that
 * ran an hour ago, a page somebody refreshed, a sweep that came round again —
 * gets the stored copy, because the picture is the one part of a person's file
 * that essentially never changes and re-fetching it on every pull would turn a
 * privacy measure into a traffic generator.
 */
export function avatarDue(
  held: { source: string | null; at: string | null; stored: boolean },
  wanted: string,
  at = Date.now(),
): boolean {
  if (!held.stored) return true;
  if (held.source !== wanted) return true;
  const when = held.at ? Date.parse(held.at) : NaN;
  return !Number.isFinite(when) || when < at - AVATAR_FRESH_MS;
}

/**
 * IS WHAT CAME BACK AN IMAGE, AND IS IT A SANE SIZE?
 *
 * PURE, AND SEPARATE FROM THE FETCH, so the rule can be checked exactly rather
 * than by pointing the box at a hostile server. It refuses on the content type
 * rather than by sniffing the bytes because this answer is served straight
 * back out again with the type the source declared: storing a `text/html`
 * error page under `image/png` would be this box laundering somebody else's
 * 404 into an image tag.
 *
 * The parameters are separated by `;` — `image/jpeg; charset=binary` is a real
 * header — and the mime is lower-cased, because it is compared and it is
 * stored.
 */
export function avatarGate(
  contentType: string | null | undefined,
  size: number,
): { mime: string } | { error: string } {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!mime.startsWith("image/"))
    return {
      error: mime
        ? `it answered ${mime}, which is not an image`
        : "it did not say what kind of file it was sending",
    };
  if (size <= 0) return { error: "it answered an empty body" };
  if (size > MAX_AVATAR_BYTES)
    return { error: `it is larger than ${MAX_AVATAR_BYTES / 1024 / 1024} MB` };
  return { mime };
}

/**
 * Store the bytes and stamp the row, in one call.
 *
 * ONLY EVER ON SUCCESS. A pull that could not read the picture leaves both the
 * blob and `avatar_source` exactly as they were, so the face already on the
 * card survives GitHub having a bad afternoon — the same rule the metrics
 * follow, and for the same reason. Leaving `avatar_source` alone is also what
 * makes the next pull try again rather than record the failure as the current
 * state of affairs.
 *
 * `updated_at` IS NOT TOUCHED. It answers "when did he last change this card",
 * and a sweep at four in the morning bumping it would destroy the only signal
 * that column carries.
 */
export function writeAvatar(
  personId: string,
  face: { source: string; mime: string; bytes: Uint8Array; at: string },
): void {
  db.prepare(
    `INSERT INTO people_watch_avatars (person_id, mime, bytes, fetched_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET
       mime = excluded.mime, bytes = excluded.bytes, fetched_at = excluded.fetched_at`,
  ).run(personId, face.mime, face.bytes, face.at);
  db.prepare("UPDATE people_watch SET avatar_source = ?, avatar_at = ? WHERE id = ?").run(
    face.source,
    face.at,
    personId,
  );
}

/** How long an event stays "new". A week rather than a day because the sweep
 *  runs every twenty hours and a badge that emptied overnight would only ever
 *  be seen by somebody who happened to look the same morning. */
export const NEW_FOR_DAYS = 7;

/**
 * How many events each person has first seen inside the window — counted for
 * the WHOLE LIST in one grouped query rather than once per card.
 *
 * The list is a table of tens and the events a table of thousands; a per-row
 * COUNT would be tens of index scans to draw one page. Passed into `shape` the
 * same way `dossierRuns()` is, for the same reason: the shaping of one person
 * must not reach into the database on its own or the list becomes N+1 by
 * accident the next time somebody adds a field.
 */
export function newEventCounts(at = Date.now()): Map<string, number> {
  const since = new Date(at - NEW_FOR_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT person_id, COUNT(*) AS n
         FROM people_watch_events
        WHERE first_seen_at >= ?
        GROUP BY person_id`,
    )
    .all(since) as unknown as { person_id: string; n: number }[];
  return new Map(rows.map((r) => [r.person_id, Number(r.n)]));
}

/**
 * `faces` IS PASSED IN FOR THE REASON `fresh` IS — one query for the whole
 * list rather than one per card. It is optional so that a caller shaping a
 * single person need not build a set of one, and the fallback is a lookup
 * rather than `false`: a missing set must not quietly become "this person has
 * no picture", which is a WRONG ANSWER rather than a slow one.
 */
export function shape(
  row: WatchRow,
  runs: DossierRunRow[],
  fresh?: Map<string, number>,
  faces?: Set<string>,
): WatchPerson {
  const stored = faces ? faces.has(row.id) : hasAvatar(row.id);
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    role: row.role,
    email: row.email,
    note: row.note,
    links: parseLinks(row.links),
    tags: parseTags(row.tags),
    metrics: parseMetrics(row.metrics),
    activityAt: row.activity_at,
    newEvents: fresh?.get(row.id) ?? 0,
    /* The relative path only where there is something to serve. A URL that
       404s is worse than a null: a null is a card that draws initials, a 404
       is a broken image on every row of the list. */
    avatar: stored ? AVATAR_PATH(row.id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dossiers: record(runs, row.name),
  };
}

/** The whole list, sorted by name the way a person reads one — case-folded,
 *  so "adam" does not sort after "Zoe" the way a byte comparison would. */
export function watchList(): WatchPerson[] {
  const runs = dossierRuns();
  const fresh = newEventCounts();
  const faces = avatarIds();
  return watchRows()
    .map((r) => shape(r, runs, fresh, faces))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

export function watchPerson(id: string): WatchPerson | null {
  const row = watchRow(id);
  return row ? shape(row, dossierRuns(), newEventCounts(), avatarIds()) : null;
}

export function insertWatch(fields: {
  name: string;
  company: string;
  role: string;
  email: string;
  note: string;
  links: Links;
  tags?: string[];
  /** An address to try for a picture, from an import that carried one. It is
   *  recorded and NOT fetched: see `importPeople`. */
  avatarSource?: string;
}): WatchRow {
  const id = mintWatchId();
  const ts = now();
  db.prepare(
    `INSERT INTO people_watch (id, name, company, role, email, note, links, tags, avatar_source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.name,
    fields.company,
    fields.role,
    fields.email,
    fields.note,
    JSON.stringify(fields.links),
    JSON.stringify(fields.tags ?? []),
    fields.avatarSource?.trim() || null,
    ts,
    ts,
  );
  return watchRow(id)!;
}

export function updateWatch(id: string, changes: Partial<Record<string, string>>): WatchRow {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  for (const [column, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    args.push(value);
  }
  sets.push("updated_at = ?");
  args.push(now(), id);
  db.prepare(`UPDATE people_watch SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return watchRow(id)!;
}

/**
 * Off the list — and the pulled timeline goes with them.
 *
 * THE DOSSIERS STAY AND THE EVENTS DO NOT, which looks inconsistent until the
 * two are named for what they are. A dossier is work this box was asked to do
 * and did; it belongs to the ledger. An event is a cached copy of a line from
 * somebody else's public feed, kept only so a card can be drawn without
 * hitting four APIs — nothing is lost by dropping it, and a re-add pulls it
 * back within the day.
 */
export function deleteWatch(id: string): void {
  db.prepare("DELETE FROM people_watch_events WHERE person_id = ?").run(id);
  /* The face goes with the events, and of everything this row owns it is the
     least arguable. It is a copy of somebody else's profile picture, kept only
     so a card could be drawn without telling a third party who was looking;
     off the list there is no card, and no reason for this box to be holding
     their photograph. */
  db.prepare("DELETE FROM people_watch_avatars WHERE person_id = ?").run(id);
  db.prepare("DELETE FROM people_watch WHERE id = ?").run(id);
}

/* --------------------------------------------------------------- the brief */

/**
 * THE BRIEF A DOSSIER RUN IS GIVEN, and the FIRST LINE IS THE NAME ALONE.
 *
 * That is not formatting. `dossierTitle` takes the first naming clause of the
 * first line and turns it into `Dossier — <name>`, and `attaches` finds the
 * run again by that string. A brief that opened with "Please look into Jane
 * Doe" would title the run `Dossier — Please look into Jane Doe`, which no
 * watch row would ever match and no second dossier would ever join — so the
 * person's card would show nothing while the ledger filled up with reports
 * about them.
 *
 * EVERYTHING ELSE IS ONLY WHAT WAS TYPED. A line is written when the field has
 * something in it and is omitted otherwise; there is no "Company: unknown",
 * because a worker told a field is unknown treats that as a thing to go and
 * find, and an empty field on a watch card means the owner did not write it
 * down rather than that nobody knows it.
 *
 * `focus` GOES LAST AND IN ITS OWN PARAGRAPH, after a blank line, so it reads
 * as the request rather than as one more identity line — and so that
 * `dossierTitle`, which only ever looks at the first line, cannot pick it up.
 */
export function composeBrief(person: {
  name: string;
  company?: string;
  role?: string;
  email?: string;
  note?: string;
  links?: Links;
}, focus?: string): string {
  const lines: string[] = [];
  if (person.role?.trim()) lines.push(`Role: ${person.role.trim()}`);
  if (person.company?.trim()) lines.push(`Company: ${person.company.trim()}`);
  if (person.email?.trim()) lines.push(`Email: ${person.email.trim()}`);
  for (const key of LINK_KEYS) {
    const v = person.links?.[key]?.trim();
    if (v) lines.push(`${LINK_LABEL[key]}: ${v}`);
  }
  if (person.note?.trim()) lines.push(`Note: ${person.note.trim()}`);

  const head = person.name.trim();
  const body = lines.length ? `${head}\n\n${lines.join("\n")}` : head;
  const asked = focus?.trim();
  return asked ? `${body}\n\nLook into: ${asked}` : body;
}

/**
 * Hand one person to the People Analyst.
 *
 * THE RUN IS NOT INSERTED HERE. `dispatch` is the one door onto a run and it
 * is called rather than copied: it holds the switched-off check, the owner's
 * standing instructions, the brief-length limit and the filing of the run
 * under the conversation that asked for it. Its answer — status and JSON — is
 * returned untouched, so a caller from this list gets exactly what a caller
 * from the sub-agents page gets, including the 409 when the worker is off.
 */
export function dispatchDossier(row: WatchRow, opts: { focus?: string; parentSessionId?: string }) {
  /* Provisioning is part of the dispatch, the same as it is on the sub-agents
     door: a box that has never opened that page still has a People Analyst by
     the time this line returns. */
  ensureTeam();
  const worker = subagentRow(subagentId("", "people"));
  if (!worker)
    return {
      status: 404 as const,
      json: {
        error: "There is no People Analyst on this box, so there is nobody to write a dossier.",
      },
    };
  const body: DispatchBody = {
    brief: composeBrief(
      {
        name: row.name,
        company: row.company,
        role: row.role,
        email: row.email,
        note: row.note,
        links: parseLinks(row.links),
      },
      opts.focus,
    ),
  };
  if (opts.parentSessionId) body.parentSessionId = opts.parentSessionId;
  return dispatch(worker, body);
}

/* --------------------------------------------------------------- the events */

/** How many events are kept per person. Three hundred is roughly a year of a
 *  busy GitHub account and several years of a quiet one; past that the table
 *  would grow without bound to hold a timeline nobody scrolls to. */
export const MAX_EVENTS = 300;

/** What the reader is handed in one go. A file, not an archive. */
export const EVENT_PAGE = 200;

/** What a source hands back, before this file gives it an identity. */
export type PulledEvent = {
  source: string;
  kind: string;
  title: string;
  url: string | null;
  at: string;
};

/**
 * THE IDENTITY OF AN EVENT IS A HASH OF THE EVENT, not of the source's own id.
 *
 * Four sources, four id schemes — a GitHub event id, an AT-protocol URI, an
 * Algolia objectID, an RSS guid which on a good number of real feeds is either
 * absent or is just the link again. There is no field all four have. What all
 * four DO have is a source, a URL and a title, and "the same source said the
 * same thing about the same link" is the only definition of sameness that
 * holds across them — which is exactly what re-pulling every twenty hours
 * needs, because the alternative is a timeline that duplicates itself daily.
 */
export function eventKey(source: string, url: string | null, title: string): string {
  return createHash("sha256").update(`${source}|${url ?? ""}|${title}`).digest("hex").slice(0, 24);
}

const shapeEvent = (r: EventRow): WatchEvent => ({
  key: r.key,
  source: r.source,
  kind: r.kind,
  title: r.title,
  url: r.url,
  at: r.at,
  firstSeenAt: r.first_seen_at,
});

/** One person's timeline, newest first. */
export function eventList(personId: string, limit = EVENT_PAGE): WatchEvent[] {
  return (
    db
      .prepare(
        `SELECT * FROM people_watch_events
          WHERE person_id = ?
          ORDER BY at DESC
          LIMIT ?`,
      )
      .all(personId, Math.max(1, Math.min(MAX_EVENTS, limit))) as unknown as EventRow[]
  ).map(shapeEvent);
}

/**
 * File a pull's events and say how many of them this box had never seen.
 *
 * `first_seen_at` IS NOT TOUCHED BY THE UPDATE. `at` is: a source may restate
 * when a thing happened, and its own answer is the better one. But when this
 * box first saw a row is a fact about this box, and letting a re-pull refresh
 * it would make every event permanently new and the badge permanently wrong.
 */
export function saveEvents(personId: string, events: PulledEvent[], at = now()): number {
  const held = db.prepare("SELECT 1 FROM people_watch_events WHERE person_id = ? AND key = ?");
  const upsert = db.prepare(
    `INSERT INTO people_watch_events (person_id, key, source, kind, title, url, at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(person_id, key) DO UPDATE SET title = excluded.title, at = excluded.at`,
  );
  let fresh = 0;
  const seen = new Set<string>();
  for (const e of events) {
    const key = eventKey(e.source, e.url, e.title);
    /* Two identical items inside ONE pull are one event, and counting the
       second as new would inflate the badge without inserting a row. */
    if (seen.has(key)) continue;
    seen.add(key);
    if (!held.get(personId, key)) fresh++;
    upsert.run(personId, key, e.source, e.kind, e.title, e.url, e.at, at);
  }
  /* Trimmed by `at`, so what is dropped is the oldest thing that happened
     rather than the oldest thing this box happened to fetch. */
  db.prepare(
    `DELETE FROM people_watch_events
      WHERE person_id = ?
        AND key NOT IN (
          SELECT key FROM people_watch_events WHERE person_id = ? ORDER BY at DESC LIMIT ?
        )`,
  ).run(personId, personId, MAX_EVENTS);
  return fresh;
}

/* ------------------------------------------------- the mailbox relationship */

/**
 * THE NAME REDUCED TO WHAT TWO SPELLINGS OF ONE PERSON HAVE IN COMMON.
 *
 * FIRST WORD AND LAST WORD, accent-folded and lower-cased, cut at the first
 * comma. That is deliberately crude, and the crudeness is the safety: middle
 * names, initials, honorifics and the "founder of Acme" clause all vary
 * between how the owner types somebody into a watch row and how their mail
 * client signs their name, and none of them identify anybody. What is left —
 * "andrej karpathy" — either matches or it does not.
 *
 * ACCENTS ARE FOLDED because "José García" and "Jose Garcia" are one person
 * typed by two keyboards. That folding also merges genuinely different names
 * in some languages, which is why a name match is never trusted where it is
 * ambiguous: see `contactFor`.
 */
export function nameKey(raw: string | null | undefined): string {
  const cut = (raw ?? "").split(",")[0]!;
  const folded = cut.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = folded.match(/[a-z0-9'-]+/g) ?? [];
  if (!words.length) return "";
  return words.length === 1 ? words[0]! : `${words[0]} ${words[words.length - 1]}`;
}

export type ContactLine = {
  address: string;
  temperature: Person["temperature"];
  quietDays: number | null;
  cadenceDays: number | null;
  lastAt: string | null;
  received: number;
  sent: number;
  why: string;
  /** "email" when the row's own address matched, "name" when it was the
   *  first-and-last-word key. A name match is a GUESS and is labelled one, the
   *  way a venture link is. */
  matchedBy: "email" | "name";
};

/**
 * THE MAILBOX'S SIDE OF A WATCHED PERSON, OR NOTHING AT ALL.
 *
 * NULL IS THE ORDINARY ANSWER. Most people on this list have never written to
 * the owner — that is what the list is for — so an absent contact means the
 * mailbox has not seen them and never means the watch row is wrong.
 *
 * THE EMAIL IS TRIED FIRST because an address is an identity and a name is a
 * label. Only when there is no address, or it matches nothing in the scanned
 * window, is the name key tried — and an AMBIGUOUS name match answers NULL
 * rather than picking one. Two different people who both fold to "james
 * smith" is not a rare case in a mailbox of thousands, and quietly attaching
 * one stranger's correspondence to a watched person's file is a worse failure
 * than an empty panel.
 */
export function contactFor(
  person: { name: string; email: string },
  roster: Person[] = people(),
): ContactLine | null {
  const email = person.email.trim().toLowerCase();
  let matches = email ? roster.filter((p) => p.address === email) : [];
  let matchedBy: "email" | "name" = "email";

  if (!matches.length) {
    const key = nameKey(person.name);
    if (!key) return null;
    matches = roster.filter((p) => p.name && nameKey(p.name) === key);
    matchedBy = "name";
    /* One address seen through two mailboxes is one person; two addresses are
       two people this name cannot choose between. */
    if (new Set(matches.map((p) => p.address)).size > 1) return null;
  }
  if (!matches.length) return null;

  /* The same address in two mailboxes is two relationships with one human and
     the tables never add them up. The heavier one is shown — it is the one the
     contacts list itself puts first — and the other is a click away on the
     contact document. */
  const best = [...matches].sort((a, b) => b.weight - a.weight || a.mailbox.localeCompare(b.mailbox))[0]!;
  return {
    address: best.address,
    temperature: best.temperature,
    quietDays: best.quietDays,
    cadenceDays: best.cadenceDays,
    lastAt: best.lastAt,
    received: best.received,
    sent: best.sent,
    why: best.why,
    matchedBy,
  };
}

/* ----------------------------------------------------------------- the file */

/** Every portfolio-wide dossier run in full, for `shapeRun`. Separate from
 *  `dossierRuns` because the list needs five columns per run and the file
 *  needs the whole row; one query cannot be both without the list paying. */
function dossierRunRows(): RunRow[] {
  return db
    .prepare(
      `SELECT * FROM agent_runs
        WHERE kind = 'dossier' AND venture_id IS NULL
        ORDER BY queued_at DESC`,
    )
    .all() as unknown as RunRow[];
}

export type WatchFile = {
  person: WatchPerson;
  contact: ContactLine | null;
  events: WatchEvent[];
  dossiers: ReturnType<typeof shapeRun>[];
  warnings: string[];
};

/**
 * ONE WATCHED PERSON, WHOLE: what he typed, what the mailbox knows, what the
 * public sources said, and what has been written about them.
 *
 * THE FOUR PARTS ARE FOUR DIFFERENT KINDS OF CLAIM and the document keeps them
 * apart rather than blending them into a profile. `person` is his own notes.
 * `contact` is measured from mail headers and may be a name-match guess.
 * `events` are somebody else's public feed, cached. `dossiers` are runs this
 * box performed. Nothing here merges them, because the merged object would
 * have no honest way to say which half of a sentence came from where.
 *
 * `warnings` IS THE LAST PULL'S, not this request's. It is the answer to "why
 * is the GitHub number missing" and it survives on the row until the next
 * pull, because a source that was down an hour ago is exactly what a reader
 * looking at a stale figure needs to be told.
 */
export function watchFile(id: string): WatchFile | null {
  const row = watchRow(id);
  if (!row) return null;
  const person = shape(row, dossierRuns(), newEventCounts(), avatarIds());
  return {
    person,
    contact: contactFor({ name: row.name, email: row.email }),
    events: eventList(id),
    dossiers: dossierRunRows()
      .filter((r) => attaches(r.title, row.name))
      .map(shapeRun),
    warnings: parseWarnings(row.pull_warnings),
  };
}

/* --------------------------------------------------------------- the import */

/** A single import call is a paste of a list, not a migration of a CRM. */
export const MAX_IMPORT = 500;

export type ImportFields = {
  name: string;
  company: string;
  role: string;
  email: string;
  note: string;
  links: Links;
  tags: string[];
  /** The exporting program's `avatar` — an ADDRESS to try, "" when it carried
   *  none. Not one of the typed fields and not merged with them: see
   *  `importPeople` for why it is written by its own rule. */
  avatarSource: string;
};

const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/**
 * ONE ROW OF SOMEBODY ELSE'S EXPORT, READ INTO THIS TABLE'S SHAPE.
 *
 * NO NAME, NO ROW. The name is the primary identity here and the join onto the
 * dossiers; a row without one could not be found again, merged again, or
 * titled. It is skipped rather than refused, because one nameless line in a
 * file of two hundred should not lose the other hundred and ninety-nine.
 *
 * PHONE AND LOCATION ARE DROPPED, and stating it is better than a reader
 * discovering it. This table has five identity lines and no sixth; the honest
 * alternatives were to invent two columns for fields nothing on this box reads,
 * or to append them to `note`, which is HIS OWN WORDS and must not have an
 * importer's sentences put into it. Anything not read here is a field this box
 * has no use for rather than a field it lost.
 *
 * `avatar` IS READ AS AN ADDRESS AND NOTHING IS FETCHED. The exporting program
 * carries a URL to somebody's profile picture; it is recorded as a place the
 * next pull may look. Downloading here would turn one request holding two
 * hundred rows into two hundred downloads against half a dozen hosts, with the
 * owner watching a spinner — and the sweep is going to visit every one of
 * these people within the day anyway.
 */
export function readImportRow(raw: unknown): ImportFields | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name, MAX_NAME);
  if (!name) return null;

  const links: Links = {};
  const rawLinks = r.links;
  if (typeof rawLinks === "object" && rawLinks !== null && !Array.isArray(rawLinks)) {
    for (const key of LINK_KEYS) {
      const v = text((rawLinks as Record<string, unknown>)[key], MAX_LINK);
      if (v) links[key] = v;
    }
  }

  const tags: string[] = [];
  if (Array.isArray(r.tags))
    for (const t of r.tags) {
      const v = text(t, MAX_TAG);
      if (v && !tags.some((held) => held.toLowerCase() === v.toLowerCase())) tags.push(v);
    }

  return {
    name,
    company: text(r.company, MAX_NAME),
    role: text(r.role, MAX_NAME),
    email: text(r.email, MAX_EMAIL),
    note: text(r.note, MAX_NOTE),
    links,
    tags: tags.slice(0, MAX_TAGS),
    avatarSource: text(r.avatar, MAX_LINK),
  };
}

/**
 * THE MERGE RULE, AND IT IS ONE SENTENCE: WHAT IS ALREADY THERE WINS.
 *
 * An import fills gaps. It never corrects, never replaces and never "updates"
 * — because the row it is writing into is the owner's own note about a person
 * and the file it is reading from is an export from another program. If those
 * two disagree about somebody's company, the one that knows which is right is
 * him, and the one that would be silently overwritten is the one he typed. So
 * a non-empty field is never touched, and re-running the same import a second
 * time changes nothing at all.
 *
 * LINKS MERGE PER KEY by the same rule — a typed GitHub survives an imported
 * one, an empty one is filled. TAGS ARE A UNION, case-folded, because a tag is
 * a shelf rather than a value: adding "ai" takes nothing away, and there is no
 * conflict to resolve.
 *
 * THE AVATAR SOURCE IS NOT IN HERE. This function is the rule about the
 * OWNER'S OWN WORDS, and an address a machine will fetch a picture from is not
 * one of them: it obeys the same fill-a-gap rule, one line up in
 * `importPeople`, where it can be read next to the pull that acts on it.
 */
export function mergeWatchFields(
  existing: { company: string; role: string; email: string; note: string; links: Links; tags: string[] },
  incoming: Omit<ImportFields, "name" | "avatarSource">,
): Omit<ImportFields, "name" | "avatarSource"> {
  const fill = (held: string, add: string) => (held.trim() ? held : add);
  const links: Links = { ...existing.links };
  for (const key of LINK_KEYS) {
    const add = incoming.links[key];
    if (add && !links[key]?.trim()) links[key] = add;
  }
  const tags = [...existing.tags];
  for (const t of incoming.tags)
    if (!tags.some((held) => held.toLowerCase() === t.toLowerCase())) tags.push(t);

  return {
    company: fill(existing.company, incoming.company),
    role: fill(existing.role, incoming.role),
    email: fill(existing.email, incoming.email),
    note: fill(existing.note, incoming.note),
    links,
    tags: tags.slice(0, MAX_TAGS),
  };
}

export type ImportResult = { added: number; updated: number; people: WatchPerson[] };

/**
 * Take a list of people and leave the watchlist holding all of them.
 *
 * UPSERT BY NAME, CASE-INSENSITIVELY, for the reason the POST door refuses a
 * duplicate: the name is the join onto the dossiers, so two rows under two
 * casings would be one person's record split in half. Here the collision is
 * MERGED rather than refused — the whole point of an import is that the list
 * may already know some of these people, and a 409 per row would make the
 * feature useless the second time it was used.
 *
 * `updated` COUNTS ROWS THAT ACTUALLY CHANGED. An import that filled nothing
 * in reports zero, which is the truth; counting every matched row as an update
 * would report six changes on a re-run that changed nothing.
 */
export function importPeople(rows: unknown[]): ImportResult {
  const touched: string[] = [];
  let added = 0;
  let updated = 0;

  for (const raw of rows.slice(0, MAX_IMPORT)) {
    const fields = readImportRow(raw);
    if (!fields) continue;

    /* Re-read per row rather than once: two lines of the same file may name
       the same person, and the second must merge into the row the first made. */
    const existing = watchByName(fields.name);
    if (!existing) {
      const row = insertWatch({
        name: fields.name,
        company: fields.company,
        role: fields.role,
        email: fields.email,
        note: fields.note,
        links: fields.links,
        tags: fields.tags,
        avatarSource: fields.avatarSource,
      });
      added++;
      touched.push(row.id);
      continue;
    }

    const held = {
      company: existing.company,
      role: existing.role,
      email: existing.email,
      note: existing.note,
      links: parseLinks(existing.links),
      tags: parseTags(existing.tags),
    };
    const merged = mergeWatchFields(held, fields);
    const changes: Record<string, string> = {};
    for (const key of ["company", "role", "email", "note"] as const)
      if (merged[key] !== held[key]) changes[key] = merged[key];
    const links = JSON.stringify(merged.links);
    if (links !== JSON.stringify(held.links)) changes.links = links;
    const tags = JSON.stringify(merged.tags);
    if (tags !== JSON.stringify(held.tags)) changes.tags = tags;
    /*
      THE AVATAR SOURCE FILLS A GAP AND NEVER REPLACES ONE, the same rule the
      typed fields follow, and it is kept OUT of `mergeWatchFields` on purpose:
      that function is the rule about the owner's own words, and this is a
      machine's note about where a picture lives. A row that already has a
      source — because a pull found a live GitHub avatar — must not have it
      overwritten by a third party's older record of the same face.
    */
    if (fields.avatarSource && !existing.avatar_source)
      changes.avatar_source = fields.avatarSource;

    if (Object.keys(changes).length) {
      updateWatch(existing.id, changes);
      updated++;
    }
    if (!touched.includes(existing.id)) touched.push(existing.id);
  }

  const runs = dossierRuns();
  const fresh = newEventCounts();
  const faces = avatarIds();
  const shaped = touched
    .map((id) => watchRow(id))
    .filter((r): r is WatchRow => !!r)
    .map((r) => shape(r, runs, fresh, faces))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { added, updated, people: shaped };
}

/**
 * Record what a pull learned, WITHOUT touching `updated_at`.
 *
 * `updated_at` IS ABOUT THE TYPED HALF. It answers "when did he last change
 * this card", and a sweep that ran at four in the morning bumping it would
 * make every row on the list look freshly edited and would destroy the only
 * signal that column carries. `activity_at` is the pull's own clock.
 */
export function writePull(id: string, pull: { metrics: Metrics; warnings: string[]; at: string }): void {
  db.prepare(
    "UPDATE people_watch SET metrics = ?, pull_warnings = ?, activity_at = ? WHERE id = ?",
  ).run(JSON.stringify(pull.metrics), JSON.stringify(pull.warnings.slice(0, 20)), pull.at, id);
}
