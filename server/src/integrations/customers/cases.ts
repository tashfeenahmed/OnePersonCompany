/**
 * THE RECOVERY QUEUE'S ARITHMETIC — what opens a case, and what closes one.
 *
 * Both halves are PURE FUNCTIONS over rows, which is the point of the file:
 * "a case resolves when Stripe shows the subscription active again" is a
 * sentence that has to be true, and the only way to know it is true is to be
 * able to run it against a fixture with no Stripe account and no clock.
 *
 * FOUR KINDS, AND EACH HAS EXACTLY ONE DEADLINE THAT MEANS SOMETHING.
 *
 *   churn          — a cancellation SCHEDULED at the end of a period. The
 *                    deadline is Stripe's cancel_at, and until it passes the
 *                    subscription is still billing and still in MRR.
 *   payment_failed — an invoice that is open with at least one attempt behind
 *                    it. The deadline is next_payment_attempt: the moment
 *                    Stripe will try the card again, after which dunning is
 *                    one step further along. A null one means Stripe has
 *                    scheduled no further attempt, which is dunning FINISHED
 *                    rather than a payment about to succeed.
 *   dispute        — the bank's evidence cut-off. The only hard deadline in
 *                    this file: miss it and the case is lost by default.
 *   trial_ending   — trial_end, which is when a trial either becomes revenue
 *                    or becomes nothing.
 *
 * A CASE WITH NO DEADLINE IS A REAL STATE. A subscription that has already
 * ended is worth writing to and has nothing to be early for; it sorts under
 * the dated cases rather than above them, and the queue says why.
 *
 * WHAT IS DELIBERATELY NOT A CASE. `incomplete_expired` subscriptions — a
 * checkout that expired before its first payment ever succeeded. They are the
 * majority of most accounts' dead rows, they never collected a cent, and
 * WorkDash's churn figure counted them until $415 of a reported $430 monthly
 * churn turned out to be cancelled free trials. Nobody was ever a customer,
 * so there is nobody to recover.
 */
import type { StripeSubscriptionRecord } from "../../db.ts";
import type { OpenInvoiceRow } from "../../providers/stripe.ts";
import { OPEN_DISPUTE_STATUSES, money } from "../../providers/stripe.ts";
import { currencyCode } from "../../shared/money.ts";
import type { CaseKind, CaseRecord, CaseWrite, DisputeRecord } from "./store.ts";
import { caseId } from "./store.ts";
import { soleVenture, ventureOfProduct, ventureOfSubscription, type VentureMap } from "./venture.ts";

/** How long a subscription that has already ENDED stays in the queue. After
 *  this the pass closes it: there is no deadline left to beat and a list that
 *  only grows is a list nobody opens. */
export const ENDED_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

export type DeriveInput = {
  accountId: number;
  accountLabel: string;
  subscriptions: StripeSubscriptionRecord[];
  openInvoices: OpenInvoiceRow[];
  disputes: DisputeRecord[];
  ventures: VentureMap;
  nowMs: number;
  /** How far ahead a scheduled cancellation is worth chasing. */
  horizonDays: number;
  /** How close a trial has to be to its end. */
  trialDays: number;
};

export type DeriveResult = {
  cases: CaseWrite[];
  /** Every case id this derivation still considers live. Anything open in the
   *  table and NOT in here is a candidate for automatic resolution. */
  live: Set<string>;
};

/**
 * What the queue should contain, given what Stripe currently says.
 *
 * The pass upserts every case here and then asks `resolutionFor` about every
 * open case that this did NOT produce. That two-step is why the queue can be
 * rebuilt from scratch on any collection without losing a decision: this
 * function knows nothing about status, and the resolution step knows nothing
 * about Stripe.
 */
export function deriveCases(input: DeriveInput): DeriveResult {
  const { accountId, accountLabel, ventures, nowMs } = input;
  const out: CaseWrite[] = [];
  const live = new Set<string>();
  const horizon = nowMs + input.horizonDays * DAY_MS;
  const endedFrom = nowMs - ENDED_WINDOW_DAYS * DAY_MS;

  const add = (w: CaseWrite) => {
    out.push(w);
    live.add(w.id);
  };

  const ventureOfSub = (s: StripeSubscriptionRecord) =>
    ventureOfSubscription(ventures, s.id) ?? ventureOfProduct(ventures, s.product);

  for (const s of input.subscriptions) {
    if (s.account_id !== accountId) continue;

    /* ---- a cancellation somebody scheduled and nobody has answered ------- */
    const pending =
      s.cancel_at_period_end === 1 && (s.status === "active" || s.status === "trialing");
    const cancelAt = s.cancel_at ? Date.parse(s.cancel_at) : Number.NaN;
    if (pending && (Number.isNaN(cancelAt) || cancelAt <= horizon)) {
      add({
        id: caseId("churn", s.id),
        ventureId: ventureOfSub(s),
        accountId,
        accountLabel,
        kind: "churn",
        customer: null,
        subjectRef: s.id,
        amount: s.monthly_usd,
        currency: s.currency,
        deadline: s.cancel_at,
        deadlineIs: "the end of the paid period, when Stripe cancels it",
        context: {
          state: "cancellation scheduled",
          plan: s.plan,
          product: s.product,
          monthly: s.monthly_usd,
          listedMonthly: s.listed_monthly_usd,
          currency: s.currency,
          interval: s.bill_interval,
          intervalCount: s.interval_count,
          startedAt: s.created_at,
          cancelAt: s.cancel_at,
          stripeStatus: s.status,
          /* Stripe's own word for why, where the cancellation form collected
             one. Never paraphrased and never guessed at when absent. */
          cancellationReason: s.reason,
          stillBilling: true,
          note:
            "Still billing and still counted in MRR. The subscription ends on the deadline, " +
            "not today.",
        },
      });
    }

    /* ---- a subscription that has already gone, and did pay -------------- */
    const ended = s.ended_at ? Date.parse(s.ended_at) : Number.NaN;
    const everPaid = s.paid_cents === null || s.paid_cents > 0;
    if (
      s.ended_at &&
      !Number.isNaN(ended) &&
      ended >= endedFrom &&
      s.status !== "incomplete_expired" &&
      everPaid
    ) {
      add({
        id: caseId("churn", s.id),
        ventureId: ventureOfSub(s),
        accountId,
        accountLabel,
        kind: "churn",
        customer: null,
        subjectRef: s.id,
        amount: s.monthly_usd,
        currency: s.currency,
        deadline: null,
        deadlineIs: "none — it has already ended",
        context: {
          state: "ended",
          plan: s.plan,
          product: s.product,
          monthly: s.monthly_usd,
          currency: s.currency,
          interval: s.bill_interval,
          startedAt: s.created_at,
          endedAt: s.ended_at,
          stripeStatus: s.status,
          cancellationReason: s.reason,
          /* NULL is "the invoice lookup has not reached this one yet", and
             this queue treats it as paid — the direction that never flatters
             retention. It is published so a reader knows which it is. */
          everCollectedCents: s.paid_cents,
          stillBilling: false,
          note:
            s.paid_cents === null
              ? "Whether this subscription ever collected a payment has not been checked yet."
              : `Collected ${money(s.paid_cents).toFixed(2)} ${currencyCode(s.currency)} over its life.`,
        },
      });
    }

    /* ---- a trial about to decide --------------------------------------- */
    const trialEnd = s.trial_end ? Date.parse(s.trial_end) : Number.NaN;
    if (
      s.status === "trialing" &&
      s.trial_end &&
      !Number.isNaN(trialEnd) &&
      trialEnd >= nowMs &&
      trialEnd <= nowMs + input.trialDays * DAY_MS
    ) {
      add({
        id: caseId("trial_ending", s.id),
        ventureId: ventureOfSub(s),
        accountId,
        accountLabel,
        kind: "trial_ending",
        customer: null,
        subjectRef: s.id,
        /* The price it WILL bill at, which is not revenue yet and is never in
           MRR. Named in the context so nothing quotes it as income. */
        amount: s.monthly_usd,
        currency: s.currency,
        deadline: s.trial_end,
        deadlineIs: "the end of the trial, when Stripe takes the first payment",
        context: {
          state: "trialing",
          plan: s.plan,
          product: s.product,
          willBillMonthly: s.monthly_usd,
          currency: s.currency,
          interval: s.bill_interval,
          trialStart: s.trial_start,
          trialEnd: s.trial_end,
          startedAt: s.created_at,
          note: "A trial has never sent a cent. This figure is what it would bill, not revenue.",
        },
      });
    }
  }

  /* ---- an invoice that is open and has already been tried --------------- */
  for (const inv of input.openInvoices) {
    if (inv.attemptCount < 1) continue;
    add({
      id: caseId("payment_failed", inv.id),
      ventureId: ventureOfSubscription(ventures, inv.subscription) ?? soleVenture(ventures),
      accountId,
      accountLabel,
      kind: "payment_failed",
      customer: inv.customer,
      subjectRef: inv.id,
      amount: inv.amountRemaining,
      currency: inv.currency,
      deadline: inv.nextPaymentAttempt,
      deadlineIs: inv.nextPaymentAttempt
        ? "Stripe's next automatic retry of the card"
        : "none — Stripe has scheduled no further attempt",
      context: {
        state: "invoice open after a failed attempt",
        invoiceNumber: inv.number,
        amountDue: inv.amountDue,
        amountRemaining: inv.amountRemaining,
        currency: inv.currency,
        attemptCount: inv.attemptCount,
        nextPaymentAttempt: inv.nextPaymentAttempt,
        dueDate: inv.dueDate,
        issuedAt: inv.createdAt,
        subscription: inv.subscription,
        note: inv.nextPaymentAttempt
          ? "Stripe will try the card again on the deadline."
          : "Stripe has scheduled no further attempt. Dunning is over; nothing will retry on its own.",
      },
    });
  }

  /* ---- a dispute the bank is still waiting on --------------------------- */
  for (const d of input.disputes) {
    if (d.account_id !== accountId) continue;
    if (d.outcome !== null || !OPEN_DISPUTE_STATUSES.has(d.status)) continue;
    add({
      id: caseId("dispute", d.id),
      ventureId: d.venture_id ?? soleVenture(ventures),
      accountId,
      accountLabel,
      kind: "dispute",
      customer: null,
      subjectRef: d.id,
      amount: d.amount,
      currency: d.currency,
      deadline: d.evidence_due_by,
      deadlineIs: d.evidence_due_by
        ? "the bank's evidence cut-off at Stripe — miss it and the case is lost by default"
        : "none published — Stripe gave no due date for this status",
      context: {
        state: "dispute open",
        stripeStatus: d.status,
        reason: d.reason,
        amount: d.amount,
        currency: d.currency,
        openedAt: d.created_at,
        evidenceDueBy: d.evidence_due_by,
        submissionCount: d.submission_count,
        charge: d.charge,
        note:
          "This is the CASE. The money the ledger shows leaving is a separate measurement, " +
          "dated by the balance posting and including the dispute fee, which this amount does not.",
      },
    });
  }

  return { cases: out, live };
}

/* ------------------------------------------------------- automatic closing */

export type ResolutionFacts = {
  /** The subscription this case is about, where it is one. */
  subscription?: StripeSubscriptionRecord | null;
  /** The dispute this case is about, where it is one. */
  dispute?: DisputeRecord | null;
  /** True where the case's invoice is still in Stripe's open list. */
  invoiceStillOpen?: boolean;
  /** True where a `invoice.paid` event for this invoice has been seen. */
  invoicePaid?: boolean;
  nowMs: number;
};

/**
 * Should this open case close by itself, and in what words?
 *
 * Null means leave it alone. The sentence is stored as the case's resolution
 * and is shown to the owner, so it says what was OBSERVED rather than what it
 * implies — "Stripe no longer lists this invoice as open" is the fact; "the
 * customer paid" is a conclusion this box can only draw when it has actually
 * seen the `invoice.paid` event.
 *
 * A DISMISSED CASE NEVER REACHES HERE. The caller only asks about cases in
 * open, drafted or sent, because a dismissal is the owner's decision and a
 * pass that overturned it would be a pass that argues.
 */
export function resolutionFor(row: CaseRecord, f: ResolutionFacts): string | null {
  switch (row.kind as CaseKind) {
    case "churn": {
      const s = f.subscription;
      if (!s) return null;
      if (s.status === "active" && s.cancel_at_period_end === 0)
        return "Stripe shows the subscription active again with no cancellation scheduled.";
      /* An ended subscription past the window: nothing here has a deadline
         left, and the queue is for things with one. */
      const ended = s.ended_at ? Date.parse(s.ended_at) : Number.NaN;
      if (!Number.isNaN(ended) && ended < f.nowMs - ENDED_WINDOW_DAYS * DAY_MS)
        return `The subscription ended more than ${ENDED_WINDOW_DAYS} days ago. Nothing here is on a deadline any more; it was not recovered.`;
      return null;
    }

    case "trial_ending": {
      const s = f.subscription;
      if (!s) return null;
      if (s.status === "active")
        return "The trial converted — Stripe shows the subscription active and billing.";
      if (s.status === "canceled" || s.status === "incomplete_expired" || s.ended_at)
        return "The trial ended without converting. Stripe shows the subscription closed.";
      const trialEnd = s.trial_end ? Date.parse(s.trial_end) : Number.NaN;
      if (!Number.isNaN(trialEnd) && trialEnd < f.nowMs && s.status !== "trialing")
        return `The trial is over; Stripe now shows the subscription as ${s.status}.`;
      return null;
    }

    case "payment_failed": {
      if (f.invoiceStillOpen) return null;
      if (f.invoicePaid)
        return "The invoice was paid — Stripe sent an invoice.paid event for it.";
      return (
        "Stripe no longer lists this invoice as open. It was collected, voided or written " +
        "off; which of those is not recorded on this box, and no invoice.paid event was seen."
      );
    }

    case "dispute": {
      const d = f.dispute;
      if (!d) return null;
      if (d.outcome === "won")
        return "Stripe closed the dispute in the account's favour — recorded as won.";
      if (d.outcome === "lost")
        return `Stripe closed the dispute as lost. The ${d.amount} ${d.currency.toUpperCase()} is gone, and the dispute fee with it.`;
      if (!OPEN_DISPUTE_STATUSES.has(d.status))
        return `The dispute is no longer open — Stripe's status is now “${d.status}”, which is neither won nor lost.`;
      return null;
    }

    default:
      return null;
  }
}
