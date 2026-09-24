/**
 * A STRIPE EVENT AS A MESSAGE FROM A PERSON — what the owner's phone says.
 *
 * The feed row is the record: Stripe's event type, a factual sentence, the
 * account label. None of that is what somebody glancing at a lock screen
 * wants. They want "💰 New sale: FreeLLMAPI Premium, $19/yr" — what happened,
 * the product's real name, a price a human writes — and nothing else unless
 * it changes what they do next.
 *
 * ONE SALE IS ONE MESSAGE. Stripe announces a new subscriber three times in
 * the same second: the Checkout Session completing, the first invoice being
 * paid, the subscription being created. `groupSales` folds those into one
 * notice per customer, and every row in the group is marked delivered by the
 * one send, so nothing is told twice and nothing is left pending.
 *
 * THE NAMES COME FROM THE ATTRIBUTION THIS BOX ALREADY HAS and are never
 * guessed: the subscription's product in `stripe_subscriptions`, a price id's
 * product in `stripe_charges`, a plan nickname another subscription carries,
 * and the venture through `venture_links` (customers/venture.ts). Where none
 * of that answers, the message says "a subscription" rather than printing a
 * price id — a raw id on a phone is a thing the owner has to go and look up.
 *
 * PURE BELOW THE LOOKUP. Everything that reads the database is behind the
 * `Lookup` interface, so the wording is decidable in a test from rows alone.
 */
import { db, ventureRowById } from "../../db.ts";
import { cash, clip, clock, dateOf, plural, price, when } from "../../shared/phone.ts";
import type { EventDetail } from "./events.ts";
import type { BusinessEventRecord } from "./store.ts";
import { ventureMap, ventureOfProduct } from "./venture.ts";

/* ----------------------------------------------------------------- grouping */

/** The three events Stripe sends for one new subscriber, and a one-off's two. */
export const SALE_TYPES = new Set(["checkout.session.completed", "invoice.paid", "customer.subscription.created"]);
/** Stripe sends them within seconds; a quarter of an hour absorbs a slow walk. */
export const SALE_WINDOW_MINUTES = 15;

type Groupable = Pick<BusinessEventRecord, "id" | "type" | "at" | "customer" | "subscription" | "object_id">;

const subOf = (e: Groupable) =>
  e.subscription ?? (e.type.startsWith("customer.subscription.") ? e.object_id : null);

/**
 * Sale events for the same customer (or the same subscription) inside the
 * window become one group; everything else is a group of one. A group never
 * takes two events of the same type, which is what keeps two real purchases
 * by one customer ten minutes apart as two sales. Order is kept: a group sits
 * where its first event was.
 */
export function groupSales<T extends Groupable>(rows: T[], minutes = SALE_WINDOW_MINUTES): T[][] {
  const out: T[][] = [];
  const open: T[][] = [];
  for (const e of rows) {
    if (!SALE_TYPES.has(e.type)) {
      out.push([e]);
      continue;
    }
    const at = Date.parse(e.at);
    const sub = subOf(e);
    const home = open.find((g) => {
      const first = g[0]!;
      if (Math.abs(Date.parse(first.at) - at) > minutes * 60_000) return false;
      if (g.some((x) => x.type === e.type)) return false;
      return g.some((x) => (e.customer && x.customer === e.customer) || (sub && subOf(x) === sub));
    });
    if (home) home.push(e);
    else {
      const g = [e];
      open.push(g);
      out.push(g);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ lookups */

export type SubscriptionFacts = {
  product: string | null;
  plan: string | null;
  bill_interval: string | null;
  interval_count: number | null;
  status: string;
  currency: string;
  listed_monthly_usd: number;
  trial_end: string | null;
  paid_cents: number | null;
  cancel_at: string | null;
};

export type Lookup = {
  subscription(id: string): SubscriptionFacts | null;
  productOfPrice(priceId: string): string | null;
  /** What other subscriptions on the same plan nickname are: the product and
   *  how often it bills. How a new subscriber's plan is named before the
   *  collector has read their subscription. */
  plan(plan: string): { product: string; bill_interval: string | null; interval_count: number | null } | null;
  /** Venture name for a product, through the venture links. */
  ventureOfProduct(product: string): string | null;
  ventureName(id: string): string | null;
  /** Stripe's own decline for a failed payment, where a charge row has it. */
  failedCharge(e: BusinessEventRecord, detail: EventDetail): { code: string | null; message: string | null } | null;
};

/** The live tables. Built per pass: link decisions change under a person's
 *  hands, which is venture.ts's reason for not caching its map either. */
export function dbLookup(): Lookup {
  let map: ReturnType<typeof ventureMap> | null = null;
  const q = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T | undefined;
  return {
    subscription: (id) =>
      q<SubscriptionFacts>(
        `SELECT product, plan, bill_interval, interval_count, status, currency, listed_monthly_usd,
                trial_end, paid_cents, cancel_at FROM stripe_subscriptions WHERE id = ?`,
        id,
      ) ?? null,
    productOfPrice: (priceId) =>
      q<{ product: string }>("SELECT product FROM stripe_charges WHERE price_id = ? AND product IS NOT NULL LIMIT 1", priceId)
        ?.product ?? null,
    plan: (plan) =>
      q<{ product: string; bill_interval: string | null; interval_count: number | null }>(
        `SELECT product, bill_interval, interval_count, COUNT(*) AS n FROM stripe_subscriptions
          WHERE plan = ? AND product IS NOT NULL AND product <> 'Other'
          GROUP BY product, bill_interval, interval_count ORDER BY n DESC LIMIT 1`,
        plan,
      ) ?? null,
    ventureOfProduct: (product) => {
      map ??= ventureMap();
      const id = ventureOfProduct(map, product);
      return id ? (ventureRowById(id)?.name ?? null) : null;
    },
    ventureName: (id) => ventureRowById(id)?.name ?? null,
    failedCharge: (e, detail) => {
      const cols = "failure_code AS code, failure_message AS message";
      if (detail.chargeId) {
        const byId = q<{ code: string | null; message: string | null }>(`SELECT ${cols} FROM stripe_charges WHERE id = ?`, detail.chargeId);
        if (byId) return byId;
      }
      if (e.amount === null) return null;
      /* No charge id on the payload (newer API versions moved it): the failed
         charge for the same amount nearest in time, inside ten minutes. */
      const t = Date.parse(e.at);
      return (
        q<{ code: string | null; message: string | null }>(
          `SELECT ${cols} FROM stripe_charges
            WHERE status = 'failed' AND amount = ? AND lower(currency) = lower(?)
              AND created_at BETWEEN ? AND ?
            ORDER BY abs(julianday(created_at) - julianday(?)) LIMIT 1`,
          e.amount,
          e.currency ?? "",
          new Date(t - 600_000).toISOString(),
          new Date(t + 600_000).toISOString(),
          e.at,
        ) ?? null
      );
    },
  };
}

/* -------------------------------------------------------------------- words */

const parseDetail = (e: BusinessEventRecord): EventDetail => {
  if (!e.detail) return {};
  try {
    const d = JSON.parse(e.detail) as unknown;
    return d && typeof d === "object" ? (d as EventDetail) : {};
  } catch {
    return {};
  }
};

/**
 * ROWS WRITTEN BEFORE MIGRATION 255 have no detail, only the summary sentence
 * events.ts assembled. Its shapes are this repo's own, so the few facts a
 * message needs are read back out of it — and only for those rows.
 */
function fromSummary(e: BusinessEventRecord): EventDetail {
  const s = e.summary;
  const d: EventDetail = {};
  const plan = / on (.+?)(?: \((\w+)\)\.$|, reason| — |\.$)/.exec(s);
  if (plan && !/^attempt \d/.test(plan[1]!)) d.plan = plan[1];
  const status = /\((\w+)\)\.$/.exec(s) ?? /is now (\w+)/.exec(s);
  if (status) d.status = status[1];
  const reason = /“([^”]+)”/.exec(s);
  if (reason) d.reason = reason[1];
  const attempt = /on attempt (\d+)/.exec(s);
  if (attempt) d.attempt = Number(attempt[1]);
  const due = /Evidence due (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/.exec(s);
  if (due) d.dueBy = `${due[1]}T${due[2]}:00.000Z`;
  if (/^Cancellation scheduled/.test(s)) d.mode = "cancel-scheduled";
  const closed = /^Dispute closed as (\w+)/.exec(s);
  if (closed) d.status = closed[1];
  const mode = /^Checkout completed \((\w+)\)/.exec(s);
  if (mode) d.mode = mode[1];
  return d;
}

const detailOf = (e: BusinessEventRecord): EventDetail => (e.detail ? parseDetail(e) : fromSummary(e));

/** A plan nickname a person typed ("Premium Annual") rather than a code
 *  ("annual-19-tax-inclusive", "PLAN_PRO_MONTHLY"). */
const humanPlan = (plan: string | null | undefined) => !!plan && /\s/.test(plan) && !/_/.test(plan);

const MONTHS_IN: Record<string, number> = { day: 1 / 30, week: 12 / 52, month: 1, year: 12 };

type Sold = {
  /** "FreeLLMAPI Premium", "a CircleChat subscription", "a subscription". */
  label: string;
  /** Whether the label is a real product or plan name. */
  named: boolean;
  venture: string | null;
  /** "$19/yr", or null when no amount is known. */
  price: string | null;
  sub: SubscriptionFacts | null;
};

/** What was bought, in words, from every row that describes it. */
function whatSold(rows: BusinessEventRecord[], lu: Lookup): Sold {
  const d: EventDetail = {};
  for (const r of rows) for (const [k, v] of Object.entries(detailOf(r))) (d as Record<string, unknown>)[k] ??= v;
  const subId = rows.map(subOf).find(Boolean) ?? null;
  const sub = subId ? lu.subscription(subId) : null;
  const plan = d.plan ?? sub?.plan ?? null;
  const same = plan && !sub ? lu.plan(plan) : null;

  const product =
    d.productName ??
    sub?.product ??
    (d.priceId ? lu.productOfPrice(d.priceId) : null) ??
    same?.product ??
    null;
  const venture =
    rows.map((r) => (r.venture_id ? lu.ventureName(r.venture_id) : null)).find(Boolean) ??
    (product ? lu.ventureOfProduct(product) : null);

  const interval = d.interval ?? sub?.bill_interval ?? same?.bill_interval ?? null;
  const count = d.intervalCount ?? sub?.interval_count ?? same?.interval_count ?? null;
  const paid = rows.find((r) => r.amount !== null && r.amount > 0);
  const currency = paid?.currency ?? rows.find((r) => r.currency)?.currency ?? sub?.currency ?? null;
  /* The amount a person paid first; the price's own amount second; and only
     for a USD subscription the collector's monthly figure scaled back up, since
     that figure is normalised to USD and would be wrong in any other currency. */
  const amount =
    paid?.amount ??
    d.unitAmount ??
    (sub && sub.currency.toLowerCase() === "usd" && interval && MONTHS_IN[interval]
      ? Math.round(sub.listed_monthly_usd * MONTHS_IN[interval]! * (count ?? 1) * 100) / 100
      : null);

  const withVenture = (name: string) =>
    venture && !name.toLowerCase().includes(venture.toLowerCase()) ? `${venture} ${name}` : name;
  const label = product && product !== "Other"
    ? withVenture(product)
    : humanPlan(plan)
      ? withVenture(plan!)
      : venture
        ? `a ${venture} subscription`
        : "a subscription";
  return {
    label,
    named: !label.startsWith("a "),
    venture,
    price: amount !== null ? price(amount, currency, interval, count) : null,
    sub,
  };
}

/** Stripe's decline, as a person would say it. */
export function declineWords(code: string | null, message: string | null): string | null {
  const m = (message ?? "").toLowerCase();
  if (m.includes("insufficient funds") || code === "insufficient_funds") return "not enough funds on the card";
  if (m.includes("does not support this type")) return "the card doesn't allow this kind of purchase";
  if (code === "expired_card" || m.includes("expired")) return code === "payment_intent_payment_attempt_expired" ? "the payment attempt timed out" : "the card has expired";
  if (code === "incorrect_cvc") return "wrong security code";
  if (code === "authentication_required" || m.includes("authentication")) return "the bank wanted extra verification and it wasn't completed";
  if (code === "processing_error") return "a processing error at the bank";
  if (code === "card_declined" || m.includes("declined")) return "card declined";
  return code ? code.replace(/_/g, " ") : null;
}

const DISPUTE_REASONS: Record<string, string> = {
  fraudulent: "they say they didn't make the purchase",
  product_not_received: "they say they never got it",
  duplicate: "they say they were charged twice",
  subscription_canceled: "they say they had cancelled",
  product_unacceptable: "they say it wasn't as described",
  credit_not_processed: "they say a refund never arrived",
  unrecognized: "they don't recognise the charge",
  general: "no specific reason given",
};

const CANCEL_REASONS: Record<string, string> = {
  cancellation_requested: "They cancelled it themselves.",
  payment_failed: "It stopped because payments kept failing.",
  payment_disputed: "It ended after a dispute.",
};

export type Worded = {
  emoji: string;
  /** The first line without its emoji — also the bullet in a digest. */
  head: string;
  lines: string[];
  /** What a digest headline counts it as. */
  kind: "sale" | "trial" | "renewal" | "payment" | "failed" | "cancelled" | "cancelling" | "overdue" | "dispute" | "other";
};

const paren = (s: string | null) => (s ? ` (${s})` : "");

/**
 * One notice — a group of rows about one thing — in words.
 *
 * `standsFor` is the collapse count for a failed payment (events.ts), so four
 * declines in an hour say so on the one message that is sent.
 */
export function word(rows: BusinessEventRecord[], lu: Lookup, zone: string, standsFor = 1, now = new Date()): Worded {
  const types = new Set(rows.map((r) => r.type));
  const lead = rows[0]!;
  const d = detailOf(lead);

  if (rows.some((r) => SALE_TYPES.has(r.type))) {
    const s = whatSold(rows, lu);
    const all: EventDetail = Object.assign({}, ...rows.map(detailOf).reverse());
    const trial = (all.status ?? s.sub?.status) === "trialing";
    if (trial) {
      const ends = all.trialEnd ?? s.sub?.trial_end ?? null;
      return {
        emoji: "🎁",
        head: `New free trial: ${s.label}`,
        lines: s.price ? [`${s.price} once it ends${ends ? ` on ${dateOf(ends, zone, now)}` : ""}.`] : [],
        kind: "trial",
      };
    }
    const onlyInvoice = types.size === 1 && types.has("invoice.paid");
    if (onlyInvoice && all.billingReason === "subscription_cycle")
      return { emoji: "🔁", head: `Renewed: ${s.label}${s.price ? `, ${s.price}` : ""}`, lines: [], kind: "renewal" };
    if (onlyInvoice && all.billingReason !== "subscription_create")
      return {
        emoji: "💵",
        head: `Payment received: ${s.price ?? "a payment"}${s.named || s.venture ? ` for ${s.label.replace(/^a /, "")}` : ""}`,
        lines: [],
        kind: "payment",
      };
    const oneOff = all.mode === "payment" && !rows.some(subOf);
    const what = oneOff && !s.named ? (s.venture ? `${s.venture}, one-off payment` : "a one-off payment") : s.label;
    return { emoji: "💰", head: `New sale: ${what}${s.price ? `, ${s.price}` : ""}`, lines: [], kind: "sale" };
  }

  if (types.has("invoice.payment_failed")) {
    const s = whatSold(rows, lu);
    const charge = lu.failedCharge(lead, d);
    const cause = charge ? declineWords(charge.code, charge.message) : null;
    const amount = lead.amount !== null ? cash(lead.amount, lead.currency) : "a payment";
    const lines: string[] = [];
    const sub = s.sub;
    if (sub?.trial_end && !sub.paid_cents && Date.parse(lead.at) - Date.parse(sub.trial_end) < 2 * 86_400_000 && Date.parse(lead.at) >= Date.parse(sub.trial_end))
      lines.push("It was the first charge after the free trial.");
    if (standsFor > 1) lines.push(`It failed ${standsFor} times in the last hour.`);
    else if (d.attempt && d.attempt > 1) lines.push(`That was attempt ${d.attempt}.`);
    if (d.nextAttempt) lines.push(`Stripe will try again on ${dateOf(d.nextAttempt, zone, now)}.`);
    else if (lead.detail && d.attempt) lines.push("Stripe won't retry it.");
    return {
      emoji: "❌",
      head: `Payment failed: ${amount}${s.named || s.venture ? ` for ${s.label.replace(/^a /, "")}` : ""}${paren(cause)}`,
      lines: [lines.join(" ")].filter(Boolean),
      kind: "failed",
    };
  }

  if (types.has("customer.subscription.deleted")) {
    const s = whatSold(rows, lu);
    const sub = s.sub;
    const neverPaid = !!sub?.trial_end && sub.paid_cents === 0;
    if (neverPaid)
      return { emoji: "📉", head: `Trial ended without paying: ${s.label}${paren(s.price)}`, lines: [], kind: "cancelled" };
    const why = d.reason ? CANCEL_REASONS[d.reason] : undefined;
    return { emoji: "📉", head: `Cancelled: ${s.label}${paren(s.price)}`, lines: why ? [why] : [], kind: "cancelled" };
  }

  if (types.has("customer.subscription.updated")) {
    const s = whatSold(rows, lu);
    if (d.mode === "cancel-scheduled") {
      const ends = d.cancelAt ?? s.sub?.cancel_at ?? null;
      return {
        emoji: "👋",
        head: `Cancelling: ${s.label}${paren(s.price)}`,
        lines: [ends ? `They turned off renewal, so it ends on ${dateOf(ends, zone, now)}.` : "They turned off renewal; it runs to the end of what they paid for."],
        kind: "cancelling",
      };
    }
    switch (d.status) {
      case "past_due":
        return { emoji: "⚠️", head: `Payment overdue: ${s.label}${paren(s.price)}`, lines: ["The latest payment didn't go through, so Stripe is retrying."], kind: "overdue" };
      case "unpaid":
        return { emoji: "⚠️", head: `Unpaid: ${s.label}${paren(s.price)}`, lines: ["Stripe has stopped retrying the payment."], kind: "overdue" };
      case "canceled":
        return { emoji: "📉", head: `Cancelled: ${s.label}${paren(s.price)}`, lines: [], kind: "cancelled" };
      case "incomplete_expired":
        return { emoji: "⌛", head: `Signup abandoned: ${s.label}`, lines: ["The first payment never went through."], kind: "cancelled" };
    }
  }

  if (types.has("charge.dispute.created")) {
    const venture = lead.venture_id ? lu.ventureName(lead.venture_id) : null;
    const reason = d.reason ? (DISPUTE_REASONS[d.reason] ?? d.reason.replace(/_/g, " ")) : null;
    const amount = lead.amount !== null ? cash(lead.amount, lead.currency) : "a charge";
    return {
      emoji: "🚨",
      head: `Dispute: ${amount}${venture ? ` for ${venture}` : ""}${paren(reason)}`,
      lines: d.dueBy ? [`Evidence is due by ${dateOf(d.dueBy, zone, now)}, ${clock(d.dueBy, zone)}.`] : [],
      kind: "dispute",
    };
  }

  if (types.has("charge.dispute.closed")) {
    const amount = lead.amount !== null ? cash(lead.amount, lead.currency) : "a charge";
    if (d.status === "won") return { emoji: "✅", head: `Dispute won: ${amount}`, lines: [], kind: "other" };
    if (d.status === "lost") return { emoji: "❌", head: `Dispute lost: ${amount}`, lines: [], kind: "dispute" };
    if (d.status === "warning_closed") return { emoji: "✅", head: `Dispute inquiry closed: ${amount}`, lines: [], kind: "other" };
    return { emoji: "ℹ️", head: `Dispute closed: ${amount}${paren(d.status?.replace(/_/g, " ") ?? null)}`, lines: [], kind: "other" };
  }

  return { emoji: "ℹ️", head: clip(lead.summary, 200), lines: [], kind: "other" };
}

/** How old an event may be before its message says when it happened. A sale
 *  that just happened needs no clock; one quiet hours or an outage held does. */
const STALE_MINUTES = 30;

/** One notice as the message a phone gets. */
export function noticeText(rows: BusinessEventRecord[], lu: Lookup, zone: string, standsFor = 1, now = new Date()): string {
  const w = word(rows, lu, zone, standsFor, now);
  const at = rows[0]!.at;
  const stale = now.getTime() - Date.parse(at) > STALE_MINUTES * 60_000;
  return [`${w.emoji} ${w.head}`, ...w.lines, stale ? `That was ${when(at, zone, now)}.` : ""].filter(Boolean).join("\n");
}

const KIND_WORDS: [Worded["kind"], string, string][] = [
  ["sale", "new sale", "new sales"],
  ["trial", "new trial", "new trials"],
  ["renewal", "renewal", "renewals"],
  ["payment", "payment", "payments"],
  ["failed", "failed payment", "failed payments"],
  ["overdue", "overdue payment", "overdue payments"],
  ["cancelling", "cancellation coming", "cancellations coming"],
  ["cancelled", "cancellation", "cancellations"],
  ["dispute", "dispute", "disputes"],
  ["other", "other update", "other updates"],
];

/** Lines a digest names before it says how many more. */
const DIGEST_LINES = 12;

/** Several notices at once, as one message: a count headline, then bullets. */
export function digestText(groups: { rows: BusinessEventRecord[]; standsFor: number }[], lu: Lookup, zone: string, now = new Date()): string {
  const worded = groups.map((g) => word(g.rows, lu, zone, g.standsFor, now));
  const counts = new Map<Worded["kind"], number>();
  for (const w of worded) counts.set(w.kind, (counts.get(w.kind) ?? 0) + 1);
  const parts = KIND_WORDS.filter(([k]) => counts.get(k)).map(([k, one, many]) => plural(counts.get(k)!, one, many));
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "";
  const money = ["sale", "trial", "renewal", "payment"] as const;
  const mark = counts.get("dispute") ? "🚨" : counts.get("failed") || counts.get("overdue") ? "⚠️" : money.some((k) => counts.get(k)) ? "💰" : "📋";
  const lines = [`${mark} ${joined[0]?.toUpperCase()}${joined.slice(1)}`];
  for (const w of worded.slice(0, DIGEST_LINES)) lines.push(`• ${w.emoji} ${w.head}`);
  if (worded.length > DIGEST_LINES) lines.push(`…and ${worded.length - DIGEST_LINES} more on the Customers page.`);
  return lines.join("\n");
}
