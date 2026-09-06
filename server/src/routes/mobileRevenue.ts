import { Hono } from "hono";
import { accountRows, appStorePayouts, appStoreReports, getPlugin, playEarnings, playFiles } from "../db.ts";

export const mobileRevenue = new Hono();
const STORES = ["appstore", "playstore"] as const;
type Store = typeof STORES[number];
type Amount = { currency: string; amount: number };

function sum(rows: Amount[]): Amount[] | null {
  if (!rows.length) return null;
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
  return [...totals].sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount: Number(amount.toFixed(2)) }));
}

/** Report months, not rolling days. Never substitute sales estimates for earnings. */
function revenue(store: Store, requestedMonth: string | null) {
  const plugin = getPlugin(store);
  const connected = plugin?.connected === 1;
  const accounts = accountRows(store);
  const ids = new Set(accounts.filter(a => a.connected === 1).map(a => a.id));
  const reports = store === "appstore"
    ? appStoreReports("finance").filter(r => ids.has(r.account_id) && r.state === "reported")
      .map(r => ({ accountId: r.account_id, month: r.period }))
    : accounts.filter(a => ids.has(a.id)).flatMap(a => [...playFiles(a.id).keys()]
      .filter(key => /^earnings\/\d{6}$/.test(key))
      .map(key => ({ accountId: a.id, month: `${key.slice(-6, -2)}-${key.slice(-2)}` })));
  const availableMonths = connected ? [...new Set(reports.map(r => r.month))].sort() : [];
  const month = requestedMonth ?? availableMonths.at(-1) ?? null;
  const rows = store === "appstore"
    ? appStorePayouts().filter(r => r.month === month)
      .map(r => ({ accountId: r.account_id, app: r.app_id || null, currency: r.currency, amount: r.amount, seenAt: r.seen_at }))
    : playEarnings().filter(r => r.month === month?.replace("-", ""))
      .map(r => ({ accountId: r.account_id, app: r.package || null, currency: r.currency, amount: r.net, seenAt: r.seen_at }));
  const byAccount = accounts.map(account => {
    const reported = connected && reports.some(r => r.accountId === account.id && r.month === month);
    const mine = reported ? rows.filter(r => r.accountId === account.id) : [];
    return {
      accountId: account.id,
      label: account.label,
      connected: account.connected === 1,
      lastSuccessfulCollection: account.last_ok_at,
      collectionError: account.last_error,
      reportAvailable: reported,
      revenue: sum(mine),
      apps: [...new Set(mine.map(r => r.app))].map(app => ({
        id: app, revenue: sum(mine.filter(r => r.app === app)),
      })),
    };
  });
  const reportedIds = new Set(byAccount.filter(a => a.reportAvailable).map(a => a.accountId));
  const measured = connected ? rows.filter(r => reportedIds.has(r.accountId)) : [];
  return {
    store,
    connected,
    collectionError: plugin?.last_error ?? null,
    status: !connected ? "not_connected" : !reportedIds.size ? "not_reported"
      : reportedIds.size < accounts.length ? "partial" : "reported",
    month,
    periodBasis: store === "appstore" ? "Apple fiscal month" : "Google Play report month",
    source: store === "appstore" ? "App Store Connect finance report: extended partner share"
      : "Google Play earnings report: net merchant earnings",
    availableMonths,
    revenue: sum(measured),
    amountsCollectedAt: measured.map(r => r.seenAt).sort().at(-1) ?? null,
    accounts: byAccount,
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
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
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
