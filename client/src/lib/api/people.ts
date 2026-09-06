import { call } from "@/lib/api";
import { qs } from "@/lib/qs";

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
};
