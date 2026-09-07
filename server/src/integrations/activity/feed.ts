/**
 * THE FEED — the one thing on this box that is on the time axis.
 *
 * Every other page here is a set of current readings: what is running, what it
 * costs, how many people came. None of them answers "what actually happened
 * this week", because none of them is a list of events — and the collectors
 * that would know are already running. So this is a PASS, not a new
 * integration: it walks tables that are already being filled and writes down
 * the moments in them.
 *
 * SIX SOURCES, AND THEY DIVIDE IN TWO.
 *
 *   EXACT — the source published the moment the thing happened:
 *     signups   activity_users.created_at, the product's own timestamp
 *     runs      agent_runs.finished_at
 *     cards     board_cards.done_at
 *     pushes    github_repos.pushed_at, GitHub's own
 *     alerts    whatever timestamp column the alerts table has, if it exists
 *
 *   DERIVED — the source publishes a DAY and never a moment:
 *     charges, refunds, disputes, failed payments — stripe_charge_days and
 *     stripe_ledger_days are one row per UTC day per currency. The best that
 *     can be said of a refund is which day it settled on.
 *
 * Those get `exact: 0` and a ts at the start of their day, and every surface
 * that draws them says so. NOTHING HERE FABRICATES A TIMESTAMP: a source that
 * cannot say when does not appear at all. An active-subscription count going up
 * is real and is not an event, because Stripe reports it as a level and the
 * moment it moved was never recorded anywhere.
 *
 * THE PASS IS IDEMPOTENT BY CONSTRUCTION. Every event has a dedupe key that is
 * the table's primary key, so running twice inserts nothing twice. A Stripe day
 * that is later revised — a refund landing in September against a July charge —
 * UPDATES its event's title in place: the day is the event, and there is one of
 * it.
 *
 * IT ONLY LOOKS BACK `WINDOW_DAYS`. Not a retention policy: events already
 * written are kept. It is the boundary on what a FIRST run may create — the
 * first collection of a product with five years of users would otherwise put
 * five thousand signups on the feed at once, most of them older than anything
 * else this box knows about. Ninety days is the same horizon Stripe's own walk
 * uses.
 *
 * A SOURCE THAT THROWS DOES NOT STOP THE PASS. Each is wrapped: one missing
 * table (alerts, which may not exist) must not cost the feed its Stripe rows.
 */
import { db, now, ventureRows } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { PLUGIN, docRows } from "./users.ts";
import { ventureFor } from "./link.ts";

/** How far back a pass will derive events it has never seen. See the header. */
export const WINDOW_DAYS = 90;

export type NewEvent = {
  key: string;
  ts: string;
  exact: boolean;
  kind: string;
  ventureId: string | null;
  product: string | null;
  title: string;
  detail: Record<string, unknown>;
  source: string;
};

function insert(events: NewEvent[]): number {
  if (!events.length) return 0;
  const found = now();
  const stmt = db.prepare(
    `INSERT INTO activity_events (key, ts, exact, kind, venture_id, product, title, detail, source, found_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       -- The title and the detail may be REVISED (a Stripe day gains a refund;
       -- a card is renamed). The timestamp and found_at are not: when it
       -- happened and when we first saw it are both facts about the past.
       ts = excluded.ts,
       title = excluded.title,
       detail = excluded.detail,
       venture_id = excluded.venture_id,
       product = excluded.product`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const e of events) {
      const before = db.prepare("SELECT 1 FROM activity_events WHERE key = ?").get(e.key);
      stmt.run(
        e.key, e.ts, e.exact ? 1 : 0, e.kind, e.ventureId, e.product, e.title,
        JSON.stringify(e.detail), e.source, found,
      );
      if (!before) n += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

function cutoff(): string {
  return new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
}

const money = (n: number, currency: string) =>
  `${n < 0 ? "-" : ""}${Math.abs(n).toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;

/* ------------------------------------------------------------------ signups */

/** One event per user row whose own createdAt is inside the window. EXACT: the
 *  product published the moment, and it is the moment the person signed up. */
function signupEvents(): NewEvent[] {
  const list = accounts.list(PLUGIN);
  if (!list.length) return [];
  const docs = new Map(docRows().map((d) => [d.account_id, d]));
  const ventures = ventureFor(
    list.map((a) => ({ id: a.id, label: a.label })),
    new Map(list.map((a) => [a.id, docs.get(a.id)?.url ?? null])),
  );
  const rows = db
    .prepare(
      `SELECT account_id, product, user_id, created_at, plan, paid, country, email_domain
         FROM activity_users WHERE created_at >= ? ORDER BY created_at ASC LIMIT 5000`,
    )
    .all(cutoff()) as unknown as {
    account_id: number;
    product: string;
    user_id: string;
    created_at: string;
    plan: string | null;
    paid: number | null;
    country: string | null;
    email_domain: string | null;
  }[];

  return rows.map((r) => ({
    key: `users:${r.account_id}:${r.user_id}`,
    ts: r.created_at,
    exact: true,
    kind: "signup",
    ventureId: ventures.get(r.account_id)?.id ?? null,
    product: r.product,
    title: `Signup on ${r.product}${r.plan ? ` · ${r.plan}` : ""}`,
    detail: {
      /* The product's own id, which is not identifying on its own and is the
         only handle the owner has for finding the person in their own admin.
         There is no address here and there is none in the table. */
      userId: r.user_id,
      plan: r.plan,
      paid: r.paid === null ? null : r.paid === 1,
      country: r.country,
      emailDomain: r.email_domain,
    },
    source: "users",
  }));
}

/* ------------------------------------------------------------------- stripe */

/**
 * The Stripe days.
 *
 * FOUR KINDS OUT OF TWO TABLES, and which table each comes from is the whole
 * of its meaning:
 *
 *   charge / payment_failed — stripe_charge_days, which is ATTEMPTS. It is the
 *     only table that can see a failure, because a decline never posts to the
 *     balance and so cannot appear in the ledger at all.
 *   refund / dispute — stripe_ledger_days, which is SETTLEMENT: money that
 *     actually moved.
 *
 * The two are dated differently — one by the charge, one by the posting — and
 * nothing here adds a figure from one to a figure from the other. Every event
 * says which table it came from.
 *
 * BLOCKED AND DECLINED ARE NEVER ADDED. A Radar block is card testing stopped
 * before a bank saw it; a decline is a real customer's bank saying no. Only the
 * declines make an event, and the blocks travel in the detail so the number is
 * available without ever being summed into the headline.
 *
 * NO VENTURE. These tables are per Stripe ACCOUNT and per currency, not per
 * product; a day's charges cannot be attributed to one business, and nothing
 * here pretends otherwise.
 */
function stripeEvents(): NewEvent[] {
  const fromDay = cutoff().slice(0, 10);
  const out: NewEvent[] = [];

  const charges = db
    .prepare(
      `SELECT account_id, account_label, day, currency, gross, refunded, refunds,
              succeeded, failed, blocked, declined
         FROM stripe_charge_days WHERE day >= ?`,
    )
    .all(fromDay) as unknown as {
    account_id: number; account_label: string; day: string; currency: string;
    gross: number; refunded: number; refunds: number; succeeded: number;
    failed: number; blocked: number; declined: number;
  }[];

  for (const r of charges) {
    const at = `${r.day}T00:00:00.000Z`;
    if (r.succeeded > 0)
      out.push({
        key: `stripe:charges:${r.account_id}:${r.currency}:${r.day}`,
        ts: at, exact: false, kind: "charge", ventureId: null, product: r.account_label,
        title: `${r.succeeded} payment${r.succeeded === 1 ? "" : "s"} taken · ${money(r.gross, r.currency)}`,
        detail: {
          resolution: "day", day: r.day, currency: r.currency,
          succeeded: r.succeeded, gross: r.gross,
          from: "stripe_charge_days — payment attempts, dated by the charge",
        },
        source: "stripe",
      });
    if (r.declined > 0)
      out.push({
        key: `stripe:declined:${r.account_id}:${r.currency}:${r.day}`,
        ts: at, exact: false, kind: "payment_failed", ventureId: null, product: r.account_label,
        title: `${r.declined} card${r.declined === 1 ? "" : "s"} declined`,
        detail: {
          resolution: "day", day: r.day, currency: r.currency,
          declined: r.declined,
          /* Carried, never added to the headline. See this function's note. */
          blocked: r.blocked,
          amount: null,
          note:
            "Declines and Radar blocks are counted apart and never share a denominator. " +
            "There is no amount: the charge day table records attempts as counts, not money.",
        },
        source: "stripe",
      });
  }

  const ledger = db
    .prepare(
      `SELECT account_id, account_label, day, currency, refunds, disputes, dispute_fees
         FROM stripe_ledger_days WHERE day >= ?`,
    )
    .all(fromDay) as unknown as {
    account_id: number; account_label: string; day: string; currency: string;
    refunds: number; disputes: number; dispute_fees: number;
  }[];

  for (const r of ledger) {
    const at = `${r.day}T00:00:00.000Z`;
    if (r.refunds > 0)
      out.push({
        key: `stripe:refunds:${r.account_id}:${r.currency}:${r.day}`,
        ts: at, exact: false, kind: "refund", ventureId: null, product: r.account_label,
        title: `${money(r.refunds, r.currency)} refunded`,
        detail: {
          resolution: "day", day: r.day, currency: r.currency, amount: r.refunds,
          from: "stripe_ledger_days — settlement, dated by the ledger posting",
        },
        source: "stripe",
      });
    if (r.disputes > 0 || r.dispute_fees > 0)
      out.push({
        key: `stripe:disputes:${r.account_id}:${r.currency}:${r.day}`,
        ts: at, exact: false, kind: "dispute", ventureId: null, product: r.account_label,
        title: `${money(r.disputes, r.currency)} lost to disputes${r.dispute_fees > 0 ? ` + ${money(r.dispute_fees, r.currency)} in fees` : ""}`,
        detail: {
          resolution: "day", day: r.day, currency: r.currency,
          amount: r.disputes, fees: r.dispute_fees,
          from: "stripe_ledger_days — settlement, dated by the ledger posting",
        },
        source: "stripe",
      });
  }

  return out;
}

/* --------------------------------------------------------------- agent runs */

/** A run that FINISHED. Exact: finished_at is written by the executor at the
 *  moment it stopped. A queued or running one is not an event — it has not
 *  happened yet, and the feed is a record of what has. */
function runEvents(): NewEvent[] {
  const rows = db
    .prepare(
      `SELECT id, kind, venture_id, title, status, finished_at, ms, output_chars
         FROM agent_runs WHERE finished_at IS NOT NULL AND finished_at >= ?`,
    )
    .all(cutoff()) as unknown as {
    id: string; kind: string; venture_id: string | null; title: string;
    status: string; finished_at: string; ms: number | null; output_chars: number;
  }[];

  return rows.map((r) => ({
    key: `run:${r.id}`,
    ts: r.finished_at,
    exact: true,
    kind: "run",
    ventureId: r.venture_id,
    product: null,
    title: `${r.kind} run ${r.status}: ${r.title}`,
    detail: { runId: r.id, runKind: r.kind, status: r.status, ms: r.ms, outputChars: r.output_chars },
    source: "runs",
  }));
}

/* -------------------------------------------------------------------- board */

/**
 * A card that reached Done.
 *
 * `done_at` is set by the move and cleared by a move out, so this is exact and
 * there is at most one event per card: a card finished twice is one card that
 * is finished, dated by the last time it got there. Archived cards are included
 * — archiving is filing, not undoing, and the work still happened.
 */
function cardEvents(): NewEvent[] {
  const rows = db
    .prepare(
      `SELECT id, title, venture_id, done_at, archived_at
         FROM board_cards WHERE done_at IS NOT NULL AND done_at >= ?`,
    )
    .all(cutoff()) as unknown as {
    id: number; title: string; venture_id: string | null; done_at: string; archived_at: string | null;
  }[];

  return rows.map((r) => ({
    key: `card:${r.id}`,
    ts: r.done_at,
    exact: true,
    kind: "card",
    ventureId: r.venture_id,
    product: null,
    title: `Done: ${r.title}`,
    detail: { cardId: r.id, archived: r.archived_at !== null },
    source: "board",
  }));
}

/* ------------------------------------------------------------------- github */

/**
 * A push, from `github_repos.pushed_at`.
 *
 * EXACT, AND COARSE. GitHub's own timestamp for the last push to a repo is a
 * real moment — but the column holds only the LAST one, so a day with nine
 * pushes leaves one event here. That is stated in the detail rather than
 * papered over: this is "the repo was pushed to, at this moment", not "every
 * push".
 */
function pushEvents(): NewEvent[] {
  const links = new Map(
    (
      db
        .prepare("SELECT entity, venture_id FROM venture_links WHERE plugin = 'github'")
        .all() as unknown as { entity: string; venture_id: string }[]
    ).map((r) => [r.entity, r.venture_id]),
  );
  const live = new Set(ventureRows().map((v) => v.id));
  const rows = db
    .prepare("SELECT full_name, pushed_at, default_branch FROM github_repos WHERE pushed_at IS NOT NULL AND pushed_at >= ?")
    .all(cutoff()) as unknown as { full_name: string; pushed_at: string; default_branch: string | null }[];

  return rows.map((r) => {
    const venture = links.get(r.full_name);
    return {
      key: `push:${r.full_name}:${r.pushed_at}`,
      ts: r.pushed_at,
      exact: true,
      kind: "push",
      ventureId: venture && live.has(venture) ? venture : null,
      product: r.full_name,
      title: `Pushed to ${r.full_name}`,
      detail: {
        repo: r.full_name,
        branch: r.default_branch,
        note: "GitHub publishes only the LAST push per repo, so a busy day leaves one event here rather than one per push.",
      },
      source: "github",
    };
  });
}

/* ------------------------------------------------------------------- alerts */

/**
 * Alerts, IF another area has built them.
 *
 * `alert_events` is not this area's table and may not exist at all. Rather than
 * assume a schema, the columns are read off sqlite_master and mapped by the
 * names that are actually there: a timestamp under any of four common spellings
 * and a title under any of four more. If neither can be found the source is
 * skipped and says so — which is the honest behaviour for a table written by
 * somebody else.
 */
function alertEvents(): { events: NewEvent[]; note: string | null } {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alert_events'")
    .get();
  if (!exists) return { events: [], note: null };

  const columns = (
    db.prepare("PRAGMA table_info(alert_events)").all() as unknown as { name: string }[]
  ).map((c) => c.name);
  const pick = (names: string[]) => names.find((n) => columns.includes(n)) ?? null;

  const tsColumn = pick(["ts", "at", "created_at", "fired_at", "raised_at"]);
  const titleColumn = pick(["title", "message", "summary", "text", "name"]);
  if (!tsColumn || !titleColumn)
    return {
      events: [],
      note:
        `alert_events exists but no timestamp/title column could be found in it (${columns.join(", ")}). ` +
        `Nothing was read: guessing which column is the time is how invented moments get onto a timeline.`,
    };

  const idColumn = pick(["id", "key", "rowid"]) ?? "rowid";
  const kindColumn = pick(["kind", "level", "severity", "status"]);
  const ventureColumn = pick(["venture_id", "venture"]);

  const rows = db
    .prepare(
      `SELECT ${idColumn} AS id, ${tsColumn} AS ts, ${titleColumn} AS title` +
        `${kindColumn ? `, ${kindColumn} AS level` : ""}` +
        `${ventureColumn ? `, ${ventureColumn} AS venture` : ""}` +
        ` FROM alert_events WHERE ${tsColumn} >= ?`,
    )
    .all(cutoff()) as unknown as {
    id: string | number; ts: string; title: string; level?: string; venture?: string;
  }[];

  return {
    events: rows.map((r) => ({
      key: `alert:${r.id}`,
      ts: String(r.ts),
      exact: true,
      kind: "alert",
      ventureId: r.venture ?? null,
      product: null,
      title: String(r.title),
      detail: { level: r.level ?? null, columns: { ts: tsColumn, title: titleColumn } },
      source: "alerts",
    })),
    note: null,
  };
}

/* --------------------------------------------------------------------- pass */

export type PassResult = {
  inserted: number;
  bySource: Record<string, number>;
  notes: string[];
  ms: number;
};

/** One pass over every source. Never throws — a source that fails is a note. */
export function runFeedPass(): PassResult {
  const started = Date.now();
  const bySource: Record<string, number> = {};
  const notes: string[] = [];
  let inserted = 0;

  const sources: [string, () => NewEvent[]][] = [
    ["users", signupEvents],
    ["stripe", stripeEvents],
    ["runs", runEvents],
    ["board", cardEvents],
    ["github", pushEvents],
  ];

  for (const [name, fn] of sources) {
    try {
      const n = insert(fn());
      bySource[name] = n;
      inserted += n;
    } catch (err) {
      bySource[name] = 0;
      notes.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const alerts = alertEvents();
    if (alerts.note) notes.push(alerts.note);
    const n = insert(alerts.events);
    bySource.alerts = n;
    inserted += n;
  } catch (err) {
    bySource.alerts = 0;
    notes.push(`alerts: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { inserted, bySource, notes, ms: Date.now() - started };
}

/**
 * The timer.
 *
 * A pass costs a handful of indexed selects over tables that are already in the
 * page cache, so it runs on the same cadence as the collectors rather than
 * trying to be clever about when a source changed. The first one is delayed a
 * few seconds so a boot that is still opening the database is not competing
 * with it, and every timer is unref'd so this can never be the reason the
 * process will not exit.
 */
export function startFeed(everyMinutes: number) {
  const every = Math.max(5, everyMinutes) * 60_000;
  setTimeout(() => {
    const r = runFeedPass();
    if (r.inserted || r.notes.length)
      console.log(`[activity] feed pass: ${r.inserted} new event(s) in ${r.ms}ms${r.notes.length ? ` — ${r.notes.join("; ")}` : ""}`);
  }, 8_000).unref();
  setInterval(() => {
    try {
      const r = runFeedPass();
      if (r.inserted) console.log(`[activity] feed pass: ${r.inserted} new event(s) in ${r.ms}ms`);
    } catch (err) {
      console.error("[activity] feed pass failed:", err);
    }
  }, every).unref();
}
