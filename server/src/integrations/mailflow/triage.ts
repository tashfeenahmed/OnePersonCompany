/**
 * INBOX TRIAGE — which conversations in the inbox need the owner today.
 *
 * One Gmail account carries every business this portfolio has plus a personal
 * life, interleaved by arrival time, which is the one ordering that correlates
 * with nothing. This module re-orders it by what the mail IS: a stranded
 * customer outranks this morning's newsletter whichever domain either arrived
 * at, and the venture tag says which business it concerns rather than which
 * folder it fell into.
 *
 * WHAT IS MEASURED AND WHAT IS A READING. Everything on a triage row except
 * the category is a fact: the thread id, the time, the sender, whether the
 * recipients contain a venture's own host. THE CATEGORY IS NOT. It is a
 * model's reading of a subject line and Gmail's own snippet — a hundred and
 * eighty characters of a conversation that may run to forty messages — and it
 * is shown WITH the model's one-line reason for exactly that reason: a
 * category you can argue with is a tool, and a category handed down without a
 * reason is an oracle nobody can correct.
 *
 * A THREAD THE MODEL DID NOT SEE IS NOT "noise". This is the rule the whole
 * file is arranged around, because the failure it prevents is the expensive
 * one: a pass that ran out of budget, a provider that was down, a thread that
 * arrived four minutes ago — each of those produces a thread with no score,
 * and a page that folded those into the bottom group would be hiding mail
 * BECAUSE it had not been read. They come back in their own `unscored` group,
 * counted, with the reason the pass gives.
 *
 * WHAT IS STORED, AND IT CHANGED — SAY IT PLAINLY. This file used to end this
 * paragraph with "the page fetches the mail itself live on every read", and
 * that sentence is no longer true. SUBJECT LINES, SENDER ADDRESSES AND
 * GMAIL'S OWN SNIPPETS ARE NOW KEPT ON THIS BOX, in `mailflow_triage_threads`
 * (migration 123), which is the row the page draws. The judgement table beside
 * it is unchanged and still has nowhere to put a subject; the two are separate
 * tables so that the older claim stays exactly as true as it was.
 *
 * WHY THE RULE MOVED, WHICH IS WORKDASH'S ARGUMENT WITH DIFFERENT NUMBERS.
 * Workdash moved its triage cache to disk because pm2 restarted the process
 * several times a day and every night's scores were gone by morning; what
 * lands there is "a score and a line per thread, never the mail". Here the
 * pressure was the read rather than the restart: with nothing mail-shaped
 * stored, GET /api/triage had to buy the mail again on every open — one
 * `threads.list` plus a `threads.get` PER ROW, fifty rows, ~510 quota units,
 * about four and a half seconds — to redraw a list that had not changed since
 * the pass half an hour earlier. The privacy claim was real and small; the
 * price was paid every single time the page was opened. So the cache holds the
 * row now, and Workdash's line has to be corrected for this box: what lands is
 * a score, a line per thread, AND the subject, sender and snippet the list
 * shows.
 *
 * WHAT STILL NEVER LANDS, AND THIS HALF IS UNCHANGED: A BODY. There is no
 * `readThread` call in this file. The hydration asks Gmail for
 * `format=metadata`, so a body is not fetched at all, let alone kept — the
 * snippet is the ~180 characters Gmail itself computes and hands over in the
 * listing. Recipient ADDRESSES are not kept either, only their domains, which
 * is all the venture match reads. And what does land lands in the same SQLite
 * file as the judgement table — the same 0600 data directory as the vault and
 * the Google refresh token that could fetch every word of it again.
 *
 * THE PASS IS INCREMENTAL, WHICH IS WHAT MAKES THE CACHE AFFORDABLE. See
 * `planPass`: the listing is ten quota units for the whole window and carries
 * each thread's history id, so the pass pays the ten-unit `threads.get` only
 * for threads that are new or have MOVED. A quiet half hour costs ten units
 * instead of two thousand, and an unchanged thread is neither re-read nor
 * re-scored.
 *
 * WHERE THE MAIL GOES. Subjects and snippets travel to one place: the model
 * provider the owner has chosen under Integrations → Models. On this install
 * that may be a local box or a cloud endpoint, and it is the same trust
 * boundary the chat already is — but it is worth saying out loud, because it
 * is the only outbound path in this area that carries anyone else's words.
 *
 * WHY THIS IS NOT A REGISTERED COLLECTOR. The manifest's `collectors` map is
 * keyed by PLUGIN id and merged over the built-in ones, so an entry under
 * `gmail` here would REPLACE `collector.ts`'s Gmail collector and take the
 * mail statistics down with it. The pass therefore runs on this area's own
 * timer (see manifest.ts `onStart`) at the same half-hour cadence, and its
 * ledger is `mailflow_triage_runs` rather than the plugin runs table.
 */
import { db, now, resendDomains, ventureRows, type VentureRow } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { hostOf, hostMatch } from "../../shared/host.ts";
import { NoProviderError, complete } from "../../models/provider.ts";
import {
  GmailError,
  NoMailbox,
  hydrateThreads,
  listThreadStubs,
  open,
  type Session,
  type ThreadRow,
  type ThreadStub,
} from "../../providers/gmail.ts";

/* ------------------------------------------------------------------ knobs */

/**
 * THE WINDOW, IN DAYS, AND IT IS THREE.
 *
 * "What needs me today" is a question about the last few days, not about the
 * month: a thread nobody answered in a fortnight is a different problem
 * (that one is `/api/mail`'s waiting queue, which measures exactly it) and
 * putting it on this list every morning is how the list stops being read.
 * Three days survives a weekend.
 */
export const WINDOW_DAYS = 3;
export const MAX_WINDOW_DAYS = 14;

/**
 * THE CAP, AND IT IS A QUOTA RATHER THAN A TASTE.
 *
 * The listing is ten Gmail quota units for all 200 of them; each thread the
 * pass has to HYDRATE is ten more. So the arithmetic now depends entirely on
 * how much moved:
 *
 *     a cold cache      200 gets    ~2,010 units   ~14s through the rate gate
 *     a normal half hour  0-15 gets    10-160 units   under two seconds
 *     nothing moved       0 gets           10 units   one request
 *
 * The first line is the one that used to run on every page load, and it is
 * why the READ no longer talks to Gmail at all: it reads the cache these
 * passes fill. READ_MAX_DEFAULT is now how many cached rows a page draws,
 * which costs a SELECT.
 */
export const SCAN_MAX = 200;
export const READ_MAX_DEFAULT = 50;

/**
 * HOW LONG AFTER BOOT THE FIRST PASS RUNS, AND WHY THERE IS ONE AT ALL.
 *
 * This used to be "no pass at boot", on the grounds that the dev server
 * restarts on every saved file and a boot pass would spend fourteen seconds of
 * Gmail quota each time. Incremental passes take that argument away: a restart
 * now costs one `threads.list` — ten units — plus whatever genuinely arrived
 * while the process was down, which is what the page needs anyway. Twenty
 * seconds is late enough that nothing competes with the server actually coming
 * up, and early enough that a mailbox is current before anybody has clicked
 * through to it.
 */
const BOOT_DELAY_MS = 20_000;

/** How long a thread that has left the window is kept before its cached row is
 *  deleted. Longer than MAX_WINDOW_DAYS on purpose: a row that ages out of a
 *  three-day window is still inside a fourteen-day one, and re-buying it
 *  because somebody widened `?days=` is the cost this table exists to avoid. */
const KEEP_GONE_DAYS = 30;

/** How many threads go to the model in one completion. Ten keeps a prompt
 *  under a couple of thousand tokens and a failure to a tenth of a pass; one
 *  at a time would be two hundred round trips for one morning's inbox. */
const BATCH = 10;

/** Snippets are truncated before they are sent, because Gmail's own is
 *  already a summary and the model is being asked to sort, not to read. */
const SNIPPET_CHARS = 220;

const HALF_HOUR_MS = 30 * 60_000;

export const SCORES = ["needs_reply", "waiting_on_them", "fyi", "noise"] as const;
export type Score = (typeof SCORES)[number];
export const URGENCIES = ["high", "normal", "low"] as const;
export type Urgency = (typeof URGENCIES)[number];

/* ------------------------------------------------------------------- rows */

export type TriageRow = {
  account_id: number;
  thread_id: string;
  score: string | null;
  reason: string | null;
  urgency: string | null;
  venture: string | null;
  venture_by: string | null;
  at_ms: number | null;
  scored_at: string | null;
  model: string | null;
  snoozed_until: string | null;
  done_at: string | null;
};

export type TriageRunRow = {
  account_id: number;
  ran_at: string;
  ok: number;
  threads: number;
  scored: number;
  note: string | null;
  error: string | null;
};

export function storedFor(accountId: number): Map<string, TriageRow> {
  const rows = db
    .prepare("SELECT * FROM mailflow_triage WHERE account_id = ?")
    .all(accountId) as unknown as TriageRow[];
  return new Map(rows.map((r) => [r.thread_id, r]));
}

/**
 * THE OWNER'S TWO VERBS, written the one way.
 *
 * AN OMITTED FIELD KEEPS WHAT IS STORED, decided in SQL against the
 * conflicting row. Three surfaces wrote these columns and each named BOTH in
 * its upsert — which clears the one the caller did not mean — so each had to
 * re-read the row first. Nothing now happens between the read and the write.
 *
 * The insert leaves `score` NULL: a thread acted on before any pass read it
 * carries a verb and no opinion, and inventing one to fill a column would be
 * this function answering a question only the model may answer.
 */
export function markThread(
  accountId: number,
  threadId: string,
  patch: { snoozedUntil?: string | null; doneAt?: string | null },
): void {
  db.prepare(
    `INSERT INTO mailflow_triage
       (account_id, thread_id, score, reason, urgency, venture, venture_by, at_ms, scored_at, model, snoozed_until, done_at)
     VALUES (@account, @thread, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, @snoozed, @done)
     ON CONFLICT(account_id, thread_id) DO UPDATE SET
       snoozed_until = CASE WHEN @setSnoozed THEN excluded.snoozed_until ELSE mailflow_triage.snoozed_until END,
       done_at       = CASE WHEN @setDone    THEN excluded.done_at       ELSE mailflow_triage.done_at       END`,
  ).run({
    account: accountId,
    thread: threadId,
    snoozed: patch.snoozedUntil ?? null,
    done: patch.doneAt ?? null,
    /* `undefined` is "leave it", `null` is "clear it". They are different
       instructions and the CASE above is where they part. */
    setSnoozed: patch.snoozedUntil !== undefined ? 1 : 0,
    setDone: patch.doneAt !== undefined ? 1 : 0,
  });
}

export function lastRun(accountId: number): TriageRunRow | undefined {
  return db.prepare("SELECT * FROM mailflow_triage_runs WHERE account_id = ?").get(accountId) as
    | TriageRunRow
    | undefined;
}

/* ------------------------------------------------------------- the row cache */

/** One cached triage row, as migration 123 stores it. Mail-shaped, and the
 *  header says so. */
export type CachedThread = {
  account_id: number;
  thread_id: string;
  subject: string;
  from_address: string;
  from_name: string;
  snippet: string;
  at_ms: number | null;
  messages: number;
  unread: number;
  /** JSON array of hosts — see `domainsOf`. Never addresses. */
  domains: string;
  history_id: string | null;
  seen_at: string;
  gone_at: string | null;
};

/** Every cached row for a mailbox, gone ones included — the pass needs those
 *  to notice a thread coming BACK, and the read filters them out itself. */
export function cachedFor(accountId: number): Map<string, CachedThread> {
  const rows = db
    .prepare("SELECT * FROM mailflow_triage_threads WHERE account_id = ?")
    .all(accountId) as unknown as CachedThread[];
  return new Map(rows.map((r) => [r.thread_id, r]));
}

/**
 * The rows a page draws: one mailbox, still in the window, newest first.
 *
 * `days` is applied HERE rather than at the pass, because the pass fills one
 * cache and different readers ask different questions of it — a page asking
 * for a day and a page asking for a fortnight both read rows the same pass
 * wrote.
 */
export function cachedPage(
  accountId: number,
  opts: { days: number; max: number },
): CachedThread[] {
  const since = Date.now() - opts.days * 86_400_000;
  return db
    .prepare(
      `SELECT * FROM mailflow_triage_threads
        WHERE account_id = ? AND gone_at IS NULL AND (at_ms IS NULL OR at_ms >= ?)
        ORDER BY at_ms DESC
        LIMIT ?`,
    )
    .all(accountId, since, opts.max) as unknown as CachedThread[];
}

/** How many rows the cache holds for a mailbox inside a window, ignoring any
 *  page limit — the "of 84" a page's "showing 50" is a share of. */
export function cachedCount(accountId: number, days: number): number {
  const since = Date.now() - days * 86_400_000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mailflow_triage_threads
        WHERE account_id = ? AND gone_at IS NULL AND (at_ms IS NULL OR at_ms >= ?)`,
    )
    .get(accountId, since) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** How many cached rows in the window carry no category yet — the number the
 *  page turns into "the model has not read these". Counted over the whole
 *  cache rather than the drawn page, so it does not shrink because a reader
 *  asked for fewer rows. */
export function unscoredCount(accountId: number, days: number): number {
  const since = Date.now() - days * 86_400_000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mailflow_triage_threads t
         LEFT JOIN mailflow_triage j
           ON j.account_id = t.account_id AND j.thread_id = t.thread_id
        WHERE t.account_id = ? AND t.gone_at IS NULL
          AND (t.at_ms IS NULL OR t.at_ms >= ?)
          AND j.score IS NULL`,
    )
    .get(accountId, since) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** The hosts a cached row's addresses belonged to. A row written before this
 *  column meant anything, or one whose JSON is somehow unreadable, answers
 *  "no domains" — which costs a venture tag and never a wrong one. */
export function domainsOf(row: CachedThread): string[] {
  try {
    const parsed: unknown = JSON.parse(row.domains);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A cached row in the shape the scorer and the route already speak.
 *
 * `to`, `labels` and `recipients` come back EMPTY, because those three are the
 * fields this box deliberately does not keep. Nothing that reads a cached row
 * uses them: the prompt wants a subject, a sender and a snippet, and the
 * venture match reads `domainsOf` instead.
 */
export function rowOf(row: CachedThread): ThreadRow {
  return {
    id: row.thread_id,
    subject: row.subject,
    from: row.from_address,
    fromName: row.from_name,
    to: "",
    at: row.at_ms,
    snippet: row.snippet,
    unread: row.unread === 1,
    labels: [],
    messages: row.messages,
    recipients: [],
  };
}

/* --------------------------------------------------- the incremental decision */

/** What a pass has to do about one thread in the listing. */
export type Decision = "new" | "changed" | "unchanged";

/**
 * WHETHER THIS THREAD IS WORTH TEN QUOTA UNITS.
 *
 * The history id is Gmail's own answer to "has anything about this
 * conversation moved", it arrives free with the listing, and where both sides
 * have one it decides alone. Where Gmail omitted it the snippet stands in: it
 * is the newest message's opening, so a reply changes it. Both wrong in the
 * same direction — an edge that reads `unchanged` costs a stale row for half
 * an hour, and one that reads `changed` costs ten units.
 *
 * A ROW THAT HAD GONE AND CAME BACK IS ALWAYS `changed`. Its cached copy is by
 * definition older than the window it left, and a thread returning to the
 * inbox is exactly the case where something happened.
 */
export function decide(stub: ThreadStub, cached: CachedThread | undefined): Decision {
  if (!cached) return "new";
  if (cached.gone_at) return "changed";
  if (stub.historyId && cached.history_id)
    return stub.historyId === cached.history_id ? "unchanged" : "changed";
  return stub.snippet === cached.snippet ? "unchanged" : "changed";
}

export type Plan = {
  /** Threads to buy a `threads.get` for. */
  fetch: ThreadStub[];
  /** Threads already cached and unmoved: no fetch, no re-score. */
  unchanged: string[];
  /** Cached threads the listing no longer carries. */
  gone: string[];
};

/**
 * ONE PASS'S SHOPPING LIST.
 *
 * `truncated` is the guard that keeps `gone` honest. The listing is capped, so
 * a mailbox with more threads in the window than the cap returns a PAGE rather
 * than the window — and every cached thread past the cut would then look
 * absent. When the listing came back full, nothing is marked gone: a page that
 * hides mail because a limit was reached is the failure this area is built
 * around.
 */
export function planPass(
  stubs: ThreadStub[],
  cached: Map<string, CachedThread>,
  opts: { truncated: boolean } = { truncated: false },
): Plan {
  const plan: Plan = { fetch: [], unchanged: [], gone: [] };
  const seen = new Set<string>();
  for (const stub of stubs) {
    seen.add(stub.id);
    if (decide(stub, cached.get(stub.id)) === "unchanged") plan.unchanged.push(stub.id);
    else plan.fetch.push(stub);
  }
  if (!opts.truncated)
    for (const [id, row] of cached) if (!seen.has(id) && !row.gone_at) plan.gone.push(id);
  return plan;
}

/* ------------------------------------------------------- venture matching */

type VentureKey = { id: string; name: string; slug: string; host: string | null };

export function ventureKeys(): VentureKey[] {
  return ventureRows().map((v: VentureRow) => ({
    id: v.id,
    name: v.name,
    slug: v.slug,
    host: hostOf(v.host ?? v.website),
  }));
}

const domainOf = (address: string): string | null => {
  const at = address.lastIndexOf("@");
  return at < 0 ? null : hostOf(address.slice(at + 1));
};

/**
 * WHICH VENTURE A THREAD IS ABOUT, decided from the addresses first.
 *
 * A domain match is a FACT — this mail was addressed to, or came from, a host
 * a venture's record names as its own — so it beats anything the model has to
 * say. The model is only consulted for the threads no address settles, and its
 * answer is stored with `venture_by = 'model'` so a reader can tell a match
 * from a guess.
 *
 * THE HOST RULE IS `shared/host.ts`'s AND NOT THIS FILE'S. A subdomain counts
 * (`mail.example.com` is `example.com`'s) and it counts in that direction
 * only; a substring never does, because `notexample.com` is somebody else. Six
 * areas used to answer this question six ways and two of them let a subdomain
 * swallow its parent, which files two businesses under one name.
 *
 * TWO AUTHORITY LISTS, ONE QUESTION — see `threadHosts` below for why this
 * takes both. The Mail page used to match Resend sending-domain chips and this
 * function matched `ventures.host`, so a venture with a host and no Resend key
 * was attributed here and invisible there, and the counts on the two pages
 * disagreed with nothing to say which was wrong.
 */
export function ventureByHost(thread: ThreadRow, keys: VentureKey[]): string | null {
  return ventureForThread(thread.recipients, thread.from, hostsOfKeys(keys))?.ventureId ?? null;
}

const hostsOfKeys = (keys: VentureKey[]): ThreadHost[] =>
  keys.filter((k) => k.host).map((k) => ({ host: k.host!, ventureId: k.id, source: "venture" as const }));

/** One host this portfolio answers at, and whose it is. */
export type ThreadHost = { host: string; ventureId: string | null; source: "venture" | "resend" };

/**
 * EVERY HOST THIS BOX WILL ATTRIBUTE A THREAD TO, from both lists at once.
 *
 * A venture's own `host` is the first list. The Resend sending domains are the
 * second, and they belong here even though Resend is a SENDING service and
 * this is a question about RECEIVING: a domain is on this box because a
 * venture sends from it, and the same domain is what its customers reply to.
 * There is no separate list of "domains whose mail forwards here" anywhere,
 * and hand-keeping one beside the page is the thing this replaces.
 *
 * Ventures are listed FIRST so that a domain which is both — the ordinary case
 * — is attributed to the venture that owns it rather than to the key that
 * sends from it.
 */
export function threadHosts(): ThreadHost[] {
  const out: ThreadHost[] = [];
  for (const k of ventureKeys()) if (k.host) out.push({ host: k.host, ventureId: k.id, source: "venture" });
  const known = new Set(out.map((h) => h.host));
  /* THE ACCOUNT ROWS AS WELL AS THE COLLECTED ONES, because a key added this
     morning has an account row and no collected row until the collector next
     runs, and a domain that exists is a domain mail arrives at. The Resend door
     names an account after the domain its key can see, so the label is a host
     wherever it is one; a renamed account contributes nothing rather than a
     wrong host. */
  const names = [
    ...resendDomains().map((d) => d.name),
    ...accounts.list("resend").filter((a) => a.connected).map((a) => a.label),
  ];
  for (const name of names) {
    const host = hostOf(name);
    if (!host || known.has(host)) continue;
    known.add(host);
    /* A sending domain no venture claims is still one of OURS — it just has
       nobody's name on it yet. `ventureId: null` is that state exactly, and it
       is what lets the mailbox filter offer the chip while the triage tag stays
       honestly empty. */
    out.push({ host, ventureId: ventureForHostList(host, out), source: "resend" });
  }
  return out;
}

const ventureForHostList = (host: string, hosts: ThreadHost[]): string | null =>
  hosts.find((h) => h.ventureId && hostMatch(h.host, host))?.ventureId ?? null;

/**
 * THE ONE ANSWER TO "WHICH VENTURE IS THIS THREAD ABOUT", for both surfaces.
 *
 * THE LOOP IS AUTHORITY-MAJOR, AND THAT ORDER IS THE WHOLE FUNCTION. A
 * forwarded message carries the mailbox's own Gmail address on top of the
 * venture address it was really sent to, so walking the RECIPIENTS in header
 * order and taking the first one we recognise would attribute practically every
 * thread to the mailbox. Walking the authority list instead means a venture
 * host anywhere in the thread beats the mailbox address everywhere in it, and
 * the mailbox is left to the caller as the fallback it is.
 *
 * NULL IS "IT IS NONE OF OURS" and is a real answer rather than a failure: a
 * mailing list, a Bcc, a thread that reached the account some other way.
 */
export function ventureForThread(
  recipients: readonly string[],
  from: string | null,
  hosts: ThreadHost[] = threadHosts(),
): ThreadHost | null {
  return ventureForDomains(threadDomains(recipients, from), hosts);
}

/**
 * THE DOMAINS OF A THREAD'S ADDRESSES, WHICH IS ALL THE MATCH EVER READS.
 *
 * This is the function that lets the cache store `["acme.ie"]` where the
 * thread carried `sarah@acme.ie`: the answer above never looks at a local
 * part, so keeping one would be storing a person to answer a question about a
 * business.
 */
export function threadDomains(recipients: readonly string[], from: string | null): string[] {
  const seen = new Set<string>();
  for (const r of recipients) {
    const d = domainOf(r);
    if (d) seen.add(d);
  }
  const f = from ? domainOf(from) : null;
  if (f) seen.add(f);
  return [...seen];
}

/** The authority-major loop itself. See `ventureForThread` for why the order
 *  is what it is. */
export function ventureForDomains(
  domains: readonly string[],
  hosts: ThreadHost[] = threadHosts(),
): ThreadHost | null {
  for (const h of hosts) for (const d of domains) if (hostMatch(h.host, d)) return h;
  return null;
}

/** `ventureByHost` for a cached row, which has domains rather than addresses.
 *  Same authority list, same answer. */
export function ventureByDomains(domains: readonly string[], keys: VentureKey[]): string | null {
  return ventureForDomains(domains, hostsOfKeys(keys))?.ventureId ?? null;
}

/* --------------------------------------------------------------- the model */

/**
 * THE PROMPT, and the two things it is built to prevent.
 *
 * It never asks for a summary, a draft or an action — only for a sort — so
 * there is nothing in the output that could be mistaken for the mail itself.
 * And it is told, in the system turn, that a snippet is all it gets: a model
 * that believes it has read the conversation will write "the customer says the
 * refund never arrived" from a hundred and eighty characters, and that
 * sentence would then be shown to somebody as if this box knew it.
 */
function systemTurn(keys: VentureKey[]): string {
  const list = keys.length
    ? keys.map((k) => `- ${k.slug}: ${k.name}${k.host ? ` (${k.host})` : ""}`).join("\n")
    : "(none — leave venture null on every item)";
  return [
    "You are sorting one person's inbox so he knows what to open first.",
    "",
    "You are given, per thread: a subject line, the sender, and GMAIL'S OWN",
    "SNIPPET — roughly 180 characters of the latest message. That is all you",
    "get. You have NOT read the conversation. Never write a reason that claims",
    "knowledge of anything beyond those three fields; where the snippet is",
    "ambiguous, say so in the reason and pick the safer category.",
    "",
    "Categories, exactly one per thread:",
    "  needs_reply      — a person is waiting on HIM. A question, a request, a",
    "                     customer with a problem, a deadline he must answer.",
    "  waiting_on_them  — a live conversation where the ball is with the other",
    "                     side. He has answered; nothing is owed today.",
    "  fyi              — real and worth knowing, but nobody is waiting: a",
    "                     receipt, a deploy notice, a report, an invoice paid.",
    "  noise            — marketing, newsletters, social notifications, cold",
    "                     outreach, anything he would never answer.",
    "",
    "urgency is high | normal | low and is judged INSIDE the category — an",
    "urgent newsletter is still noise.",
    "",
    "reason: ONE short sentence, under 120 characters, in your own words. It",
    "is shown to him beside the category, so it must justify the category.",
    "Never quote more than a few words of the mail.",
    "",
    "venture: the slug of the business the thread concerns, or null. Only pick",
    "one when the subject or sender makes it plain; null is a perfectly good",
    "answer and is better than a guess. The businesses are:",
    list,
    "",
    'Answer with ONLY a JSON array: [{"id":1,"score":"fyi","urgency":"low",',
    '"reason":"…","venture":null}, …] — one object per thread you were given,',
    "with the id you were given. No prose, no code fence.",
  ].join("\n");
}

function userTurn(batch: ThreadRow[]): string {
  return batch
    .map((t, i) => {
      const from = t.fromName ? `${t.fromName} <${t.from}>` : t.from;
      return [
        `#${i + 1}`,
        `from: ${from || "(no sender)"}`,
        `subject: ${t.subject || "(no subject)"}`,
        `snippet: ${(t.snippet || "").slice(0, SNIPPET_CHARS)}`,
        `messages: ${t.messages}${t.unread ? ", unread" : ""}`,
      ].join("\n");
    })
    .join("\n\n");
}

type Judgement = { score: Score; urgency: Urgency; reason: string; venture: string | null };

/** The model's answer, read defensively. A batch that comes back malformed
 *  leaves its threads UNSCORED — never defaulted to a category — which is the
 *  whole point of the unscored group.
 *
 *  Exported for the test rather than for a caller: this is the one function
 *  here whose input is written by a model, so it is the one worth pinning
 *  against fixtures — a fence and a stray sentence and a bad category are all
 *  things that have arrived from a free endpoint. */
export function parseBatch(text: string, size: number): Map<number, Judgement> {
  const out = new Map<number, Judgement>();
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = Number(o.id);
    if (!Number.isInteger(id) || id < 1 || id > size) continue;
    const score = String(o.score ?? "").trim() as Score;
    if (!(SCORES as readonly string[]).includes(score)) continue;
    const urgency = String(o.urgency ?? "normal").trim() as Urgency;
    const reason = String(o.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const venture =
      o.venture === null || o.venture === undefined ? null : String(o.venture).trim() || null;
    out.set(id, {
      score,
      urgency: (URGENCIES as readonly string[]).includes(urgency) ? urgency : "normal",
      reason: reason || "The model gave no reason.",
      venture,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- the pass */

export type ScanResult = {
  accountId: number;
  accountLabel: string;
  ok: boolean;
  /** Threads the listing returned inside the window. */
  threads: number;
  /** Threads this pass actually bought from Gmail, at ten quota units each.
   *  On a quiet half hour it is zero and the pass cost one request. */
  fetched: number;
  /** Threads the listing carried that had not moved since the last pass:
   *  neither re-read nor re-scored. */
  unchanged: number;
  /** Cached rows the listing no longer carries — archived, or simply aged out
   *  of the window. Marked, not deleted. */
  gone: number;
  /** Threads sent to the model this pass. The rest were already scored at the
   *  same last-message time and were not re-read — a score is invalidated by a
   *  REPLY, not by the clock. */
  scored: number;
  /** Threads the pass saw and could not score: a batch the model answered
   *  badly, or a provider that failed part-way. Never counted as noise. */
  unscored: number;
  model: string | null;
  note: string | null;
  error: string | null;
};

/**
 * One pass over one mailbox, and it is the only thing on this box that talks
 * to Gmail for the Triage page.
 *
 * FOUR STEPS. List the window (ten units, and it carries a history id per
 * thread). Decide what moved (`planPass`). Buy only that (`hydrateThreads`,
 * ten units each). Score whatever still has no category — including threads
 * that were cached but left unscored by a pass with no model behind it, which
 * cost nothing to pick up because their row is already here.
 *
 * FAILURE IS PER BATCH. A provider that dies on the third batch leaves the
 * first two scored and the rest unscored, and the run row says so — the same
 * trade every collector on this box makes per account. The one failure that is
 * fatal to a pass is Gmail refusing the listing, because then there is nothing
 * to sort. Note the order: THE CACHE IS WRITTEN BEFORE THE MODEL IS ASKED, so
 * a scorer that is down still leaves the page with today's mail on it, in the
 * unscored group where it belongs.
 */
export async function scanAccount(
  accountId: number,
  opts: { days?: number; max?: number } = {},
): Promise<ScanResult> {
  passes += 1;
  try {
    return await scanOnce(accountId, opts);
  } finally {
    passes -= 1;
  }
}

async function scanOnce(
  accountId: number,
  opts: { days?: number; max?: number },
): Promise<ScanResult> {
  const account = accounts.list("gmail").find((a) => a.id === accountId);
  const label = account?.label ?? `account ${accountId}`;
  const days = Math.min(Math.max(Math.trunc(opts.days ?? WINDOW_DAYS), 1), MAX_WINDOW_DAYS);
  const max = Math.min(Math.max(Math.trunc(opts.max ?? SCAN_MAX), 1), SCAN_MAX);

  const failed = (error: string): ScanResult => {
    writeRun(accountId, false, 0, 0, null, error);
    return {
      accountId, accountLabel: label, ok: false,
      threads: 0, fetched: 0, unchanged: 0, gone: 0, scored: 0, unscored: 0,
      model: null, note: null, error,
    };
  };
  const gmailError = (err: unknown, what: string): string =>
    err instanceof GmailError
      ? `Gmail refused ${what}: ${err.body}`
      : err instanceof Error
        ? err.message
        : String(err);

  let session: Session;
  try {
    session = await open("triage_scan", accountId);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }

  let stubs: ThreadStub[];
  try {
    stubs = (await listThreadStubs(session, { q: `in:inbox newer_than:${days}d`, max })).stubs;
  } catch (err) {
    return failed(gmailError(err, "the thread listing"));
  }

  const cached = cachedFor(accountId);
  /* A listing that came back FULL may have been cut short by the cap, and
     `planPass` must not read that as "the rest were archived". */
  const plan = planPass(stubs, cached, { truncated: stubs.length >= max });

  let fresh: ThreadRow[] = [];
  let dropped = 0;
  if (plan.fetch.length) {
    try {
      const got = await hydrateThreads(session, plan.fetch);
      fresh = got.threads;
      dropped = got.dropped;
    } catch (err) {
      /* The listing succeeded, so there IS something to sort — but the rows
         would be half of one window and half of the last, in an order neither
         of them agreed on. Fail the pass and keep yesterday's cache intact. */
      return failed(gmailError(err, "the thread reads"));
    }
  }

  writeCache(accountId, fresh, plan);

  const keys = ventureKeys();
  const bySlug = new Map(keys.map((k) => [k.slug.toLowerCase(), k.id]));
  const byName = new Map(keys.map((k) => [k.name.toLowerCase(), k.id]));
  const stored = storedFor(accountId);

  /* THE SCORING SET IS READ BACK OUT OF THE CACHE, not out of what Gmail just
     answered, and that is what lets a pass finish somebody else's work: a
     thread cached last week that no model was up to read is still unscored
     today, is still in the window, and costs nothing to hand over now. */
  const listed = new Set(stubs.map((s) => s.id));
  const current = [...cachedFor(accountId).values()].filter(
    (c) => listed.has(c.thread_id) && !c.gone_at,
  );

  /* Only what is new or has MOVED. A thread whose last-message time is
     unchanged since it was scored is the same conversation and does not need
     reading again; a reply changes `at`, which is what invalidates it. */
  const todo = current.filter((c) => {
    const row = stored.get(c.thread_id);
    return !row || row.score === null || row.at_ms !== c.at_ms;
  });

  const upsert = db.prepare(
    `INSERT INTO mailflow_triage
       (account_id, thread_id, score, reason, urgency, venture, venture_by, at_ms, scored_at, model, snoozed_until, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(account_id, thread_id) DO UPDATE SET
       score = excluded.score, reason = excluded.reason, urgency = excluded.urgency,
       venture = excluded.venture, venture_by = excluded.venture_by,
       at_ms = excluded.at_ms, scored_at = excluded.scored_at, model = excluded.model,
       /* A re-score does NOT clear the owner's verbs: a thread he marked done
          that then got a reply comes back on the list because the live
          listing carries it, and re-hiding it would be this pass deciding
          something he decided. done_at is cleared only when the thread MOVED,
          because a new message is new work. */
       done_at = CASE WHEN mailflow_triage.at_ms IS NOT excluded.at_ms THEN NULL ELSE mailflow_triage.done_at END,
       snoozed_until = CASE WHEN mailflow_triage.at_ms IS NOT excluded.at_ms THEN NULL ELSE mailflow_triage.snoozed_until END`,
  );

  let scored = 0;
  let unscored = 0;
  let model: string | null = null;
  let error: string | null = null;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let judgements = new Map<number, Judgement>();
    try {
      const reply = await complete([
        { role: "system", content: systemTurn(keys) },
        { role: "user", content: userTurn(batch.map(rowOf)) },
      ]);
      model = reply.model ?? model;
      judgements = parseBatch(reply.text, batch.length);
    } catch (err) {
      error =
        err instanceof NoProviderError
          ? "No model provider is live, so nothing could be scored. Choose one under Integrations → Models."
          : `The scorer failed part-way: ${err instanceof Error ? err.message : String(err)}`;
      unscored += todo.length - i;
      break;
    }

    const stamp = now();
    for (let j = 0; j < batch.length; j++) {
      const t = batch[j]!;
      const judged = judgements.get(j + 1);
      if (!judged) {
        unscored += 1;
        continue;
      }
      const hostVenture = ventureByDomains(domainsOf(t), keys);
      const guess = judged.venture
        ? (bySlug.get(judged.venture.toLowerCase()) ??
          byName.get(judged.venture.toLowerCase()) ??
          null)
        : null;
      const venture = hostVenture ?? guess;
      upsert.run(
        accountId,
        t.thread_id,
        judged.score,
        judged.reason,
        judged.urgency,
        venture,
        venture === null ? null : hostVenture ? "host" : "model",
        t.at_ms,
        stamp,
        model,
      );
      scored += 1;
    }
  }

  /* The note is what the page prints under the header, so it says where the
     quota went as well as what the model did. */
  const note =
    `${stubs.length} threads in ${days}d · ${plan.fetch.length} read from Gmail, ` +
    `${plan.unchanged.length} unchanged` +
    (plan.gone.length ? `, ${plan.gone.length} left the window` : "") +
    (dropped ? `, ${dropped} vanished mid-read` : "") +
    ` · ${scored} scored` +
    (unscored ? `, ${unscored} unscored` : "");
  writeRun(accountId, error === null, stubs.length, scored, note, error);

  return {
    accountId,
    accountLabel: label,
    ok: error === null,
    threads: stubs.length,
    fetched: plan.fetch.length,
    unchanged: plan.unchanged.length,
    gone: plan.gone.length,
    scored,
    unscored,
    model,
    note,
    error,
  };
}

/**
 * THE CACHE WRITE, AND IT IS ONE TRANSACTION.
 *
 * Fresh rows land whole; unchanged rows are only touched (`seen_at`, and
 * `gone_at` cleared, for a thread that came back); rows the listing dropped
 * are MARKED rather than deleted, because "not in the last three days" is not
 * "gone from Gmail" and the owner's Done and Snooze verbs next door are keyed
 * to threads this table describes. The delete is a separate, much older
 * cutoff — see KEEP_GONE_DAYS.
 */
function writeCache(accountId: number, fresh: ThreadRow[], plan: Plan): void {
  const stamp = now();
  const historyOf = new Map(plan.fetch.map((s) => [s.id, s.historyId]));

  const upsert = db.prepare(
    `INSERT INTO mailflow_triage_threads
       (account_id, thread_id, subject, from_address, from_name, snippet, at_ms,
        messages, unread, domains, history_id, seen_at, gone_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(account_id, thread_id) DO UPDATE SET
       subject = excluded.subject, from_address = excluded.from_address,
       from_name = excluded.from_name, snippet = excluded.snippet,
       at_ms = excluded.at_ms, messages = excluded.messages,
       unread = excluded.unread, domains = excluded.domains,
       history_id = excluded.history_id, seen_at = excluded.seen_at,
       gone_at = NULL`,
  );
  const touch = db.prepare(
    "UPDATE mailflow_triage_threads SET seen_at = ?, gone_at = NULL WHERE account_id = ? AND thread_id = ?",
  );
  const leave = db.prepare(
    "UPDATE mailflow_triage_threads SET gone_at = ? WHERE account_id = ? AND thread_id = ? AND gone_at IS NULL",
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const t of fresh)
      upsert.run(
        accountId,
        t.id,
        t.subject,
        t.from,
        t.fromName,
        t.snippet,
        t.at,
        t.messages,
        t.unread ? 1 : 0,
        JSON.stringify(threadDomains(t.recipients, t.from)),
        historyOf.get(t.id) ?? null,
        stamp,
      );
    for (const id of plan.unchanged) touch.run(stamp, accountId, id);
    for (const id of plan.gone) leave.run(stamp, accountId, id);
    db.prepare(
      "DELETE FROM mailflow_triage_threads WHERE account_id = ? AND gone_at IS NOT NULL AND gone_at < ?",
    ).run(accountId, new Date(Date.now() - KEEP_GONE_DAYS * 86_400_000).toISOString());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function writeRun(
  accountId: number,
  ok: boolean,
  threads: number,
  scored: number,
  note: string | null,
  error: string | null,
) {
  db.prepare(
    `INSERT INTO mailflow_triage_runs (account_id, ran_at, ok, threads, scored, note, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       ran_at = excluded.ran_at, ok = excluded.ok, threads = excluded.threads,
       scored = excluded.scored, note = excluded.note, error = excluded.error`,
  ).run(accountId, now(), ok ? 1 : 0, threads, scored, note, error);
}

/** Every connected Gmail account, scanned. Returns one result per mailbox so
 *  a second account failing cannot hide the first one's answer. */
export async function scanAll(opts: { days?: number; max?: number } = {}): Promise<ScanResult[]> {
  const out: ScanResult[] = [];
  for (const account of accounts.list("gmail")) {
    if (!account.connected) continue;
    out.push(await scanAccount(account.id, opts));
  }
  return out;
}

/* --------------------------------------------------------------- the timer */

let timer: ReturnType<typeof setInterval> | null = null;
let boot: ReturnType<typeof setTimeout> | null = null;

/** How many passes are in flight, over every mailbox and every caller — the
 *  timer, the owner's button, the read's own cold-start kick. The page polls
 *  while this is above zero and stops when it is not, which is the whole of
 *  "is it still reading?". */
let passes = 0;
let nextRunAtMs: number | null = null;

/** What the page needs to say "read 4 minutes ago · next in 26". `nextRunAt`
 *  is null before the timer has been started at all, which is the test process
 *  and the CLI rather than the server. */
export function passState(): { running: boolean; nextRunAt: string | null } {
  return {
    running: passes > 0,
    nextRunAt: nextRunAtMs === null ? null : new Date(nextRunAtMs).toISOString(),
  };
}

/**
 * A pass, started and not waited for.
 *
 * The one caller is the READ, and only when the cache for a mailbox is empty
 * and no pass has ever run — a box that has just been set up, where the
 * alternative is a permanently blank page waiting for a timer. It returns
 * immediately either way: the request that triggers it is answered from the
 * cache it is about to fill, and the page's poll picks the rows up.
 */
export function kickPass(accountId: number): void {
  if (passes > 0) return;
  void scanAccount(accountId).catch((err: unknown) => {
    console.error("[mailflow] triage kick failed:", err instanceof Error ? err.message : err);
  });
}

async function runPass(): Promise<void> {
  try {
    if (!accounts.list("gmail").some((a) => a.connected)) return;
    await scanAll();
  } catch (err) {
    /* A pass that throws must not take the process with it. The run row
       already carries anything worth reading. */
    console.error("[mailflow] triage pass failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * The half-hour pass, plus one shortly after boot.
 *
 * IT WRITES SCORES AND A CACHE OF THE ROWS, AND NOTHING ELSE. There is no
 * import of the outbox in this file and no path from here to a send — the only
 * thing a timer in this area can do is decide that a thread looks like it
 * needs a reply, which is a sentence on a page.
 *
 * IT DOES NOW RUN AT BOOT, TWENTY SECONDS IN, AND THAT REVERSES WHAT THIS
 * COMMENT USED TO SAY. The old rule — first pass half an hour in — existed
 * because a boot pass cost fourteen seconds of Gmail quota and this server
 * restarts on every saved file. An incremental pass costs one `threads.list`
 * plus whatever actually arrived while the process was down, so the reason is
 * gone, and the thing it was protecting has flipped: the page now DRAWS from
 * what a pass wrote, so a box that never passed is a box with a blank Triage
 * page. Twenty seconds keeps it off the critical path of coming up.
 *
 * It skips entirely when no Gmail account is connected.
 */
export function startTriageTimer() {
  if (timer) clearInterval(timer);
  if (boot) clearTimeout(boot);
  nextRunAtMs = Date.now() + BOOT_DELAY_MS;
  boot = setTimeout(() => {
    void (async () => {
      await runPass();
      nextRunAtMs = Date.now() + HALF_HOUR_MS;
      timer = setInterval(() => {
        nextRunAtMs = Date.now() + HALF_HOUR_MS;
        void runPass();
      }, HALF_HOUR_MS);
      timer.unref?.();
    })();
  }, BOOT_DELAY_MS);
  boot.unref?.();
}

export { NoMailbox };
