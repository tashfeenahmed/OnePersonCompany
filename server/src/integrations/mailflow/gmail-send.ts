/**
 * THE SEND. This file is the only place in this repository that can put a
 * message into somebody else's inbox, and it is deliberately eight lines of
 * HTTP surrounded by three pages of fence.
 *
 * WHY IT IS HERE AND NOT IN providers/gmail.ts. That file's header makes a
 * claim it has kept since it was written: `get` hard-codes `method: "GET"`,
 * `modify` can construct exactly two bodies and neither reaches `/send`, and
 * "nothing else in the file constructs a non-GET Gmail request". Adding a send
 * to it would quietly falsify a paragraph other people have read and believed.
 * So the send lives beside the queue that is the only thing allowed to call
 * it, and the provider keeps its sentence — with one note added there pointing
 * at this file, because a narrowed claim you have to grep for is not a claim.
 *
 * WHAT MAKES "NOTHING SENDS WITHOUT AN APPROVE" TRUE, mechanically, and this
 * is the list to preserve rather than the prose:
 *
 *   1. `sendMessage` is exported from here and imported in exactly ONE place —
 *      `outbox.ts`, by `sendApproved`. `grep -rn sendMessage src/` returns this
 *      file and that call. If it ever returns three, something has grown a
 *      second door.
 *   2. `sendApproved` refuses any row whose status is not `approved`, and the
 *      only route that writes `approved` is the owner's approve route, which
 *      rejects a request carrying the skills proxy's own header.
 *   3. There is no timer in this area that reaches either. The triage pass is
 *      the only scheduled thing here and it writes scores; it has no import of
 *      this file and no path to the outbox at all.
 *
 * THE TOKEN COULD ALWAYS DO THIS. The refresh token in the vault carries
 * `gmail.modify`, which Google defines as every read and write short of
 * permanent deletion — sending included. Nothing about this file widens the
 * credential; it exercises a power the box has held since the token was
 * minted, in one function, behind a button.
 */
import { Buffer } from "node:buffer";
import { GMAIL_API, GmailError, type Session } from "../../providers/gmail.ts";

const TIMEOUT_MS = 45_000;

/** gmail.modify is Google's "everything but permanent delete", and sending is
 *  inside it. Checked against what the refresh response actually said rather
 *  than against what somebody wrote in a config file, for the reason
 *  providers/gmail.ts checks it before a label change: a grant that cannot do
 *  this must fail as "that token cannot send" and not as a 403 two frames on. */
const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const FULL_SCOPE = "https://mail.google.com/";
const SEND_ONLY_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export function canSend(session: Session): boolean {
  /* An empty scope list means Google told us nothing, which has not been seen
     and is not a licence — but refusing on it would break a working grant on
     the strength of a missing field, so it is allowed through and the API's
     own answer decides. */
  if (!session.scopes.length) return true;
  return (
    session.scopes.includes(SEND_SCOPE) ||
    session.scopes.includes(FULL_SCOPE) ||
    session.scopes.includes(SEND_ONLY_SCOPE)
  );
}

/* --------------------------------------------------------------- addresses */

/** One address, checked as an address rather than trusted as a string. This is
 *  the value that becomes an SMTP envelope, so a newline in it is a header
 *  injection and is refused here rather than escaped and hoped for. */
export function validAddress(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 320) return false;
  if (/[\r\n\0<>,;]/.test(v)) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
}

/**
 * A header VALUE, made safe to write on one line.
 *
 * Folding and injection are the same bug seen from two sides: a subject with a
 * newline in it does not become a two-line subject, it becomes whatever header
 * the sender wanted next. Newlines are collapsed to spaces and never escaped,
 * and anything outside ASCII is RFC 2047 encoded whole rather than
 * transliterated — a subject in Arabic must arrive in Arabic.
 */
function headerValue(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ").trim();
  if (!flat) return "";
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(flat)) return flat;
  return `=?UTF-8?B?${Buffer.from(flat, "utf8").toString("base64")}?=`;
}

/** base64url, which is what Gmail's `raw` field is and is NOT plain base64 —
 *  a `+` in a message's base64 becomes a space in a query-safe decoder, and
 *  the symptom is one message in forty arriving mangled. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ------------------------------------------------------- the reply context */

export type ReplyContext = {
  /** The thread's own subject, so a reply says "Re: …" rather than inventing
   *  a new one. Empty when the thread carried none. */
  subject: string;
  /** The last message's Message-ID, for In-Reply-To. Null when Gmail returned
   *  no such header, in which case the reply is threaded by threadId alone —
   *  which Gmail honours and other clients may not, and the caller is told. */
  messageId: string | null;
  /** The References chain with the last Message-ID appended. */
  references: string | null;
};

type Header = { name?: string; value?: string };

function pick(headers: Header[], name: string): string {
  const want = name.toLowerCase();
  for (const h of headers) if ((h.name ?? "").toLowerCase() === want) return h.value ?? "";
  return "";
}

/**
 * What a reply needs to land in the conversation rather than beside it.
 *
 * A GET, and a metadata one: `format=metadata` with a four-header mask, so
 * this reads the envelope of a thread it is about to reply to and no part of
 * what anybody wrote in it. That is the same shape as the triage scan and for
 * the same reason — this area never fetches a body.
 */
export async function replyContext(
  session: Session,
  threadId: string,
): Promise<ReplyContext> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId))
    throw new GmailError(400, "That is not a Gmail thread id.");

  const res = await fetch(
    `${GMAIL_API}/threads/${threadId}?format=metadata` +
      "&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References" +
      "&metadataHeaders=From&fields=messages(payload/headers)",
    {
      method: "GET",
      headers: { Authorization: `Bearer ${session.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new GmailError(res.status, (await res.text()).slice(0, 300));
  const doc = JSON.parse((await res.text()) || "{}") as {
    messages?: { payload?: { headers?: Header[] } }[];
  };
  const messages = doc.messages ?? [];
  if (!messages.length) throw new GmailError(404, "That thread has no messages.");
  const last = messages[messages.length - 1]!.payload?.headers ?? [];
  const subject =
    messages.map((m) => pick(m.payload?.headers ?? [], "Subject")).find(Boolean) ?? "";
  const messageId = pick(last, "Message-ID").trim() || null;
  const prior = pick(last, "References").trim();
  const references = messageId ? `${prior ? `${prior} ` : ""}${messageId}` : prior || null;
  return { subject, messageId, references };
}

/* ------------------------------------------------------------- the one POST */

export type SendResult = {
  /** Gmail's id for the message it just created. This is the proof, and it is
   *  the one thing the outbox stores that only a real send can produce. */
  messageId: string;
  threadId: string | null;
};

/**
 * THE ONLY FUNCTION IN THIS REPOSITORY THAT SENDS MAIL.
 *
 * `users.messages.send` with a raw RFC 5322 document this file builds. There
 * is no header parameter and no body-parts parameter: the caller passes a
 * recipient, a subject, a plain-text body and — for a reply — a thread id, and
 * every header that reaches the wire is constructed here from those four. A
 * caller cannot add a Bcc, cannot set a From that is not the mailbox's own
 * address, and cannot reach `/drafts`, `/trash` or `/batchDelete`, because
 * none of those strings exists in this file.
 *
 * THE BODY GOES OUT AS text/plain, and the plain text is the markdown the
 * owner approved, verbatim. That is a decision rather than a shortcut: the
 * queue stores markdown because the page renders it, and rendering it to HTML
 * on the way out would mean the message that arrives is not the document that
 * was approved. Markdown reads correctly as prose — that is what it is for —
 * and "what he read is what they get" is worth more here than bold text.
 */
export async function sendMessage(
  session: Session,
  mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    threadId?: string | null;
    inReplyTo?: string | null;
    references?: string | null;
  },
): Promise<SendResult> {
  if (!canSend(session))
    throw new GmailError(
      403,
      "That Gmail grant cannot send. Sending needs gmail.modify (or gmail.send); " +
        "this token carries neither, so nothing was attempted.",
    );
  if (!validAddress(mail.to)) throw new GmailError(400, `"${mail.to}" is not an address.`);
  if (!validAddress(mail.from))
    throw new GmailError(
      400,
      "This Gmail account has no address on record yet, so there is nothing to " +
        "send FROM. Collect the Gmail plugin once and try again.",
    );

  const headers: string[] = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${headerValue(mail.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  /* Both, when there is one. In-Reply-To is what a mail client threads on and
     References is what a mailing list threads on; Gmail's own threadId below
     is what GMAIL threads on, and sending all three is how the same reply
     lands in the same conversation in three different readers. */
  if (mail.inReplyTo) headers.push(`In-Reply-To: ${headerValue(mail.inReplyTo)}`);
  if (mail.references) headers.push(`References: ${headerValue(mail.references)}`);

  /* The body base64'd in 76-column lines, which is what
     Content-Transfer-Encoding: base64 promises. A single 4000-character line
     is legal to Gmail and rejected by strict receivers. */
  const encoded = Buffer.from(mail.text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const raw = `${headers.join("\r\n")}\r\n\r\n${encoded}\r\n`;

  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      raw: base64url(Buffer.from(raw, "utf8")),
      ...(mail.threadId ? { threadId: mail.threadId } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const doc = JSON.parse(text) as { error?: { message?: string } };
      if (doc.error?.message) message = doc.error.message.slice(0, 300);
    } catch {
      /* not the documented shape; the body stands */
    }
    throw new GmailError(res.status, message);
  }
  const doc = JSON.parse(text || "{}") as { id?: string; threadId?: string };
  if (!doc.id)
    throw new GmailError(
      200,
      "Gmail accepted the send and returned no message id, so whether a copy " +
        "left is unknown from here. Check the Sent folder before resending.",
    );
  return { messageId: doc.id, threadId: doc.threadId ?? null };
}
