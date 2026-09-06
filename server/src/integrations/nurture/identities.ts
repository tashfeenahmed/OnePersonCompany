/**
 * SENDING IDENTITIES — who a message claims to be from, and which transport is
 * entitled to make that claim.
 *
 * THE ROUTING RULE, written once and enforced in one place (`transportFor`):
 *
 *   identity.kind = 'gmail'   -> Gmail's messages.send, from the mailbox's OWN
 *                                address as Google reported it. Any other From
 *                                is refused HERE, because Gmail would refuse it
 *                                later and less clearly.
 *   identity.kind = 'resend'  -> Resend's POST /emails with the key belonging
 *                                to that domain. One key per sending domain on
 *                                this account, so the key IS the authorisation.
 *   no identity               -> exactly what the outbox did before this area
 *                                existed: the Gmail account on the row.
 *
 * WHY A QUIET FALLBACK WOULD BE THE BUG. If an identity's transport cannot be
 * resolved the send is refused with a sentence naming what WOULD work. The
 * alternative — dropping back to Gmail — sends a message claiming to be from a
 * product domain that Gmail is not authorised for. That lands in spam if it
 * lands at all, and it looks from here like a successful send.
 *
 * VERIFICATION IS RESEND'S ANSWER, READ AND STORED, NEVER A JUDGEMENT MADE
 * HERE. `GET /domains` on the identity's own key returns a status per domain —
 * "verified", "pending", "failed", "temporary_failure" — and that word is what
 * goes in the column. It is never reduced to a boolean: "pending" is a domain
 * whose DNS has not propagated and "failed" is a domain that will bounce, and
 * a page that showed both as "not verified" would send the owner to fix the
 * wrong thing. NULL means nobody has asked, which is not "unverified".
 *
 * A GMAIL IDENTITY HAS NO RESEND STATUS and never will. Its `verified` stays
 * NULL and the routes say "Gmail's own mailbox" rather than inventing a status
 * to fill a column.
 */
import { db, gmailMailboxes, now, ventureRowById } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { domains as resendDomains, ResendError } from "../../providers/resend.ts";
import { validAddress } from "../mailflow/gmail-send.ts";

export const KINDS = ["gmail", "resend"] as const;
export type IdentityKind = (typeof KINDS)[number];

export type IdentityRow = {
  id: number;
  venture: string | null;
  kind: string;
  from_name: string;
  from_address: string;
  reply_to: string | null;
  account_id: number;
  is_default: number;
  verified: string | null;
  verified_at: string | null;
  verify_note: string | null;
  created_at: string;
  updated_at: string;
};

export const domainOf = (address: string) => address.split("@")[1]?.toLowerCase() ?? "";

/* ------------------------------------------------------------------- reads */

export function identityRows(): IdentityRow[] {
  return db
    .prepare("SELECT * FROM nurture_send_identities ORDER BY venture IS NULL, venture, is_default DESC, id")
    .all() as unknown as IdentityRow[];
}

export function identityRow(id: number): IdentityRow | undefined {
  return db.prepare("SELECT * FROM nurture_send_identities WHERE id = ?").get(id) as
    | IdentityRow
    | undefined;
}

/**
 * The identity a draft for this venture is written from.
 *
 * The venture's default first, then any identity of that venture, then the
 * global default — and null rather than "the first row in the table" when none
 * of those exist. A From line picked at random is a From line nobody chose.
 */
export function defaultIdentity(ventureId: string | null): IdentityRow | null {
  const rows = identityRows();
  if (ventureId) {
    const mine = rows.filter((r) => r.venture === ventureId);
    return mine.find((r) => r.is_default === 1) ?? mine[0] ?? null;
  }
  return rows.find((r) => r.venture === null && r.is_default === 1) ?? null;
}

/* ------------------------------------------------------------- the transport */

export type Transport =
  | { via: "gmail"; accountId: number; from: string; fromName: string; replyTo: string | null }
  | { via: "resend"; accountId: number; from: string; fromName: string; replyTo: string | null };

export class IdentityRefused extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = "IdentityRefused";
    this.status = status;
  }
}

/** The address a Gmail plugin account sends FROM, as Gmail itself reported it
 *  to the collector. Null before the first collect, in which case there is
 *  nothing honest to put on a From line. */
export function gmailAddress(accountId: number): string | null {
  const box = gmailMailboxes().find((b) => b.account_id === accountId);
  const addr = (box?.address ?? "").trim();
  return addr && validAddress(addr) ? addr : null;
}

/**
 * Resolve one identity to a transport, or refuse with a sentence naming what
 * would have worked. This is the single place the routing rule is applied; a
 * second copy would be a second answer to "may this claim be made".
 */
export function transportFor(identity: IdentityRow): Transport {
  if (!validAddress(identity.from_address))
    throw new IdentityRefused(`“${identity.from_address}” is not an address.`);

  if (identity.kind === "gmail") {
    const account = accounts.list("gmail").find((a) => a.id === identity.account_id && a.connected);
    if (!account)
      throw new IdentityRefused(
        `That identity is bound to Gmail account ${identity.account_id}, which is not connected. Reconnect it in Integrations → Gmail, or point the identity at another account.`,
      );
    const mailbox = gmailAddress(identity.account_id);
    if (!mailbox)
      throw new IdentityRefused(
        "Collect that Gmail account once so its own address is known; until then there is nothing honest to put on the From line.",
      );
    if (mailbox !== identity.from_address.toLowerCase())
      throw new IdentityRefused(
        `Gmail account ${identity.account_id} sends as ${mailbox}, not as ${identity.from_address}. Google refuses a From it does not own, so this is refused here where the reason is readable.`,
      );
    return {
      via: "gmail",
      accountId: identity.account_id,
      from: mailbox,
      fromName: identity.from_name,
      replyTo: identity.reply_to,
    };
  }

  if (identity.kind === "resend") {
    const account = accounts.list("resend").find((a) => a.id === identity.account_id && a.connected);
    if (!account)
      throw new IdentityRefused(
        `That identity is bound to Resend key ${identity.account_id}, which is not connected. Each Resend key here is scoped to one sending domain; add or reconnect the key for ${domainOf(identity.from_address)} in Integrations → Resend.`,
      );
    /* The account is LABELLED with its domain — that is how the Resend plugin
       names its ten keys — so a key/address mismatch is catchable without a
       network call. A label that is not a domain (somebody renamed it) is not
       treated as a mismatch: Resend's own 403 names the domain and the key,
       and that is a better error than a guess made from a label. */
    const label = account.label.trim().toLowerCase();
    if (label.includes(".") && label !== domainOf(identity.from_address))
      throw new IdentityRefused(
        `That Resend key is for ${label}, and ${identity.from_address} is on ${domainOf(identity.from_address)}. A Resend key here is scoped to one domain, so this send would be refused by Resend.`,
      );
    return {
      via: "resend",
      accountId: identity.account_id,
      from: identity.from_address,
      fromName: identity.from_name,
      replyTo: identity.reply_to,
    };
  }

  throw new IdentityRefused(
    `“${identity.kind}” is not a transport. They are: ${KINDS.join(", ")}.`,
  );
}

/** The From line as it goes on the wire. A display name with a comma or a
 *  quote in it is quoted; anything with a newline never reaches here, because
 *  gmail-send.ts and resend-send.ts both refuse one. */
export function fromLine(from: string, name: string): string {
  const clean = name.replace(/[\r\n"]+/g, " ").trim();
  if (!clean) return from;
  return /[,;<>@]/.test(clean) ? `"${clean}" <${from}>` : `${clean} <${from}>`;
}

/**
 * WHAT RESEND'S STORED WORD MEANS FOR SENDING, or null when it says nothing
 * worrying.
 *
 * NOT PART OF `transportFor`, deliberately. A status is a reading taken at a
 * moment, and refusing on it would mean a domain mid-DNS-propagation
 * ("pending") could not be drafted for at all, and a stale "failed" from before
 * the owner fixed his records would block a domain that now works. It is a
 * WARNING, surfaced on the sequence's `problems` and on the outbox card's
 * `fromError`, so the owner sees it while the draft is being read rather than
 * as a 4xx after he has pressed Send.
 *
 * NULL `verified` — nobody has asked — is its own sentence and not silence: an
 * identity that has never been checked is exactly the one whose first use would
 * be its first test, and its first use is a real email.
 */
export function verificationWarning(identity: IdentityRow): string | null {
  if (identity.kind !== "resend") return null;
  const status = (identity.verified ?? "").trim().toLowerCase();
  if (status === "verified") return null;
  if (!status)
    return `Resend has not been asked about ${domainOf(identity.from_address)} yet, so whether it can send is unknown here. Press “Ask Resend again”.`;
  return (
    `Resend reports ${domainOf(identity.from_address)} as “${identity.verified}”, not “verified”` +
    `${identity.verify_note ? ` — ${identity.verify_note}` : ""}. A send may be refused.`
  );
}

/* ------------------------------------------------------------- verification */

/**
 * Ask Resend what it thinks of this identity's domain, and write down the
 * answer.
 *
 * ONE GET. It reaches `providers/resend.ts`, whose every function is a read and
 * which cannot construct a POST by any argument — the send lives in
 * `resend-send.ts` next door for exactly the reason gmail-send.ts lives outside
 * providers/gmail.ts.
 *
 * A DOMAIN THE KEY CANNOT SEE IS A REFUSAL, NOT AN EMPTY ANSWER. `GET /domains`
 * on a per-domain key returns that domain and nothing else, so an identity
 * whose domain is absent from the list is an identity that key is not entitled
 * to send as, and the note says so rather than leaving `verified` null and the
 * owner guessing.
 */
export async function verifyIdentity(
  id: number,
  reader = "nurture_identity_verify",
): Promise<IdentityRow> {
  const row = identityRow(id);
  if (!row) throw new IdentityRefused(`There is no identity ${id}.`, 404);

  if (row.kind === "gmail") {
    /* Gmail's own answer is the transport check: it either owns the address or
       it does not, and there is no third state to store. */
    let note: string;
    let status: string | null;
    try {
      transportFor(row);
      note = "Gmail's own mailbox. Resend has no opinion about it and none is stored.";
      status = "mailbox";
    } catch (err) {
      note = err instanceof Error ? err.message : String(err);
      status = "refused";
    }
    db.prepare(
      "UPDATE nurture_send_identities SET verified = ?, verified_at = ?, verify_note = ?, updated_at = ? WHERE id = ?",
    ).run(status, now(), note, now(), id);
    return identityRow(id)!;
  }

  const domain = domainOf(row.from_address);
  let status: string | null = null;
  let note: string;
  try {
    const list = await resendDomains(row.account_id, reader);
    const found = list.find((d) => d.name.toLowerCase() === domain);
    if (found) {
      status = found.status;
      note =
        `Resend reports ${found.name} as “${found.status ?? "no status"}”` +
        (found.sending ? `, sending ${found.sending}` : "") +
        ". This is Resend's word, read on the date beside it, not a judgement made here.";
    } else {
      status = "unknown";
      note =
        `That Resend key can see ${list.length ? list.map((d) => d.name).join(", ") : "no domain at all"} — not ${domain}. ` +
        "A key here is scoped to one sending domain, so this identity would be refused by Resend. Point it at the key for its own domain.";
    }
  } catch (err) {
    status = null;
    note =
      err instanceof ResendError
        ? `Resend answered HTTP ${err.status} — ${err.body}. Nothing was stored as a status: “could not ask” is not “not verified”.`
        : `Could not reach Resend (${err instanceof Error ? err.message : String(err)}). “Could not ask” is not “not verified”.`;
  }

  db.prepare(
    "UPDATE nurture_send_identities SET verified = ?, verified_at = ?, verify_note = ?, updated_at = ? WHERE id = ?",
  ).run(status, now(), note, now(), id);
  return identityRow(id)!;
}

/* ------------------------------------------------------------------ writes */

export function createIdentity(input: {
  venture: string | null;
  kind: string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  accountId: number;
  isDefault: boolean;
}): IdentityRow {
  const address = input.fromAddress.trim().toLowerCase();
  if (!validAddress(address)) throw new IdentityRefused(`“${input.fromAddress}” is not an address.`, 400);
  if (!(KINDS as readonly string[]).includes(input.kind))
    throw new IdentityRefused(`“${input.kind}” is not a transport. They are: ${KINDS.join(", ")}.`, 400);
  if (input.replyTo && !validAddress(input.replyTo))
    throw new IdentityRefused(`“${input.replyTo}” is not an address.`, 400);
  if (input.venture && !ventureRowById(input.venture))
    throw new IdentityRefused(`There is no venture “${input.venture}”.`, 400);
  if (db.prepare("SELECT id FROM nurture_send_identities WHERE from_address = ?").get(address))
    throw new IdentityRefused(
      `There is already an identity for ${address}. Two rows claiming one address is two answers to “which transport sends as this”.`,
      409,
    );

  const at = now();
  const info = db
    .prepare(
      `INSERT INTO nurture_send_identities
         (venture, kind, from_name, from_address, reply_to, account_id, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(
      input.venture,
      input.kind,
      input.fromName.replace(/[\r\n]+/g, " ").trim().slice(0, 120),
      address,
      input.replyTo ? input.replyTo.trim().toLowerCase() : null,
      Math.trunc(input.accountId),
      at,
      at,
    );
  const id = Number(info.lastInsertRowid);
  if (input.isDefault) makeDefault(id);
  return identityRow(id)!;
}

/** Exactly one default per venture, in one transaction, so there is never an
 *  instant with two — or with none where there was one. */
export function makeDefault(id: number): IdentityRow {
  const row = identityRow(id);
  if (!row) throw new IdentityRefused(`There is no identity ${id}.`, 404);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (row.venture === null)
      db.prepare("UPDATE nurture_send_identities SET is_default = 0 WHERE venture IS NULL").run();
    else
      db.prepare("UPDATE nurture_send_identities SET is_default = 0 WHERE venture = ?").run(row.venture);
    db.prepare("UPDATE nurture_send_identities SET is_default = 1, updated_at = ? WHERE id = ?").run(now(), id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return identityRow(id)!;
}

export function updateIdentity(
  id: number,
  patch: { fromName?: string; replyTo?: string | null; venture?: string | null; accountId?: number },
): IdentityRow {
  const row = identityRow(id);
  if (!row) throw new IdentityRefused(`There is no identity ${id}.`, 404);
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (patch.fromName !== undefined) {
    sets.push("from_name = ?");
    args.push(patch.fromName.replace(/[\r\n]+/g, " ").trim().slice(0, 120));
  }
  if (patch.replyTo !== undefined) {
    const v = patch.replyTo ? patch.replyTo.trim().toLowerCase() : null;
    if (v && !validAddress(v)) throw new IdentityRefused(`“${v}” is not an address.`, 400);
    sets.push("reply_to = ?");
    args.push(v);
  }
  if (patch.venture !== undefined) {
    if (patch.venture && !ventureRowById(patch.venture))
      throw new IdentityRefused(`There is no venture “${patch.venture}”.`, 400);
    sets.push("venture = ?", "is_default = 0");
    args.push(patch.venture);
  }
  if (patch.accountId !== undefined) {
    sets.push("account_id = ?", "verified = NULL", "verified_at = NULL", "verify_note = NULL");
    args.push(Math.trunc(patch.accountId));
  }
  if (!sets.length) throw new IdentityRefused("Nothing to change.", 400);
  db.prepare(`UPDATE nurture_send_identities SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(
    ...args,
    now(),
    id,
  );
  return identityRow(id)!;
}

/**
 * Remove an identity.
 *
 * REFUSED WHILE ANYTHING POINTS AT IT — a sequence that writes from it, or a
 * draft that has not left. Deleting it would leave those rows naming an
 * identity that no longer exists, and the failure would surface at send time as
 * "identity 4" rather than as a sentence. Sent rows keep the id: they are a
 * record of a message that really went out from that address, and a foreign key
 * cannot be the reason history is edited.
 */
export function deleteIdentity(id: number): void {
  const row = identityRow(id);
  if (!row) throw new IdentityRefused(`There is no identity ${id}.`, 404);
  const seqs = (db.prepare("SELECT COUNT(*) AS n FROM nurture_sequences WHERE identity_id = ?").get(id) as { n: number }).n;
  if (seqs)
    throw new IdentityRefused(
      `${seqs} sequence${seqs === 1 ? "" : "s"} write${seqs === 1 ? "s" : ""} from this identity. Point them elsewhere first.`,
    );
  const live = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM mailflow_outbox WHERE identity_id = ? AND status IN ('draft','approved','sending','failed','uncertain')",
      )
      .get(id) as { n: number }
  ).n;
  if (live)
    throw new IdentityRefused(
      `${live} message${live === 1 ? "" : "s"} in the outbox ${live === 1 ? "is" : "are"} written from this identity and ${live === 1 ? "has" : "have"} not left. Dismiss or send them first.`,
    );
  db.prepare("DELETE FROM nurture_send_identities WHERE id = ?").run(id);
}
