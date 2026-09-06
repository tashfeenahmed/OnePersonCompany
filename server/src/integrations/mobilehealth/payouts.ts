/**
 * APP STORE AND PLAY PAYOUT MONEY, SUMMED ONCE.
 *
 * Three summations of these two tables used to exist — the mobile board added
 * every row with no gate at two decimal places, the revenue route added the
 * ones whose report had actually arrived, and the finance area added a third
 * set at four places ignoring the gate entirely. The revenue route is mounted
 * INSIDE the mobile board's router, so one API tree served two answers for one
 * month; and because finance ignored the gate, a venture's margin could be
 * charged against payouts the revenue document deliberately withheld.
 *
 * THE GATE IS THE POINT OF THIS FILE, so it is applied exactly once, here.
 *
 *   A payout row is money only when the report it came from is one this box
 *   knows arrived. Apple issues a finance report per fiscal month and answers
 *   the same 404 for a settled month, the running month and a month in the
 *   future — so `appstore_reports` records what was asked and what came back,
 *   and only `reported` counts. Google writes an earnings export once a month
 *   closes, so the presence of the `earnings/YYYYMM` object IS the gate.
 *
 * WHY A GATE AT ALL, GIVEN THE ROWS EXIST. Rows arrive per account. An account
 * whose report has not landed contributes nothing, and a sum across accounts
 * that quietly included the ones that had reported and silently omitted the
 * ones that had not is a partial figure wearing a total's clothes. `coverage`
 * says which accounts answered so a caller can label it.
 *
 * NULL IS NOT ZERO, here as everywhere: a month with no reported reports has
 * no payout, and `null` is what it gets.
 *
 * CURRENCIES ARE NEVER ADDED. Every total is a list keyed by an upper-case ISO
 * code — one spelling, so a map merged with the finance area's cannot hold one
 * currency under two keys.
 */
import {
  accountRows,
  appStorePayouts,
  appStoreReports,
  getPlugin,
  playEarnings,
  playFiles,
} from "../../db.ts";
import { currencyCode, isoMonth, money } from "../../shared/money.ts";

export const STORES = ["appstore", "playstore"] as const;
export type Store = (typeof STORES)[number];

/**
 * One payout row that passed the gate.
 *
 * `month` is always `YYYY-MM`. Google stamps its objects `202608` and Apple
 * names its reports `2026-08`; one document should not carry both spellings,
 * and the conversion is `shared/money.ts`'s rather than a fifth hand-rolled
 * slice — a key that fails to match yields a silent zero, not an error.
 */
export type Payout = {
  store: Store;
  accountId: number;
  /** App id (Apple) or package name (Google). Null where the row carries none. */
  app: string | null;
  month: string;
  currency: string;
  /** What buyers were charged, where the source publishes it. Apple's finance
   *  report publishes proceeds only, so it is null there rather than wrong. */
  charged: number | null;
  refunds: number | null;
  fees: number | null;
  /** The money that lands. The only field anything may call revenue. */
  net: number;
  transactions: number | null;
  seenAt: string;
};

const connected = (store: Store) => getPlugin(store)?.connected === 1;

/** The accounts whose own connection is live. A disconnected account's stored
 *  rows are history, not this month's money. */
const liveAccounts = (store: Store) => accountRows(store).filter((a) => a.connected === 1);

/**
 * Which account reported which month — the gate, in one query per store.
 *
 * Empty when the plugin is not connected: a box that has never been told the
 * credential knows nothing about any month, which is not the same as knowing
 * that no month earned.
 */
export function reportedMonths(store: Store): { accountId: number; month: string }[] {
  if (!connected(store)) return [];
  const ids = new Set(liveAccounts(store).map((a) => a.id));
  if (store === "appstore")
    return appStoreReports("finance")
      .filter((r) => ids.has(r.account_id) && r.state === "reported")
      .map((r) => ({ accountId: r.account_id, month: r.period }));
  return [...ids].flatMap((id) =>
    [...playFiles(id).keys()]
      .filter((key) => /^earnings\/\d{6}$/.test(key))
      .map((key) => ({ accountId: id, month: isoMonth(key.slice(-6)) })),
  );
}

/** Every month either store has a reported report for, oldest first. */
export const availableMonths = (store: Store): string[] =>
  [...new Set(reportedMonths(store).map((r) => r.month))].sort();

/**
 * The gated payout rows for one store.
 *
 * `month` null means every reported month. A row whose account/month pair is
 * not in `reportedMonths` is dropped — that is the whole gate, and it is the
 * only place it is spelled.
 */
export function payouts(store: Store, month: string | null = null): Payout[] {
  const gate = new Set(
    reportedMonths(store)
      .filter((r) => month === null || r.month === month)
      .map((r) => `${r.accountId} ${r.month}`),
  );
  if (!gate.size) return [];
  if (store === "appstore")
    return appStorePayouts()
      .filter((r) => gate.has(`${r.account_id} ${r.month}`))
      .map((r) => ({
        store,
        accountId: r.account_id,
        app: r.app_id || null,
        month: r.month,
        currency: currencyCode(r.currency),
        charged: null,
        refunds: null,
        fees: null,
        net: r.amount,
        transactions: null,
        seenAt: r.seen_at,
      }));
  return playEarnings()
    .filter((r) => gate.has(`${r.account_id} ${isoMonth(r.month)}`))
    .map((r) => ({
      store,
      accountId: r.account_id,
      app: r.package || null,
      month: isoMonth(r.month),
      currency: currencyCode(r.currency),
      charged: r.charged,
      refunds: r.refunds,
      fees: r.fees,
      net: r.net,
      transactions: r.transactions,
      seenAt: r.seen_at,
    }));
}

/** Both stores at once, for one month. What the finance area's revenue lines
 *  are built from. */
export const payoutsForMonth = (month: string): Payout[] =>
  STORES.flatMap((store) => payouts(store, month));

/** Amounts summed per currency, biggest first, four places. Null — never an
 *  empty list and never zero — when there is nothing that passed the gate. */
export function byCurrency(
  rows: Payout[],
  amount: (p: Payout) => number | null = (p) => p.net,
): { currency: string; amount: number }[] | null {
  if (!rows.length) return null;
  const sums = new Map<string, number>();
  for (const r of rows) {
    const v = amount(r);
    if (v === null) continue;
    sums.set(r.currency, (sums.get(r.currency) ?? 0) + v);
  }
  if (!sums.size) return null;
  return [...sums]
    .map(([currency, n]) => ({ currency, amount: money(n) }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.currency.localeCompare(b.currency));
}

/** Which accounts answered for this month, so a caller can say whether its
 *  total covers the whole store. */
export function coverage(store: Store, month: string | null) {
  const accounts = accountRows(store);
  const answered = new Set(
    reportedMonths(store).filter((r) => month === null || r.month === month).map((r) => r.accountId),
  );
  return {
    connected: connected(store),
    accounts,
    answered,
    status: !connected(store) ? "not_connected"
      : !answered.size ? "not_reported"
        : answered.size < accounts.length ? "partial" : "reported",
  };
}
