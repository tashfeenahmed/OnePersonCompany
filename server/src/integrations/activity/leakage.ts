/**
 * TODAY — money on the floor.
 *
 * Revenue Stripe already tried to collect, or was ordered to give back, that
 * nobody is chasing. It is the one figure on this box that is worth opening a
 * dashboard for, because unlike MRR it is a number a person can go and change
 * this afternoon.
 *
 * NOTHING HERE IS STORED. Every figure below is computed from the Stripe
 * tables at the moment somebody asks, for the reason the uptime route computes
 * its availability on read: a stored "money on the floor: $9,271" is wrong ten
 * minutes later and badly wrong after a week of failed collections — which is
 * the week somebody looks at it.
 *
 * THE ARITHMETIC IS ON THE WIRE. Every bucket carries the sentence that
 * produced it — which table, which column, which window — because a figure
 * like this is quoted, and a quoted figure whose derivation lives only in this
 * file is a figure nobody can check.
 *
 * FOUR RULES DECIDE EVERY BUCKET:
 *
 *   PER CURRENCY, AND NO BLENDED TOTAL. There is no exchange rate on this box
 *   and there will not be one. Two currencies is two answers.
 *
 *   ATTEMPTS ARE NOT SETTLEMENT. Failed payments come from stripe_charge_days,
 *   which is attempts; refunds and disputes come from stripe_ledger_days, which
 *   is money that moved. They are dated differently — one by the charge, one by
 *   the ledger posting — and no total spans them.
 *
 *   DECLINED AND BLOCKED ARE NEVER ADDED. A Radar block is card testing stopped
 *   before a bank saw it, which is the system working; a decline is a real
 *   customer's bank saying no, which is the only one worth chasing. Adding them
 *   turns "half our payments fail" into an alarm about an attack.
 *
 *   A WINDOW FIGURE AND A PER-MONTH FIGURE ARE NEVER SUMMED. Refunds over 30
 *   days are money that left in those 30 days. Past-due MRR and the coupon
 *   discount are RATES — dollars per month, for as long as they last. The
 *   document reports two totals per currency and refuses to make one.
 *
 * AND ONE FIGURE IS REFUSED OUTRIGHT: see `wrongFigures` at the bottom.
 */
import { Hono } from "hono";
import {
  stripeChargeDays,
  stripeLedgerDays,
  stripeSubscriptions,
} from "../../db.ts";
import { NEEDS_RESPONSE_STATUSES, OPEN_DISPUTE_STATUSES } from "../../providers/stripe.ts";
import { disputes as disputeCases, disputeCount } from "../customers/store.ts";

export const leakageRoutes = new Hono();

const money = (n: number) => Math.round(n * 100) / 100;

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value));
}

type Bucket = {
  id: string;
  label: string;
  /**
   * How many THINGS the amount beside it is made of — and NULL where the
   * source that produced the amount cannot count them.
   *
   * That null is the disputes bucket's doing and it is the honest shape. Its
   * amount comes from the ledger, which records debits and has no notion of a
   * case; the case COUNT exists now, in `disputeCases` below, but it is a
   * different population dated a different way, and putting it here beside a
   * ledger figure would invite exactly one arithmetic — amount ÷ count, "the
   * mean chargeback" — that is wrong in both directions at once.
   */
  count: number | null;
  /** Money, in this currency. NULL where the source records a COUNT and no
   *  amount — which is a different thing from nothing being at stake, and a
   *  zero here would read as "cost us nothing". */
  amount: number | null;
  /** "30d" or "now" (current state) or "per month" (a rate). */
  window: string;
  /** Which table and which columns. The reader's check on the figure. */
  arithmetic: string;
  /** Why it is money on the floor, in one sentence. */
  why: string;
  /** True when the amount is only the part that can be seen. */
  floor: boolean;
};

leakageRoutes.get("/", (c) => {
  const days = clamp(Number(c.req.query("days") ?? 30) || 30, 1, 400);
  const fromDay = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

  const fromIso = `${fromDay}T00:00:00.000Z`;

  const charges = stripeChargeDays(fromDay);
  const ledger = stripeLedgerDays(fromDay);
  const subs = stripeSubscriptions();
  /* The dispute CASES. Read whole rather than windowed, because "open now" is
     current state — a chargeback opened in June and still under review is open
     today, and a window would hide the one that still needs answering. */
  const allCases = disputeCases({ limit: 2000 });

  const currencies = [
    ...new Set([
      ...charges.map((r) => r.currency),
      ...ledger.map((r) => r.currency),
      ...subs.filter((s) => s.status === "past_due" || s.status === "active").map((s) => s.currency),
    ]),
  ].sort();

  const perCurrency = currencies.map((currency) => {
    const ch = charges.filter((r) => r.currency === currency);
    const le = ledger.filter((r) => r.currency === currency);
    const pastDue = subs.filter((s) => s.currency === currency && s.status === "past_due");
    const active = subs.filter((s) => s.currency === currency && s.status === "active");
    const abandoned = subs.filter((s) => s.currency === currency && s.status === "incomplete_expired");

    const declined = ch.reduce((n, r) => n + r.declined, 0);
    const blocked = ch.reduce((n, r) => n + r.blocked, 0);
    const failed = ch.reduce((n, r) => n + r.failed, 0);
    const refunds = money(le.reduce((n, r) => n + r.refunds, 0));
    const refundCount = ch.reduce((n, r) => n + r.refunds, 0);
    const disputes = money(le.reduce((n, r) => n + r.disputes, 0));
    const disputeFees = money(le.reduce((n, r) => n + r.dispute_fees, 0));

    /* THE CASES, WHICH THIS DOCUMENT USED TO SAY IT DID NOT HAVE.
       The comment on the `disputes` bucket below read "the COUNT is 0 because
       there is no dispute-level table on this box". There is one now —
       stripe_disputes, walked by the customers area — so the count is real.
       The ledger figure stays exactly where it was, because the two measure
       different things and replacing one with the other would silently change
       what every reader of this bucket has been quoting. */
    const cs = allCases.filter((d) => d.currency === currency);
    const csWindow = cs.filter((d) => d.created_at >= fromIso);
    const csOpen = cs.filter((d) => d.outcome === null && OPEN_DISPUTE_STATUSES.has(d.status));
    const csLost = csWindow.filter((d) => d.outcome === "lost");
    const csWon = csWindow.filter((d) => d.outcome === "won");
    const needsResponse = csOpen.filter((d) => NEEDS_RESPONSE_STATUSES.has(d.status));
    const pastDueMonthly = money(pastDue.reduce((n, s) => n + s.monthly_usd, 0));
    const discountedAway = money(
      active.reduce((n, s) => n + (s.listed_monthly_usd - s.monthly_usd), 0),
    );

    const buckets: Bucket[] = [
      {
        id: "declined",
        label: "Cards declined",
        count: declined,
        /* NO AMOUNT, AND THAT IS THE TABLE'S DOING. stripe_charge_days records
           attempts as COUNTS; the money on a failed charge never posted to the
           balance and so is not in any column here. A zero would be a claim
           that nothing was at stake. */
        amount: null,
        window: `${days}d`,
        arithmetic:
          `SUM(declined) over stripe_charge_days for the last ${days} days, in ${currency.toUpperCase()}. ` +
          `Blocked attempts (${blocked}) are counted separately and are NOT in this figure. ` +
          `Stripe's own total for failed attempts is ${failed} = declined + blocked.`,
        why: "A real customer's bank said no. A retry or a dunning email gets most of it back.",
        floor: false,
      },
      {
        id: "refunds",
        label: "Refunded",
        count: refundCount,
        amount: refunds,
        window: `${days}d`,
        arithmetic:
          `SUM(refunds) over stripe_ledger_days for the last ${days} days — SETTLEMENT, dated by the ledger posting. ` +
          `The count is SUM(refunds) over stripe_charge_days, which is dated by the CHARGE; the two do not line up ` +
          `day for day and are not divided into each other.`,
        why: "Money already collected and given back. Sometimes a product problem wearing a billing costume.",
        floor: false,
      },
      {
        id: "disputes",
        /* THE MONEY IS STILL THE LEDGER'S AND THE COUNT IS STILL NULL, and
           the second half of that is deliberate now rather than a gap. The
           old comment here said the count was 0 "because there is no
           dispute-level table on this box". There is one — stripe_disputes,
           walked by the customers area — but its cases are a DIFFERENT
           population from this amount: dated by when the bank opened them,
           excluding the fee this figure includes, and a case won returns
           money this figure already counted as gone. So the counts live in
           `disputeCases` below, where every one of them is beside an amount
           measured the same way, and this bucket carries none rather than one
           somebody would divide into the ledger's money. */
        label: "Lost to disputes",
        count: null,
        amount: money(disputes + disputeFees),
        window: `${days}d`,
        arithmetic:
          `SUM(disputes) + SUM(dispute_fees) over stripe_ledger_days for the last ${days} days = ` +
          `${disputes} + ${disputeFees} — SETTLEMENT, dated by the balance posting, fee included because it ` +
          `is charged whatever the outcome. NO COUNT: the cases are a different population, dated by when ` +
          `the bank opened them and excluding the fee, and they are counted in \`disputeCases\` instead. ` +
          `Dividing this amount by any figure there is a mean chargeback that is wrong twice over.`,
        why: "Gone with the fee on top, and each one counts against the Stripe account.",
        floor: false,
      },
      {
        id: "past_due",
        label: "Subscriptions past due",
        count: pastDue.length,
        amount: pastDueMonthly,
        window: "per month",
        arithmetic:
          `SUM(monthly_usd) over stripe_subscriptions WHERE status = 'past_due' — a RATE, dollars per month for as ` +
          `long as they stay past due, not a sum of money that has already gone. It is current state and has no window.`,
        why: "Billing and failing. Contracted revenue that is not arriving and has not been cancelled either.",
        floor: false,
      },
      {
        id: "coupons",
        label: "Discounted away",
        count: active.filter((s) => s.listed_monthly_usd > s.monthly_usd).length,
        amount: discountedAway,
        window: "per month",
        arithmetic:
          `SUM(listed_monthly_usd - monthly_usd) over ACTIVE stripe_subscriptions — list price not invoiced ` +
          `because of a still-running coupon. Already OUT of MRR: this says how much came off, not how much more ` +
          `is owed. A rate, per month.`,
        why: "A discount somebody granted once and nobody has revisited. Not a debt — a decision worth re-taking.",
        floor: false,
      },
      {
        id: "abandoned",
        label: "Abandoned checkouts",
        count: abandoned.length,
        /* Stripe expires an incomplete subscription without ever invoicing it.
           The plan's list price IS recorded here — see `listedIfBilled` below —
           but it was never billed and is not money the business is owed, so it
           is not an amount and adds to nothing. */
        amount: null,
        window: "lifetime",
        arithmetic:
          `COUNT over stripe_subscriptions WHERE status = 'incomplete_expired' — every subscription that reached ` +
          `the card form and expired. LIFETIME, because that table is not windowed. No amount: nothing was ever ` +
          `invoiced, so there is no money on the floor here, only intent.`,
        why: "Someone reached the card form and left. What that would have been worth is a guess, not a figure.",
        floor: false,
      },
    ];

    const windowMoney = buckets
      .filter((b) => b.window === `${days}d` && b.amount !== null)
      .reduce((n, b) => n + (b.amount ?? 0), 0);
    const perMonth = buckets
      .filter((b) => b.window === "per month" && b.amount !== null)
      .reduce((n, b) => n + (b.amount ?? 0), 0);

    return {
      currency,
      buckets,
      totals: {
        /** Money that actually left, in this window. Settlement only. */
        window: money(windowMoney),
        windowLabel: `${days}d`,
        windowIs: "refunds + disputes + dispute fees, all from the ledger — money that moved",
        /** Dollars per month, for as long as the condition lasts. */
        perMonth: money(perMonth),
        perMonthIs: "past-due MRR + the recurring coupon discount — rates, not sums",
        /** THERE IS NO SINGLE NUMBER, and this is why. */
        combined: null,
        note:
          "A window figure and a per-month rate are different units and are never added. " +
          "Two buckets carry no amount at all (declines, abandoned checkouts) and add to neither.",
      },
      /**
       * THE SAME SUBJECT, MEASURED THE OTHER WAY, and kept beside the ledger
       * figure rather than instead of it.
       *
       * A case is dated by when the cardholder's bank OPENED it and carries
       * the disputed amount with no fee. A ledger debit is dated by the
       * balance POSTING and includes the fee, which Stripe charges whatever
       * the outcome. So a case opened on the 28th and debited on the 2nd is
       * in one window and not the other, and a case WON returns money the
       * ledger already took. The two disagree, on purpose, and the full
       * breakdown with the difference is at /api/disputes.
       */
      disputeCases: {
        openNow: csOpen.length,
        openNowAmount: money(csOpen.reduce((n, d) => n + d.amount, 0)),
        needsResponseNow: needsResponse.length,
        /** The soonest evidence cut-off among cases still needing a response.
         *  Null where none is open or Stripe published no date. */
        nextEvidenceDueBy:
          needsResponse
            .filter((d) => d.evidence_due_by)
            .map((d) => d.evidence_due_by!)
            .sort()[0] ?? null,
        openedInWindow: csWindow.length,
        lostInWindow: csLost.length,
        lostAmountInWindow: money(csLost.reduce((n, d) => n + d.amount, 0)),
        wonInWindow: csWon.length,
        wonAmountInWindow: money(csWon.reduce((n, d) => n + d.amount, 0)),
        basis:
          "CASE-BASED, from stripe_disputes. The disputed amount only — Stripe's dispute fee " +
          "is not in any figure here and IS in the ledger money above. openNow has no window.",
      },
      counts: {
        declined,
        /** Never added to `declined`. Radar stopping card testing is not a
         *  business problem and does not belong in the same denominator. */
        blocked,
        failedTotal: failed,
        refunds: refundCount,
        pastDue: pastDue.length,
        abandoned: abandoned.length,
        /** What those abandoned checkouts would have been worth per month at
         *  list price, IF every one of them had subscribed. A hypothetical,
         *  named as one, excluded from every total on this document. */
        listedIfBilled: money(abandoned.reduce((n, s) => n + s.listed_monthly_usd, 0)),
      },
      /** Buckets whose amount is null. The totals above are a FLOOR while this
       *  is non-empty. */
      noAmount: buckets.filter((b) => b.amount === null).map((b) => b.id),
    };
  });

  const oldestCharge = charges.map((r) => r.day).sort().at(0) ?? null;

  return c.json({
    window: { days, from: fromDay },
    currencies: perCurrency,
    /* NO PORTFOLIO TOTAL. Same rule as every money route here: this box fetches
       no exchange rate, so two currencies is two answers. */
    combined: null,
    coverage: {
      currencies: currencies.length,
      chargeDaysFrom: oldestCharge,
      subscriptions: subs.length,
      /** How many dispute cases this box holds. 0 is either an account with no
       *  disputes or a Stripe key that cannot read them — the Customers
       *  integration's last run says which. It is not a zero. */
      disputeCases: disputeCount(),
      note:
        currencies.length === 0
          ? "No Stripe account is connected, or none has been collected yet. Nothing here is zero — it is unread."
          : "Computed from the Stripe tables on every read. Nothing on this document is stored.",
    },
    /**
     * THE FIGURES THIS ROUTE REFUSES TO PRODUCE, said out loud rather than left
     * as an absence somebody fills in with a division of their own.
     */
    wrongFigures: [
      {
        figure: "A dispute RATE",
        why:
          "Stripe measures disputes against SUCCESSFUL TRANSACTIONS, lifetime. This box holds a charge-day " +
          "table that starts wherever the backfill got to and a subscription book, and neither is a lifetime " +
          "count of successful charges. Dividing disputes by customers, or by the charges inside a 30-day " +
          "window, produces a number of roughly the right order and entirely the wrong denominator — and it " +
          "is the number a risk reviewer would be quoted. So it is not computed here at all. The absolute " +
          "figures are published two ways instead: the ledger's dispute money above, and the CASE counts in " +
          "`disputeCases`. There is now a dispute-level table (stripe_disputes, walked by the customers " +
          "area); what there is still no honest denominator for is a rate.",
      },
      {
        figure: "A payment failure rate",
        why:
          "failed = declined + blocked, and blocked is Radar stopping card testing before a bank saw it. " +
          "On an account under a card-testing attack that ratio is a fact about the attack, not about the " +
          "business. `declined` and `blocked` are published apart and never share a denominator.",
      },
      {
        figure: "One number for money on the floor",
        why:
          "The buckets are in three different units — money that left in a window, dollars per month, and " +
          "counts with no amount at all. `totals.window` and `totals.perMonth` are each real; `totals.combined` " +
          "is null and stays null.",
      },
      {
        figure: "The value of an abandoned checkout",
        why:
          "Stripe expires an incomplete subscription without ever invoicing it. `listedIfBilled` is what they " +
          "would have been worth at list price if every one of them had paid, which is not a thing that was " +
          "lost — it is a thing that never was. It is on the document as a hypothetical and in no total.",
      },
    ],
  });
});
