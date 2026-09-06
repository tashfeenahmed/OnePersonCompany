/**
 * THE OUTBOUND LIFECYCLE, SHARED BY EVERY QUEUE ON THIS BOX THAT SENDS.
 *
 * Two of them exist — mail (`mailflow_outbox`) and posts (`publish_items`) —
 * and they had grown two vocabularies and two ideas about how an item is
 * TAKEN before the network call. One of those two ideas was wrong, and it put
 * a real duplicate post on a live account.
 *
 * WHAT WENT WRONG, because it is the reason this module exists.
 *
 * The posting queue claimed an item with a bare `UPDATE ... WHERE id = ?`: no
 * status in the WHERE, no transaction, and `publishing` — the in-flight status
 * itself — was on the list of statuses a submission would accept. The
 * scheduler was kept from racing itself by a boolean in module scope, which
 * the manual "publish now" route does not go through at all. So a tick
 * submitting item X while somebody pressed Publish on X read the same row,
 * both saw a null external id, both passed the consent check, and both opened
 * a socket. Two identical posts in somebody's feed, nobody having asked for
 * either.
 *
 * An in-process flag is not a lock. It is invisible to every other entry point
 * in the process, and it is gone the moment the process restarts. The database
 * is the only thing both callers share, so the claim has to happen there.
 *
 * THE CORRECT VERSION ALREADY EXISTED, one directory away, in the mail
 * outbox's `sendApproved`: `BEGIN IMMEDIATE`, re-read the row inside the
 * transaction, re-run every check against what was just read, and write the
 * in-flight status with the OLD status in the WHERE clause. That is what is
 * extracted here, so there is one of it.
 *
 * THE FOUR PROPERTIES A CLAIM HAS TO HAVE:
 *
 *   1. `BEGIN IMMEDIATE`, not `BEGIN`. A deferred transaction takes its write
 *      lock at the first write, which is after the read — the window this is
 *      meant to close. Immediate takes it up front, so the second caller
 *      blocks at the door rather than reading a row that is about to change.
 *   2. THE ROW IS RE-READ INSIDE THE TRANSACTION. Whatever the caller decided
 *      from the row it loaded a moment ago is a decision about the past.
 *   3. THE UPDATE NAMES THE STATUS IT EXPECTS. `WHERE id = ? AND status = ?`
 *      is what makes the write itself the arbitration; without it two claims
 *      both "succeed" and the second one silently overwrites the first.
 *   4. ZERO ROWS CHANGED IS A REFUSAL, NEVER A SHRUG. The guarded UPDATE
 *      changing nothing means somebody else got there first, and the only safe
 *      answer to that is to not send. Both callers of this preferred refusing
 *      to send over sending twice, and that preference is now enforced here
 *      rather than restated in each of them.
 */
import { db } from "../../db.ts";

/* ------------------------------------------------------- the vocabulary */

/**
 * THE STATES AN OUTBOUND ITEM CAN BE IN, named once.
 *
 * The two queues had the same seven states under different words —
 * sent/published, dismissed/cancelled, sending/publishing — with no shared
 * type, so nothing could check one against the other and a reader of one had
 * to learn the other's synonyms. The names below are the mail queue's, because
 * they are the ones that read as English about anything you can send.
 *
 * Each queue keeps its own column values (they are already on the owner's
 * disk and a rename is a migration, not a refactor); what they share is this
 * shape, and `outboxStatus` is the one place the translation lives.
 */
export const OUTBOX_STATUSES = [
  /** Written, not offered. Nothing may act on it. */
  "draft",
  /** A person read it and said yes to THIS document. */
  "approved",
  /** Claimed by a sender. Exactly one claim ever succeeds — see `claim`. */
  "sending",
  /** It left. Terminal. */
  "sent",
  /** It did not leave, and we know that. Terminal, but re-approvable. */
  "failed",
  /** Withdrawn by a person before it left. Terminal. */
  "dismissed",
  /** The call may or may not have arrived. NEVER retried automatically — see
   *  the note below. Terminal until a person looks. */
  "uncertain",
] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * `uncertain` IS NOT A SYNONYM FOR `failed`, AND THE DIFFERENCE IS THE WHOLE
 * SAFETY ARGUMENT OF BOTH QUEUES.
 *
 * A refusal is a fact: the API answered 400, the address bounced, the token was
 * revoked. Retrying that costs nothing. A call that THREW is not a fact — the
 * request may well have arrived and been accepted and the answer simply lost —
 * and none of the APIs on the other end of either queue offers an idempotency
 * key that could tell the two apart after the event. So an ambiguous outcome
 * stops, with a sentence naming what to go and look at. Retrying a silent
 * success is the duplicate this module exists to prevent, arriving by the other
 * road. The posting queue spells this state `failed` with the ambiguity in the
 * error text; that difference is a migration and not a refactor.
 *
 * ---
 *
 * One queue's own word for a state, mapped onto the shared one. Unknown words
 * map to `null` rather than to a guess: a status this module has never heard of
 * must not be quietly filed as `draft`. `publishing/items.ts` narrows its own
 * union through this, so a status added to one queue without a word in the
 * other fails to compile rather than drifting.
 */
export function outboxStatus(raw: string): OutboxStatus | null {
  const alias: Record<string, OutboxStatus> = {
    /* The posting queue's words. */
    published: "sent",
    publishing: "sending",
    cancelled: "dismissed",
    scheduled: "approved",
    /* Its ambiguous outcome is a `failed` row carrying a sentence, so far. */
  };
  const v = raw.trim().toLowerCase();
  return alias[v] ?? ((OUTBOX_STATUSES as readonly string[]).includes(v) ? (v as OutboxStatus) : null);
}

/* ------------------------------------------------------------- the claim */

export type Claim<R> = { ok: true; row: R } | { ok: false; error: string };

export type ClaimSpec<R> = {
  /** Re-read the row. Called INSIDE the transaction; whatever the caller read
   *  before is a decision about the past. */
  read: () => R | undefined;
  /** What to say when `read` finds nothing. */
  missing: string;
  /**
   * Every reason this row may not be claimed, re-run against what `read` just
   * returned. Return the refusal sentence, or `null` to allow.
   *
   * PUT THE CHEAP, ROW-LOCAL CHECKS HERE and leave the expensive ones outside.
   * The transaction holds a write lock on the whole database for as long as
   * this runs, and a network call inside it would hold that lock for a
   * timeout. Everything a caller re-checks here today is a read of one or two
   * rows.
   */
  guard: (row: R) => string | null;
  /**
   * The guarded UPDATE, returning `changes`. It MUST name the expected status
   * in its WHERE clause — property 3 in the header — and it must move the row
   * to the in-flight status, so that a second claim's `guard` refuses.
   */
  update: (row: R) => number | bigint;
  /** What to say when the guarded UPDATE changed nothing: somebody else
   *  claimed it between the read and the write. Callers write their own,
   *  because "this message may already be sending" and "another submission of
   *  that post started first" are read by different people. */
  lost: string;
};

/**
 * Take exclusive ownership of a row before a network call, or refuse.
 *
 * Synchronous by construction, and that matters: `better-sqlite3` is
 * synchronous, so nothing else in this single-threaded process can interleave
 * between `BEGIN IMMEDIATE` and `COMMIT`. The transaction is what protects
 * against a second OS process; the synchrony is what protects against the
 * second `await` in this one. Both callers therefore claim before their first
 * `await` and there is no window at all.
 *
 * ANYTHING THROWN BY A GUARD ROLLS BACK AND PROPAGATES. A guard that throws is
 * a bug, and leaving a transaction open on a bug would wedge every subsequent
 * write on the box.
 */
export function claim<R>(spec: ClaimSpec<R>): Claim<R> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = spec.read();
    if (!row) {
      db.exec("ROLLBACK");
      return { ok: false, error: spec.missing };
    }
    const refusal = spec.guard(row);
    if (refusal) {
      db.exec("ROLLBACK");
      return { ok: false, error: refusal };
    }
    if (Number(spec.update(row)) !== 1) {
      db.exec("ROLLBACK");
      return { ok: false, error: spec.lost };
    }
    db.exec("COMMIT");
    return { ok: true, row };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
