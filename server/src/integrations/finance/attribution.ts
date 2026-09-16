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
 *               money that arrived in a month. THE CHARGES ARE THE MONEY, and
 *               since the collector learned to read paid invoices and Checkout
 *               Sessions a charge carries the product it paid for. So
 *               `ventureSettledCharges` is dated cash with a product on it,
 *               per venture, per currency, MEASURED — not apportioned, not
 *               MRR, and never added to it. The settled LEDGER
 *               (`stripe_ledger_days`) is still per account per day per
 *               currency with no product on it; it is what the portfolio's
 *               total is measured against.
 *
 * WHAT IS LEFT OVER IS REPORTED AND NEVER DROPPED. A charge no walk could name,
 * a product nobody has linked, a product linked to two ventures: each is a
 * fact about the link map, counted as unattributed with its reason, and
 * carried at the portfolio so that the portfolio's total is the ledger's and
 * not the sum of the ventures. The owner can switch on
 * `stripe_split = mrr-share`, which apportions THAT REMAINDER — never the
 * attributed part, which would count the same money twice — by each venture's
 * share of live MRR in that currency; every figure it produces is stamped
 * `estimated: true` with the basis attached. It is off until somebody chooses
 * it because the difference between "this venture settled €412" and "this
 * venture's share of a portfolio figure works out at €412" is the difference
 * between a measurement and an allocation.
 */
import {
  adSenseMonths,
  configValue,
  db,
  stripeLedgerDays,
  stripeSubscriptions,
  ventureRows,
  type StripeSubscriptionRecord,
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
  source: "appstore" | "playstore" | "adsense" | "stripe" | "stripe-charges";
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

/**
 * THE SUBSCRIPTIONS WHOSE PRODUCT IS LINKED TO THIS VENTURE, live and dead.
 *
 * `rows` and `index` are parameters with defaults rather than reads, so a
 * caller asking about nineteen ventures reads the table ONCE and every figure
 * below is computed off the same array. The default keeps every existing
 * caller's one-liner working.
 */
function subsOf(
  ventureId: string,
  rows: StripeSubscriptionRecord[],
  index: Map<string, string[]>,
): StripeSubscriptionRecord[] {
  return rows.filter((s) => owns(index, s.product, ventureId));
}

/** A venture's live MRR per currency, from the subscriptions whose PRODUCT is
 *  linked to it. A run rate, never a receipt. */
export function ventureMrr(
  ventureId: string,
  rows: StripeSubscriptionRecord[] = stripeSubscriptions(),
  index: Map<string, string[]> = linkIndex("stripe"),
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of subsOf(ventureId, rows, index)) {
    if (!isBilling(s.status)) continue;
    const code = currencyCode(s.currency);
    out[code] = (out[code] ?? 0) + s.monthly_usd;
  }
  return out;
}

/** How many live subscriptions a venture's linked products carry. Beside the
 *  MRR rather than inside it: a $99 plan and a $1 plan are one row each here
 *  and nothing alike above. */
export function ventureSubscribers(
  ventureId: string,
  rows: StripeSubscriptionRecord[] = stripeSubscriptions(),
  index: Map<string, string[]> = linkIndex("stripe"),
): number {
  return subsOf(ventureId, rows, index).filter((s) => isBilling(s.status)).length;
}

/**
 * THE SAME FIGURE AS IT STOOD `days` AGO, RECONSTRUCTED FROM THE ROWS.
 *
 * A subscription counts in the past figure if it had been created by then and
 * had not ended by then. TODAY'S STATUS IS DELIBERATELY NOT TESTED: a
 * subscription cancelled last week WAS billing thirty days ago, and testing it
 * would make the past figure a subset of the present one — so the delta could
 * never be negative and a venture could never be seen to lose money.
 *
 * IT IS A RECONSTRUCTION AND IT HAS ONE BLIND SPOT, which every caller repeats
 * to its reader: it sees a subscription that STARTED or STOPPED and cannot see
 * a plan whose PRICE changed, because the subscription object keeps no record
 * of what it used to cost.
 *
 * It lives here rather than in the evidence packet because the packet and the
 * Stripe document both publish this delta, and two reconstructions of one
 * figure is how the alert and the proposal come to disagree about the same
 * business on the same night.
 */
export function ventureMrrPrevious(
  ventureId: string,
  days = 30,
  rows: StripeSubscriptionRecord[] = stripeSubscriptions(),
  index: Map<string, string[]> = linkIndex("stripe"),
): Record<string, number> {
  const then = Date.now() - days * 86_400_000;
  const out: Record<string, number> = {};
  for (const s of subsOf(ventureId, rows, index)) {
    if (Date.parse(s.created_at) > then) continue;
    if (s.ended_at && Date.parse(s.ended_at) <= then) continue;
    const code = currencyCode(s.currency);
    out[code] = (out[code] ?? 0) + (Number(s.monthly_usd) || 0);
  }
  return out;
}

/**
 * SETTLED ONE-OFF CASH, which is the half of Stripe this area could not see
 * until the charge rows learned what they were for.
 *
 * WHY IT IS A SEPARATE FIGURE AND NOT PART OF MRR. A lifetime licence is money
 * that arrived once. MRR is a RUN RATE — what the book is contracted to bill
 * every month — and a one-off folded into it would be revenue this business
 * has to earn again next month or report as churn. They are two measurements
 * of two things and this box keeps them apart everywhere, so this returns its
 * own object and nothing adds it to `ventureMrr`.
 *
 * IT IS MEASURED, NOT ALLOCATED. The join is the same one the rest of this
 * file uses — `venture_links` on the product name, case-insensitively — and
 * the product on a charge row is the one its Checkout Session named. A charge
 * with no product is not counted for anybody: unattributed is a fact, and
 * spreading it over the ventures that do have products would invent a receipt.
 *
 * NINETY DAYS IS ALL THERE IS. `stripe_charges` holds the collector's rolling
 * walk and is pruned to its edge, so a window wider than that is a floor and
 * `window` says what was asked for rather than implying it was answered.
 *
 * GROSS IS PER CURRENCY, like every other money figure here. There is no
 * `gross_usd`: a single scalar is the shape that silently adds a euro to a
 * dollar the day a second currency appears.
 */
export type OneOffChargeRow = {
  product: string;
  currency: string;
  n: number;
  gross: number;
};

/** Every attributed one-off charge in the window, grouped once. Exported so a
 *  caller asking about every venture makes one query rather than nineteen. */
export function oneOffCharges(days = 30): OneOffChargeRow[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db
    .prepare(
      `SELECT product, currency, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS gross
         FROM stripe_charges
        WHERE status = 'succeeded' AND product IS NOT NULL AND created_at >= ?
        GROUP BY product, currency`,
    )
    .all(since) as unknown as OneOffChargeRow[];
}

export type VentureOneOff = {
  days: number;
  /** Succeeded charges whose product is linked to this venture. */
  count: number;
  /** Gross per currency code, succeeded charges only. */
  gross: Record<string, number>;
  byProduct: { product: string; currency: string; count: number; gross: number }[];
  window: string;
};

export function ventureOneOff(
  ventureId: string,
  days = 30,
  rows: OneOffChargeRow[] = oneOffCharges(days),
): VentureOneOff {
  const window =
    `settled one-off purchases in the last ${days} days, dated by the charge and ` +
    `attributed by the product its Checkout Session sold`;
  const products = linkedEntities(ventureId, "stripe");
  if (!products.length) return { days, count: 0, gross: {}, byProduct: [], window };

  const wanted = new Set(products.map((e) => normaliseEntity(e)));
  const gross: Record<string, number> = {};
  const byProduct: VentureOneOff["byProduct"] = [];
  let count = 0;
  for (const r of rows) {
    if (!wanted.has(normaliseEntity(r.product))) continue;
    const code = currencyCode(r.currency);
    gross[code] = money((gross[code] ?? 0) + r.gross);
    count += r.n;
    byProduct.push({ product: r.product, currency: code, count: r.n, gross: money(r.gross) });
  }
  byProduct.sort((a, b) => b.gross - a.gross || a.product.localeCompare(b.product));
  return { days, count, gross, byProduct, window };
}

/* --------------------------------------- settled Stripe cash, per venture */

/**
 * A MONTH'S SUCCEEDED CHARGES, GROUPED BY WHAT THEY BOUGHT.
 *
 * The calendar-month twin of `oneOffCharges`, which answers a rolling window.
 * Two functions rather than one with a flag because they answer two different
 * questions and the P&L only ever asks this one: a month is the unit every
 * other figure in this area is measured in.
 *
 * REFUNDS ARE SUBTRACTED BY THEIR AMOUNT WHERE THERE IS ONE. `amount_refunded`
 * is what came back; where it is null — a row written before the column
 * existed — a charge whose `refunded` flag is set is treated as refunded IN
 * FULL. That is the direction that never flatters revenue, and the rolling
 * rewalk replaces such a row with its real figure within the window.
 *
 * SUCCEEDED ONLY. A declined card is not revenue and a pending one is not
 * money yet.
 */
export type ChargeMonthRow = {
  /** Null is "neither the invoice walk nor the session walk named this", and
   *  it is never "Other". */
  product: string | null;
  currency: string;
  n: number;
  gross: number;
  refunded: number;
};

export function chargesForMonth(month: string): ChargeMonthRow[] {
  return db
    .prepare(
      `SELECT product, currency, COUNT(*) AS n,
              COALESCE(SUM(amount), 0) AS gross,
              COALESCE(SUM(CASE WHEN amount_refunded IS NOT NULL THEN amount_refunded
                                WHEN refunded = 1 THEN amount
                                ELSE 0 END), 0) AS refunded
         FROM stripe_charges
        WHERE status = 'succeeded' AND created_at LIKE ?
        GROUP BY product, currency`,
    )
    .all(`${month}%`) as unknown as ChargeMonthRow[];
}

/** Why a charge reached no venture. Three facts, never one word. */
export type UnattributedReason =
  /** No walk could say what the payment bought. */
  | "no-product"
  /** It bought something nobody has linked to a venture. */
  | "no-venture"
  /** It bought something linked to MORE than one venture. */
  | "ambiguous";

export type ChargeTotal = { currency: string; count: number; gross: number; net: number };

export type ChargeSplit = {
  /** Venture id → one row per currency. Only ventures that earned anything. */
  byVenture: Map<string, ChargeTotal[]>;
  /** What reached nobody, per currency, with the reasons counted. */
  unattributed: (ChargeTotal & { reasons: Record<UnattributedReason, number>; products: string[] })[];
  /** Every attributed charge, per currency: the portfolio's denominator and
   *  the number the settled remainder is measured against. */
  attributed: Record<string, ChargeTotal>;
};

/**
 * WHICH VENTURE EACH CHARGE BELONGS TO — the whole rule, over rows, with no
 * database in it so that every branch of it is testable.
 *
 * THE JOIN IS `venture_links` ON THE PRODUCT, case-insensitively, which is the
 * same join `ventureMrr` uses. A venture's subscriptions and its settled cash
 * therefore agree about which products are its, which they did not when one
 * side matched exactly and the other did not.
 *
 * A PRODUCT LINKED TO TWO VENTURES IS ATTRIBUTED TO NEITHER. Splitting it in
 * half would invent a receipt, and handing it to the first venture in the list
 * would caption one business's money with another's name. It is counted as
 * unattributed with the reason `ambiguous`, which is a fixable fact about the
 * link map rather than a silent number. Keeping it out of both also keeps the
 * arithmetic true: the portfolio's attributed total is what the ventures add
 * up to, exactly, and nothing is counted twice.
 *
 * NET IS GROSS LESS REFUNDS AND NOTHING ELSE. A charge row carries no fee —
 * Stripe's fees are per balance transaction, on the ledger table, with no
 * product dimension at all — so a per-venture figure net of fees would be an
 * allocation wearing a measurement's clothes. The fees are real and they are
 * reported at the portfolio, where they are measured; see `portfolioPnl`.
 */
export function splitCharges(rows: ChargeMonthRow[], index: Map<string, string[]>): ChargeSplit {
  const byVenture = new Map<string, Map<string, ChargeTotal>>();
  const unattributed = new Map<
    string,
    ChargeTotal & { reasons: Record<UnattributedReason, number>; products: string[] }
  >();
  const attributed: Record<string, ChargeTotal> = {};

  const bump = (t: ChargeTotal, r: ChargeMonthRow) => {
    t.count += r.n;
    t.gross += r.gross;
    t.net += r.gross - r.refunded;
  };
  const blank = (currency: string): ChargeTotal => ({ currency, count: 0, gross: 0, net: 0 });

  for (const r of rows) {
    const code = currencyCode(r.currency);
    const owners = r.product === null ? [] : (index.get(normaliseEntity(r.product)) ?? []);
    const reason: UnattributedReason | null =
      r.product === null ? "no-product" : owners.length === 0 ? "no-venture" : owners.length > 1 ? "ambiguous" : null;

    if (reason !== null) {
      const row =
        unattributed.get(code) ??
        { ...blank(code), reasons: { "no-product": 0, "no-venture": 0, ambiguous: 0 }, products: [] };
      bump(row, r);
      row.reasons[reason] += r.n;
      if (r.product !== null && !row.products.includes(r.product)) row.products.push(r.product);
      unattributed.set(code, row);
      continue;
    }

    const ventureId = owners[0]!;
    const mine = byVenture.get(ventureId) ?? new Map<string, ChargeTotal>();
    const row = mine.get(code) ?? blank(code);
    bump(row, r);
    mine.set(code, row);
    byVenture.set(ventureId, mine);

    const all = attributed[code] ?? blank(code);
    bump(all, r);
    attributed[code] = all;
  }

  /* Rounded once, at the end, like every other total in this area. */
  const round = (t: ChargeTotal): ChargeTotal => ({ ...t, gross: money(t.gross), net: money(t.net) });
  return {
    byVenture: new Map(
      [...byVenture].map(([id, m]) => [
        id,
        [...m.values()].map(round).sort((a, b) => a.currency.localeCompare(b.currency)),
      ]),
    ),
    unattributed: [...unattributed.values()]
      .map((u) => ({ ...round(u), reasons: u.reasons, products: u.products.sort() }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    attributed: Object.fromEntries(Object.entries(attributed).map(([c, t]) => [c, round(t)])),
  };
}

/** The month's split, read out of the tables. One query and one link index,
 *  so a caller asking about nineteen ventures asks the database once. */
export const settledChargeSplit = (month: string): ChargeSplit =>
  splitCharges(chargesForMonth(month), linkIndex("stripe"));

const WHY_UNATTRIBUTED: Record<UnattributedReason, string> = {
  "no-product": "no invoice or Checkout Session named what the payment bought",
  "no-venture": "what it bought is linked to no venture",
  ambiguous: "what it bought is linked to more than one venture, so it is counted for neither",
};

/** How a currency's unattributed cash came to be unattributed, in words a
 *  person can act on — the link map is the thing they would change. */
export function unattributedNote(reasons: Record<UnattributedReason, number>): string {
  const parts = (Object.keys(WHY_UNATTRIBUTED) as UnattributedReason[])
    .filter((k) => reasons[k] > 0)
    .map((k) => `${reasons[k]} where ${WHY_UNATTRIBUTED[k]}`);
  return parts.length ? parts.join("; ") : "nothing";
}

/**
 * THIS VENTURE'S SETTLED STRIPE CASH FOR THE MONTH — measured, not allocated.
 *
 * This is the line that was missing. `ventureRevenue` summed store payouts,
 * AdSense and (only when the owner switched a split on) an apportionment of
 * the Stripe ledger; the cash Stripe actually collected reached no venture at
 * all, and because the portfolio card summed the ventures, it left the
 * portfolio too. A month of real receipts could read as a dollar earned.
 */
export function ventureSettledCharges(
  ventureId: string,
  month: string,
  split: ChargeSplit = settledChargeSplit(month),
): RevenueLine[] {
  return (split.byVenture.get(ventureId) ?? []).map((t) => ({
    source: "stripe-charges" as const,
    kind: "Stripe charges settled in the month, for products linked to this venture",
    currency: t.currency,
    gross: t.gross,
    net: t.net,
    basis: "link" as const,
    estimated: false,
    note:
      `${t.count} succeeded charge${t.count === 1 ? "" : "s"} in ${month} whose product is linked to this ` +
      `venture, ${money(t.gross)} gross less ${money(t.gross - t.net)} refunded. BEFORE Stripe's fees: a ` +
      `charge carries no fee, the fees are per balance transaction with no product on them, and they are ` +
      `reported once at the portfolio rather than apportioned here.`,
  }));
}

/* ------------------------------------------------- the book, per venture */

/**
 * ONE ROW PER VENTURE THAT HAS A STRIPE PRODUCT LINKED TO IT — the shape the
 * Stripe document publishes so that an alert rule can name a business.
 *
 * WHY IT EXISTS. Every rule on this box is an address: a skill, a view, some
 * parameters and a path into the document. The Stripe document published `mrr`
 * for the whole account and `products[].mrr` per product, and NOTHING keyed by
 * venture — so "tell me when THIS business's revenue moves" was unwritable,
 * and the evidence packet's "no alert rule names this venture" was a sentence
 * nobody could act on for revenue. This is that missing key.
 *
 * KEYED BY VENTURE ID IN THE DOCUMENT, because the path language addresses
 * object keys and numeric array indexes — `byVenture.v-abc123.mrr` resolves and
 * survives a venture being added, where `byVenture[2].mrr` would silently
 * become a different business.
 *
 * A SCALAR `mrr` ONLY WHERE THERE IS ONE CURRENCY. Where a venture bills in
 * two, the scalar is null and `mrrByCurrency` holds the truth: null reads as
 * "asked and not told" everywhere on this box, and a rule against it records
 * an unreadable rather than a collapse to zero. Adding the two would invent an
 * exchange rate.
 */
export type VentureStripeRow = {
  ventureId: string;
  name: string;
  slug: string;
  products: string[];
  /** The single currency all of this venture's Stripe money is in, or null
   *  where it spans two (or where none has arrived yet). Every scalar money
   *  field below is null exactly when this is null AND there is money. */
  currency: string | null;
  mrr: number | null;
  mrrByCurrency: Record<string, number>;
  subscribers: number;
  /** MRR as it stood `days` ago, reconstructed — see `ventureMrrPrevious`. */
  previousMrr: number | null;
  /** Signed: negative is revenue lost. */
  mrrDelta: number | null;
  /** The same move without its sign, because the engine's threshold operators
   *  compare in ONE direction and "the money moved" is a two-directional
   *  question. This is the field the seeded per-venture rule watches. */
  mrrAbsDelta: number | null;
  /** That move as a percentage of the earlier figure, or null where the
   *  earlier figure was zero — a percentage of nothing is not a figure. */
  mrrMovePct: number | null;
  oneOffCount: number;
  oneOff: number | null;
  oneOffByCurrency: Record<string, number>;
  days: number;
};

/**
 * THE ONE CURRENCY A VENTURE'S STRIPE MONEY IS IN, across all of it.
 *
 * Asked of MRR, the figure from thirty days ago AND the one-off cash together,
 * because the scalars are only publishable at all if they mean the same
 * currency: `mrr: 29` beside `oneOff: 19` in another currency is two numbers a
 * reader will add. Where there is more than one, every scalar is null and the
 * per-currency maps beside them hold the truth. Where there is none — a linked
 * venture that has not billed anybody yet — the currency is null and the
 * scalars are a real zero.
 */
function oneCurrency(...maps: Record<string, number>[]): string | null {
  const codes = new Set(maps.flatMap((m) => Object.keys(m)));
  return codes.size === 1 ? [...codes][0]! : null;
}

export function ventureStripeBook(days = 30): VentureStripeRow[] {
  const index = linkIndex("stripe");
  const subs = stripeSubscriptions();
  const charges = oneOffCharges(days);
  const out: VentureStripeRow[] = [];

  for (const v of ventures()) {
    const products = linkedEntities(v.id, "stripe");
    /* A venture with no linked product is not published here at all. Every
       field would be a zero that reads as "this business earns nothing"
       rather than "nobody has told this box which products are its". */
    if (!products.length) continue;

    const mrrByCurrency = ventureMrr(v.id, subs, index);
    const previousByCurrency = ventureMrrPrevious(v.id, days, subs, index);
    const one = ventureOneOff(v.id, days, charges);

    const currency = oneCurrency(mrrByCurrency, previousByCurrency, one.gross);
    const blended =
      currency === null &&
      [mrrByCurrency, previousByCurrency, one.gross].some((m) => Object.keys(m).length);
    /* Null where the venture's money spans currencies — asked and not told,
       which a rule records as unreadable — and a real zero where it has simply
       taken none. */
    const scalar = (m: Record<string, number>): number | null =>
      blended ? null : money(m[currency ?? ""] ?? 0);

    const nowMrr = scalar(mrrByCurrency);
    const beforeMrr = scalar(previousByCurrency);
    const delta = nowMrr !== null && beforeMrr !== null ? money(nowMrr - beforeMrr) : null;

    out.push({
      ventureId: v.id,
      name: v.name,
      slug: v.slug,
      products,
      currency,
      mrr: nowMrr,
      mrrByCurrency: Object.fromEntries(
        Object.entries(mrrByCurrency).map(([c, n]) => [c, money(n)]),
      ),
      subscribers: ventureSubscribers(v.id, subs, index),
      previousMrr: beforeMrr,
      mrrDelta: delta,
      mrrAbsDelta: delta === null ? null : Math.abs(delta),
      mrrMovePct:
        delta === null || !beforeMrr
          ? null
          : Number(((Math.abs(delta) / Math.abs(beforeMrr)) * 100).toFixed(2)),
      oneOffCount: one.count,
      oneOff: scalar(one.gross),
      oneOffByCurrency: one.gross,
      days,
    });
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
 * The WINDOW is the caller's — `from` and `to` are inclusive `YYYY-MM-DD`
 * days — because a rolling thirty days and a calendar month are two
 * legitimate questions; the ARITHMETIC and the currency spelling are not the
 * caller's, and that is the whole point: no second reduction should key a
 * currency code differently or round before summing.
 *
 * Rounding happens once, at the end. Every field is summed at full precision
 * first — rounding each row and then adding drifts off the true total.
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

/**
 * THE APPORTIONMENT, AND IT APPLIES TO THE REMAINDER AND NOTHING ELSE.
 *
 * `settledRemainder` is the month's settled ledger MINUS what the charge walk
 * already attributed by product, per currency. That subtraction is the whole
 * correctness of this function: apportioning the WHOLE ledger while the
 * measured lines above also count the attributed part of it would report the
 * same euro twice, once as a receipt and once as a share — and the second copy
 * would land on ventures that did not earn it.
 *
 * FLOORED AT ZERO. The ledger dates money by settlement and a charge by its
 * creation, so a charge made on the last day of the month settles in the next
 * one and a remainder can come out negative. A negative pot apportioned by MRR
 * share would hand ventures negative revenue they did not lose; zero is the
 * honest floor and the portfolio's own row below reports the difference.
 */
function settledRemainder(month: string, split: ChargeSplit): SettledCurrency[] {
  return stripeSettledMonth(month).map((s) => {
    const taken = split.attributed[s.currency];
    return {
      ...s,
      gross: money(Math.max(0, s.gross - (taken?.gross ?? 0))),
      net: money(Math.max(0, s.net - (taken?.net ?? 0))),
    };
  });
}

function stripeLines(
  venture: VentureRow,
  month: string,
  split: ChargeSplit,
): { lines: RevenueLine[]; unavailable: string | null } {
  const remainder = settledRemainder(month, split);
  const left = remainder.filter((s) => s.net > 0 || s.gross > 0);

  if (stripeSplitMode() === "off")
    return {
      lines: [],
      /* Only where there IS a remainder. A month whose settled cash was all
         attributed by product has nothing to caveat, and a standing paragraph
         saying Stripe cannot be split would then be false. */
      unavailable: left.length
        ? "Stripe's settled ledger has no product dimension in this box's tables — it is per account per day " +
          "per currency — so the part of it that no charge could be attributed to a product is not split per " +
          `venture: ${left.map((s) => `${money(s.net)} ${s.currency}`).join(", ")} for ${month}, reported at the ` +
          "portfolio as revenue attributed to no venture. Charges whose product IS linked to this venture are " +
          "measured above. To apportion the remainder by each venture's share of live MRR, set “Stripe split” " +
          "to mrr-share on the Finance integration's page; every figure it produces is labelled estimated."
        : null,
    };

  const mine = ventureMrr(venture.id);
  const whole = portfolioMrr();
  const lines: RevenueLine[] = [];
  for (const settled of remainder) {
    const denominator = whole[settled.currency] ?? 0;
    const numerator = mine[settled.currency] ?? 0;
    if (denominator <= 0 || numerator <= 0) continue;
    if (settled.net <= 0 && settled.gross <= 0) continue;
    const share = numerator / denominator;
    const taken = split.attributed[settled.currency];
    lines.push({
      source: "stripe",
      kind: "Portfolio settled net not attributed to any product, apportioned by this venture's share of live MRR",
      currency: settled.currency,
      gross: money(settled.gross * share),
      net: money(settled.net * share),
      basis: "mrr-share",
      estimated: true,
      note:
        `${(share * 100).toFixed(1)}% of the ${money(settled.net)} ${settled.currency} of ${month}'s settled ` +
        `ledger that no charge could be attributed to a product` +
        (taken ? ` (${money(taken.net)} of it was attributed and is not in this figure)` : "") +
        `, because ${money(numerator)} of ${money(denominator)} ${settled.currency} of live MRR belongs to ` +
        `products linked to this venture. An allocation of a measured portfolio figure, not a per-venture ` +
        `receipt: MRR is today's book and the ledger is that month's cash, so the two do not describe the ` +
        `same period.`,
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

export function ventureRevenue(
  venture: VentureRow,
  month: string,
  /** The month's charge split, where the caller has one. A portfolio asking
   *  about nineteen ventures passes it in and the database is read once. */
  split: ChargeSplit = settledChargeSplit(month),
): VentureRevenue {
  const stripe = stripeLines(venture, month, split);
  const lines = [
    ...ventureSettledCharges(venture.id, month, split),
    ...stripe.lines,
    ...storeLines(venture, month),
    ...adsenseLines(venture, month),
  ];
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
