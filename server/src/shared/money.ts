/**
 * MONEY, ROUNDED ONCE AND SPELLED ONE WAY.
 *
 * Rounding money at three different precisions — 2, 4 and 6 decimal places —
 * means two documents about the same month never tie out to the cent. Mixing
 * upper-case currency codes with Stripe's lower-case ones means a map keyed by
 * currency holds the same money twice under two spellings. And hand-rolling
 * the `YYYYMM`-to-`YYYY-MM` slice is a fresh chance to get the offsets wrong
 * each time — a key that fails to match yields a silent zero, not an error.
 *
 * WHAT THIS MODULE SETTLED ON
 *
 *   1. FOUR DECIMAL PLACES IS THE DEFAULT, and the rule for anything that will
 *      be summed or stored. Two is not enough: a twelfth of a yearly bill has
 *      a real tail, and a thousand of them rounded to cents first is off by
 *      cents. Six is more than a settled figure carries and makes two
 *      correctly-equal numbers compare unequal on the last digit.
 *
 *   2. `dp` IS EXPLICIT WHERE A SURFACE HAS A REASON. Per-call model spend is
 *      genuinely sub-cent — a single completion can cost a hundredth of a
 *      cent — and rounds at 6, passed at the call site as `MODEL_SPEND_DP`
 *      rather than becoming a second `money`. Several sub-cent surfaces still
 *      hand-roll `.toFixed(6)`; they want this constant.
 *
 *   3. ROUNDING IS THE LAST STEP, NEVER AN INTERMEDIATE ONE. Sum at full
 *      precision, round the answer. Rounding each row and then adding drifts,
 *      and drifts further the more rows there are.
 *
 *   4. TWO DECIMAL PLACES IS A RENDERING CONCERN. A page that wants "£12.34"
 *      formats it for display; it does not get a differently-rounded number
 *      from the server and then disagree with the report next to it.
 *
 *   5. CURRENCY CODES ARE UPPER-CASE ISO 4217 EVERYWHERE. Hetzner says "EUR",
 *      Stripe says "usd", the app stores say both. One shape here, applied at
 *      the edge where a provider's row is read, so a map keyed by currency
 *      cannot hold one currency under two keys.
 *
 * MONEY IS STILL NEVER ADDED ACROSS CURRENCIES. Nothing in this module makes
 * that possible; a total spanning currencies needs a rate somebody typed, and
 * the rate, its date and the word "approximately" travel with the figure.
 */

/* -------------------------------------------------------------- amounts */

/**
 * The default precision. See rule 1 — four places, because a twelfth of a
 * yearly bill has a tail and cents lost per row become pounds per year.
 */
export const MONEY_DP = 4;

/**
 * An amount, rounded for storage or for the wire.
 *
 * `dp` is there for the one documented exception (rule 2) and nothing else.
 * A caller passing 2 because the number "looks like" money is reintroducing
 * the disagreement this module exists to end.
 */
export const money = (n: number, dp: number = MONEY_DP): number => Number(n.toFixed(dp));

/** Per-call model spend, which is genuinely sub-cent. Rule 2, named. */
export const MODEL_SPEND_DP = 6;

/** Stripe and the ad networks meter in minor units. One place to divide. */
export const fromMinorUnits = (minor: number, dp: number = MONEY_DP): number =>
  money(minor / 100, dp);

/**
 * Currency codes are upper-case ISO 4217 throughout. Anything that is not
 * three letters comes back trimmed and upper-cased anyway rather than
 * rejected: a provider that invents a code is a finding for the caller, not a
 * reason to drop the row's money on the floor.
 */
export const currencyCode = (raw: string | null | undefined): string =>
  String(raw ?? "").trim().toUpperCase();

/* ------------------------------------------------------------- calendars */

/** `YYYY-MM`, and nothing else. */
export const isMonth = (s: string | null | undefined): boolean =>
  /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s ?? ""));

/** `YYYYMM`, the spelling Google's report objects are named with. */
export const isCompactMonth = (s: string | null | undefined): boolean =>
  /^\d{4}(0[1-9]|1[0-2])$/.test(String(s ?? ""));

/**
 * "2026-09" → the number of days in it.
 *
 * Months are the unit every bill and every store report uses, so this box
 * counts in them rather than in 30s. Day 0 of the NEXT month is the last day
 * of this one, which is the only arithmetic here that needs saying.
 */
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate();
}

/**
 * `YYYY-MM` → `YYYYMM`.
 *
 * ANYTHING NOT IN THE EXPECTED SHAPE COMES BACK UNCHANGED. These two are
 * lookup keys: a value that is already compact, or that is neither spelling,
 * must not be mangled into a key that matches nothing — a wrong key returns a
 * silent zero, which is the failure mode this pair exists to remove.
 */
export const compactMonth = (month: string): string =>
  isMonth(month) ? month.replace("-", "") : month;

/** `YYYYMM` → `YYYY-MM`. Unchanged if it is not compact — see `compactMonth`. */
export const isoMonth = (compact: string): string =>
  isCompactMonth(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;

/** The month an ISO day or instant falls in, as `YYYY-MM`. */
export const monthOf = (iso: string): string => iso.slice(0, 7);
