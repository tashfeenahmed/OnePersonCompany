import { call } from "@/lib/api";

/**
 * THE FINANCE AREA FROM THIS SIDE — the operating-cost ledger and the profit
 * model.
 *
 * EVERY MONEY FIELD HERE IS A LIST KEYED BY CURRENCY, and the types say so
 * rather than leaving it to a comment. `Amounts.combined` is typed `null` — it
 * is not "usually null", it is a field that exists so no page has to wonder
 * whether it may add euro to dollars. The one converted figure lives on its
 * own endpoint and carries the rate the owner typed and the word approximate.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. Where the server says
 * `amount: null` this says `number | null` and the page draws a dash with the
 * reason in the row's note: a cost whose price nobody has established is not a
 * free one, and a table that rendered it as 0.00 would be the whole failure
 * this area exists to avoid.
 */

export type Amounts = {
  amounts: { currency: string; amount: number }[];
  /** How many rows had no price and are therefore NOT in `amounts`. */
  unpriced: number;
  /** Always null. There is no total across currencies. */
  combined: null;
};

export type Period = "monthly" | "yearly" | "once";
export type Category = "server" | "domain" | "service" | "subscription" | "salary" | "other";
export type RenewalDecision = "keep" | "cancel" | "undecided";
export type Basis = "equal" | "manual" | "revenue" | "traffic";

export type Allocation = {
  ventureId: string;
  venture: string | null;
  share: number;
  basis: Basis;
  note: string | null;
  updatedAt: string;
};

export type Expense = {
  id: string;
  ventureId: string | null;
  venture: string | null;
  shared: boolean;
  label: string;
  category: string;
  /** Null is a cost with no known price. Never render it as zero. */
  amount: number | null;
  currency: string;
  period: Period;
  monthly: number | null;
  annual: number | null;
  startsOn: string | null;
  endsOn: string | null;
  renewalOn: string | null;
  renewalDecision: RenewalDecision;
  /** Anything but "manual" is refreshed from a provider on every collection. */
  source: string;
  sourceRef: string | null;
  notes: string | null;
  /** "metered" or "estimated" on rows whose amount depends on observed usage. */
  confidence: string | null;
  archived: boolean;
  /** Columns the owner corrected; a refresh never overwrites these. */
  ownerFields: string[];
  updatedAt: string;
  allocations?: Allocation[];
};

export type FinanceSummary = {
  generatedAt: string;
  counts: {
    expenses: number; shared: number; allocated: number; unallocated: number; unpriced: number;
    bySource: Record<string, number>; byCategory: Record<string, number>;
  };
  monthly: Amounts;
  annual: Amounts;
  converted: { currency: string; amount: number; approximate: true; rates: Rate[]; note: string } | { error: string } | null;
  fx: { displayCurrency: string | null; rates: Rate[]; errors: string[]; reference: ReferenceRates | null };
  /** Whether, and when, Dynadot's own renewal list priced the domain rows.
   *  Null before the first read — "unpriced" then means nobody has looked. */
  registrarPrices: { tlds: number; priceLevel: string | null; currency: string; fetchedAt: string } | null;
  /** `within90Days` counts only renewals still ahead; a date that has
   *  already passed is counted apart, in `overdue`. */
  renewals: { within90Days: number; undecided: number; overdue: number };
  defaultAllocation: "none" | "equal";
  /** What Stripe is holding, per currency, as the collector last saw it. NOT a
   *  runway and never divided by anything: money in Stripe is money Stripe
   *  has, and nothing on this box knows the burn. Null when no account has
   *  reported a balance. `seenAt` is the stalest account's reading. */
  stripeBalance: {
    currencies: { currency: string; available: number; pending: number }[];
    seenAt: string;
  } | null;
  tariff: { perKwh: number | null; currency: string };
  note: string;
};

export type Rate = {
  from: string;
  to: string;
  rate: number;
  asOf: string | null;
  /** Who said so — the owner on the Finance page, or the ECB's daily file. */
  source?: "typed" | "ecb";
};

/**
 * The ECB's daily reference rates as the server cached them: how many of
 * each currency one euro buys, and the business day the file is for. Here so
 * a card can put two currencies on one axis and NAME the rate — never a
 * total, and it makes none. See lib/fx for the cross rate.
 */
export type ReferenceRates = {
  base: string;
  asOf: string;
  fetchedAt: string;
  rates: Record<string, number>;
};

export type ExpensesDoc = {
  count: number;
  monthly: Amounts;
  annual: Amounts;
  expenses: Expense[];
  note: string;
};

export type Renewal = Expense & { inDays: number };

export type RenewalsDoc = {
  window: { days: number; through: string };
  count: number;
  undecided: number;
  overdue: number;
  renewals: Renewal[];
  note: string;
};

export type AllocationsDoc = {
  defaultRule: "none" | "equal";
  ventures: { id: string; slug: string; name: string; stage: string }[];
  shared: (Expense & { allocations: Allocation[]; assignedShare: number; unallocatedShare: number })[];
  note: string;
};

export type RevenueLine = {
  source: "appstore" | "playstore" | "adsense" | "stripe" | "stripe-charges";
  kind: string;
  currency: string;
  gross: number | null;
  net: number;
  basis: "link" | "host" | "mrr-share";
  estimated: boolean;
  note: string;
};

export type CostLine = {
  expenseId: string;
  label: string;
  category: string;
  currency: string;
  monthly: number | null;
  share: number;
  direct: boolean;
  basis: string | null;
  estimated: boolean;
  confidence: string | null;
  note: string | null;
};

export type ModelSpend = {
  /** Null when no model price per million is configured — the tokens are still
   *  measured. Never read as $0. */
  usd: number | null;
  tokens: number;
  calls: number;
  estimatedCalls: number;
  note: string;
};

export type MarginRow = { currency: string; revenue: number; cost: number; margin: number };

export type VenturePnl = {
  month: string;
  venture: { id: string; slug: string; name: string; stage: string };
  /** True only when the month has closed. */
  actual: boolean;
  started: boolean;
  elapsedDays: number;
  daysInMonth: number;
  revenue: {
    gross: Amounts;
    net: Amounts;
    /** Live MRR. A run rate, never added to net. */
    subscriptionRunRate: { currency: string; amount: number }[];
    lines: RevenueLine[];
    unavailable: string[];
  };
  costs: {
    direct: Amounts;
    allocated: Amounts;
    ledgerTotal: Amounts;
    lines: CostLine[];
    unpriced: string[];
    complete: boolean;
  };
  modelSpend: ModelSpend;
  margin: MarginRow[];
  projected: {
    method: string;
    elapsedDays: number;
    daysInMonth: number;
    revenueNet: { currency: string; amount: number | null }[];
    modelUsd: number | null;
    costs: string;
  } | null;
  rules: string[];
};

export type PortfolioPnl = {
  month: string;
  actual: boolean;
  generatedAt: string;
  ventures: {
    venture: { id: string; slug: string; name: string; stage: string };
    actual: boolean;
    revenueNet: { currency: string; amount: number }[];
    costTotal: { currency: string; amount: number }[];
    modelUsd: number | null;
    margin: MarginRow[];
    complete: boolean;
  }[];
  /**
   * THE PORTFOLIO'S OWN REVENUE. Read this rather than summing
   * `ventures[].margin[].revenue`: that sum is `allocated` and silently drops
   * every settled charge that reached no venture.
   */
  revenue: {
    /** What the ventures earned, per currency. */
    allocated: Amounts;
    /** Settled Stripe cash no venture is carrying — Stripe's fees on the whole
     *  account, plus charges whose product names no venture. `note` says which
     *  and why; the amount is signed, and a negative one is explained. */
    unallocated: { currency: string; amount: number; charges: number; note: string }[];
    /** The two added, within each currency and never across. */
    total: Amounts;
    /** What "revenue" means on this document, in one paragraph. */
    basis: string;
  };
  ledger: {
    monthly: Amounts;
    unallocatedShared: Amounts;
    unallocatedLines: { expenseId: string; label: string; currency: string; monthly: number | null; allocated: number }[];
    defaultRule: "none" | "equal";
  };
  stripeSettled: { currency: string; gross: number; fees: number; taxWithheld: number; net: number }[];
  modelSpend: ModelSpend;
  power: PowerLine[];
  rules: string[];
};

export type PowerLine = {
  machineId: string;
  label: string;
  amount: number | null;
  currency: string;
  kwh: number | null;
  watts: { idle: number; busy: number };
  perKwh: number | null;
  /** About the HOURS. The watts are typed in whatever this says. */
  confidence: "metered" | "estimated" | null;
  wattsEstimated: true;
  hours: { awake: number; busy: number; covered: number; inMonth: number } | null;
  samples: number;
  source: string;
  note: string;
};

export type PowerDoc = {
  month: string;
  tariff: { perKwh: number | null; currency: string };
  profiles: {
    machineId: string; label: string | null; idleWatts: number; busyWatts: number;
    ratePerKwh: number | null; currency: string; timezone: string | null; alwaysOn: boolean; updatedAt: string;
  }[];
  lines: PowerLine[];
  /** `gone` marks a profile whose workstation account was deleted: it is
   *  still priced and still in the ledger, so it is listed to be removed on
   *  purpose rather than hidden. */
  machines: { machineId: string; label: string; hasProfile: boolean; gone?: true }[];
  note: string;
};

/**
 * THE LEDGER AS ONE DOCUMENT, for the dashboard cards.
 *
 * Four reads the Finance page makes one tab at a time, gathered once so a
 * board of eight cost cards is one round of requests rather than eight — and
 * so every card on it is drawn from the same moment: a servers card summed
 * from one read and a "where it goes" donut from another, thirty seconds
 * apart across a provider refresh, would disagree about the bill.
 */
export type FinanceReport = {
  summary: FinanceSummary;
  expenses: Expense[];
  renewals: RenewalsDoc;
  power: PowerDoc;
};

export const finance = {
  summary: () => call<FinanceSummary>("/finance"),
  report: async (): Promise<FinanceReport> => {
    const [summary, expenses, renewals, power] = await Promise.all([
      call<FinanceSummary>("/finance"),
      call<ExpensesDoc>("/finance/expenses"),
      call<RenewalsDoc>("/finance/renewals?days=90"),
      call<PowerDoc>("/finance/power"),
    ]);
    return { summary, expenses: expenses.expenses, renewals, power };
  },
  expenses: (params: { venture?: string; category?: string; archived?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.venture) q.set("venture", params.venture);
    if (params.category) q.set("category", params.category);
    if (params.archived) q.set("archived", "true");
    const s = q.toString();
    return call<ExpensesDoc>(`/finance/expenses${s ? `?${s}` : ""}`);
  },
  createExpense: (body: Record<string, unknown>) =>
    call<{ expense: Expense }>("/finance/expenses", { method: "POST", body: JSON.stringify(body) }),
  updateExpense: (id: string, body: Record<string, unknown>) =>
    call<{ expense: Expense; note: string }>(`/finance/expenses/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeExpense: (id: string) =>
    call<{ result: "deleted" | "archived"; note: string }>(`/finance/expenses/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setRenewal: (id: string, decision: RenewalDecision) =>
    call<{ expense: Expense }>(`/finance/expenses/${encodeURIComponent(id)}/renewal`, { method: "POST", body: JSON.stringify({ decision }) }),
  renewals: (days = 90) => call<RenewalsDoc>(`/finance/renewals?days=${days}`),
  allocations: () => call<AllocationsDoc>("/finance/allocations"),
  setAllocations: (expenseId: string, shares: { ventureId: string; share: number }[], basis: Basis) =>
    call<{ expenseId: string; allocations: Allocation[] }>(`/finance/allocations/${encodeURIComponent(expenseId)}`, {
      method: "PUT", body: JSON.stringify({ shares, basis }),
    }),
  autoAllocate: (expenseId: string, basis: Basis, month?: string) =>
    call<{ written: number; basis: Basis; explanation: string; skipped: { ventureId: string; why: string }[]; note?: string }>(
      `/finance/allocations/${encodeURIComponent(expenseId)}/auto`,
      { method: "POST", body: JSON.stringify({ basis, month }) },
    ),
  unallocated: () => call<{ count: number; defaultRule: string; monthly: Amounts; expenses: Expense[]; note: string }>("/finance/unallocated"),
  portfolio: (month?: string) => call<PortfolioPnl>(`/finance/profit/portfolio${month ? `?month=${month}` : ""}`),
  venture: (key: string, month?: string) =>
    call<VenturePnl>(`/finance/profit/${encodeURIComponent(key)}${month ? `?month=${month}` : ""}`),
  power: (month?: string) => call<PowerDoc>(`/finance/power${month ? `?month=${month}` : ""}`),
  savePower: (machineId: string, body: Record<string, unknown>) =>
    call<{ profile: unknown; note: string }>(`/finance/power/${encodeURIComponent(machineId)}`, { method: "PUT", body: JSON.stringify(body) }),
  removePower: (machineId: string) =>
    call<{ removed: boolean }>(`/finance/power/${encodeURIComponent(machineId)}`, { method: "DELETE" }),
  refresh: () =>
    call<{ hetzner: SeedCounts; registrar: SeedCounts; power: SeedCounts; domainsRelinked: number; monthly: Amounts; note: string }>(
      "/finance/refresh", { method: "POST" },
    ),
};

export type SeedCounts = { added: number; refreshed: number; unchanged: number; archived: number };
