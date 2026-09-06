/**
 * PEOPLE — who the owner actually corresponds with, folded out of mail
 * headers, and how warm each of those correspondences is.
 *
 * WHAT THIS MEASURES, AND THE ONE THING IT REFUSES TO. Every figure here comes
 * from a From, To, Cc or Date header and from nothing else. No subject line,
 * snippet or body is requested from Gmail (see gmail-meta.ts, where
 * `format=metadata` makes that a property of the REQUEST) and none is stored.
 * So this can say "you two normally trade mail about every nine days and it
 * has been thirty-one"; it can never say what either of you said, why it went
 * quiet, or whether anybody meant anything by it. That sentence travels with
 * the document, because a reader who forgets it will read a cooling
 * correspondence as a falling-out.
 *
 * THE ONE PLACE A SUBJECT IS LOOKED AT is the venture link, and it is looked
 * at in memory and thrown away: if a message's subject mentions a venture's
 * host, that is a point towards linking the contact to that venture. The link
 * is a GUESS and is published as one — `link.derived: true` with the reason —
 * because a person at gmail.com who once wrote "re: planintel.ie" is not
 * thereby a PlanIntel contact.
 *
 * STALENESS IS MEASURED AGAINST EACH PERSON'S OWN RHYTHM, never against a
 * fixed number of days — the decision workdash's collect_contacts.py arrived
 * at over the same mailbox, and the reason it is worth copying: somebody you
 * mail daily is three times past their gap after three days, and somebody you
 * mail every August is not cold in September. So the temperature is
 * quiet ÷ cadence, where cadence is the MEDIAN gap between days on which any
 * mail passed either way. A median rather than a mean because one four-month
 * silence in an otherwise weekly correspondence drags a mean far enough that
 * the person can never be reported as cooling again.
 *
 * A CONTACT WITHOUT A RHYTHM HAS NO TEMPERATURE. Fewer than four measurable
 * gaps — five separate days of contact — and the answer is `null` with the
 * reason beside it, not "cold". `null` is "asked and not told" here exactly as
 * it is everywhere else on this box.
 *
 * STALE IS A SECOND, SIMPLER QUESTION, and it is the owner's own: no mail
 * either way for the number of days he typed into the settings. It is
 * deliberately not the same thing as "cold": cold is relative to the
 * relationship, stale is relative to the calendar, and a page that only had
 * one of them could not answer "who have I not spoken to since spring".
 */
import { configValue, db, finishRun, now, record, startRun, upsertPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { GmailError, open as openMailbox } from "../../providers/gmail.ts";
import {
  messageIds,
  metaMessages,
  profileAddress,
  type MetaMessage,
} from "./gmail-meta.ts";

/** The plugin id these settings hang off. Not a credential and not a
 *  collector's own service: the credential is Gmail's, and this id exists so
 *  the five decisions below live in the same checked settings registry
 *  everything else on this box uses. */
export const PLUGIN = "people";

/** Is there a Gmail account with all three fields? That is the whole of what
 *  "connected" means for this plugin: there is no credential of its own, so
 *  the flag cannot be derived from its accounts the way `syncPlugin` derives
 *  every other one — a plugin with no accounts would be permanently
 *  disconnected while working perfectly. */
export function mailboxExists(): boolean {
  return (
    accounts.credentialed("gmail", ["client-id", "client-secret", "refresh-token"], "people_state")
      .ready.length > 0
  );
}

/** The flag and the last error, written together. */
export function syncConnected(error?: string | null) {
  upsertPlugin(PLUGIN, mailboxExists(), error ?? null);
}

/** A Gmail failure in words. `GmailError.message` is only "HTTP 403"; the
 *  sentence Google actually sent is on `.body`, and without it every refusal
 *  on the page reads as the same unexplained number. */
export function reason(e: unknown): string {
  if (e instanceof GmailError) return e.body ? `${e.message} — ${e.body}` : e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/* ------------------------------------------------------------- the settings */

export const DEFAULT_WINDOW_DAYS = 365;
export const DEFAULT_MIN_EACH_WAY = 2;
export const DEFAULT_MAX_RECEIVED = 2500;
export const DEFAULT_STALE_DAYS = 90;

/**
 * The SENT budget, which is a constant rather than a setting on purpose.
 *
 * Outbound is both the scarcer half of a mailbox and the more informative one
 * — "who have I stopped writing to" is the question this area exists for — so
 * it gets its own guaranteed share of the scan rather than competing with
 * inbound for one shared cap. There is one knob for the big, cheap-to-be-wrong
 * half (received) and none for the small one, because a setting that lets the
 * owner starve the sent scan would make every "you have not written to them"
 * claim on the page a claim about the budget.
 */
export const MAX_SENT = 1500;

/** Below four gaps — five separate days of contact — a median is a coin toss
 *  and the temperature is null. */
export const MIN_GAPS = 4;
/** Past this multiple of their own gap, a correspondence is cooling; past the
 *  second, cold. workdash's numbers, kept because they were tuned against a
 *  real mailbox rather than chosen for roundness. */
export const COOLING_RATIO = 1.75;
export const COLD_RATIO = 3.0;
/** Nothing is called cooling before a week of silence, whatever the ratio
 *  says. "You have not written to your co-founder since Tuesday" is noise. */
export const MIN_QUIET_DAYS = 7;

export type Settings = {
  windowDays: number;
  minEachWay: number;
  maxReceived: number;
  staleDays: number;
  /** Lower-cased, no leading @. The owner's own domains, whose people are
   *  colleagues seen from inside rather than contacts. */
  selfDomains: Set<string>;
};

const int = (raw: string | null, fallback: number, lo: number, hi: number) => {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
};

/** A comma-or-newline list, lower-cased, with a leading @ or a scheme stripped
 *  — the owner will type both forms and neither is wrong. */
export function parseDomains(raw: string | null): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter((d) => d.includes(".")),
    ),
  ];
}

export function settings(): Settings {
  return {
    windowDays: int(configValue(PLUGIN, "window-days"), DEFAULT_WINDOW_DAYS, 7, 1825),
    minEachWay: int(configValue(PLUGIN, "min-each-way"), DEFAULT_MIN_EACH_WAY, 1, 20),
    maxReceived: int(configValue(PLUGIN, "max-received"), DEFAULT_MAX_RECEIVED, 100, 20000),
    staleDays: int(configValue(PLUGIN, "stale-days"), DEFAULT_STALE_DAYS, 7, 730),
    selfDomains: new Set(parseDomains(configValue(PLUGIN, "self-domains"))),
  };
}

/* ---------------------------------------------------------------- the fold */

/**
 * Local parts that are a desk rather than a person.
 *
 * DELIBERATELY SHORT. A long list of guesses — info, hello, team, contact —
 * drops real people who write from the address printed on their own website,
 * which is most founders. These are the ones that cannot be a person, and the
 * List-Unsubscribe header does the rest of the work: a sender that declares
 * itself a mailing list has told us what it is, which beats guessing.
 */
const BULK_LOCALS = [
  "no-reply", "noreply", "donotreply", "do-not-reply", "mailer-daemon",
  "postmaster", "bounce", "bounces", "notification", "notifications",
  "news", "newsletter", "updates", "alerts", "billing", "receipts",
  "support", "automated",
];

export function looksBulk(address: string): boolean {
  const local = address.split("@")[0]?.toLowerCase() ?? "";
  const normal = local.replace(/[^a-z]+/g, "-");
  return BULK_LOCALS.some(
    (b) => local === b || normal === b || local.startsWith(`${b}-`) || normal.startsWith(`${b}-`),
  );
}

/** A display name, or null. NEVER derived from the address: a "Jane Smith"
 *  invented out of `jane.smith@` is a name this dashboard made up. */
export function displayName(raw: string): string | null {
  const name = raw.replace(/^"(.*)"$/, "$1").trim();
  if (!name || name.length < 2) return null;
  if (name.includes("@")) return null; // clients routinely put the address here
  if (!/[^\W\d_]/.test(name)) return null; // no letters at all
  return name.slice(0, 80);
}

export const domainOf = (address: string) => address.split("@")[1]?.toLowerCase() ?? "";

/** One person as the fold sees them, before anything is written down. */
type Folded = {
  address: string;
  name: string | null;
  nameAt: number;
  received: number;
  sent: number;
  bulkHits: number;
  threads: Set<string>;
  days: Map<string, { received: number; sent: number }>;
  firstAt: number | null;
  lastReceived: number | null;
  lastSent: number | null;
  /** Ventures whose host was seen in a subject line of a message with this
   *  person on it. Counted in memory; the subject itself is never kept. */
  subjectHosts: Set<string>;
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayNumber = (ms: number) => Math.floor(ms / 86_400_000);

/**
 * Fold a scan's messages into people.
 *
 * A MESSAGE TO FIVE PEOPLE COUNTS ONCE FOR EACH OF THE FIVE. That is what
 * makes "sent" per-contact rather than per-message, and it is why the column
 * must never be summed across rows to get "mail sent": that would count one
 * send five times. The route says so; this is where it becomes true.
 */
export function fold(
  messages: { message: MetaMessage; direction: "sent" | "received" }[],
  self: (address: string) => boolean,
  hostsIn: (subject: string) => string[],
): Map<string, Folded> {
  const people = new Map<string, Folded>();

  const touch = (address: string): Folded => {
    let row = people.get(address);
    if (!row) {
      row = {
        address,
        name: null,
        nameAt: 0,
        received: 0,
        sent: 0,
        bulkHits: 0,
        threads: new Set(),
        days: new Map(),
        firstAt: null,
        lastReceived: null,
        lastSent: null,
        subjectHosts: new Set(),
      };
      people.set(address, row);
    }
    return row;
  };

  for (const { message, direction } of messages) {
    const at = message.at;
    const hosts = hostsIn(message.subject);
    /* A message with no internalDate has no place on the day grid and cannot
       move a "last seen". It still counts towards the volume, because it
       happened. */
    const day = at === null ? null : isoDay(at);

    const parties =
      direction === "sent"
        ? message.recipients.map((address) => ({ address, name: null as string | null }))
        : message.from
          ? [{ address: message.from, name: displayName(message.fromName) }]
          : [];

    for (const party of parties) {
      if (!party.address.includes("@") || self(party.address)) continue;
      const row = touch(party.address);
      if (direction === "received") {
        row.received += 1;
        if (message.bulk) row.bulkHits += 1;
        if (at !== null && (row.lastReceived === null || at > row.lastReceived)) row.lastReceived = at;
        /* LATEST SEEN NAME WINS. People change how they sign their mail, and
           the most recent signature is the one they answer to now. */
        if (party.name && at !== null && at >= row.nameAt) {
          row.name = party.name;
          row.nameAt = at;
        }
      } else {
        row.sent += 1;
        if (at !== null && (row.lastSent === null || at > row.lastSent)) row.lastSent = at;
      }
      if (message.threadId) row.threads.add(message.threadId);
      if (at !== null && (row.firstAt === null || at < row.firstAt)) row.firstAt = at;
      if (day) {
        const cell = row.days.get(day) ?? { received: 0, sent: 0 };
        cell[direction === "received" ? "received" : "sent"] += 1;
        row.days.set(day, cell);
      }
      for (const host of hosts) row.subjectHosts.add(host);
    }
  }
  return people;
}

/* ------------------------------------------------------- the derived figures */

/**
 * The median gap, in days, between DAYS on which mail passed either way.
 *
 * Days rather than messages: a fourteen-message thread on one Tuesday
 * afternoon is one contact, and counting the messages would report that
 * relationship as hourly.
 */
export function cadence(dayNumbers: number[]): { days: number | null; gaps: number } {
  const days = [...new Set(dayNumbers)].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) gaps.push(days[i]! - days[i - 1]!);
  if (gaps.length < MIN_GAPS) return { days: null, gaps: gaps.length };
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { days: median, gaps: gaps.length };
}

export type Temperature = "warm" | "cooling" | "cold" | null;

/**
 * The eight lines the whole page rests on.
 *
 * Every branch returns a REASON as well as a verdict, because "cold" on its
 * own is a judgement and "you two normally trade mail about every nine days;
 * it has been thirty-one, which is 3.4× the usual gap" is a measurement.
 */
export function temperature(
  cadenceDays: number | null,
  quietDays: number | null,
): { temperature: Temperature; why: string } {
  if (cadenceDays === null)
    return {
      temperature: null,
      why: "not enough separate days of contact inside the window to know their rhythm — no claim either way",
    };
  if (quietDays === null)
    return { temperature: null, why: "no dated message either way, so there is nothing to measure" };
  const usual = `you two normally trade mail about every ${Math.round(cadenceDays)} day${Math.round(cadenceDays) === 1 ? "" : "s"}`;
  if (quietDays < MIN_QUIET_DAYS)
    return { temperature: "warm", why: `${usual}, and it has been ${quietDays} — current` };
  const ratio = quietDays / Math.max(cadenceDays, 1);
  const past = `${usual}; it has been ${quietDays}, which is ${ratio.toFixed(1)}× the usual gap`;
  if (ratio >= COLD_RATIO) return { temperature: "cold", why: past };
  if (ratio >= COOLING_RATIO) return { temperature: "cooling", why: past };
  return { temperature: "warm", why: `${usual}, and it has been ${quietDays} — current` };
}

/**
 * How much of a correspondence this is, for ordering a list.
 *
 * 10 × the smaller of (received, sent) + the total. The SMALLER side is how
 * often the conversation actually went both ways; the total only breaks ties.
 * It is an ordering, not a score of a relationship, and the page says so.
 */
export const WEIGHT_BASIS =
  "10 × the smaller of (messages received, messages sent) + the total. The " +
  "smaller side is how often the conversation actually went both ways; the " +
  "total only breaks ties. It orders a list and measures nothing.";

export const weightOf = (received: number, sent: number) =>
  10 * Math.min(received, sent) + received + sent;

/* ----------------------------------------------------------------- storage */

export type ContactRow = {
  mailbox: string;
  address: string;
  name: string;
  domain: string;
  first_seen: string | null;
  last_received: string | null;
  last_sent: string | null;
  received: number;
  sent: number;
  threads: number;
  window_days: number;
  scan_from: string | null;
  scanned_at: string;
};

export type DayRow = { day: string; received: number; sent: number };

export function contactRows(): ContactRow[] {
  return db.prepare("SELECT * FROM people_contacts").all() as unknown as ContactRow[];
}

export function contactRow(address: string, mailbox?: string): ContactRow | undefined {
  const rows = db
    .prepare("SELECT * FROM people_contacts WHERE address = ? ORDER BY mailbox")
    .all(address.trim().toLowerCase()) as unknown as ContactRow[];
  return mailbox ? rows.find((r) => r.mailbox === mailbox) : rows[0];
}

export function dayRows(mailbox: string, address: string): DayRow[] {
  return db
    .prepare(
      "SELECT day, received, sent FROM people_days WHERE mailbox = ? AND address = ? ORDER BY day",
    )
    .all(mailbox, address) as unknown as DayRow[];
}

/** Every day row for every contact, for the brief's arithmetic. One query
 *  rather than one per person: the brief reads the whole table anyway. */
export function allDayRows(): (DayRow & { mailbox: string; address: string })[] {
  return db
    .prepare("SELECT mailbox, address, day, received, sent FROM people_days")
    .all() as unknown as (DayRow & { mailbox: string; address: string })[];
}

/**
 * Replace one mailbox's contacts with what this scan found.
 *
 * DELETE-THEN-INSERT, INSIDE A TRANSACTION, and scoped to the mailbox. The
 * window is rolling: a person who fell out the back of it must leave the
 * table, or "contacts in the last year" quietly becomes "contacts ever, plus
 * whatever the last scan saw". Scoped to the mailbox because another Google
 * account's rows are another scan's business.
 */
export function replaceMailbox(
  mailbox: string,
  windowDays: number,
  scanFrom: string | null,
  rows: {
    address: string;
    name: string | null;
    firstSeen: string | null;
    lastReceived: string | null;
    lastSent: string | null;
    received: number;
    sent: number;
    threads: number;
    days: DayRow[] | null;
  }[],
) {
  const at = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM people_contacts WHERE mailbox = ?").run(mailbox);
    db.prepare("DELETE FROM people_days WHERE mailbox = ?").run(mailbox);
    const contact = db.prepare(
      `INSERT INTO people_contacts
         (mailbox, address, name, domain, first_seen, last_received, last_sent,
          received, sent, threads, window_days, scan_from, scanned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const day = db.prepare(
      "INSERT INTO people_days (mailbox, address, day, received, sent) VALUES (?, ?, ?, ?, ?)",
    );
    for (const r of rows) {
      contact.run(
        mailbox,
        r.address,
        r.name ?? "",
        domainOf(r.address),
        r.firstSeen,
        r.lastReceived,
        r.lastSent,
        r.received,
        r.sent,
        r.threads,
        windowDays,
        scanFrom,
        at,
      );
      for (const d of r.days ?? []) day.run(mailbox, r.address, d.day, d.received, d.sent);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Mailboxes whose rows are no longer backed by a connected Gmail account.
 *  A credential removed leaves a table nobody can refresh and everybody
 *  reads. */
export function forgetMailboxesExcept(keep: string[]) {
  const held = new Set(
    (db.prepare("SELECT DISTINCT mailbox FROM people_contacts").all() as unknown as {
      mailbox: string;
    }[]).map((r) => r.mailbox),
  );
  for (const mailbox of held) {
    if (keep.includes(mailbox)) continue;
    db.prepare("DELETE FROM people_contacts WHERE mailbox = ?").run(mailbox);
    db.prepare("DELETE FROM people_days WHERE mailbox = ?").run(mailbox);
  }
}

/* --------------------------------------------------------------- the scan */

export type MailboxScan = {
  accountId: number;
  accountLabel: string;
  mailbox: string | null;
  ok: boolean;
  error: string | null;
  /** Messages actually READ, per direction, and whether the cap bit. */
  sent: { messages: number; truncated: boolean };
  received: { messages: number; truncated: boolean };
  /** The oldest message the scan reached, ISO. Later than the window's start
   *  means every count is a floor. */
  scanFrom: string | null;
  people: number;
  charted: number;
  dropped: number;
};

export type CollectPeople = {
  ok: boolean;
  runId: number;
  error?: string | null;
  note?: string | null;
  mailboxes: MailboxScan[];
};

/** The received query, and every exclusion in it has a reason.
 *  `-in:sent` because a self-addressed message carries SENT and INBOX at once;
 *  `-in:chats` and `-is:draft` because neither is mail anybody sent; and the
 *  three bulk categories because a year of Promotions eats the whole cap and
 *  silently collapses the window to about nine weeks. UPDATES IS KEPT —
 *  receipts, invoices and partner mail live there and are real correspondence. */
export const receivedQuery = (windowDays: number) =>
  `newer_than:${windowDays}d -in:sent -in:chats -is:draft ` +
  `-category:promotions -category:social -category:forums`;

export const sentQuery = (windowDays: number) => `newer_than:${windowDays}d in:sent -in:chats`;

/**
 * One collection: every connected Gmail account, scanned for headers.
 *
 * FAILURE IS PER MAILBOX. One dead grant among three must not empty the
 * contacts of the other two — the same trade every collector on this box
 * makes per account — so a mailbox that refuses keeps its previous rows and
 * says why beside them.
 */
export async function collectPeople(): Promise<CollectPeople> {
  const runId = startRun(PLUGIN);
  const s = settings();
  const pairs = accounts.credentialed(
    "gmail",
    ["client-id", "client-secret", "refresh-token"],
    "collect_people",
  ).ready;

  if (!pairs.length) {
    const error =
      "No Gmail account is connected, so there are no headers to read. Connect one under Integrations.";
    finishRun(runId, false, undefined, error);
    syncConnected(error);
    return { ok: false, runId, error, mailboxes: [] };
  }

  const hostsIn = ventureHostMatcher();
  const scans: MailboxScan[] = [];
  const seen: string[] = [];

  for (const pair of pairs) {
    const scan: MailboxScan = {
      accountId: pair.account.id,
      accountLabel: pair.account.label,
      mailbox: null,
      ok: false,
      error: null,
      sent: { messages: 0, truncated: false },
      received: { messages: 0, truncated: false },
      scanFrom: null,
      people: 0,
      charted: 0,
      dropped: 0,
    };
    scans.push(scan);

    try {
      const session = await openMailbox("collect_people", pair.account.id);
      const mailbox = await profileAddress(session);
      scan.mailbox = mailbox;
      seen.push(mailbox);

      const sentIds = await messageIds(session, sentQuery(s.windowDays), MAX_SENT);
      const receivedIds = await messageIds(session, receivedQuery(s.windowDays), s.maxReceived);
      scan.sent.truncated = sentIds.truncated;
      scan.received.truncated = receivedIds.truncated;

      const sentMeta = await metaMessages(session, sentIds.ids);
      const receivedMeta = await metaMessages(session, receivedIds.ids);
      scan.sent.messages = sentMeta.messages.length;
      scan.received.messages = receivedMeta.messages.length;
      scan.dropped = sentMeta.dropped + receivedMeta.dropped;

      /*
        WHO COUNTS AS "US". The mailbox's own address always; every OTHER
        connected mailbox too, because two of the owner's accounts writing to
        each other would otherwise arrive at the top of his own contacts list
        with a perfect two-way cadence; and the domains he typed into the
        settings. The approximation is stated on the page: a genuine outsider
        at one of those domains is dropped.
      */
      const selfAddresses = new Set([mailbox, ...seen]);
      /* The account LABEL too, when it looks like an address: the credential
         route names a Gmail account after the mailbox it reaches, so the other
         accounts' addresses are usually known before their own scans run. A
         label that is not an address ("Account 2") is ignored rather than
         added as a nonsense self-address. */
      for (const p of pairs) {
        const label = p.account.label.trim().toLowerCase();
        if (label.includes("@")) selfAddresses.add(label);
      }
      const isSelf = (address: string) =>
        selfAddresses.has(address) || s.selfDomains.has(domainOf(address));

      const people = fold(
        [
          ...sentMeta.messages.map((m) => ({ message: m, direction: "sent" as const })),
          ...receivedMeta.messages.map((m) => ({ message: m, direction: "received" as const })),
        ],
        isSelf,
        hostsIn,
      );

      const oldest = Math.min(
        ...[...sentMeta.messages, ...receivedMeta.messages]
          .map((m) => m.at)
          .filter((at): at is number => at !== null),
      );
      scan.scanFrom = Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;

      const rows = [...people.values()]
        /* A row with nothing either way is not a contact; and a machine that
           declares itself a mailing list on half its mail is not a person. */
        .filter((p) => p.received + p.sent > 0)
        .filter((p) => !(looksBulk(p.address) || p.bulkHits * 2 >= Math.max(1, p.received)))
        .map((p) => {
          const mutual = p.received >= s.minEachWay && p.sent >= s.minEachWay;
          return {
            address: p.address,
            name: p.name,
            firstSeen: p.firstAt === null ? null : new Date(p.firstAt).toISOString(),
            lastReceived: p.lastReceived === null ? null : new Date(p.lastReceived).toISOString(),
            lastSent: p.lastSent === null ? null : new Date(p.lastSent).toISOString(),
            received: p.received,
            sent: p.sent,
            threads: p.threads.size,
            /* Only the people there is a correspondence with get a day series.
               A year of a newsletter is 365 rows about a robot. */
            days: mutual
              ? [...p.days.entries()]
                  .map(([day, cell]) => ({ day, received: cell.received, sent: cell.sent }))
                  .sort((a, b) => a.day.localeCompare(b.day))
              : null,
          };
        });

      replaceMailbox(mailbox, s.windowDays, scan.scanFrom, rows);
      scan.people = rows.length;
      scan.charted = rows.filter((r) => r.days !== null).length;
      scan.ok = true;
      accounts.markOk(pair.account.id);
    } catch (e) {
      const message = reason(e);
      scan.error = message;
      accounts.markFailed(pair.account.id, message);
    }
  }

  /* Only prune mailboxes when at least one scan worked: a run in which every
     grant failed must not read as "the owner disconnected everything". */
  if (scans.some((s2) => s2.ok)) forgetMailboxesExcept(seen);

  const ok = scans.some((s2) => s2.ok);
  const total = contactRows().length;
  const note = `${scans.filter((s2) => s2.ok).length}/${scans.length} mailboxes, ${total} contacts`;
  finishRun(runId, ok, note, ok ? undefined : (scans[0]?.error ?? "No mailbox answered."));
  syncConnected(ok ? null : (scans.find((s2) => s2.error)?.error ?? null));
  if (ok) record("people.contacts", total, { windowDays: s.windowDays });
  return {
    ok,
    runId,
    note,
    error: ok ? null : (scans.find((s2) => s2.error)?.error ?? "No mailbox answered."),
    mailboxes: scans,
  };
}

/* --------------------------------------------------------- the venture link */

export type VentureLink = {
  ventureId: string;
  ventureName: string;
  slug: string;
  /** "domain" — their address is at the venture's host; "subject" — the
   *  venture's host appeared in a subject line on a message with them on it. */
  by: "domain" | "subject";
  /** Always true. It is here so a reader of the JSON cannot miss it. */
  derived: true;
  why: string;
};

type VentureLite = { id: string; slug: string; name: string; host: string | null };

function ventures(): VentureLite[] {
  return db
    .prepare("SELECT id, slug, name, host FROM ventures ORDER BY position, id")
    .all() as unknown as VentureLite[];
}

/** A host, stripped to the form a contact's domain could equal: no scheme, no
 *  www, no path. */
export const bareHost = (host: string) =>
  host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/** Which venture hosts a subject line mentions. Called on a string that is
 *  then discarded — see the file header. */
export function ventureHostMatcher(): (subject: string) => string[] {
  const hosts = ventures()
    .map((v) => (v.host ? bareHost(v.host) : null))
    .filter((h): h is string => Boolean(h));
  if (!hosts.length) return () => [];
  return (subject: string) => {
    const lower = subject.toLowerCase();
    return hosts.filter((h) => lower.includes(h));
  };
}

/**
 * The venture a contact probably belongs to — a GUESS, published as one.
 *
 * The roster is a parameter so a caller drawing a hundred and sixty contacts
 * reads the ventures table ONCE rather than once a row; a caller with one
 * contact can leave it out.
 *
 * Only the domain rule survives into storage, because the subject rule's
 * evidence (the subject line) is deliberately not kept. That is the honest
 * trade: a link this box can still justify tomorrow, rather than one whose
 * reason was thrown away. `derived: true` and the reason travel with it.
 */
export function ventureLinkFor(domain: string, roster = ventures()): VentureLink | null {
  const bare = domain.replace(/^www\./, "");
  for (const v of roster) {
    if (!v.host) continue;
    const host = bareHost(v.host);
    if (bare === host || bare.endsWith(`.${host}`))
      return {
        ventureId: v.id,
        ventureName: v.name,
        slug: v.slug,
        by: "domain",
        derived: true,
        why: `their address is at ${domain}, which is ${v.name}'s host. A guess: somebody at a venture's own domain is usually connected to it, and sometimes is a stranger who bought a mailbox there.`,
      };
  }
  return null;
}

/* --------------------------------------------------- the document's people */

export type Person = {
  mailbox: string;
  address: string;
  name: string | null;
  domain: string;
  firstSeen: string | null;
  lastReceived: string | null;
  lastSent: string | null;
  lastAt: string | null;
  received: number;
  sent: number;
  threads: number;
  contactDays: number;
  cadenceDays: number | null;
  cadenceGaps: number;
  quietDays: number | null;
  daysSinceSent: number | null;
  daysSinceReceived: number | null;
  ratio: number | null;
  temperature: Temperature;
  why: string;
  stale: boolean;
  mutual: boolean;
  weight: number;
  link: VentureLink | null;
};

const daysBetween = (iso: string | null, at: number) =>
  iso === null ? null : Math.max(0, Math.floor((at - Date.parse(iso)) / 86_400_000));

/**
 * Every stored contact, with every derived figure computed HERE, on the read.
 *
 * Nothing derived is stored (see 110_people_contacts): a "cold" written down
 * on Tuesday is wrong on Thursday and survives a collector that has stopped,
 * which is the one condition the page exists to reveal.
 */
export function people(at = Date.now()): Person[] {
  const s = settings();
  /* The ventures read once for the whole list rather than once a contact: the
     venture link is a derivation over the same eight rows every time. */
  const roster = ventures();
  const days = new Map<string, number[]>();
  for (const d of allDayRows()) {
    const key = `${d.mailbox} ${d.address}`;
    const held = days.get(key) ?? [];
    held.push(dayNumber(Date.parse(d.day)));
    days.set(key, held);
  }

  return contactRows().map((r) => {
    const key = `${r.mailbox} ${r.address}`;
    const c = cadence(days.get(key) ?? []);
    const lastMs = Math.max(
      r.last_received ? Date.parse(r.last_received) : 0,
      r.last_sent ? Date.parse(r.last_sent) : 0,
    );
    const lastAt = lastMs > 0 ? new Date(lastMs).toISOString() : null;
    const quietDays = daysBetween(lastAt, at);
    const t = temperature(c.days, quietDays);
    return {
      mailbox: r.mailbox,
      address: r.address,
      name: r.name || null,
      domain: r.domain,
      firstSeen: r.first_seen,
      lastReceived: r.last_received,
      lastSent: r.last_sent,
      lastAt,
      received: r.received,
      sent: r.sent,
      threads: r.threads,
      contactDays: new Set(days.get(key) ?? []).size,
      cadenceDays: c.days === null ? null : Math.round(c.days * 10) / 10,
      cadenceGaps: c.gaps,
      quietDays,
      daysSinceSent: daysBetween(r.last_sent, at),
      daysSinceReceived: daysBetween(r.last_received, at),
      ratio:
        c.days === null || quietDays === null
          ? null
          : Math.round((quietDays / Math.max(c.days, 1)) * 100) / 100,
      temperature: t.temperature,
      why: t.why,
      /* THE OWNER'S OWN QUESTION, and it is not the same as "cold": cold is
         relative to the relationship, stale is relative to the calendar. */
      stale: quietDays !== null && quietDays >= s.staleDays,
      mutual: r.received >= s.minEachWay && r.sent >= s.minEachWay,
      weight: weightOf(r.received, r.sent),
      link: ventureLinkFor(r.domain, roster),
    };
  });
}
