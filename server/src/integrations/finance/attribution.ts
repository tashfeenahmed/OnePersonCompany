/**
 * WHICH BUSINESS EARNED IT — the revenue half of a per-venture P&L, and the
 * one place in this area where a figure could be invented if nobody was
 * careful.
 *
 * THE JOIN IS `venture_links` AND NOTHING ELSE. A Stripe product, an App Store
 * app id and a Play package reach a venture because the owner (or the venture
 * map's accept-all) said they belong to it. Nothing here matches on a
 * hostname, a prefix or a similar-looking name: two businesses on one box can
 * differ only by their top-level domain, and a revenue figure captioned with
 * the wrong company's name is the exact failure this dashboard exists not to
 * commit.
 *
 * THREE SOURCES ANSWER PER VENTURE AND ONE DOES NOT, and the fourth is the
 * interesting one:
 *
 *   app stores  Apple's finance report and Google's earnings report are per
 *               app per report month per currency. Measured, settled, dated.
 *   AdSense     per site per month, and the site is matched to a venture's own
 *               `host` — AdSense publishes no entity the venture map links, so
 *               this is the one host match here and it is labelled `basis:
 *               "host"` on every row it produces.
 *   Stripe      subscriptions carry a product name, so a venture's MRR is
 *               knowable — but MRR is a RUN RATE this app normalises, not
 *               money that arrived in a month. The settled ledger, which IS
 *               dated money, has no product dimension at all: `stripe_ledger_days`
 *               is per account per day per currency and nothing more.
 *
 * SO STRIPE'S SETTLED REVENUE IS NOT SPLIT PER VENTURE BY DEFAULT, and the
 * P&L says so in words rather than quietly leaving it out. The owner can
 * switch on `stripe_split = mrr-share`, which apportions the portfolio's
 * settled net by each venture's share of live MRR in that currency; every
 * figure it produces is stamped `estimated: true` with the basis attached. It
 * is off until somebody chooses it because the difference between "this
 * venture settled €412" and "this venture's share of a portfolio figure works
 * out at €412" is the difference between a measurement and an allocation.
 */
import {
  adSenseMonths,
  configValue,
  db,
  stripeLedgerDays,
  stripeSubscriptions,
  ventureRows,
  type VentureRow,
} from "../../db.ts";
import { linkedEntities, linkIndex, normaliseEntity } from "../ventures/links.ts";
import { payoutsForMonth } from "../mobilehealth/payouts.ts";
import { isBilling } from "../../providers/stripe.ts";
import { PLUGIN } from "./expenses.ts";
import { addTo, currencyCode, daysInMonth, emptyTotals, money, type CurrencyTotals } from "./money.ts";

const owns = (index: Map<string, string[]>, entity: string | null, ventureId: string): boolean =>
  (index.get(normaliseEntity(entity)) ?? []).includes(ventureId);

export type RevenueLine = {
  source: "appstore" | "playstore" | "adsense" | "stripe";
  /** What the figure IS, in the source's own words. */
  kind: string;
  currency: string;
  /** Before the platform's cut, where the source reports one. Null where the
   *  source only ever publishes the net figure. */
  gross: number | null;
  net: number;
  /** How the line reached this venture. `link` is a stored venture link, `host`
   *  is a match on the venture's own hostname, `mrr-share` is an allocation. */
  basis: "link" | "host" | "mrr-share";
  /** True where the number is an apportionment rather than a receipt. */
  estimated: boolean;
  note: string;
};

/* ---------------------------------------------------------------- stores */

function storeLines(venture: VentureRow, month: string): RevenueLine[] {
  const apple = linkIndex("appstore");
  const google = linkIndex("playstore");
  const out: RevenueLine[] = [];

  /* THE ROWS COME THROUGH THE REPORT GATE, which this area used to skip. A
     payout whose finance report has not been seen to arrive is withheld by
     /api/mobile/revenue, and a margin charged against money that document will
     not show is a margin nobody can check. One helper, one gate. */
  for (const p of payoutsForMonth(month)) {
    const index = p.store === "appstore" ? apple : google;
    if (!owns(index, p.app, venture.id)) continue;
    out.push(
      p.store === "appstore"
        ? {
          source: "appstore",
          kind: "Apple finance report: extended partner share",
          currency: p.currency,
          /* Apple's finance report publishes the developer's proceeds. The gross
             customer price is in the SALES report, which is an estimate on a
             different calendar, so there is no gross here rather than a wrong one. */
          gross: null,
          net: p.net,
          basis: "link",
          estimated: false,
          note: "Apple fiscal month; proceeds after Apple's commission. Not confirmation of a bank deposit.",
        }
        : {
          source: "playstore",
          kind: "Google Play earnings report: net merchant earnings",
          currency: p.currency,
          gross: p.charged,
          net: p.net,
          basis: "link",
          estimated: false,
          note: `Charged ${money(p.charged ?? 0)} less refunds ${money(p.refunds ?? 0)} and fees ${money(p.fees ?? 0)} over ${p.transactions ?? 0} transactions.`,
        },
    );
  }
  return out;
}

/* --------------------------------------------------------------- adsense */

function adsenseLines(venture: VentureRow, month: string): RevenueLine[] {
  const host = (venture.host ?? "").replace(/^www\./i, "").toLowerCase();
  if (!host) return [];
  const out: RevenueLine[] = [];
  for (const m of adSenseMonths()) {
    if (m.month !== month) continue;
    if (m.site.replace(/^www\./i, "").toLowerCase() !== host) continue;
    out.push({
      source: "adsense",
      kind: "AdSense estimated earnings for the month",
      currency: currencyCode(m.currency),
      gross: null,
      net: m.usd,
      basis: "host",
      estimated: true,
      note:
        `Matched to this venture because the AdSense site “${m.site}” is its host. AdSense publishes no entity ` +
        `the venture map can link, so this is a hostname match rather than a stored link. Earnings are Google's ` +
        `own estimate and are revised after the month closes.`,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- stripe */

/** A venture's live MRR per currency, from the subscriptions whose PRODUCT is
 *  linked to it. A run rate, never a receipt. */
export function ventureMrr(ventureId: string): Record<string, number> {
  const products = linkIndex("stripe");
  const out: Record<string, number> = {};
  for (const s of stripeSubscriptions()) {
    if (!isBilling(s.status)) continue;
    if (!owns(products, s.product, ventureId)) continue;
    const code = currencyCode(s.currency);
    out[code] = (out[code] ?? 0) + s.monthly_usd;
  }
  return out;
}

/** The whole book's MRR per currency — the denominator of the mrr-share
 *  basis, including subscriptions belonging to no venture at all. */
export function portfolioMrr(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stripeSubscriptions()) {
    if (!isBilling(s.status)) continue;
    const code = currencyCode(s.currency);
    out[code] = (out[code] ?? 0) + s.monthly_usd;
  }
  return out;
}

/**
 * THE SETTLED STRIPE LEDGER, REDUCED ONCE.
 *
 * Two reductions of `stripe_ledger_days` used to exist — a rolling window on
 * the revenue route keyed “usd” at two places, and a calendar month here keyed
 * “USD” at four. Same five fields, same rows, two answers, and one currency
 * held under two keys so nothing downstream could join them.
 *
 * This is the only one. The WINDOW is the caller's — `from` and `to` are
 * inclusive `YYYY-MM-DD` days — because a rolling thirty days and a calendar
 * month are two legitimate questions; the ARITHMETIC and the currency spelling
 * are not the caller's, and that is the whole point.
 *
 * Rounding happens once, at the end. Every field is summed at full precision
 * first: rounding each row and then adding is how the two copies drifted apart
 * in the first place.
 */
export type SettledCurrency = {
  currency: string;
  gross: number;
  fees: number;
  taxWithheld: number;
  feesTotal: number;
  refunds: number;
  disputes: number;
  other: number;
  net: number;
  transactions: number;
  feeBreakdown: {
    processing: number;
    managedPayments: number;
    disputes: number;
    billing: number;
    other: number;
  };
  /** Per-day, oldest first, for whatever draws a line. Unrounded sums rounded
   *  once here like everything else. */
  days: { day: string; gross: number; fees: number; net: number }[];
};

export function stripeSettled(from: string, to: string): SettledCurrency[] {
  const rows = stripeLedgerDays(from).filter((r) => r.day <= to);
  const codes = [...new Set(rows.map((r) => currencyCode(r.currency)))].sort();
  return codes.map((currency) => {
    const mine = rows.filter((r) => currencyCode(r.currency) === currency);
    const sum = (f: (r: (typeof mine)[number]) => number) => money(mine.reduce((n, r) => n + f(r), 0));
    const byDay = new Map<string, { day: string; gross: number; fees: number; net: number }>();
    for (const r of mine) {
      const d = byDay.get(r.day) ?? { day: r.day, gross: 0, fees: 0, net: 0 };
      d.gross += r.gross;
      d.fees += r.fees;
      d.net += r.net;
      byDay.set(r.day, d);
    }
    return {
      currency,
      gross: sum((r) => r.gross),
      fees: sum((r) => r.fees),
      taxWithheld: sum((r) => r.tax_withheld),
      feesTotal: sum((r) => r.fees_total),
      refunds: sum((r) => r.refunds),
      disputes: sum((r) => r.disputes),
      other: sum((r) => r.other),
      net: sum((r) => r.net),
      transactions: mine.reduce((n, r) => n + r.count, 0),
      feeBreakdown: {
        processing: sum((r) => r.processing),
        managedPayments: sum((r) => r.managed_payments),
        disputes: sum((r) => r.dispute_fees),
        billing: sum((r) => r.billing),
        other: sum((r) => r.other_fees),
      },
      days: [...byDay.values()]
        .sort((a, b) => a.day.localeCompare(b.day))
        .map((d) => ({ day: d.day, gross: money(d.gross), fees: money(d.fees), net: money(d.net) })),
    };
  });
}

/** The calendar month, which is the window the P&L asks for. */
export const stripeSettledMonth = (month: string): SettledCurrency[] =>
  stripeSettled(`${month}-01`, `${month}-${String(daysInMonth(month)).padStart(2, "0")}`);

export type StripeSplitMode = "off" | "mrr-share";

export function stripeSplitMode(): StripeSplitMode {
  return (configValue(PLUGIN, "stripe_split") ?? "").trim().toLowerCase() === "mrr-share" ? "mrr-share" : "off";
}

function stripeLines(venture: VentureRow, month: string): { lines: RevenueLine[]; unavailable: string | null } {
  if (stripeSplitMode() === "off")
    return {
      lines: [],
      unavailable:
        "Stripe's settled ledger has no product dimension in this box's tables — it is per account per day per " +
        "currency — so settled revenue cannot be split per venture from a measurement. This venture's live MRR is " +
        "reported separately as a run rate. To apportion the portfolio's settled net by each venture's share of " +
        "MRR, set “Stripe split” to mrr-share on the Finance integration's page; every figure it produces is " +
        "labelled estimated.",
    };

  const mine = ventureMrr(venture.id);
  const whole = portfolioMrr();
  const lines: RevenueLine[] = [];
  for (const settled of stripeSettledMonth(month)) {
    const denominator = whole[settled.currency] ?? 0;
    const numerator = mine[settled.currency] ?? 0;
    if (denominator <= 0 || numerator <= 0) continue;
    const share = numerator / denominator;
    lines.push({
      source: "stripe",
      kind: "Portfolio settled net, apportioned by this venture's share of live MRR",
      currency: settled.currency,
      gross: money(settled.gross * share),
      net: money(settled.net * share),
      basis: "mrr-share",
      estimated: true,
      note:
        `${(share * 100).toFixed(1)}% of the portfolio's ${settled.currency} settled ledger for ${month}, because ` +
        `${money(numerator)} of ${money(denominator)} ${settled.currency} of live MRR belongs to products linked to ` +
        `this venture. An allocation of a measured portfolio figure, not a per-venture receipt: MRR is today's book ` +
        `and the ledger is that month's cash, so the two do not describe the same period.`,
    });
  }
  return { lines, unavailable: null };
}

/* ----------------------------------------------------------------- public */

export type VentureRevenue = {
  lines: RevenueLine[];
  gross: CurrencyTotals;
  net: CurrencyTotals;
  /** MRR per currency, always reported and never added to `net`. */
  runRate: { currency: string; amount: number }[];
  /** Why a source is absent, where absence is a fact about the tables rather
   *  than about the business. */
  unavailable: string[];
};

export function ventureRevenue(venture: VentureRow, month: string): VentureRevenue {
  const stripe = stripeLines(venture, month);
  const lines = [...stripe.lines, ...storeLines(venture, month), ...adsenseLines(venture, month)];
  const gross = emptyTotals();
  const net = emptyTotals();
  for (const l of lines) {
    addTo(gross, l.currency, l.gross);
    addTo(net, l.currency, l.net);
  }
  return {
    lines,
    gross,
    net,
    runRate: Object.entries(ventureMrr(venture.id))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amount: money(amount) })),
    unavailable: stripe.unavailable ? [stripe.unavailable] : [],
  };
}

/* --------------------------------------------------------------- traffic */

/**
 * A venture's requests over a month, from Cloudflare zones it is linked to.
 *
 * Used only as an ALLOCATION BASIS — "split the control plane four ways in
 * proportion to what each site actually served" — and never presented as a
 * traffic figure, because Cloudflare's request count is edge requests and not
 * people. Null for a venture with no linked zone: a basis that silently gave
 * such a venture a zero share would hand its costs to its neighbours.
 */
export function ventureTraffic(ventureId: string, month: string): number | null {
  const zones = linkedEntities(ventureId, "cloudflare");
  if (!zones.length) return null;
  const placeholders = zones.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(requests), 0) AS n FROM cloudflare_traffic
       WHERE zone_id IN (${placeholders}) AND day LIKE ?`,
    )
    .get(...zones, `${month}%`) as { n: number } | undefined;
  return row ? row.n : null;
}

/** Every venture, in the owner's order — the list every allocation basis and
 *  the portfolio P&L iterate. */
export const ventures = (): VentureRow[] => ventureRows();
