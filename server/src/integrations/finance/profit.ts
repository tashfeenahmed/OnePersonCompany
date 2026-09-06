/**
 * WHAT EACH BUSINESS ACTUALLY KEEPS — revenue in, costs out, per venture, per
 * month.
 *
 * FOUR RULES, and they are the document:
 *
 * 1. NEVER SUM CURRENCIES. Every figure below is a list keyed by currency
 *    code. A venture earning in USD on the App Store and paying for a server
 *    in EUR has TWO margins, not one, and `combined` is null on all of them
 *    until the owner types a rate — at which point the rate, its date and the
 *    word "approximately" go on the wire with the converted figure.
 *
 * 2. ACTUAL AND PROJECTED ARE NEVER THE SAME FIELD. A month that has closed
 *    carries `actual: true` and nothing else; the month in progress carries
 *    the measured part AND a projection, with the method named on the
 *    document. The method is one sentence — the daily average of the measured
 *    part, times the length of the month — and it is applied to REVENUE and
 *    MODEL SPEND only. Recurring costs are NOT prorated: a monthly server bill
 *    is owed in full on the third of the month, and prorating it would make
 *    every margin look wonderful until the 28th.
 *
 * 3. ALLOCATED COSTS ARE ESTIMATES AND SAY SO. A venture's own domain is a
 *    direct cost. A share of the control plane is an allocation of a real bill
 *    by a rule somebody chose, and every one of those lines carries the basis
 *    and the share it was computed from.
 *
 * 4. NULL IS ASKED AND NOT TOLD. A revenue source that reports nothing for the
 *    month is absent from the list with a reason, not a zero; an expense with
 *    no price is counted in `unpriced` and left out of the total, and the
 *    total says how many it is missing. A margin computed over an incomplete
 *    cost side carries `complete: false` and names what is missing.
 */
import { db, ventureRow, ventureRowById, now, type VentureRow } from "../../db.ts";
import { budgets } from "../../runtime/budgets.ts";
import {
  activeIn,
  allExpenses,
} from "./expenses.ts";
import {
  addTo,
  currencyCode,
  daysInMonth,
  elapsedDays,
  emptyTotals,
  isMonth,
  money,
  monthlyOf,
  projectProRata,
  shapeTotals,
  type CurrencyTotals,
  type Period,
} from "./money.ts";
import { allAllocations, defaultRule, shareFor, type AllocationRow } from "./allocations.ts";
import { stripeSettled, ventureRevenue, ventures, type RevenueLine } from "./attribution.ts";
import { powerLines } from "./power.ts";

/* Re-exported so routes can validate without importing three modules. */
export { isMonth };

export const PROJECTION_METHOD =
  "Pro-rata: the measured part of the month divided by the days elapsed, times the days in the month. " +
  "It assumes the rest of the month looks like the part that has happened, which is false for anything " +
  "seasonal. Recurring costs are NOT projected this way — a monthly bill is owed in full whatever the date.";

/* -------------------------------------------------------------- model spend */

export type ModelSpend = {
  /** Dollars, or null when there is no price to compute them from. */
  usd: number | null;
  tokens: number;
  calls: number;
  /** Calls whose token count was the reservation rather than a reported usage. */
  estimatedCalls: number;
  note: string;
};

/**
 * What this venture's own agent runs cost in model tokens over the month.
 *
 * READ OFF `budget_usage`, which the runtime writes one row per model call
 * with the venture it was running for. That makes it the ONLY per-venture
 * model figure on this box — /api/costs reports OpenAI and OpenRouter per
 * account and per project, which is the whole portfolio.
 *
 * ITS DOLLARS ARE A LOCAL MULTIPLICATION AND NOT A PROVIDER'S INVOICE. The
 * runtime prices a call at the `usdPerMillion` budget setting; where that is
 * zero — its default — the stored `usd` is structurally zero for every row,
 * and reporting it would be reporting a setting as a measurement. So `usd` is
 * NULL in that case with the reason, and the token count, which IS measured,
 * stands on its own.
 *
 * IT IS ALSO A PARTIAL VIEW AND SAYS SO. Work done through a connected agent
 * runtime rather than a direct provider is recorded with status
 * `unmetered-agent`: the call happened, the tokens are the reservation, and
 * the real spend lands on the provider's own bill.
 */
export function modelSpend(ventureId: string | null, month: string): ModelSpend {
  const price = budgets().usdPerMillion;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(tokens),0) AS tokens,
              COALESCE(SUM(usd),0) AS usd,
              SUM(CASE WHEN status <> 'reported' THEN 1 ELSE 0 END) AS estimated,
              SUM(CASE WHEN status = 'unmetered-agent' THEN 1 ELSE 0 END) AS agent
       FROM budget_usage
       WHERE at LIKE ? ${ventureId === null ? "" : "AND venture_id = ?"}`,
    )
    .get(...(ventureId === null ? [`${month}%`] : [`${month}%`, ventureId])) as {
      calls: number; tokens: number; usd: number; estimated: number | null; agent: number | null;
    };

  return {
    usd: price > 0 ? money(row.usd) : null,
    tokens: row.tokens,
    calls: row.calls,
    estimatedCalls: row.estimated ?? 0,
    note:
      (price > 0
        ? `Dollars are tokens × the ${price}/million price set in the run budgets, not a provider invoice.`
        : `No model price per million is set in the run budgets, so every stored dollar figure is structurally zero and none is reported. The token count is measured.`) +
      (row.agent
        ? ` ${row.agent} of ${row.calls} calls ran through a connected agent runtime: their tokens are the reservation, and their real spend is on that provider's own bill.`
        : "") +
      ` This is the runtime's own meter and covers only work dispatched through it; portfolio provider spend is on /api/costs.`,
  };
}

/* ------------------------------------------------------------------ costs */

export type CostLine = {
  expenseId: string;
  label: string;
  category: string;
  currency: string;
  /** This venture's share of the monthly run rate. Null when the expense has
   *  no price. */
  monthly: number | null;
  /** 1 for a direct cost; the allocated fraction for a shared one. */
  share: number;
  direct: boolean;
  /** How the share was decided. Absent on direct costs. */
  basis: string | null;
  estimated: boolean;
  confidence: string | null;
  note: string | null;
};

export type CostSide = {
  direct: CurrencyTotals;
  allocated: CurrencyTotals;
  total: CurrencyTotals;
  lines: CostLine[];
  /** Expenses with no price that this venture would have carried. Their names,
   *  so the gap is nameable rather than a count. */
  unpricedLabels: string[];
};

export function ventureCosts(ventureId: string, month: string): CostSide {
  const rows = allExpenses().filter((r) => activeIn(r, month));
  const allocations = allAllocations();
  const byExpense = new Map<string, AllocationRow[]>();
  for (const a of allocations) byExpense.set(a.expense_id, [...(byExpense.get(a.expense_id) ?? []), a]);
  const rule = defaultRule();
  const ventureCount = ventures().length;

  const direct = emptyTotals();
  const allocated = emptyTotals();
  const total = emptyTotals();
  const lines: CostLine[] = [];
  const unpricedLabels: string[] = [];

  for (const r of rows) {
    const monthly = monthlyOf(r.amount, r.period as Period);
    if (r.venture_id === ventureId) {
      if (monthly === null) unpricedLabels.push(r.label);
      addTo(direct, r.currency, monthly);
      addTo(total, r.currency, monthly);
      lines.push({
        expenseId: r.id, label: r.label, category: r.category, currency: currencyCode(r.currency),
        monthly: monthly === null ? null : money(monthly), share: 1, direct: true, basis: null, estimated: false,
        confidence: r.confidence, note: r.notes,
      });
      continue;
    }
    if (r.venture_id !== null) continue;
    const { share, basis } = shareFor(ventureId, byExpense.get(r.id) ?? [], rule, ventureCount);
    if (share <= 0) continue;
    const mine = monthly === null ? null : monthly * share;
    if (mine === null) unpricedLabels.push(r.label);
    addTo(allocated, r.currency, mine);
    addTo(total, r.currency, mine);
    lines.push({
      expenseId: r.id, label: r.label, category: r.category, currency: currencyCode(r.currency),
      monthly: mine === null ? null : money(mine), share: Number(share.toFixed(6)), direct: false, basis,
      estimated: true, confidence: r.confidence, note: r.notes,
    });
  }

  lines.sort((a, b) => (b.monthly ?? 0) - (a.monthly ?? 0) || a.label.localeCompare(b.label));
  return { direct, allocated, total, lines, unpricedLabels };
}

/* ----------------------------------------------------------------- margin */

/** Revenue minus costs, currency by currency, with every currency that appears
 *  on either side present in the result. A currency with revenue and no cost
 *  is a positive margin; a currency with cost and no revenue is a negative
 *  one, and neither may be dropped for looking odd. */
export function marginOf(revenue: CurrencyTotals, costs: CurrencyTotals): { currency: string; revenue: number; cost: number; margin: number }[] {
  const codes = [...new Set([...Object.keys(revenue.byCurrency), ...Object.keys(costs.byCurrency)])].sort();
  return codes.map((currency) => {
    const r = revenue.byCurrency[currency] ?? 0;
    const c = costs.byCurrency[currency] ?? 0;
    return { currency, revenue: money(r), cost: money(c), margin: money(r - c) };
  });
}

/* --------------------------------------------------------------- the P&L */

export type VenturePnl = ReturnType<typeof venturePnl>;

export function venturePnl(venture: VentureRow, month: string, nowIso = now()) {
  const total = daysInMonth(month);
  const elapsed = elapsedDays(month, nowIso);
  const closed = elapsed >= total;
  const started = elapsed > 0;

  const revenue = ventureRevenue(venture, month);
  const costs = ventureCosts(venture.id, month);
  const model = modelSpend(venture.id, month);

  /* Model spend is a COST and it is in dollars. It is kept out of `costs`
     (which is the ledger) and folded into the margin as its own currency line,
     so a reader can always see the ledger figure and the model figure apart. */
  const costsWithModel = { byCurrency: { ...costs.total.byCurrency }, unpriced: costs.total.unpriced };
  if (model.usd !== null && model.usd > 0)
    costsWithModel.byCurrency.USD = (costsWithModel.byCurrency.USD ?? 0) + model.usd;

  const projected = closed || !started
    ? null
    : {
      method: PROJECTION_METHOD,
      elapsedDays: Number(elapsed.toFixed(2)),
      daysInMonth: total,
      revenueNet: Object.entries(revenue.net.byCurrency)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, amount]) => ({ currency, amount: projectProRata(amount, elapsed, total) })),
      modelUsd: projectProRata(model.usd, elapsed, total),
      /* Costs are the run rate as they stand; nothing is scaled. Said here
         rather than left to be inferred from an absent field. */
      costs: "not projected — recurring costs are owed in full for the month",
    };

  return {
    month,
    venture: { id: venture.id, slug: venture.slug, name: venture.name, stage: venture.stage },
    /** True when the month has finished. The single flag every caption keys
     *  off: `false` means every figure here is a part-month. */
    actual: closed,
    started,
    elapsedDays: Number(elapsed.toFixed(2)),
    daysInMonth: total,
    revenue: {
      gross: shapeTotals(revenue.gross),
      net: shapeTotals(revenue.net),
      /** Live MRR for this venture's linked Stripe products. A RUN RATE — it
       *  is not money that arrived in this month and is never added to net. */
      subscriptionRunRate: revenue.runRate,
      lines: revenue.lines,
      unavailable: revenue.unavailable,
    },
    costs: {
      direct: shapeTotals(costs.direct),
      allocated: shapeTotals(costs.allocated),
      ledgerTotal: shapeTotals(costs.total),
      lines: costs.lines,
      unpriced: costs.unpricedLabels,
      /** False when a cost this venture carries has no price. The margin below
       *  is then a CEILING on profit, not the profit. */
      complete: costs.unpricedLabels.length === 0,
    },
    modelSpend: model,
    /** Ledger costs plus model dollars, per currency. */
    margin: marginOf(revenue.net, costsWithModel),
    projected,
    rules: [
      "Currencies are never added. Each row of `margin` is one currency's own arithmetic.",
      closed
        ? "This month has closed; every figure is a measurement of it."
        : started
          ? "This month is in progress. `revenue` and `modelSpend` cover the part measured so far; `projected` scales them and names the method. Costs are the full month's run rate."
          : "This month has not started. Nothing is measured and nothing is projected.",
      "Allocated costs are shares of real bills decided by a rule, not measurements of this venture's usage.",
      costs.unpricedLabels.length
        ? `${costs.unpricedLabels.length} cost(s) this venture carries have no price yet, so the margin is a ceiling: ${costs.unpricedLabels.slice(0, 4).join(", ")}.`
        : "Every cost this venture carries has a price.",
    ],
  };
}

/* ------------------------------------------------------------- portfolio */

/**
 * The whole operation for a month: every venture's line, plus the two things
 * that belong to no venture — unallocated shared cost, and the Stripe ledger,
 * which is measured at the portfolio and only ever estimated below it.
 */
export function portfolioPnl(month: string, nowIso = now()) {
  const list = ventures();
  const rows = allExpenses().filter((r) => activeIn(r, month));
  const allocations = allAllocations();
  const byExpense = new Map<string, AllocationRow[]>();
  for (const a of allocations) byExpense.set(a.expense_id, [...(byExpense.get(a.expense_id) ?? []), a]);
  const rule = defaultRule();

  const ledger = emptyTotals();
  const unallocated = emptyTotals();
  const unallocatedLines: { expenseId: string; label: string; currency: string; monthly: number | null; allocated: number }[] = [];
  for (const r of rows) {
    const monthly = monthlyOf(r.amount, r.period as Period);
    addTo(ledger, r.currency, monthly);
    if (r.venture_id !== null) continue;
    const shares = byExpense.get(r.id) ?? [];
    const assigned = shares.length
      ? shares.reduce((n, s) => n + s.share, 0)
      : rule === "equal" && list.length ? 1 : 0;
    const rest = Math.max(0, 1 - assigned);
    if (rest <= 0.0001) continue;
    addTo(unallocated, r.currency, monthly === null ? null : monthly * rest);
    unallocatedLines.push({
      expenseId: r.id, label: r.label, currency: currencyCode(r.currency),
      monthly, allocated: Number(assigned.toFixed(6)),
    });
  }

  const perVenture = list.map((v) => {
    const p = venturePnl(v, month, nowIso);
    return {
      venture: p.venture,
      actual: p.actual,
      revenueNet: p.revenue.net.amounts,
      costTotal: p.costs.ledgerTotal.amounts,
      modelUsd: p.modelSpend.usd,
      margin: p.margin,
      complete: p.costs.complete,
    };
  });

  return {
    month,
    actual: elapsedDays(month, nowIso) >= daysInMonth(month),
    generatedAt: nowIso,
    ventures: perVenture,
    ledger: {
      monthly: shapeTotals(ledger),
      unallocatedShared: shapeTotals(unallocated),
      unallocatedLines: unallocatedLines.sort((a, b) => (b.monthly ?? 0) - (a.monthly ?? 0)),
      defaultRule: rule,
    },
    /** The one Stripe figure on this box that IS dated per-venture-free money.
     *  Reported at the portfolio because that is the only level it is true at. */
    stripeSettled: stripeSettled(month),
    modelSpend: modelSpend(null, month),
    power: powerLines(month, nowIso),
    rules: [
      "Currencies are never added, at any level of this document.",
      "`stripeSettled` is the portfolio's measured settlement. The per-venture lines above do not contain it unless the mrr-share split is switched on, and where they do it is an allocation.",
      "`unallocatedShared` is real money nobody's margin is carrying. A portfolio with a large figure here has venture margins that are all too good.",
      "`power` is priced from typed-in wattage. `confidence: metered` means the HOURS were observed; the watts are always an estimate.",
    ],
  };
}

/** One venture by any key the caller had — id, slug, name or host. */
export function findVenture(key: string): VentureRow | undefined {
  return ventureRow(key) ?? ventureRowById(key);
}

export type { RevenueLine };
