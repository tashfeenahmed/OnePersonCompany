/**
 * TRIAGE AND THE OUTBOX — the two routes behind the Triage and Outbox apps.
 *
 * ONE FILE FOR TWO ROUTES because they are one screen's worth each and one
 * area on the server (`integrations/mailflow/`), and because the second is
 * where a reply to the first goes.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND, and the nulls are the
 * interesting half. `score: null` is NOT a category — it means the model has
 * not read that thread, and the page draws it in its own group rather than
 * folding it into noise. `ventureBy: "host"` is a fact and `"model"` is a
 * guess; the page says which. `messageId: null` on an outbox row means nothing
 * has left, whatever the row's status says about intent.
 *
 * THERE IS NO approve OR send HELPER MISSING BY ACCIDENT. They are here, they
 * are called only from a button the owner presses, and the server refuses both
 * for anything arriving through the skills proxy. The agent's half of this
 * area is draft, edit and dismiss.
 */
import { call } from "@/lib/api";

/* ------------------------------------------------------------------ triage */

/** needs_reply | waiting_on_them | fyi | noise — or null for "not scored". */
export type TriageScore = "needs_reply" | "waiting_on_them" | "fyi" | "noise";

export type TriageThread = {
  id: string;
  accountId: number;
  subject: string;
  from: string;
  fromName: string;
  /** Unix milliseconds, or null when Gmail gave no date. Never zero. */
  at: number | null;
  /** Gmail's own snippet, fetched live. It is never stored on the server. */
  snippet: string;
  unread: boolean;
  messages: number;
  score: TriageScore | null;
  reason: string | null;
  urgency: "high" | "normal" | "low" | null;
  venture: string | null;
  ventureName: string | null;
  /** "host" — a domain in the thread matched a venture's own host, which is a
   *  fact. "model" — the model named it, which is a guess. */
  ventureBy: string | null;
  /** A reply has arrived since the score was made, so the reason describes a
   *  conversation that has moved on. */
  stale: boolean;
  scoredAt: string | null;
  model: string | null;
  snoozedUntil: string | null;
  snoozed: boolean;
  doneAt: string | null;
};

export type TriageDoc = {
  account: { id: number; label: string | null };
  window: { days: number; threads: number; max: number };
  lastRun: {
    ranAt: string;
    ok: boolean;
    threads: number;
    scored: number;
    note: string | null;
    error: string | null;
  } | null;
  counts: {
    needsReply: number;
    waitingOnThem: number;
    fyi: number;
    noise: number;
    unscored: number;
    done: number;
    snoozed: number;
    stale: number;
  };
  groups: Record<string, TriageThread[]>;
  done: TriageThread[];
  snoozedList: TriageThread[];
  note: string;
};

export type TriageRun = {
  accountId: number;
  accountLabel: string;
  ok: boolean;
  threads: number;
  scored: number;
  unscored: number;
  model: string | null;
  note: string | null;
  error: string | null;
};

/* ------------------------------------------------------------------ outbox */

export type OutboxStatus = "draft" | "approved" | "sent" | "dismissed" | "failed" | "sending" | "uncertain";

export type OutboxItem = {
  approvalKey: string;
  from: string | null;
  id: number;
  accountId: number;
  to: string;
  subject: string;
  /** The markdown as written. */
  body: string;
  /** The markdown WITH the signature setting under it — what the recipient
   *  would receive. The page renders this, so what is approved is what is
   *  sent. */
  preview: string;
  inReplyTo: string | null;
  venture: string | null;
  ventureName: string | null;
  status: OutboxStatus;
  createdBy: "agent" | "owner" | string;
  createdAt: string;
  approvedAt: string | null;
  sentAt: string | null;
  /** Gmail's own id for the sent copy. The only proof anything left. */
  messageId: string | null;
  error: string | null;
  /** The sending identity this is written FROM, when it has one. NULL is the
   *  original behaviour: the Gmail account on the row, from the address Google
   *  itself reported. `via` says which door it would leave by. */
  identityId: number | null;
  fromName: string | null;
  via: "gmail" | "resend" | null;
  replyTo: string | null;
  /** Why the From line could not be resolved — a Resend key pointed at another
   *  domain, a Gmail account disconnected. NULL when it resolved. A refusal:
   *  the send is frozen against it. */
  fromError: string | null;
  /** A resolved From line Resend has something to say about — "pending", or
   *  never asked. It does NOT stop a send; it is what the owner needs to read
   *  before approving rather than after Resend refuses. */
  fromWarning: string | null;
  /** Whether this draft carries a plan and a fact packet. A draft typed by hand
   *  does not, and that absence is honest: nobody validated it against
   *  anything. */
  hasReasons: boolean;
  sequenceId: number | null;
  sequenceStep: number | null;
  sentVia: string | null;
  /** Resend's own last event for a sent copy. NULL means NOT READ — never "not
   *  delivered". */
  deliveryEvent: string | null;
  deliveryReadAt: string | null;
};

export type OutboxDoc = {
  pagination: { offset: number; limit: number; total: number };
  accounts: { id: number; label: string; address: string | null }[];
  settings: {
    gapDays: number;
    dailyCap: number;
    requireApproval: boolean;
    signature: string;
  };
  mailbox: { accountId: number | null; address: string | null };
  today: { sent: number; cap: number };
  counts: Record<OutboxStatus, number>;
  items: OutboxItem[];
  note: string;
};

export const mailflowApi = {
  triage: (opts: { days?: number; max?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.days) q.set("days", String(opts.days));
    if (opts.max) q.set("max", String(opts.max));
    return call<TriageDoc>(`/triage${q.toString() ? `?${q}` : ""}`);
  },

  runTriage: (body: { days?: number; max?: number } = {}) =>
    call<TriageRun>("/triage/run", { method: "POST", body: JSON.stringify(body) }),

  done: (threadId: string, body: { account?: number; undo?: boolean } = {}) =>
    call<{ threadId: string; doneAt: string | null; note: string }>(
      `/triage/${encodeURIComponent(threadId)}/done`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  snooze: (threadId: string, body: { account?: number; days?: number } = {}) =>
    call<{ threadId: string; snoozedUntil: string; days: number; note: string }>(
      `/triage/${encodeURIComponent(threadId)}/snooze`,
      { method: "POST", body: JSON.stringify(body) },
    ),

  outbox: (status?: OutboxStatus | null, offset = 0) =>
    call<OutboxDoc>(`/outbox?limit=50&offset=${offset}${status ? `&status=${status}` : ""}`),

  draft: (body: {
    account?: number;
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string | null;
    venture?: string | null;
  }) =>
    call<{ item: OutboxItem; note: string }>("/outbox", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  edit: (
    id: number,
    body: { to?: string; subject?: string; body?: string; venture?: string | null },
  ) =>
    call<{ item: OutboxItem; note: string }>(`/outbox/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  /** The owner's press. The server refuses this for anything arriving through
   *  the skills proxy, and the outbox skill has no such action to begin with. */
  approve: (id: number, approvalKey: string) =>
    call<{ item: OutboxItem; note: string }>(`/outbox/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ approvalKey }),
    }),

  /** The owner's second press. One message actually leaves. */
  send: (id: number, approvalKey: string) =>
    call<{ item: OutboxItem; note: string }>(`/outbox/${id}/send`, {
      method: "POST",
      body: JSON.stringify({ approvalKey }),
    }),

  resolve: (id: number) => call<{ item: OutboxItem }>(`/outbox/${id}/resolve`, { method: "POST", body: JSON.stringify({ checkedNotSent: true }) }),
  dismiss: (id: number) =>
    call<{ item: OutboxItem; note: string }>(`/outbox/${id}/dismiss`, {
      method: "POST",
      body: "{}",
    }),
};
