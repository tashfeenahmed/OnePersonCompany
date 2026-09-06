/**
 * THE FOLLOW-UP, ASSEMBLED FROM THE CASE AND NOTHING ELSE.
 *
 * WHY THIS IS A TEMPLATE AND NOT A MODEL CALL. Every other place on this box
 * where a model writes prose, it is writing ABOUT data to the owner — a
 * briefing, a run report, a narration — and the worst a hallucination can do
 * is embarrass this dashboard in front of the person who owns it. This one is
 * addressed to a customer. A sentence invented here becomes a promise the
 * business has to keep: "we'll refund you", "your card won't be charged
 * again", "here is a link to fix it". So the composer is a function over the
 * case's own fields, and the fields it may use are enumerated below.
 *
 * WHAT IT MAY SAY, exhaustively: the plan or product name Stripe recorded,
 * the amount and currency on the case, the dates on the case, the attempt
 * count on a failing invoice, and Stripe's own word for a cancellation
 * reason. Nothing else. In particular there is NO LINK: a billing-portal URL
 * is not on any document this box holds, and a link somebody has to invent is
 * the fastest way to send a customer to a 404 with the business's name on it.
 *
 * WHAT IT MUST NEVER SAY, and the skill carries the same rule so an agent
 * asked to "improve the wording" knows the boundary: that the customer WILL
 * be charged, WILL be refunded, WILL be given a discount, or that anything
 * has been done to their account. This box cannot write to Stripe. Every one
 * of those sentences would be a claim about an action that never happened.
 *
 * DATES ARE ABSOLUTE. "on 16 October" rather than "in 12 days", because the
 * draft sits in the outbox until the owner approves it and "in 12 days" is
 * wrong by the time it leaves. Written in en-GB long form because that is a
 * date a person reads rather than parses, and in UTC with the day named, so
 * a reader in another zone is never off by one without being told.
 */
import type { CaseRecord } from "./store.ts";

export type Composed = {
  subject: string;
  body: string;
  /** Every fact the body used, so the case can record what the owner is being
   *  asked to stand behind. */
  usedFacts: Record<string, unknown>;
};

/** "16 October 2026 (UTC)". Null in, null out — a missing date never becomes
 *  a phrase. */
export function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  })} (UTC)`;
}

type Ctx = Record<string, unknown>;
const s = (c: Ctx, k: string) => (typeof c[k] === "string" ? (c[k] as string) : null);
const n = (c: Ctx, k: string) => (typeof c[k] === "number" ? (c[k] as number) : null);

const cash = (amount: number | null, currency: string | null) =>
  amount === null || amount === undefined
    ? null
    : `${(currency ?? "").toUpperCase()} ${amount.toFixed(2)}`.trim();

/**
 * MAY THIS PRICE BE QUOTED TO THE CUSTOMER AT ALL?
 *
 * Only when the subscription bills MONTHLY, once a month. Every amount on a
 * case is `monthly_usd` — a normalisation this dashboard performs so that a
 * book of annual and monthly plans can be described by one figure — and an
 * annual subscriber has never seen it. The account this was built against has
 * a plan whose monthly_usd is 10.21 and whose actual invoice is ten times
 * that: "billing at USD 10.21 per year" would have gone to a real customer,
 * been wrong, and been wrong in the direction that invites a dispute.
 *
 * There is no field on this box that holds what the customer was actually
 * charged per invoice, so the honest move is silence: the letter simply does
 * not mention a price, which is what WorkDash's own yearly template does and
 * for exactly this reason.
 */
function quotablePrice(ctx: Ctx, amount: number | null, currency: string | null): string | null {
  const interval = s(ctx, "interval");
  const count = n(ctx, "intervalCount");
  if (interval !== "month" || (count !== null && count !== 1)) return null;
  return cash(amount, currency);
}

/**
 * The subject and body for one case.
 *
 * Returns `null` for a case whose facts cannot carry a message — a dispute,
 * where the counterparty is a BANK and the thing to do is upload evidence at
 * Stripe rather than email the cardholder. A composer that produced a
 * cheerful follow-up for a chargeback would be worse than none.
 */
export function compose(row: CaseRecord): Composed | null {
  let ctx: Ctx = {};
  try {
    const parsed = JSON.parse(row.context) as unknown;
    if (parsed && typeof parsed === "object") ctx = parsed as Ctx;
  } catch {
    /* A context that will not parse leaves the composer with the columns
       alone, which are still facts. It never leaves it with nothing. */
  }

  const product = s(ctx, "product");
  const plan = s(ctx, "plan");
  /* THE NOUN THE CUSTOMER WOULD RECOGNISE. The product is what they bought;
     the plan is a price nickname and is often internal ("Annual — legacy"),
     so the product wins and the plan is only used when there is no product. */
  const what = product ?? plan;
  const interval = s(ctx, "interval");
  /* NULL unless the plan bills monthly. See quotablePrice. */
  const price = quotablePrice(ctx, row.amount, row.currency);

  const used: Record<string, unknown> = {
    kind: row.kind,
    product,
    plan,
    amount: row.amount,
    currency: row.currency,
    /* Recorded even when it is null, so a reader of usedFacts can see that a
       price was deliberately withheld rather than missing. */
    priceQuoted: quotablePrice(ctx, row.amount, row.currency),
  };

  switch (row.kind) {
    case "churn": {
      const state = s(ctx, "state");
      if (state === "ended") {
        const endedAt = longDate(s(ctx, "endedAt"));
        used.endedAt = s(ctx, "endedAt");
        return {
          subject: what ? `Your ${what} subscription` : "Your subscription",
          body: [
            "Hello,",
            "",
            `Your ${what ?? "subscription"} ended${endedAt ? ` on ${endedAt}` : ""}, and I wanted to write once rather than not at all.`,
            "",
            "If it stopped because something was missing or got in the way, I would like to know — I read these myself.",
            "",
            "If you would like it back, reply here and I will help you set it up again. If you are done with it, that is genuinely fine and you do not need to answer.",
          ].join("\n"),
          usedFacts: used,
        };
      }
      const cancelAt = longDate(s(ctx, "cancelAt") ?? row.deadline);
      used.cancelAt = s(ctx, "cancelAt") ?? row.deadline;
      used.interval = interval;
      return {
        subject: what ? `Before your ${what} subscription ends` : "Before your subscription ends",
        body: [
          "Hello,",
          "",
          `I saw your ${what ?? "subscription"} is set to end${cancelAt ? ` on ${cancelAt}` : ""}, and I wanted to write before it does rather than after.`,
          "",
          /* THE PRICE IS QUOTED ONLY AS WHAT IT HAS BEEN, never as what it
             will be. This box cannot change a price and must not imply that
             the current one is being held. */
          price
            ? `It has been billing at ${price} a month. If that is a card that stopped working rather than a decision, reply here and I will point you at the right place to fix it.`
            : "If that is a card that stopped working rather than a decision, reply here and I will point you at the right place to fix it.",
          "",
          "If you are done with it, that is genuinely fine — say so and I will leave it to close cleanly. Either way, if something was missing or got in the way, I would like to know.",
        ].join("\n"),
        usedFacts: used,
      };
    }

    case "payment_failed": {
      /*
        THE ONE CASE WHOSE AMOUNT MAY ALWAYS BE QUOTED.

        `quotablePrice` exists because a subscription case's `amount` is
        `monthly_usd` — a normalisation this dashboard performs that the
        customer has never seen — and it decides by reading `interval` out of
        the context. An invoice context has no `interval`, so running it here
        returned null every time and the one letter whose figure is REAL never
        printed it. `amount` on a payment case is `amountRemaining` off the
        invoice: the actual sum Stripe tried to take, in the currency Stripe
        billed it in. That is what the customer's statement will say.
      */
      const invoiceAmount = cash(row.amount, row.currency);
      const attempts = n(ctx, "attemptCount");
      const next = longDate(s(ctx, "nextPaymentAttempt") ?? row.deadline);
      const number = s(ctx, "invoiceNumber");
      used.attemptCount = attempts;
      used.nextPaymentAttempt = s(ctx, "nextPaymentAttempt") ?? row.deadline;
      used.invoiceNumber = number;
      /* Overrides the subscription rule's null: this figure is an invoice
         total, not a normalisation, so it is quoted and recorded as quoted. */
      used.priceQuoted = invoiceAmount;
      return {
        subject: `A payment did not go through${number ? ` (invoice ${number})` : ""}`,
        body: [
          "Hello,",
          "",
          `A payment on your account did not go through${invoiceAmount ? ` — ${invoiceAmount}` : ""}${
            attempts !== null ? `, after ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""
          }.`,
          "",
          /* The retry is quoted because Stripe scheduled it and this row read
             the date off the invoice. Where there is none, the sentence says
             that nothing will retry — which is the fact, and the reason to
             reply. */
          next
            ? `Stripe will try the card again on ${next}. If the card has changed, replying here is the quickest way to get it sorted before then.`
            : "There is no further automatic attempt scheduled, so it will not retry on its own. Reply here and I will help you get it settled.",
          "",
          "If you meant to stop, tell me and I will close it out — no chasing.",
        ].join("\n"),
        usedFacts: used,
      };
    }

    case "trial_ending": {
      const trialEnd = longDate(s(ctx, "trialEnd") ?? row.deadline);
      const willBill = quotablePrice(ctx, n(ctx, "willBillMonthly"), row.currency);
      used.trialEnd = s(ctx, "trialEnd") ?? row.deadline;
      used.willBillMonthly = n(ctx, "willBillMonthly");
      return {
        subject: what ? `Your ${what} trial` : "Your trial",
        body: [
          "Hello,",
          "",
          `Your trial${what ? ` of ${what}` : ""} ends${trialEnd ? ` on ${trialEnd}` : " shortly"}.`,
          "",
          willBill
            ? `After that the plan is ${willBill} a month. If you would like to carry on, there is nothing to do.`
            : "If you would like to carry on, there is nothing to do.",
          "",
          "If it has not been useful, reply and tell me what was missing — that is more useful to me than a quiet cancellation.",
        ].join("\n"),
        usedFacts: used,
      };
    }

    /* NO DRAFT FOR A DISPUTE. The other party is a card issuer, the remedy is
       evidence uploaded at Stripe before the cut-off, and an email to the
       cardholder is at best irrelevant and at worst read as pressure. The
       route says this in words rather than producing an empty draft. */
    case "dispute":
      return null;

    default:
      return null;
  }
}

/** Why a case cannot be drafted, in the words the route returns. Kept beside
 *  the composer so the two can never disagree about which kinds it handles. */
export function whyNoDraft(row: CaseRecord): string {
  if (row.kind === "dispute")
    return (
      "A dispute is answered with evidence at Stripe before the bank's cut-off, not with " +
      "an email to the cardholder. This queue will not write one."
    );
  return `There is no follow-up template for a “${row.kind}” case.`;
}
