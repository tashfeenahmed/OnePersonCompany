/**
 * THE CALENDAR'S ENGINE: wake every minute, publish what is due, and do
 * nothing else.
 *
 * THE CONSENT FOR AN UNATTENDED POST IS THE APPROVAL OF THAT SPECIFIC ITEM
 * FOR THAT SPECIFIC TIME. Two deliberate acts, per item, on a caption and a
 * picture somebody looked at. Nothing else in this server can put a post on an
 * account: an item with no `scheduled_for` is never touched by this function
 * however long it sits, and an item that is scheduled but not approved cannot
 * exist, because `schedule()` refuses one.
 *
 * ONE PER TICK, DELIBERATELY. If a week of posts somehow comes due at once —
 * the laptop was shut, a clock jumped — they go out one a minute rather than
 * seven at once into somebody's feed. That is also what makes the blackout
 * behave correctly: a due item inside a window is not skipped and not lost, it
 * simply is not the one chosen this minute, and it goes out on the first tick
 * after the window closes.
 *
 * DURABLE STATE, NOT MEMORY. This module holds one boolean — whether a tick is
 * already running — and nothing else. Which item is next is a query; that an
 * item is in flight is a row in `publishing`; that an attempt failed and when
 * to try again is `attempts` and `next_attempt_at`. Restarting this process
 * loses nothing, which matters on a box that restarts on every file save.
 *
 * A PROCESS KILLED MID-CALL LEAVES A ROW IN `publishing`, and `reclaim()`
 * moves it back after fifteen minutes. That is only safe because publishItem
 * checks `external_id` first: if the call had in fact succeeded before the
 * process died, the id is on the row and the second attempt refuses. If it had
 * not, the row is unchanged and retrying is right. The dangerous middle — the
 * call succeeded and the answer never arrived — is the one case this cannot
 * distinguish, and the item is reported with its attempt count so a person
 * can look before pressing again.
 */
import { db, now } from "../../db.ts";
import { itemRow, type ItemRow } from "./items.ts";
import { publishItem } from "./publish.ts";
import { inBlackout, settings, STUCK_MINUTES, TICK_MS, wall } from "./settings.ts";

/**
 * The item to publish next, out of rows that are already known to be
 * scheduled.
 *
 * PURE, AND THAT IS THE POINT. Due-selection is three rules that interact —
 * the scheduled time, the retry's `next_attempt_at`, and the order — and the
 * only way to be sure about them is to assert them against a fixed list at a
 * fixed instant, which the tests do. Everything to do with the clock, the
 * blackout and the database is above this function, not inside it.
 *
 * Oldest scheduled time first, so a backlog drains in the order it was meant
 * to go out rather than in the order the rows were created.
 */
export function dueItems(rows: ItemRow[], atIso: string): ItemRow[] {
  const at = Date.parse(atIso);
  return rows
    .filter((r) => {
      if (r.status !== "scheduled") return false;
      /* Already out there. A row that carries an id is never chosen, which is
         belt and braces over publishItem's own check. */
      if (r.external_id) return false;
      if (!r.scheduled_for) return false;
      if (Date.parse(r.scheduled_for) > at) return false;
      if (r.next_attempt_at && Date.parse(r.next_attempt_at) > at) return false;
      return true;
    })
    .sort((a, b) => (a.scheduled_for! < b.scheduled_for! ? -1 : a.scheduled_for! > b.scheduled_for! ? 1 : 0));
}

/** Every scheduled row, for `dueItems` to judge. Small by construction: a
 *  calendar with more than a few hundred future posts on it is not a thing
 *  this app is for. */
export function scheduledRows(): ItemRow[] {
  return db
    .prepare("SELECT * FROM publish_items WHERE status = 'scheduled' ORDER BY scheduled_for LIMIT 500")
    .all() as unknown as ItemRow[];
}

/**
 * Items stuck in `publishing` for longer than a call could possibly take.
 *
 * Run at start and on every tick. The window is generous — fifteen minutes,
 * longer than LinkedIn's upload plus its poll — because reclaiming early would
 * mean two submissions of one post, which is the exact outcome this whole file
 * is arranged to prevent.
 */
export function reclaim(): number {
  const cutoff = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString();
  const stuck = db
    .prepare(
      "SELECT * FROM publish_items WHERE status = 'publishing' AND (last_attempt_at IS NULL OR last_attempt_at < ?)",
    )
    .all(cutoff) as unknown as ItemRow[];
  for (const row of stuck) {
    /* An id on the row means the call DID land before the process died. The
       item is published; only the status never got written. */
    if (row.external_id) {
      db.prepare(
        "UPDATE publish_items SET status = 'published', published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?",
      ).run(now(), now(), row.id);
      continue;
    }
    db.prepare(
      `UPDATE publish_items
          SET status = CASE WHEN scheduled_for IS NULL THEN 'failed' ELSE 'scheduled' END,
              error = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      `This server stopped while the post was being submitted (attempt ${row.attempts}). ` +
        "It is being retried — check the account before approving another attempt, because " +
        "a call that succeeded without answering cannot be told from one that failed.",
      now(),
      row.id,
    );
  }
  return stuck.length;
}

export type TickResult = {
  at: string;
  ran: boolean;
  why: string;
  reclaimed: number;
  due: number;
  publishedId: string | null;
  error: string | null;
};

let ticking = false;

/**
 * One tick.
 *
 * Reentrant-safe by a flag rather than a lock: there is one process, and the
 * only two callers are the timer and the route that runs it by hand. Two ticks
 * at once would submit the same item twice.
 */
export async function tick(trigger: "clock" | "manual" = "clock"): Promise<TickResult> {
  const at = new Date();
  const out: TickResult = {
    at: at.toISOString(),
    ran: false,
    why: "",
    reclaimed: 0,
    due: 0,
    publishedId: null,
    error: null,
  };
  if (ticking) {
    out.why = "A tick was already running.";
    return out;
  }
  ticking = true;
  try {
    out.reclaimed = reclaim();
    const s = settings();
    const due = dueItems(scheduledRows(), at.toISOString());
    out.due = due.length;
    if (!due.length) {
      out.why = "Nothing is due.";
      return out;
    }
    const window = inBlackout(s.blackout, wall(s.timezone, at));
    if (window) {
      out.why = `${due.length} due, held by the blackout window “${window.raw}”. Nothing is skipped; they go out when it closes.`;
      return out;
    }
    const item = due[0]!;
    out.ran = true;
    const res = await publishItem(item.id, { by: trigger === "clock" ? "scheduler" : "owner" });
    out.publishedId = res.ok ? item.id : null;
    out.error = res.error;
    out.why = res.ok
      ? `Published ${item.id}${res.permalink ? ` — ${res.permalink}` : ""}. ${due.length - 1} still due.`
      : `${item.id} did not go out: ${res.error ?? "no reason given"}`;
    return out;
  } finally {
    ticking = false;
  }
}

/**
 * The timer.
 *
 * EVERY MINUTE, AND IT DOES ALMOST NOTHING. A tick with nothing due is one
 * indexed query. The alternative — sleeping until the next scheduled time —
 * does not survive a laptop being shut, which is the machine this runs on:
 * a timer set for nine hours' time does not fire on a machine that was asleep
 * for eight of them.
 *
 * `reclaim()` runs once at start as well, so a crash's leftovers are dealt
 * with without waiting for the first minute — and it runs BEHIND a delay
 * because `node --watch` restarts this server on every save, and reclaiming
 * inside the same second as a save would fight a publish that is genuinely in
 * flight in the outgoing process.
 */
export function startScheduler() {
  const run = () => {
    void tick("clock").catch(() => {
      /* A tick that throws has already recorded whatever it managed. The timer
         must not die with it — that would take the calendar with it until the
         next restart. */
    });
  };
  setTimeout(() => {
    try {
      reclaim();
    } catch {
      /* onStart work must not throw. See the manifest contract. */
    }
  }, 30_000).unref?.();
  setInterval(run, TICK_MS).unref?.();
}

/* -------------------------------------------------------------- the views */

/**
 * The calendar, as a week or a month of days.
 *
 * DAYS ARE LOCAL AND THE TIMES ARE INSTANTS. An item's `scheduled_for` is UTC
 * on the wire and always has been; which DAY it falls on depends on the
 * configured zone, and a calendar that bucketed by UTC day would draw a 23:30
 * post on the wrong square for half the world. So the bucket key comes from
 * `wall()`, which is Intl's answer rather than an offset computed here.
 */
export function calendar(opts: { from: Date; days: number; ventureId?: string | null }) {
  const s = settings();
  const start = new Date(opts.from);
  const rows = (
    opts.ventureId
      ? db
          .prepare(
            "SELECT * FROM publish_items WHERE venture_id = ? AND (scheduled_for IS NOT NULL OR published_at IS NOT NULL) ORDER BY COALESCE(scheduled_for, published_at)",
          )
          .all(opts.ventureId)
      : db
          .prepare(
            "SELECT * FROM publish_items WHERE scheduled_for IS NOT NULL OR published_at IS NOT NULL ORDER BY COALESCE(scheduled_for, published_at)",
          )
          .all()
  ) as unknown as ItemRow[];

  const buckets = new Map<string, ItemRow[]>();
  for (let i = 0; i < opts.days; i++)
    buckets.set(wall(s.timezone, new Date(start.getTime() + i * 86_400_000)).day, []);
  let outside = 0;
  for (const row of rows) {
    const when = row.scheduled_for ?? row.published_at;
    if (!when) continue;
    const key = wall(s.timezone, new Date(when)).day;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else outside += 1;
  }
  return { timezone: s.timezone, buckets, outside };
}

/** Reload one item after a write, for a route that wants to answer with it. */
export const reread = itemRow;
