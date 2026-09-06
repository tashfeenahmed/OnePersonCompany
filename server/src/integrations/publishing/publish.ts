/**
 * THE SUBMISSION — the one place in this server that sends something to
 * somebody else's audience.
 *
 * FOUR CHECKS BEFORE A SOCKET IS OPENED, in this order, because each one makes
 * the next one's failure impossible to confuse:
 *
 *   1. Has this already been submitted? An item carrying an `external_id` is
 *      never sent again, whatever its status. That covers a re-press and a
 *      retried HTTP request. It does NOT cover the worst case — a call that
 *      succeeded and whose answer was lost — because the id is only ever
 *      written from a response this process read, so it is null in exactly
 *      that case. That one is handled by refusing to retry an ambiguous
 *      outcome at all; see the retry decision at the bottom of this file and
 *      `scheduler.reclaim()`.
 *
 *      AND CHECKS 1 AND 2 — THE TWO THAT DECIDE WHETHER IT MAY GO OUT AT ALL —
 *      ARE RUN AGAIN INSIDE THE CLAIM, against the row as re-read there.
 *      Checking here and writing later is checking the past: see `claim` in
 *      mailflow/outbound.ts, and the paragraph above the claim below for what
 *      that cost. Checks 3 and 4 read rows a concurrent submission cannot
 *      change, so they stay where they are.
 *   2. Did the owner approve it? Nothing else in this file cares what the
 *      caption says; this cares that a person read it.
 *   3. Do the platform limits pass? See limits.ts. A refusal here is a
 *      sentence naming one thing to change; a refusal at Meta is a code.
 *   4. Is the credential still there? A destination probed a week ago and a
 *      credential deleted yesterday is a row that looks ready and is not.
 *
 * THE TRANSPORT IS INJECTED AND THE DRY RUN IS THE SAME CODE. A rehearsal runs
 * every step above, resolves the same credential, composes the same body, and
 * differs in exactly one place: the transport answers from a canned table
 * instead of a socket, and this file refuses to write an external id, a
 * permalink or a `published` status from one. That is what lets a box with no
 * posting permission still prove the pipeline — see providers/social.ts.
 *
 * EVERY ATTEMPT IS RECORDED WITH THE CALLS IT MADE, credentials stripped. The
 * item keeps the LATEST error because that is what a queue draws; the attempts
 * table keeps all of them, because "failed three times with three different
 * errors" and "failed three times with the same permission error" are
 * different problems.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as accounts from "../../accounts.ts";
import { db, now } from "../../db.ts";
import {
  appSecretProof,
  parseApp,
  parseLines,
  postInstagramImage,
  postPageFeed,
  postPagePhoto,
  postPageVideo,
  publishablePages,
} from "../../providers/meta.ts";
import * as linkedin from "../../providers/linkedin.ts";
import * as tiktok from "../../providers/tiktok.ts";
import {
  dryTransport,
  failed,
  liveTransport,
  type PublishOutcome,
  type RecordedCall,
  type Transport,
} from "../../providers/social.ts";
import { destinationRow, type DestinationRow } from "./destinations.ts";
import {
  itemRow,
  mimeFromPath,
  problemsFor,
  publicMediaUrl,
  sniff,
  type ItemRow,
} from "./items.ts";
import { settings } from "./settings.ts";
import { claim } from "../mailflow/outbound.ts";

/** A file bigger than this is not read into memory to be posted. It is well
 *  above every per-platform cap in limits.ts, so this is the belt rather than
 *  the braces — it exists so a corrupt path cannot allocate a gigabyte. */
const READ_CAP = 1024 * 1024 * 1024;

/**
 * THE STATUSES A SUBMISSION WILL ACCEPT.
 *
 * `failed` IS IN THE LIST, and it is there because `retry` is a real button. A
 * failed item was approved by the owner before it was ever submitted, and
 * nothing since has withdrawn that — an EDIT would have, by returning it to
 * `draft` (see items.patchItem). Leaving it out made the retry route
 * structurally unable to do anything but 422, which is worse than either
 * offering the retry or removing it: it looked like a feature and was a dead
 * end. Retry is a button on the page and no longer a skill action — see
 * skills.ts's header.
 *
 * `publishing` IS NOT IN THE LIST, AND THAT REMOVAL IS A BUG FIX. It used to
 * be, which meant "this item is being submitted right now" read as "the owner
 * consented to this" — so a second caller arriving mid-flight passed the
 * consent check and opened its own socket. It fired: a tick and a manual
 * Publish on the same item put the same post on a live Page twice. An item in
 * flight is nobody's to take; `scheduler.reclaim()` is what rescues one whose
 * process died, and it does so by moving it to `failed`, which IS in this
 * list, so the retry button still works.
 */
const CONSENTED = ["approved", "scheduled", "failed"];

/** Why this row may not be submitted, or `null`. ONE function, called twice —
 *  once for a fast refusal with a good sentence, and again inside the claim
 *  against the row as it is at the instant of the write. Two copies of this
 *  would be two answers to "may this go out". */
function consentRefusal(r: ItemRow): string | null {
  if (r.external_id)
    return (
      `That item was already submitted as ${r.external_id}. It is not sent again — ` +
      "a double press must not become two posts in somebody's feed."
    );
  if (r.status === "publishing")
    return (
      "That item is being submitted right now, and it is not submitted twice. If this box " +
      "stopped mid-call, `scheduler.reclaim()` settles the row in a few minutes and the error " +
      "will say what to check."
    );
  if (!CONSENTED.includes(r.status))
    return `That item is ${r.status}. Only an approved item is published — approve it first.`;
  return null;
}

export type PublishResult = {
  ok: boolean;
  dry: boolean;
  itemId: string;
  status: string;
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  note: string | null;
  /** What went out, or would have. Credentials already removed. */
  calls: RecordedCall[];
  ms: number;
};

/**
 * Submit one item.
 *
 * `by` names who asked — "owner", "scheduler", a skill's name — and is only
 * used in the note. Nothing about authority is decided here: authority was
 * decided when the item was approved.
 */
export async function publishItem(
  id: string,
  opts: { dry?: boolean; by?: string; transport?: Transport } = {},
): Promise<PublishResult> {
  const started = Date.now();
  const dry = !!opts.dry;
  const row = itemRow(id);
  const base = (over: Partial<PublishResult>): PublishResult => ({
    ok: false,
    dry,
    itemId: id,
    status: row?.status ?? "unknown",
    externalId: null,
    permalink: null,
    error: null,
    note: null,
    calls: [],
    ms: Date.now() - started,
    ...over,
  });

  if (!row) return base({ error: "No item by that id." });

  /* 1 — already out there. Refused even for a rehearsal, because rehearsing a
     post that has already gone is a question with no useful answer. */
  if (row.external_id)
    return base({
      error: consentRefusal(row)!,
      externalId: row.external_id,
      permalink: row.permalink,
    });

  /* 2 — the owner's consent. A dry run is exempt: rehearsing a draft is how
     somebody finds out whether it WOULD go, and nothing leaves this box. */
  const refusal = dry ? null : consentRefusal(row);
  if (refusal) return base({ error: refusal });

  if (!row.destination_id) return base({ error: "That item has no destination." });
  const dest = destinationRow(row.destination_id);
  if (!dest) return base({ error: "That item's destination no longer exists." });

  /* 3 — the platform's own rules, before a byte moves. */
  const problems = problemsFor(row, dest);
  if (problems.length)
    return base({
      error: problems.map((p) => p.message).join(" "),
    });

  const transport = opts.transport ?? (dry ? dryTransport() : liveTransport());

  /*
    THE CLAIM. The item is moved to `publishing` BEFORE the call and the row is
    the only record of that — see the migration. A process killed mid-call
    leaves it here, and the next start reclaims it, having first checked
    `external_id`.

    IT IS TRANSACTIONAL, AND THAT IS NOT BELT-AND-BRACES. This used to be a
    bare `UPDATE ... WHERE id = ?`: no status guard, no transaction. The
    scheduler was kept from racing itself by a boolean in module scope
    (`scheduler.ticking`) that the manual routes do not go through, so a tick
    submitting item X while somebody pressed Publish on X had both callers read
    a null `external_id`, both pass the consent check, and both open a socket.
    That is the exact failure this file's header says it is arranged to prevent
    — and it was prevented for the crash case and not for the concurrent one.
    It happened, on a real account, with two identical posts to show for it.

    Every check above is therefore re-run against the row as re-read inside the
    transaction, and the write names the status it expects, so exactly one
    caller can ever win. See mailflow/outbound.ts, where the mail queue's
    version of this had been correct all along.
  */
  if (!dry) {
    const claimed = claim<ItemRow>({
      read: () => itemRow(id),
      missing: "No item by that id.",
      guard: consentRefusal,
      update: (r) =>
        db
          .prepare(
            `UPDATE publish_items
                SET status = 'publishing', attempts = attempts + 1, last_attempt_at = ?, updated_at = ?
              WHERE id = ? AND status = ? AND external_id IS NULL`,
          )
          .run(now(), now(), id, r.status).changes,
      lost:
        "Another submission of that item started in the same instant, and it is not sent twice. " +
        "Nothing left this machine from here.",
    });
    if (!claimed.ok) return base({ error: claimed.error });
  }

  let outcome: PublishOutcome;
  try {
    outcome = await submit(row, dest, transport);
  } catch (err) {
    /* A publisher that throws is a bug in this repository, not a refused
       post, and the item must survive it intact. */
    outcome = failed(
      `The publisher threw: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    );
  }

  const ms = Date.now() - started;
  recordAttempt(row.id, dry, outcome, transport.calls, ms);

  if (dry) {
    /* NOTHING IS WRITTEN TO THE ITEM BY A REHEARSAL. Not the status, not an
       id, not even a success note — a dry run that left a trace on the row
       would eventually be mistaken for a publish. */
    return base({
      ok: outcome.ok,
      status: row.status,
      error: outcome.error,
      note:
        (outcome.note ? `${outcome.note} ` : "") +
        "Nothing left this machine: this was a rehearsal against a mock transport, and " +
        "the calls listed are what would have been sent.",
      calls: transport.calls,
      ms,
    });
  }

  if (outcome.ok) {
    db.prepare(
      `UPDATE publish_items
          SET status = 'published', external_id = ?, permalink = ?, published_at = ?,
              error = NULL, note = ?, next_attempt_at = NULL, updated_at = ?
        WHERE id = ?`,
    ).run(outcome.id, outcome.url, now(), outcome.note, now(), id);
    return base({
      ok: true,
      status: "published",
      externalId: outcome.id,
      permalink: outcome.url,
      note: outcome.note,
      calls: transport.calls,
      ms,
    });
  }

  const after = itemRow(id)!;
  const max = settings().maxAttempts;
  const exhausted = after.attempts >= max;

  /*
    AN AMBIGUOUS OUTCOME IS NEVER RETRIED, AND THIS IS THE SECOND HALF OF THE
    RULE `scheduler.reclaim()` KEEPS.

    A refusal is a fact: Meta answered 400, the caption was too long, the token
    was revoked. Retrying that is free and sometimes right. A `fetch` that
    THREW is not a fact — a 180-second timeout on `/photos`, a 45-second one on
    `/feed`, TikTok's status poll running out — because the request may well
    have arrived and been accepted, and the answer is simply gone. TikTok's own
    message says so in as many words ("check the app before retrying, or this
    will post it twice"), and until this check existed the code went on to
    retry it five minutes later anyway.

    THE SIGNAL IS ALREADY ON THE WIRE. `liveTransport` records `status: null`
    for a call that threw and a real number for one that answered, so the last
    recorded call tells us which happened. No new plumbing, and it is true of
    all four networks because they all go through the same transport.
  */
  const last = transport.calls.at(-1);
  const ambiguous = last !== undefined && last.status === null;

  /* A retry is only ever offered for something that MIGHT be transient AND
     whose outcome is known. A credential that is not configured will not fix
     itself, and retrying it four times is four identical log lines.

     THE STATUS IS READ FROM `row`, NOT FROM `after`, and that is not a
     shortcut: this function moves the item to `publishing` before the call, so
     by now `after.status` is always "publishing" and a test against it would
     make nothing retryable ever. `row` is the item as it was when somebody
     asked for this submission.

     AND IT IS THE STATUS RATHER THAN A NON-NULL `scheduled_for`. The Autopilot
     writes a PROPOSED date onto a draft (see autopilot-hook.ts), so a row can
     carry a date the owner never scheduled; the old test on `scheduled_for`
     turned a failed "Publish now" on such a row into a real unattended
     schedule for a slot nobody chose. Only an item the owner actually put on
     the calendar goes back on it. */
  const retryable =
    outcome.configured && !exhausted && !ambiguous && row.status === "scheduled";

  const ambiguousError = ambiguous
    ? `${outcome.error ?? "The call did not answer."} THE OUTCOME IS UNKNOWN — the request ` +
      "may have been accepted and the answer lost. Nothing here retries it. Open the account " +
      "and look before you try again; retrying a silent success posts twice."
    : outcome.error;

  db.prepare(
    `UPDATE publish_items
        SET status = ?, error = ?, next_attempt_at = ?, scheduled_for = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    retryable ? "scheduled" : "failed",
    ambiguousError,
    retryable ? new Date(Date.now() + backoffMs(after.attempts)).toISOString() : null,
    /* An ambiguous outcome loses its date as well as its status, for
       reclaim()'s reason: neither a timer nor a later status change may
       resurrect a slot nobody re-chose. */
    retryable ? after.scheduled_for : ambiguous ? null : after.scheduled_for,
    now(),
    id,
  );
  return base({
    ok: false,
    status: retryable ? "scheduled" : "failed",
    error: ambiguousError,
    note: retryable
      ? `Attempt ${after.attempts} of ${max}; the next one is in ${Math.round(backoffMs(after.attempts) / 60_000)} minutes.`
      : ambiguous
        ? "Stopped, deliberately. Check the account before approving another attempt."
        : exhausted
          ? `Given up after ${after.attempts} attempts. Fix what the error says and retry by hand.`
          : outcome.configured
            ? null
            : "Nothing is connected for that destination, so there was nothing to retry.",
    calls: transport.calls,
    ms,
  });
}

/**
 * How long to wait before trying again: 5, 15, 45, 135 minutes, capped at six
 * hours.
 *
 * EXPONENTIAL AND NOT CONSTANT, because the two things that actually fail here
 * are a rate limit and a platform having a bad hour, and both are cured by
 * waiting longer rather than by asking again promptly. Pure, and asserted in
 * the tests, so a change to it is a visible change.
 */
export function backoffMs(attempt: number): number {
  const minutes = Math.min(360, 5 * Math.pow(3, Math.max(0, attempt - 1)));
  return Math.round(minutes * 60_000);
}

/* --------------------------------------------------------- the publishers */

async function submit(
  row: ItemRow,
  dest: DestinationRow,
  t: Transport,
): Promise<PublishOutcome> {
  const caption = row.caption ?? "";
  const media = row.media_path ? readMedia(row.media_path) : null;
  if (row.media_path && !media)
    return failed("The media file could not be read off this disk.");

  if (dest.plugin_id === "meta") return submitMeta(row, dest, caption, media, t);
  if (dest.plugin_id === "linkedin") return submitLinkedIn(dest, caption, media, t);
  if (dest.plugin_id === "tiktok") return submitTikTok(row, dest, caption, t);
  return failed(`There is no publisher here for ${dest.plugin_id}.`, false);
}

function readMedia(path: string): { bytes: Uint8Array; mime: string; name: string } | null {
  try {
    const buf = readFileSync(path);
    if (buf.length > READ_CAP) return null;
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return { bytes, mime: sniff(bytes) ?? mimeFromPath(path), name: basename(path) };
  } catch {
    return null;
  }
}

/** One plugin account's credential set, or null. Read at the moment of the
 *  call rather than held: a credential deleted between the probe and the
 *  publish is a refusal, not a stale token being used. */
function credentialsFor(
  plugin: string,
  accountId: number | null,
  fields: string[],
): Record<string, string> | null {
  const { ready } = accounts.credentialed(plugin, fields, "publish");
  if (!ready.length) return null;
  const match = accountId !== null ? ready.find((r) => r.account.id === accountId) : undefined;
  return (match ?? ready[0])!.values;
}

/**
 * Facebook and Instagram, both through the Page token.
 *
 * THE PAGE TOKEN IS FETCHED FRESH ON EVERY PUBLISH and is never stored. It is
 * derived from the system user's token, it can be revoked by a role change,
 * and a stale one in a table would produce a refusal nobody could explain. One
 * extra Graph call per post is the correct price for that.
 */
async function submitMeta(
  row: ItemRow,
  dest: DestinationRow,
  caption: string,
  media: { bytes: Uint8Array; mime: string; name: string } | null,
  t: Transport,
): Promise<PublishOutcome> {
  const values = credentialsFor("meta", dest.account_id, ["token"]);
  if (!values) return failed("The Meta account this destination came from is not connected.", false);
  const token = parseLines(values.token)[0] ?? "";
  if (!token) return failed("The stored Meta token has no usable line.", false);
  const app = parseApp(values.app);
  const proof = app ? appSecretProof(token, app) : null;

  const listing = await publishablePages(token, proof, t);
  if (!listing.ok) return failed(`Meta would not list the Pages — ${listing.error}`);

  /* An Instagram destination is reached THROUGH the Page it is linked to, so
     both kinds look for a Page here: the FB one by its own id, the IG one by
     the Page whose `instagram_business_account` matches. */
  const page =
    dest.kind === "page"
      ? listing.pages.find((p) => p.id === dest.external_id)
      : listing.pages.find((p) => p.instagram.id === dest.external_id);

  /*
    A REHEARSAL DOES NOT HAVE THE REAL LISTING, because the transport answered
    `/me/accounts` from a table. Matching a canned Page id against a real
    destination would fail every dry run for a reason that is about the mock
    rather than about the post — so a dry transport gets a synthetic page
    carrying the destination's own id and a placeholder token.

    What the rehearsal then proves is exactly what it can prove: that the
    pipeline reaches the API call, with the right path and the right body. It
    proves NOTHING about permission. That is what the destination probe is for,
    and the two are deliberately separate answers.
  */
  const resolved =
    page ??
    (t.dry
      ? {
          id: dest.kind === "ig" ? "DRY-PAGE" : dest.external_id,
          token: "DRY-PAGE-TOKEN",
          instagram: { id: dest.external_id, username: dest.handle },
        }
      : undefined);
  if (!resolved)
    return failed(
      dest.kind === "page"
        ? `This token no longer administers Page ${dest.external_id}. Probe the destinations again.`
        : `No Page this token administers is linked to Instagram account ${dest.external_id}.`,
    );
  if (!resolved.token)
    return failed(
      "Meta would not mint a Page access token for that Page, so nothing can be posted as it. " +
        "The system user needs a ROLE on the Page in Business settings — the scope is not the problem.",
      false,
    );

  if (dest.kind === "ig") {
    const url = publicMediaUrl(row.id);
    if (!url)
      return failed(
        "Instagram fetches the picture itself, and no public base URL is set. " +
          "Set `publicBaseUrl` under Integrations → Publishing.",
        false,
      );
    return postInstagramImage({ id: dest.external_id, token: resolved.token }, caption, url, t);
  }

  const cred = { id: resolved.id, token: resolved.token };
  if (!media) return postPageFeed(cred, caption, t);
  if (row.media_kind === "video") return postPageVideo(cred, caption, media, t);
  return postPagePhoto(cred, caption, media, t);
}

async function submitLinkedIn(
  dest: DestinationRow,
  caption: string,
  media: { bytes: Uint8Array; mime: string; name: string } | null,
  t: Transport,
): Promise<PublishOutcome> {
  const values = credentialsFor("linkedin", dest.account_id, ["token", "author"]);
  if (!values) return failed("The LinkedIn account this destination came from is not connected.", false);
  const { urn } = linkedin.parseUrn(values.author);
  if (!urn) return failed("The stored LinkedIn author is not a URN.", false);
  const cred = { token: (values.token ?? "").trim(), author: urn };
  if (!media) return linkedin.postText(cred, caption, t);
  return linkedin.postImage(cred, caption, media, null, t);
}

async function submitTikTok(
  row: ItemRow,
  dest: DestinationRow,
  caption: string,
  t: Transport,
): Promise<PublishOutcome> {
  const values = credentialsFor("tiktok", dest.account_id, ["token"]);
  if (!values) return failed("The TikTok account this destination came from is not connected.", false);
  const url = publicMediaUrl(row.id);
  if (!url)
    return failed(
      "TikTok pulls the clip from a URL, and no public base URL is set. Set `publicBaseUrl` " +
        "under Integrations → Publishing, and verify its domain in the TikTok developer portal.",
      false,
    );
  return tiktok.postVideo({ token: (values.token ?? "").trim() }, { url, title: caption }, t);
}

/* ---------------------------------------------------------- the attempts */

function recordAttempt(
  itemId: string,
  dry: boolean,
  outcome: PublishOutcome,
  calls: RecordedCall[],
  ms: number,
) {
  db.prepare(
    "INSERT INTO publish_attempts (item_id, ts, dry, ok, calls, external_id, permalink, error, ms) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    itemId,
    now(),
    dry ? 1 : 0,
    outcome.ok ? 1 : 0,
    JSON.stringify(calls),
    dry ? null : outcome.id,
    dry ? null : outcome.url,
    outcome.error,
    ms,
  );
}

export type AttemptRow = {
  id: number;
  item_id: string;
  ts: string;
  dry: number;
  ok: number;
  calls: string;
  external_id: string | null;
  permalink: string | null;
  error: string | null;
  ms: number | null;
};

export function attemptRows(itemId: string, limit = 20): AttemptRow[] {
  return db
    .prepare("SELECT * FROM publish_attempts WHERE item_id = ? ORDER BY id DESC LIMIT ?")
    .all(itemId, Math.max(1, Math.min(100, limit))) as unknown as AttemptRow[];
}

export function shapeAttempt(r: AttemptRow) {
  let calls: RecordedCall[] = [];
  try {
    calls = JSON.parse(r.calls) as RecordedCall[];
  } catch {
    calls = [];
  }
  return {
    id: r.id,
    at: r.ts,
    dry: r.dry === 1,
    ok: r.ok === 1,
    externalId: r.external_id,
    permalink: r.permalink,
    error: r.error,
    ms: r.ms,
    calls,
  };
}
