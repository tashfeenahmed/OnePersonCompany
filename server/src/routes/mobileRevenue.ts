import { Hono } from "hono";
import {
  STORES,
  availableMonths,
  byCurrency,
  coverage,
  payouts,
  type Store,
} from "../integrations/mobilehealth/payouts.ts";
import { getPlugin } from "../db.ts";
import { isMonth } from "../shared/money.ts";

export const mobileRevenue = new Hono();

/**
 * Report months, not rolling days. Never substitute sales estimates for
 * earnings.
 *
 * THE SUMMATION AND THE REPORT GATE BOTH LIVE IN `mobilehealth/payouts.ts`.
 * They used to live here, again in `mobile.ts` — which mounts this router —
 * and a third time in the finance area, with three different gates and two
 * different precisions. One API tree answered a month two ways.
 */
function revenue(store: Store, requestedMonth: string | null) {
  const months = availableMonths(store);
  const month = requestedMonth ?? months.at(-1) ?? null;
  const { connected, accounts, answered, status } = coverage(store, month);
  const rows = month === null ? [] : payouts(store, month);

  return {
    store,
    connected,
    collectionError: getPlugin(store)?.last_error ?? null,
    status,
    month,
    periodBasis: store === "appstore" ? "Apple fiscal month" : "Google Play report month",
    source: store === "appstore"
      ? "App Store Connect finance report: extended partner share"
      : "Google Play earnings report: net merchant earnings",
    availableMonths: months,
    revenue: byCurrency(rows),
    amountsCollectedAt: rows.map((r) => r.seenAt).sort().at(-1) ?? null,
    accounts: accounts.map((account) => {
      const mine = rows.filter((r) => r.accountId === account.id);
      return {
        accountId: account.id,
        label: account.label,
        connected: account.connected === 1,
        lastSuccessfulCollection: account.last_ok_at,
        collectionError: account.last_error,
        reportAvailable: answered.has(account.id),
        revenue: byCurrency(mine),
        apps: [...new Set(mine.map((r) => r.app))].map((app) => ({
          id: app,
          revenue: byCurrency(mine.filter((r) => r.app === app)),
        })),
      };
    }),
    note: "Revenue is reported net proceeds, not confirmation of a bank deposit. Null means no reported amount, never zero. Partial coverage is not a complete store total. Quote collection dates and any account errors; these are stored reports, not a live provider call.",
  };
}

export type MobileRevenueStore = ReturnType<typeof revenue>;

mobileRevenue.get("/", c => {
  const store = c.req.query("store") ?? "all";
  const month = c.req.query("month") ?? null;
  const unknown = Object.keys(c.req.query()).find(key => key !== "store" && key !== "month");
  if (unknown) return c.json({ error: `Unknown revenue parameter: ${unknown}. Use store and month.` }, 400);
  if (store !== "all" && !STORES.includes(store as Store))
    return c.json({ error: "store must be all, appstore, or playstore." }, 400);
  if (month !== null && !isMonth(month))
    return c.json({ error: "month must be YYYY-MM (Apple fiscal month or Google Play report month)." }, 400);
  return c.json({
    requestedMonth: month,
    selection: month ? "Requested report month" : "Latest available financial report month per store; these may differ",
    stores: (store === "all" ? STORES : [store as Store]).map(id => revenue(id, month)),
    combined: null,
    note: "Stores and currencies remain separate. Apple fiscal months and Google Play report months do not necessarily cover the same dates. Estimates are available in the default mobile view and are never added to this revenue.",
    generatedAt: new Date().toISOString(),
  });
});
