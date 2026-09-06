/**
 * CUSTOMERS — the tables, the settings, and the one policy this area is not
 * allowed to re-open.
 *
 * Everything else on this box that touches Stripe measures the account:
 * a day of charges, a book of subscriptions, a ledger of settlement. This
 * area measures the CUSTOMER, which is a different unit with a different
 * obligation attached — the moment a row can name a person, the question
 * stops being "is the figure right" and starts being "who may see this".
 *
 * THE ADDRESS POLICY IS activity/users.ts's AND IS INHERITED WHOLE. Addresses
 * are salted-hashed per install; the domain is kept because it identifies
 * nobody; there is no lookup by address anywhere in this area. The single
 * exception is `email_plain`, which exists because a recovery queue that
 * cannot address a follow-up is a list of regrets — and it is written ONLY
 * while `customers.contact-access` is on, nulled on the first pass after it
 * is turned off, and never published by a route that reads the setting as
 * off. The setting is in the checked settings registry rather than a constant
 * for the reason ops/backups.ts gives about writing an archive at four in the
 * morning: a decision that changes what leaves this machine belongs on a page
 * the owner can reach.
 */
import { createHash } from "node:crypto";
import { configValue, db, now, stripeLedgerDays } from "../../db.ts";
import { currencyCode, money } from "../../shared/money.ts";
import { hashEmail } from "../activity/users.ts";
import { systemZone, validZone, zoned, PLUGIN as BRIEFING } from "../proactive/briefing.ts";

export const PLUGIN = "customers";

/* --------------------------------------------------------------- settings */

export const DEFAULT_TRIAL_DAYS = 7;
/** How far ahead a pending cancellation is worth chasing. The same sixty days
 *  /api/stripe uses for "ending soon", and for its reason: an annual plan that
 *  switched off auto-renew on day one stays paid for eleven months, and
 *  putting that beside a monthly one ending on Thursday is how a pending-churn
 *  figure lies. */
export const DEFAULT_HORIZON_DAYS = 60;

export type Settings = {
  /** May a route publish a plain address, and may the pass store one. */
  contactAccess: boolean;
  /** [fromHour, toHour) in `timezone`, or null for "no quiet hours". */
  quiet: { from: number; to: number } | null;
  /** The owner's zone. Defaults to the briefing area's, which is where the
   *  owner already typed it, and to this machine's if neither is set. Two
   *  places to type a timezone is two places for it to be wrong, so this only
   *  ever OVERRIDES rather than duplicating. */
  timezone: string;
  timezoneFrom: "customers" | "briefing" | "system";
  trialDays: number;
  horizonDays: number;
  /** Whether business events are pushed to Telegram at all. OFF until asked
   *  for — a message arriving on somebody's phone because a default said so
   *  is a surprise, which is the argument proactive/briefing.ts makes about
   *  its own daily push. */
  telegram: boolean;
};

const onOff = (v: string | null, fallback: boolean) => {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return fallback;
  return t === "on" || t === "yes" || t === "true" || t === "1";
};

/**
 * "22-8", "22 - 8", "off". Parsed here and nowhere else.
 *
 * `from === to` DISABLES rather than meaning twenty-four hours of silence,
 * the safe reading: a typo that muted every notification forever would look
 * exactly like a working configuration.
 */
export function parseQuiet(raw: string | null): { from: number; to: number } | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t || t === "off" || t === "none" || t === "0") return null;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(t);
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || from > 23 || to < 0 || to > 23) return null;
  if (from === to) return null;
  return { from, to };
}

/** Is `hour` inside the window, wrapping over midnight? */
export function inQuiet(hour: number, q: { from: number; to: number }): boolean {
  return q.from < q.to ? hour >= q.from && hour < q.to : hour >= q.from || hour < q.to;
}

function intSetting(key: string, fallback: number, lo: number, hi: number): number {
  const raw = (configValue(PLUGIN, key) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

export function settings(): Settings {
  const own = (configValue(PLUGIN, "timezone") ?? "").trim();
  const theirs = (configValue(BRIEFING, "timezone") ?? "").trim();
  const timezone = own && validZone(own) ? own : theirs && validZone(theirs) ? theirs : systemZone();
  return {
    contactAccess: onOff(configValue(PLUGIN, "contact-access"), false),
    quiet: parseQuiet(configValue(PLUGIN, "quiet-hours")),
    timezone,
    timezoneFrom:
      own && validZone(own) ? "customers" : theirs && validZone(theirs) ? "briefing" : "system",
    trialDays: intSetting("trial-days", DEFAULT_TRIAL_DAYS, 0, 60),
    horizonDays: intSetting("horizon-days", DEFAULT_HORIZON_DAYS, 1, 400),
    telegram: onOff(configValue(PLUGIN, "telegram"), false),
  };
}

/* ----------------------------------------------------------------- cursors */

export function cursor(kind: string, accountId: number): string | null {
  const r = db
    .prepare("SELECT value FROM customers_cursor WHERE kind = ? AND account_id = ?")
    .get(kind, accountId) as { value: string | null } | undefined;
  return r ? r.value : null;
}

export function setCursor(kind: string, accountId: number, value: string) {
  db.prepare(
    `INSERT INTO customers_cursor (kind, account_id, value, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(kind, account_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(kind, accountId, value, now());
}

/* ---------------------------------------------------------------- disputes */

export type DisputeRecord = {
  id: string;
  account_id: number;
  account_label: string;
  charge: string | null;
  payment_intent: string | null;
  amount: number;
  currency: string;
  reason: string | null;
  status: string;
  evidence_due_by: string | null;
  submission_count: number | null;
  is_charge_refundable: number | null;
  created_at: string;
  closed_at: string | null;
  outcome: string | null;
  venture_id: string | null;
  seen_at: string;
};

/**
 * Upsert one walk's worth of cases.
 *
 * `closed_at` IS ONLY EVER WRITTEN ONCE, by COALESCE on the existing row: it
 * is the first moment THIS BOX saw the case settled, and a second walk that
 * re-observed the same terminal status must not move the date forward. Stripe
 * publishes no closed timestamp, so this is the most precise honest answer
 * and it is only ever as precise as the collection interval.
 *
 * `terminal` IS THE CALLER'S CLAIM THAT A TRANSITION HAPPENED — that this box
 * believed the case was open and now does not — rather than "the status is
 * terminal". The difference is the whole column: computed from the status
 * alone it stamps every settled dispute in the account's history with the day
 * the integration was installed. See the pass, which derives it from the
 * cases it previously held open.
 */
export function writeDisputes(
  rows: (Omit<DisputeRecord, "seen_at" | "closed_at" | "is_charge_refundable" | "venture_id"> & {
    isChargeRefundable: boolean | null;
    ventureId: string | null;
    terminal: boolean;
  })[],
): number {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT INTO stripe_disputes
       (id, account_id, account_label, charge, payment_intent, amount, currency, reason,
        status, evidence_due_by, submission_count, is_charge_refundable, created_at,
        closed_at, outcome, venture_id, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       evidence_due_by = excluded.evidence_due_by,
       submission_count = excluded.submission_count,
       is_charge_refundable = excluded.is_charge_refundable,
       outcome = excluded.outcome,
       venture_id = COALESCE(excluded.venture_id, stripe_disputes.venture_id),
       closed_at = COALESCE(stripe_disputes.closed_at, excluded.closed_at),
       seen_at = excluded.seen_at`,
  );
  db.exec("BEGIN");
  try {
    for (const d of rows)
      stmt.run(
        d.id, d.account_id, d.account_label, d.charge, d.payment_intent, d.amount,
        d.currency, d.reason, d.status, d.evidence_due_by, d.submission_count,
        d.isChargeRefundable === null ? null : d.isChargeRefundable ? 1 : 0,
        d.created_at, d.terminal ? seen : null, d.outcome, d.ventureId, seen,
      );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}

export function disputes(opts: { since?: string; limit?: number } = {}): DisputeRecord[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 500), 1), 2000);
  if (opts.since)
    return db
      .prepare("SELECT * FROM stripe_disputes WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.since, limit) as unknown as DisputeRecord[];
  return db
    .prepare("SELECT * FROM stripe_disputes ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as DisputeRecord[];
}

export function dispute(id: string): DisputeRecord | undefined {
  return db.prepare("SELECT * FROM stripe_disputes WHERE id = ?").get(id) as
    | DisputeRecord
    | undefined;
}

export function disputeCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM stripe_disputes").get() as { n: number }).n;
}

/**
 * WHAT THE BALANCE LEDGER RECORDS LEAVING OVER A WINDOW, per currency.
 *
 * Byte-for-byte the same reduction lived in two documents — the dispute board
 * over ninety days and the leakage board over thirty — and both printed the
 * same sentence describing it. They were well coordinated and that was the
 * risk: a sign convention corrected in one, or a new fee bucket added to one,
 * leaves the other quietly reporting the old number, and nothing about either
 * page would say which.
 *
 * THE WINDOW IS THE CALLER'S and the arithmetic is not. `disputes` is the
 * disputed money itself; `disputeFees` is the fee Stripe charges whatever the
 * outcome — kept apart, because a document that adds them and calls the result
 * "disputes" cannot be checked against Stripe's own page.
 *
 * SETTLEMENT DATING, not case dating. These rows are posted when the balance
 * moved, so they never line up with a count of cases opened in the same window
 * and are never presented as if they did.
 *
 * KEYED BY UPPER-CASE ISO CODE, like every other per-currency map on this box —
 * Stripe stores its own lower-case spelling, and a map that held one currency
 * under two keys was the other half of this finding.
 */
export function ledgerDisputes(fromDay: string): Map<string, { disputes: number; disputeFees: number }> {
  const out = new Map<string, { disputes: number; disputeFees: number }>();
  for (const r of stripeLedgerDays(fromDay)) {
    const code = currencyCode(r.currency);
    const held = out.get(code) ?? { disputes: 0, disputeFees: 0 };
    held.disputes += r.disputes;
    held.disputeFees += r.dispute_fees;
    out.set(code, held);
  }
  for (const [code, v] of out)
    out.set(code, { disputes: money(v.disputes), disputeFees: money(v.disputeFees) });
  return out;
}

/* ------------------------------------------------------------------- cases */

export const CASE_KINDS = ["churn", "payment_failed", "dispute", "trial_ending"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];
export const CASE_STATUSES = ["open", "drafted", "sent", "resolved", "dismissed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export type CaseRecord = {
  id: string;
  venture_id: string | null;
  account_id: number;
  account_label: string;
  kind: CaseKind;
  customer: string | null;
  email_hash: string | null;
  email_domain: string | null;
  email_plain: string | null;
  subject_ref: string;
  amount: number | null;
  currency: string | null;
  deadline: string | null;
  deadline_is: string | null;
  context: string;
  status: CaseStatus;
  resolution: string | null;
  outbox_id: number | null;
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export const caseId = (kind: CaseKind, ref: string) => `${kind}:${ref}`;

/** The statuses a pass may still touch. `dismissed` is not among them — the
 *  owner saying "not this one" is a decision, and a queue that re-opened it on
 *  the next collection would be a queue nobody reads twice. */
export const LIVE_STATUSES: CaseStatus[] = ["open", "drafted", "sent"];

export type CaseWrite = {
  id: string;
  ventureId: string | null;
  accountId: number;
  accountLabel: string;
  kind: CaseKind;
  customer: string | null;
  subjectRef: string;
  amount: number | null;
  currency: string | null;
  deadline: string | null;
  deadlineIs: string | null;
  context: unknown;
};

/**
 * Open a case, or refresh the facts on one that is already here.
 *
 * WHAT AN UPSERT MAY OVERWRITE AND WHAT IT MAY NOT. Facts may always be
 * rewritten — the deadline moved, the amount changed, Stripe's status is
 * different — because they are copies of somebody else's row. `status`,
 * `resolution`, `outbox_id` and `opened_at` may never be, because they are
 * this box's own record of what a person did. A dismissed or resolved case is
 * left entirely alone: re-opening it is a decision, and it is made by the
 * pass only through `reopen()` where that is explicit.
 */
export function upsertCase(w: CaseWrite): void {
  const at = now();
  db.prepare(
    `INSERT INTO customer_cases
       (id, venture_id, account_id, account_label, kind, customer, subject_ref,
        amount, currency, deadline, deadline_is, context, status, opened_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'open',?,?)
     ON CONFLICT(id) DO UPDATE SET
       venture_id = COALESCE(excluded.venture_id, customer_cases.venture_id),
       account_label = excluded.account_label,
       customer = COALESCE(excluded.customer, customer_cases.customer),
       amount = excluded.amount,
       currency = excluded.currency,
       deadline = excluded.deadline,
       deadline_is = excluded.deadline_is,
       context = excluded.context,
       updated_at = excluded.updated_at
     WHERE customer_cases.status IN ('open','drafted','sent')`,
  ).run(
    w.id, w.ventureId, w.accountId, w.accountLabel, w.kind, w.customer, w.subjectRef,
    w.amount, w.currency, w.deadline, w.deadlineIs, JSON.stringify(w.context), at, at,
  );
}

export function caseRow(id: string): CaseRecord | undefined {
  return db.prepare("SELECT * FROM customer_cases WHERE id = ?").get(id) as
    | CaseRecord
    | undefined;
}

export function cases(
  opts: { statuses?: CaseStatus[]; kinds?: CaseKind[]; venture?: string; limit?: number } = {},
): CaseRecord[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
    args.push(...opts.statuses);
  }
  if (opts.kinds?.length) {
    where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
    args.push(...opts.kinds);
  }
  if (opts.venture) {
    where.push("venture_id = ?");
    args.push(opts.venture);
  }
  args.push(Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 1000));
  /* SORTED BY DEADLINE, NULLS LAST. A case with no deadline is not urgent and
     is not finished either — it sits under the dated ones rather than at the
     top, which is where a plain ASC on a nullable column would put it. */
  return db
    .prepare(
      `SELECT * FROM customer_cases
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY (deadline IS NULL) ASC, deadline ASC, opened_at ASC LIMIT ?`,
    )
    .all(...args) as unknown as CaseRecord[];
}

export function setCaseStatus(
  id: string,
  status: CaseStatus,
  resolution: string | null,
): CaseRecord | undefined {
  const at = now();
  const terminal = status === "resolved" || status === "dismissed";
  db.prepare(
    `UPDATE customer_cases SET status = ?, resolution = ?, updated_at = ?, resolved_at = ?
      WHERE id = ?`,
  ).run(status, resolution, at, terminal ? at : null, id);
  return caseRow(id);
}

export function linkDraft(id: string, outboxId: number): void {
  db.prepare(
    "UPDATE customer_cases SET outbox_id = ?, status = 'drafted', updated_at = ? WHERE id = ?",
  ).run(outboxId, now(), id);
}

/** Stripe's own customer id, once one has been established. Written once and
 *  never overwritten with a null — see the pass on why a churn case learns it
 *  a collection later than an invoice case does. */
export function setCaseCustomer(id: string, customer: string): void {
  db.prepare(
    "UPDATE customer_cases SET customer = ?, updated_at = ? WHERE id = ? AND customer IS NULL",
  ).run(customer, now(), id);
}

/**
 * The address columns, written under the policy in this file's header.
 *
 * The hash and the domain are always written; the plain address only while
 * contact access is on, and it is actively NULLED when it is off — turning the
 * setting off has to remove what is already stored, or "off" would only mean
 * "no new ones".
 */
export function setCaseEmail(id: string, email: string | null, contactAccess: boolean): void {
  if (!email) {
    db.prepare("UPDATE customer_cases SET email_plain = NULL, updated_at = ? WHERE id = ?").run(
      now(),
      id,
    );
    return;
  }
  const { hash, domain } = hashEmail(email);
  db.prepare(
    `UPDATE customer_cases SET email_hash = ?, email_domain = ?, email_plain = ?, updated_at = ?
      WHERE id = ?`,
  ).run(hash, domain, contactAccess ? email.trim().toLowerCase() : null, now(), id);
}

/** Clear every stored plain address. Called on the first pass after contact
 *  access is switched off. */
export function forgetPlainAddresses(): number {
  const info = db
    .prepare("UPDATE customer_cases SET email_plain = NULL WHERE email_plain IS NOT NULL")
    .run();
  return Number(info.changes ?? 0);
}

/* ------------------------------------------------------------------ events */

export type BusinessEventRecord = {
  id: string;
  account_id: number;
  account_label: string;
  venture_id: string | null;
  type: string;
  at: string;
  summary: string;
  object_id: string | null;
  object_type: string | null;
  customer: string | null;
  amount: number | null;
  currency: string | null;
  delivered_at: string | null;
  delivery_error: string | null;
  attempts: number;
  muted: number;
  suppressed_by: string | null;
  deferred_until: string | null;
  seen_at: string;
};

export type EventWrite = {
  id: string;
  accountId: number;
  accountLabel: string;
  ventureId: string | null;
  type: string;
  at: string;
  summary: string;
  objectId: string | null;
  objectType: string | null;
  customer: string | null;
  amount: number | null;
  currency: string | null;
  muted: boolean;
  suppressedBy: string | null;
};

/** INSERT OR IGNORE on Stripe's own event id — that is the whole dedupe, and
 *  it is why the walk may overlap its window as much as it likes. Returns how
 *  many rows were actually new. */
export function insertEvents(rows: EventWrite[]): number {
  if (!rows.length) return 0;
  const seen = now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO business_events
       (id, account_id, account_label, venture_id, type, at, summary, object_id,
        object_type, customer, amount, currency, muted, suppressed_by, seen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let added = 0;
  db.exec("BEGIN");
  try {
    for (const e of rows) {
      const info = stmt.run(
        e.id, e.accountId, e.accountLabel, e.ventureId, e.type, e.at, e.summary,
        e.objectId, e.objectType, e.customer, e.amount, e.currency,
        e.muted ? 1 : 0, e.suppressedBy, seen,
      );
      added += Number(info.changes ?? 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return added;
}

export function businessEvent(id: string): BusinessEventRecord | undefined {
  return db.prepare("SELECT * FROM business_events WHERE id = ?").get(id) as
    | BusinessEventRecord
    | undefined;
}

export function businessEvents(
  opts: { days?: number; limit?: number; type?: string; undeliveredOnly?: boolean } = {},
): BusinessEventRecord[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.days) {
    where.push("at >= ?");
    args.push(new Date(Date.now() - opts.days * 86_400_000).toISOString());
  }
  if (opts.type) {
    where.push("type = ?");
    args.push(opts.type);
  }
  if (opts.undeliveredOnly) where.push("delivered_at IS NULL AND muted = 0");
  args.push(Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1000));
  return db
    .prepare(
      `SELECT * FROM business_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(...args) as unknown as BusinessEventRecord[];
}

/** Everything still waiting for a message: not delivered, not muted, not
 *  deferred past now. Oldest first, because that is the order a phone reads
 *  them in. */
export function pendingEvents(limit = 200): BusinessEventRecord[] {
  return db
    .prepare(
      `SELECT * FROM business_events
        WHERE delivered_at IS NULL AND muted = 0
          AND (deferred_until IS NULL OR deferred_until <= ?)
        ORDER BY at ASC, id ASC LIMIT ?`,
    )
    .all(now(), limit) as unknown as BusinessEventRecord[];
}

export function markDelivered(id: string): void {
  db.prepare(
    "UPDATE business_events SET delivered_at = ?, delivery_error = NULL, attempts = attempts + 1 WHERE id = ?",
  ).run(now(), id);
}

export function markDeliveryFailed(id: string, error: string): void {
  db.prepare(
    "UPDATE business_events SET delivery_error = ?, attempts = attempts + 1 WHERE id = ?",
  ).run(error, id);
}

export function suppress(id: string, why: string): void {
  db.prepare("UPDATE business_events SET muted = 1, suppressed_by = ? WHERE id = ?").run(why, id);
}

export function defer(id: string, until: string): void {
  db.prepare("UPDATE business_events SET deferred_until = ? WHERE id = ?").run(until, id);
}

/** A resend clears the delivery record and lets the next pass pick it up. The
 *  attempts counter is NOT reset: it is a history of how much this event has
 *  cost, and zeroing it would hide a type that fails every time. */
export function requeue(id: string): void {
  db.prepare(
    `UPDATE business_events SET delivered_at = NULL, delivery_error = NULL,
       muted = 0, suppressed_by = NULL, deferred_until = NULL WHERE id = ?`,
  ).run(id);
}

export function mutedTypes(): string[] {
  return (
    db.prepare("SELECT type FROM business_event_mutes ORDER BY type").all() as unknown as {
      type: string;
    }[]
  ).map((r) => r.type);
}

export function muteType(type: string): void {
  db.prepare("INSERT OR IGNORE INTO business_event_mutes (type, created_at) VALUES (?, ?)").run(
    type,
    now(),
  );
  /* Everything of this type still waiting goes quiet too. A mute that only
     applied to future events would still deliver the backlog that made the
     owner press the button. */
  db.prepare(
    `UPDATE business_events SET muted = 1, suppressed_by = 'type muted'
      WHERE type = ? AND delivered_at IS NULL AND muted = 0`,
  ).run(type);
}

export function unmuteType(type: string): boolean {
  const info = db.prepare("DELETE FROM business_event_mutes WHERE type = ?").run(type);
  return Number(info.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------ shared */

/** The local day and hour in the owner's zone. Re-exported from the briefing
 *  area rather than reimplemented: two formatters is two answers about which
 *  side of midnight it is. */
export { zoned };

/** A short, stable digest for a context object, so a route can say whether the
 *  facts behind a draft have changed since it was written. */
export const factsKey = (context: unknown) =>
  createHash("sha256").update(JSON.stringify(context)).digest("hex").slice(0, 16);
