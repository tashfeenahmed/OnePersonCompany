/**
 * BUSINESS EVENTS — reading one Stripe event into one English sentence, and
 * deciding whether it is worth a message.
 *
 * EVERY FUNCTION IN THIS FILE IS PURE except the two at the bottom that read
 * the alerts table. That is deliberate and it is what the tests exercise:
 * dedupe, collapsing and quiet hours are the three places a notifier goes
 * wrong, and all three of them are decidable from data with no clock, no
 * network and no database.
 *
 * NO MODEL WRITES A SUMMARY. Each sentence below is assembled from fields
 * that were in the payload — a plan name, an amount, an attempt count — and
 * the one thing it never does is characterise. "Payment failed on attempt 3"
 * is a fact; "a customer is churning" is a story, and a story on a phone at
 * seven in the morning is how somebody emails the wrong person.
 *
 * THE RECONCILIATION WITH AGGREGATE ALERTS IS CLASS-LEVEL AND SAYS SO. An
 * alert rule watching `stripe` or `leakage` that tripped in the same window
 * as a revenue event is reporting the same money story from the other end —
 * "past-due MRR crossed $400" and "invoice payment failed" on the same
 * morning are one thing happening. The event is kept, marked with which alert
 * covered it, and not delivered. It is not a claim that the two documents
 * contain the same figure; it is a claim that the owner has already been
 * woken about it once.
 */
import { money as stripeMoney } from "../../providers/stripe.ts";
import { events as alertEvents, rules as alertRules } from "../proactive/store.ts";
import { inQuiet, zoned } from "./store.ts";

/* --------------------------------------------------------------- summaries */

export type ParsedEvent = {
  summary: string;
  objectId: string | null;
  objectType: string | null;
  customer: string | null;
  amount: number | null;
  currency: string | null;
  /** The subscription this event is about, where the payload names one. The
   *  only handle venture attribution has. */
  subscription: string | null;
  /** True where the event is a payment FAILURE — the one class that collapses.
   *  Stripe emits one per retry attempt, so a declining card can ping four
   *  times in an afternoon. */
  isPaymentFailure: boolean;
  /** True where the event is not worth a message at all whatever the settings
   *  say: a subscription update that changed nothing a person would act on. */
  uninteresting: boolean;
};

type Obj = Record<string, unknown>;

const str = (o: Obj, k: string): string | null => {
  const v = o[k];
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && typeof (v as Obj).id === "string")
    return ((v as Obj).id as string).trim() || null;
  return null;
};
const num = (o: Obj, k: string): number | null =>
  typeof o[k] === "number" ? (o[k] as number) : null;

/** Cents to major units — literally the collector's own conversion now, not a
 *  second one under a comment claiming it was the same. It was not: this
 *  rounded at two places and the collector at six, so for one failed invoice
 *  the amount on a phone and the amount on the recovery case could differ. */
const money = (cents: number | null) => (cents === null ? null : stripeMoney(cents));

const cash = (amount: number | null, currency: string | null) =>
  amount === null ? null : `${currency ? currency.toUpperCase() : ""} ${amount.toFixed(2)}`.trim();

/** The subscription id on an invoice, at both places Stripe has kept it. */
function invoiceSubscription(o: Obj): string | null {
  const direct = str(o, "subscription");
  if (direct) return direct;
  const parent = o.parent as Obj | undefined;
  const details = parent?.subscription_details as Obj | undefined;
  return details ? str(details, "subscription") : null;
}

/** The plan a subscription object bills on, from its first line — which is
 *  the one that decides how the whole thing bills. A mixed-interval
 *  subscription does not exist at Stripe. */
function planName(o: Obj): string | null {
  const items = (o.items as Obj | undefined)?.data;
  if (!Array.isArray(items) || !items.length) return null;
  const price = (items[0] as Obj).price as Obj | undefined;
  if (!price) return null;
  const nickname = typeof price.nickname === "string" ? price.nickname.trim() : "";
  if (nickname) return nickname;
  const product = price.product;
  if (product && typeof product === "object" && typeof (product as Obj).name === "string")
    return ((product as Obj).name as string).trim() || null;
  return null;
}

/**
 * One event, read.
 *
 * `customer.subscription.updated` IS FILTERED HERE and it is the only type
 * with logic, for WorkDash's reason: Stripe emits an update for every trivial
 * change — a card fingerprint, a metadata key — and a notifier that announced
 * all of them would be a notifier the owner mutes in a week. Only two updates
 * are worth a message: a cancellation being SCHEDULED, and the status
 * arriving at something terminal. `previous_attributes` is what makes that
 * decidable: it names the fields that actually moved.
 */
export function parseEvent(
  type: string,
  object: Obj,
  previous: Obj | null,
): ParsedEvent {
  const base = {
    objectId: str(object, "id"),
    customer: str(object, "customer"),
    amount: null as number | null,
    currency: str(object, "currency"),
    subscription: null as string | null,
    isPaymentFailure: false,
    uninteresting: false,
  };

  switch (type) {
    case "customer.subscription.created": {
      const plan = planName(object);
      return {
        ...base,
        objectType: "subscription",
        subscription: base.objectId,
        summary: `New subscription${plan ? ` on ${plan}` : ""}${
          str(object, "status") ? ` (${str(object, "status")})` : ""
        }.`,
      };
    }

    case "customer.subscription.deleted": {
      const plan = planName(object);
      const reason =
        ((object.cancellation_details as Obj | undefined)?.reason as string | undefined) ?? null;
      return {
        ...base,
        objectType: "subscription",
        subscription: base.objectId,
        summary:
          `Subscription ended${plan ? ` on ${plan}` : ""}` +
          `${reason ? `, reason recorded by Stripe as “${reason}”` : ""}.`,
      };
    }

    case "customer.subscription.updated": {
      const plan = planName(object);
      const status = str(object, "status") ?? "unknown";
      const scheduled =
        previous !== null &&
        Object.hasOwn(previous, "cancel_at_period_end") &&
        object.cancel_at_period_end === true;
      const terminal =
        previous !== null &&
        Object.hasOwn(previous, "status") &&
        ["canceled", "unpaid", "incomplete_expired", "past_due"].includes(status);
      if (!scheduled && !terminal)
        return {
          ...base,
          objectType: "subscription",
          subscription: base.objectId,
          uninteresting: true,
          summary: `Subscription updated (${status}) — no field a person acts on changed.`,
        };
      return {
        ...base,
        objectType: "subscription",
        subscription: base.objectId,
        summary: scheduled
          ? `Cancellation scheduled${plan ? ` on ${plan}` : ""} — it keeps billing until the period ends.`
          : `Subscription is now ${status}${plan ? ` on ${plan}` : ""}.`,
      };
    }

    case "invoice.payment_failed": {
      const amount = money(num(object, "amount_due"));
      const attempt = num(object, "attempt_count");
      const currency = str(object, "currency");
      return {
        ...base,
        objectType: "invoice",
        amount,
        currency,
        subscription: invoiceSubscription(object),
        isPaymentFailure: true,
        summary:
          `Invoice payment failed${cash(amount, currency) ? ` for ${cash(amount, currency)}` : ""}` +
          `${attempt !== null ? ` on attempt ${attempt}` : ""}.`,
      };
    }

    case "invoice.paid": {
      const amount = money(num(object, "amount_paid"));
      const currency = str(object, "currency");
      return {
        ...base,
        objectType: "invoice",
        amount,
        currency,
        subscription: invoiceSubscription(object),
        summary: `Invoice paid${cash(amount, currency) ? ` — ${cash(amount, currency)}` : ""}.`,
      };
    }

    case "charge.dispute.created": {
      const amount = money(num(object, "amount"));
      const currency = str(object, "currency");
      const reason = str(object, "reason");
      const due = (object.evidence_details as Obj | undefined)?.due_by;
      return {
        ...base,
        objectType: "dispute",
        amount,
        currency,
        summary:
          `Dispute opened${cash(amount, currency) ? ` for ${cash(amount, currency)}` : ""}` +
          `${reason ? `, reason “${reason}”` : ""}` +
          `${typeof due === "number" && due ? `. Evidence due ${new Date(due * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}.`,
      };
    }

    case "charge.dispute.closed": {
      const amount = money(num(object, "amount"));
      const currency = str(object, "currency");
      const status = str(object, "status") ?? "closed";
      return {
        ...base,
        objectType: "dispute",
        amount,
        currency,
        summary: `Dispute closed as ${status}${cash(amount, currency) ? ` — ${cash(amount, currency)}` : ""}.`,
      };
    }

    case "checkout.session.completed": {
      const amount = money(num(object, "amount_total"));
      const currency = str(object, "currency");
      const mode = str(object, "mode");
      return {
        ...base,
        objectType: "checkout_session",
        amount,
        currency,
        subscription: str(object, "subscription"),
        summary:
          `Checkout completed${mode ? ` (${mode})` : ""}` +
          `${cash(amount, currency) ? ` — ${cash(amount, currency)}` : ""}.`,
      };
    }

    default:
      return {
        ...base,
        objectType: null,
        summary: `${type} — this area has no reading for that type, so only the fact is recorded.`,
        uninteresting: true,
      };
  }
}

/* -------------------------------------------------------------- collapsing */

export const COLLAPSE_MINUTES = 60;

export type Collapsible = {
  id: string;
  type: string;
  at: string;
  customer: string | null;
  /** True for a row whose message has ALREADY gone. It seeds the window — a
   *  later failure for the same customer folds into it — and it can never
   *  itself be collapsed, because there is nothing left to suppress. */
  delivered?: boolean;
};

export type CollapseResult = {
  /** id → the id of the event it was folded into. */
  collapsed: Map<string, string>;
  /** id → how many events it now stands for, INCLUDING itself. Only present
   *  for survivors that actually absorbed something. */
  standsFor: Map<string, number>;
};

/**
 * N failed payments for one customer inside an hour become one message.
 *
 * Stripe emits `invoice.payment_failed` once per RETRY, so one card that has
 * expired produces four identical alarms over an afternoon. WorkDash's
 * notifier said so in its README and shipped without a fix; its other
 * notifier batched every failure for six hours instead, which is the opposite
 * error — a failure worth knowing about arrives at dinner time.
 *
 * The rule here is the middle one: the FIRST failure for a customer goes out
 * immediately and opens a sixty-minute window; every later failure for the
 * same customer inside that window is folded into it and the survivor's
 * message says how many it stands for. The window then restarts, so a card
 * still failing tomorrow is still worth a line.
 *
 * A FAILURE WITH NO CUSTOMER ID COLLAPSES WITH NOTHING. Two events that
 * cannot be shown to be the same person are two people until proved
 * otherwise, and folding them would hide a second customer's problem.
 */
export function collapseFailures(
  rows: Collapsible[],
  minutes = COLLAPSE_MINUTES,
  /**
   * Failures whose message has already been sent, inside the same window.
   *
   * WITHOUT THESE THE WINDOW IS PER PASS, NOT PER HOUR, and the promise this
   * function makes in the README and in the `events` skill is not kept: a
   * failure delivered at 09:00 leaves the pending set the moment it is
   * marked, so the retry at 09:40 arrives in an empty set and opens a window
   * of its own. The seed rows carry `delivered: true`, open windows exactly
   * as a survivor would, and are never themselves collapsed.
   */
  seed: Collapsible[] = [],
): CollapseResult {
  const collapsed = new Map<string, string>();
  const standsFor = new Map<string, number>();
  const open = new Map<string, { id: string; until: number }>();

  const ordered = [...seed.map((r) => ({ ...r, delivered: true })), ...rows].sort(
    (a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id),
  );

  for (const r of ordered) {
    if (r.type !== "invoice.payment_failed" || !r.customer) continue;
    const at = Date.parse(r.at);
    if (Number.isNaN(at)) continue;
    const held = open.get(r.customer);
    if (held && at <= held.until) {
      /* A row that has already been delivered cannot be suppressed — its
         message is gone. It does not extend the window either: the window
         belongs to whichever row opened it. */
      if (r.delivered) continue;
      collapsed.set(r.id, held.id);
      standsFor.set(held.id, (standsFor.get(held.id) ?? 1) + 1);
      continue;
    }
    open.set(r.customer, { id: r.id, until: at + minutes * 60_000 });
  }

  return { collapsed, standsFor };
}

/* ------------------------------------------------------------- quiet hours */

/**
 * When may this be delivered, given the owner's quiet hours?
 *
 * Returns null when now is fine, and an ISO instant when it is not. That
 * instant is found by stepping forward an hour at a time and asking the
 * owner's own zone what hour it is — 48 calls to a formatter at worst, and
 * correct across every daylight-saving transition, which arithmetic on an
 * offset is not. The result is rounded UP to the top of an hour, so a
 * deferral never lands one minute inside the window it was waiting out.
 *
 * A CRITICAL EVENT DOES NOT PIERCE QUIET HOURS HERE, and that is a deliberate
 * difference from WorkDash's events.js, which lets `crit` through. Nothing in
 * this area is an outage: a dispute with a Thursday deadline and a card that
 * failed at two in the morning are both things a person handles after
 * breakfast, and there is no event in the watched list whose value decays
 * inside eight hours. If one is ever added, this is the function that has to
 * learn about it rather than every caller.
 */
export function quietDeferral(
  at: Date,
  timezone: string,
  quiet: { from: number; to: number } | null,
): string | null {
  if (!quiet) return null;
  if (!inQuiet(zoned(timezone, at).hour, quiet)) return null;

  /*
    THE STEP IS FIFTEEN MINUTES AND THE INSTANT RETURNED IS NOT ROUNDED.

    This used to probe hourly and then round the winning probe to a UTC hour,
    which was wrong twice. Rounding DOWN landed before the moment that had
    been tested, and in a zone whose offset is not a whole number of hours
    that is back inside the window — Asia/Kolkata is UTC+5:30, so an event at
    22:15 local under 22-8 probed clear at 08:15 and the rounded answer was
    07:30 local, still quiet. Rounding UP was safe but blunt: a message held
    until nine when the owner's quiet hours ended at eight.

    Fifteen minutes is exact rather than merely safer. A quiet boundary is a
    LOCAL hour mark, and every IANA offset is a whole number of quarter hours,
    so the true end of the window always falls on a quarter-hour UTC mark —
    which means the first non-quiet quarter-hour at or after `at` IS the
    boundary, in any zone, with no rounding at all. 192 formatter calls at
    worst, once per delivery pass.
  */
  const QUARTER = 900_000;
  const first = Math.ceil(at.getTime() / QUARTER) * QUARTER;
  for (let step = 0; step <= 192; step++) {
    const probe = new Date(first + step * QUARTER);
    if (!inQuiet(zoned(timezone, probe).hour, quiet)) return probe.toISOString();
  }
  /* Unreachable while `from !== to` is enforced at parse time. Returning null
     rather than throwing: a notifier that crashes on a settings value is
     worse than one that sends early. */
  return null;
}

/* --------------------------------------------------- aggregate alert cover */

export const RECONCILE_MINUTES = 60;

/** The alert skills whose trips are about the same money these events are.
 *  Named rather than inferred, so adding a skill to this list is a decision
 *  somebody makes on purpose. */
export const COVERING_SKILLS = new Set(["stripe", "leakage"]);

export type AlertTrip = { id: number; ts: string; skill: string; rule: string };

/** Trips from revenue rules in the recent past, newest first. Read once per
 *  delivery pass rather than once per event. */
export function recentRevenueTrips(minutes = RECONCILE_MINUTES): AlertTrip[] {
  const byId = new Map(alertRules().map((r) => [r.id, r]));
  const cut = Date.now() - minutes * 60_000;
  return alertEvents({ days: 2, kinds: ["trip"], limit: 200 })
    .filter((e) => {
      const rule = byId.get(e.rule_id);
      return Boolean(rule && COVERING_SKILLS.has(rule.skill) && Date.parse(e.ts) >= cut);
    })
    .map((e) => ({
      id: e.id,
      ts: e.ts,
      skill: byId.get(e.rule_id)!.skill,
      rule: byId.get(e.rule_id)!.name,
    }));
}

/** The sentence to write into `suppressed_by`, or null when nothing covers
 *  this event. Pure, so the window rule is testable without an alerts table. */
export function coveredBy(
  eventAt: string,
  trips: AlertTrip[],
  minutes = RECONCILE_MINUTES,
): string | null {
  const at = Date.parse(eventAt);
  if (Number.isNaN(at)) return null;
  const hit = trips.find((t) => Math.abs(Date.parse(t.ts) - at) <= minutes * 60_000);
  return hit ? `alert ${hit.id} (${hit.rule})` : null;
}
