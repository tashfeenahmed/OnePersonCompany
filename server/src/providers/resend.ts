/**
 * Resend — eleven keys, one per sending domain.
 *
 * THIS IS WHAT THE ACCOUNTS MODEL IS FOR, and it is the clearest example of it
 * on the board. The previous system kept the credential as ONE vault entry,
 * a JSON object keyed by domain:
 *
 *     { "acme.ie": "re_…", "acme.so": "re_…", … }
 *
 * — eleven keys in one document, which is precisely the shape `accounts.ts`
 * exists to undo. A blob has no per-key label, no per-key state and no per-key
 * error: one revoked key shows up as a warning rather than as
 * "acme.so stopped answering", and there is nowhere to put the fact that
 * one of these eleven is a send-only key that can never be read from. Here each
 * key is its own ACCOUNT, labelled with its domain, with its own connected
 * flag, its own last error and its own vault entry — the same split
 * `005_accounts_split` performed on the Hetzner token blob.
 *
 * A KEY IS SCOPED TO ITS DOMAIN, which is what makes eleven of them necessary
 * rather than tidy. Probed on 2026-09-05: the acme.ie key's `GET /domains`
 * returns acme.ie and nothing else, and its `GET /emails` returns
 * acme.ie's mail and nothing else. There is no key here that sees the
 * whole account, so one account row could not have covered them even in
 * principle.
 *
 * WHAT RESEND WILL AND WILL NOT SAY, probed 2026-09-05:
 *
 *     GET /domains          200 — status, region, created_at, capabilities,
 *                                 open_tracking/click_tracking flags
 *     GET /domains/{id}     200 — the DNS records, each with its OWN status
 *     GET /emails?limit=…   200 — a real list endpoint: id, created_at,
 *                                 from, to, subject, last_event. Pages with
 *                                 `after=<uuid>`, 1–100 per page.
 *     GET /api-keys         200 — the keys on the account and when each was
 *                                 last used
 *     GET /usage            404
 *     GET /account, /metrics, /stats, /v1/usage   405 Method not allowed
 *
 * SO SEND VOLUME IS ANSWERABLE, and that is the finding that shapes the whole
 * integration. It was not obvious — Resend's dashboard shows a chart and its
 * docs are mostly about sending — and a plausible reading of the API was that
 * only individual emails could be fetched by id, in which case there would be
 * no volume figure and the two catalog cards promising one would have had to
 * say so. `/emails` exists, it pages, and it carries `last_event`, so delivered
 * and bounced are countable per day per domain from real rows.
 *
 * WHAT IS STORED, AND WHAT IS THROWN AWAY IN THIS FILE. An email record carries
 * `to`, `subject` and `bcc`. None of them is returned by this function, none
 * reaches the database, and none can therefore reach the wire — the same rule
 * the previous system's own collector keeps for review authors and `providers/gmail.ts`
 * keeps for correspondents. What is kept is the day, the sending address (which
 * is ours), and `last_event`.
 *
 * NOTHING HERE SENDS. There is one HTTP entry point, it hard-codes
 * `method: "GET"`, and it takes no body — so `POST /emails` is not something
 * this file could be made to do by any argument. That matters more than usual
 * because every one of these keys can send mail from a live domain.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

export const RESEND_API = "https://api.resend.com";
const TIMEOUT_MS = 30_000;

/**
 * How far back the email list is walked.
 *
 * Ninety days, which on the busiest domain here is about six pages. The walk
 * stops at the first row older than the window rather than at a page count, so
 * a quiet domain costs one request and a busy one costs what it costs.
 */
export const WINDOW_DAYS = 90;

/** Resend's own maximum page size. Asking for 200 is a 422 that names the
 *  limit, which is how this number was arrived at. */
const PAGE = 100;

/** A ceiling on the walk, so a domain that suddenly sends a hundred thousand
 *  emails cannot turn a collection into an afternoon. A run that hits it says
 *  so and its counts are reported as floors. */
export const MAX_PAGES = 20;

/**
 * A quarter of a second between requests.
 *
 * Resend rate-limits at two requests a second on the default plan and answers
 * 429 past it. Ten domains times a handful of pages is a few dozen requests, so
 * pacing them costs seconds and removes the one failure mode that would look
 * like a broken key.
 */
const PACE_MS = 250;

/**
 * The `last_event` values seen on this account, and how they are read.
 *
 * Resend reports the LATEST event on an email rather than a history, so these
 * are mutually exclusive and every email is in exactly one bucket. `delivered`
 * and `bounced` are the two that matter; `complained` is a spam report and is
 * counted apart because it is a different and worse thing than a bounce.
 * `suppressed` is Resend refusing to send to an address on its own suppression
 * list — it never reached a mail server, so it is neither a delivery nor a
 * bounce and is counted on its own.
 *
 * OPENS AND CLICKS ARE NOT IN THIS LIST AND CANNOT BE. `open_tracking` and
 * `click_tracking` are FALSE on every domain on this account, so Resend never
 * writes an `opened` or `clicked` event for them. An open rate here would be a
 * measurement of a feature nobody switched on.
 */
export const EVENTS = [
  "delivered",
  "bounced",
  "complained",
  "suppressed",
  "sent",
  "queued",
  "scheduled",
  "delivery_delayed",
  "canceled",
  "failed",
] as const;

/* ------------------------------------------------------------------ shapes */

export type DnsRecord = {
  /** "DKIM", "SPF" — Resend's own grouping, not the DNS type. */
  record: string | null;
  type: string | null;
  name: string | null;
  status: string | null;
  priority: number | null;
};

export type DomainRow = {
  id: string;
  name: string;
  /** "verified", "pending", "failed", "temporary_failure" — Resend's word,
   *  never reduced to a boolean. "pending" is not "failed". */
  status: string | null;
  region: string | null;
  createdAt: string | null;
  sending: string | null;
  receiving: string | null;
  openTracking: boolean | null;
  clickTracking: boolean | null;
  records: DnsRecord[];
  /** Null when the per-domain call was not made or was refused — which is not
   *  the same as a domain with no records. */
  recordsRead: boolean;
};

export type EmailRow = {
  id: string;
  domain: string;
  /** The calendar day Resend stamped, UTC. */
  day: string;
  createdAt: string;
  /** OUR OWN sending address. The recipient is never read out of the response
   *  and the subject never leaves this file. */
  fromAddress: string | null;
  lastEvent: string | null;
};

export type AccountResult = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  domains: DomainRow[];
  emails: EmailRow[];
  /** How far the walk actually got: pages spent, the oldest row it reached,
   *  and whether the page ceiling cut it short. */
  walk: { pages: number; oldest: string | null; truncated: boolean };
  notes: string[];
};

export type CollectResult = {
  accounts: AccountResult[];
  accountsTried: number;
  warnings: string[];
};

/* -------------------------------------------------------------------- http */

export class ResendError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.name = "ResendError";
    this.status = status;
    this.body = body;
  }
}

/**
 * THE SLOT IS RESERVED BEFORE THE WAIT, NOT AFTER IT.
 *
 * This used to read the clock, sleep the remainder, and only then stamp
 * `lastCall`. Called one after another — which is all the collector ever does
 * — that is identical to this and the difference never showed. Called
 * CONCURRENTLY it collapses: ten callers all read the same stale `lastCall`,
 * all compute the same 250ms, all sleep, and all fire in the same millisecond.
 * The pacer's whole job is not done and Resend answers 429 to most of them.
 *
 * Reserving the slot first — take `nextSlot`, advance it, then sleep until it
 * — makes the spacing a property of the queue rather than of the caller's
 * shape, which is what the mailbox's fan-out over ten domains needs and what
 * `providers/gmail.ts`'s quota gate already does for the same reason.
 */
let nextSlot = 0;
async function pace() {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + PACE_MS;
  if (start > now) await new Promise((r) => setTimeout(r, start - now));
}

/**
 * THE ONLY FUNCTION IN THIS FILE THAT TALKS TO RESEND.
 *
 * `method: "GET"` here and nowhere else, and no body parameter exists — so
 * `POST /emails` is not reachable from this module by any argument. Every one
 * of these keys can send mail from a domain that real people trust, which makes
 * "this cannot send" worth being a property of the code rather than a promise.
 */
async function get<T>(path: string, key: string): Promise<T> {
  await pace();
  const res = await fetch(`${RESEND_API}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text();
    let message = body.slice(0, 300);
    try {
      const doc = JSON.parse(body) as { message?: string; name?: string };
      if (doc.message) message = doc.message.slice(0, 300);
    } catch {
      /* not the documented shape; the body stands */
    }
    throw new ResendError(res.status, message);
  }
  return (await res.json()) as T;
}

/** The one refusal worth a sentence of its own — see `verify`. */
const SEND_ONLY = /restricted to only send/i;

const sendOnlyMessage = (domain: string) =>
  `Resend says that key is “restricted to only send emails”. A Sending-access ` +
  `key can POST an email and read nothing at all, so it can never answer what ` +
  `${domain} has sent. Mint a Full-access key for this domain in Resend → API ` +
  `keys and paste that instead — this dashboard only ever issues GETs, so the ` +
  `wider key is never used to send anything.`;

/* ------------------------------------------------------------------ verify */

/**
 * Is this key real, and can it READ?
 *
 * `GET /domains` rather than the cheapest call, because the two failures this
 * door has to separate are not "valid" and "invalid":
 *
 *   * a revoked or mistyped key answers 401 "API key is invalid";
 *   * a SENDING-ACCESS key answers 401 "This API key is restricted to only
 *     send emails" — it is a perfectly good Resend key that this dashboard can
 *     do nothing with, because every endpoint here is a read.
 *
 * The second is refused rather than stored, for the reason the OpenRouter and
 * Stripe doors refuse an inference key and a test key: a credential that cannot
 * answer would connect happily and produce a permanently empty domain, which is
 * the most expensive shape of failure here because it looks like an answer. It
 * is refused WITH THE FIX, because the fix is one click in Resend and the key
 * that would work is a different key rather than a different service.
 *
 * Measured on a live account: one key in eleven was like that, and it failed
 * identically on every attempt — a property of the key, not a bad minute.
 *
 * The domain the key can see comes back, because it is the natural NAME for the
 * account row: labelling these "Account 1 … Account 11" would throw away the
 * only thing that distinguishes them.
 */
export async function verify(
  key: string,
): Promise<
  { ok: true; domains: { name: string; status: string | null }[] } | { ok: false; error: string }
> {
  try {
    const doc = await get<{ data?: { name?: string; status?: string }[] }>(
      "/domains",
      key,
    );
    const domains = (doc.data ?? [])
      .filter((d) => d.name)
      .map((d) => ({ name: d.name!, status: d.status ?? null }));
    if (!domains.length)
      return {
        ok: false,
        error:
          "That key works and reaches no sending domain. Add and verify a " +
          "domain in Resend → Domains, or paste a key belonging to an account " +
          "that has one — otherwise there is nothing here to report.",
      };
    return { ok: true, domains };
  } catch (err) {
    if (err instanceof ResendError) {
      if (SEND_ONLY.test(err.body)) return { ok: false, error: sendOnlyMessage("a domain") };
      if (err.status === 401)
        return { ok: false, error: `Resend rejected that key (${err.body}).` };
      return { ok: false, error: `Resend answered HTTP ${err.status} — ${err.body}` };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "Resend did not answer within 30 seconds."
          : `Could not reach Resend (${name}).`,
    };
  }
}

/* ----------------------------------------------------------------- readers */

type ApiDomain = {
  id?: string;
  name?: string;
  status?: string;
  region?: string;
  created_at?: string;
  capabilities?: { sending?: string; receiving?: string };
  open_tracking?: boolean;
  click_tracking?: boolean;
  records?: {
    record?: string;
    type?: string;
    name?: string;
    status?: string;
    priority?: number;
  }[];
};

const shapeDomain = (d: ApiDomain, recordsRead: boolean): DomainRow => ({
  id: d.id ?? "",
  name: d.name ?? "",
  status: d.status ?? null,
  region: d.region ?? null,
  createdAt: d.created_at ?? null,
  sending: d.capabilities?.sending ?? null,
  receiving: d.capabilities?.receiving ?? null,
  openTracking: typeof d.open_tracking === "boolean" ? d.open_tracking : null,
  clickTracking: typeof d.click_tracking === "boolean" ? d.click_tracking : null,
  records: (d.records ?? []).map((r) => ({
    record: r.record ?? null,
    type: r.type ?? null,
    name: r.name ?? null,
    status: r.status ?? null,
    priority: typeof r.priority === "number" ? r.priority : null,
  })),
  recordsRead,
});

/** The address between the angle brackets, or the whole string when there are
 *  none. `Acme <hello@acme.ie>` is stored as `hello@acme.ie`:
 *  the display name is a label somebody typed and the address is the fact. */
function fromAddress(value: string | undefined): string | null {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1]! : value).trim().toLowerCase() || null;
}

/**
 * One key's emails, newest first, back to the window.
 *
 * PAGED WITH `after=<id>` RATHER THAN AN OFFSET. Both work — `?page=` and
 * `?offset=` are accepted — but an offset over a list that is growing at the
 * head re-reads or skips rows as mail arrives mid-walk, and a cursor cannot.
 *
 * THE WALK STOPS ON A DATE, not on a page count: rows are keyed by Resend's own
 * email id and REPLACED, so re-reading a day corrects it rather than doubling
 * it, and the only thing a wider walk costs is requests. `last_event` is
 * exactly why the recent days must be re-read at all — an email that was
 * `delivered` this morning can be `bounced` this afternoon, and a stored figure
 * that never looked again would be quietly wrong in the direction that
 * flatters.
 */
async function walkEmails(
  key: string,
  domain: string,
  since: string,
): Promise<{ rows: EmailRow[]; pages: number; oldest: string | null; truncated: boolean }> {
  const rows: EmailRow[] = [];
  let after: string | null = null;
  let pages = 0;
  let oldest: string | null = null;
  let done = false;

  while (pages < MAX_PAGES && !done) {
    const path = `/emails?limit=${PAGE}${after ? `&after=${after}` : ""}`;
    const doc: {
      data?: {
        id?: string;
        created_at?: string;
        from?: string;
        last_event?: string;
      }[];
      has_more?: boolean;
    } = await get(path, key);
    pages += 1;
    const page = doc.data ?? [];
    if (!page.length) break;

    for (const m of page) {
      if (!m.id || !m.created_at) continue;
      /* Resend stamps `2026-09-04 21:15:22.684000+00`, which is ISO with a
         space where the T belongs. Normalised here so every timestamp below is
         the same shape as every other one on this box. */
      const createdAt = m.created_at.replace(" ", "T");
      const day = createdAt.slice(0, 10);
      if (oldest === null || day < oldest) oldest = day;
      if (day < since) {
        done = true;
        continue;
      }
      rows.push({
        id: m.id,
        domain,
        day,
        createdAt,
        fromAddress: fromAddress(m.from),
        lastEvent: m.last_event ?? null,
      });
    }

    after = page[page.length - 1]?.id ?? null;
    if (!doc.has_more || !after) break;
  }

  return { rows, pages, oldest, truncated: pages >= MAX_PAGES && !done };
}

/* ----------------------------------------------------------------- collect */

/**
 * Every connected key, one after another.
 *
 * PER-ACCOUNT FAILURE IS THE POINT HERE. Ten domains answering and one refusing
 * is ten domains on the page and one red row naming its own reason — not a
 * broken Resend integration. The run fails only when every key failed, which is
 * the rule the registrars, Hetzner and Cloudflare all keep.
 */
export async function collect(reader = "collect_resend"): Promise<CollectResult> {
  const { ready, broken } = accounts.credentialed("resend", ["key"], reader);
  const out: CollectResult = {
    accounts: [],
    accountsTried: ready.length + broken.length,
    warnings: [],
  };

  const empty = (account: Account, error: string): AccountResult => ({
    id: account.id,
    label: account.label,
    ok: false,
    error,
    domains: [],
    emails: [],
    walk: { pages: 0, oldest: null, truncated: false },
    notes: [],
  });

  for (const { account } of broken) {
    out.accounts.push(empty(account, "No key stored."));
    out.warnings.push(`${account.label}: no key stored`);
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  for (const { account, values } of ready) {
    const key = (values.key ?? "").trim();
    const notes: string[] = [];
    try {
      const list = await get<{ data?: ApiDomain[] }>("/domains", key);
      const stubs = (list.data ?? []).filter((d) => d.id && d.name);

      /*
        THE DNS RECORDS COST ONE CALL PER DOMAIN and are worth it: the listing
        says a domain is "verified" and the detail says WHICH records prove it
        and what each one's own status is. A domain that reads verified while
        one of its three records is pending is a domain about to stop sending,
        and the listing cannot show that.
      */
      const domains: DomainRow[] = [];
      for (const stub of stubs) {
        try {
          const full = await get<ApiDomain>(`/domains/${stub.id}`, key);
          domains.push(shapeDomain(full, true));
        } catch (err) {
          domains.push(shapeDomain(stub, false));
          notes.push(
            `${stub.name}: DNS records unavailable (${
              err instanceof ResendError ? err.body.slice(0, 80) : "error"
            })`,
          );
        }
      }

      /* The account is LABELLED for a domain but the key is what decides what
         it can see, so the emails are attributed to the domain Resend named
         rather than to the label somebody typed. */
      const domain = domains[0]?.name ?? account.label;
      let emails: EmailRow[] = [];
      let walk = { pages: 0, oldest: null as string | null, truncated: false };
      try {
        const walked = await walkEmails(key, domain, since);
        emails = walked.rows;
        walk = { pages: walked.pages, oldest: walked.oldest, truncated: walked.truncated };
        if (walked.truncated)
          notes.push(
            `the email walk stopped at ${MAX_PAGES} pages, so this domain's ` +
              "counts are floors",
          );
      } catch (err) {
        /*
          A DOMAIN THAT ANSWERS AND A LIST THAT REFUSES ARE DIFFERENT FACTS.
          The domain keeps its verification and its records; the send figures
          are absent rather than zero, and the note says which happened.
        */
        notes.push(
          `${domain}: the email list was refused (${
            err instanceof ResendError ? err.body.slice(0, 90) : "error"
          }), so nothing about volume is reported for it`,
        );
      }

      out.accounts.push({
        id: account.id,
        label: account.label,
        ok: true,
        domains,
        emails,
        walk,
        notes,
      });
      for (const n of notes) out.warnings.push(`${account.label}: ${n}`);
    } catch (err) {
      const error =
        err instanceof ResendError
          ? SEND_ONLY.test(err.body)
            ? sendOnlyMessage(account.label)
            : `HTTP ${err.status} ${err.body}`
          : err instanceof Error && err.name === "TimeoutError"
            ? "Resend did not answer within 30 seconds."
            : `Could not reach Resend (${err instanceof Error ? err.name : "Error"}).`;
      out.accounts.push(empty(account, error));
      out.warnings.push(`${account.label}: ${error}`);
    }
  }

  return out;
}

/* ==========================================================================
   THE LIVE HALF — "sent by apps", in the mailbox app
   ==========================================================================

   THE COLLECTOR ABOVE THROWS AWAY THE RECIPIENT AND THE SUBJECT. It has to:
   what it reads goes into `resend_emails`, and that table has no column for
   either. This half throws away nothing and stores nothing — the rows are read
   inside one HTTP request, written to one response, and forgotten. `routes/
   mailbox.ts` is the only caller and its header carries the same rule.

   It is the same stance change `providers/gmail.ts` documents at its own
   banner, and for the same reason: a page that shows you what a product sent
   somebody has to show you what it said. A password-reset email whose subject
   is redacted is a row that cannot answer the question it was opened to
   answer.

   BOTH FUNCTIONS GO THROUGH THE SAME `get` as everything else in this file, so
   "nothing here sends" is still a property of the code: `method: "GET"` is
   written once, there is still no body parameter, and `POST /emails` is still
   not reachable from this module by any argument.

   THAT SENTENCE IS STILL TRUE AND IT IS NOW NARROWER, so it is written down
   here rather than left to be discovered. Since the nurture area landed there
   IS a `POST /emails` on this box, in
   `integrations/nurture/resend-send.ts` — one function, called from exactly one
   place, behind the outbox's approve. It deliberately does not live in this
   file, for the reason `integrations/mailflow/gmail-send.ts` does not live in
   providers/gmail.ts: adding a send here would quietly falsify a paragraph
   other people have read and believed. This module is still every read and no
   write; the send is next door, where the queue that is the only thing allowed
   to call it is.
*/

/**
 * One key's sending domains, with the status Resend itself gives each.
 *
 * A READ, through the same `get` as everything else — the identity checker in
 * `integrations/nurture/identities.ts` needs to know whether a domain is
 * verified before it lets a message claim to be from it, and asking Resend is
 * the only honest way to answer that. `collect()` above already reads this
 * endpoint but pays for a full email walk on the way past, which is far too
 * much for a question asked when somebody presses a button.
 *
 * The status is Resend's own word and is never reduced to a boolean here:
 * "pending" is a domain whose DNS has not propagated, "failed" is a domain that
 * will bounce, and a caller shown one flag for both would fix the wrong thing.
 */
export async function domains(
  accountId: number,
  reader = "resend_domains",
): Promise<DomainRow[]> {
  const { key } = keyOf(accountId, reader);
  const doc = await get<{ data?: ApiDomain[] }>("/domains", key);
  return (doc.data ?? []).filter((d) => d.name).map((d) => shapeDomain(d, false));
}

/** One row of the sent list, as Resend gives it. `to` is a list because Resend
 *  sends one back, and joining it here would lose the difference between two
 *  recipients and one address with a comma in it. */
export type SentRow = {
  id: string;
  domain: string;
  /** ISO instant, normalised the same way the collector normalises it. */
  at: string;
  from: string;
  to: string[];
  subject: string;
  lastEvent: string | null;
};

/** One sent email, whole. The same shape as a Gmail message where it can be,
 *  so one reader renders both. */
export type SentEmail = SentRow & {
  cc: string[];
  bcc: string[];
  /** The RFC 5322 Message-ID Resend stamped, when it reports one. */
  messageId: string | null;
  text: string;
  /** The HTML AS THE PRODUCT SENT IT. Unsanitised, exactly like the Gmail
   *  side: `routes/mailbox.ts` is the only caller and cleans it before it
   *  reaches a wire. It is our own template rather than a stranger's markup,
   *  which is a reason to trust it and not a reason to skip the step — the
   *  moment there are two paths into the reader, one of them is the one
   *  somebody forgets. */
  html: string | null;
};

/** The one account of the `resend` plugin whose key can answer for a domain,
 *  with its key still inside this module. A route never sees a value: that is
 *  the door `accounts.ts` describes and this side of it is where it stays. */
function keyOf(accountId: number, reader: string): { account: Account; key: string } {
  const { ready } = accounts.credentialed("resend", ["key"], reader);
  const pair = ready.find((p) => p.account.id === accountId);
  if (!pair)
    throw new ResendError(
      404,
      `No connected Resend key for account ${accountId}.`,
    );
  return { account: pair.account, key: (pair.values.key ?? "").trim() };
}

const at = (v: string | undefined): string => (v ?? "").replace(" ", "T");

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : [];

/**
 * A page of what one domain has sent, newest first.
 *
 * PAGED WITH `after=<id>` for the reason the collector's walk is: an offset
 * over a list growing at the head re-reads or skips rows as mail is sent
 * mid-read, and a cursor cannot. The caller hands back the last id it saw.
 *
 * A SENDING-ONLY KEY IS A STATE AND NOT AN ERROR. One of the keys on this
 * account is restricted to sending and answers 401 on every read; the door
 * refuses such a key at paste time, so this is here for the key that gets
 * restricted afterwards. It comes back as `restricted` with rows of nothing,
 * because "this domain can send and cannot be read" is a different sentence
 * from "this domain sent nothing".
 */
export async function sentList(
  accountId: number,
  opts: { limit: number; after?: string },
  reader = "mailbox_sent",
): Promise<{ domain: string; rows: SentRow[]; restricted: boolean; hasMore: boolean }> {
  const { account, key } = keyOf(accountId, reader);
  const domain = account.label;
  const path = `/emails?limit=${opts.limit}${opts.after ? `&after=${encodeURIComponent(opts.after)}` : ""}`;
  try {
    const doc = await get<{
      data?: {
        id?: string;
        created_at?: string;
        from?: string;
        to?: unknown;
        subject?: string;
        last_event?: string;
      }[];
      has_more?: boolean;
    }>(path, key);
    const rows: SentRow[] = (doc.data ?? [])
      .filter((r) => r.id)
      .map((r) => ({
        id: r.id!,
        domain,
        at: at(r.created_at),
        from: r.from ?? "",
        to: list(r.to),
        subject: r.subject ?? "",
        lastEvent: r.last_event ?? null,
      }));
    return { domain, rows, restricted: false, hasMore: !!doc.has_more };
  } catch (err) {
    if (err instanceof ResendError && err.status === 401 && SEND_ONLY.test(err.body))
      return { domain, rows: [], restricted: true, hasMore: false };
    throw err;
  }
}

/**
 * One sent email, body and all.
 *
 * `GET /emails/{id}` is the only endpoint on this API that returns what was
 * actually written, and it is why "sent by apps" can be a reader rather than a
 * table of subjects. Resend keeps these for a while and not forever, so a 404
 * here is a retention answer rather than a wrong id, and the route says so.
 *
 * NO ATTACHMENT BYTES EXIST ON THIS SIDE. Resend does not return them and does
 * not resolve `cid:` references either, so a template's own logo arrives as a
 * reference to something nobody can fetch. The sanitiser downstream hides
 * those rather than leaving a broken-image glyph, which would say "this mail
 * is damaged" about a mail that is fine.
 */
export async function sentEmail(
  accountId: number,
  id: string,
  reader = "mailbox_sent_one",
): Promise<{ email: SentEmail | null; restricted: boolean }> {
  const { account, key } = keyOf(accountId, reader);
  /* The id becomes a path segment, so it is checked as an id rather than
     escaped and hoped for. Resend's are UUIDs; this is that shape without
     insisting on the version nibble. */
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/.test(id))
    throw new ResendError(400, "That is not a Resend email id.");

  try {
    const doc = await get<{
      id?: string;
      created_at?: string;
      from?: string;
      to?: unknown;
      cc?: unknown;
      bcc?: unknown;
      subject?: string;
      html?: string;
      text?: string;
      last_event?: string;
      message_id?: string;
    }>(`/emails/${id}`, key);
    return {
      restricted: false,
      email: {
        id: doc.id ?? id,
        domain: account.label,
        at: at(doc.created_at),
        from: doc.from ?? "",
        to: list(doc.to),
        cc: list(doc.cc),
        bcc: list(doc.bcc),
        subject: doc.subject ?? "",
        lastEvent: doc.last_event ?? null,
        messageId: doc.message_id ?? null,
        text: doc.text ?? "",
        html: doc.html ? doc.html : null,
      },
    };
  } catch (err) {
    if (err instanceof ResendError && err.status === 401 && SEND_ONLY.test(err.body))
      return { email: null, restricted: true };
    throw err;
  }
}

export type { Account };
