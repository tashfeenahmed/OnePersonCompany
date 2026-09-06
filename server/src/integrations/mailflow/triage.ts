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
 * NOTHING HERE READS OR STORES A BODY. The scan asks Gmail for
 * `format=metadata` and gets headers plus the snippet Gmail itself computes;
 * there is no `readThread` call in this file and no column in the table for a
 * subject, a sender or a snippet. What is stored is the judgement — a
 * category, a reason, an urgency, a venture guess — and the page fetches the
 * mail itself live on every read, exactly as routes/mailbox.ts does.
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
  listThreads,
  open,
  type Session,
  type ThreadRow,
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
 * Every row costs a `threads.get` at ten Gmail quota units — the listing
 * itself is ten for all of them — so 200 threads is about 2,000 units and
 * roughly fourteen seconds through providers/gmail.ts's rate gate. That is
 * fine for a background pass and much too slow for a page load, which is why
 * the READ below has its own, smaller default.
 */
export const SCAN_MAX = 200;
export const READ_MAX_DEFAULT = 50;

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

export function lastRun(accountId: number): TriageRunRow | undefined {
  return db.prepare("SELECT * FROM mailflow_triage_runs WHERE account_id = ?").get(accountId) as
    | TriageRunRow
    | undefined;
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
  const seen: string[] = [];
  for (const r of recipients) {
    const d = domainOf(r);
    if (d) seen.push(d);
  }
  const f = from ? domainOf(from) : null;
  if (f) seen.push(f);
  for (const h of hosts) for (const d of seen) if (hostMatch(h.host, d)) return h;
  return null;
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
 * One pass over one mailbox.
 *
 * FAILURE IS PER BATCH. A provider that dies on the third batch leaves the
 * first two scored and the rest unscored, and the run row says so — the same
 * trade every collector on this box makes per account. The one failure that is
 * fatal to a pass is Gmail refusing the listing, because then there is nothing
 * to sort.
 */
export async function scanAccount(
  accountId: number,
  opts: { days?: number; max?: number } = {},
): Promise<ScanResult> {
  const account = accounts.list("gmail").find((a) => a.id === accountId);
  const label = account?.label ?? `account ${accountId}`;
  const days = Math.min(Math.max(Math.trunc(opts.days ?? WINDOW_DAYS), 1), MAX_WINDOW_DAYS);
  const max = Math.min(Math.max(Math.trunc(opts.max ?? SCAN_MAX), 1), SCAN_MAX);

  let session: Session;
  try {
    session = await open("triage_scan", accountId);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    writeRun(accountId, false, 0, 0, null, error);
    return { accountId, accountLabel: label, ok: false, threads: 0, scored: 0, unscored: 0, model: null, note: null, error };
  }

  let threads: ThreadRow[];
  try {
    const page = await listThreads(session, { q: `in:inbox newer_than:${days}d`, max });
    threads = page.threads;
  } catch (err) {
    const error =
      err instanceof GmailError
        ? `Gmail refused the thread listing: ${err.body}`
        : err instanceof Error
          ? err.message
          : String(err);
    writeRun(accountId, false, 0, 0, null, error);
    return { accountId, accountLabel: label, ok: false, threads: 0, scored: 0, unscored: 0, model: null, note: null, error };
  }

  const keys = ventureKeys();
  const bySlug = new Map(keys.map((k) => [k.slug.toLowerCase(), k.id]));
  const byName = new Map(keys.map((k) => [k.name.toLowerCase(), k.id]));
  const stored = storedFor(accountId);

  /* Only what is new or has MOVED. A thread whose last-message time is
     unchanged since it was scored is the same conversation and does not need
     reading again; a reply changes `at`, which is what invalidates it. */
  const todo = threads.filter((t) => {
    const row = stored.get(t.id);
    return !row || row.score === null || row.at_ms !== (t.at ?? null);
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
        { role: "user", content: userTurn(batch) },
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
      const hostVenture = ventureByHost(t, keys);
      const guess = judged.venture
        ? (bySlug.get(judged.venture.toLowerCase()) ??
          byName.get(judged.venture.toLowerCase()) ??
          null)
        : null;
      const venture = hostVenture ?? guess;
      upsert.run(
        accountId,
        t.id,
        judged.score,
        judged.reason,
        judged.urgency,
        venture,
        venture === null ? null : hostVenture ? "host" : "model",
        t.at ?? null,
        stamp,
        model,
      );
      scored += 1;
    }
  }

  const note =
    `${threads.length} threads in ${days}d · ${scored} scored` +
    (todo.length < threads.length ? `, ${threads.length - todo.length} already current` : "") +
    (unscored ? `, ${unscored} unscored` : "");
  writeRun(accountId, error === null, threads.length, scored, note, error);

  return {
    accountId,
    accountLabel: label,
    ok: error === null,
    threads: threads.length,
    scored,
    unscored,
    model,
    note,
    error,
  };
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

/**
 * The half-hour pass.
 *
 * IT WRITES SCORES AND NOTHING ELSE. There is no import of the outbox in this
 * file and no path from here to a send — the only thing a timer in this area
 * can do is decide that a thread looks like it needs a reply, which is a
 * sentence on a page.
 *
 * It skips entirely when no Gmail account is connected, and it does not run at
 * boot: the first pass is half an hour in, so a restart during a working day
 * does not spend fourteen seconds of Gmail quota the moment the file is saved
 * — and this server restarts on every edit.
 */
export function startTriageTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void (async () => {
      try {
        if (!accounts.list("gmail").some((a) => a.connected)) return;
        await scanAll();
      } catch (err) {
        /* A pass that throws must not take the process with it. The run row
           already carries anything worth reading. */
        console.error("[mailflow] triage pass failed:", err instanceof Error ? err.message : err);
      }
    })();
  }, HALF_HOUR_MS);
  timer.unref?.();
}

export { NoMailbox };
