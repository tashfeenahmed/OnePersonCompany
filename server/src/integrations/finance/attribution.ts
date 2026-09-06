/**
 * WHICH BUSINESS EARNED IT — the revenue half of a per-venture P&L, and the
 * one place in this area where a figure could be invented if nobody was
 * careful.
 *
 * THE JOIN IS `venture_links` AND NOTHING ELSE. A Stripe product, an App Store
 * app id and a Play package reach a venture because the owner (or the venture
 * map's accept-all) said they belong to it. Nothing here matches on a
 * hostname, a prefix or a similar-looking name: `example.ie` and `neu.so` are two
 * businesses in this very database, and a revenue figure captioned with the
 * wrong company's name is the exact failure this dashboard exists not to
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
 * is off until somebody chooses it because the difference between "Example App 1
 * settled €412" and "Example App 1's share of a portfolio figure works out at
 * €412" is the difference between a measurement and an allocation.
 */
import {
  adSenseMonths,
  appStorePayouts,
  configValue,
  db,
  playEarnings,
  stripeLedgerDays,
  stripeSubscriptions,
  ventureRows,
  type VentureRow,
} from "../../db.ts";
import { isBilling } from "../../providers/stripe.ts";
import { PLUGIN } from "./expenses.ts";
import { addTo, currencyCode, emptyTotals, money, type CurrencyTotals } from "./money.ts";

/** venture id → the entities it owns at one plugin. */
function linkIndex(plugin: string): Map<string, string[]> {
  const rows = db
    .prepare("SELECT venture_id, entity FROM venture_links WHERE plugin = ?")
    .all(plugin) as { venture_id: string; entity: string }[];
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.entity, [...(out.get(r.entity) ?? []), r.venture_id]);
  return out;
}

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
  const out: RevenueLine[] = [];

  const apple = linkIndex("appstore");
  for (const p of appStorePayouts()) {
    if (p.month !== month) continue;
    if (!(apple.get(p.app_id) ?? []).includes(venture.id)) continue;
    out.push({
      source: "appstore",
      kind: "Apple finance report: extended partner share",
      currency: currencyCode(p.currency),
      /* Apple's finance report publishes the developer's proceeds. The gross
         customer price is in the SALES report, which is an estimate on a
         different calendar, so there is no gross here rather than a wrong one. */
      gross: null,
      net: p.amount,
      basis: "link",
      estimated: false,
      note: "Apple fiscal month; proceeds after Apple's commission. Not confirmation of a bank deposit.",
    });
  }

  const google = linkIndex("playstore");
  const compact = month.replace("-", "");
  for (const e of playEarnings()) {
    if (e.month !== compact) continue;
    if (!(google.get(e.package) ?? []).includes(venture.id)) continue;
    out.push({
      source: "playstore",
      kind: "Google Play earnings report: net merchant earnings",
      currency: currencyCode(e.currency),
      gross: e.charged,
      net: e.net,
      basis: "link",
      estimated: false,
      note: `Charged ${money(e.charged)} less refunds ${money(e.refunds)} and fees ${money(e.fees)} over ${e.transactions} transactions.`,
    });
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
    const key = s.product ?? "";
    if (!key || !(products.get(key) ?? []).includes(ventureId)) continue;
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

/** The portfolio's settled Stripe money for a month, per currency. This IS
 *  dated money and it is the only Stripe revenue figure in this area that is
 *  a measurement. */
export function stripeSettled(month: string): { currency: string; gross: number; fees: number; taxWithheld: number; net: number }[] {
  const rows = stripeLedgerDays(`${month}-01`).filter((r) => r.day.slice(0, 7) === month);
  const byCurrency = new Map<string, { gross: number; fees: number; taxWithheld: number; net: number }>();
  for (const r of rows) {
    const code = currencyCode(r.currency);
    const acc = byCurrency.get(code) ?? { gross: 0, fees: 0, taxWithheld: 0, net: 0 };
    acc.gross += r.gross;
    acc.fees += r.fees;
    acc.taxWithheld += r.tax_withheld;
    acc.net += r.net;
    byCurrency.set(code, acc);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, v]) => ({
      currency,
      gross: money(v.gross),
      fees: money(v.fees),
      taxWithheld: money(v.taxWithheld),
      net: money(v.net),
    }));
}

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
  for (const settled of stripeSettled(month)) {
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
  const zones = (db
    .prepare("SELECT entity FROM venture_links WHERE venture_id = ? AND plugin = 'cloudflare'")
    .all(ventureId) as { entity: string }[]).map((r) => r.entity);
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
