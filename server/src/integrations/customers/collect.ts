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
import { db, finishRun, getPlugin, now, startRun, stripeSubscriptions, upsertPlugin } from "../../db.ts";
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
  COLLAPSE_MINUTES,
  collapseFailures,
  coveredBy,
  parseEvent,
  quietDeferral,
  recentRevenueTrips,
  type Collapsible,
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
import { SALE_TYPES, SALE_WINDOW_MINUTES, dbLookup, digestText, groupSales, noticeText } from "./notice.ts";

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

/** Up to this many notices in one pass go one message each; past it, one
 *  digest carries them all. proactive/pushes.ts keeps the same line. */
export const SINGLE_MAX = 3;

/**
 * HOW STALE AN EVENT MAY BE AND STILL BE WORTH A MESSAGE.
 *
 * The burst this prevents: pushing is off, months of events accumulate, the
 * owner switches the setting on one morning, and the pass begins working
 * through the entire history at ten messages every ten minutes — hours of
 * "Invoice paid" pings for invoices paid in July. The same thing happens to a
 * laptop that was shut for a fortnight. A notification is a claim that
 * something is worth interrupting somebody for NOW, and an event from July is
 * not, however true it still is.
 *
 * TWENTY-FOUR HOURS, MEASURED FROM WHEN THE ROW BECAME ELIGIBLE rather than
 * from the event's own timestamp. A row held by quiet hours became eligible at
 * `deferred_until`, and measuring a 22:00 event that waited until 08:00
 * against its own `at` would throw away exactly the message quiet hours
 * existed to preserve.
 *
 * Nothing is deleted. The row keeps its sentence and stays in the feed and in
 * the undelivered view; what it loses is the phone.
 */
const MAX_EVENT_AGE_HOURS = 24;

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
  /** Cases whose linked outbox draft moved on: sent, or deleted. */
  relinked: number;
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
  relinked: 0,
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

    /* HOUSEKEEPING RUNS BEFORE THE EARLY RETURN, and that ordering is the
       whole point of it being here. Turning contact access off has to delete
       what is already stored or "off" only ever means "no new ones" — and the
       one moment that matters most is the moment Stripe is DISCONNECTED,
       which is exactly the pass that has no accounts to walk. The same goes
       for the connected flag: leaving it at 1 after the key is removed would
       keep this plugin on the scheduler and on the page forever. */
    if (!s.contactAccess) forgetPlainAddresses();

    const pairs = keyAccounts("collect_customers");
    if (!pairs.length) {
      const error = "No Stripe account is connected, so there are no customers to read.";
      finishRun(runId, false, undefined, error);
      markPlugin(error);
      return { ...out, error };
    }

    const map = ventureMap();
    const nowMs = Date.now();
    const subs = stripeSubscriptions();
    const invoicesByAccount = new Map<number, OpenInvoiceRow[]>();
    /*
      THE ACCOUNTS WHOSE INVOICE WALK CAME BACK SHORT.

      A truncated invoice walk is not a small answer, it is a wrong one: the
      resolution step reads ABSENCE from `openInvoiceIds` as "Stripe no longer
      lists this invoice as open" and closes the case with that sentence. On a
      capped walk the missing invoices are still open, the sentence is false,
      and `upsertCase`'s status guard then refuses to re-open the case on the
      next pass — so one short walk permanently loses a payment case. Any
      account in this set has its payment_failed resolutions skipped entirely.
    */
    const invoiceWalkShort = new Set<number>();
    /*
      THE ACCOUNTS WHOSE WALK ACTUALLY FAILED, as ids — not re-derived at the
      resolution step by asking which warnings began with an account's label.
      That reading is wrong twice over: two accounts called "Account 1" and
      "Account 10" match each other under `startsWith`, and — since the
      truncation notes above are warnings too — a short walk would be read as
      a failed one and stop every resolution on that account, including the
      churn and dispute cases a capped invoice page says nothing about. An id
      is not ambiguous.
    */
    const failedAccounts = new Set<number>();
    let okAccounts = 0;

    for (const { account, key } of pairs) {
      const label = account.label;
      try {
        /* ---- 1. disputes ------------------------------------------------- */
        const stillOpen = storedDisputes({ limit: 2000 }).filter(
          (d) => d.account_id === account.id && d.outcome === null && OPEN_DISPUTE_STATUSES.has(d.status),
        );
        /* Which cases this box currently believes are LIVE. `closed_at` is
           stamped on the transition out of this set and nowhere else — see
           below. */
        const wasOpen = new Set(stillOpen.map((d) => d.id));
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
        const disputeTruncated = new Set<string>();
        const walked = await walkDisputes(key, from, disputeTruncated);
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
              /*
                closed_at IS A TRANSITION, NOT A STATE, and this is the flag
                that says one happened.

                It is documented as the first moment THIS BOX saw a case
                settle, so it may only be stamped when the box previously
                believed the case was OPEN and now does not. Deriving it from
                "is terminal now" instead stamped every dispute in the
                account's history with the day the integration was installed —
                and stamped them again on the next rewalk, because a corrected
                NULL simply let COALESCE take the new value.

                A case that has never been seen open — the whole settled
                history the first walk reads — keeps NULL, which is the true
                statement: it was closed before anybody here looked.
              */
              terminal: wasOpen.has(d.id) && !OPEN_DISPUTE_STATUSES.has(d.status),
            })),
          );
        /*
          THE SEEDING CURSOR IS ONLY SET ON A COMPLETE FIRST WALK. Marking it
          "seeded" after a capped walk would pin the floor at ninety days
          forever, and the older history the cap dropped would never be read
          by anything.
        */
        if (disputeTruncated.size)
          out.warnings.push(
            `${label}: the dispute walk hit its row cap and Stripe had more. The history was not fully read and will be re-walked next pass.`,
          );
        else setCursor("disputes", account.id, "seeded");

        /* ---- 2. open invoices -------------------------------------------- */
        const invoiceTruncated = new Set<string>();
        const invoices = await walkOpenInvoices(key, invoiceTruncated);
        invoicesByAccount.set(account.id, invoices);
        out.openInvoices += invoices.length;
        if (invoiceTruncated.size) {
          invoiceWalkShort.add(account.id);
          out.warnings.push(
            `${label}: the open-invoice walk hit its row cap and Stripe had more, so no payment case on this account was closed this pass — absence from a short list is not evidence an invoice was settled.`,
          );
        }

        /* ---- 3. events --------------------------------------------------- */
        const evCursor = cursor("events", account.id);
        const firstWalk = evCursor === null;
        const since = firstWalk
          ? Math.floor(nowMs / 1000) - FIRST_EVENT_HOURS * 3_600
          : Number(evCursor);
        const eventTruncated = new Set<string>();
        const events = await walkEvents(
          key,
          Number.isFinite(since) ? since : 0,
          eventTruncated,
        );
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
            subscription: parsed.subscription,
            detail: parsed.detail,
          };
        });
        out.newEvents += insertEvents(writes);
        out.suppressed += writes.filter((w) => w.muted).length;

        /*
          THE CURSOR ADVANCES ONLY WHEN THE WALK WAS COMPLETE.

          It normally moves to the newest event SEEN, and the next walk
          overlaps it because two events can share a second — the table's
          primary key makes that overlap free.

          A TRUNCATED WALK MUST NOT MOVE IT AT ALL, and this is the one place
          in the area where a cap changes an answer rather than shortening it.
          `/v1/events` answers newest-first and pages backwards in time, so a
          capped walk returns the NEWEST rows and drops the older ones;
          advancing to the newest would step over the middle of the window,
          and Stripe only keeps thirty days. Holding at `since` means the next
          pass reads the same window again — the newest rows are already
          stored and are ignored on re-insert — and the warning says the
          window is bigger than one walk can carry.
        */
        if (eventTruncated.size) {
          out.warnings.push(
            `${label}: the event walk hit its row cap and Stripe had more. The cursor was NOT advanced, so nothing has been skipped, but this window holds more events than one pass can read.`,
          );
        } else {
          const newest = events.length ? events[events.length - 1]!.created : since;
          setCursor("events", account.id, String(Math.max(newest, 0)));
        }

        accounts.markOk(account.id);
        okAccounts += 1;
      } catch (err) {
        const error = describeStripeError(err);
        out.warnings.push(`${label}: ${error}`);
        failedAccounts.add(account.id);
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
    /* Every case id this pass's derivation still considers live, across all
       accounts. A live row that is NOT in here no longer matches anything
       Stripe reports — see the closing step below. */
    const liveIds = new Set<string>();
    /* Accounts this pass actually derived a queue for. A case belonging to an
       account that was not walked cannot be judged by absence from `liveIds`,
       because nothing looked. */
    const derivedFor = new Set<number>();
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
      for (const id of derived.live) liveIds.add(id);
      derivedFor.add(account.id);
      out.cases += derived.cases.length;
    }

    /* The outbox rows this queue is pointing at, reconciled before anything
       is closed — a case whose draft was sent is `sent` rather than still
       `drafted`, and a case whose draft was deleted goes back to `open`. */
    out.relinked = reconcileDrafts();

    /* Everything still live in the table, asked whether Stripe has fixed it.
       Only accounts that ANSWERED this pass are considered: a case whose
       account's key was refused must not be resolved as "no longer open",
       because nobody looked. */
    const subById = new Map(subs.map((x) => [x.id, x]));
    const disputeById = new Map(allDisputes.map((d) => [d.id, d]));
    for (const row of cases({ statuses: LIVE_STATUSES, limit: 1000 })) {
      if (failedAccounts.has(row.account_id)) continue;

      /* THE ONE PLACE A SHORT WALK IS ALLOWED TO CHANGE THE ANSWER, so it is
         refused here. `invoiceStillOpen` is a claim about absence, and on a
         truncated walk absence means "not read" rather than "not open". */
      const invoiceEvidenceIsSound = !invoiceWalkShort.has(row.account_id);
      if (row.kind === "payment_failed" && !invoiceEvidenceIsSound) continue;

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
        continue;
      }

      /*
        THE CASE THAT STOPPED BEING DERIVED AND MATCHES NO RULE.

        `resolutionFor` answers "has Stripe fixed this", which is a different
        question from "does Stripe still report this at all". A trial whose
        `trial_end` moved outside the warning window, a cancellation
        un-scheduled while the subscription is still `trialing` (the churn
        rule requires `active`), an ended subscription that aged past the
        thirty-day window — none of them matches a rule, and without this they
        stay open forever with a deadline that has stopped meaning anything.

        It only fires for an account whose queue was actually DERIVED this
        pass, and never on a truncated invoice walk, because both of those are
        "nobody looked" wearing the same shape as "it is gone".
      */
      if (!derivedFor.has(row.account_id)) continue;
      if (!invoiceEvidenceIsSound) continue;
      if (!liveIds.has(row.id)) {
        setCaseStatus(
          row.id,
          "resolved",
          "This no longer matches anything Stripe reports: the condition that opened it — a scheduled cancellation, an open invoice, a trial inside the warning window, a live dispute — is not there on this pass. Nothing was recovered and nothing was lost; the case simply stopped being one.",
        );
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
      `${out.resolved} resolved${out.relinked ? `, ${out.relinked} re-linked` : ""} · ` +
      `${out.delivered} delivered, ${out.deferred} deferred, ` +
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
 * THE PROMISE `sent` MAKES, KEPT HERE.
 *
 * Migration 251 says "sent is set when that outbox row leaves", `counts.sent`
 * publishes it and `LIVE_STATUSES` includes it — and until this function
 * existed nothing in the repo ever wrote it. A status a schema promises and no
 * code produces is worse than an absent one, because every reader plans around
 * a transition that cannot happen.
 *
 * IT IS A READ OF THE OUTBOX RATHER THAN A HOOK INSIDE IT. `mailflow/outbox.ts`
 * exists to guarantee that `sendApproved` is the only door out, and its header
 * counts the callers of `sendMessage` as the proof; adding a callback into that
 * function would mean this area's bug could throw inside somebody's send. So
 * the queue reconciles on its own pass instead: it asks what happened to the
 * row it is pointing at and writes down the answer.
 *
 * THREE OUTCOMES, and the third is the one the review found. A row that was
 * SENT moves the case to `sent`. A row that no longer exists — the owner
 * deleted the draft — un-links the case and puts it back to `open`, so
 * `prepare` can write a new one; without this the case would point forever at
 * a row that is not there and refuse every future draft with a 409 naming it.
 * A row that is dismissed does the same, because a dismissal is the owner
 * saying "not this message", not "not this case" (the outbox's own per-address
 * floor is what stops a second draft going to the same person too soon, and it
 * counts dismissed rows).
 */
function reconcileDrafts(): number {
  const linked = db
    .prepare(
      "SELECT id, outbox_id, status FROM customer_cases WHERE outbox_id IS NOT NULL AND status IN ('drafted','sent')",
    )
    .all() as unknown as { id: string; outbox_id: number; status: string }[];
  if (!linked.length) return 0;

  let changed = 0;
  for (const row of linked) {
    const draft = db
      .prepare("SELECT status FROM mailflow_outbox WHERE id = ?")
      .get(row.outbox_id) as { status: string } | undefined;

    if (!draft || draft.status === "dismissed") {
      db.prepare(
        "UPDATE customer_cases SET outbox_id = NULL, status = 'open', updated_at = ? WHERE id = ?",
      ).run(now(), row.id);
      changed += 1;
      continue;
    }
    if (draft.status === "sent" && row.status !== "sent") {
      db.prepare("UPDATE customer_cases SET status = 'sent', updated_at = ? WHERE id = ?").run(
        now(),
        row.id,
      );
      changed += 1;
    }
  }
  return changed;
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
         shorten a list somebody is working through. It simply has no
         address. */
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
  /** The outbound call; a test passes its own. */
  send: (text: string) => Promise<{ sent: boolean; reason?: string }> = push,
): Promise<{ delivered: number; deferred: number; suppressed: number }> {
  const pending = pendingEvents(200);
  if (!pending.length) return { delivered: 0, deferred: 0, suppressed: 0 };

  let suppressed = 0;
  let deferred = 0;
  let delivered = 0;

  /*
    COLLAPSE FIRST, so a reconciliation or a deferral is never spent on an
    event that was going to be folded away anyway.

    THE WINDOW IS SEEDED WITH WHAT WAS ALREADY DELIVERED, and without that
    seed the sixty minutes the README and the `events` skill both promise are
    really "sixty minutes, or until the end of this pass, whichever comes
    first". A failure delivered at 09:00 leaves the pending set the moment it
    is marked; the retry at 09:40 then arrives in an empty set, opens its own
    window and produces a second message for the same dying card — a known
    failure mode this seed exists to avoid.
  */
  const { collapsed, standsFor } = collapseFailures(
    pending.map((e) => ({ id: e.id, type: e.type, at: e.at, customer: e.customer })),
    COLLAPSE_MINUTES,
    deliveredFailuresSince(COLLAPSE_MINUTES),
  );
  for (const [id, into] of collapsed) {
    suppress(id, `collapsed into ${into}`);
    suppressed += 1;
  }

  if (!s.telegram) {
    /*
      PUSHING IS OFF, AND THE ROWS SAY SO RATHER THAN QUEUEING.

      Leaving them `pending` forever would look harmless and be a loaded gun:
      the day the setting is switched on, the pass would start working
      through every event since the integration was installed, at ten
      messages a pass. An event that arrived while the owner had notifications
      off was never going to be a notification, so it is written down as
      suppressed now, when that is true, rather than becoming a message months
      later when it is not. Turning the setting on tells you about what
      happens NEXT, which is what turning it on means.
    */
    for (const e of pending) {
      if (collapsed.has(e.id)) continue;
      suppress(e.id, "pushing to Telegram is off");
      suppressed += 1;
    }
    return { delivered: 0, deferred: 0, suppressed };
  }

  const trips = recentRevenueTrips();
  const at = new Date();
  const nowMs = at.getTime();
  const ready: BusinessEventRecord[] = [];

  for (const e of pending) {
    if (collapsed.has(e.id)) continue;
    if (e.attempts >= MAX_DELIVERY_ATTEMPTS) continue;

    /* THE AGE FENCE, measured from when this row became eligible rather than
       from the event's own timestamp — see MAX_EVENT_AGE_HOURS. */
    const eligibleFrom = Date.parse(e.deferred_until ?? e.at);
    if (
      Number.isFinite(eligibleFrom) &&
      nowMs - eligibleFrom > MAX_EVENT_AGE_HOURS * 3_600_000
    ) {
      suppress(
        e.id,
        `older than the ${MAX_EVENT_AGE_HOURS}h delivery window — it is in the feed but was not worth a message this long after the fact`,
      );
      suppressed += 1;
      continue;
    }

    const cover = coveredBy(e.at, trips);
    if (cover) {
      suppress(e.id, cover);
      suppressed += 1;
      continue;
    }

    /* THE REST OF A SALE ALREADY TOLD. Stripe's three events for one new
       subscriber nearly always arrive in one walk and are grouped below; when
       a walk boundary splits them, the late one is part of a message that has
       already gone, and a second "new sale" for the same person is the
       duplicate this table exists to prevent. */
    const told = SALE_TYPES.has(e.type) ? saleAlreadyTold(e) : null;
    if (told) {
      suppress(e.id, `told with the sale in ${told}`);
      suppressed += 1;
      continue;
    }

    const until = quietDeferral(at, s.timezone, s.quiet);
    if (until) {
      defer(e.id, until);
      deferred += 1;
      continue;
    }
    ready.push(e);
  }
  if (!ready.length) return { delivered, deferred, suppressed };

  /*
    ONE SALE, ONE MESSAGE; MANY AT ONCE, ONE MESSAGE.

    groupSales folds checkout + first invoice + new subscription for the same
    customer into one notice, and each notice's rows share one send: they are
    all marked delivered when it goes and all marked failed when it does not,
    so a retry sends the whole notice again rather than a fragment. Past
    SINGLE_MAX notices in one pass, the lot is one digest — the rule the alert
    and run pushes keep (proactive/pushes.ts), for the same reason.
  */
  const lu = dbLookup();
  const groups = groupSales(ready).map((rows) => ({ rows, standsFor: standsFor.get(rows[0]!.id) ?? 1 }));
  const settle = (rows: BusinessEventRecord[], result: { sent: boolean; reason?: string }) => {
    for (const r of rows) {
      if (result.sent) markDelivered(r.id);
      else markDeliveryFailed(r.id, result.reason ?? "Telegram did not accept the message.");
    }
    if (result.sent) delivered += rows.length;
  };
  if (groups.length > SINGLE_MAX) {
    const all = groups.flatMap((g) => g.rows);
    settle(all, await safePush(send, digestText(groups, lu, s.timezone, at)));
    return { delivered, deferred, suppressed };
  }
  let sent = 0;
  for (const g of groups) {
    if (sent >= MAX_SENDS_PER_PASS) break;
    sent += 1;
    settle(g.rows, await safePush(send, noticeText(g.rows, lu, s.timezone, g.standsFor, at)));
  }

  return { delivered, deferred, suppressed };
}

/**
 * Failed-payment events already DELIVERED inside the collapse window.
 *
 * They are what makes the sixty minutes a property of the feed rather than of
 * one pass. They seed the collapse as window-openers and can never themselves
 * be collapsed — the message they stand for has already gone.
 */
function deliveredFailuresSince(minutes: number): Collapsible[] {
  const cut = new Date(Date.now() - minutes * 60_000).toISOString();
  return (
    db
      .prepare(
        `SELECT id, type, at, customer FROM business_events
          WHERE type = 'invoice.payment_failed' AND delivered_at IS NOT NULL AND at >= ?
          ORDER BY at ASC`,
      )
      .all(cut) as unknown as { id: string; type: string; at: string; customer: string | null }[]
  ).map((r) => ({ ...r, delivered: true }));
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

/** A push that throws is a push that failed: the rows record why and the
 *  next pass retries, instead of the pass dying half-way through a notice. */
async function safePush(
  send: (text: string) => Promise<{ sent: boolean; reason?: string }>,
  text: string,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    return await send(text);
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The delivered sale-type row this one belongs with, if any — same customer
 *  or same subscription, inside the sale window. A sale that already told an
 *  event of THIS type is a different purchase (a customer buying twice), and
 *  this one is news of its own. */
function saleAlreadyTold(e: BusinessEventRecord): string | null {
  if (!e.customer && !e.subscription) return null;
  const t = Date.parse(e.at);
  const window = [
    new Date(t - SALE_WINDOW_MINUTES * 60_000).toISOString(),
    new Date(t + SALE_WINDOW_MINUTES * 60_000).toISOString(),
  ];
  const sameType = db
    .prepare(
      `SELECT 1 FROM business_events
        WHERE delivered_at IS NOT NULL AND id <> ? AND type = ?
          AND ((customer IS NOT NULL AND customer = ?) OR (subscription IS NOT NULL AND subscription = ?))
          AND at BETWEEN ? AND ? LIMIT 1`,
    )
    .get(e.id, e.type, e.customer ?? "", e.subscription ?? "", window[0]!, window[1]!);
  if (sameType) return null;
  const row = db
    .prepare(
      `SELECT id FROM business_events
        WHERE delivered_at IS NOT NULL AND id <> ?
          AND type IN ('checkout.session.completed', 'invoice.paid', 'customer.subscription.created')
          AND type <> ?
          AND ((customer IS NOT NULL AND customer = ?) OR (subscription IS NOT NULL AND subscription = ?)
               OR (type = 'customer.subscription.created' AND object_id = ?))
          AND at BETWEEN ? AND ?
        ORDER BY at LIMIT 1`,
    )
    .get(
      e.id,
      e.type,
      e.customer ?? "",
      e.subscription ?? "",
      e.subscription ?? "",
      window[0]!,
      window[1]!,
    ) as { id: string } | undefined;
  return row?.id ?? null;
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

/**
 * Minutes since the last pass that FINISHED, or null if there has never been
 * one. Read from the run ledger rather than kept in memory, because the thing
 * this guards against is process restarts.
 */
function minutesSinceLastPass(): number | null {
  const r = db
    .prepare(
      "SELECT finished_at FROM runs WHERE plugin_id = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    )
    .get(PLUGIN) as { finished_at: string } | undefined;
  if (!r) return null;
  const at = Date.parse(r.finished_at);
  return Number.isFinite(at) ? (Date.now() - at) / 60_000 : null;
}

export function startCustomersTimer() {
  const tick = () => {
    void runPass().catch(() => {
      /* runPass already writes its own failure to the run ledger. A throw
         escaping here would take the timer with it. */
    });
  };
  /*
    A MINUTE AFTER BOOT, BUT ONLY IF A PASS IS ACTUALLY DUE.
    
    A minute rather than immediately because the Stripe collector may still be
    filling the subscription book this pass derives cases from, and a queue
    built from an empty table is a queue that resolves everything.

    The recency check is the other half, and it is about the development
    machine rather than the server: this app runs under `node --watch`, so
    every file any agent saves restarts the process, and an unguarded boot
    tick turned that into a full Stripe pass — a dispute walk, an invoice
    walk, an event walk and up to forty customer GETs — five times in nine
    minutes. The clock is the run ledger, so it survives the restart that
    caused the problem.
  */
  setTimeout(() => {
    const since = minutesSinceLastPass();
    if (since !== null && since < PASS_MINUTES) return;
    tick();
  }, 60_000).unref?.();
  setInterval(tick, PASS_MINUTES * 60_000).unref?.();
}

