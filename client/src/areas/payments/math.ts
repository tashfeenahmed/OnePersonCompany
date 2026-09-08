/**
 * The arithmetic the Payments page performs on what the API sends — kept out
 * of the components so the test runner can hold it to account without a DOM.
 *
 * NONE OF THIS INVENTS A FIGURE. Every function here divides, sorts or slices
 * numbers the server already stood behind; where a denominator is missing the
 * answer is null and the page draws a dash, never a confident zero.
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
}): string[] {
  const out: string[] = [];
  const attempts = input.succeeded + input.failed;
  const rate = failRate(input.succeeded, input.failed);
  if (rate !== null && rate >= 25 && attempts >= 10) {
    out.push(
      `${Math.round(rate)}% of payment attempts failed — ${input.failed} of ${attempts} in the last ${input.days} days. ` +
        `${input.blocked} were blocked by Stripe's own checks and ${input.declined} were declined by the customer's bank.`,
    );
  }
  if (input.disputesNeedingResponse > 0) {
    out.push(
      `${input.disputesNeedingResponse} dispute${input.disputesNeedingResponse === 1 ? "" : "s"} worth ${input.fmtMoney(input.disputesAtStake)} ` +
        `need${input.disputesNeedingResponse === 1 ? "s" : ""} a response` +
        (input.nextEvidenceDueBy ? `; the first evidence deadline is ${input.nextEvidenceDueBy}.` : "."),
    );
  }
  if (input.pastDue > 0) {
    out.push(`${input.pastDue} subscription${input.pastDue === 1 ? " is" : "s are"} past due — billing and failing, and not in MRR.`);
  }
  if (input.failingInvoices > 0) {
    out.push(
      `${input.failingInvoices} failing invoice${input.failingInvoices === 1 ? "" : "s"} sit${input.failingInvoices === 1 ? "s" : ""} in the recovery queue waiting for a follow-up.`,
    );
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
