/**
 * THE CUSTOMERS PASS — one function, run on a clock and by a button.
 *
 * IT IS NOT A STRIPE COLLECTOR AND MUST NEVER BE REGISTERED AS ONE.
 * `manifestCollectors()` merges every area's map OVER collector.ts's built-ins
 * keyed by plugin id, so an entry under `stripe` here would silently REPLACE
 * the revenue collector and take MRR, the ledger and the balance off the whole
 * dashboard — the trap mailflow/manifest.ts wrote down about `gmail`. This
 * pass is registered under its own `customers` plugin id, which holds settings
 * and no credential, and it reads the Stripe accounts through the same vault
 * reader everything else uses.
 *
 * WHAT ONE PASS DOES, IN ORDER, AND WHY THAT ORDER:
 *
 *   1. Walk disputes. They are the slowest-moving thing here and they are an
 *      input to cases, so they go first.
 *   2. Walk open invoices. Current state, not a window — an unpaid invoice
 *      from March is exactly the one worth chasing.
 *   3. Walk events since the cursor. This is also how an invoice gets its
 *      "was it actually paid" answer, which is why it runs before resolution.
 *   4. Derive the queue from the Stripe tables and upsert it.
 *   5. Close what Stripe now shows as fixed.
 *   6. Resolve a bounded number of customer addresses for open cases.
 *   7. Deliver what is owed on Telegram.
 *
 * ONE ACCOUNT FAILING LOSES ONLY THAT ACCOUNT, the rule every collector on
 * this box keeps. A revoked key takes its own cases off the page and leaves
 * the other account's where they were; the pass fails only when every account
 * failed. A key that can read subscriptions but NOT disputes or events is a
 * specific and useful finding, and it is reported as the sentence Stripe
 * itself returned rather than as an empty page.
 */
import * as accounts from "../../accounts.ts";
import { db, finishRun, getPlugin, startRun, stripeSubscriptions, upsertPlugin } from "../../db.ts";
import {
  OPEN_DISPUTE_STATUSES,
  describeStripeError,
  fetchCustomer,
  fetchSubscriptionCustomer,
  keyAccounts,
  walkDisputes,
  walkEvents,
  walkOpenInvoices,
  type OpenInvoiceRow,
} from "../../providers/stripe.ts";
import { deriveCases, resolutionFor } from "./cases.ts";
import {
  collapseFailures,
  coveredBy,
  parseEvent,
  quietDeferral,
  recentRevenueTrips,
} from "./events.ts";
import {
  cases,
  cursor,
  defer,
  disputes as storedDisputes,
  forgetPlainAddresses,
  insertEvents,
  LIVE_STATUSES,
  markDelivered,
  markDeliveryFailed,
  mutedTypes,
  pendingEvents,
  setCaseCustomer,
  setCaseEmail,
  setCaseStatus,
  setCursor,
  settings,
  suppress,
  upsertCase,
  writeDisputes,
  type BusinessEventRecord,
  type EventWrite,
} from "./store.ts";
import { ventureMap, ventureOfSubscription, soleVenture } from "./venture.ts";

export const PLUGIN = "customers";

/** How far back every pass rewalks disputes. Ninety days is the span in which
 *  a case's status can still move; anything still OPEN older than that is
 *  walked too, by lowering the floor to its own opening date. */
const DISPUTE_REWALK_DAYS = 90;

/** The first event walk's reach. A day rather than Stripe's full thirty,
 *  because connecting a key must not put last month on somebody's phone —
 *  and everything in that first walk is recorded suppressed anyway. */
const FIRST_EVENT_HOURS = 24;

/** Customer lookups per pass. One GET each, and the answer rarely changes, so
 *  the queue's addresses fill over the first two or three passes rather than
 *  costing four hundred requests the first time somebody presses Collect. */
const CUSTOMER_LOOKUPS_PER_PASS = 40;

/** How many delivery attempts an event gets before the pass stops trying. It
 *  stays undelivered, with the last error on it, in the undelivered view —
 *  never silently dropped. */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** How many messages one pass will send. A burst ceiling, not a policy: past
 *  this the rest wait for the next pass rather than arriving as forty pings. */
const MAX_SENDS_PER_PASS = 10;

/**
 * THE PSEUDO-PLUGIN'S CONNECTED FLAG, and why it is not `syncPlugin`.
 *
 * `syncPlugin` derives the flag from a plugin's own ACCOUNTS, and this plugin
 * has none — it holds settings, the way `backups` and `outbox` do. What makes
 * the customers area live is a connected STRIPE account, so the flag is
 * derived from that. Getting this wrong would be invisible and expensive: the
 * scheduler only collects connected plugins, so a permanently-zero flag would
 * mean the queue quietly stopped updating while the page still drew it.
 */
export function markPlugin(error: string | null) {
  upsertPlugin(PLUGIN, getPlugin("stripe")?.connected === 1, error);
}

let running = false;

export type PassResult = {
  ok: boolean;
  error?: string | null;
  note?: string | null;
  disputes: number;
  openInvoices: number;
  events: number;
  newEvents: number;
  cases: number;
  resolved: number;
  delivered: number;
  deferred: number;
  suppressed: number;
  addresses: number;
  warnings: string[];
};

const EMPTY = (): PassResult => ({
  ok: false,
  disputes: 0,
  openInvoices: 0,
  events: 0,
  newEvents: 0,
  cases: 0,
  resolved: 0,
  delivered: 0,
  deferred: 0,
  suppressed: 0,
  addresses: 0,
  warnings: [],
});

export async function runPass(): Promise<PassResult> {
  if (running)
    return { ...EMPTY(), ok: true, note: "A customers pass was already running; this one did nothing." };
  running = true;
  const runId = startRun(PLUGIN);
  const out = EMPTY();
  try {
    const s = settings();
    const pairs = keyAccounts("collect_customers");
    if (!pairs.length) {
      const error = "No Stripe account is connected, so there are no customers to read.";
      finishRun(runId, false, undefined, error);
      return { ...out, error };
    }

    /* Turning contact access OFF has to remove what is already stored, or
       "off" would only ever mean "no new ones". */
    if (!s.contactAccess) forgetPlainAddresses();

    const map = ventureMap();
    const nowMs = Date.now();
    const subs = stripeSubscriptions();
    const invoicesByAccount = new Map<number, OpenInvoiceRow[]>();
    let okAccounts = 0;

    for (const { account, key } of pairs) {
      const label = account.label;
      try {
        /* ---- 1. disputes ------------------------------------------------- */
        const stillOpen = storedDisputes({ limit: 2000 }).filter(
          (d) => d.account_id === account.id && d.outcome === null && OPEN_DISPUTE_STATUSES.has(d.status),
        );
        const seeded = cursor("disputes", account.id) === "seeded";
        const rewalkFrom = Math.floor(nowMs / 1000) - DISPUTE_REWALK_DAYS * 86_400;
        const oldestOpen = stillOpen
          .map((d) => Math.floor(Date.parse(d.created_at) / 1000))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b)[0];
        /* The floor is the older of "ninety days" and "the oldest case still
           open", so a dispute that has been under review since spring still
           gets its status refreshed. The first pass reads the account's whole
           dispute history, which is a walk measured in dozens of rows on any
           account this queue is useful for. */
        const from = seeded ? Math.min(rewalkFrom, oldestOpen ?? rewalkFrom) : 0;
        const walked = await walkDisputes(key, from);
        out.disputes += walked.length;
        if (walked.length)
          writeDisputes(
            walked.map((d) => ({
              id: d.id,
              account_id: account.id,
              account_label: label,
              charge: d.charge,
              payment_intent: d.paymentIntent,
              amount: d.amount,
              currency: d.currency,
              reason: d.reason,
              status: d.status,
              evidence_due_by: d.evidenceDueBy,
              submission_count: d.submissionCount,
              created_at: d.createdAt,
              outcome: d.outcome,
              isChargeRefundable: d.isChargeRefundable,
              /* A dispute names a CHARGE, and a charge has no product on it.
                 Rule two only — see venture.ts. */
              ventureId: soleVenture(map),
              terminal: !OPEN_DISPUTE_STATUSES.has(d.status),
            })),
          );
        setCursor("disputes", account.id, "seeded");

        /* ---- 2. open invoices -------------------------------------------- */
        const invoices = await walkOpenInvoices(key);
        invoicesByAccount.set(account.id, invoices);
        out.openInvoices += invoices.length;

        /* ---- 3. events --------------------------------------------------- */
        const evCursor = cursor("events", account.id);
        const firstWalk = evCursor === null;
        const since = firstWalk
          ? Math.floor(nowMs / 1000) - FIRST_EVENT_HOURS * 3_600
          : Number(evCursor);
        const events = await walkEvents(key, Number.isFinite(since) ? since : 0);
        out.events += events.length;

        const muted = new Set(mutedTypes());
        const writes: EventWrite[] = events.map((e) => {
          const parsed = parseEvent(e.type, e.object, e.previous);
          const suppressedBy = firstWalk
            ? "first collection"
            : muted.has(e.type)
              ? "type muted"
              : parsed.uninteresting
                ? "nothing a person acts on changed"
                : null;
          return {
            id: e.id,
            accountId: account.id,
            accountLabel: label,
            ventureId:
              ventureOfSubscription(map, parsed.subscription) ??
              (parsed.objectType === "dispute" ? soleVenture(map) : null),
            type: e.type,
            at: e.createdAt,
            summary: parsed.summary,
            objectId: parsed.objectId,
            objectType: parsed.objectType,
            customer: parsed.customer,
            amount: parsed.amount,
            currency: parsed.currency,
            muted: suppressedBy !== null,
            suppressedBy,
          };
        });
        out.newEvents += insertEvents(writes);
        out.suppressed += writes.filter((w) => w.muted).length;

        /* The cursor advances to the newest event SEEN, and the walk overlaps
           it next time because two events can share a second. The events
           table's primary key makes the overlap free. */
        const newest = events.length ? events[events.length - 1]!.created : since;
        setCursor("events", account.id, String(Math.max(newest, 0)));

        accounts.markOk(account.id);
        okAccounts += 1;
      } catch (err) {
        const error = describeStripeError(err);
        out.warnings.push(`${label}: ${error}`);
        accounts.markFailed(account.id, error);
      }
    }

    if (!okAccounts) {
      const error = out.warnings.join("; ") || "Every Stripe account failed.";
      finishRun(runId, false, undefined, error);
      markPlugin(error);
      return { ...out, error };
    }

    /* ---- 4 and 5. the queue ------------------------------------------- */
    const allDisputes = storedDisputes({ limit: 2000 });
    const openInvoiceIds = new Set<string>();
    for (const { account } of pairs) {
      const invoices = invoicesByAccount.get(account.id);
      if (!invoices) continue;
      for (const inv of invoices) openInvoiceIds.add(inv.id);
      const derived = deriveCases({
        accountId: account.id,
        accountLabel: account.label,
        subscriptions: subs,
        openInvoices: invoices,
        disputes: allDisputes,
        ventures: map,
        nowMs,
        horizonDays: s.horizonDays,
        trialDays: s.trialDays,
      });
      for (const c of derived.cases) upsertCase(c);
      out.cases += derived.cases.length;
    }

    /* Everything still live in the table, asked whether Stripe has fixed it.
       Only accounts that ANSWERED this pass are considered: a case whose
       account's key was refused must not be resolved as "no longer open",
       because nobody looked. */
    const answered = new Set(
      pairs.filter((p) => !out.warnings.some((w) => w.startsWith(`${p.account.label}:`))).map((p) => p.account.id),
    );
    const subById = new Map(subs.map((x) => [x.id, x]));
    const disputeById = new Map(allDisputes.map((d) => [d.id, d]));
    for (const row of cases({ statuses: LIVE_STATUSES, limit: 1000 })) {
      if (!answered.has(row.account_id)) continue;
      const reason = resolutionFor(row, {
        subscription: subById.get(row.subject_ref) ?? null,
        dispute: disputeById.get(row.subject_ref) ?? null,
        invoiceStillOpen: openInvoiceIds.has(row.subject_ref),
        invoicePaid: paidEventSeen(row.subject_ref),
        nowMs,
      });
      if (reason) {
        setCaseStatus(row.id, "resolved", reason);
        out.resolved += 1;
      }
    }

    /* ---- 6. addresses -------------------------------------------------- */
    out.addresses = await fillAddresses(pairs, s.contactAccess);

    /* ---- 7. delivery --------------------------------------------------- */
    const delivery = await deliverPending(s);
    out.delivered = delivery.delivered;
    out.deferred = delivery.deferred;
    out.suppressed += delivery.suppressed;

    const note =
      `${out.disputes} dispute(s) walked, ${out.openInvoices} open invoice(s), ` +
      `${out.newEvents} new event(s) of ${out.events} seen · ${out.cases} case(s) derived, ` +
      `${out.resolved} resolved · ${out.delivered} delivered, ${out.deferred} deferred, ` +
      `${out.suppressed} suppressed` +
      (pairs.length > 1 ? ` · ${okAccounts}/${pairs.length} accounts` : "");
    finishRun(runId, true, note, out.warnings.join("; ") || undefined);
    markPlugin(out.warnings.join("; ") || null);
    return { ...out, ok: true, note };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, undefined, error);
    markPlugin(error);
    return { ...out, error };
  } finally {
    running = false;
  }
}

/**
 * Has an `invoice.paid` event for this invoice actually been seen?
 *
 * The difference between "the invoice is no longer open" and "the customer
 * paid", which are not the same fact — an invoice can also be voided or
 * written off, and a resolution that said "paid" on the strength of an
 * absence would be a figure somebody quotes.
 *
 * A dedicated indexed read rather than a filter over the table, because this
 * runs once per open payment case on every pass.
 */
function paidEventSeen(invoiceId: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM business_events WHERE object_id = ? AND type = 'invoice.paid' LIMIT 1",
      )
      .get(invoiceId),
  );
}

/**
 * An address for every open case that does not have one yet, up to the cap.
 *
 * A dispute is skipped: there is nobody here to write to. A churn or trial
 * case reaches its customer through the SUBSCRIPTION, which carries only a
 * customer id, so the id is read off the invoice list where one exists and
 * otherwise off the subscription's own customer field — which this box does
 * not store, so those cases carry the hash of an address only once an invoice
 * or an event has named one.
 */
async function fillAddresses(
  pairs: { account: { id: number; label: string }; key: string }[],
  contactAccess: boolean,
): Promise<number> {
  /* Two states want a lookup. A case with no hash has never been asked. A case
     WITH a hash and no plain address, while contact access is on, was asked
     during a period when the address could not be stored — turning the setting
     on has to fill those in, or "on" would only ever mean "from now on". A
     customer whose address was removed at Stripe stays in the second state and
     is re-asked each pass, which the per-pass cap already bounds. */
  const wanted = cases({ statuses: ["open", "drafted"], limit: 500 }).filter(
    (r) => r.kind !== "dispute" && (!r.email_hash || (contactAccess && !r.email_plain)),
  );
  if (!wanted.length) return 0;

  const keyOf = new Map(pairs.map((p) => [p.account.id, p.key]));
  let done = 0;
  for (const row of wanted.slice(0, CUSTOMER_LOOKUPS_PER_PASS)) {
    const key = keyOf.get(row.account_id);
    if (!key) continue;
    try {
      /* A churn or trial case reaches its customer through the SUBSCRIPTION,
         which is one extra GET because the revenue table has no customer
         column — see providers/stripe.ts. An invoice case already carries the
         id and never spends this request. */
      const customerId =
        row.customer ??
        (row.subject_ref.startsWith("sub_")
          ? await fetchSubscriptionCustomer(key, row.subject_ref)
          : null);
      if (!customerId) continue;
      if (!row.customer) setCaseCustomer(row.id, customerId);
      const c = await fetchCustomer(key, customerId);
      /* A deleted customer keeps its case. Dropping the row would quietly
         shorten a list somebody is working through — WorkDash's rule, and the
         right one. It simply has no address. */
      setCaseEmail(row.id, c.deleted ? null : c.email, contactAccess);
      done += 1;
    } catch {
      /* One customer that cannot be read costs one address, never the pass. */
    }
  }
  return done;
}

/**
 * THE DELIVERY PASS: collapse, reconcile, defer, send.
 *
 * The four decisions are made in that order and each is recorded on the row,
 * because "you were not told" is a fact about the tool and the undelivered
 * view is the only place it can be read.
 */
export async function deliverPending(
  s: ReturnType<typeof settings>,
): Promise<{ delivered: number; deferred: number; suppressed: number }> {
  const pending = pendingEvents(200);
  if (!pending.length) return { delivered: 0, deferred: 0, suppressed: 0 };

  let suppressed = 0;
  let deferred = 0;
  let delivered = 0;

  /* Collapse first, so a reconciliation or a deferral is never spent on an
     event that was going to be folded away anyway. */
  const { collapsed, standsFor } = collapseFailures(
    pending.map((e) => ({ id: e.id, type: e.type, at: e.at, customer: e.customer })),
  );
  for (const [id, into] of collapsed) {
    suppress(id, `collapsed into ${into}`);
    suppressed += 1;
  }

  if (!s.telegram) {
    /* Pushing is off. Events are still ingested, still collapsed and still
       readable — what is not happening is a message, and the row says so
       rather than pretending the queue is empty. */
    return { delivered: 0, deferred: 0, suppressed };
  }

  const trips = recentRevenueTrips();
  const at = new Date();
  let sent = 0;

  for (const e of pending) {
    if (collapsed.has(e.id)) continue;
    if (e.attempts >= MAX_DELIVERY_ATTEMPTS) continue;

    const cover = coveredBy(e.at, trips);
    if (cover) {
      suppress(e.id, cover);
      suppressed += 1;
      continue;
    }

    const until = quietDeferral(at, s.timezone, s.quiet);
    if (until) {
      defer(e.id, until);
      deferred += 1;
      continue;
    }

    if (sent >= MAX_SENDS_PER_PASS) break;
    const result = await push(message(e, standsFor.get(e.id) ?? 1));
    sent += 1;
    if (result.sent) {
      markDelivered(e.id);
      delivered += 1;
    } else {
      markDeliveryFailed(e.id, result.reason ?? "Telegram did not accept the message.");
    }
  }

  return { delivered, deferred, suppressed };
}

/**
 * THE OUTBOUND CALL, AND WHY IT IS AN `await import` RATHER THAN A TOP-LEVEL ONE.
 *
 * `telegram/bridge.ts` is the right seam — it is the one function on this box
 * that cannot send to the wrong chat, because it only ever sends to a LOCKED
 * one and returns `{ sent: false }` with a reason when there is no pairing.
 * But its import graph reaches `routes/chat.ts`, which reaches
 * `routes/pluginConfig.ts`, which calls `manifestCollectors()` at module
 * scope — and a manifest importing that at load time is a cycle that ends in
 * "Cannot access 'MANIFESTS' before initialization" and a server that will not
 * boot. Deferring the import to the first delivery costs one resolved module
 * on a path that already awaits a network call, and it keeps the notification
 * going through the one door that checks who it is going to.
 *
 * PLAIN TEXT, NOT HTML, for proactive/telegram.ts's reason: a summary carries
 * whatever Stripe put in a plan name, and a stray `<` in HTML mode is a 400
 * from Telegram rather than a message.
 */
async function push(text: string): Promise<{ sent: boolean; reason?: string }> {
  const { notify } = await import("../../telegram/bridge.ts");
  return notify(text, { html: false });
}

/**
 * One event on a phone. Plain text, for proactive/telegram.ts's reason: a
 * summary can contain any character at all and a stray `<` in HTML mode is a
 * 400 from Telegram rather than a message.
 */
export function message(e: BusinessEventRecord, standsFor: number): string {
  const when = `${e.at.slice(0, 16).replace("T", " ")} UTC`;
  const lines = [
    `${e.type}`,
    e.summary,
    standsFor > 1
      ? `This stands for ${standsFor} failed-payment events for the same customer within the hour.`
      : "",
    e.venture_id ? `Venture: ${e.venture_id}` : "",
    `${when} · ${e.account_label}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Re-exported for the manifest's collector entry, which wants the shared
 *  CollectResult shape and nothing else. */
export async function collectCustomers(): Promise<{ ok: boolean; error?: string | null; note?: string | null }> {
  const r = await runPass();
  return { ok: r.ok, error: r.error ?? null, note: r.note ?? null };
}

/* ------------------------------------------------------------------ timer */

/** Every ten minutes. Faster than the half-hour collector clock because the
 *  point of an event feed is that it is not a digest, and slower than a
 *  minute because Stripe's events endpoint is not a websocket and a deadline
 *  measured in days does not need one. Unref'd: it must never hold the
 *  process open. */
export const PASS_MINUTES = 10;

export function startCustomersTimer() {
  const tick = () => {
    void runPass().catch(() => {
      /* runPass already writes its own failure to the run ledger. A throw
         escaping here would take the timer with it. */
    });
  };
  /* A minute after boot rather than immediately: the Stripe collector may
     still be filling the subscription book this pass derives cases from, and
     a queue built from an empty table is a queue that resolves everything. */
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, PASS_MINUTES * 60_000).unref?.();
}

