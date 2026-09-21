import { call } from "@/lib/api";
import { qs, seg } from "@/lib/qs";
import type { RunStatus, RunSummary } from "@/lib/api/runs";
import type { Dispatched } from "@/lib/api/subagents";
import { hrefFor, LINK_SITES, linkLabel, type LinkKey, type LinkSite } from "@/lib/personLinks";

/* WHERE A LINK GOES IS ONE FUNCTION, and it lives in an import-free leaf so a
   node test can run it — see `@/lib/personLinks` for the four readings. It is
   re-exported here because every caller of it already holds a `WatchPerson`,
   and two import paths for one rule is how a card and a header come to
   disagree about where somebody's GitHub is. */
export { hrefFor, LINK_SITES, linkLabel };
export type { LinkKey, LinkSite };

/**
 * PEOPLE AND COMMITMENTS, FROM THIS SIDE.
 *
 * TWO DOCUMENTS AND TWO PROMISES, and the types keep them apart on purpose.
 * `/api/people` is mail METADATA — addresses, counts, dates, gaps — and there
 * is no field on it that could carry a subject or a body, because the server
 * has none to send. `/api/commitments` is the owner's own sentences, quoted
 * verbatim, and `sentence` is not optional on any row: a page that drew `what`
 * without it would be showing a model's paraphrase as though it were the
 * thing he wrote.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. Where the server says
 * null this says null and the page draws it: `temperature: null` is "no rhythm
 * measured yet" and is never rendered as cold; `cadenceDays: null` is "not
 * enough separate days of contact"; `due: null` on an open promise is undated
 * and never overdue.
 */

/** warm | cooling | cold, or null for "no rhythm measured yet". */
export type Temperature = "warm" | "cooling" | "cold" | null;

/** The venture a contact's DOMAIN points at. Always a guess, and the badge
 *  that draws it says so — `derived` is true on every one of these. */
export type VentureLink = {
  ventureId: string;
  ventureName: string;
  slug: string;
  by: "domain" | "subject";
  derived: true;
  why: string;
};

export type Person = {
  /** The connected mailbox this person was seen THROUGH. Two mailboxes are
   *  two relationships with the same human and are never added together. */
  mailbox: string;
  address: string;
  /** The name they sign with, or null. Never derived from the address. */
  name: string | null;
  domain: string;
  /** "No earlier than" — the oldest message the scan reached, not the first
   *  they ever sent. */
  firstSeen: string | null;
  lastReceived: string | null;
  lastSent: string | null;
  lastAt: string | null;
  /** Per contact and per window. Summing these across rows does NOT give mail
   *  volume: one message to five people counts once for each. */
  received: number;
  sent: number;
  threads: number;
  contactDays: number;
  /** The median gap between days on which mail passed. Null under four gaps. */
  cadenceDays: number | null;
  cadenceGaps: number;
  quietDays: number | null;
  daysSinceSent: number | null;
  daysSinceReceived: number | null;
  ratio: number | null;
  temperature: Temperature;
  /** The arithmetic in words. Shown rather than paraphrased. */
  why: string;
  stale: boolean;
  mutual: boolean;
  weight: number;
  link: VentureLink | null;
};

export type PeopleDoc = {
  /** The window THESE ROWS were scanned over — not the setting, which may have
   *  been changed since and applies to the next collection. */
  windowDays: number;
  windowDaysSetting: number;
  minEachWay: number;
  staleDays: number;
  maxReceived: number;
  maxSent: number;
  selfDomains: string[];
  scannedAt: string | null;
  scanFrom: string | null;
  /** The message cap bit: every count is a floor. */
  floors: boolean;
  mailboxes: string[];
  counts: {
    scanned: number;
    mutual: number;
    matched: number;
    returned: number;
    warm: number;
    cooling: number;
    cold: number;
    noRhythm: number;
    stale: number;
  };
  domains: string[];
  contacts: Person[];
  definitions: Record<string, string>;
  note: string | null;
};

export type PersonDay = { day: string; received: number; sent: number };

export type PersonDoc = {
  windowDays: number;
  staleDays: number;
  scannedAt: string | null;
  scanFrom: string | null;
  floors: boolean;
  seenIn: (Person & { days: PersonDay[] })[];
  definitions: Record<string, string>;
};

export type BriefFigures = {
  week: string;
  computedAt: string;
  windowDays: number;
  counts: {
    tracked: number;
    warm: number;
    cooling: number;
    cold: number;
    noRhythm: number;
    stale: number;
  };
  previousBriefWeek: string | null;
  daysSincePreviousBrief: number | null;
  firstBrief: boolean;
  cannotSay: string;
};

export type BriefDoc = {
  week: string;
  writtenAt?: string;
  model: string | null;
  markdown: string | null;
  error: string | null;
  figures: BriefFigures | null;
  weeks: { week: string; written_at: string }[];
  definitions?: Record<string, string>;
};

export type Commitment = {
  id: string;
  mailbox: string;
  threadId: string;
  messageId: string;
  to: string;
  toName: string | null;
  subject: string | null;
  /** A model's shortest span of the sentence. A summary. */
  what: string;
  /** What he actually typed, verbatim. Never hide this. */
  sentence: string;
  /** His own words for a deadline, or null. */
  dueText: string | null;
  /** Those words as a date, only where they resolve. Null is undated, not
   *  overdue. */
  due: string | null;
  sentAt: string | null;
  status: "open" | "done" | "dismissed";
  foundAt: string;
  decidedAt: string | null;
};

export type CommitmentsDoc = {
  status: string;
  counts: {
    open: number;
    done: number;
    dismissed: number;
    matched: number;
    returned: number;
  };
  overdue: number;
  commitments: Commitment[];
  definitions: Record<string, string>;
  note: string | null;
};

export type ScanResult = {
  ok: boolean;
  days: number;
  listed: number;
  scanned: number;
  truncated: boolean;
  /** Sentences of his own put to the judge — every sentence of every message
   *  that was opened, not a pattern's hits. */
  candidates: number;
  /** Judged as not a promise. */
  notPromise: number;
  /** Judged by nobody, because no model answered. These file NOTHING, so a
   *  non-zero figure means the scan under-reports and the page must say so. */
  unjudged: number;
  /** Past the per-message ceiling, never shown to the judge. */
  unshown: number;
  refusedSpans: number;
  noRecipient: number;
  alreadyKnown: number;
  filed: number;
  /** The model that decided what was filed, and the one that tightened the
   *  spans. Two calls, often two different models. */
  judgeModel: string | null;
  model: string | null;
  modelError: string | null;
  error?: string | null;
  note: string | null;
};


/* ------------------------------------------------------------- watchlist */

/**
 * SOMEBODY THE OWNER IS WATCHING, WHICH IS NOT SOMEBODY WHO HAS EMAILED.
 *
 * `Person` above is MAIL METADATA — a row that exists because a message
 * passed, with a rhythm measured from it. A `WatchPerson` is the opposite kind
 * of fact: a name the owner typed because they want to know about that human,
 * whether or not there has ever been a message. A founder they have never
 * spoken to belongs on this list; a mailing list that writes weekly does not.
 * Two documents, two tables, and deliberately no join between them — merging
 * them on an address would put people the owner never chose to watch onto a
 * page that says "these are the people you are watching".
 *
 * EVERY TEXT FIELD MAY BE NULL AND THIS TYPE SAYS SO. The server stores what
 * was typed and nothing else; a person with no company has no company, not an
 * empty string that renders as a stray separator. Callers use `said()` rather
 * than trusting a `.trim()` to be safe.
 */
export type WatchLinks = Partial<Record<LinkKey, string | null>>;

export type WatchPerson = {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  email: string | null;
  note: string | null;
  links: WatchLinks;
  /**
   * WHERE THEIR PICTURE IS ON THIS BOX, or null for somebody we have no
   * picture of.
   *
   * A RELATIVE URL AND NOT A REMOTE ONE — `/api/people/watch/<id>/avatar`
   * serves bytes this box fetched from GitHub or Bluesky and kept. Pointing
   * the page straight at the original would tell those sites who is reading
   * this dashboard and would break the day somebody rotates their photo's
   * filename. Null after a pull is an answer: nothing on file to fetch.
   *
   * THE ADDRESS IS STABLE AND THE BYTES BEHIND IT ARE NOT, and the server
   * caches it — so anything drawing this hangs the row's own stamp off it
   * rather than trusting the browser to ask again. `PersonAvatar` is the one
   * place that happens.
   */
  avatar: string | null;
  createdAt: string;
  /**
   * THE OWNER'S OWN WORDS FOR WHY THIS PERSON IS ON THE LIST — "investor",
   * "competitor", "spoke at the conference". Free text, never a taxonomy, and
   * an empty array is a person nobody has labelled rather than a person with
   * no properties. Sent whole on a write: a PATCH with `tags` REPLACES the
   * set, which is the only reading under which removing one is possible.
   */
  tags: string[];
  /**
   * WHAT THE PUBLIC INTERNET SAYS THIS PERSON'S NUMBERS ARE, at `at`.
   *
   * EVERY ONE OF THESE IS NULL UNTIL SOMEBODY PULLS, and null after a pull is
   * still an answer: it means that site had nothing to say — no GitHub on
   * file, an account with no posts, a handle that 404s. Null is never drawn
   * as a zero, because "0 followers" and "we never asked" are the two facts
   * this page most needs to keep apart. `at` is null when nothing has ever
   * been measured, and it is the ONE stamp for all five: they are read in a
   * single pull or not at all.
   */
  metrics: {
    ghFollowers: number | null;
    ghRepos: number | null;
    bskyFollowers: number | null;
    bskyPosts: number | null;
    hnKarma: number | null;
    at: string | null;
    /**
     * HOW FAR EACH FIGURE HAS MOVED IN SEVEN DAYS, AND A MISSING KEY IS NOT A
     * ZERO.
     *
     * PARTIAL RATHER THAN NULLABLE, and the difference is the whole reason
     * this shape is worth reading carefully. `{ ghFollowers: 0 }` is a
     * measurement — they gained nobody this week. A missing `ghFollowers` is
     * the server saying there is no reading from a week ago to subtract:
     * somebody added on Tuesday, a link typed yesterday, a source that has
     * never answered. Drawing the second as "0" or as a flat arrow would put
     * a result under somebody nothing has been measured about, which is the
     * one thing this page must not do.
     *
     * Measured against the newest history row at least seven days old, so it
     * is a real week rather than "the oldest point we happen to hold".
     */
    deltas: {
      ghFollowers?: number;
      ghRepos?: number;
      bskyFollowers?: number;
      bskyPosts?: number;
      hnKarma?: number;
    };
  };
  /** The newest public event on record for them, or null for somebody with
   *  none. NOT the same as `metrics.at` — that is when we last looked, this is
   *  when they last did something. */
  activityAt: string | null;
  /** Events first seen in the last week. A count the server keeps because it
   *  is the only thing that knows what this box had already seen. */
  newEvents: number;
  /**
   * HOW MANY OF THOSE WERE THINGS THE BOX NOTICED RATHER THAN THINGS THE
   * PERSON PUBLISHED — a bio rewritten, a follower count that jumped, a new
   * public repository.
   *
   * A SUBSET OF `newEvents`, counted separately because the two answer
   * different questions. Sorted by `newEvents` the list finds the people who
   * are BUSY; sorted by `signals` it finds the people something is HAPPENING
   * to, and those are not the same list. On the timeline they arrive with
   * `source: "watch"` and `kind: "change"`, and they must never be drawn as
   * something the person said.
   */
  signals: number;
  updatedAt: string;
  /**
   * THE DOSSIERS ON THIS PERSON, COUNTED BY THE SERVER.
   *
   * Counted there rather than here because the join is a string comparison
   * over every dossier run this box has ever done, and a page that had to read
   * the whole ledger to draw a list of names would be reading it once per
   * name. `last` is null for somebody nobody has written about yet — which is
   * a state the cards say out loud rather than drawing as a zero.
   */
  dossiers: {
    count: number;
    running: boolean;
    queued: number;
    last: {
      id: string;
      status: RunStatus;
      finishedAt: string | null;
      queuedAt: string;
    } | null;
  };
};

/** What can be typed about a person. Everything but the name is optional, and
 *  the name is the only thing the server refuses to invent. */
export type WatchInput = {
  name?: string;
  company?: string;
  role?: string;
  email?: string;
  note?: string;
  links?: WatchLinks;
  /** THE WHOLE SET, ALWAYS. There is no add-one route and there should not be
   *  one: a partial tag write needs a merge rule, and the only merge rule that
   *  can delete a tag is "the client sends what the list now is". */
  tags?: string[];
};

/** A field the owner may not have filled in, as a string to draw or "". The
 *  one place null becomes "" on this side, so nothing else has to guess. */
export const said = (value: string | null | undefined): string => (value ?? "").trim();

/* ----------------------------------------------------------- one person */

/**
 * THE MAILBOX'S OPINION OF SOMEBODY ON THE WATCHLIST, OR NULL.
 *
 * A WATCHED PERSON AND A CORRESPONDENT ARE TWO DIFFERENT FACTS and this is the
 * one place they are allowed to meet. The join is the email address the owner
 * typed, and nothing else: a person with no address on file, or one whose
 * address has never appeared in the connected mailbox, gets `null` here and
 * their page says so in a sentence. It is NEVER filled in from a name match —
 * two people called Jane Doe would become one relationship, and the whole
 * point of the field is that it is evidence.
 *
 * The numbers are `Person`'s, narrowed to the ones a file wants: how long it
 * has been quiet, what the usual gap is, which way the mail runs, and the
 * server's own sentence for how it decided. `temperature: null` is "no rhythm
 * measured yet" and is drawn as that rather than as cold.
 */
export type PersonContact = {
  address: string;
  temperature: Temperature;
  /** Days since anything passed either way. Null when no dated mail exists. */
  quietDays: number | null;
  /** The median gap, or null under enough separate days to claim one. */
  cadenceDays: number | null;
  lastAt: string | null;
  received: number;
  sent: number;
  /** The arithmetic in words, from the server. Shown, never paraphrased. */
  why: string;
};

/**
 * ONE THING THIS PERSON DID IN PUBLIC.
 *
 * `key` is the server's dedupe identity, so the same commit read twice is one
 * row. `at` is when it HAPPENED and `firstSeenAt` is when this box first saw
 * it — two different dates, and the difference is what makes a "NEW" pill
 * honest: an old post found today is new to the reader and not new to the
 * world, and the timeline says so by showing the date it happened next to a
 * pill that means "you have not seen this".
 */
/**
 * THE SOURCE ON AN EVENT NOBODY PUBLISHED — a bio rewritten, a follower count
 * that jumped, a repository that appeared. The server's own spelling, named
 * here so the surfaces that draw these differently from a post are all
 * comparing against one string rather than four copies of a literal.
 */
export const SIGNAL_SOURCE = "watch";

export type PersonEvent = {
  key: string;
  /** github | bluesky | hn | rss — a chip, and a string rather than a union
   *  because a source added on the server should draw here without a release. */
  source: string;
  kind: string;
  title: string;
  url: string | null;
  at: string | null;
  firstSeenAt: string;
};

/**
 * THE FILE ON ONE PERSON: who they are, the mailbox's view of them, what they
 * have done in public, and everything written about them.
 *
 * `warnings` IS NOT AN ERROR CHANNEL. A pull that read GitHub and could not
 * reach Bluesky is a partial success, and the page draws what came back with
 * the sentence about what did not underneath it. A page that threw the whole
 * document away because one of four sources timed out would be showing less
 * than it has.
 */
/**
 * ONE DAY'S READING OF THE TRACKED NUMBERS — a point on the sparklines.
 *
 * ONE ROW PER DAY THE BOX LOOKED, NOT PER DAY THAT PASSED. A gap in `history`
 * is a day nothing was pulled (a laptop that was shut, a sweep that has not
 * come round), and a chart that joined two points across it is drawing a
 * straight line through days nobody measured — true of the readings at either
 * end and of nothing in between. `day` is UTC.
 *
 * EVERY FIGURE IS NULLABLE FOR THE REASON `metrics` ARE. A row of five nulls
 * is a pull that reached nobody — evidence that the box looked — and never a
 * person whose numbers went to zero.
 */
export type PersonHistoryPoint = {
  day: string;
  at: string;
  ghFollowers: number | null;
  ghRepos: number | null;
  bskyFollowers: number | null;
  bskyPosts: number | null;
  hnKarma: number | null;
};

export type PersonFile = {
  person: WatchPerson;
  contact: PersonContact | null;
  /** Newest first. */
  events: PersonEvent[];
  /** OLDEST FIRST — the order a chart draws in, and the opposite of `events`.
   *  At most fourteen months of it, and short for somebody recently added:
   *  a short series is a short watch, never a quiet person. */
  history: PersonHistoryPoint[];
  /** Every dossier run naming this person, newest first. */
  dossiers: RunSummary[];
  warnings: string[];
};

/**
 * WHERE THE TWENTY-HOURLY REFRESH HAS GOT TO, FOR THE LIST AS A WHOLE.
 *
 * `lastAt` IS THE OLDEST PULL STAMP ON THE LIST, NOT THE NEWEST, and that is
 * the only reading under which the sentence "pulled for everyone" is true. The
 * newest becomes "a few seconds ago" the moment any single person is
 * refreshed, which would let this page claim the whole list was current while
 * nine of ten rows had not been read since Tuesday.
 *
 * NULL UNLESS `everyonePulled`, for the same reason: with one never-pulled
 * person there was no instant at which the list was ever complete. An empty
 * watchlist reports `everyonePulled: false` rather than a vacuous true.
 *
 * `nextDueAt` IS NULL WHEN SOMEBODY IS DUE ALREADY — draw "due now", never
 * "next in −4h". `everyMs` is the server's own interval, sent so that nothing
 * here has to hardcode twenty hours and go quietly wrong the day it changes.
 */
export type WatchSweep = {
  lastAt: string | null;
  nextDueAt: string | null;
  everyonePulled: boolean;
  everyMs: number;
};

export type WatchDoc = {
  people: WatchPerson[];
  sweep: WatchSweep;
};

export const peopleApi = {
  list: (params: {
    stale?: string;
    domain?: string;
    venture?: string;
    q?: string;
    all?: string;
    limit?: number;
  } = {}) => call<PeopleDoc>(`/people${qs(params)}`),

  person: (address: string) =>
    call<PersonDoc>(`/people/${encodeURIComponent(address)}`),

  brief: (week?: string) => call<BriefDoc>(`/people/brief${qs({ week })}`),

  /** Write this week's brief now. `force` rewrites the current week only —
   *  an earlier week's row is the record and nothing can touch it. */
  writeBrief: (force = false) =>
    call<{ week: string; written: boolean; reason: string; error: string | null }>(
      `/people/brief${force ? "?force=1" : ""}`,
      { method: "POST" },
    ),

  commitments: (params: { status?: string; limit?: number } = {}) =>
    call<CommitmentsDoc>(`/commitments${qs(params)}`),

  decide: (id: string, action: "done" | "dismiss" | "reopen") =>
    call<{ commitment: Commitment }>(`/commitments/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
    }),

  scan: (days: number) =>
    call<ScanResult>("/commitments/scan", {
      method: "POST",
      body: JSON.stringify({ days }),
    }),

  /* ------------------------------------------------------- the watchlist */

  /** Everyone on the list, sorted by name on the server. */
  watch: () => call<WatchDoc>("/people/watch"),

  addWatch: (body: WatchInput) =>
    call<WatchPerson>("/people/watch", { method: "POST", body: JSON.stringify(body) }),

  updateWatch: (id: string, patch: WatchInput) =>
    call<WatchPerson>(`/people/watch/${seg(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /** Off the list. THE RUNS STAY — a dossier is a report that was written, and
   *  deleting the person it names would delete work rather than a bookmark.
   *  They reappear as unfiled, which is honest: nobody is watching them now. */
  removeWatch: (id: string) =>
    call<{ id: string; deleted: true }>(`/people/watch/${seg(id)}`, { method: "DELETE" }),

  /** THE WHOLE FILE ON ONE PERSON, in one request: the row, the mailbox's
   *  view, the public activity and the dossiers. One document rather than four
   *  because the page draws all of it at once and four polls on a 10s clock is
   *  four times the traffic for the same screen. */
  personFile: (id: string) => call<PersonFile>(`/people/watch/${seg(id)}`),

  /**
   * GO AND READ THEIR PUBLIC ACTIVITY NOW.
   *
   * SECONDS, NOT MILLISECONDS — it is four outbound fetches — and it answers
   * with the same document `personFile` does, already updated, so the page
   * swaps the whole file in rather than pulling again afterwards. Sources that
   * did not answer come back in `warnings` and the rest of the document is
   * still true.
   */
  pullPerson: (id: string) =>
    call<PersonFile>(`/people/watch/${seg(id)}/pull`, { method: "POST" }),

  /**
   * Write one now.
   *
   * THE SAME ANSWER A DISPATCH GIVES, because it is the same dispatch: the
   * server composes the brief so the run's title is exactly `Dossier — <name>`
   * and hands back the run and the worker. 409 when the People analyst is
   * switched off, which the page draws as the error it is rather than as a
   * button that did nothing.
   */
  dossierFor: (id: string, focus?: string) =>
    call<Dispatched>(`/people/watch/${seg(id)}/dossier`, {
      method: "POST",
      body: JSON.stringify(focus ? { focus } : {}),
    }),
};
