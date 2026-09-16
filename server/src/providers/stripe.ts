/**
 * Stripe — what actually came in, and what it is contracted to keep coming in.
 *
 * WHAT THE OWNER PASTES: a key with READ access to charges, balance, balance
 * transactions, subscriptions, prices, invoices and payouts. A restricted key
 * (`rk_live_…`) is the right sort: nothing in this file sends a request body
 * or a method other than GET, so a key that can write is a key whose extra
 * power is never used and can still be leaked. `get()` below is the single
 * HTTP entry point and takes no body — that is the whole enforcement, and it
 * is deliberately structural rather than a rule somebody has to remember.
 *
 * WHAT IT READS, and nothing else:
 *   GET /v1/balance                — what Stripe is holding
 *   GET /v1/payouts                — what it has actually sent to the bank
 *   GET /v1/prices?expand=product  — the price list, for plan and product names
 *   GET /v1/subscriptions          — status=all, the whole book, live and dead
 *   GET /v1/invoices?subscription= — did THIS cancelled subscription ever bill
 *   GET /v1/charges                — the attempts, succeeded and failed
 *   GET /v1/checkout/sessions      — what a ONE-OFF payment was for
 *   GET /v1/balance_transactions   — the ledger: fees, tax, refunds, net
 *
 * TWO WALKS THAT LOOK ALIKE AND ARE NOT. The charge walk measures ATTEMPTS —
 * it is the only place a failed payment exists, because a decline never posts
 * to the balance. The balance-transaction walk measures SETTLEMENT — the fee
 * Stripe actually took, the tax it withheld, the refund it paid back, and the
 * net that reached the account. Their two "gross" figures are dated
 * differently (the charge's own timestamp against the ledger's posting) and
 * are therefore stored in two tables and never added together. Net revenue is
 * a ledger question and is only ever answered from the ledger.
 *
 * THE INCREMENTAL STRATEGY, WHICH IS THE WHOLE REASON THIS IS NOT A LOOP OVER
 * A YEAR. The collector this replaces keeps a day ledger in a JSON file beside the
 * key: each run rewalks ninety days, rewrites those ninety rows, and leaves
 * everything older alone, because a settled day's gross cannot change — its
 * refund window has closed — so re-deriving three hundred of them every ten
 * minutes is traffic spent on an answer nobody's arithmetic can move. The
 * database here IS that ledger, and the rule is the same one: every run
 * rewrites the rolling ninety days by primary key, and older rows are never
 * touched again.
 *
 * WHERE THIS DELIBERATELY DIFFERS FROM THE SYSTEM IT REPLACES: its first run against an
 * empty ledger backfills the account's whole history in one walk. That is the
 * right trade for a systemd timer and the wrong one here, because the first
 * collection happens INSIDE the HTTP request that stores the credential — an
 * owner who pastes a key would sit on a spinner for however many years of
 * charges the account has. So history is filled BACKWARDS, one chunk per run
 * (HISTORY_CHUNK_DAYS), and the run that reaches the account's first charge
 * says so and stops asking. Connecting costs one window; the year arrives over
 * the next few collections, and every figure derived from it says how far back
 * the ledger actually reaches rather than implying a completeness it lacks.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";
import { fromMinorUnits } from "../shared/money.ts";

export const STRIPE_API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 45_000;

/**
 * How far back every run rewalks, and it is not the same thing as how much
 * history is held.
 *
 * Ninety days because that is the span in which a day's figures can still
 * MOVE: a refund lands against a charge from July, a dispute is opened on
 * August's payment, a charge caught mid-flight settles. Rows inside it are
 * rewritten by primary key on every run; rows outside it are settled history
 * and are read once, ever.
 */
export const WALK_DAYS = 90;

/** How much older history one run adds while the ledger is still reaching
 *  back. Four months a run: a two-year-old account is complete inside seven
 *  collections, and no single run is unbounded. */
export const HISTORY_CHUNK_DAYS = 120;

/**
 * One walk's ceiling. A walk that quietly stops short is a lie the document
 * cannot detect, so the cap is named once and every hit is reported.
 */
const PAGE_CAP = 5000;

/** Recent payouts kept. The question these answer is "when did money last
 *  actually leave for the bank", which is the last few and never the history. */
const PAYOUTS = 10;

/**
 * Cancelled subscriptions resolved against their invoices per run.
 *
 * WHY THERE IS A CAP AT ALL. Whether a cancellation cost anything is not on
 * the subscription object in any form — `trial_end` says a trial was OFFERED,
 * not that an invoice was ever paid — so it takes one GET per cancelled
 * subscription. This account has 154 of them and a fresh install would make
 * 154 extra requests inside the connect call. The answer never changes once
 * known, so it is stored per subscription and asked for at most sixty a run,
 * newest cancellation first: the churn windows anybody is reading fill on the
 * first collection and the archive catches up over the next two.
 */
const RESOLVE_PER_RUN = 60;

/**
 * Any billing interval, as a share of a month.
 *
 * THIS IS THE NORMALISATION AND IT IS A CHOICE, NOT A FACT. An annual plan
 * bills $29 once a year and this counts it as $2.4167 of MRR every month.
 * That is the standard convention and it is the only way a book of 444 annual
 * and 254 monthly items can be described by one figure at all — but it is
 * arithmetic performed ON the customer's cash flow rather than a thing Stripe
 * reported, so every surface that shows MRR says the annual plans are counted
 * as a twelfth. The alternative — reporting only what bills this month — is a
 * figure that jumps every time an annual renewal lands and describes nothing.
 */
const PER_MONTH: Record<string, number> = {
  day: 30,
  week: 4.34524,
  month: 1,
  year: 1 / 12,
};

/**
 * LIVE IS NOT THE SAME AS BILLING, and conflating them is how a free trial
 * becomes revenue.
 *
 * `trialing` is a going concern — somebody is inside the product and may well
 * convert — but it has never sent a cent, and money counted IN as MRR has to
 * come back out as churn when the trial ends. The only way to never book that
 * loss is to never book the revenue: MRR, the plan mix and the product mix all
 * key off THIS, and trialing value is reported beside them rather than inside.
 *
 * `past_due` is deliberately out too. It is a subscription that is billing and
 * FAILING, and counting it as contracted revenue is how a book of dying cards
 * reads as growth. It is counted on its own instead, which is a number
 * somebody can act on.
 *
 * Exported because the collector's readings and the route's totals must agree
 * to the cent, and the only way to guarantee that is for both to ask the same
 * function what counts as money.
 */
export const isBilling = (status: string) => status === "active";

/**
 * Balance-transaction categories that move money between Stripe and a bank
 * rather than between a customer and the business. A payout is the same
 * dollars a second time; counting it would double every figure in the ledger.
 */
const LEDGER_EXCLUDED = new Set([
  "payout",
  "payout_reversal",
  "transfer",
  "transfer_reversal",
  "advance",
  "advance_funding",
  "topup",
  "topup_reversal",
]);

/** Old balance transactions carry `type` but no `reporting_category`. This
 *  rebuilds the category Stripe's own reports use from the type alone. */
const TYPE_CATEGORY: Record<string, string> = {
  charge: "charge",
  payment: "charge",
  refund: "refund",
  payment_refund: "refund",
  refund_failure: "refund_failure",
  payment_refund_failure: "refund_failure",
  stripe_fee: "fee",
  network_cost: "fee",
  application_fee: "fee",
  application_fee_refund: "fee",
  adjustment: "other_adjustment",
  payout: "payout",
  payout_cancel: "payout",
  payout_failure: "payout",
  transfer: "transfer",
  transfer_cancel: "transfer",
  transfer_failure: "transfer",
  transfer_refund: "transfer",
  topup: "topup",
  topup_reversal: "topup_reversal",
};

/**
 * Which line of the fee breakdown one fee belongs on.
 *
 * Stripe names fees in PROSE, not in an enum: `fee_details[].type` is only
 * ever `stripe_fee`, `tax`, `withheld_tax` or `application_fee`, and
 * everything that distinguishes card processing from a merchant-of-record fee
 * is in the free-text description. So the type decides tax versus not-tax —
 * the one split that must never be wrong, because it is the difference between
 * a cost and a pass-through — and the description decides the rest. An
 * unrecognised description is `other` and never quietly folded into
 * processing: a bucket that absorbs the unknown stops being a measurement.
 *
 * Descriptions seen on this account on 2026-09-04: "Stripe processing fees",
 * "Withheld sales tax", "Refund of withheld sales tax", "Managed Payments
 * Transaction Fee (2026-09-03)" and "Billing - Usage Fee (2026-09-03)".
 */
export function feeBucket(kind: string | null, desc: string | null): string {
  if (kind === "tax" || kind === "withheld_tax" || kind === "withheld_tax_refund")
    return "tax";
  const d = (desc ?? "").toLowerCase();
  if (d.includes("withheld sales tax")) return "tax";
  if (d.includes("dispute")) return "disputes";
  if (d.includes("managed payments")) return "managedPayments";
  if (d.startsWith("billing")) return "billing";
  if (d.includes("processing")) return "processing";
  return "other";
}

/* ------------------------------------------------------------------ shapes */

/**
 * One UTC day of payment ATTEMPTS, per currency.
 *
 * `gross` and `succeeded` are succeeded charges only — that is what every
 * chart drawn off this table assumes. The failure columns are the other half
 * of the same walk and are the reason it exists at all: a decline never
 * reaches the balance, so the ledger table below cannot see one.
 *
 * BLOCKED AND DECLINED ARE NOT THE SAME EVENT and never share a denominator.
 * `outcome.type` is Stripe's own word for the difference: "blocked" means a
 * Radar rule stopped the attempt before a bank saw it — an attack repelled,
 * which is the system working — and "issuer_declined" means a real customer's
 * bank said no, which is the only half anybody can act on. This account fails
 * 553 of 1,135 attempts over ninety days and reading that as "49% of payments
 * fail" would be a false alarm about card testing.
 */
export type ChargeDay = {
  accountId: number;
  accountLabel: string;
  day: string;
  currency: string;
  gross: number;
  refunded: number;
  refunds: number;
  succeeded: number;
  failed: number;
  blocked: number;
  declined: number;
};

/**
 * One charge, as the Payments board lists it — the row the day above was
 * folded from, kept only for the ninety days the walk rewalks.
 *
 * `emailMasked` is the ONLY form of the address this row ever holds: the
 * masking happens here, in the walk, before anything is returned, so no
 * writer downstream has a full address to leak by accident. `failureCode`
 * and `failureMessage` are Stripe's own words for a decline — the one place
 * on this box the bank's reason survives, since the day table keeps counts.
 */
export type ChargeRow = {
  id: string;
  accountId: number;
  amount: number;
  currency: string;
  status: string;
  paid: boolean;
  refunded: boolean;
  createdAt: string;
  description: string | null;
  emailMasked: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  outcomeType: string | null;
  /**
   * WHAT A ONE-OFF PAYMENT BOUGHT, from the Checkout Session that made it.
   *
   * Null on everything else, and null is "no completed session named this
   * payment" rather than "Other" — a subscription invoice, a charge created in
   * the dashboard, an invoice paid outside Checkout. A charge that cannot be
   * attributed must stay unattributed: filing it under a product would put one
   * venture's cash on another venture's page.
   */
  product: string | null;
  priceId: string | null;
};

/**
 * "t***@gmail.com": enough to recognise a customer in a list, not enough to
 * write to. THE STARS ARE A FIXED THREE, so the mask says nothing about how
 * long the address was; the host stays because it is what makes a row
 * recognisable at all. Anything that is not an address is null rather than
 * a guess.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return `${email[0]}***@${email.slice(at + 1)}`;
}

/**
 * One UTC day of SETTLEMENT, per currency, straight off the balance ledger.
 *
 * `fees` is Stripe's own cut EX-TAX and is the figure any blended rate must be
 * derived from. `taxWithheld` is sales tax Stripe collects as merchant of
 * record and remits onward — real money off the top and not a cost, because it
 * is not the business's money at any point. Folding the two together is how a
 * 8.2% processing cost reads as 15.3%, which is a mistake the previous system
 * made and documented; here they are two columns and `feesTotal` is the sum for the one
 * reader that needs it: net = gross - refunds - disputes - feesTotal + other.
 */
export type LedgerDay = {
  accountId: number;
  accountLabel: string;
  day: string;
  currency: string;
  gross: number;
  fees: number;
  taxWithheld: number;
  feesTotal: number;
  refunds: number;
  disputes: number;
  other: number;
  net: number;
  count: number;
  /** The fee scalar decomposed. Always adds back up to feesTotal. */
  processing: number;
  managedPayments: number;
  disputeFees: number;
  billing: number;
  otherFees: number;
};

/**
 * One subscription, live or dead, priced.
 *
 * ROWS RATHER THAN AGGREGATES. MRR, the active count and every churn rate are
 * computed from this table when somebody asks, never written into it. A stored
 * "MRR: $875" is wrong the moment a subscription cancels and badly wrong after
 * a week of failed collections — which is the week somebody looks. The row
 * carries what Stripe said; the arithmetic happens on the read.
 */
export type SubscriptionRow = {
  accountId: number;
  accountLabel: string;
  id: string;
  status: string;
  currency: string;
  /** Net of recurring coupons, normalised to a month. See PER_MONTH. */
  monthlyUsd: number;
  /** Before coupons, same normalisation — so "how much is discounted away"
   *  is a subtraction rather than a second walk. */
  listedMonthlyUsd: number;
  interval: string | null;
  intervalCount: number | null;
  product: string | null;
  plan: string | null;
  createdAt: string;
  /** When it actually ended. NOT set for a subscription that has merely asked
   *  to cancel — Stripe fills `canceled_at` the moment a cancellation is
   *  SCHEDULED, and 93 subscriptions on this account are in exactly that
   *  state: still billing, still MRR, gone at the end of the period. */
  endedAt: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  /** cancellation_requested / payment_failed / payment_disputed, or null on
   *  subscriptions older than the field. Null is treated as voluntary:
   *  guessing "involuntary" would flatter the retention story. */
  reason: string | null;
  /**
   * Cents this subscription has ever collected, or null for "not asked yet".
   *
   * Null is not zero and the difference decides whether a cancellation is
   * churn. A row that could not be resolved is treated downstream as PAID —
   * an unreachable invoice list must never silently reclassify a real loss as
   * a trial that never mattered.
   */
  paidCents: number | null;
};

export type BalanceRow = {
  accountId: number;
  accountLabel: string;
  currency: string;
  available: number;
  pending: number;
};

export type PayoutRow = {
  accountId: number;
  accountLabel: string;
  id: string;
  amount: number;
  currency: string;
  status: string;
  /** False means somebody pressed the button. This account's payouts are all
   *  manual, which is why nothing here promises a "next payout" date: there
   *  is no schedule to read. */
  automatic: boolean;
  arrivalDate: string;
  createdAt: string;
};

/** How far back one account's day tables reach, and whether that is the whole
 *  account. Read from the database, because the collector is restarted far
 *  more often than the account is. */
export type AccountState = {
  historyFrom: string | null;
  backfilled: boolean;
};

export type AccountOutcome = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  /** What this account's history now covers, to be written back. */
  state?: AccountState;
  rows?: number;
};

export type CollectResult = {
  chargeDays: ChargeDay[];
  /** The rolling walk's charges, one row each — never the history chunk's,
   *  which is read once and would otherwise freeze in the table. */
  charges: ChargeRow[];
  ledgerDays: LedgerDay[];
  subscriptions: SubscriptionRow[];
  balances: BalanceRow[];
  payouts: PayoutRow[];
  accounts: AccountOutcome[];
  accountsTried: number;
  warnings: string[];
  /** Cancellations still waiting on an invoice lookup. Published rather than
   *  hidden: a churn figure computed while some rows are unresolved is a
   *  churn figure that may still move. */
  unresolved: number;
  truncated: string[];
};

/* -------------------------------------------------------------------- http */

export class StripeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StripeError";
    this.status = status;
  }
}

type Params = Record<string, string | number | undefined>;

/**
 * The only HTTP call in this file. GET, no body, by construction.
 *
 * There is no second function here that takes a method or a payload, so
 * "this integration cannot write to Stripe" is a property of the code rather
 * than a promise in a comment. The key is live.
 */
async function get<T>(path: string, key: string, params: Params = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null) qs.set(k, String(v));
  const url = `${STRIPE_API}/${path}${qs.toString() ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Stripe explains itself in the body, and its sentences are good ones —
    // "This API call cannot be made with a publishable API key" names the
    // mistake where a bare 401 would send the owner to rotate a fine key.
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ? ` — ${body.error.message}` : "";
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new StripeError(res.status, `HTTP ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

type Page<T> = { data?: T[]; has_more?: boolean };

/**
 * Walk a Stripe list endpoint.
 *
 * `hit` is a set the caller owns; the path is added to it when the cap
 * actually bit AND Stripe still had more to give. A short walk that says so is
 * a caveat; a short walk that says nothing is a wrong number.
 */
async function* page<T extends { id: string }>(
  path: string,
  key: string,
  params: Params,
  hit: Set<string>,
  cap = PAGE_CAP,
): AsyncGenerator<T> {
  let after: string | undefined;
  let seen = 0;
  while (seen < cap) {
    const doc = await get<Page<T>>(path, key, { ...params, limit: 100, starting_after: after });
    const rows = doc.data ?? [];
    for (const r of rows) yield r;
    seen += rows.length;
    if (!doc.has_more || !rows.length) return;
    after = rows[rows.length - 1]!.id;
  }
  hit.add(path);
}

/* ------------------------------------------------------------------ verify */

/**
 * Is this key real, and can it read the two things everything else rests on?
 *
 * Asked of `/v1/balance` — the cheapest call Stripe has, one object, no
 * pagination — and then of one page of subscriptions, because a restricted key
 * can carry balance access and not subscription access and would otherwise
 * connect happily and show an MRR of nothing. Both refusals are named, so the
 * owner learns which permission is missing at the point the key was pasted
 * rather than from an empty card an hour later.
 */
export async function verify(
  key: string,
): Promise<
  | { ok: true; livemode: boolean; currencies: string[] }
  | { ok: false; error: string }
> {
  try {
    const bal = await get<{
      livemode?: boolean;
      available?: { currency: string }[];
      pending?: { currency: string }[];
    }>("balance", key);
    await get<Page<{ id: string }>>("subscriptions", key, { limit: 1, status: "all" });
    const currencies = [
      ...new Set([
        ...(bal.available ?? []).map((b) => b.currency),
        ...(bal.pending ?? []).map((b) => b.currency),
      ]),
    ].sort();
    return { ok: true, livemode: Boolean(bal.livemode), currencies };
  } catch (err) {
    if (err instanceof StripeError) {
      if (err.status === 401)
        return {
          ok: false,
          error:
            "Stripe refused that key. A restricted key (rk_live_…) needs READ " +
            "access to Balance, Balance transactions, Charges, Subscriptions, " +
            "Prices, Invoices and Payouts; a publishable key (pk_…) is refused " +
            "on every one of them.",
        };
      if (err.status === 403)
        return {
          ok: false,
          error: `${err.message} — the key is real but is missing a read permission. Balance and Subscriptions are both required.`,
        };
      return { ok: false, error: err.message };
    }
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      error:
        name === "TimeoutError"
          ? "Stripe did not answer within 45 seconds."
          : `Could not reach Stripe (${name}).`,
    };
  }
}

/* ----------------------------------------------------------------- helpers */

/**
 * Minor units to major units, for everything this collector stores.
 *
 * EXPORTED, and `customers/events.ts` calls IT rather than converting again
 * for the message it sends to a phone. A second conversion at a different
 * precision means the figure on the phone and the figure on the recovery case
 * differ in the last places for one failed invoice, and nothing says so.
 *
 * Four decimal places, not six. Stripe's amounts are whole minor units, so the
 * two agree exactly on a single row; six places invent a tail on a monthly
 * figure normalised from a yearly price, longer than any settled figure
 * carries, and make two correctly-equal numbers compare unequal on the last
 * digit.
 */
export const money = (cents: number) => fromMinorUnits(cents);

const utcDay = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

const iso = (seconds: number | null | undefined) =>
  seconds ? new Date(seconds * 1000).toISOString() : null;

/**
 * The start of the UTC day a timestamp falls in.
 *
 * THE WALK'S EDGE HAS TO BE A DAY BOUNDARY — the collector this replaces lost
 * an afternoon finding out why. The day tables are keyed by day and
 * every run REPLACES the days it covered; a walk starting at 11:00 on the
 * ninetieth day back reads only that day's afternoon and then overwrites the
 * whole day with it. One run later the day is outside the walk entirely, so
 * the truncated version is the one kept — permanently, and growing by one
 * wrong day a day. Rounding down to midnight costs a few extra hours of
 * charges and makes every rewritten day a whole one.
 */
const utcMidnight = (seconds: number) => seconds - (seconds % 86_400);

const dayBefore = (day: string) =>
  new Date(`${day}T00:00:00Z`).getTime() / 1000;

/* ------------------------------------------------------------------ pricing */

type StripePrice = {
  id: string;
  nickname?: string | null;
  currency?: string;
  unit_amount?: number | null;
  recurring?: { interval?: string; interval_count?: number } | null;
  product?: string | { id?: string; name?: string } | null;
};

type StripeCoupon = {
  percent_off?: number | null;
  amount_off?: number | null;
  currency?: string | null;
  duration?: string | null;
};

type StripeDiscount = { coupon?: StripeCoupon; end?: number | null };

type StripeSubscription = {
  id: string;
  status?: string;
  created?: number;
  canceled_at?: number | null;
  ended_at?: number | null;
  cancel_at?: number | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  trial_start?: number | null;
  trial_end?: number | null;
  cancellation_details?: { reason?: string | null } | null;
  discount?: StripeDiscount | null;
  discounts?: (StripeDiscount | string)[] | null;
  items?: { data?: { price?: StripePrice; quantity?: number }[] };
};

/**
 * The share of a subscription's list price that is actually invoiced.
 *
 * MRR taken as `unit_amount × quantity` is the STICKER and not the money —
 * every coupon on the account gets billed to the dashboard at full price.
 * A `percent_off` scales the whole invoice. An `amount_off` is a flat sum off
 * each invoice and is normalised to a month by the subscription's own interval
 * before it can be compared to a monthly figure: an annual plan with $12 off a
 * year is $1 of MRR, not $12.
 *
 * A coupon whose `end` has passed is spent. A `once` coupon comes off the next
 * invoice only — a one-off discount is not a change in recurring revenue — so
 * it is left out entirely rather than being silently either way. Forever and
 * still-running repeating coupons are applied.
 */
function discountFactor(
  sub: StripeSubscription,
  listedMonthly: number,
  perMonth: number,
  currency: string,
  nowSec: number,
): { factor: number; notes: string[] } {
  const found: StripeDiscount[] = [];
  const notes: string[] = [];
  let unresolved = 0;
  if (sub.discount && typeof sub.discount === "object") found.push(sub.discount);
  for (const d of sub.discounts ?? []) {
    if (d && typeof d === "object") found.push(d);
    else if (d) unresolved += 1;
  }
  if (unresolved)
    notes.push(`${unresolved} discount(s) came back as ids and were not applied`);

  let factor = 1;
  for (const d of found) {
    const coupon = d.coupon ?? {};
    if (d.end && d.end <= nowSec) continue;
    if (coupon.duration === "once") {
      notes.push("a one-off coupon is pending and is not in MRR");
      continue;
    }
    if (coupon.percent_off) {
      factor *= Math.max(0, 1 - Number(coupon.percent_off) / 100);
      continue;
    }
    const off = coupon.amount_off;
    if (!off) continue;
    // A fixed coupon only means anything against the same currency; where they
    // disagree Stripe would not apply it here either.
    if (coupon.currency && coupon.currency !== currency) {
      notes.push("an amount_off coupon is in another currency and was not applied");
      continue;
    }
    if (listedMonthly <= 0) continue;
    factor *= Math.max(0, 1 - (Number(off) * perMonth) / listedMonthly);
  }
  return { factor, notes };
}

/* ----------------------------------------------------------------- collect */

/** The accounts holding a key, in the order they were added. */
export function keyAccounts(reader: string): { account: Account; key: string }[] {
  return accounts
    .credentialed("stripe", ["key"], reader)
    .ready.map(({ account, values }) => ({ account, key: values.key! }));
}

/**
 * The two accumulators, IN CENTS.
 *
 * Stripe reports integers of the smallest currency unit and every sum below is
 * done in them, converted once on the way out. Adding dollars-as-floats across
 * a thousand charges accumulates a tail that turns "gross - refunds - fees"
 * into a net that misses by a cent — and a reconciliation identity that is
 * nearly true is worse than one that is not offered.
 */
type DayAcc = Omit<ChargeDay, "accountId" | "accountLabel" | "day" | "currency">;
type LedgerAcc = Omit<LedgerDay, "accountId" | "accountLabel" | "day" | "currency">;

const emptyDay = (): DayAcc => ({
  gross: 0,
  refunded: 0,
  refunds: 0,
  succeeded: 0,
  failed: 0,
  blocked: 0,
  declined: 0,
});

const emptyLedger = (): LedgerAcc => ({
  gross: 0,
  /* Never accumulated. `fees` is DERIVED — feesTotal less the withheld tax —
     and is computed once, at the end, where the row is converted to dollars.
     Adding to it here as well would be a second definition of Stripe's cut,
     and the two would eventually disagree about a rate the whole board
     divides by. It is in the shape only so the accumulator matches the row it
     becomes. */
  fees: 0,
  taxWithheld: 0,
  feesTotal: 0,
  refunds: 0,
  disputes: 0,
  other: 0,
  net: 0,
  count: 0,
  processing: 0,
  managedPayments: 0,
  disputeFees: 0,
  billing: 0,
  otherFees: 0,
});

/**
 * Every connected Stripe account, one after another.
 *
 * ONE ACCOUNT FAILING LOSES ONLY THAT ACCOUNT, exactly as it does everywhere
 * else here: a revoked key takes its own book off the page and leaves the
 * other account's revenue where it was. The run fails only when every account
 * failed.
 *
 * `state` is what each account's day tables already cover; `resolved` is the
 * set of subscription ids whose "did it ever bill" question has already been
 * answered and is never asked twice.
 */
export async function collect(
  state: Map<number, AccountState>,
  resolved: Map<string, number>,
  reader = "collect_stripe",
): Promise<CollectResult> {
  const pairs = keyAccounts(reader);
  const out: CollectResult = {
    chargeDays: [],
    charges: [],
    ledgerDays: [],
    subscriptions: [],
    balances: [],
    payouts: [],
    accounts: [],
    accountsTried: pairs.length,
    warnings: [],
    unresolved: 0,
    truncated: [],
  };

  for (const { account, key } of pairs) {
    const label = account.label;
    const truncated = new Set<string>();
    try {
      const walked = await collectAccount(
        account,
        key,
        state.get(account.id) ?? { historyFrom: null, backfilled: false },
        resolved,
        truncated,
      );
      out.chargeDays.push(...walked.chargeDays);
      out.charges.push(...walked.charges);
      out.ledgerDays.push(...walked.ledgerDays);
      out.subscriptions.push(...walked.subscriptions);
      out.balances.push(...walked.balances);
      out.payouts.push(...walked.payouts);
      out.unresolved += walked.unresolved;
      for (const note of walked.notes)
        if (!out.warnings.includes(`${label}: ${note}`))
          out.warnings.push(`${label}: ${note}`);
      for (const t of truncated) {
        const line = `${label}: the ${t} walk hit its ${PAGE_CAP}-row cap and Stripe had more`;
        out.truncated.push(line);
        out.warnings.push(line);
      }
      out.accounts.push({
        id: account.id,
        label,
        ok: true,
        state: walked.state,
        rows:
          walked.chargeDays.length +
          walked.ledgerDays.length +
          walked.subscriptions.length,
      });
    } catch (err) {
      const error = describe(err);
      out.warnings.push(`${label}: ${error}`);
      out.accounts.push({ id: account.id, label, ok: false, error });
    }
  }

  return out;
}

async function collectAccount(
  account: Account,
  key: string,
  state: AccountState,
  resolved: Map<string, number>,
  truncated: Set<string>,
) {
  const label = account.label;
  const nowSec = Math.floor(Date.now() / 1000);
  const rollingFrom = utcMidnight(nowSec - WALK_DAYS * 86_400);
  const notes: string[] = [];

  /* ---- the price list, for plan and product names ---------------------- */
  // Expanded rather than a second walk over /products: one request instead of
  // two, and a price whose product cannot be expanded keeps its own nickname
  // rather than borrowing a name from somewhere else.
  const planOf = new Map<string, string>();
  const productOf = new Map<string, string>();
  for await (const p of page<StripePrice & { id: string }>(
    "prices",
    key,
    { "expand[]": "data.product" },
    truncated,
  )) {
    const product =
      p.product && typeof p.product === "object" ? (p.product.name ?? null) : null;
    planOf.set(p.id, p.nickname || product || p.id);
    productOf.set(p.id, product ?? "Other");
  }

  /* ---- balance and payouts --------------------------------------------- */
  const bal = await get<{
    available?: { currency: string; amount: number }[];
    pending?: { currency: string; amount: number }[];
  }>("balance", key);
  const byCurrency = new Map<string, { available: number; pending: number }>();
  for (const b of bal.available ?? []) {
    const row = byCurrency.get(b.currency) ?? { available: 0, pending: 0 };
    row.available += b.amount;
    byCurrency.set(b.currency, row);
  }
  for (const b of bal.pending ?? []) {
    const row = byCurrency.get(b.currency) ?? { available: 0, pending: 0 };
    row.pending += b.amount;
    byCurrency.set(b.currency, row);
  }
  const balances: BalanceRow[] = [...byCurrency.entries()].map(([currency, v]) => ({
    accountId: account.id,
    accountLabel: label,
    currency,
    available: money(v.available),
    pending: money(v.pending),
  }));

  const payoutDoc = await get<Page<{
    id: string;
    amount: number;
    currency: string;
    status: string;
    automatic: boolean;
    arrival_date: number;
    created: number;
  }>>("payouts", key, { limit: PAYOUTS });
  const payouts: PayoutRow[] = (payoutDoc.data ?? []).map((p) => ({
    accountId: account.id,
    accountLabel: label,
    id: p.id,
    amount: money(p.amount),
    currency: p.currency,
    status: p.status,
    automatic: Boolean(p.automatic),
    arrivalDate: utcDay(p.arrival_date),
    createdAt: iso(p.created)!,
  }));

  /* ---- subscriptions: the whole book, live and dead --------------------- */
  //
  // status=all and unbounded in time on purpose. It is seven requests for this
  // account's 698 subscriptions, and it is what makes churn answerable over
  // ANY window without a second walk — the rows carry their own timestamps and
  // the route filters them when somebody asks.
  //
  // The discount expansion is probed once rather than assumed: an unsupported
  // `expand` is a hard 400 on some API versions, and a 400 mid-walk would cost
  // the whole account for the sake of ten coupons.
  const subParams: Params = { status: "all" };
  try {
    await get("subscriptions", key, { limit: 1, status: "all", "expand[]": "data.discounts" });
    subParams["expand[]"] = "data.discounts";
  } catch {
    notes.push(
      "this API version does not expand subscription discounts, so only coupons returned inline are applied to MRR",
    );
  }

  const subscriptions: SubscriptionRow[] = [];
  const toResolve: { id: string; endedAt: number }[] = [];

  for await (const s of page<StripeSubscription & { id: string }>(
    "subscriptions",
    key,
    subParams,
    truncated,
  )) {
    const status = s.status ?? "unknown";
    const items = s.items?.data ?? [];

    // The subscription's interval comes off its FIRST line, which is the one
    // that decides how the whole thing bills. A mixed-interval subscription
    // does not exist at Stripe.
    let perMonth: number | null = null;
    let currency = "usd";
    let interval: string | null = null;
    let intervalCount: number | null = null;
    let listed = 0;
    for (const item of items) {
      const price: StripePrice = item.price ?? { id: "" };
      const rec = price.recurring ?? {};
      const per = (PER_MONTH[rec.interval ?? "month"] ?? 1) / (rec.interval_count || 1);
      if (perMonth === null) {
        perMonth = per;
        currency = price.currency ?? "usd";
        interval = rec.interval ?? null;
        intervalCount = rec.interval_count ?? null;
      }
      listed += (price.unit_amount ?? 0) * (item.quantity ?? 1) * per;
    }

    const { factor, notes: why } = discountFactor(
      s,
      listed,
      perMonth ?? 1,
      currency,
      nowSec,
    );
    for (const n of why) if (!notes.includes(n)) notes.push(n);

    const live = status === "active" || status === "trialing";
    const ended = !live ? (s.canceled_at ?? s.ended_at ?? null) : null;
    const firstPrice = items[0]?.price;

    /*
      DOES THIS CANCELLATION NEED AN INVOICE LOOKUP? Two of them do not.

      `incomplete_expired` is Stripe's own word for a subscription whose FIRST
      payment never succeeded inside the 23-hour window — it cannot have
      collected anything, so it is resolved at zero here without spending a
      request. That is 182 of this account's 336 dead subscriptions, and they
      are the ones that would otherwise dominate a churn figure: they are
      failed checkouts, not customers who left.

      Everything else that has ended and has never been asked goes on the list.
    */
    let paidCents = resolved.get(s.id) ?? null;
    if (ended && paidCents === null) {
      if (status === "incomplete_expired") paidCents = 0;
      else toResolve.push({ id: s.id, endedAt: ended });
    }

    subscriptions.push({
      accountId: account.id,
      accountLabel: label,
      id: s.id,
      status,
      currency,
      monthlyUsd: money(listed * factor),
      listedMonthlyUsd: money(listed),
      interval,
      intervalCount,
      product: firstPrice ? (productOf.get(firstPrice.id ?? "") ?? "Other") : null,
      plan: firstPrice ? (planOf.get(firstPrice.id ?? "") ?? null) : null,
      createdAt: iso(s.created ?? 0)!,
      endedAt: iso(ended),
      cancelAtPeriodEnd: Boolean(s.cancel_at_period_end),
      cancelAt: iso(s.cancel_at ?? s.current_period_end),
      trialStart: iso(s.trial_start),
      trialEnd: iso(s.trial_end),
      reason: s.cancellation_details?.reason ?? null,
      paidCents,
    });
  }

  /*
    THE ONE EXTRA REQUEST PER CANCELLATION, newest first and capped.

    Whether any money ever changed hands is the question that decides whether a
    cancellation is churn at all, and it is not on the subscription object.
    This was learned the expensive way: $415 of a reported $430 monthly
    churn turned out to be free trials that were cancelled — revenue that never
    existed — while the one real loss in the window was a three-year customer
    whose card finally died. A duration heuristic cannot tell those apart in
    either direction. The invoice list can.
  */
  toResolve.sort((a, b) => b.endedAt - a.endedAt);
  let unresolved = Math.max(0, toResolve.length - RESOLVE_PER_RUN);
  for (const { id } of toResolve.slice(0, RESOLVE_PER_RUN)) {
    try {
      let cents = 0;
      for await (const inv of page<{ id: string; amount_paid?: number }>(
        "invoices",
        key,
        { subscription: id },
        truncated,
        200,
      ))
        cents += inv.amount_paid ?? 0;
      const row = subscriptions.find((r) => r.id === id);
      if (row) row.paidCents = cents;
    } catch {
      // "Cannot say" and it stays that way: the row keeps paidCents null and
      // the reader treats null as paid, which is the direction that never
      // flatters retention.
      unresolved += 1;
    }
  }

  /* ---- the two day walks ------------------------------------------------ */
  const chargeAcc = new Map<string, DayAcc>();
  const ledgerAcc = new Map<string, LedgerAcc>();

  /*
    THE ROLLING WALK IS THE ONLY ONE THAT KEEPS INDIVIDUAL CHARGES. It rereads
    the same ninety days on every run, so a row it wrote is a row it will
    correct — a refund, a late dispute. The history chunk below is read once
    and never again, and a charge kept from it would be a charge frozen at
    whatever it looked like that day; the collector prunes to the same edge.
  */
  const charges: ChargeRow[] = [];
  /* BEFORE THE CHARGES, because the charge rows are written with the product
     the session names and a second pass over them would be a second place for
     the join to be got wrong. Same window as the rolling walk, so every charge
     inside it that can be attributed is. */
  const oneOff = await walkCheckoutSessions(
    key,
    { "created[gte]": rollingFrom },
    productOf,
    truncated,
    notes,
  );
  await walkCharges(key, { "created[gte]": rollingFrom }, chargeAcc, truncated, {
    accountId: account.id,
    keep: charges,
    oneOff,
  });
  await walkLedger(key, { "created[gte]": rollingFrom }, ledgerAcc, truncated);

  /*
    HISTORY, ONE CHUNK PER RUN.

    The first run writes down where the rolling window starts and stops there,
    so pasting a key costs one window rather than however many years the
    account has. Every run after it walks one chunk further back, and the run
    that finds nothing older than the chunk it just read marks the account
    backfilled and never asks again. `backfilled` is only set on the evidence
    of that probe — a chunk that came back empty because it hit a page cap
    would otherwise freeze a short history into the state forever.
  */
  let state2: AccountState = state;
  if (state.historyFrom === null) {
    /*
      The first run writes the bookmark and stops. Deliberately NOT a warning:
      an integration that is working exactly as designed must not put a line on
      the plugin page that reads as a fault. How far the history reaches is
      published by the route, beside the figures it qualifies.
    */
    state2 = { historyFrom: utcDay(rollingFrom), backfilled: false };
  } else if (!state.backfilled) {
    const until = dayBefore(state.historyFrom);
    const from = utcMidnight(until - HISTORY_CHUNK_DAYS * 86_400);
    const range = { "created[gte]": from, "created[lt]": until };
    await walkCharges(key, range, chargeAcc, truncated);
    await walkLedger(key, range, ledgerAcc, truncated);

    // Is there anything at all older than the chunk just read? One request
    // each, and a definitive answer — the alternative, "stop when a chunk
    // comes back empty", would stop at any quiet season the account had.
    const olderCharges = await get<Page<{ id: string }>>("charges", key, {
      limit: 1,
      "created[lt]": from,
    });
    const olderLedger = await get<Page<{ id: string }>>("balance_transactions", key, {
      limit: 1,
      "created[lt]": from,
    });
    const done = !(olderCharges.data ?? []).length && !(olderLedger.data ?? []).length;
    state2 = { historyFrom: utcDay(from), backfilled: done };
  }

  const chargeDays: ChargeDay[] = [...chargeAcc.entries()].map(([k, v]) => {
    const [day, currency] = k.split("|") as [string, string];
    return {
      accountId: account.id,
      accountLabel: label,
      day,
      currency,
      ...v,
      gross: money(v.gross),
      refunded: money(v.refunded),
    };
  });
  const ledgerDays: LedgerDay[] = [...ledgerAcc.entries()].map(([k, v]) => {
    const [day, currency] = k.split("|") as [string, string];
    return {
      accountId: account.id,
      accountLabel: label,
      day,
      currency,
      count: v.count,
      gross: money(v.gross),
      // Stripe's own cut, EX-TAX: the figure a blended rate is derived from,
      // and the reason `taxWithheld` is a column rather than a bucket inside
      // this one. Both come out of the same scalar.
      fees: money(v.feesTotal - v.taxWithheld),
      taxWithheld: money(v.taxWithheld),
      feesTotal: money(v.feesTotal),
      refunds: money(v.refunds),
      disputes: money(v.disputes),
      other: money(v.other),
      net: money(v.net),
      processing: money(v.processing),
      managedPayments: money(v.managedPayments),
      disputeFees: money(v.disputeFees),
      billing: money(v.billing),
      otherFees: money(v.otherFees),
    };
  });

  return {
    chargeDays,
    charges,
    ledgerDays,
    subscriptions,
    balances,
    payouts,
    unresolved,
    notes,
    state: state2,
  };
}

/* ------------------------------------------------- what a one-off bought */

/**
 * THE PRODUCT BEHIND A ONE-OFF PAYMENT, WHICH THE CHARGE OBJECT DOES NOT HOLD.
 *
 * A subscription's product is reachable: the item carries a price and the
 * price list above turns a price id into a name. A one-off payment carries
 * NOTHING — on this account every such charge has `description: null` — so the
 * settled cash of a venture that sells a lifetime licence was, until this
 * walk, money with no product, no venture and no page it could appear on.
 *
 * THE SESSION IS WHERE THE PRODUCT STILL EXISTS. A Checkout Session (and a
 * Payment Link, which creates one) holds the line items that were bought and
 * the payment intent that paid for them, and the charge holds the same payment
 * intent. So: one walk of the sessions over the window the charges are walked
 * over, keyed by payment intent, and the charge walk looks itself up.
 *
 * TWO THINGS ARE FILTERED HERE RATHER THAN IN THE QUERY, deliberately. Stripe's
 * list endpoint documents `status`, `created`, `customer`, `payment_intent`,
 * `payment_link` and `subscription` as filters and does NOT document `mode` or
 * `payment_status`, so those two are applied to the objects that come back. A
 * filter invented in a query string either 400s or is ignored, and the second
 * of those is the dangerous one — it would silently count subscription
 * checkouts as one-off cash.
 *
 * THE EXPANSION HAS A FALLBACK. `expand[]=data.line_items` is what makes this
 * one request per hundred sessions rather than one per session; if Stripe
 * refuses the expansion on the list endpoint, the walk is repeated without it
 * and the run attributes nothing rather than making a per-session request each
 * time. That is a caveat in `notes` and never a wrong product.
 */
export type OneOffAttribution = { product: string | null; priceId: string | null };

type StripeCheckoutSession = {
  id: string;
  mode?: string | null;
  status?: string | null;
  payment_status?: string | null;
  payment_intent?: string | { id?: string } | null;
  line_items?: {
    data?: { price?: (StripePrice & { id?: string }) | null }[];
  } | null;
};

/**
 * ONE SESSION, READ — split out from the walk because this is the part with the
 * decisions in it, and a decision that cannot be tested without a live Stripe
 * account is a decision nobody checks.
 *
 * Null means "this session is not one-off cash, or cannot be joined to a
 * charge", and every one of its reasons is a fact about the session rather
 * than a failure.
 */
export function sessionAttribution(
  sess: {
    mode?: string | null;
    payment_status?: string | null;
    payment_intent?: string | { id?: string } | null;
    line_items?: { data?: { price?: { id?: string; product?: unknown } | null }[] } | null;
  },
  productOf: Map<string, string>,
): (OneOffAttribution & { intent: string }) | null {
  /* A subscription checkout is not one-off cash, and an unpaid completed
     session is not cash at all. */
  if (sess.mode !== "payment" || sess.payment_status !== "paid") return null;
  const intent =
    typeof sess.payment_intent === "string"
      ? sess.payment_intent
      : (sess.payment_intent?.id ?? null);
  if (!intent) return null;

  const price = sess.line_items?.data?.[0]?.price ?? null;
  const priceId = price?.id ?? null;
  /* The expanded product's own name first; the price list second, for a
     session whose price came back as an id. An ad-hoc `price_data` line is in
     neither, and stays null rather than being filed under "Other". */
  const product = price?.product;
  const named =
    product && typeof product === "object"
      ? ((product as { name?: string | null }).name ?? null)
      : null;
  return {
    intent,
    priceId,
    product: named ?? (priceId ? (productOf.get(priceId) ?? null) : null),
  };
}

async function walkCheckoutSessions(
  key: string,
  range: Params,
  /** price id to product name, from the price list this account already walked. */
  productOf: Map<string, string>,
  truncated: Set<string>,
  notes: string[],
): Promise<Map<string, OneOffAttribution>> {
  const out = new Map<string, OneOffAttribution>();

  const walk = async (expand: boolean) => {
    const params: Params = { ...range, status: "complete" };
    if (expand) params["expand[]"] = "data.line_items";
    for await (const sess of page<StripeCheckoutSession & { id: string }>(
      "checkout/sessions",
      key,
      params,
      truncated,
    )) {
      const bought = sessionAttribution(sess, productOf);
      if (bought) out.set(bought.intent, { product: bought.product, priceId: bought.priceId });
    }
  };

  try {
    await walk(true);
  } catch (err) {
    if (!(err instanceof StripeError) || err.status !== 400) throw err;
    out.clear();
    notes.push(
      "Stripe would not expand line items while listing Checkout Sessions, so one-off " +
        "payments have no product this run",
    );
    await walk(false);
  }
  return out;
}

type StripeCharge = {
  id: string;
  created: number;
  /** The one id a charge and its Checkout Session share. */
  payment_intent?: string | { id?: string } | null;
  amount?: number;
  amount_refunded?: number;
  currency?: string;
  status?: string;
  paid?: boolean;
  refunded?: boolean;
  outcome?: { type?: string } | null;
  description?: string | null;
  /** The address on the card form; `receipt_email` is the one Stripe was
   *  told to send the receipt to. Either identifies the row and both are
   *  masked on the way in. */
  billing_details?: { email?: string | null } | null;
  receipt_email?: string | null;
  failure_code?: string | null;
  failure_message?: string | null;
};

async function walkCharges(
  key: string,
  range: Params,
  acc: Map<string, DayAcc>,
  truncated: Set<string>,
  /** Where to keep the rows themselves, when this walk is one whose rows
   *  will be read again. Absent for the history chunk. `oneOff` is what the
   *  session walk found, keyed by payment intent. */
  rows?: { accountId: number; keep: ChargeRow[]; oneOff?: Map<string, OneOffAttribution> },
) {
  for await (const c of page<StripeCharge>("charges", key, range, truncated)) {
    const currency = c.currency ?? "usd";
    const k = `${utcDay(c.created)}|${currency}`;
    const row = acc.get(k) ?? emptyDay();
    const ok = Boolean(c.paid) && c.status === "succeeded";
    if (rows) {
      const intent =
        typeof c.payment_intent === "string" ? c.payment_intent : (c.payment_intent?.id ?? null);
      const bought = intent ? (rows.oneOff?.get(intent) ?? null) : null;
      rows.keep.push({
        id: c.id,
        accountId: rows.accountId,
        amount: money(c.amount ?? 0),
        currency,
        status: c.status ?? "unknown",
        paid: Boolean(c.paid),
        refunded: Boolean(c.refunded) || (c.amount_refunded ?? 0) > 0,
        createdAt: iso(c.created) ?? new Date(0).toISOString(),
        description: c.description ?? null,
        emailMasked: maskEmail(c.billing_details?.email ?? c.receipt_email),
        failureCode: c.failure_code ?? null,
        failureMessage: c.failure_message ?? null,
        outcomeType: c.outcome?.type ?? null,
        product: bought?.product ?? null,
        priceId: bought?.priceId ?? null,
      });
    }
    if (ok) {
      row.gross += c.amount ?? 0;
      row.succeeded += 1;
    } else if (c.status === "failed") {
      row.failed += 1;
      // Anything that is neither blocked nor issuer_declined counts as
      // neither rather than being guessed into one of them.
      if (c.outcome?.type === "blocked") row.blocked += 1;
      else if (c.outcome?.type === "issuer_declined") row.declined += 1;
    }
    /*
      A refund is recorded against the day of the CHARGE, not the day the
      refund happened. That is what "refunded" has always meant in a revenue
      window — money back out of what came in on that day — and the ninety-day
      rewalk is what keeps it true when a refund lands in September against a
      July charge. The ledger table below dates the same refund the other way,
      by settlement, which is why the two are never added together.
    */
    const refunded = c.amount_refunded ?? 0;
    if (refunded > 0 || c.refunded) {
      row.refunds += 1;
      row.refunded += refunded;
    }
    acc.set(k, row);
  }
}

type StripeBalanceTx = {
  id: string;
  created: number;
  currency?: string;
  amount?: number;
  fee?: number;
  net?: number | null;
  type?: string;
  description?: string | null;
  reporting_category?: string | null;
  fee_details?: { type?: string; description?: string | null; amount?: number }[] | null;
};

async function walkLedger(
  key: string,
  range: Params,
  acc: Map<string, LedgerAcc>,
  truncated: Set<string>,
) {
  for await (const b of page<StripeBalanceTx>("balance_transactions", key, range, truncated)) {
    const category =
      b.reporting_category ?? TYPE_CATEGORY[b.type ?? ""] ?? "other_adjustment";
    if (LEDGER_EXCLUDED.has(category)) continue;

    const currency = b.currency ?? "usd";
    const k = `${utcDay(b.created)}|${currency}`;
    const row = acc.get(k) ?? emptyLedger();
    const amount = b.amount ?? 0;
    const fee = b.fee ?? 0;
    const net = b.net ?? amount - fee;

    row.count += 1;
    row.feesTotal += fee;
    row.net += net;
    if (category === "charge") row.gross += amount;
    else if (category === "refund" || category === "refund_failure") row.refunds -= amount;
    else if (category === "dispute" || category === "dispute_reversal") row.disputes -= amount;
    else if (category === "fee") {
      // A standalone fee row is money out with no fee field of its own — the
      // Managed Payments and Billing lines this account is charged daily.
      row.feesTotal -= amount;
      addFee(row, feeBucket(b.type ?? null, b.description ?? null), -amount);
    } else row.other += amount;

    /*
      THE FEE SCALAR, DECOMPOSED, with the residual kept rather than dropped.
      `fee` is one number and reading only that is how 46% of a "fee" turns out
      to be money Stripe never kept: on this account the last thirty days split
      into withheld sales tax, card processing, a merchant-of-record
      transaction fee, dispute fees and Billing usage — and the tax is larger
      than the processing. Anything the details do not account for lands in
      `other`, so the buckets always add back up to the scalar they came from.
    */
    if (fee) {
      let seen = 0;
      for (const d of b.fee_details ?? []) {
        const cents = d.amount ?? 0;
        addFee(row, feeBucket(d.type ?? null, d.description ?? null), cents);
        seen += cents;
      }
      if (seen !== fee) addFee(row, "other", fee - seen);
    }
    acc.set(k, row);
  }
}

/** One fee bucket, in CENTS. `tax` is kept apart from the rest for the whole
 *  of the ledger's life: it is a pass-through, not a cost. */
function addFee(row: LedgerAcc, bucket: string, cents: number) {
  if (bucket === "tax") row.taxWithheld += cents;
  else if (bucket === "processing") row.processing += cents;
  else if (bucket === "managedPayments") row.managedPayments += cents;
  else if (bucket === "disputes") row.disputeFees += cents;
  else if (bucket === "billing") row.billing += cents;
  else row.otherFees += cents;
}

function describe(err: unknown): string {
  if (err instanceof StripeError) {
    if (err.status === 401)
      return "Stripe refused the key — it has been revoked or rolled.";
    if (err.status === 403)
      return `${err.message} — the key is missing a read permission.`;
    return err.message;
  }
  if (err instanceof Error && err.name === "TimeoutError")
    return "Stripe did not answer within 45 seconds.";
  return err instanceof Error ? err.name : "Error";
}

export type { Account };

/* ------------------------------------------------- cases, disputes, events */

/**
 * THE FOUR READS THE CUSTOMERS AREA ADDED, and why they are here rather than
 * in that area's own file.
 *
 * `get()` above is the only HTTP call in this integration and takes no body,
 * which is what makes "this cannot write to Stripe" a property of the code
 * rather than a promise. A second module holding a second fetch would end
 * that guarantee the day somebody needed a POST. So the customers area asks
 * for its four lists here, through the same GET, behind the same key reader,
 * and the enforcement stays structural.
 *
 * NONE OF THESE RUNS INSIDE `collect()`. The collector above is the revenue
 * walk and its cost is already understood — ninety days rewalked plus one
 * history chunk. Disputes, events, open invoices and customer lookups are the
 * customers area's own pass on its own clock, and a Stripe key that cannot
 * read them must not be able to take MRR off the page.
 */

/** Stripe's own dispute statuses that mean the case is still LIVE. Taken from
 *  the statuses Stripe documents and kept as a set rather than a "not won and
 *  not lost" test: `warning_closed` is neither won nor lost and is over. */
export const OPEN_DISPUTE_STATUSES = new Set([
  "warning_needs_response",
  "warning_under_review",
  "needs_response",
  "under_review",
]);

/** The statuses that mean the bank is waiting on the merchant. These are the
 *  only ones for which `evidence_due_by` is a date anybody must act on. */
export const NEEDS_RESPONSE_STATUSES = new Set([
  "warning_needs_response",
  "needs_response",
]);

export type DisputeRow = {
  id: string;
  charge: string | null;
  paymentIntent: string | null;
  /** Major units of `currency`, converted once here like every other money
   *  figure this file produces. */
  amount: number;
  currency: string;
  reason: string | null;
  status: string;
  evidenceDueBy: string | null;
  submissionCount: number | null;
  isChargeRefundable: boolean | null;
  createdAt: string;
  /** won | lost | null. NULL is "still live or closed without a verdict" and
   *  is never read as a win. */
  outcome: "won" | "lost" | null;
};

type StripeDispute = {
  id: string;
  charge?: string | { id?: string } | null;
  payment_intent?: string | { id?: string } | null;
  amount?: number;
  currency?: string;
  reason?: string | null;
  status?: string;
  created?: number;
  is_charge_refundable?: boolean;
  evidence_details?: { due_by?: number | null; submission_count?: number } | null;
};

const idOf = (v: unknown): string | null =>
  typeof v === "string" ? v : v && typeof v === "object" ? ((v as { id?: string }).id ?? null) : null;

/**
 * The dispute CASES on one account, from `created[gte]` forward.
 *
 * `since` is a unix second and the caller is expected to overlap it — the
 * status of a case changes for months after it was opened, so a walk that
 * only ever read new cases would show every dispute as permanently open. The
 * customers pass rewalks ninety days on every run and adds older history the
 * way the charge walk does.
 *
 * NO `expand`. The charge id is enough to hold the case to a payment, and
 * expanding the charge on every dispute would multiply the payload for a
 * field nothing here reads.
 */
export async function walkDisputes(
  key: string,
  since: number,
  truncated: Set<string> = new Set(),
): Promise<DisputeRow[]> {
  const out: DisputeRow[] = [];
  for await (const d of page<StripeDispute & { id: string }>(
    "disputes",
    key,
    { "created[gte]": since },
    truncated,
    2000,
  )) {
    const status = d.status ?? "unknown";
    out.push({
      id: d.id,
      charge: idOf(d.charge),
      paymentIntent: idOf(d.payment_intent),
      amount: money(d.amount ?? 0),
      currency: d.currency ?? "usd",
      reason: d.reason ?? null,
      status,
      evidenceDueBy: iso(d.evidence_details?.due_by ?? null),
      submissionCount: d.evidence_details?.submission_count ?? null,
      isChargeRefundable:
        typeof d.is_charge_refundable === "boolean" ? d.is_charge_refundable : null,
      createdAt: iso(d.created ?? 0)!,
      outcome: status === "won" ? "won" : status === "lost" ? "lost" : null,
    });
  }
  return out;
}

/** An invoice that is still open — issued, not paid, not voided. The only
 *  place `next_payment_attempt` exists, which is the deadline on a failing
 *  payment. */
export type OpenInvoiceRow = {
  id: string;
  customer: string | null;
  customerEmail: string | null;
  subscription: string | null;
  amountDue: number;
  amountRemaining: number;
  currency: string;
  attemptCount: number;
  /** ISO 8601 UTC, or null when Stripe has scheduled no further attempt —
   *  which means dunning is finished, not that a payment is imminent. */
  nextPaymentAttempt: string | null;
  dueDate: string | null;
  createdAt: string;
  hostedInvoiceUrl: string | null;
  number: string | null;
};

type StripeInvoice = {
  id: string;
  customer?: string | { id?: string } | null;
  customer_email?: string | null;
  subscription?: string | { id?: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id?: string } } } | null;
  amount_due?: number;
  amount_remaining?: number;
  currency?: string;
  attempt_count?: number;
  next_payment_attempt?: number | null;
  due_date?: number | null;
  created?: number;
  hosted_invoice_url?: string | null;
  number?: string | null;
};

/**
 * Every OPEN invoice on the account.
 *
 * `status=open` rather than a date window, because "is this invoice still
 * unpaid" is current state and an unpaid invoice from March is exactly the
 * one worth chasing.
 *
 * THE CAP MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS FILE, because the
 * caller uses ABSENCE from this list as evidence: a case whose invoice is not
 * returned is resolved as "Stripe no longer lists it as open". A truncated
 * walk is therefore not a short answer, it is a WRONG one, and the caller is
 * required to pass a Set and to skip that resolution when it fired. An account
 * with more than two thousand open invoices has a dunning problem this queue
 * is the wrong tool for.
 *
 * `subscription` MOVED ON NEWER API VERSIONS. It used to be a top-level field
 * and is now `parent.subscription_details.subscription`; both are read,
 * because the key the owner pasted decides which version answers and a
 * customers queue that lost its subscription link on an upgrade would silently
 * stop attributing invoices to plans.
 */
export async function walkOpenInvoices(
  key: string,
  truncated: Set<string> = new Set(),
): Promise<OpenInvoiceRow[]> {
  const out: OpenInvoiceRow[] = [];
  for await (const inv of page<StripeInvoice & { id: string }>(
    "invoices",
    key,
    { status: "open" },
    truncated,
    2000,
  )) {
    out.push({
      id: inv.id,
      customer: idOf(inv.customer),
      customerEmail: (inv.customer_email ?? "").trim() || null,
      subscription:
        idOf(inv.subscription) ?? idOf(inv.parent?.subscription_details?.subscription),
      amountDue: money(inv.amount_due ?? 0),
      amountRemaining: money(inv.amount_remaining ?? inv.amount_due ?? 0),
      currency: inv.currency ?? "usd",
      attemptCount: inv.attempt_count ?? 0,
      nextPaymentAttempt: iso(inv.next_payment_attempt ?? null),
      dueDate: iso(inv.due_date ?? null),
      createdAt: iso(inv.created ?? 0)!,
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      number: (inv.number ?? "").trim() || null,
    });
  }
  return out;
}

/** One customer, for an address. Asked once per case and never in a loop over
 *  the book — see customers/collect.ts for the cap. */
export type CustomerRow = { id: string; email: string | null; name: string | null; deleted: boolean };

export async function fetchCustomer(key: string, id: string): Promise<CustomerRow> {
  const c = await get<{ id: string; email?: string | null; name?: string | null; deleted?: boolean }>(
    `customers/${encodeURIComponent(id)}`,
    key,
  );
  return {
    id: c.id,
    email: (c.email ?? "").trim() || null,
    name: (c.name ?? "").trim() || null,
    deleted: Boolean(c.deleted),
  };
}

/**
 * The customer id on one subscription.
 *
 * `stripe_subscriptions` holds no customer column — the revenue walk never
 * needed one, because MRR is a property of a price rather than of a person —
 * so a churn case reaches its customer through one extra GET. It is asked
 * once per case, for a set measured in the low tens, and never in a loop over
 * the book. Adding the column to the revenue table instead would mean editing
 * the shared writer and re-collecting the whole account for a field only this
 * area reads.
 */
export async function fetchSubscriptionCustomer(
  key: string,
  id: string,
): Promise<string | null> {
  const sub = await get<{ customer?: string | { id?: string } | null }>(
    `subscriptions/${encodeURIComponent(id)}`,
    key,
  );
  return idOf(sub.customer);
}

/** The event types the customers area watches. Named here beside the walk
 *  that asks for them so the request and the list cannot drift. */
export const WATCHED_EVENTS = [
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "invoice.payment_failed",
  "invoice.paid",
  "charge.dispute.created",
  "charge.dispute.closed",
  "checkout.session.completed",
] as const;

export type StripeEventRow = {
  id: string;
  type: string;
  createdAt: string;
  created: number;
  /** The object the event is about, as Stripe sent it. Read for its own
   *  fields and never stored whole — a stored copy is a second, ageing
   *  version of a row Stripe still owns. */
  object: Record<string, unknown>;
  previous: Record<string, unknown> | null;
};

/**
 * One event walk's ceiling.
 *
 * Two thousand rather than five hundred because of the direction Stripe pages
 * in: `/v1/events` answers NEWEST FIRST and `starting_after` walks backwards
 * in time, so a capped walk keeps the newest N and silently drops the OLDER
 * ones — the opposite of every other walk in this file, where a cap drops the
 * tail nobody was reading. A caller that advanced a cursor past a capped
 * events walk would skip the middle of its own history. The cap is therefore
 * high enough that no ordinary account reaches it, and the caller is REQUIRED
 * to pass a truncation Set and hold its cursor when it fired.
 */
const EVENT_PAGE_CAP = 2000;

/**
 * Events since a cursor, oldest first.
 *
 * THE CAP IS A CALLER'S PROBLEM AND IT IS NAMED HERE BECAUSE OF THE PAGING
 * DIRECTION. When `truncated` gains "events", the rows returned are the NEWEST
 * `cap` events after `sinceSeconds` and everything between `sinceSeconds` and
 * the oldest returned row was never read. Advancing a cursor to the newest row
 * in that case skips them permanently — Stripe keeps events for thirty days
 * and nothing goes back for them. See collect.ts, which holds the cursor.
 *
 * `types[]` IS SENT TO STRIPE rather than filtered here. The notifier this
 * replaces pulled every event and dropped what it did not want, which works and costs
 * a page of JSON per unwatched burst; Stripe filters server-side for free and
 * the request then documents itself.
 *
 * THE CURSOR IS A TIMESTAMP AND THE DEDUPE IS THE PRIMARY KEY. `created[gt]`
 * cannot express "everything after this exact event" — two events can share a
 * second — so the walk overlaps by asking from the last second it saw, and
 * the events table's INSERT OR IGNORE on Stripe's own event id makes the
 * overlap free. A cursor of event ids alone would break the first time an
 * event aged out of Stripe's thirty-day retention.
 *
 * RETURNED OLDEST FIRST because that is the order they will be read in on a
 * phone. Stripe answers newest first.
 */
export async function walkEvents(
  key: string,
  sinceSeconds: number,
  truncated: Set<string> = new Set(),
  cap = EVENT_PAGE_CAP,
): Promise<StripeEventRow[]> {
  const params: Params = { "created[gte]": sinceSeconds };
  WATCHED_EVENTS.forEach((t, i) => {
    params[`types[${i}]`] = t;
  });
  const out: StripeEventRow[] = [];
  for await (const e of page<{
    id: string;
    type?: string;
    created?: number;
    data?: { object?: Record<string, unknown>; previous_attributes?: Record<string, unknown> };
  }>("events", key, params, truncated, cap)) {
    out.push({
      id: e.id,
      type: e.type ?? "unknown",
      created: e.created ?? 0,
      createdAt: iso(e.created ?? 0)!,
      object: e.data?.object ?? {},
      previous: e.data?.previous_attributes ?? null,
    });
  }
  return out.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}

/** The one place this file's error prose is reused outside `collect()`. The
 *  customers pass reports a missing Stripe permission with the same sentence
 *  the revenue collector would. */
export const describeStripeError = describe;
