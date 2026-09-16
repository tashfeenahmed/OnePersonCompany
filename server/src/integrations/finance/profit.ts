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
import { db, openAiCosts, openRouterActivity, ventureRow, ventureRowById, now, type VentureRow } from "../../db.ts";
import { budgets } from "../../runtime/budgets.ts";
import { expensesForMonth } from "./expenses.ts";
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
import {
  settledChargeSplit,
  stripeSettledMonth,
  unattributedNote,
  ventureRevenue,
  ventures,
  type ChargeSplit,
  type RevenueLine,
} from "./attribution.ts";
import { ledgerMonth, powerLines } from "./power.ts";

/* Re-exported so routes can validate without importing three modules. */
export { isMonth };

export const PROJECTION_METHOD =
  "Pro-rata: the measured part of the month divided by the days elapsed, times the days in the month. " +
  "It assumes the rest of the month looks like the part that has happened, which is false for anything " +
  "seasonal. Recurring costs are NOT projected this way — a monthly bill is owed in full whatever the date.";

/**
 * WHAT "REVENUE" MEANS ON THIS DOCUMENT, in one paragraph, on the wire.
 *
 * It is written once and published in three places — the portfolio's own
 * `revenue.basis`, the rules list, and the card that draws it — because a
 * basis that is explained on the page and not in the payload is a basis that
 * drifts the first time somebody rewords the page.
 */
export const REVENUE_BASIS = (onLedger: boolean): string =>
  onLedger
    ? "Revenue is settled money, not billings. A venture's Stripe line is the GROSS of the charges whose " +
      "product is linked to it, less refunds, and before Stripe's fees — a charge carries no fee, so a " +
      "per-venture figure net of fees would be an allocation rather than a measurement. The portfolio's " +
      "total is the settled LEDGER'S net for the month, so the fees, and every charge that reached no " +
      "venture, sit in `revenue.unallocated`: honest, because Stripe's fees are a shared cost of one " +
      "payment account and no venture's margin is carrying them yet. App Store and Play figures are the " +
      "stores' own net proceeds; AdSense is its own estimate."
    : "Revenue is settled money, not billings. No Stripe balance report has been collected for this month, " +
      "so the Stripe figures here are the CHARGES — gross less refunds — and Stripe's fees are not " +
      "subtracted anywhere. A venture's line is the charges whose product is linked to it; the rest is in " +
      "`revenue.unallocated` with the reason. App Store and Play figures are the stores' own net proceeds; " +
      "AdSense is its own estimate.";

/* -------------------------------------------------------------- model spend */

export type ModelSpend = {
  /**
   * ATTRIBUTED COST IN DOLLARS, from the provider's own invoice — or null when
   * no invoice covers the month. This is the figure margins are charged.
   */
  usd: number | null;
  /**
   * WHAT THE RUNTIME METER HOLDS, which is a RESERVATION and not a cost. The
   * enforcement meter prices a call at a flat `usdPerMillion` before the call
   * happens; that is what a budget needs and it is not what anybody was
   * billed. Null when no price is configured, because every stored dollar is
   * then structurally zero and a setting is not a measurement.
   */
  reservationUsd: number | null;
  tokens: number;
  calls: number;
  /** Calls whose token count was the reservation rather than a reported usage. */
  estimatedCalls: number;
  /** How `usd` was arrived at, or null when it could not be. */
  basis: "invoice" | "invoice-token-share" | null;
  /** True where `usd` is an apportionment of a real bill rather than a receipt. */
  estimated: boolean;
  /** The whole month's invoiced model spend, per provider. The denominator. */
  invoiced: { provider: string; usd: number }[];
  note: string;
};

/**
 * THE PROVIDERS' INVOICED DOLLARS FOR A MONTH.
 *
 * The measured half. `openai_costs` is money per day per project and
 * `openrouter_activity` is money per day per model; both are what the provider
 * says it charged. Replicate reports no money at all and is therefore absent
 * rather than zero — see /api/costs, which says the same thing at length.
 *
 * BYOK dollars are NOT added: OpenRouter routes those to the owner's own
 * provider key and bills them there, so counting them here would count them
 * twice the moment that provider is also connected.
 */
export function providerSpend(month: string): { provider: string; usd: number }[] {
  const inMonth = (day: string) => day.slice(0, 7) === month;
  const openai = openAiCosts(`${month}-01`).filter((r) => inMonth(r.day));
  const openrouter = openRouterActivity(`${month}-01`).filter((r) => inMonth(r.day));
  return [
    { provider: "openai", usd: money(openai.reduce((n, r) => n + r.usd, 0)) },
    { provider: "openrouter", usd: money(openrouter.reduce((n, r) => n + r.usd, 0)) },
  ].filter((p) => p.usd > 0);
}

/**
 * What this venture's own agent runs cost in model tokens over the month, and
 * what that is worth in the dollars somebody was actually invoiced.
 *
 * TWO METERS EXISTED FOR ONE DOLLAR AND ONLY ONE OF THEM WAS A MEASUREMENT.
 * `budget_usage` is the runtime's own meter: one row per model call, with the
 * venture it ran for, priced at the flat `usdPerMillion` budget setting and
 * RESERVED at the request's byte count before the call, corrected only if the
 * provider returns a usage block. That is exactly what a spending limit needs
 * and it is not a cost. Charging margins with it meant the P&L reported one
 * number while the provider's invoice sat on /api/costs reporting another,
 * with nothing reconciling them — and on the default settings, no price per
 * million, the reservation is structurally zero, so a venture's model cost was
 * silently nothing at all.
 *
 * SO THE INVOICE IS THE COST AND THE METER IS THE SHARE. The providers publish
 * per project and per model, never per venture, so a venture's cost is its
 * share of the invoice by metered tokens: an allocation of a real bill by a
 * stated rule, `estimated` with its basis attached, like every other allocated
 * cost here. A cheap model and an expensive one weigh the same per token, so
 * the split leans towards whoever ran the cheap one — a stated rule over a
 * measured total, which is the improvement, and still an allocation.
 *
 * IT IS A PARTIAL VIEW EITHER WAY. Work dispatched through a connected agent
 * runtime is recorded `unmetered-agent`: the tokens are the reservation and
 * the real spend lands on that provider's own bill, which may not be one of
 * the two read here.
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

  const invoiced = providerSpend(month);
  const total = invoiced.reduce((n, p) => n + p.usd, 0);
  const allTokens = ventureId === null
    ? row.tokens
    : (db
      .prepare("SELECT COALESCE(SUM(tokens),0) AS tokens FROM budget_usage WHERE at LIKE ?")
      .get(`${month}%`) as { tokens: number }).tokens;

  const share = ventureId === null ? 1 : allTokens > 0 ? row.tokens / allTokens : 0;
  const usd = !total ? null : ventureId !== null && allTokens <= 0 ? null : money(total * share);
  const basis = usd === null ? null : ventureId === null ? "invoice" as const : "invoice-token-share" as const;

  return {
    usd,
    reservationUsd: price > 0 ? money(row.usd) : null,
    tokens: row.tokens,
    calls: row.calls,
    estimatedCalls: row.estimated ?? 0,
    basis,
    estimated: basis === "invoice-token-share",
    invoiced,
    note:
      (usd === null
        ? `No provider invoice covers ${month} on this box, so there is no model cost to report; the token count is measured and stands on its own.`
        : ventureId === null
          ? `The providers' own invoiced dollars for ${month}, summed. A measurement.`
          : `${(share * 100).toFixed(1)}% of the ${money(total)} the providers invoiced for ${month}, apportioned by this venture's ${row.tokens.toLocaleString()} of ${allTokens.toLocaleString()} metered tokens. An allocation of a real bill: no provider publishes spend per venture, and tokens weigh the same here whatever the model cost.`) +
      (price > 0
        ? ` The runtime meter reserved ${money(row.usd)} at the ${price}/million budget price; that is an enforcement figure, not a cost, and nothing adds it to the above.`
        : ` No model price per million is set in the run budgets, so the runtime's own reservation figure is structurally zero and is not reported.`) +
      (row.agent
        ? ` ${row.agent} of ${row.calls} calls ran through a connected agent runtime: their tokens are the reservation, and their real spend is on that provider's own bill.`
        : "") +
      ` Portfolio provider spend, per provider and per day, is on /api/costs.`,
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
  const rows = expensesForMonth(month);
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

export function venturePnl(
  venture: VentureRow,
  month: string,
  nowIso = now(),
  /** The month's Stripe charge split, where the caller already has one — the
   *  portfolio reads it once for every venture rather than once each. */
  split: ChargeSplit = settledChargeSplit(month),
) {
  const total = daysInMonth(month);
  const elapsed = elapsedDays(month, nowIso);
  const closed = elapsed >= total;
  const started = elapsed > 0;

  const revenue = ventureRevenue(venture, month, split);
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
  const rows = expensesForMonth(month);
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

  /* ONE READ OF THE CHARGES FOR EVERY VENTURE BELOW. The split is also what
     the portfolio's own revenue rows are measured against, so computing it
     here rather than nineteen times inside `venturePnl` is not only cheaper —
     it is the guarantee that the ventures and the portfolio were told the
     same thing. */
  const split = settledChargeSplit(month);
  const pnls = list.map((v) => venturePnl(v, month, nowIso, split));

  const perVenture = pnls.map((p) => ({
    venture: p.venture,
    actual: p.actual,
    revenueNet: p.revenue.net.amounts,
    costTotal: p.costs.ledgerTotal.amounts,
    modelUsd: p.modelSpend.usd,
    margin: p.margin,
    complete: p.costs.complete,
  }));

  /*
    UNATTRIBUTED MODEL SPEND, so the portfolio's cost is every invoiced dollar.

    The per-venture figure is a share of the providers' invoice by METERED
    TOKENS, and a call the runtime ran with no venture on it — a scheduled
    sweep, a chat in the console, an agent working on the box itself — carries
    tokens and no share. Its dollars were invoiced all the same. Summing the
    ventures therefore understated the portfolio by exactly the unattributed
    share, silently, and the bigger the box's own housekeeping the bigger the
    hole. This is that difference, named beside the shared bills nobody's
    margin is carrying, because it is the same kind of fact.

    CLAMPED AT ZERO AND SAID SO. The per-venture share is computed from a rate
    card in one place and an invoice in another; where the shares add up past
    the invoice the remainder is zero rather than a negative cost, and the rule
    below says the arithmetic disagreed.
  */
  const portfolioModel = modelSpend(null, month);
  const allocatedModelUsd = pnls.reduce((n, p) => n + (p.modelSpend.usd ?? 0), 0);
  const allocatedModelTokens = pnls.reduce((n, p) => n + p.modelSpend.tokens, 0);
  const invoicedModelUsd = portfolioModel.usd ?? 0;
  const modelOverAllocated = invoicedModelUsd > 0 && allocatedModelUsd > invoicedModelUsd + 0.005;
  const modelRemainderUsd = money(Math.max(0, invoicedModelUsd - allocatedModelUsd));
  const modelRemainderTokens = Math.max(0, portfolioModel.tokens - allocatedModelTokens);
  if (modelRemainderUsd > 0) {
    addTo(unallocated, "USD", modelRemainderUsd);
    unallocatedLines.push({
      expenseId: "model-spend-unattributed",
      label: `Model spend, not attributed to a venture · ${modelRemainderTokens.toLocaleString()} tokens`,
      currency: "USD",
      monthly: modelRemainderUsd,
      allocated: 0,
    });
  }

  /*
    THE REVENUE SIDE, SHAPED LIKE THE COST SIDE — allocated, unallocated, total.

    THE BASIS, IN ONE SENTENCE: the portfolio's Stripe total is the SETTLED
    LEDGER'S NET for the month, and the ventures' Stripe lines are the GROSS of
    the charges attributed to their products, less refunds. The difference
    between the two — Stripe's fees, plus every charge that reached no venture
    — is the unallocated row. So the portfolio total is a measurement that ties
    to the ledger, the per-venture figures are measurements that tie to the
    charges, and the fees land where they belong: a shared cost of one payment
    account, carried by nobody's margin until somebody allocates them.

    WITHOUT A LEDGER there is no balance report on the account, and the total
    falls back to the charges themselves, gross less refunds, with the fees
    therefore missing from it. The basis text says which of the two this is.
  */
  const settled = stripeSettledMonth(month);
  const onLedger = settled.length > 0;

  const allocatedRevenue = emptyTotals();
  for (const p of pnls)
    for (const a of p.revenue.net.amounts) addTo(allocatedRevenue, a.currency, a.amount);

  /* What the mrr-share split already handed to the ventures out of the
     remainder. It is inside `allocatedRevenue` above, so it must come out of
     the unallocated figure or the same money appears in both. */
  const apportioned: Record<string, number> = {};
  for (const p of pnls)
    for (const l of p.revenue.lines)
      if (l.basis === "mrr-share")
        apportioned[l.currency] = (apportioned[l.currency] ?? 0) + l.net;

  const unattributedByCurrency = new Map(split.unattributed.map((u) => [u.currency, u]));
  const revenueCurrencies = [
    ...new Set([
      ...settled.map((s) => s.currency),
      ...split.unattributed.map((u) => u.currency),
      ...Object.keys(split.attributed),
    ]),
  ].sort();

  const unallocatedRevenue = revenueCurrencies
    .map((currency) => {
      const u = unattributedByCurrency.get(currency);
      const ledgerNet = settled.find((s) => s.currency === currency)?.net ?? 0;
      const taken = split.attributed[currency]?.net ?? 0;
      const given = apportioned[currency] ?? 0;
      const amount = money(onLedger ? ledgerNet - taken - given : (u?.net ?? 0) - given);
      return {
        currency,
        amount,
        charges: u?.count ?? 0,
        note:
          (onLedger
            ? `${money(ledgerNet)} ${currency} settled on Stripe's ledger for ${month}, less ${money(taken)} ` +
              `attributed to ventures by the product their charges paid for` +
              (given > 0 ? ` and ${money(given)} apportioned by the mrr-share split` : "") +
              `. What is left is Stripe's fees on the whole account plus any charge that reached no venture`
            : `No Stripe balance report has been collected for ${month}, so this is the charges themselves, ` +
              `gross less refunds, and Stripe's fees are not in it`) +
          (u
            ? `: ${u.count} charge${u.count === 1 ? "" : "s"} worth ${money(u.net)} ${currency} — ` +
              `${unattributedNote(u.reasons)}` +
              (u.products.length ? `; the products nobody has linked are ${u.products.slice(0, 6).join(", ")}` : "")
            : "; every charge in the month reached a venture") +
          (amount < 0
            ? ". This figure is NEGATIVE: the ledger dates money by settlement and a charge by its creation, " +
              "so a charge made at the end of a month settles in the next one. It is left signed rather than " +
              "floored, because flooring it would make the total below stop being the ledger's."
            : "."),
      };
    })
    .filter((r) => r.amount !== 0 || r.charges > 0);

  const totalRevenue = emptyTotals();
  for (const [currency, amount] of Object.entries(allocatedRevenue.byCurrency))
    addTo(totalRevenue, currency, amount);
  for (const r of unallocatedRevenue) addTo(totalRevenue, r.currency, r.amount);

  return {
    month,
    actual: elapsedDays(month, nowIso) >= daysInMonth(month),
    generatedAt: nowIso,
    ventures: perVenture,
    /**
     * THE PORTFOLIO'S OWN REVENUE, so that nothing has to add the ventures up
     * and hope. `allocated` is what the ventures earned, `unallocated` is the
     * settled Stripe cash that reached none of them, and `total` is the two
     * added WITHIN each currency. A reader that sums `ventures[].margin[]`
     * gets `allocated` and silently drops the rest, which is the defect this
     * block exists to make impossible.
     */
    revenue: {
      allocated: shapeTotals(allocatedRevenue),
      unallocated: unallocatedRevenue,
      total: shapeTotals(totalRevenue),
      basis: REVENUE_BASIS(onLedger),
    },
    ledger: {
      monthly: shapeTotals(ledger),
      unallocatedShared: shapeTotals(unallocated),
      /* Sorted by what is actually UNALLOCATED, not by the size of the bill: a
         fully-split €13 box belongs below a €7 one nobody has touched, because
         the question this list answers is "what is nobody carrying". */
      unallocatedLines: unallocatedLines.sort(
        (a, b) => (b.monthly ?? 0) * (1 - b.allocated) - (a.monthly ?? 0) * (1 - a.allocated),
      ),
      defaultRule: rule,
    },
    /** The one Stripe figure on this box that IS dated per-venture-free money.
     *  Reported at the portfolio because that is the only level it is true at. */
    stripeSettled: settled,
    modelSpend: portfolioModel,
    /*
      THE ELECTRICITY DETAIL BEHIND ROWS THAT ARE ALREADY IN `ledger.monthly`,
      and NOT a second set of euros.

      This used to be recomputed for the month asked about while the seeded
      ledger rows priced the month before, so one payload carried the same
      electricity twice on two month bases and nothing said the ledger already
      contained it. There is one producer now — `seedPower` writes the rows,
      and this is those same rows' working, on the same month basis. Adding it
      to `ledger.monthly` counts it twice; the rule below says so on the wire.
    */
    power: powerLines(ledgerMonth(nowIso), nowIso).map((line) => ({
      ...line,
      month: ledgerMonth(nowIso),
      inLedger: true as const,
    })),
    rules: [
      "Currencies are never added, at any level of this document.",
      REVENUE_BASIS(onLedger),
      "`stripeSettled` is the portfolio's measured settlement, and `revenue.total` ties to its net. A charge whose product is linked to a venture is in that venture's line; everything else is in `revenue.unallocated`, which names why.",
      "`unallocatedShared` is real money nobody's margin is carrying — shared bills nobody has allocated, plus the invoiced model spend no venture's tokens account for. A portfolio with a large figure here has venture margins that are all too good. Model spend is not in `ledger.monthly`, which is the expense rate card only.",
      modelOverAllocated
        ? `The ventures' model shares add up to ${money(allocatedModelUsd)} against ${money(invoicedModelUsd)} invoiced, so the unattributed remainder is reported as zero rather than as a negative cost. The shares are computed from metered tokens and the invoice from the providers; they are two meters and they have disagreed.`
        : `Every invoiced model dollar is carried: ${money(allocatedModelUsd)} by the ventures and ${money(modelRemainderUsd)} by nobody, against ${money(invoicedModelUsd)} invoiced.`,
      `\`power\` is the working behind the electricity rows already counted in \`ledger.monthly\` — the same money, not more of it, and never added to the ledger total. It is priced for ${ledgerMonth(nowIso)}, the last complete month, because a ledger row is a run rate and a part-month is not one. \`confidence: metered\` means the HOURS were observed; the watts are always an estimate.`,
    ],
  };
}

/** One venture by any key the caller had — id, slug, name or host. */
export function findVenture(key: string): VentureRow | undefined {
  return ventureRow(key) ?? ventureRowById(key);
}

export type { RevenueLine };
