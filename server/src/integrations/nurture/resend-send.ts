/**
 * THE SECOND SEND. This file and `mailflow/gmail-send.ts` are the only two
 * places in this repository that can put a message into somebody else's inbox,
 * and this one is deliberately twelve lines of HTTP surrounded by three pages
 * of fence, exactly like its twin.
 *
 * WHY IT IS HERE AND NOT IN providers/resend.ts. That file's header makes a
 * claim it has kept since it was written: `get` hard-codes `method: "GET"`,
 * there is no body parameter, and `POST /emails` is not reachable from that
 * module by any argument. Adding a send to it would falsify a paragraph other
 * people have read and believed. So the send lives beside the queue that is the
 * only thing allowed to call it, and the provider keeps its sentence — with one
 * note added there pointing at this file, because a narrowed claim you have to
 * grep for is not a claim.
 *
 * WHAT MAKES "NOTHING SENDS WITHOUT AN APPROVE" STILL TRUE, now that there are
 * two doors rather than one. This is the list to preserve rather than the
 * prose:
 *
 *   1. `resendSend` is exported from here and imported in exactly ONE place —
 *      `mailflow/outbox.ts`, by `sendApproved`. `grep -rn resendSend src/`
 *      returns this file and that call, which is the same shape the Gmail door
 *      has kept.
 *   2. `sendApproved` refuses any row that is not `approved`, whichever
 *      transport it is about to use. The only route that writes `approved` is
 *      the owner's approve route, which rejects a request carrying the skills
 *      proxy's own header — and the `outbox` skill publishes no approve and no
 *      send action for it to reject in the first place.
 *   3. The nurture area's daily pass writes DRAFTS. It has no import of this
 *      file, and none of the outbox's send.
 *   4. This function takes a prepared body and cannot compose one: no `bcc`
 *      parameter exists, no `attachments` parameter exists, no template id
 *      exists, and the `headers` it sends are the two threading headers built
 *      from a Message-ID the caller read out of the thread being replied to.
 *
 * THE IDEMPOTENCY KEY IS THE DRAFT'S OWN APPROVAL, not a random uuid. Resend
 * de-duplicates on that key for 24 hours, so a retry of a send whose response
 * was lost on the wire returns the FIRST message's id rather than sending a
 * second copy. A uuid minted per attempt would defeat the whole mechanism at
 * exactly the moment it is needed — the second attempt. The outbox's own
 * `uncertain` state still exists on top of this, because 24 hours of
 * de-duplication is not forever and a network failure after the POST is
 * ambiguous however good the key is.
 *
 * THE BODY GOES OUT AS text/plain, the markdown the owner approved, verbatim —
 * the same decision gmail-send.ts made and for the same reason. Rendering it to
 * HTML on the way out would mean the message that arrives is not the document
 * that was approved.
 */
import * as accounts from "../../accounts.ts";
import { RESEND_API, ResendError } from "../../providers/resend.ts";
import { validAddress } from "../mailflow/gmail-send.ts";

const TIMEOUT_MS = 45_000;

export type ResendSendResult = {
  /** Resend's own id for the message it just created. The proof, and the one
   *  thing stored on the row that only a real send can produce. */
  id: string;
};

/** A Message-ID header is `<...>`. A bare id gets the brackets; anything with
 *  no `@` in it is not a Message-ID at all and comes back null, because a wrong
 *  In-Reply-To threads worse than none. */
export function messageIdHeader(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const inner = raw.replace(/^<|>$/g, "");
  if (!inner.includes("@")) return null;
  if (/[\r\n]/.test(inner)) return null;
  return `<${inner}>`;
}

/**
 * THE ONLY FUNCTION IN THIS REPOSITORY THAT SENDS MAIL THROUGH RESEND.
 *
 * The key never leaves this module: it is read out of the vault here, used on
 * one request, and dropped. A route never sees a value — that is the door
 * `accounts.ts` describes, and this side of it is where it stays. Reading it
 * here rather than importing a helper from providers/resend.ts is deliberate:
 * that module's helper is private, and exporting it to reach a send would be
 * the first step of putting the send back inside the file that promises not to
 * have one.
 */
export async function resendSend(
  accountId: number,
  mail: {
    /** The whole From line, display name included. */
    from: string;
    /** The bare address inside it, for the checks. */
    fromAddress: string;
    to: string;
    replyTo?: string | null;
    subject: string;
    text: string;
    /** The RFC 5322 Message-ID of the message being replied to, if any. Resend
     *  does not thread for you: without these headers the reply arrives in the
     *  recipient's client as a new conversation. */
    inReplyTo?: string | null;
    references?: string | null;
    /** Stable across retries of the same approved document. See the header. */
    idempotencyKey: string;
  },
  reader = "nurture_resend_send",
): Promise<ResendSendResult> {
  if (!validAddress(mail.to)) throw new ResendError(400, `“${mail.to}” is not an address.`);
  if (!validAddress(mail.fromAddress))
    throw new ResendError(400, `“${mail.fromAddress}” is not an address.`);
  if (mail.replyTo && !validAddress(mail.replyTo))
    throw new ResendError(400, `“${mail.replyTo}” is not an address.`);
  if (/[\r\n]/.test(mail.from) || /[\r\n]/.test(mail.subject))
    throw new ResendError(400, "A From line or a subject with a newline in it is a header injection, and is refused rather than escaped.");
  if (!mail.text.trim()) throw new ResendError(400, "There is no message to send.");

  const { ready } = accounts.credentialed("resend", ["key"], reader);
  const pair = ready.find((p) => p.account.id === accountId);
  if (!pair)
    throw new ResendError(
      404,
      `No connected Resend key for account ${accountId}. Each key here is scoped to one sending domain, so there is no other key that could carry this.`,
    );
  const key = (pair.values.key ?? "").trim();

  const ref = messageIdHeader(mail.inReplyTo);
  const references = messageIdHeader(mail.references) ?? ref;

  let res: Response;
  try {
    res = await fetch(`${RESEND_API}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        /* Resend's own de-duplication window. The header name is theirs. */
        "Idempotency-Key": mail.idempotencyKey.slice(0, 256),
      },
      body: JSON.stringify({
        from: mail.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        ...(ref ? { headers: { "In-Reply-To": ref, References: references ?? ref } } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    throw new ResendError(
      0,
      name === "TimeoutError"
        ? "Resend did not answer within 45 seconds. Whether the message left is unknown from here."
        : `Could not reach Resend (${name}).`,
    );
  }

  const raw = await res.text();
  if (!res.ok) {
    /* Resend's error body is returned nearly verbatim: a 403 says exactly which
       domain is unverified and which key was used, and a paraphrase of that is
       a worse debugging experience for the one person who will ever read it. */
    let message = raw.slice(0, 600);
    try {
      const doc = JSON.parse(raw) as { message?: string; name?: string };
      if (doc.message) message = `${doc.name ? `${doc.name}: ` : ""}${doc.message}`.slice(0, 600);
    } catch {
      /* not the documented shape; the body stands */
    }
    throw new ResendError(res.status, message);
  }

  let id: string | null = null;
  try {
    id = (JSON.parse(raw || "{}") as { id?: string }).id ?? null;
  } catch {
    /* a 200 with an unparseable body is still a send, and is reported as one
       whose id is unknown rather than as a failure */
  }
  if (!id)
    throw new ResendError(
      200,
      "Resend accepted the send and returned no id, so whether a copy left is unknown from here. Check the domain's sent list before resending.",
    );
  return { id };
}
