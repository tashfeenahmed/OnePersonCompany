/**
 * THE ARITHMETIC OF THE PAYMENTS BOARD, kept out of the widget builders so
 * the test runner can hold it to account without a DOM. The builders in
 * `liveWidgets.ts` call these; nothing else does.
 *
 * NONE OF THIS INVENTS A FIGURE. Every function here divides, sorts or slices
 * numbers the server already stood behind; where a denominator is missing the
 * answer is null and the card draws a dash, never a confident zero.
 */

/** One day of payment attempts, the shape `/api/stripe` sends per day. */
export type AttemptDay = {
  day: string;
  succeeded: number;
  failed: number;
  blocked: number;
  declined: number;
};

/**
 * The share of attempts that failed, as a percentage, or null when nothing
 * was attempted. "0% of 0 attempts" is not a measurement.
 */
export function failRate(succeeded: number, failed: number): number | null {
  const attempts = succeeded + failed;
  if (attempts === 0) return null;
  return Math.round((failed / attempts) * 1000) / 10;
}

/** The fail rate over the LAST `n` days of a daily series. */
export function rateOverLast(series: readonly AttemptDay[], n: number): number | null {
  const tail = series.slice(Math.max(0, series.length - n));
  if (tail.length < n) return null;
  const s = tail.reduce((a, d) => a + d.succeeded, 0);
  const f = tail.reduce((a, d) => a + d.failed, 0);
  return failRate(s, f);
}

export type Drift = {
  short: number;
  long: number;
  /** In the words the card prints. */
  verdict: "holding" | "getting worse" | "recovering";
};

/** Two percentage points is the width a decline rate wanders in a normal
 *  week; inside it the honest word is "holding". */
export const DRIFT_PTS = 2;

/**
 * Seven days against thirty, FIXED — never the window the reader picked,
 * because the point of the comparison is that it does not move with the
 * control. Null when the series is shorter than thirty days, or either span
 * saw no attempts.
 */
export function drift(series: readonly AttemptDay[]): Drift | null {
  const short = rateOverLast(series, 7);
  const long = rateOverLast(series, 30);
  if (short === null || long === null) return null;
  const delta = short - long;
  return {
    short,
    long,
    verdict: delta >= DRIFT_PTS ? "getting worse" : delta <= -DRIFT_PTS ? "recovering" : "holding",
  };
}

/**
 * One line of the "Worth a look" card: the sentence, and how loudly to say
 * it. "bad" is money already at risk — a dispute with a deadline, a fail rate
 * past the line; "warn" is something to write about this week.
 */
export type Alert = { text: string; tone: "warn" | "bad" };

/**
 * Which alerts the "Worth a look" card should carry, as sentences. Each one
 * has its own threshold, and the thresholds are here so a test can name them.
 */
export function worthALook(input: {
  days: number;
  succeeded: number;
  failed: number;
  blocked: number;
  declined: number;
  pastDue: number;
  disputesNeedingResponse: number;
  disputesAtStake: number;
  nextEvidenceDueBy: string | null;
  failingInvoices: number;
  fmtMoney: (n: number) => string;
}): Alert[] {
  const out: Alert[] = [];
  const attempts = input.succeeded + input.failed;
  const rate = failRate(input.succeeded, input.failed);
  if (rate !== null && rate >= 25 && attempts >= 10) {
    out.push({
      tone: "bad",
      text:
        `${Math.round(rate)}% of payment attempts failed — ${input.failed} of ${attempts} in the last ${input.days} days. ` +
        `${input.blocked} were blocked by Stripe's own checks and ${input.declined} were declined by the customer's bank.`,
    });
  }
  if (input.disputesNeedingResponse > 0) {
    out.push({
      tone: "bad",
      text:
        `${input.disputesNeedingResponse} dispute${input.disputesNeedingResponse === 1 ? "" : "s"} worth ${input.fmtMoney(input.disputesAtStake)} ` +
        `need${input.disputesNeedingResponse === 1 ? "s" : ""} a response` +
        (input.nextEvidenceDueBy ? `; the first evidence deadline is ${input.nextEvidenceDueBy}.` : "."),
    });
  }
  if (input.pastDue > 0) {
    out.push({
      tone: "warn",
      text: `${input.pastDue} subscription${input.pastDue === 1 ? " is" : "s are"} past due — billing and failing, and not in MRR.`,
    });
  }
  if (input.failingInvoices > 0) {
    out.push({
      tone: "warn",
      text: `${input.failingInvoices} failing invoice${input.failingInvoices === 1 ? "" : "s"} sit${input.failingInvoices === 1 ? "s" : ""} in the recovery queue waiting for a follow-up.`,
    });
  }
  return out;
}

/** The top `n` plans by MRR, and how many were left out of the picture. */
export function planSplit<T extends { mrr: number }>(plans: readonly T[], n = 4): { top: T[]; more: number } {
  const positive = plans.filter((p) => p.mrr > 0).slice().sort((a, b) => b.mrr - a.mrr);
  return { top: positive.slice(0, n), more: Math.max(0, positive.length - n) };
}

/**
 * The recovery queue's churn cases, sorted soonest first, and split at sixty
 * days — the point past which "ending soon" stops meaning anything. A case
 * with no deadline is a cancellation that has already ended, and sorts last.
 */
export function splitLeaving<T extends { daysLeft: number | null }>(
  cases: readonly T[],
  soonDays = 60,
): { soon: T[]; later: T[]; undated: T[] } {
  const dated = cases.filter((c) => c.daysLeft !== null).slice().sort((a, b) => a.daysLeft! - b.daysLeft!);
  return {
    soon: dated.filter((c) => c.daysLeft! <= soonDays),
    later: dated.filter((c) => c.daysLeft! > soonDays),
    undated: cases.filter((c) => c.daysLeft === null),
  };
}

/** A per-month total over cases that carry an amount, and how many did not. */
export function sumMonthly<T extends { amount: number | null }>(cases: readonly T[]): { total: number; unpriced: number } {
  let total = 0;
  let unpriced = 0;
  for (const c of cases) {
    if (c.amount === null) unpriced += 1;
    else total += c.amount;
  }
  return { total, unpriced };
}

/* ------------------------------------------------- the fail-rate picture */

/** One point of the trailing fail-rate line: a day, and the share of the
 *  attempts in the `span` days ending on it that failed. */
export type FailRatePoint = { day: string; rate: number };

/**
 * How many days of attempts the trailing line needs before it is drawn: the
 * thirty-day window itself plus a week of movement. Fewer than that is a
 * line of one or two points, which is a dot pretending to be a trend — so
 * under 7d and 30d the card says which window would show it.
 */
export const TRAILING_MIN_DAYS = 37;

/**
 * The fail rate over the trailing `span` days, one point per day, oldest
 * first. A day whose trailing window saw no attempts is dropped rather than
 * recorded as 0% — "nothing was attempted" is not "nothing failed". Capped
 * at the last `cap` points so an all-time series does not hand a sparkline
 * five years of pixels it cannot draw.
 */
export function trailingFailRate(
  series: readonly AttemptDay[],
  span = 30,
  minDays = TRAILING_MIN_DAYS,
  cap = 365,
): FailRatePoint[] | null {
  if (series.length < minDays) return null;
  const tail = series.slice(Math.max(0, series.length - (cap + span - 1)));
  const out: FailRatePoint[] = [];
  let s = 0;
  let f = 0;
  for (let i = 0; i < tail.length; i += 1) {
    s += tail[i]!.succeeded;
    f += tail[i]!.failed;
    if (i >= span) {
      s -= tail[i - span]!.succeeded;
      f -= tail[i - span]!.failed;
    }
    if (i < span - 1) continue;
    const rate = failRate(s, f);
    if (rate !== null) out.push({ day: tail[i]!.day, rate });
  }
  return out;
}

/** One run of days, with its attempts summed. */
export type AttemptBucket = {
  from: string;
  to: string;
  succeeded: number;
  failed: number;
  blocked: number;
  declined: number;
};

/**
 * How many days one bucket of the attempts picture covers, from how many
 * days there are: a week is read by the day, a month by the week, a quarter
 * by the fortnight, and anything longer by the month. The grain follows the
 * window so the card always draws a handful of rows rather than ninety.
 */
export function bucketDays(days: number): number {
  if (days <= 7) return 1;
  if (days <= 31) return 7;
  if (days <= 93) return 14;
  return 30;
}

/**
 * The series cut into runs of `size` days, NEWEST FIRST, the newest run
 * being the one that may be short. Newest first because the rows are read
 * as "this week against the ones before it", and the ranked bars they
 * become are ordered by the builder, not by length — a time axis is not a
 * ranking.
 */
export function attemptBuckets(series: readonly AttemptDay[], size: number): AttemptBucket[] {
  const out: AttemptBucket[] = [];
  const step = Math.max(1, size);
  for (let end = series.length; end > 0; end -= step) {
    const chunk = series.slice(Math.max(0, end - step), end);
    out.push({
      from: chunk[0]!.day,
      to: chunk[chunk.length - 1]!.day,
      succeeded: chunk.reduce((n, d) => n + d.succeeded, 0),
      failed: chunk.reduce((n, d) => n + d.failed, 0),
      blocked: chunk.reduce((n, d) => n + d.blocked, 0),
      declined: chunk.reduce((n, d) => n + d.declined, 0),
    });
  }
  return out;
}

/**
 * Which of a charge list falls inside a window measured back from `now`,
 * newest first as it arrived. "all" is the whole list. The list is the
 * collector's ninety days whatever the window, and the caller says so when
 * the window is wider — this only cuts it shorter.
 */
export function chargesInWindow<T extends { createdAt: string }>(
  list: readonly T[],
  window: number | "all",
  nowMs: number,
): T[] {
  if (window === "all") return [...list];
  const cutoff = nowMs - window * 86_400_000;
  return list.filter((c) => Date.parse(c.createdAt) >= cutoff);
}
