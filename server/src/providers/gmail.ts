/**
 * Gmail — what is waiting, how long it has waited, who you write to, and
 * (since the Email app) the threads themselves.
 *
 * THE TOKEN CAN WRITE, AND THIS FILE NOW EXERCISES THAT IN EXACTLY ONE PLACE.
 * THAT IS THE FIRST THING TO KNOW ABOUT IT, AND IT CHANGED.
 *
 * The refresh token in the vault was minted by workdash's `gmail_auth.py` with
 * `gmail.modify` and `calendar.readonly`. `gmail.modify` is a WRITE scope: it
 * can archive a thread, move a label, trash a message and mark a conversation
 * read. Google offers no way to narrow a token after the fact, and re-minting a
 * `gmail.readonly` one needs a human at a consent screen — so the credential
 * this dashboard holds is, and will stay, more powerful than the dashboard.
 *
 * This file used to answer that with "there is one function here and it hard-
 * codes GET", which made "this cannot archive your mail" a property of the
 * code rather than a promise. The mailbox app broke exactly one hole in that
 * and the hole is named, because an opened thread that stays bold is a mail
 * client nobody believes:
 *
 *   * there are now TWO functions in this file that talk to Gmail. `get` is
 *     unchanged: `method: "GET"` hard-coded, no body parameter, and every
 *     reader still goes through it.
 *   * `modify` is the second, and it is not a general POST. It takes a thread
 *     id and a boolean, it builds its own body from a frozen pair of constants
 *     — `{removeLabelIds:["UNREAD"]}` or `{addLabelIds:["UNREAD"]}` — and it
 *     appends `/modify` to a path it constructs itself. There is no argument
 *     you can pass it that reaches `/trash`, `/send`, `/batchModify` or any
 *     label but UNREAD, because none of those strings exists in it.
 *   * nothing else in the file constructs a non-GET Gmail request. The OAuth
 *     refresh is still a POST to `oauth2.googleapis.com`, which is not Gmail.
 *
 * ONE MORE HOLE HAS SINCE BEEN OPENED AND IT IS NOT IN THIS FILE. The mailflow
 * area's outbox can SEND, through `integrations/mailflow/gmail-send.ts`, which
 * builds its own RFC 5322 document and POSTs it to `messages/send` with a
 * session this file minted. It is written there rather than here precisely so
 * that the two claims above stay literally true of this file — `get` is still
 * the only Gmail reader, `modify` still reaches nothing but the UNREAD label —
 * and so that the send sits beside the queue that is the only thing allowed to
 * call it. Read that file's header for what fences it: one caller, one status,
 * and a button pressed by a person.
 *
 * So the sentence is now: this file can mark a conversation read or unread and
 * can do nothing else to your mail; the dashboard as a whole can also send one
 * message that its owner has approved. That is a smaller claim than the old
 * one and it is still a property of the code. Refusing the write
 * outright was the alternative and was declined for the reason the credential
 * was accepted in the first place: it would cost the feature to buy back a
 * risk this file's shape has already bounded.
 *
 * PRIVACY IS THE SECOND THING, AND THE COLLECTOR HALF AND THE LIVE HALF ANSWER
 * IT DIFFERENTLY — see "the live half" at the foot of this file. Everything
 * above the banner is the collector, and for it the rule is unchanged and is
 * stricter than "do not print anything private": private data never crosses
 * the wire in the first place.
 *
 *   * every request carries an explicit `fields` mask, so Gmail is asked for
 *     label ids, counters and timestamps and is never given the chance to
 *     return a subject or a snippet. `snippet` is 200 characters of message
 *     body that rides along on responses nobody asked to trim, and the mask is
 *     what stops it — verified against a live response: with the mask on, the
 *     key is absent from the JSON entirely.
 *   * `format=minimal` on the thread reads, which excludes headers and payload
 *     on top of that.
 *   * the ONE call that reads headers at all is the outreach scan, which asks
 *     for `To` and `Cc` on your own SENT mail and turns each address into an
 *     HMAC before it leaves this file. No route below can render a person's
 *     address or name, because no row anywhere holds one.
 *
 * That is the same contract workdash's `collect_inbox.py` holds ("this file
 * lands in dist/, so it carries counts and only counts"), tightened by one
 * step: `collect_contacts.py` deliberately publishes real names and addresses
 * because a contacts *page* without them is not a contacts page. This
 * dashboard has no contacts page — it has a number on a card — so it takes the
 * cheaper trade and keeps the identities out entirely.
 *
 * WHAT IT TOUCHES, and nothing else:
 *   POST https://oauth2.googleapis.com/token   (grant_type=refresh_token)
 *   GET  /users/me/profile
 *   GET  /users/me/labels            and  /users/me/labels/{id}
 *   GET  /users/me/threads           and  /users/me/threads/{id}
 *                                    (?format=minimal, =metadata, =full)
 *   GET  /users/me/messages          and  /users/me/messages/{id}?format=metadata
 *   POST /users/me/threads/{id}/modify        the one write — UNREAD only
 */
import { createHmac } from "node:crypto";
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 45_000;

/**
 * The two scopes that can produce every figure below, and the one that is
 * actually in the vault.
 *
 * `gmail.readonly` is what this code deserves; `gmail.modify` is what the
 * credential carries, because workdash's mail page sends replies with the same
 * token. Either is accepted and both behave identically here — the same
 * decision `collect_inbox.py` documents, for the same reason. Anything else is
 * a credential minted for something that is not this, and is worth saying
 * before Google says it as a 403.
 */
export const USABLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

/** How far back the triage scan and the daily line look. */
export const WINDOW_DAYS = 30;

/**
 * How far back the outreach scan reads SENT mail.
 *
 * Ninety rather than thirty, because "is this contact new" is a question the
 * thirty-day window cannot answer about itself: somebody written to for the
 * first time this month is only new if the two months before it are on hand.
 * On this mailbox ninety days of sent mail is 141 messages, so the wider
 * lookback costs a hundred requests and buys the only definition of "new" that
 * is not a restatement of the window.
 */
export const OUTREACH_DAYS = 90;

/**
 * Caps, and what they cost.
 *
 * The thread LIST is cheap — a page of a hundred ids for one request. The
 * per-thread read is not, and it is the only way to find out whether the last
 * message in a conversation came from us. This mailbox carries ~317 inbox
 * threads a week, so a thirty-day scan of everything would be well over a
 * thousand reads on every collection.
 *
 * MAX_THREAD_FETCH is a WHOLE-RUN budget rather than a per-label one, spent
 * INBOX first, so adding a label divides the work rather than multiplying it —
 * the rule `collect_inbox.py` arrived at over the same mailbox. A label that
 * ran out of budget says so and its count is reported as a FLOOR, never as a
 * measurement.
 */
export const MAX_THREAD_LIST = 400;
export const MAX_THREAD_FETCH = 250;
export const MAX_OUTREACH_MESSAGES = 400;

/** Six at a time. A thread read is ~300ms; sequentially, a full budget would be
 *  a minute and a quarter of a collection, and connecting a mailbox happens
 *  inside an HTTP request. The gate below is what keeps six concurrent readers
 *  from crossing Gmail's per-second ceiling. */
const CONCURRENCY = 6;

/**
 * GMAIL'S CEILING IS PER SECOND, NOT PER RUN, AND IT IS PRICED IN "QUOTA UNITS".
 *
 * This was found the hard way on the first live collection: the run spent about
 * 3,600 units against a daily allowance of a billion and still came back with
 * `Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per
 * minute per user'`. The limit that bites is the moving per-user rate — six
 * concurrent `threads.get` at ten units each is ~200 units a second on its own,
 * and the day counts running beside them pushed it over. The failure is not a
 * broken credential and looks exactly like one: the outreach scan came back
 * refused and thirty days of the volume line came back empty.
 *
 * So every call declares what it COSTS and passes through a gate that spaces
 * request starts to stay under the ceiling. It is a spacer rather than a
 * semaphore: responses still overlap, so the wall clock is set by the budget
 * rather than by the slowest request. A full run — 250 thread reads, sixty day
 * counts, a hundred and forty sent-mail reads — comes to about twenty seconds,
 * which is the right trade for a two-hourly collector that must not come back
 * with holes in it.
 *
 * The prices are Google's published ones. They are worth having exactly right:
 * a `threads.get` is ten times a `labels.get`, and treating them alike is how a
 * budget that looks generous is spent in a burst.
 *
 * THE RATE WAS MEASURED RATHER THAN READ OFF A DOC PAGE. Sixty `threads.get`
 * against this project, paced three ways on 2026-09-05:
 *
 *     180 units/s   60 of 60 answered
 *      90 units/s   60 of 60 answered
 *     250 units/s   45 answered, 15 refused 403 "Quota exceeded for quota
 *                   metric 'Total Query Cost' and limit 'Units per minute per
 *                   user'"
 *
 * — which puts the real ceiling at Google's documented 15,000 units a minute
 * per user. 140 is that with room, because the limit is a MOVING average and
 * pacing exactly at a moving ceiling is how a run that passed all week fails on
 * the day a request is slow.
 */
const UNITS_PER_SECOND = 140;
const COST = {
  profile: 1,
  label: 1,
  threadList: 10,
  threadGet: 10,
  /** The one write. Google prices `threads.modify` at ten, the same as a read
   *  of the same thread, and it goes through the same gate as everything else
   *  — a write that skipped the spacer would be the one request able to push a
   *  run over the ceiling, and it is the one the owner is watching. */
  threadModify: 10,
  messageList: 5,
  messageGet: 5,
} as const;

let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hold this request until the account's spending rate has room for it. */
async function gate(units: number) {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + (units * 1000) / UNITS_PER_SECOND;
  if (start > now) await sleep(start - now);
}

/** Google's own words for "you are going too fast", which arrive as a 429 and
 *  also as a 403 — the second is the one that reads like a permission problem
 *  and is not. */
const RATE_LIMITED = /rate ?limit|Quota exceeded|userRateLimitExceeded/i;

/**
 * The three Gmail categories a waiting reply is never in.
 *
 * Promotions, Social and Forums are the three Gmail itself files as "read this
 * when you feel like it", and counting them as somebody waiting on an answer is
 * how "263 waiting" stops meaning anything — on this mailbox, 24,901 of the
 * 83,299 messages in the inbox are promotions.
 *
 * CATEGORY_UPDATES IS DELIBERATELY ABSENT from the set. Receipts, delivery
 * notices, "your build failed" and password resets live there, and several of
 * them are the most time-sensitive mail in the box. `collect_inbox.py` makes
 * exactly this call and it is not this file's place to overturn it.
 *
 * They are excluded IN THE QUERY rather than after the fetch, which is the one
 * place this improves on the collector it is modelled on: workdash fetches a
 * promotion, discovers it is a promotion, and has already spent the request.
 * Gmail applies `-category:` server-side, so the budget is spent only on mail
 * that could be waiting on a reply.
 */
export const BULK_CATEGORIES = ["promotions", "social", "forums"] as const;

/** The sentence that travels with every `needingReply` figure. A count is only
 *  interpretable beside its definition, and this one is an approximation. */
export const NEEDS_REPLY_DEFINITION =
  "a thread whose LAST message carries neither SENT nor DRAFT — they wrote " +
  "last and you have neither replied nor started to. Computed from label ids " +
  "alone, so no address or subject is read to produce it. Threads whose last " +
  "message sits in Gmail's Promotions, Social or Forums category are excluded " +
  "in the query and never counted; CATEGORY_UPDATES is not excluded, because " +
  "receipts and alerts are real work. It over-reports rather than under: a " +
  "thread answered by phone, or from another mailbox, still reads as waiting.";

/* ------------------------------------------------------------------ shapes */

export type GmailLabel = {
  id: string;
  name: string;
  /** "system" or "user", as Gmail types it. INBOX and a hand-made label are
   *  different kinds of thing and a page that mixes them says which is which. */
  kind: string;
  /** Gmail's OWN counters, from labels.get. These are exact and they cost one
   *  request each — there is no listing and no estimate involved. Null is
   *  "the counter was not returned", never nought. */
  messagesTotal: number | null;
  messagesUnread: number | null;
  threadsTotal: number | null;
  threadsUnread: number | null;
  /** The triage half, filled only for labels the scan actually reached. Null
   *  throughout means nobody looked, which is not "nothing is waiting". */
  scanned: number | null;
  needingReply: number | null;
  oldestWaitingDays: number | null;
  /** True when the list or the budget ran out, so `needingReply` is a floor. */
  truncated: boolean;
  note: string | null;
};

export type GmailDay = {
  /** Calendar day in the mailbox's own reckoning, "2026-09-04". */
  day: string;
  received: number;
  sent: number;
  /** True when Gmail had more ids than one page would carry, so the figure is
   *  a floor. At 500 per page this mailbox has never come close. */
  receivedCapped: boolean;
  sentCapped: boolean;
};

/** One person written to, as a fingerprint and three dates. There is no field
 *  on this type that could hold an address, a name or a subject. */
export type Correspondent = {
  fingerprint: string;
  firstAt: string;
  lastAt: string;
  messages: number;
};

export type MailboxResult = {
  accountId: number;
  accountLabel: string;
  ok: boolean;
  error?: string;
  /** From `users.getProfile`, which is also the connect-time check: a token
   *  that refreshes but reaches no mailbox is the wrong Google login. */
  address: string | null;
  messagesTotal: number | null;
  threadsTotal: number | null;
  historyId: string | null;
  /** What Google says the token carries, read off the refresh response rather
   *  than off the file it came from. The file's `scopes` field is what somebody
   *  wrote down; this is what the grant actually is. */
  scopes: string[];
  labels: GmailLabel[];
  days: GmailDay[];
  correspondents: Correspondent[];
  /** The window the outreach scan actually covered, and whether its cap bit. */
  outreach: { days: number; messages: number; truncated: boolean };
  notes: string[];
};

export type CollectResult = {
  mailboxes: MailboxResult[];
  accountsTried: number;
  warnings: string[];
};

/* -------------------------------------------------------------------- http */

export class GmailError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.name = "GmailError";
    this.status = status;
    this.body = body;
  }
}

/**
 * A fresh access token.
 *
 * The one POST in this file, and it is not a Gmail request: it exchanges a
 * long-lived refresh token for an hour-long access token at Google's OAuth
 * endpoint. It mutates nothing in the mailbox and there is no Gmail resource it
 * could have touched — the same exception `providers/adsense.ts` carries, for
 * the same reason.
 *
 * The response's `scope` is returned alongside the token because it is the only
 * authoritative statement of what the grant can do. A `scopes` list copied out
 * of a JSON file is what somebody believed when they wrote it down.
 */
async function accessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ token: string; scopes: string[] }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text.slice(0, 240);
    try {
      const doc = JSON.parse(text) as { error?: string; error_description?: string };
      reason = doc.error_description ?? doc.error ?? reason;
      if (doc.error === "invalid_grant")
        reason =
          "Google has stopped accepting that refresh token. A Cloud app still " +
          "in Testing issues refresh tokens that expire after seven days — " +
          "publish the app, then mint a new token with gmail_auth.py.";
    } catch {
      /* not JSON; the body is all there is */
    }
    throw new GmailError(res.status, reason);
  }
  const doc = JSON.parse(text) as { access_token?: string; scope?: string };
  if (!doc.access_token)
    throw new GmailError(200, "Google returned no access_token for that refresh grant.");
  return {
    token: doc.access_token,
    scopes: (doc.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

/**
 * THE ONLY FUNCTION IN THIS FILE THAT TALKS TO GMAIL.
 *
 * `method: "GET"` is written here and nowhere else, there is no body parameter,
 * and every reader below goes through it. That is what makes "this cannot
 * archive, label, trash or send" a fact about the code rather than a claim
 * about the credential — which matters more here than anywhere else on this
 * box, because the credential genuinely can do all four.
 */
async function get<T>(
  path: string,
  token: string,
  params: [string, string][] = [],
  units: number = COST.messageGet,
): Promise<T> {
  const qs = new URLSearchParams(params);
  const url = `${GMAIL_API}/${path}${qs.toString() ? `?${qs}` : ""}`;

  /*
    THREE TRIES, AND ONLY FOR THE RATE LIMIT. A 401 is a dead grant and a 404 is
    a thread somebody deleted mid-run; retrying either is spending requests to
    be told the same thing again. Being told to slow down is the one failure
    here that a wait actually fixes, and the backoff is generous because the
    ceiling is a moving average — coming back too soon re-triggers it.
  */
  for (let attempt = 0; ; attempt++) {
    await gate(units);
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      /*
        AN EMPTY BODY UNDER A 200 IS A REAL ANSWER AND NOT A BROKEN ONE.

        With a `fields` mask, Gmail omits the response entirely when nothing it
        selects is present — a day on which no mail was sent answers 200 with
        ZERO BYTES rather than with `{}`. Handed straight to `res.json()` that
        is "SyntaxError: Unexpected end of JSON input", which is how eleven days
        of the volume line first arrived as unreadable: they were days with no
        sent mail, which is the most ordinary thing a mailbox can do.

        So an empty body reads as an empty document, and every caller's
        `?? []` then does the right thing. The alternative — dropping the
        `fields` mask — would trade this for Gmail being free to return snippets
        of message bodies, which is not a trade this file will make.
      */
      const text = await res.text();
      return (text.trim() ? JSON.parse(text) : {}) as T;
    }

    const body = await res.text();
    let message = body.slice(0, 300);
    try {
      const doc = JSON.parse(body) as { error?: { message?: string } };
      if (doc.error?.message) message = doc.error.message.slice(0, 300);
    } catch {
      /* not the documented shape; the body stands */
    }
    const throttled =
      (res.status === 429 || res.status === 403) && RATE_LIMITED.test(message);
    if (!throttled || attempt >= 2) throw new GmailError(res.status, message);
    await sleep(2000 * (attempt + 1) ** 2);
  }
}

/** A tiny worker pool, the one in `providers/gsc.ts` written out again rather
 *  than shared: a second copy of eight lines beats a util module that two
 *  providers then have to agree about. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ verify */

/**
 * Is this grant real, and does it reach a mailbox?
 *
 * Both halves, because neither proves anything alone: a valid client with a
 * revoked token and a live token under the wrong client fail identically from
 * the outside, and only the exchange can tell them apart. Then `getProfile`,
 * because a grant that refreshes and reaches no mailbox is the wrong Google
 * login — which would otherwise connect happily and report an empty inbox
 * forever.
 *
 * The address comes back so the route that stores the credential can NAME the
 * account after the mailbox it actually reaches, rather than "Account 1".
 */
export async function verify(values: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<
  | { ok: true; address: string | null; scopes: string[]; messages: number | null }
  | { ok: false; error: string }
> {
  try {
    const { token, scopes } = await accessToken(
      values.clientId,
      values.clientSecret,
      values.refreshToken,
    );
    /*
      A SCOPE CHECK BEFORE THE CALL, so a token minted for Drive is refused as
      that rather than as a Gmail 403 three frames later. Present-and-wrong is
      refused; ABSENT is accepted, because Google omits `scope` from some
      refresh responses and breaking a working credential to enforce a field it
      may not send is the wrong trade — the same tolerance collect_inbox.py
      keeps for tokens minted before it recorded scopes.
    */
    if (scopes.length && !scopes.some((s) => USABLE_SCOPES.includes(s)))
      return {
        ok: false,
        error:
          `That token carries ${scopes
            .map((s) => s.split("/").pop())
            .slice(0, 4)
            .join(", ")} and neither gmail.readonly nor gmail.modify. It was ` +
          "minted for something that is not this — rerun gmail_auth.py.",
      };

    const profile = await get<{
      emailAddress?: string;
      messagesTotal?: number;
    }>("profile", token, [["fields", "emailAddress,messagesTotal"]], COST.profile);
    if (!profile.emailAddress)
      return {
        ok: false,
        error:
          "That grant works, but Gmail returned no mailbox for it. Mint the " +
          "token while signed in as the account whose mail you want to read.",
      };
    return {
      ok: true,
      address: profile.emailAddress,
      scopes,
      messages: profile.messagesTotal ?? null,
    };
  } catch (err) {
    if (err instanceof GmailError)
      return {
        ok: false,
        error:
          err.status === 403 && /Gmail API has not been used/.test(err.body)
            ? `${err.body} (the grant is fine; the API is switched off on that Cloud project)`
            : `HTTP ${err.status} ${err.body}`,
      };
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "Google did not answer within 45 seconds."
          : `Could not reach Google (${name}).`,
    };
  }
}

/* ----------------------------------------------------------------- readers */

type LabelStub = { id?: string; name?: string; type?: string };

/**
 * The labels worth counting, Gmail's own noise removed.
 *
 * INBOX is wanted. SENT, DRAFT, TRASH and SPAM are not waiting on anyone; CHAT
 * is not mail; the CATEGORY_* views are slices of INBOX that would count the
 * same thread two and three times; and the colour labels (RED_STAR,
 * ORANGE_STAR …) are stars rather than folders. UNREAD and STARRED are kept
 * because they are the two system labels that name a STATE of the mail rather
 * than a place it lives, and both are figures a triage page wants.
 */
const SYSTEM_KEEP = new Set(["INBOX", "UNREAD", "STARRED", "SENT", "DRAFT"]);
/** The system labels the triage scan is actually run over. SENT and DRAFT
 *  carry counters worth showing and no threads that could be "waiting on a
 *  reply" — by construction, we wrote the last message in every one. */
const SCAN_LABELS = new Set(["INBOX"]);

function keepLabel(l: LabelStub): boolean {
  if (!l.id || !l.name) return false;
  if (l.type === "system") return SYSTEM_KEEP.has(l.id);
  return !l.id.startsWith("CATEGORY_");
}

/** Gmail's `internalDate` is epoch MILLISECONDS. Divided once, here, so no
 *  caller has to remember which unit it is in. */
const whenOf = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n / 1000) : null;
};

/**
 * One thread's verdict, from label ids alone.
 *
 * `format=minimal` excludes headers and payload; the `fields` mask cuts the
 * response to two keys per message. Nothing this function can see says who
 * wrote or what they said — which is both the privacy contract and the reason
 * the answer is cheap.
 */
async function threadState(
  token: string,
  id: string,
): Promise<{ waiting: boolean; at: number | null } | null> {
  const doc = await get<{ messages?: { labelIds?: string[]; internalDate?: string }[] }>(
    `threads/${id}`,
    token,
    [
      ["format", "minimal"],
      ["fields", "messages(labelIds,internalDate)"],
    ],
    COST.threadGet,
  );
  const messages = doc.messages ?? [];
  if (!messages.length) return null;
  // Gmail returns a thread oldest-first, so the last entry is the most recent
  // thing that happened in the conversation.
  const last = messages[messages.length - 1]!;
  const labels = new Set(last.labelIds ?? []);
  return {
    waiting: !labels.has("SENT") && !labels.has("DRAFT"),
    at: whenOf(last.internalDate),
  };
}

/** Thread ids for one label over one window, newest first, ids only. */
async function threadIds(
  token: string,
  labelId: string,
  query: string,
  cap: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids: string[] = [];
  let page: string | undefined;
  for (;;) {
    const doc = await get<{ threads?: { id?: string }[]; nextPageToken?: string }>(
      "threads",
      token,
      [
        ["labelIds", labelId],
        ["q", query],
        ["maxResults", "100"],
        ["fields", "threads/id,nextPageToken"],
        ...(page ? ([["pageToken", page]] as [string, string][]) : []),
      ],
      COST.threadList,
    );
    for (const t of doc.threads ?? []) if (t.id) ids.push(t.id);
    page = doc.nextPageToken;
    if (!page || ids.length >= cap) break;
  }
  return { ids: ids.slice(0, cap), truncated: ids.length > cap || !!page };
}

/**
 * How many messages landed on one calendar day, counted EXACTLY.
 *
 * `resultSizeEstimate` is right there in the same response and is not used,
 * because it is an estimate and this dashboard does not print estimates as
 * measurements — asked for the unread inbox it answered 201 against a true 263
 * on this very mailbox. Counting the ids the mask returns costs the same one
 * request and is exact up to the page size, and a day that needed a second page
 * is reported as a floor rather than silently truncated.
 */
async function dayCount(
  token: string,
  query: string,
): Promise<{ n: number; capped: boolean }> {
  const doc = await get<{ messages?: { id?: string }[]; nextPageToken?: string }>(
    "messages",
    token,
    [
      ["q", query],
      ["maxResults", "500"],
      ["fields", "messages/id,nextPageToken"],
    ],
    COST.messageList,
  );
  return { n: (doc.messages ?? []).length, capped: !!doc.nextPageToken };
}

/** "2026/09/04" — Gmail's search date format, which is the mailbox's own
 *  timezone rather than UTC. Both ends of a day query use it, so the bucket is
 *  whatever Gmail itself calls that day. */
const searchDay = (d: Date) =>
  `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/* ---------------------------------------------------------- the outreach scan */

/** Everything between the angle brackets, lowercased. `"Jane Smith"
 *  <jane@x.io>` and `jane@x.io` are one person and must fingerprint alike. */
function addressesIn(header: string): string[] {
  const out: string[] = [];
  for (const part of header.split(",")) {
    const m = /<([^>]+)>/.exec(part);
    const raw = (m ? m[1]! : part).trim().toLowerCase();
    if (raw.includes("@")) out.push(raw);
  }
  return out;
}

/**
 * A person, as sixteen bytes of HMAC.
 *
 * The salt is a random blob generated by the migration and held in the
 * database, so a fingerprint is meaningless outside this install — a plain
 * SHA-256 of an email address is reversible with a word list, which is not a
 * hash of anything private at all.
 *
 * The fingerprint exists ONLY so two runs can tell that they saw the same
 * person, and so two mailboxes can be counted without double-counting somebody
 * written to from both. Nothing downstream renders it; nothing downstream
 * could, because the address never entered the database.
 */
export function fingerprint(salt: Buffer, address: string): string {
  return createHmac("sha256", salt).update(address).digest("hex").slice(0, 32);
}

/* ----------------------------------------------------------------- collect */

export function tokenAccounts(
  reader: string,
): { account: Account; values: Record<string, string> }[] {
  return accounts.credentialed(
    "gmail",
    ["client-id", "client-secret", "refresh-token"],
    reader,
  ).ready;
}

/**
 * One mailbox, read.
 *
 * FAILURE IS PER MAILBOX AND PER PART. The profile call is the only hard
 * dependency: without it there is no mailbox and the account is failed. A label
 * whose counters refuse keeps its row with nulls, a triage scan that runs out
 * of budget reports a floor and says so, and an outreach scan that Gmail
 * declines costs nothing else — the trade GitHub makes for a repo without push
 * access, and Cloudflare for a zone whose records will not read.
 *
 * `knownDays` is asked AFTER the profile call rather than before it, because
 * the days are stored against the mailbox ADDRESS and nothing knows the address
 * until Gmail has said it. A finished day does not change, so it is asked about
 * once; the newest three are re-read every run because a day is still gaining
 * mail until it is over. That is the same "never re-fetch a day already
 * answered, bar the ones still moving" rule the app stores keep.
 */
async function collectMailbox(
  account: Account,
  values: Record<string, string>,
  salt: Buffer,
  knownDays: (address: string) => Set<string>,
): Promise<MailboxResult> {
  const base: MailboxResult = {
    accountId: account.id,
    accountLabel: account.label,
    ok: false,
    address: null,
    messagesTotal: null,
    threadsTotal: null,
    historyId: null,
    scopes: [],
    labels: [],
    days: [],
    correspondents: [],
    outreach: { days: OUTREACH_DAYS, messages: 0, truncated: false },
    notes: [],
  };

  const { token, scopes } = await accessToken(
    values["client-id"]!,
    values["client-secret"]!,
    values["refresh-token"]!,
  );
  base.scopes = scopes;

  const profile = await get<{
    emailAddress?: string;
    messagesTotal?: number;
    threadsTotal?: number;
    historyId?: string;
  }>("profile", token, [
    ["fields", "emailAddress,messagesTotal,threadsTotal,historyId"],
  ], COST.profile);
  base.address = profile.emailAddress ?? null;
  base.messagesTotal = profile.messagesTotal ?? null;
  base.threadsTotal = profile.threadsTotal ?? null;
  base.historyId = profile.historyId ?? null;
  base.ok = true;
  const known = knownDays(base.address ?? "");

  /* ------------------------------------------------------------- labels */

  let stubs: LabelStub[] = [];
  try {
    const doc = await get<{ labels?: LabelStub[] }>(
      "labels",
      token,
      [["fields", "labels(id,name,type)"]],
      COST.label,
    );
    stubs = (doc.labels ?? []).filter(keepLabel);
  } catch (err) {
    base.notes.push(
      `the label list could not be read (${err instanceof GmailError ? err.body : "error"})`,
    );
  }

  const labels: GmailLabel[] = await pooled(stubs, CONCURRENCY, async (l) => {
    const row: GmailLabel = {
      id: l.id!,
      name: l.name!,
      kind: l.type === "system" ? "system" : "user",
      messagesTotal: null,
      messagesUnread: null,
      threadsTotal: null,
      threadsUnread: null,
      scanned: null,
      needingReply: null,
      oldestWaitingDays: null,
      truncated: false,
      note: null,
    };
    try {
      /*
        Gmail's OWN counters, which is the whole reason the unread figure on
        this dashboard is exact rather than estimated. labels.get costs one
        request and returns four exact numbers; the alternative — listing ids
        and counting them — costs a page per five hundred messages to learn the
        same thing about an inbox holding 83,299.
      */
      const doc = await get<{
        messagesTotal?: number;
        messagesUnread?: number;
        threadsTotal?: number;
        threadsUnread?: number;
      }>(
        `labels/${l.id}`,
        token,
        [["fields", "messagesTotal,messagesUnread,threadsTotal,threadsUnread"]],
        COST.label,
      );
      row.messagesTotal = doc.messagesTotal ?? null;
      row.messagesUnread = doc.messagesUnread ?? null;
      row.threadsTotal = doc.threadsTotal ?? null;
      row.threadsUnread = doc.threadsUnread ?? null;
    } catch (err) {
      // Null, not zero. An empty label and a label that would not answer are
      // different facts, and a zero erases the difference.
      row.note = `counters unavailable (${err instanceof GmailError ? err.body.slice(0, 90) : "error"})`;
    }
    return row;
  });
  base.labels = labels;

  /* ------------------------------------------------------------- triage */

  const bulk = BULK_CATEGORIES.map((c) => `-category:${c}`).join(" ");
  const query = `newer_than:${WINDOW_DAYS}d ${bulk}`;
  const nowSec = Math.floor(Date.now() / 1000);
  let budget = MAX_THREAD_FETCH;

  // INBOX first, then the hand-made labels smallest-first: a budget spent on
  // the mailbox's own queue is worth more than one spent on a label holding
  // eleven messages, and the small labels then all fit in what is left.
  const order = labels
    .filter((l) => SCAN_LABELS.has(l.id) || l.kind === "user")
    .sort((a, b) =>
      SCAN_LABELS.has(a.id) === SCAN_LABELS.has(b.id)
        ? (a.threadsTotal ?? 0) - (b.threadsTotal ?? 0)
        : SCAN_LABELS.has(a.id)
          ? -1
          : 1,
    );

  for (const label of order) {
    if (budget <= 0) {
      label.note = "the run's thread budget ran out before this label";
      continue;
    }
    const notes: string[] = [];
    let ids: string[] = [];
    try {
      const listed = await threadIds(token, label.id, query, MAX_THREAD_LIST);
      ids = listed.ids;
      if (listed.truncated) {
        label.truncated = true;
        notes.push(`more than ${MAX_THREAD_LIST} threads in the window`);
      }
    } catch (err) {
      label.note = `not scanned (${err instanceof GmailError ? err.body.slice(0, 90) : "error"})`;
      continue;
    }

    const spend = Math.min(ids.length, budget);
    if (spend < ids.length) {
      label.truncated = true;
      notes.push(
        `only the ${spend} most recent of ${ids.length} threads were checked ` +
          "for a reply, so the count is a floor",
      );
    }
    budget -= spend;

    const states = await pooled(ids.slice(0, spend), CONCURRENCY, async (id) => {
      try {
        return await threadState(token, id);
      } catch {
        return "failed" as const;
      }
    });

    let waiting = 0;
    let oldest: number | null = null;
    let failed = 0;
    for (const s of states) {
      if (s === "failed") {
        failed += 1;
        continue;
      }
      if (!s || !s.waiting) continue;
      waiting += 1;
      if (s.at !== null) {
        const age = Math.max(0, Math.floor((nowSec - s.at) / 86_400));
        oldest = oldest === null ? age : Math.max(oldest, age);
      }
    }
    if (failed) {
      label.truncated = true;
      notes.push(`${failed} thread(s) could not be read`);
    }
    label.scanned = spend;
    label.needingReply = waiting;
    label.oldestWaitingDays = oldest;
    label.note = notes.join("; ") || null;
  }

  if (budget <= 0)
    base.notes.push(
      `the run's ${MAX_THREAD_FETCH}-thread budget was spent; every label it ` +
        "did not reach reports no reply count rather than a zero",
    );

  /* -------------------------------------------------------- daily volume */

  const wanted: { day: string; from: Date; to: Date }[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const from = new Date(Date.now() - i * 86_400_000);
    const to = new Date(from.getTime() + 86_400_000);
    wanted.push({ day: isoDay(from), from, to });
  }
  /* A finished day does not gain mail, so it is asked about once. The newest
     three are re-read on every run because today is still filling and Gmail's
     own day boundary is the mailbox's timezone rather than this box's. */
  const due = wanted.filter((d, i) => i < 3 || !known.has(d.day));
  const counted = await pooled(due, CONCURRENCY, async (d) => {
    const span = `after:${searchDay(d.from)} before:${searchDay(d.to)}`;
    try {
      const [inbox, sent] = await Promise.all([
        dayCount(token, `in:inbox ${span}`),
        dayCount(token, `in:sent ${span}`),
      ]);
      return {
        day: d.day,
        received: inbox.n,
        sent: sent.n,
        receivedCapped: inbox.capped,
        sentCapped: sent.capped,
      };
    } catch (err) {
      /* The REASON, not just the absence. A note reading "30 days could not be
         read" with nothing after it is the sentence this codebase exists not to
         print: a reader cannot tell a rate limit from a revoked grant, and the
         two need completely different things done about them. */
      return err instanceof GmailError
        ? `${err.status} ${err.body}`
        : `${err instanceof Error ? err.name : "Error"}: ${
            err instanceof Error ? err.message : String(err)
          }`;
    }
  });
  base.days = counted.filter((d): d is GmailDay => typeof d !== "string");
  const dayErrors = counted.filter((d): d is string => typeof d === "string");
  if (dayErrors.length)
    base.notes.push(
      `${dayErrors.length} day(s) of the volume line could not be read and are ` +
        `absent rather than drawn as zero (${dayErrors[0]!.slice(0, 120)})`,
    );

  /* ------------------------------------------------------------ outreach */

  try {
    const listed = await get<{ messages?: { id?: string }[]; nextPageToken?: string }>(
      "messages",
      token,
      [
        ["q", `in:sent newer_than:${OUTREACH_DAYS}d`],
        ["maxResults", "500"],
        ["fields", "messages/id,nextPageToken"],
      ],
      COST.messageList,
    );
    const ids = (listed.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id)
      .slice(0, MAX_OUTREACH_MESSAGES);
    const truncated =
      !!listed.nextPageToken || (listed.messages ?? []).length > MAX_OUTREACH_MESSAGES;

    const seen = new Map<string, Correspondent>();
    const rows = await pooled(ids, CONCURRENCY, async (id) => {
      try {
        /*
          THE ONE PLACE HEADERS ARE READ, and it reads exactly two of them off
          mail this mailbox SENT. `metadataHeaders` is an allowlist and the
          `fields` mask cuts everything else — no Subject, no body, no snippet.
          Every address that comes back is turned into a fingerprint below and
          the string is dropped on the floor.
        */
        return await get<{
          internalDate?: string;
          payload?: { headers?: { name?: string; value?: string }[] };
        }>(`messages/${id}`, token, [
          ["format", "metadata"],
          ["metadataHeaders", "To"],
          ["metadataHeaders", "Cc"],
          ["fields", "internalDate,payload/headers"],
        ], COST.messageGet);
      } catch {
        return null;
      }
    });

    for (const doc of rows) {
      const at = whenOf(doc?.internalDate);
      if (!doc || at === null) continue;
      const day = new Date(at * 1000).toISOString().slice(0, 10);
      const people = new Set<string>();
      for (const h of doc.payload?.headers ?? [])
        if (h.value && (h.name === "To" || h.name === "Cc"))
          for (const a of addressesIn(h.value)) people.add(a);
      // The mailbox writing to itself is not a relationship — the load-bearing
      // `is_self` rule collect_contacts.py names as the worst thing to get
      // wrong, kept here in its one-mailbox form.
      if (base.address) people.delete(base.address.toLowerCase());
      for (const address of people) {
        const fp = fingerprint(salt, address);
        const row = seen.get(fp);
        if (!row) seen.set(fp, { fingerprint: fp, firstAt: day, lastAt: day, messages: 1 });
        else {
          row.firstAt = row.firstAt < day ? row.firstAt : day;
          row.lastAt = row.lastAt > day ? row.lastAt : day;
          row.messages += 1;
        }
      }
    }
    base.correspondents = [...seen.values()];
    base.outreach = { days: OUTREACH_DAYS, messages: ids.length, truncated };
    if (truncated)
      base.notes.push(
        `the outreach scan stopped at ${MAX_OUTREACH_MESSAGES} sent messages, ` +
          "so the people count is a floor",
      );
  } catch (err) {
    base.notes.push(
      `the outreach scan was refused (${err instanceof GmailError ? err.body.slice(0, 90) : "error"})`,
    );
  }

  return base;
}

/**
 * Every connected mailbox, one after another.
 *
 * Sequential rather than pooled at this level: each mailbox already runs six
 * requests at a time inside itself, and three mailboxes doing that at once is
 * eighteen concurrent calls against one user's rate ceiling for no wall-clock
 * gain worth the risk.
 */
export async function collect(
  salt: Buffer,
  knownDays: (address: string) => Set<string>,
  reader = "collect_gmail",
): Promise<CollectResult> {
  const pairs = tokenAccounts(reader);
  const out: CollectResult = { mailboxes: [], accountsTried: pairs.length, warnings: [] };

  for (const { account, values } of pairs) {
    try {
      /* The day cache is keyed by ADDRESS rather than by account row, because
         that is how the days are stored — a mailbox re-connected under a new
         account row must not re-read a month it already has. */
      const mailbox = await collectMailbox(account, values, salt, knownDays);
      out.mailboxes.push(mailbox);
      for (const n of mailbox.notes) out.warnings.push(`${account.label}: ${n}`);
    } catch (err) {
      const error =
        err instanceof GmailError
          ? `HTTP ${err.status} ${err.body}`
          : err instanceof Error && err.name === "TimeoutError"
            ? "Gmail did not answer within 45 seconds."
            : `Could not reach Gmail (${err instanceof Error ? err.name : "Error"}).`;
      out.mailboxes.push({
        accountId: account.id,
        accountLabel: account.label,
        ok: false,
        error,
        address: null,
        messagesTotal: null,
        threadsTotal: null,
        historyId: null,
        scopes: [],
        labels: [],
        days: [],
        correspondents: [],
        outreach: { days: OUTREACH_DAYS, messages: 0, truncated: false },
        notes: [],
      });
      out.warnings.push(`${account.label}: ${error}`);
    }
  }

  return out;
}

/* ==========================================================================
   THE LIVE HALF — the mailbox app
   ==========================================================================

   EVERYTHING ABOVE THIS BANNER IS THE COLLECTOR: it runs on a timer, it asks
   Gmail with a `fields` mask that cannot return a subject, and what it learns
   goes into tables that have no column for a body. Everything below it is the
   opposite kind of code, and the difference is worth stating rather than
   leaving to be discovered.

   THE COLLECTOR STORES COUNTS. THE LIVE HALF STORES NOTHING. A mail client
   has to render a subject, a sender and a body, so no mask can save this half
   the way it saves that one — the private data is the product. What replaces
   the mask is the absence of a destination: these functions are called inside
   one HTTP request, their answer is written to one response, and there is no
   table, no cache, no log line and no file anywhere below them. `routes/
   mailbox.ts` is the only caller and its own header carries the same rule from
   the other end.

   That is a real stance change from the file it sits in and not an oversight,
   which is why it is a banner and not a comment. `routes/mail.ts` — the
   figures route — keeps the old contract exactly: its schema still cannot hold
   a subject, and nothing here writes to it.

   WHY THESE LIVE IN THE PROVIDER AT ALL rather than in the route. Because
   `get` lives here, and the whole argument of this file is that there is one
   place a Gmail request is made. A route that built its own fetch would be a
   second entry point, unpaced, unretried, and outside the gate — which is the
   shape this file exists to prevent. Thread listing and thread reading are
   GETs and fit the existing entry point unchanged; the write got a second
   entry point of its own, named and bounded, rather than a `method` parameter
   on the first.
*/

/**
 * A token, and the account it belongs to.
 *
 * Held for the life of ONE request and never cached. An access token is good
 * for an hour and caching it would save a round trip per page view, at the
 * price of a live credential sitting in this process's memory between
 * requests — which is the one thing the vault exists to avoid. The refresh
 * costs ~200ms against a thread hydration that costs two seconds.
 */
export type Session = {
  account: Account;
  token: string;
  /** What Google says the grant carries, off the refresh response. `modify`
   *  checks this before it writes, because a read-only grant must fail as
   *  "this token cannot do that" and not as a 403 three frames later. */
  scopes: string[];
};

/** Nothing to open: no mailbox is connected, or the id named none. Its own
 *  class because the route answers it 404 with a link to Integrations, while
 *  a GmailError is a 502 about a service. */
export class NoMailbox extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoMailbox";
  }
}

/**
 * Mint a token for one mailbox.
 *
 * `accountId` picks one when several Google accounts are connected; without it
 * the first connected account answers, which is what an absent `?account=`
 * means everywhere on this box. There is one mailbox on this install today and
 * the parameter exists so that the second one is a chip rather than a rewrite.
 */
export async function open(reader: string, accountId?: number): Promise<Session> {
  const pairs = tokenAccounts(reader);
  if (!pairs.length)
    throw new NoMailbox(
      "No Gmail account is connected, so there is no mailbox to read. " +
        "Connect one on the Integrations page.",
    );
  const pair =
    accountId === undefined
      ? pairs[0]!
      : pairs.find((p) => p.account.id === accountId);
  if (!pair)
    throw new NoMailbox(
      `No connected Gmail account with id ${accountId}. Connected: ` +
        pairs.map((p) => `${p.account.id} (${p.account.label})`).join(", "),
    );

  const { token, scopes } = await accessToken(
    pair.values["client-id"]!,
    pair.values["client-secret"]!,
    pair.values["refresh-token"]!,
  );
  return { account: pair.account, token, scopes };
}

/* ------------------------------------------------------------- headers */

type Header = { name?: string; value?: string };

/** The first value of a header, case-insensitively. "" rather than undefined,
 *  because every consumer of these renders them into a string. */
function header(headers: Header[], name: string): string {
  const want = name.toLowerCase();
  for (const h of headers) if ((h.name ?? "").toLowerCase() === want) return h.value ?? "";
  return "";
}

/** EVERY value of a header, not the first. A forwarded message carries several
 *  `Delivered-To` lines and a wide `Cc` is split across folded headers; taking
 *  only the first is how a thread addressed to two of our domains gets
 *  attributed to neither. */
function headerAll(headers: Header[], name: string): string[] {
  const want = name.toLowerCase();
  const out: string[] = [];
  for (const h of headers)
    if ((h.name ?? "").toLowerCase() === want && h.value) out.push(h.value);
  return out;
}

/**
 * Addresses out of a header, by shape rather than by splitting on commas.
 *
 * `"Ogbeide, Courage" <c@x.io>` is one recipient with a comma inside a quoted
 * display name, and comma-splitting turns it into two — one of them a fragment
 * with no `@` and the other an address that has lost its opening quote. Pulling
 * out anything that looks like an address survives that, and survives
 * `<a@b.io>, c@d.io` and the un-bracketed bare form equally.
 */
const ADDRESS_RE = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g;

function addressesOf(...headerValues: string[]): string[] {
  const out: string[] = [];
  for (const value of headerValues) {
    for (const m of value.matchAll(ADDRESS_RE)) {
      const address = m[0].trim().toLowerCase().replace(/[.,;>]+$/, "");
      if (address.includes("@")) out.push(address);
    }
  }
  return out;
}

/** `Jane Smith <jane@x.io>` as its two halves. The display name is a label
 *  somebody typed and the address is the fact, so a list row can show the
 *  first and a reply can use the second. */
function splitFrom(value: string): { address: string; name: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (m) {
    const name = m[1]!.replace(/^"(.*)"$/, "$1").trim();
    return { address: m[2]!.trim(), name };
  }
  return { address: value.trim(), name: "" };
}

/** Gmail's `internalDate` is epoch MILLISECONDS as a string. Null rather than
 *  0 when it is absent: a message at the Unix epoch sorts to the bottom of a
 *  list forever and reads as a real date from 1970. */
const whenMs = (v: string | undefined): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/* --------------------------------------------------------------- listing */

/** One row of the thread list. Built from the thread's messages rather than
 *  from a single message, because a conversation's subject is its first
 *  message's and its arrival time is its last message's. */
export type ThreadRow = {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  /** The last message's To header, verbatim, for the row to show. */
  to: string;
  /** Unix milliseconds. Null when Gmail gave no internalDate for any message,
   *  which has not been seen and is not the same as "a long time ago". */
  at: number | null;
  snippet: string;
  unread: boolean;
  labels: string[];
  /** The "(3)" Gmail puts after a sender. Always at least 1. */
  messages: number;
  /**
   * Every address in every To, Cc and Delivered-To across the whole thread,
   * lowercased and deduplicated.
   *
   * The provider does not decide which venture mailbox a thread arrived at —
   * it does not know what the ventures are. It hands over the evidence and
   * `routes/mailbox.ts` decides against the connected Resend domains, which is
   * the only place both facts are on hand.
   */
  recipients: string[];
};

type MetaMessage = {
  id?: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: Header[] };
};

/**
 * A page of threads for one Gmail query.
 *
 * TWO STEPS, AND THE SECOND IS WHERE THE MONEY GOES. `threads.list` answers
 * with ids, a snippet and nothing else — no subject, no sender, no date — so
 * every row has to be hydrated with a `threads.get`. That is ten quota units a
 * row against ten for the whole listing, which is why the page is capped:
 * twenty-five rows is 260 units, about two seconds through the gate, and a
 * hundred would be a page that takes eight.
 *
 * `format=metadata` with an explicit `metadataHeaders` list, so the hydration
 * fetches headers and not bodies. A body is what the reader is for, and
 * fetching twenty-five of them to render twenty-five one-line snippets would
 * be several megabytes to draw a list.
 *
 * ONE THREAD FAILING DOES NOT FAIL THE PAGE. A thread deleted between the
 * listing and the hydration answers 404, and a page that threw would show
 * nothing because one conversation moved to the bin mid-request. It is dropped
 * and the rest arrive — the same trade the collector makes per label and per
 * repo everywhere else on this box.
 */
export async function listThreads(
  session: Session,
  opts: { q: string; max: number; pageToken?: string },
): Promise<{ threads: ThreadRow[]; nextPageToken: string | null; dropped: number }> {
  const { token } = session;
  const list = await get<{ threads?: { id?: string; snippet?: string }[]; nextPageToken?: string }>(
    "threads",
    token,
    [
      ["maxResults", String(opts.max)],
      ...(opts.q ? ([["q", opts.q]] as [string, string][]) : []),
      ...(opts.pageToken ? ([["pageToken", opts.pageToken]] as [string, string][]) : []),
      ["fields", "threads(id,snippet),nextPageToken"],
    ],
    COST.threadList,
  );

  const stubs = (list.threads ?? []).filter((t): t is { id: string; snippet?: string } => !!t.id);

  const hydrated = await pooled(stubs, CONCURRENCY, async (stub) => {
    try {
      const doc = await get<{ messages?: MetaMessage[] }>(
        `threads/${encodeURIComponent(stub.id)}`,
        token,
        [
          ["format", "metadata"],
          ["metadataHeaders", "Subject"],
          ["metadataHeaders", "From"],
          ["metadataHeaders", "To"],
          ["metadataHeaders", "Cc"],
          ["metadataHeaders", "Date"],
          ["metadataHeaders", "Delivered-To"],
          ["fields", "messages(id,labelIds,internalDate,snippet,payload/headers)"],
        ],
        COST.threadGet,
      );
      return { stub, doc };
    } catch {
      /* Deleted, or refused for this one thread. Dropped rather than fatal. */
      return null;
    }
  });

  const threads: ThreadRow[] = [];
  let dropped = 0;

  for (const entry of hydrated) {
    if (!entry) {
      dropped += 1;
      continue;
    }
    const messages = entry.doc.messages ?? [];
    if (!messages.length) {
      dropped += 1;
      continue;
    }
    /* Gmail returns a thread oldest-first. The subject belongs to the
       conversation and is taken from the first message that has one; the
       sender and the time belong to the most recent thing that happened. */
    const last = messages[messages.length - 1]!;
    const lastHeaders = last.payload?.headers ?? [];
    const subject =
      messages.map((m) => header(m.payload?.headers ?? [], "Subject")).find(Boolean) ?? "";
    const from = splitFrom(header(lastHeaders, "From"));

    const recipients = new Set<string>();
    for (const m of messages) {
      const hs = m.payload?.headers ?? [];
      for (const a of addressesOf(
        ...headerAll(hs, "To"),
        ...headerAll(hs, "Cc"),
        ...headerAll(hs, "Delivered-To"),
      ))
        recipients.add(a);
    }

    const labels = new Set<string>();
    for (const m of messages) for (const l of m.labelIds ?? []) labels.add(l);

    threads.push({
      id: entry.stub.id,
      subject,
      from: from.address,
      fromName: from.name,
      to: header(lastHeaders, "To"),
      at: whenMs(last.internalDate),
      snippet: entry.stub.snippet ?? last.snippet ?? "",
      /* A thread is unread if ANY message in it is, which is what makes the
         row bold in Gmail itself. */
      unread: messages.some((m) => (m.labelIds ?? []).includes("UNREAD")),
      labels: [...labels],
      messages: messages.length,
      recipients: [...recipients],
    });
  }

  /* Newest first. The listing already arrives that way, but the hydration is
     pooled and a dropped row would otherwise leave a hole in the order. */
  threads.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

  return { threads, nextPageToken: list.nextPageToken ?? null, dropped };
}

/* ---------------------------------------------------------------- reading */

export type Attachment = {
  filename: string;
  mimeType: string;
  /** Bytes, as Gmail reports them. Null when the part carried no size. */
  size: number | null;
};

export type LiveMessage = {
  /** Gmail's own message id — what threads replies inside this mailbox. */
  id: string;
  /**
   * The RFC 5322 `Message-ID` header, which is a different identifier and the
   * one a reply has to reference. A recipient's mail client threads on this
   * and knows nothing about Gmail's. Null when the header was absent, which
   * happens on drafts.
   */
  messageId: string | null;
  from: string;
  fromName: string;
  to: string;
  cc: string;
  subject: string;
  at: number | null;
  unread: boolean;
  labels: string[];
  /** The plain-text part, joined. "" when the sender shipped HTML only. */
  text: string;
  /**
   * The sender's own HTML, DECODED AND OTHERWISE UNTOUCHED.
   *
   * This is a stranger's markup. It is not sanitised here and it must never
   * reach a wire in this state — `routes/mailbox.ts` is the only caller of
   * this function and sanitises it before it puts it in a response. It is
   * returned raw rather than cleaned in place because the cleaning depends on
   * a per-message decision the provider has no business making (whether remote
   * images are being loaded), and a half-sanitised string is worse than an
   * obviously raw one.
   */
  html: string | null;
  /** Named and sized, never fetched. A list of attachments costs nothing —
   *  the parts are already in the response — and downloading them would be
   *  megabytes through this process for something nobody has clicked. */
  attachments: Attachment[];
};

type Part = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: Part[];
};

/** Gmail encodes every body as base64url. A part that will not decode comes
 *  back as "" rather than throwing: one malformed part must not cost the
 *  message it is in. */
function decodePart(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

/**
 * The MIME tree, walked.
 *
 * BOTH BODIES ARE COLLECTED, NEVER ONE OR THE OTHER. `multipart/alternative`
 * means the sender shipped the same message twice and the client picks; but a
 * great many senders ship an EMPTY text part beside a full HTML one, so
 * "prefer text" alone renders a blank message. Both are carried and the reader
 * decides, which also means "show me the plain version" is a thing the page
 * can offer without a second request.
 *
 * A part with an `attachmentId` is a file rather than a body even when its
 * mime type says `text/plain` — that is an attached .txt, and folding it into
 * the message body is how a reader shows a log file as if somebody had typed
 * it.
 */
function walkParts(
  part: Part,
  acc: { text: string[]; html: string[]; files: Attachment[] },
) {
  const mime = (part.mimeType ?? "").toLowerCase();
  const isFile = !!part.body?.attachmentId;

  if (!isFile && part.body?.data) {
    if (mime === "text/plain") acc.text.push(decodePart(part.body.data));
    else if (mime === "text/html") acc.html.push(decodePart(part.body.data));
  } else if (isFile) {
    acc.files.push({
      /* An inline image has no filename and is not something to list — it is
         part of the design of the mail, not an enclosure. Content-Id names it
         instead, and the reader shows it as an inline image rather than as a
         file somebody sent. */
      filename: part.filename?.trim() || "",
      mimeType: part.mimeType ?? "application/octet-stream",
      size: typeof part.body?.size === "number" ? part.body.size : null,
    });
  }

  for (const child of part.parts ?? []) walkParts(child, acc);
}

/**
 * One thread, whole.
 *
 * `format=full` and NO `fields` mask, which is the one call in this file that
 * asks Gmail for everything it has about a message. The mask everywhere else
 * exists to stop a body arriving; here the body is the point. Nothing is
 * stored — see the banner.
 */
export async function readThread(
  session: Session,
  threadId: string,
): Promise<{ id: string; messages: LiveMessage[] } | null> {
  const doc = await get<{ id?: string; messages?: (MetaMessage & { payload?: Part })[] }>(
    `threads/${encodeURIComponent(threadId)}`,
    session.token,
    [["format", "full"]],
    COST.threadGet,
  );
  if (!doc.messages?.length) return null;

  const messages: LiveMessage[] = doc.messages.map((m) => {
    const headers = m.payload?.headers ?? [];
    const from = splitFrom(header(headers, "From"));
    const acc = { text: [] as string[], html: [] as string[], files: [] as Attachment[] };
    if (m.payload) walkParts(m.payload, acc);
    const text = acc.text.join("\n").trim();
    const html = acc.html.join("\n").trim();
    return {
      id: m.id ?? "",
      messageId: header(headers, "Message-ID").trim() || null,
      from: from.address,
      fromName: from.name,
      to: headerAll(headers, "To").join(", "),
      cc: headerAll(headers, "Cc").join(", "),
      subject: header(headers, "Subject"),
      at: whenMs(m.internalDate),
      unread: (m.labelIds ?? []).includes("UNREAD"),
      labels: m.labelIds ?? [],
      /* A message with neither part — a calendar invite, a bare attachment —
         falls back to the snippet, which is at least a sentence rather than an
         empty card that reads as a failure to load. */
      text: text || (html ? "" : (m.snippet ?? "")),
      html: html || null,
      attachments: acc.files.filter((f) => f.filename),
    };
  });

  return { id: doc.id ?? threadId, messages };
}

/* ------------------------------------------------------------- the write */

/**
 * THE SECOND FUNCTION IN THIS FILE THAT TALKS TO GMAIL, AND THE ONLY ONE THAT
 * WRITES.
 *
 * It exists because an opened thread that stays bold is a mail client nobody
 * believes, and marking read is the one write a reader cannot do without.
 *
 * WHAT MAKES IT SAFE IS ITS SHAPE, not a comment. It takes a thread id and a
 * boolean; it builds the body from the two frozen constants below and from
 * nothing the caller supplies; and it appends `/modify` to a path it builds
 * itself. The strings `trash`, `untrash`, `send`, `batchModify`, `batchDelete`
 * and `drafts` do not appear in this function, so there is no argument that
 * reaches them — which is the same argument `get` makes about `method`, made
 * about a URL and a body instead.
 *
 * The scope is checked first, so a `gmail.readonly` grant fails as a sentence
 * about the credential rather than as a Google 403 the route would have to
 * translate. An ABSENT scope list is allowed through for the reason `verify`
 * allows it: Google omits `scope` from some refresh responses, and refusing on
 * a field that may not be sent would break a working credential.
 */
const UNREAD_OFF = { removeLabelIds: ["UNREAD"] } as const;
const UNREAD_ON = { addLabelIds: ["UNREAD"] } as const;
const MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export async function modify(
  session: Session,
  threadId: string,
  unread: boolean,
): Promise<{ threadId: string; unread: boolean }> {
  if (session.scopes.length && !session.scopes.includes(MODIFY_SCOPE))
    throw new GmailError(
      403,
      "That Gmail grant is read-only, so this dashboard cannot change what is " +
        "read and what is not. Marking a thread read needs gmail.modify.",
    );

  /* The id goes into a path, so it is checked as an id rather than escaped and
     hoped for. Gmail's own ids are hex; this is the wider set Google documents
     for resource names, and anything else never becomes a URL at all. */
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId))
    throw new GmailError(400, "That is not a Gmail thread id.");

  await gate(COST.threadModify);
  const res = await fetch(
    `${GMAIL_API}/threads/${threadId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(unread ? UNREAD_ON : UNREAD_OFF),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    let message = body.slice(0, 300);
    try {
      const doc = JSON.parse(body) as { error?: { message?: string } };
      if (doc.error?.message) message = doc.error.message.slice(0, 300);
    } catch {
      /* not the documented shape; the body stands */
    }
    throw new GmailError(res.status, message);
  }
  /* The response is the thread's new label set. It is read and discarded: the
     caller asked for a state and this returns the state it asked for, so a
     partial write would have been an error rather than a different answer. */
  await res.text();
  return { threadId, unread };
}

export type { Account };
