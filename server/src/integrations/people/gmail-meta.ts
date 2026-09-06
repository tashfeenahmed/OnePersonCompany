/**
 * READING GMAIL FOR HEADERS AND NOTHING ELSE.
 *
 * THE PROMISE THIS FILE MAKES IS ABOUT THE SHAPE OF THE REQUEST, which is the
 * only kind of promise worth making about privacy. Every message read here is
 * asked for as `format=metadata` with an explicit `metadataHeaders` list and a
 * `fields` mask that selects the envelope and nothing else. Three separate
 * refusals of content, so one typo in any of them is not enough to put a
 * message body into this area: Gmail does not send a body, a snippet or a MIME
 * part back, and there is therefore nothing here to accidentally store.
 *
 * THE TWO SHAPES, and they are the whole surface:
 *
 *   GET /users/me/messages?q=…                             ids only
 *   GET /users/me/messages/{id}?format=metadata&…          headers only
 *   GET /users/me/profile                                  the address
 *
 * The transport — one GET, gated, retried on a throttle — is gmail-get.ts, and
 * the credential is providers/gmail.ts's: `gmail.open()` mints the token
 * through the same refresh exchange every other reader on this box uses, and
 * no secret is read here.
 */
import type { Session } from "../../providers/gmail.ts";
import { GmailError } from "../../providers/gmail.ts";
import {
  addressesOf,
  CONCURRENCY,
  COST,
  gmailGet,
  header,
  headerAll,
  pooled,
  splitFrom,
  type Header,
} from "./gmail-get.ts";

export { addressesOf, splitFrom };

/**
 * The seven headers asked for, and the two unobvious ones.
 *
 * `List-Unsubscribe` and `Precedence` are how a mailing list identifies
 * itself. Without them, the only way to tell a newsletter from a person is to
 * guess at the local part — "info", "hello", "team" — and a list of guesses
 * drops real people who write from the address printed on their own website,
 * which is most founders. These two are the sender's own declaration about
 * itself, which is a fact rather than a heuristic, and neither carries content.
 */
const METADATA_HEADERS: [string, string][] = [
  ["metadataHeaders", "From"],
  ["metadataHeaders", "To"],
  ["metadataHeaders", "Cc"],
  ["metadataHeaders", "Date"],
  ["metadataHeaders", "Subject"],
  ["metadataHeaders", "List-Unsubscribe"],
  ["metadataHeaders", "Precedence"],
];

/** One message, as headers. No body, no snippet — see the file header. */
export type MetaMessage = {
  id: string;
  threadId: string;
  /** Unix milliseconds. Null when Gmail sent no internalDate, which is not the
   *  same as "a long time ago" and is never treated as the epoch. */
  at: number | null;
  labels: string[];
  from: string;
  fromName: string;
  /** Every address in every To and Cc line, lower-cased. */
  recipients: string[];
  /** Looked at IN MEMORY to see whether a venture's host is mentioned, and
   *  never written down. See contacts.ts. */
  subject: string;
  /** The sender declared itself a mailing list — a List-Unsubscribe header, or
   *  a Precedence of bulk/list/junk. */
  bulk: boolean;
};

/** Gmail's `after:` takes a date, not a timestamp: 2026/09/05. */
export const gmailDate = (d: Date) =>
  `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;

/**
 * Message ids for one query, newest first, up to `max`.
 *
 * NEWEST FIRST IS LOAD-BEARING WHEN THE CAP BITES: what a truncated scan holds
 * is the most RECENT part of the window, so "last written to" stays true and
 * only "first seen" and the counts become floors. A truncation that dropped
 * the recent end instead would make every figure on the page wrong in a way
 * nothing could detect.
 */
export async function messageIds(
  session: Session,
  q: string,
  max: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const params: [string, string][] = [
      ["q", q],
      ["maxResults", String(Math.max(1, Math.min(500, max - ids.length)))],
      ["fields", "messages/id,nextPageToken"],
    ];
    if (pageToken) params.push(["pageToken", pageToken]);
    const doc = await gmailGet<{ messages?: { id?: string }[]; nextPageToken?: string }>(
      "messages",
      session.token,
      params,
      COST.messageList,
    );
    for (const m of doc.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = doc.nextPageToken;
    if (!pageToken || ids.length >= max) break;
  }
  return { ids: ids.slice(0, max), truncated: Boolean(pageToken) && ids.length >= max };
}

/**
 * Hydrate ids into headers.
 *
 * ONE MESSAGE FAILING DOES NOT FAIL THE SCAN — a message deleted between the
 * listing and the hydration answers 404, and a scan that threw would report an
 * empty year because one mail moved to the bin. The count of drops comes back
 * so the document can say so, and every count in a run with drops is a floor.
 */
export async function metaMessages(
  session: Session,
  ids: string[],
): Promise<{ messages: MetaMessage[]; dropped: number }> {
  let dropped = 0;
  const got = await pooled(ids, CONCURRENCY, async (id) => {
    try {
      const doc = await gmailGet<{
        id?: string;
        threadId?: string;
        internalDate?: string;
        labelIds?: string[];
        payload?: { headers?: Header[] };
      }>(
        `messages/${encodeURIComponent(id)}`,
        session.token,
        [
          ["format", "metadata"],
          ...METADATA_HEADERS,
          ["fields", "id,threadId,internalDate,labelIds,payload/headers"],
        ],
        COST.messageGet,
      );
      const headers = doc.payload?.headers ?? [];
      const from = splitFrom(header(headers, "From"));
      const ms = Number(doc.internalDate);
      return {
        id: doc.id ?? id,
        threadId: doc.threadId ?? "",
        at: Number.isFinite(ms) && ms > 0 ? ms : null,
        labels: doc.labelIds ?? [],
        from: from.address,
        fromName: from.name,
        recipients: addressesOf(...headerAll(headers, "To"), ...headerAll(headers, "Cc")),
        subject: header(headers, "Subject"),
        bulk:
          Boolean(header(headers, "List-Unsubscribe")) ||
          ["bulk", "list", "junk"].includes(header(headers, "Precedence").trim().toLowerCase()),
      } satisfies MetaMessage;
    } catch {
      dropped += 1;
      return null;
    }
  });
  return { messages: got.filter((m): m is MetaMessage => m !== null), dropped };
}

/** The mailbox's own address, so a scan knows which side of a message it is
 *  on. One request, one quota unit. */
export async function profileAddress(session: Session): Promise<string> {
  const doc = await gmailGet<{ emailAddress?: string }>(
    "profile",
    session.token,
    [["fields", "emailAddress"]],
    COST.profile,
  );
  const address = (doc.emailAddress ?? "").trim().toLowerCase();
  if (!address) throw new GmailError(200, "Google returned no address for that mailbox.");
  return address;
}
