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
 *
 * THERE ARE NOW TWO DOORS, AND POINT 1 ABOVE IS UNCHANGED BY THAT. Since the
 * nurture area landed, a row may carry an `identity_id` naming a sending
 * identity, and an identity whose kind is `resend` is delivered by
 * `nurture/resend-send.ts`'s `resendSend` instead of Gmail's `sendMessage`.
 * Both are imported ONCE and called from the same single function —
 * `sendApproved` — so `grep -rn "sendMessage\|resendSend" src/` returns two
 * definitions and two calls, both inside it. A row with no identity behaves
 * exactly as it did before: the Gmail account named on the row, from the
 * address Google itself reported.
 *
 * WHY THE TRANSPORT IS FROZEN INTO THE APPROVAL. `approvalContent` names the
 * identity, the From line and the transport alongside the words, so the
 * approval is of "this message, from this address, by this door". Changing an
 * identity's account after approval therefore fails the content check at send
 * time rather than quietly sending the same words out of a different domain.
 */
import { configValue, db, now } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { GmailError, open } from "../../providers/gmail.ts";
import { fromAddress, replyContext, sendMessage, validAddress } from "./gmail-send.ts";
import { claim, OUTBOX_STATUSES, type OutboxStatus } from "./outbound.ts";
import { fromLine, identityRow, IdentityRefused, transportFor, verificationWarning } from "../nurture/identities.ts";
import { optedOut } from "../nurture/planner.ts";
import { resendSend } from "../nurture/resend-send.ts";
import { captureEdit } from "../nurture/style.ts";

export const PLUGIN = "outbox";

export const DEFAULT_GAP_DAYS = 14;
export const DEFAULT_DAILY_CAP = 20;

/** This queue's own column values. They ARE the shared vocabulary — see
 *  `OUTBOX_STATUSES` in outbound.ts, which took its names from here because
 *  they read as English about anything you can send. The posting queue's
 *  synonyms map onto the same union through `outboxStatus`. */
export const STATUSES = OUTBOX_STATUSES;
export type Status = OutboxStatus;

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
  /** The three documents that justify a draft, added by the nurture area. JSON
   *  or NULL — NULL on every row written before it existed and on every row the
   *  owner typed himself, which is exactly what "no plan, no facts, nobody
   *  validated it" should look like. */
  plan: string | null;
  facts: string | null;
  validation: string | null;
  /** What the MACHINE wrote, before any editing. The "before" of a style pair.
   *  NULL on an owner-written draft, which is why one teaches nothing. */
  generated_body: string | null;
  identity_id: number | null;
  sent_via: string | null;
  delivery_event: string | null;
  delivery_read_at: string | null;
  sequence_id: number | null;
  sequence_step: number | null;
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

/** Re-exported so this area's routes keep one import, and so `grep` for the
 *  helper still lands in the outbox. The body lives beside the send. */
export { fromAddress };

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
/* --------------------------------------------------------- the two doors */

/**
 * WHICH DOOR THIS ROW LEAVES BY, and the whole From line it leaves with.
 *
 * A row with no `identity_id` is the original behaviour, unchanged and
 * unchangeable by anything in the nurture area: the Gmail account named on the
 * row, from the address Gmail itself reported to the collector, with no display
 * name and no reply-to. Every row written before identities existed is that
 * row, so nothing about an old draft moved.
 *
 * A row WITH an identity resolves through `transportFor`, which is the single
 * place the routing rule lives — and which REFUSES rather than falling back.
 * A quiet fallback to Gmail here would send a message claiming to be from a
 * product domain Gmail is not authorised for: it lands in spam if it lands at
 * all, and from this side it looks like a successful send.
 *
 * `null` when the mailbox has no address yet, which is not an error — it is the
 * state before the Gmail plugin's first collect, and the draft routes report it
 * as "connect and collect Gmail" rather than as a failure.
 */
export type Route = {
  via: "gmail" | "resend";
  accountId: number;
  /** The bare address, for the checks and for the floor. */
  address: string;
  /** The whole From line, display name included. */
  line: string;
  replyTo: string | null;
  identityId: number | null;
};

export function routeFor(r: Pick<OutboxRow, "account_id" | "identity_id">): Route | null {
  if (r.identity_id) {
    const identity = identityRow(r.identity_id);
    if (!identity)
      throw new SendRefused(
        `This message was written from sending identity ${r.identity_id}, which no longer exists. Edit it and choose another.`,
      );
    const t = transportFor(identity);
    return {
      via: t.via,
      accountId: t.accountId,
      address: t.from,
      line: fromLine(t.from, t.fromName),
      replyTo: t.replyTo,
      identityId: identity.id,
    };
  }
  const addr = fromAddress(r.account_id);
  if (!addr) return null;
  return { via: "gmail", accountId: r.account_id, address: addr, line: addr, replyTo: null, identityId: null };
}

/**
 * The route, or null where resolving it REFUSES — for the READ path, which must
 * be able to show a card whose identity has gone wrong rather than failing the
 * whole listing.
 *
 * `reason` AND `warning` ARE NOT THE SAME THING and are kept apart because one
 * of them stops a send and the other does not. `reason` is a refusal: there is
 * no honest From line, the route is null, and `approvalContent` freezes it so
 * the send refuses too. `warning` is a resolved route that Resend has something
 * to say about — "pending", "failed", or never asked. `transportFor`
 * deliberately does not read the verification status (a domain mid-propagation
 * must still be draftable, and a stale "failed" must not block a domain the
 * owner has since fixed), so the warning is carried to the card instead and the
 * owner reads it while he is reading the draft rather than as a 4xx after he
 * has pressed Send.
 */
export function routeOrReason(
  r: Pick<OutboxRow, "account_id" | "identity_id">,
): { route: Route | null; reason: string | null; warning: string | null } {
  try {
    const route = routeFor(r);
    const identity = r.identity_id ? identityRow(r.identity_id) : null;
    return { route, reason: null, warning: identity ? verificationWarning(identity) : null };
  } catch (err) {
    if (err instanceof SendRefused || err instanceof IdentityRefused)
      return { route: null, reason: err.message, warning: null };
    throw err;
  }
}

/** Snapshot every recipient-visible field: the words, the signature, and the
 *  identity and transport that will carry them. The transport is in here on
 *  purpose — an approval is of "this message, from this address, by this door",
 *  so re-pointing an identity at another key after approval fails the check at
 *  send time instead of quietly sending the same words out of a different
 *  domain. */
export function approvalContent(r: OutboxRow): string {
  const { route, reason } = routeOrReason(r);
  return JSON.stringify({
    accountId: route?.accountId ?? r.account_id,
    identityId: r.identity_id ?? null,
    via: route?.via ?? null,
    from: route?.address ?? null,
    fromLine: route?.line ?? null,
    replyTo: route?.replyTo ?? null,
    routeError: reason,
    to: r.to_address,
    subject: r.subject,
    text: preview(r),
    threadId: r.in_reply_to,
  });
}

export function approveDraft(id: number): void {
  const r = row(id);
  if (!r || !["draft", "failed"].includes(r.status)) throw new SendRefused("Only a draft or a confirmed failed delivery can be approved.");
  db.prepare("UPDATE mailflow_outbox SET status = 'approved', approved_at = ?, approved_content = ?, error = NULL WHERE id = ? AND status IN ('draft','failed')")
    .run(now(), approvalContent(r), id);
  /* THE APPROVE IS WHERE AN EDIT BECOMES EVIDENCE, and the only place. A draft
     that was edited and then dismissed taught nothing; this one he is standing
     behind. It is opt-in, it stores nothing when the setting is off, and it
     cannot fail an approval — see nurture/style.ts. */
  captureEdit(r);
}

/**
 * THE ONE DOOR, AND EVERY SUPPRESSION IS RE-ASKED AT IT.
 *
 * A claim survives process crashes; an interrupted send must be reconciled,
 * never retried automatically. The claim itself is `claim` in outbound.ts,
 * shared with the posting queue — this was the correct one of the two and is
 * now the only one.
 *
 * WHY EVERY CHECK IS RUN AGAIN HERE RATHER THAN TRUSTED FROM DRAFT TIME. Time
 * passes between "was it fair to write this" and "may this leave", and the
 * second question is the one that costs something. The floor was already
 * re-asked. THE OPT-OUT WAS NOT, and that was a hole with a person's name on
 * it: `nurture_optouts` was consulted when the draft was planned and never
 * again, so somebody who unsubscribed after a draft was written still got the
 * mail — while the page that recorded their opt-out reported them as opted
 * out. `optOut()` dismisses the live drafts it can see, which covers the
 * ordinary case; this covers the one it cannot, where a draft is approved and
 * sent in the same breath as the opt-out lands. An address that asked not to
 * be written to is a refusal at the door, beside the floor and the cap.
 */
export async function sendApproved(id: number): Promise<OutboxRow> {
  const taken = claim<OutboxRow>({
    read: () => row(id),
    missing: `There is no message ${id}.`,
    guard: (found) => {
      if (found.status !== "approved")
        return "Only an approved draft can be sent. This message may already be sending.";
      if (!found.approved_content || found.approved_content !== approvalContent(found))
        return "The message or signature changed. Edit and approve the latest preview before sending.";
      const out = optedOut(found.to_address);
      if (out)
        return (
          `${found.to_address} asked not to be written to again (recorded ${out.at.slice(0, 10)}` +
          `${out.reason ? `: ${out.reason}` : ""}). Nothing was sent.`
        );
      const s = settings();
      if (floorBlocker(found.to_address, s.gapDays, id))
        return "Another recent message to this recipient is inside the configured contact interval.";
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const used = db
        .prepare(
          "SELECT COUNT(*) AS n FROM mailflow_outbox WHERE sent_at >= ? OR (status IN ('sending','uncertain') AND sending_at >= ?)",
        )
        .get(start.toISOString(), start.toISOString()) as { n: number };
      if (used.n >= s.dailyCap)
        return "Today's sending allowance is used or reserved by messages in progress.";
      return null;
    },
    update: () =>
      db
        .prepare("UPDATE mailflow_outbox SET status = 'sending', sending_at = ? WHERE id = ? AND status = 'approved'")
        .run(now(), id).changes,
    lost: "Another send of this message started in the same instant. It is not sent twice.",
  });
  if (!taken.ok) throw new SendRefused(taken.error);
  const r = taken.row;
  let attempted = false;
  let via: "gmail" | "resend" = "gmail";
  try {
    const approved = JSON.parse(r.approved_content!) as {
      from: string | null; fromLine?: string | null; replyTo?: string | null; via?: string | null;
      accountId?: number; routeError?: string | null;
      to: string; subject: string; text: string; threadId: string | null;
    };
    if (approved.routeError) throw new SendRefused(approved.routeError);
    if (!approved.from)
      throw new SendRefused(
        "There is no From address on this message. Collect its Gmail account so Gmail's own address is known, or give it a sending identity.",
      );
    via = approved.via === "resend" ? "resend" : "gmail";

    /* THE REPLY CONTEXT IS READ FROM GMAIL EITHER WAY, and that is not a
       leak of one transport into the other. `in_reply_to` is a GMAIL thread
       id — the conversation lives in the owner's own mailbox — so the
       Message-ID a reply has to quote is only readable there. Resend then
       carries the reply out under the product's domain with In-Reply-To and
       References taken from that read. It is one metadata GET, exactly the
       shape replyContext has always made. */
    const ctx = approved.threadId
      ? await replyContext(await open("outbox_reply_context", r.account_id), approved.threadId)
      : null;

    if (via === "resend") {
      attempted = true;
      const out = await resendSend(approved.accountId ?? r.account_id, {
        from: approved.fromLine ?? approved.from,
        fromAddress: approved.from,
        to: approved.to,
        replyTo: approved.replyTo ?? null,
        subject: approved.subject,
        text: approved.text,
        inReplyTo: ctx?.messageId ?? null,
        references: ctx?.references ?? null,
        /* The draft's own approved document, hashed. Stable across retries of
           the same approval and different for a re-approved edit, which is
           exactly the de-duplication Resend's key is for. */
        idempotencyKey: `opc-outbox-${id}-${approvalKey(r)}`,
      });
      db.prepare(
        "UPDATE mailflow_outbox SET status = 'sent', sent_at = ?, message_id = ?, sent_via = 'resend', error = NULL WHERE id = ? AND status = 'sending'",
      ).run(now(), out.id, id);
      /* Resend's own reading of what happened to it. A best-effort GET that
         must never turn a completed send into a failure, so it is awaited and
         swallowed. */
      await readDeliveryBack(id, approved.accountId ?? r.account_id, out.id);
      return row(id)!;
    }

    const session = await open("outbox_send", approved.accountId ?? r.account_id);
    attempted = true;
    const out = await sendMessage(session, {
      from: approved.from, to: approved.to, subject: approved.subject, text: approved.text,
      threadId: approved.threadId, inReplyTo: ctx?.messageId, references: ctx?.references,
    });
    db.prepare("UPDATE mailflow_outbox SET status = 'sent', sent_at = ?, message_id = ?, sent_via = 'gmail', error = NULL WHERE id = ? AND status = 'sending'")
      .run(now(), out.messageId, id);
    return row(id)!;
  } catch (err) {
    // A network failure or ambiguous success after POST can have delivered the message.
    const status4xx =
      (err instanceof GmailError && err.status >= 400 && err.status < 500) ||
      (isProviderRefusal(err) && err.status >= 400 && err.status < 500);
    const refused = status4xx || err instanceof SendRefused || err instanceof IdentityRefused;
    const status = attempted && !refused ? "uncertain" : "failed";
    const reason = err instanceof Error ? err.message : String(err);
    const where = via === "resend" ? "the sending domain's Resend log" : "Gmail Sent";
    const error = status === "uncertain" ? `Delivery is uncertain. Check ${where} before taking any further action. ${reason}` : reason;
    db.prepare("UPDATE mailflow_outbox SET status = ?, error = ? WHERE id = ? AND status = 'sending'").run(status, error, id);
    throw new SendRefused(error, 502);
  }
}

/** `ResendError` without importing the provider for a type: the send adapter
 *  throws it and this file only needs its status. A structural check rather
 *  than an `instanceof` keeps the provider out of this module's import graph
 *  for everything except the send itself. */
function isProviderRefusal(err: unknown): err is { status: number } {
  return typeof err === "object" && err !== null && "status" in err && typeof (err as { status: unknown }).status === "number";
}

/**
 * What Resend says happened to a message it accepted.
 *
 * BEST EFFORT, AND NEVER A FAILURE. The send already succeeded when this runs;
 * a read that throws must not turn a delivered message into a failed row. A
 * NULL `delivery_event` therefore means "not read", never "not delivered", and
 * the routes say so.
 *
 * It is read once, immediately, which is early — a message accepted a second
 * ago usually reads as "sent" rather than "delivered". That is honest and it is
 * dated; the routes publish `deliveryReadAt` beside it so a stale reading
 * cannot be mistaken for a final one, and re-reading is a button.
 */
export async function readDeliveryBack(id: number, accountId: number, resendId: string): Promise<string | null> {
  try {
    const { sentEmail } = await import("../../providers/resend.ts");
    const { email } = await sentEmail(accountId, resendId, "outbox_delivery");
    const event = email?.lastEvent ?? null;
    db.prepare("UPDATE mailflow_outbox SET delivery_event = ?, delivery_read_at = ? WHERE id = ?").run(event, now(), id);
    return event;
  } catch {
    db.prepare("UPDATE mailflow_outbox SET delivery_read_at = ? WHERE id = ?").run(now(), id);
    return null;
  }
}

export function recoverInterruptedSends() {
  db.prepare("UPDATE mailflow_outbox SET status = 'uncertain', error = 'The server stopped during delivery. Check Gmail Sent before resolving this message.' WHERE status = 'sending'").run();
}

export function approvalKey(r: OutboxRow) { return createHash("sha256").update(approvalContent(r)).digest("hex"); }

/* ------------------------------------------------- the fact-backed draft */

/**
 * WRITE A DRAFT THAT CARRIES ITS OWN JUSTIFICATION.
 *
 * `POST /api/outbox` still exists and still does what it always did: it takes a
 * recipient, a subject and a body and files them. Nothing about it moved,
 * because that is the route the owner's composer and the `outbox` skill use,
 * and a draft somebody typed himself has no plan and needs none.
 *
 * This is the other door. The nurture area's planner decides who and why, its
 * gatherers assemble the facts, its wording step turns those into sentences and
 * its validator reads them back — and what arrives here is the finished set of
 * four documents. They are stored on the row so the card can show the owner the
 * facts beside the words and the sentence saying whether the model's wording
 * passed. Four columns, one insert, no second table: a plan that could get
 * separated from the draft it justifies would be a plan nobody looks at.
 *
 * IT IS STILL A DRAFT. `status` is written as 'draft' literally, here, and this
 * function does not import the send, cannot reach `approved`, and returns a row
 * that waits like every other one.
 *
 * THE PER-ADDRESS FLOOR IS CHECKED HERE TOO, and it is a refusal rather than an
 * exception: the caller is usually the daily pass, which has to record "this
 * person was skipped and here is why" for twenty people and carry on.
 */
export type PrepareInput = {
  accountId: number;
  to: string;
  subject: string;
  body: string;
  /** The machine's wording before any editing. The "before" of a style pair,
   *  and normally the same string as `body` at insert time. */
  generatedBody: string | null;
  inReplyTo: string | null;
  venture: string | null;
  identityId: number | null;
  createdBy: string;
  plan: unknown;
  facts: unknown;
  validation: unknown;
  sequenceId: number | null;
  sequenceStep: number | null;
};

export function prepareDraft(input: PrepareInput): { item: OutboxRow } | { refused: string } {
  const to = input.to.trim().toLowerCase();
  if (!validAddress(to)) return { refused: `“${input.to}” is not an email address.` };
  const subject = input.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  if (!subject) return { refused: "A draft needs a subject." };
  const body = input.body.trim().slice(0, 20_000);
  if (!body) return { refused: "A draft needs a body." };

  const s = settings();
  const blocker = floorBlocker(to, s.gapDays);
  if (blocker)
    return {
      refused:
        `there is already a message to ${to} from ${blocker.created_at.slice(0, 10)} (${blocker.status}), ` +
        `inside the ${s.gapDays}-day floor this queue keeps — dismissed rows count`,
    };

  const info = db
    .prepare(
      `INSERT INTO mailflow_outbox
         (account_id, to_address, subject, body, in_reply_to, venture, status, created_by, created_at,
          plan, facts, validation, generated_body, identity_id, sequence_id, sequence_step)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.accountId,
      to,
      subject,
      body,
      input.inReplyTo,
      input.venture,
      input.createdBy,
      now(),
      input.plan === undefined ? null : JSON.stringify(input.plan),
      input.facts === undefined ? null : JSON.stringify(input.facts),
      input.validation === undefined ? null : JSON.stringify(input.validation),
      input.generatedBody,
      input.identityId,
      input.sequenceId,
      input.sequenceStep,
    );
  return { item: row(Number(info.lastInsertRowid))! };
}

/** Every live draft written by one sequence. Used by the stop cascade: a draft
 *  written for a step that should no longer happen is taken out of the queue
 *  rather than left sitting there looking approvable. */
export function dismissSequenceDrafts(sequenceId: number, address: string, reason: string): number {
  return db
    .prepare(
      `UPDATE mailflow_outbox SET status = 'dismissed', approved_at = NULL, approved_content = NULL,
              error = ?
        WHERE sequence_id = ? AND lower(to_address) = lower(?) AND status IN ('draft','approved')`,
    )
    .run(`Taken out of the queue: ${reason}.`, sequenceId, address).changes as number;
}
