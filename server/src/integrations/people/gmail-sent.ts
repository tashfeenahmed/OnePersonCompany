/**
 * THE OWNER'S OWN SENT MAIL, READ AND THEN DROPPED.
 *
 * THIS IS THE ONE FILE IN THIS AREA THAT FETCHES A MESSAGE BODY, and the
 * promise it makes is not "no bodies" — it is that a body exists inside one
 * function call and nowhere else. `readSent` returns text to its caller; the
 * caller (commitments.ts) scans it, keeps at most one 200-character sentence
 * the owner actually wrote, and lets the rest go out of scope. Nothing here
 * writes to the database, to a log or to the run ledger, and there is no cache.
 *
 * ONLY `in:sent`, WHICH IS THE OTHER HALF OF THE PROMISE. The query is built
 * here with the SENT label pinned, so nothing a caller can pass reaches the
 * inbox: what can be read is what the owner himself wrote. A promise somebody
 * made TO him, and every word of every message he received, is out of reach by
 * construction rather than by intention.
 *
 * OLDEST FIRST, and it is load-bearing. Gmail lists newest first; a scan that
 * took the first 200 of a 900-message backlog and then moved on would skip the
 * other 700 forever. Reversing the id list means a truncated scan is a
 * PREFIX of the window, and the next one continues rather than re-reading.
 *
 * `fields` OMITS `snippet` DELIBERATELY. The mask is `id,threadId,
 * internalDate,payload`, so Google's own one-line preview — which is a body by
 * another name — never arrives.
 */
import type { Session } from "../../providers/gmail.ts";
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

/** Bodies are far heavier than headers, so the pool is narrower: four at a
 *  time rather than six. The gate prices both the same — a `messages.get` is
 *  five units whatever the format — but a hundred full messages in flight is
 *  megabytes of a laptop's memory to find at most a sentence in each. */
const BODY_CONCURRENCY = Math.max(2, CONCURRENCY - 2);

/** Past this the text is a document rather than a note, and the promise —
 *  if there is one — is in the first few thousand characters of it. */
export const MAX_BODY_CHARS = 8_000;

export type SentMessage = {
  id: string;
  threadId: string;
  /** Unix milliseconds, or null when Gmail sent no internalDate. */
  at: number | null;
  subject: string;
  /** The first recipient. Empty when the message had no readable To, Cc or
   *  Bcc — which happens on mail sent only to a blind list. */
  to: string;
  toName: string;
  /** How many other people were on it. A promise on a thirty-person thread is
   *  a different thing from one in a two-person exchange. */
  others: number;
  /** The plain-text part, decoded, cut at MAX_BODY_CHARS. Transient — see the
   *  file header. */
  text: string;
};

type Part = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: Part[];
};

/** Gmail encodes every body as base64url. A part that will not decode comes
 *  back as "" rather than throwing: one malformed part must not cost the
 *  message it is in. */
function decode(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * The plain-text parts, joined.
 *
 * TEXT ONLY, AND HTML IS NOT A FALLBACK. A sender's HTML is markup this file
 * would have to strip, and a stripper that gets it wrong turns a stylesheet
 * into a sentence the owner is then told he promised. Gmail's own composer
 * always ships a text/plain alternative, so his own mail has one; a message
 * that genuinely has none contributes nothing, which is the safe direction.
 */
function plainText(part: Part | undefined, acc: string[]) {
  if (!part) return;
  if (part.mimeType === "text/plain" && !part.filename) acc.push(decode(part.body?.data));
  for (const child of part.parts ?? []) plainText(child, acc);
}

/**
 * Ids of the owner's own sent messages in a window, OLDEST FIRST.
 *
 * `labelIds=SENT` rather than a `in:sent` term in the query, so the label is
 * a parameter of the request rather than a string a caller could displace.
 */
export async function sentIds(
  session: Session,
  days: number,
  max: number,
): Promise<{ ids: string[]; listed: number; truncated: boolean }> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const params: [string, string][] = [
      ["q", `newer_than:${days}d -in:chats -is:draft`],
      ["labelIds", "SENT"],
      ["maxResults", "500"],
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
    /* Two thousand ids is a cheap listing (five units a page) and a hard stop:
       past that the window is wrong, not the cap. */
    if (!pageToken || ids.length >= 2000) break;
  }
  const oldestFirst = [...ids].reverse();
  return {
    ids: oldestFirst.slice(0, max),
    listed: ids.length,
    truncated: oldestFirst.length > max,
  };
}

/**
 * Read those messages.
 *
 * ONE MESSAGE FAILING DOES NOT FAIL THE SCAN, for the reason the metadata scan
 * gives: a message deleted between the listing and the read answers 404.
 */
export async function readSent(
  session: Session,
  ids: string[],
): Promise<{ messages: SentMessage[]; dropped: number }> {
  let dropped = 0;
  const got = await pooled(ids, BODY_CONCURRENCY, async (id) => {
    try {
      const doc = await gmailGet<{
        id?: string;
        threadId?: string;
        internalDate?: string;
        payload?: Part & { headers?: Header[] };
      }>(
        `messages/${encodeURIComponent(id)}`,
        session.token,
        [
          ["format", "full"],
          ["fields", "id,threadId,internalDate,payload"],
        ],
        COST.messageGet,
      );
      const headers = doc.payload?.headers ?? [];
      /* Five headers in order of how much each proves about who this was for.
         Bcc is included because a message sent only to a Bcc list still has a
         recipient, and "no recipient" is a reason to drop a promise. */
      const recipients = addressesOf(
        ...headerAll(headers, "To"),
        ...headerAll(headers, "Delivered-To"),
        ...headerAll(headers, "Cc"),
        ...headerAll(headers, "Bcc"),
        ...headerAll(headers, "X-Original-To"),
      );
      const to = recipients[0] ?? "";
      /* The display name only when it belongs to the address taken: a
         multi-recipient To would otherwise put the first person's name beside
         the second person's address. */
      const first = splitFrom(header(headers, "To").split(",")[0] ?? "");
      const acc: string[] = [];
      plainText(doc.payload, acc);
      const ms = Number(doc.internalDate);
      return {
        id: doc.id ?? id,
        threadId: doc.threadId ?? "",
        at: Number.isFinite(ms) && ms > 0 ? ms : null,
        subject: header(headers, "Subject"),
        to,
        toName: first.address === to ? first.name : "",
        others: Math.max(0, new Set(recipients).size - 1),
        text: acc.join("\n").slice(0, MAX_BODY_CHARS),
      } satisfies SentMessage;
    } catch {
      dropped += 1;
      return null;
    }
  });
  return { messages: got.filter((m): m is SentMessage => m !== null), dropped };
}
