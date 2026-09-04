/**
 * The stock libraries' remaining allowance.
 *
 * ONE THING IS REPORTED HERE BECAUSE ONE THING IS KNOWABLE. Pexels and Pixabay
 * are search APIs the video workers call; neither keeps a usage history, neither
 * charges anything, and nothing on this box records what the workers pulled. The
 * request quota is the whole of what they will tell you about themselves, and it
 * happens to be the number that matters — a pipeline that stops finding footage
 * on the 28th is a quota problem you would rather see on the 14th.
 *
 * THE BURN RATE IS COMPUTED ON THE READ, never stored. It is a slope through the
 * readings in the window, and a slope written down at collection time is a claim
 * about a moment that quietly ages into a lie. The same rule as the domain
 * countdowns and the fleet's own figures.
 */
import { Hono } from "hono";
import { stockQuota, type StockQuotaRow } from "../db.ts";
import { DISPLAY, type Library } from "../providers/stock.ts";

export const stock = new Hono();

const LIBRARIES: Library[] = ["pexels", "pixabay"];

/** Readings for one account, oldest first. */
type Series = { ts: string; remaining: number }[];

/**
 * Requests a day, from the readings themselves.
 *
 * Measured across the whole span rather than between the last two samples: two
 * readings six hours apart can differ by a single request the collector itself
 * made, and calling that "4 a day" would be reporting the observer. Null until
 * the window is long enough to mean something — six hours is not a rate.
 *
 * A RESET INSIDE THE WINDOW IS NOT CONSUMPTION. When the allowance refills, the
 * counter jumps UP; a naive first-minus-last would read that as negative burn.
 * Only the falling segments are counted, which is what "how fast is it being
 * spent" actually asks.
 */
function burnPerDay(series: Series): number | null {
  if (series.length < 2) return null;
  const spanMs = Date.parse(series[series.length - 1]!.ts) - Date.parse(series[0]!.ts);
  if (spanMs < 12 * 3_600_000) return null;

  let spent = 0;
  for (let i = 1; i < series.length; i++) {
    const drop = series[i - 1]!.remaining - series[i]!.remaining;
    if (drop > 0) spent += drop;
  }
  return Number(((spent / spanMs) * 86_400_000).toFixed(1));
}

/** Whole days until the allowance is gone at the current rate, or null when
 *  there is no rate, no allowance figure, or nothing is being spent. */
function daysLeft(remaining: number | null, perDay: number | null): number | null {
  if (remaining === null || perDay === null || perDay <= 0) return null;
  return Math.floor(remaining / perDay);
}

stock.get("/", (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 400);
  const rows = stockQuota(days);

  const byLibrary = LIBRARIES.map((library) => {
    const mine = rows.filter((r) => r.library === library);

    // Grouped by account: two keys on one library have two allowances, and
    // adding them would invent a shared pool that does not exist.
    const ids = [...new Set(mine.map((r) => r.account_id))];
    const accounts = ids.map((id) => {
      const own = mine.filter((r) => r.account_id === id);
      const latest = own[own.length - 1] as StockQuotaRow | undefined;
      const series: Series = own
        .filter((r) => r.remaining !== null)
        .map((r) => ({ ts: r.ts, remaining: r.remaining! }));
      const perDay = burnPerDay(series);
      const remaining = latest?.remaining ?? null;

      return {
        accountId: id,
        label: latest?.account_label ?? null,
        limit: latest?.quota_limit ?? null,
        remaining,
        used:
          latest?.quota_limit != null && remaining != null
            ? latest.quota_limit - remaining
            : null,
        /** Share of the allowance already spent, 0–100, or null. */
        usedPct:
          latest?.quota_limit && remaining != null
            ? Number((((latest.quota_limit - remaining) / latest.quota_limit) * 100).toFixed(1))
            : null,
        resetsAt: latest?.resets_at ?? null,
        perDay,
        daysLeft: daysLeft(remaining, perDay),
        readings: series.length,
        seenAt: latest?.ts ?? null,
        points: series.map((p) => ({ ts: p.ts, value: p.remaining })),
      };
    });

    return {
      library,
      name: DISPLAY[library],
      connected: accounts.length > 0,
      accounts,
      /*
        What this integration cannot say, as a property of the service rather
        than a gap in the collector — the same contract Replicate's `cannot`
        block uses, and for the same reason: a reader who does not find a
        clips-used figure should learn why here rather than assume it is
        missing by accident.
      */
      cannot: [
        "how many clips the workers actually downloaded — neither service keeps a usage history, and nothing here records what was fetched",
        "what it cost — both libraries are free at this tier",
      ],
    };
  });

  return c.json({
    window: { days },
    libraries: byLibrary,
    /** Every quota check spends one request from the allowance it reports, so
     *  the reading is never free and the cadence is a deliberate trade. */
    note: "Neither library publishes a quota endpoint, so each reading costs one request from the allowance it reports. They are read every six hours rather than every half hour for that reason.",
    generatedAt: new Date().toISOString(),
  });
});
