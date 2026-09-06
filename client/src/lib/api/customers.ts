import { call } from "@/lib/api";
import { qs } from "@/lib/qs";

/**
 * CUSTOMERS, FROM THIS SIDE — the recovery queue, the dispute cases and the
 * event feed.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND, and three of the
 * nulls below are the whole point of the area:
 *
 *   `deadline: null` is a case with nothing to be early for — a subscription
 *   that has already ended, an invoice Stripe will not retry. It is never
 *   drawn as overdue and never sorted to the top.
 *
 *   `contact.address: null` is the contact-access setting being off. It is not
 *   a missing address: `contact.known` says whether one was found at all, and
 *   the page prints the sentence the server sends rather than composing its
 *   own explanation.
 *
 *   `outcome: null` on a dispute is a live case or one closed with no verdict.
 *   It is not a win, and no colour on the page may suggest it is.
 *
 * THE DISPUTE DOCUMENT CARRIES TWO MEASUREMENTS OF THE SAME SUBJECT and the
 * types keep them apart on purpose: `cases` is counted from stripe_disputes,
 * `ledger` is money that moved, and there is no field here that adds them.
 */

/* ---------------------------------------------------------------- recovery */

export type CaseKind = "churn" | "payment_failed" | "dispute" | "trial_ending";
export type CaseStatus = "open" | "drafted" | "sent" | "resolved" | "dismissed";

export type RecoveryCase = {
  id: string;
  kind: CaseKind;
  status: CaseStatus;
  account: string;
  venture: string | null;
  ventureName: string | null;
  subject: string;
  customer: string | null;
  /** Monthly-NORMALISED for a subscription case, the invoice amount for a
   *  payment case, the disputed amount for a dispute. The context says which. */
  amount: number | null;
  currency: string | null;
  deadline: string | null;
  deadlineIs: string | null;
  /** Negative once the deadline has passed. Null where there is none. */
  daysLeft: number | null;
  contact: { known: boolean; domain: string | null; address: string | null; why: string };
  context: Record<string, unknown> | null;
  factsKey: string;
  resolution: string | null;
  outboxId: number | null;
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type RecoveryQueue = {
  filter: { statuses: CaseStatus[]; kinds: CaseKind[] | null; venture: { id: string; name: string } | null; limit: number };
  counts: {
    open: number;
    drafted: number;
    sent: number;
    byKind: Record<CaseKind, number>;
    overdue: number;
    undated: number;
  };
  items: RecoveryCase[];
  contactAccess: boolean;
  /** When the inputs were last read. A queue is only as complete as its last
   *  pass, and a short list with an old or failed pass is not a quiet week. */
  lastPass: { at: string | null; ok: boolean | null; error: string | null };
  note: string;
  cannot: string[];
};

export type CaseDetail = {
  item: RecoveryCase;
  preview:
    | { subject: string; body: string; usedFacts: Record<string, unknown>; why?: undefined }
    | { subject: null; body: null; why: string };
};

export type Prepared = {
  outboxId: number;
  case: RecoveryCase;
  draft: { subject: string; body: string; usedFacts: Record<string, unknown> };
  note: string;
};

/* ---------------------------------------------------------------- disputes */

export type DisputeCase = {
  id: string;
  account: string;
  venture: string | null;
  ventureName: string | null;
  charge: string | null;
  amount: number;
  currency: string;
  reason: string | null;
  /** Stripe's own word, kept verbatim. */
  status: string;
  /** won | lost | null — and null is never a win. */
  outcome: "won" | "lost" | null;
  open: boolean;
  needsResponse: boolean;
  evidenceDueBy: string | null;
  /** The same instant in the owner's zone. Beside the ISO value, never
   *  instead of it. */
  evidenceDueLocal: string | null;
  hoursLeft: number | null;
  submissionCount: number | null;
  openedAt: string;
  firstSeenClosedAt: string | null;
  seenAt: string;
};

export type DisputeCurrency = {
  currency: string;
  window: string;
  cases: {
    opened: number;
    openedAmount: number;
    won: number;
    wonAmount: number;
    lost: number;
    lostAmount: number;
    /** Current state, no window. */
    openNow: number;
    openNowAmount: number;
    needsResponseNow: number;
    nextEvidenceDueBy: string | null;
    arithmetic: string;
  };
  ledger: { moneyOut: number; disputes: number; disputeFees: number; arithmetic: string };
  difference: number;
  differenceIs: string;
};

export type DisputeDoc = {
  window: { days: number; from: string };
  timezone: string;
  timezoneFrom: string;
  combined: null;
  currencies: DisputeCurrency[];
  counts: {
    byStatus: Record<string, number>;
    byOutcome: { won: number; lost: number; undecided: number };
    total: number;
  };
  open: DisputeCase[];
  recent: DisputeCase[];
  coverage: { stored: number; note: string };
  cannot: string[];
};

/* ------------------------------------------------------------------ events */

export type BusinessEvent = {
  id: string;
  type: string;
  at: string;
  summary: string;
  account: string;
  venture: string | null;
  ventureName: string | null;
  object: { id: string | null; type: string | null };
  customer: string | null;
  amount: number | null;
  currency: string | null;
  delivery: {
    deliveredAt: string | null;
    attempts: number;
    error: string | null;
    exhausted: boolean;
    muted: boolean;
    /** WHY no message was sent, in a sentence. Never a boolean, because the
     *  four reasons are not interchangeable. */
    suppressedBy: string | null;
    deferredUntil: string | null;
  };
  seenAt: string;
};

export type EventDoc = {
  window: { days: number };
  settings: {
    telegram: boolean;
    quietHours: string | null;
    timezone: string;
    timezoneFrom: string;
    mutedTypes: string[];
    collapseMinutes: number;
    reconcileMinutes: number;
    maxAttempts: number;
  };
  watched: string[];
  counts: {
    inWindow: number;
    delivered: number;
    pending: number;
    suppressed: number;
    failed: number;
    byType: Record<string, number>;
  };
  items: BusinessEvent[];
  note: string;
  cannot: string[];
};

export type UndeliveredDoc = {
  items: BusinessEvent[];
  counts: { total: number; deferred: number; failed: number; exhausted: number };
  note: string;
};

/* ------------------------------------------------------------------- calls */

export const customersApi = {
  queue: (opts: { status?: string; kind?: string; venture?: string; limit?: number } = {}) =>
    call<RecoveryQueue>(`/recovery${qs(opts)}`),
  case: (id: string) => call<CaseDetail>(`/recovery/${encodeURIComponent(id)}`),
  prepare: (id: string) =>
    call<Prepared>(`/recovery/${encodeURIComponent(id)}/prepare`, { method: "POST" }),
  resolve: (id: string, note?: string) =>
    call<{ item: RecoveryCase; note: string }>(`/recovery/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),
  dismiss: (id: string, note?: string) =>
    call<{ item: RecoveryCase; note: string }>(`/recovery/${encodeURIComponent(id)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ note }),
    }),

  disputes: (days = 90) => call<DisputeDoc>(`/disputes${qs({ days })}`),

  events: (opts: { days?: number; limit?: number; type?: string } = {}) =>
    call<EventDoc>(`/business-events${qs(opts)}`),
  undelivered: () => call<UndeliveredDoc>("/business-events/undelivered"),
  mute: (type: string) =>
    call<{ muted: string[]; note: string }>("/business-events/mute", {
      method: "POST",
      body: JSON.stringify({ type }),
    }),
  unmute: (type: string) =>
    call<{ muted: string[]; note: string }>("/business-events/unmute", {
      method: "POST",
      body: JSON.stringify({ type }),
    }),
  resend: (id: string) =>
    call<{ item: BusinessEvent; note: string }>(
      `/business-events/${encodeURIComponent(id)}/resend`,
      { method: "POST" },
    ),
};
