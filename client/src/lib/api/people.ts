import { call } from "@/lib/api";
import { qs, seg } from "@/lib/qs";
import type { RunStatus } from "@/lib/api/runs";
import type { Dispatched } from "@/lib/api/subagents";

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
  candidates: number;
  droppedByModel: number;
  refusedSpans: number;
  noRecipient: number;
  alreadyKnown: number;
  filed: number;
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
export type WatchLinks = {
  website?: string | null;
  github?: string | null;
  x?: string | null;
  linkedin?: string | null;
  bluesky?: string | null;
};

export type WatchPerson = {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  email: string | null;
  note: string | null;
  links: WatchLinks;
  createdAt: string;
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
};

/** A field the owner may not have filled in, as a string to draw or "". The
 *  one place null becomes "" on this side, so nothing else has to guess. */
export const said = (value: string | null | undefined): string => (value ?? "").trim();

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
  watch: () => call<{ people: WatchPerson[] }>("/people/watch"),

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
