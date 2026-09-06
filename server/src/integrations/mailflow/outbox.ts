import { createHash } from "node:crypto";
/**
 * THE OUTBOX — mail this box has WRITTEN, and not one line it has sent by
 * itself.
 *
 * Everything else on this server that touches a customer reads. This is the
 * missing middle: a place where a draft can be assembled — by the agent, or by
 * the owner typing it — and then sit there under his eye until he presses a
 * button next to what it says.
 *
 * THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE, and it is enforced by shape
 * rather than by convention. The list is the thing to preserve:
 *
 *   1. `sendMessage` (gmail-send.ts) is imported once and called from exactly
 *      ONE function here — `sendApproved`. `grep -rn sendMessage src/` returns
 *      the definition and that one call. Three would mean a second door.
 *   2. `sendApproved` refuses any row that is not `approved`. There is no
 *      send-all and no approve-all, because an approve-all is a send-all
 *      wearing a different word.
 *   3. The only route that writes `approved` is the owner's approve route, and
 *      it refuses a request carrying the skills proxy's `x-opc-via: skills`
 *      header. The `outbox` skill publishes draft, edit and dismiss and has no
 *      approve and no send action at all — so the proxy has nowhere to send
 *      such a request in the first place, and the header check is the second
 *      wall rather than the only one.
 *   4. THERE IS NO TIMER IN THIS FILE. No setInterval, no exported tick, no
 *      background pass. The triage timer next door writes scores and has no
 *      import of this module.
 *
 * THE TWO FLOORS, AND WHY THEY COUNT DISMISSED ROWS.
 *
 * The per-address floor — default 14 days, a setting — refuses a second draft
 * to the same address inside the window WHATEVER ITS STATUS, dismissed
 * included. That last part is the whole point: a dismissal is the owner saying
 * "not this person, not now", and re-offering the same address two days later
 * is how a queue teaches somebody to stop reading it. It is checked when a
 * draft is created AND again at send, because time passes in between and the
 * question at send is "may this leave", not "was it fair to write".
 *
 * The daily cap — default 20 — counts messages that actually LEFT today. It is
 * a circuit breaker on the whole area rather than a policy about any one
 * recipient: whatever goes wrong upstream, this box cannot become a sender of
 * volume without somebody changing a number on the settings page.
 */
import { configValue, db, now } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { gmailMailboxes } from "../../db.ts";
import { GmailError, open } from "../../providers/gmail.ts";
import { replyContext, sendMessage, validAddress } from "./gmail-send.ts";

export const PLUGIN = "outbox";

export const DEFAULT_GAP_DAYS = 14;
export const DEFAULT_DAILY_CAP = 20;

export const STATUSES = ["draft", "approved", "sent", "dismissed", "failed", "sending", "uncertain"] as const;
export type Status = (typeof STATUSES)[number];

export type OutboxRow = {
  id: number;
  account_id: number;
  to_address: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  venture: string | null;
  status: string;
  created_by: string;
  created_at: string;
  approved_at: string | null;
  sent_at: string | null;
  message_id: string | null;
  error: string | null;
  approved_content: string | null;
  sending_at: string | null;
};

/* --------------------------------------------------------------- settings */

export type OutboxSettings = {
  gapDays: number;
  dailyCap: number;
  signature: string;
  /** Whether a draft must be approved before it can be sent. TRUE unless the
   *  owner has typed "no" on the settings page, and no route an agent can
   *  reach writes settings — `PUT /api/plugins/outbox/config` is not on any
   *  skill, so this is a switch only a person at the keyboard can move. */
  requireApproval: boolean;
};

/**
 * An unset number is the DEFAULT and not zero.
 *
 * `Number("")` is 0 and 0 is a legal value for both of these — a zero floor
 * means "no floor" and a zero cap means "send nothing" — so an empty setting
 * read as a number would silently switch sending off for everyone who has
 * never opened the settings page. Blank is therefore checked before the parse.
 */
function numberSetting(key: string, fallback: number, hi: number): number {
  const raw = (configValue(PLUGIN, key) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= hi ? n : fallback;
}

export function settings(): OutboxSettings {
  const approval = (configValue(PLUGIN, "approval") ?? "").trim().toLowerCase();
  return {
    gapDays: numberSetting("gap-days", DEFAULT_GAP_DAYS, 365),
    dailyCap: numberSetting("daily-cap", DEFAULT_DAILY_CAP, 500),
    signature: (configValue(PLUGIN, "signature") ?? "").trim(),
    /* Anything but an explicit "no" is yes. A misspelt setting must fail
       CLOSED — towards the state where a person presses the button. */
    requireApproval: approval !== "no" && approval !== "off" && approval !== "false",
  };
}

/* -------------------------------------------------------------------- rows */

export function row(id: number): OutboxRow | undefined {
  return db.prepare("SELECT * FROM mailflow_outbox WHERE id = ?").get(id) as OutboxRow | undefined;
}

export function rows(opts: { status?: string; limit?: number; offset?: number } = {}): OutboxRow[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
  if (opts.status)
    return db
      .prepare("SELECT * FROM mailflow_outbox WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(opts.status, limit, offset) as unknown as OutboxRow[];
  return db
    .prepare("SELECT * FROM mailflow_outbox ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as unknown as OutboxRow[];
}

/**
 * What the recipient would actually receive: the approved markdown with the
 * signature setting under it. It is computed here and published on every row
 * so the page shows the WHOLE message rather than the body alone — a signature
 * appended at send time that nobody saw in the preview would mean the document
 * that was approved is not the document that went out.
 */
export function preview(r: OutboxRow, s: OutboxSettings = settings()): string {
  return s.signature ? `${r.body.trimEnd()}\n\n${s.signature}` : r.body;
}

/* ------------------------------------------------------------- the floors */

const DAY_MS = 86_400_000;

/** The row that blocks a new draft to this address, or null. Every status
 *  counts — see the file header on why dismissed rows count too. */
export function floorBlocker(
  toAddress: string,
  gapDays: number,
  exceptId?: number,
): OutboxRow | null {
  if (gapDays <= 0) return null;
  const cut = new Date(Date.now() - gapDays * DAY_MS).toISOString();
  const found = db
    .prepare(
      `SELECT * FROM mailflow_outbox
        WHERE lower(to_address) = lower(?) AND created_at >= ? AND id <> ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(toAddress, cut, exceptId ?? -1) as OutboxRow | undefined;
  return found ?? null;
}

/** How many messages have LEFT since local midnight. Sent rows only: a draft
 *  written today has cost nobody an email. */
export function sentToday(): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const r = db
    .prepare("SELECT COUNT(*) AS n FROM mailflow_outbox WHERE sent_at IS NOT NULL AND sent_at >= ?")
    .get(start.toISOString()) as { n: number };
  return Number(r.n);
}

/* ------------------------------------------------------------- the mailbox */

/** The address a mailbox sends FROM, as Gmail itself reported it to the
 *  collector. Null when the Gmail plugin has never been collected, in which
 *  case there is nothing honest to put on a From line and the send refuses. */
export function fromAddress(accountId: number): string | null {
  const box = gmailMailboxes().find((b) => b.account_id === accountId);
  const addr = (box?.address ?? "").trim();
  return addr && validAddress(addr) ? addr : null;
}

export function firstGmailAccount(): number | null {
  const a = accounts.list("gmail").find((x) => x.connected);
  return a ? a.id : null;
}

/* ----------------------------------------------------------------- the send */

export class SendRefused extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "SendRefused";
    this.status = status;
  }
}

/**
 * THE ONE CALLER OF `sendMessage`.
 *
 * It takes one id, refuses anything that is not `approved`, re-checks both
 * floors, and writes what happened onto the row — including the failure, which
 * becomes a terminal `failed` rather than dropping back into the queue. A
 * failed send is not retried automatically anywhere in this area: whether a
 * copy arrived is Google's answer rather than this table's, and a queue that
 * retries on its own is a queue that can send the same mail twice.
 */
/** Snapshot every recipient-visible field, including the signature and sending account. */
export function approvalContent(r: OutboxRow): string {
  return JSON.stringify({ accountId: r.account_id, from: fromAddress(r.account_id), to: r.to_address,
    subject: r.subject, text: preview(r), threadId: r.in_reply_to });
}

export function approveDraft(id: number): void {
  const r = row(id);
  if (!r || !["draft", "failed"].includes(r.status)) throw new SendRefused("Only a draft or a confirmed failed delivery can be approved.");
  db.prepare("UPDATE mailflow_outbox SET status = 'approved', approved_at = ?, approved_content = ?, error = NULL WHERE id = ? AND status IN ('draft','failed')")
    .run(now(), approvalContent(r), id);
}

/** A claim survives process crashes; an interrupted send must be reconciled, never retried automatically. */
export async function sendApproved(id: number): Promise<OutboxRow> {
  db.exec("BEGIN IMMEDIATE");
  let r: OutboxRow;
  try {
    const found = row(id);
    if (!found || found.status !== "approved") throw new SendRefused("Only an approved draft can be sent. This message may already be sending.");
    r = found;
    if (!r.approved_content || r.approved_content !== approvalContent(r))
      throw new SendRefused("The message or signature changed. Edit and approve the latest preview before sending.");
    const s = settings();
    const blocker = floorBlocker(r.to_address, s.gapDays, id);
    if (blocker) throw new SendRefused("Another recent message to this recipient is inside the configured contact interval.");
    const start = new Date(); start.setHours(0,0,0,0);
    const used = db.prepare("SELECT COUNT(*) AS n FROM mailflow_outbox WHERE sent_at >= ? OR (status IN ('sending','uncertain') AND sending_at >= ?)")
      .get(start.toISOString(), start.toISOString()) as { n: number };
    if (used.n >= s.dailyCap) throw new SendRefused("Today's sending allowance is used or reserved by messages in progress.");
    db.prepare("UPDATE mailflow_outbox SET status = 'sending', sending_at = ? WHERE id = ? AND status = 'approved'").run(now(), id);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  let attempted = false;
  try {
    const approved = JSON.parse(r.approved_content!) as { from: string | null; to: string; subject: string; text: string; threadId: string | null };
    if (!approved.from) throw new SendRefused("Collect this Gmail account before sending so its From address is known.");
    const session = await open("outbox_send", r.account_id);
    const ctx = approved.threadId ? await replyContext(session, approved.threadId) : null;
    attempted = true;
    const out = await sendMessage(session, {
      from: approved.from, to: approved.to, subject: approved.subject, text: approved.text,
      threadId: approved.threadId, inReplyTo: ctx?.messageId, references: ctx?.references,
    });
    db.prepare("UPDATE mailflow_outbox SET status = 'sent', sent_at = ?, message_id = ?, error = NULL WHERE id = ? AND status = 'sending'")
      .run(now(), out.messageId, id);
    return row(id)!;
  } catch (err) {
    // A network failure or ambiguous success after POST can have delivered the message.
    const refused = err instanceof GmailError && err.status >= 400 && err.status < 500;
    const status = attempted && !refused ? "uncertain" : "failed";
    const reason = err instanceof Error ? err.message : String(err);
    const error = status === "uncertain" ? `Delivery is uncertain. Check Gmail Sent before taking any further action. ${reason}` : reason;
    db.prepare("UPDATE mailflow_outbox SET status = ?, error = ? WHERE id = ? AND status = 'sending'").run(status, error, id);
    throw new SendRefused(error, 502);
  }
}

export function recoverInterruptedSends() {
  db.prepare("UPDATE mailflow_outbox SET status = 'uncertain', error = 'The server stopped during delivery. Check Gmail Sent before resolving this message.' WHERE status = 'sending'").run();
}

export function approvalKey(r: OutboxRow) { return createHash("sha256").update(approvalContent(r)).digest("hex"); }
