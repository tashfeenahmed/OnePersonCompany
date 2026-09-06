/**
 * THE ARITHMETIC, KEPT AWAY FROM THE DATABASE so it can be tested and so there
 * is exactly one of it.
 *
 * Three rules live here and nowhere else:
 *
 *   1. A PERIOD IS NOT A NUMBER. A yearly bill contributes a twelfth to a
 *      monthly run rate and its EXACT price to a yearly one — never twelve
 *      roundings of a twelfth. A one-off contributes NOTHING to either: a fee
 *      paid once is not a rate, and amortising it produces a commitment that
 *      never stops being owed.
 *
 *   2. MONEY IS NEVER ADDED ACROSS CURRENCIES. Every total this area produces
 *      is a map from currency code to amount. There is no `total` field on any
 *      of them and there will not be one without a rate the owner typed, at
 *      which point the rate, its date and the word "approximately" travel with
 *      the figure — see `convert`.
 *
 *   3. NULL IS NOT ZERO. An expense with no `amount` is a cost whose price
 *      nobody has established: twenty-three domains with a renewal date and no
 *      published price, a service somebody added before looking up the bill.
 *      It is counted in `unpriced` and excluded from every total, and the
 *      total says how many it is missing.
 */

export type Period = "monthly" | "yearly" | "once";
export type Category = "server" | "domain" | "service" | "subscription" | "salary" | "other";
export type RenewalDecision = "keep" | "cancel" | "undecided";
export type Basis = "equal" | "manual" | "revenue" | "traffic";

export const PERIODS: Period[] = ["monthly", "yearly", "once"];
export const CATEGORIES: Category[] = ["server", "domain", "service", "subscription", "salary", "other"];
export const DECISIONS: RenewalDecision[] = ["keep", "cancel", "undecided"];
export const BASES: Basis[] = ["equal", "manual", "revenue", "traffic"];

/* The amount and currency-code primitives moved to `shared/money.ts` — nine
   copies of them shipped at three precisions, so two documents about one month
   never tied out. Re-exported here because this area's own rules are written in
   terms of them and a reader of this file should not have to chase two. */
export { compactMonth, currencyCode, isoMonth, money, monthOf } from "../../shared/money.ts";
import { currencyCode, money } from "../../shared/money.ts";

/**
 * This expense's contribution to a MONTHLY run rate.
 *
 * `null` in, `null` out — an unpriced row contributes nothing and must not be
 * silently treated as free. A one-off is 0 by definition rather than by
 * accident: see rule 1.
 */
export function monthlyOf(amount: number | null, period: Period): number | null {
  if (amount === null) return null;
  if (period === "monthly") return amount;
  if (period === "yearly") return amount / 12;
  return 0;
}

/** This expense's contribution to a YEARLY bill, at its own real cadence. */
export function annualOf(amount: number | null, period: Period): number | null {
  if (amount === null) return null;
  if (period === "monthly") return amount * 12;
  if (period === "yearly") return amount;
  return 0;
}

/** A total per currency, plus how many rows had no price to add. */
export type CurrencyTotals = {
  /** Currency code → amount. Sorted by code when it goes on the wire. */
  byCurrency: Record<string, number>;
  /** Rows whose amount was null. Their labels are the caller's to attach. */
  unpriced: number;
};

export const emptyTotals = (): CurrencyTotals => ({ byCurrency: {}, unpriced: 0 });

export function addTo(totals: CurrencyTotals, currency: string, amount: number | null): CurrencyTotals {
  if (amount === null) {
    totals.unpriced += 1;
    return totals;
  }
  const code = currencyCode(currency);
  totals.byCurrency[code] = (totals.byCurrency[code] ?? 0) + amount;
  return totals;
}

/** On the wire: a sorted list rather than an object, so the order is the same
 *  every read and a client can render it without deciding one. */
export function shapeTotals(totals: CurrencyTotals): {
  amounts: { currency: string; amount: number }[];
  unpriced: number;
  combined: null;
} {
  return {
    amounts: Object.entries(totals.byCurrency)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amount: money(amount) })),
    unpriced: totals.unpriced,
    /* Always null. See rule 2 — a converted figure is offered separately, by
       `convert`, and carries its rate. */
    combined: null,
  };
}

/* ------------------------------------------------------------------- FX */

export type Rate = { from: string; to: string; rate: number; asOf: string | null };

/**
 * The `fx` setting, parsed.
 *
 * One line per source currency: `EUR = 1.08 on 2026-09-01`, meaning one euro
 * buys 1.08 of the display currency on that date. The date is optional and its
 * absence is reported rather than defaulted — a rate with no date cannot be
 * checked against anything.
 *
 * A LINE THAT DOES NOT PARSE IS AN ERROR, not a skipped line. Silently
 * ignoring "EUR 1.08" would leave a euro figure out of a conversion the owner
 * believes they configured, which is worse than refusing the setting.
 */
export function parseRates(raw: string | null, display: string): { rates: Rate[]; errors: string[] } {
  const rates: Rate[] = [];
  const errors: string[] = [];
  for (const line of (raw ?? "").split(/[\n,]/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const m = /^([A-Za-z]{3})\s*=\s*([0-9]+(?:\.[0-9]+)?)(?:\s+on\s+(\d{4}-\d{2}-\d{2}))?$/.exec(text);
    if (!m) {
      errors.push(`“${text}” is not a rate. Write one per line: EUR = 1.08 on 2026-09-01.`);
      continue;
    }
    const from = currencyCode(m[1]!);
    const rate = Number(m[2]);
    if (!Number.isFinite(rate) || rate <= 0) {
      errors.push(`“${text}” has no usable rate.`);
      continue;
    }
    if (from === currencyCode(display)) {
      errors.push(`${from} is already the display currency, so there is nothing to convert.`);
      continue;
    }
    rates.push({ from, to: currencyCode(display), rate, asOf: m[3] ?? null });
  }
  return { rates, errors };
}

/**
 * The one figure in this area that spans currencies, and everything about its
 * shape is an argument for not trusting it too far.
 *
 * `null` unless a display currency AND a rate for every foreign currency
 * present have been typed in. A partial conversion — three currencies, two
 * rates — is refused outright and names the missing one, because a total that
 * quietly dropped a currency reads exactly like a total that included it.
 */
export function convert(
  totals: CurrencyTotals,
  display: string | null,
  rates: Rate[],
): {
  currency: string;
  amount: number;
  approximate: true;
  rates: Rate[];
  note: string;
} | { error: string } | null {
  if (!display) return null;
  const to = currencyCode(display);
  const codes = Object.keys(totals.byCurrency);
  if (!codes.length) return null;
  const missing = codes.filter((c) => c !== to && !rates.some((r) => r.from === c && r.to === to));
  if (missing.length)
    return {
      error:
        `No rate was set for ${missing.join(", ")} → ${to}, so there is no converted total. ` +
        `Add one on the Finance integration's page: ${missing[0]} = 1.08 on ${new Date().toISOString().slice(0, 10)}.`,
    };
  let sum = 0;
  const used: Rate[] = [];
  for (const [code, amount] of Object.entries(totals.byCurrency)) {
    if (code === to) {
      sum += amount;
      continue;
    }
    const rate = rates.find((r) => r.from === code && r.to === to)!;
    sum += amount * rate.rate;
    used.push(rate);
  }
  return {
    currency: to,
    amount: money(sum),
    approximate: true,
    rates: used,
    note:
      "Converted with the rates typed on the Finance integration's page, not a rate fetched from a market. " +
      "It is approximate by construction; the per-currency amounts beside it are the measured figures.",
  };
}

/* ------------------------------------------------------------- calendars */

export { daysInMonth, isMonth } from "../../shared/money.ts";
import { daysInMonth } from "../../shared/money.ts";

/** The month this box is in, in UTC — the same clock every stored day uses. */
export const currentMonth = (): string => new Date().toISOString().slice(0, 7);

/**
 * How much of `month` has actually happened, in days, as of `nowIso`.
 *
 * A CLOSED MONTH RETURNS ITS FULL LENGTH and a future month returns 0. The
 * caller uses this to decide whether a figure is an actual or a projection,
 * and both edges matter: "0 of 30 days elapsed" is the only honest basis for
 * refusing to project a month that has not started.
 */
export function elapsedDays(month: string, nowIso: string): number {
  const total = daysInMonth(month);
  const now = nowIso.slice(0, 7);
  if (now > month) return total;
  if (now < month) return 0;
  /* The day itself counts as elapsed only in proportion — a projection made at
     09:00 on the 3rd has two and a bit days of evidence, not three. */
  const day = Number(nowIso.slice(8, 10));
  const hours = Number(nowIso.slice(11, 13)) + Number(nowIso.slice(14, 16)) / 60;
  return Math.min(total, day - 1 + hours / 24);
}

/**
 * A measured part-month scaled to the whole month.
 *
 * The ONE projection method this area uses, named on every figure it produces:
 * the daily average of what has been measured so far, times the length of the
 * month. It assumes the rest of the month looks like the part that has
 * happened, which is false for anything seasonal and is stated rather than
 * hidden.
 *
 * Returns null when there is nothing to project FROM — no elapsed time, or no
 * measured figure. A projection from zero evidence is a guess wearing a
 * number's clothes.
 */
export function projectProRata(measured: number | null, elapsed: number, total: number): number | null {
  if (measured === null || elapsed <= 0 || total <= 0) return null;
  return money((measured / elapsed) * total);
}
