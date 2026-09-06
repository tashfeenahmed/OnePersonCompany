/**
 * The customers area's three skill entries.
 *
 * TWO OF THEM WRITE AND THAT IS THE POINT OF THE AREA. `recovery` can prepare
 * a draft, resolve a case and dismiss one; `events` can mute a type and
 * requeue a message. None of them can send anything: `prepare` writes a row
 * into the outbox with status `draft`, and the outbox publishes no approve and
 * no send action to any skill, so there is no request the proxy will accept
 * that puts mail on the wire. That is a property of which entries exist rather
 * than a rule a model has to remember.
 *
 * THE RULES BELOW ARE THE PRODUCT. Two of them are the reason this area was
 * built rather than a chart: an agent that quotes a dispute count without
 * saying whether it counted CASES or LEDGER DEBITS has produced a figure a
 * risk reviewer will act on, and an agent that tells a customer they will be
 * refunded has made a promise the business has to keep.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "recovery",
    title: "Recovery queue — customers who are about to leave, or already have",
    plugins: ["stripe"],
    about:
      "One row per thing that can still be acted on, sorted by DEADLINE rather " +
      "than by value: a cancellation scheduled at the end of a period, an " +
      "invoice open after a failed attempt, a trial about to end, and an open " +
      "dispute. Each case carries the customer's Stripe object, the amount and " +
      "currency, the exact date something runs out, and a `context` object of " +
      "the facts that were read. Cases are re-derived from Stripe on every " +
      "pass and close by themselves when Stripe shows them fixed.",
    rules: [
      "A DEADLINE IS NOT A PREDICTION. `deadline` on a payment_failed case is " +
        "when STRIPE will retry the card; on a churn case it is when the paid " +
        "period ends; on a dispute it is the bank's evidence cut-off. Quote " +
        "`deadlineIs`, which says which of those it is, and never turn one into " +
        "a claim about what the customer will do.",
      "A CHURN CASE WITH `state: \"cancellation scheduled\"` IS STILL BILLING and " +
        "is still counted in MRR. It has not churned; it will on the deadline. " +
        "Saying revenue has been lost is wrong until the date passes.",
      "NEVER SAY A CUSTOMER WILL BE CHARGED, REFUNDED, DISCOUNTED OR HAD " +
        "ANYTHING DONE TO THEIR ACCOUNT unless a field of the case says so. " +
        "This integration is GET-only by construction: nothing here can refund, " +
        "retry, cancel or re-price anything at Stripe, so any sentence " +
        "promising one of those is a promise about an action that did not happen.",
      "ADDRESSES ARE HIDDEN UNLESS CONTACT ACCESS IS ON. `contact.address` is " +
        "null while the `customers.contact-access` setting is off, and what is " +
        "stored is a salted hash and a domain. Do not ask for an address, do " +
        "not infer one from a domain, and do not suggest turning the setting on " +
        "unless you were asked how to write to somebody.",
      "PREPARE WRITES A DRAFT AND NOTHING LEAVES. It composes from the case's " +
        "own fields into the Outbox with status `draft`; the owner approves and " +
        "sends it there. There is no send action on this skill or on the outbox " +
        "one. Say “written into the Outbox as a draft”, never “sent”.",
      "A TRIAL FIGURE IS NOT REVENUE. `amount` on a trial_ending case is what " +
        "the plan WOULD bill. It has never sent a cent and is in no MRR figure " +
        "on this box.",
      "`everCollectedCents: null` on an ended subscription means the invoice " +
        "lookup has not reached it, not that it collected nothing. A cancelled " +
        "free trial and a three-year customer look identical without it.",
      "A DISMISSED CASE STAYS DISMISSED. The pass never re-opens one. Do not " +
        "offer to re-open it; offer to look at whether a new case has opened.",
      "The queue is only as complete as its last pass. `lastPass` says when the " +
        "inputs were read and whether that run failed; quote it before calling a " +
        "short list quiet.",
    ],
    views: [
      {
        key: "queue",
        path: "/api/recovery",
        about:
          "The queue, soonest deadline first, with counts by kind and how many are overdue or undated.",
        params: [
          {
            name: "status",
            type: "string",
            required: false,
            fallback: "open,drafted,sent",
            about:
              "Comma-separated: open, drafted, sent, resolved, dismissed — or `all`. Default is the three live ones.",
          },
          {
            name: "kind",
            type: "string",
            required: false,
            about: "Comma-separated: churn, payment_failed, dispute, trial_ending. Default all.",
          },
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture slug or id. Cases that could not be attributed have none and are excluded by this filter.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 100,
            about: "Rows returned. Clamped to 1–500.",
          },
        ],
      },
      {
        key: "case",
        path: "/api/recovery/:id",
        about:
          "One case with its full context, and a PREVIEW of the follow-up prepare would write — without writing it.",
        params: [
          {
            name: "id",
            type: "string",
            required: true,
            in: "path",
            about: "The case id, which is `<kind>:<stripe object id>` — e.g. `churn:sub_1abc`.",
            exampled: true,
          },
        ],
      },
    ],
    actions: [
      {
        key: "prepare_draft",
        method: "POST",
        path: "/api/recovery/:id/prepare",
        about:
          "Compose a factual follow-up from the case's own fields and write it into the Outbox as a DRAFT. It is not sent and cannot be sent from here. Refused when contact access is off, when no address has been read, when the outbox's per-address floor blocks it, and for dispute cases.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The case id.", exampled: true },
        ],
      },
      {
        key: "resolve",
        method: "POST",
        path: "/api/recovery/:id/resolve",
        about:
          "Close a case as handled, with an optional note. Changes nothing at Stripe — it is a note about this queue.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The case id.", exampled: true },
          { name: "note", type: "string", required: false, about: "Why it is closed. Up to 400 characters." },
        ],
      },
      {
        key: "dismiss",
        method: "POST",
        path: "/api/recovery/:id/dismiss",
        about:
          "Take a case off the queue for good. The pass never re-opens a dismissed case, which is why this is irreversible from here.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The case id.", exampled: true },
          { name: "note", type: "string", required: false, about: "Why. Up to 400 characters." },
        ],
        destructive: true,
      },
    ],
    asks: [
      "What needs answering this week before a deadline passes?",
      "Which cancellations are scheduled, and what were they paying?",
    ],
  },

  {
    id: "disputes",
    title: "Disputes — the cases, their outcomes, and the deadlines",
    plugins: ["stripe"],
    about:
      "Chargebacks as CASES rather than as ledger debits: one row per dispute " +
      "with Stripe's own status, the reason, the disputed amount, the evidence " +
      "cut-off, and won/lost once it closes. Counts by outcome and by status, " +
      "per currency, over a window in days (default 90). The ledger's dispute " +
      "money is published beside the case figures as a cross-check.",
    rules: [
      "SAY WHICH MEASUREMENT YOU USED. `cases.*` counts DISPUTES, dated by when " +
        "the bank opened them, excluding Stripe's dispute fee. `ledger.*` is " +
        "money that MOVED, dated by the balance posting, including the fee. The " +
        "two are published side by side with a `difference` that is expected to " +
        "be non-zero, and they are never added.",
      "`openNow` IS CURRENT STATE AND HAS NO WINDOW. A dispute opened four " +
        "months ago and still under review is open today. Do not describe it as " +
        "a figure for the last N days — the windowed figures are `opened`, `won` " +
        "and `lost`.",
      "`outcome: null` IS NOT A WIN. It is a live case, or one Stripe closed " +
        "with no verdict — `warning_closed` is the bank withdrawing before it " +
        "became a formal dispute. Report it as undecided.",
      "THE EVIDENCE DEADLINE IS THE ONE DATE HERE THAT LOSES MONEY BY DEFAULT. " +
        "It is published as an ISO instant in UTC (`evidenceDueBy`) and as the " +
        "same moment in the owner's zone (`evidenceDueLocal`). Quote both, or " +
        "quote the local one and name the zone; “23:59 UTC” and “00:59 " +
        "tomorrow” are the same moment and only one of them sounds urgent.",
      "THERE IS NO DISPUTE RATE AND THERE WILL NOT BE ONE. Stripe measures " +
        "disputes against successful transactions LIFETIME; this box has a " +
        "charge-day table that starts wherever the backfill got to. A ratio " +
        "computed from these rows would be roughly the right order and entirely " +
        "the wrong denominator — and it is the number a risk reviewer is quoted.",
      "`coverage.stored: 0` means nothing was ingested, which is either an " +
        "account with no disputes or a key without permission to read them. The " +
        "Customers integration's last run says which. It is not a zero.",
      "`venture` is null on most disputes and that is structural: a dispute " +
        "names a CHARGE and a charge carries no product, so it is filled only " +
        "where every Stripe link on this box points at one business.",
      "Nothing here can submit evidence. That happens in the Stripe dashboard, " +
        "before the deadline above.",
    ],
    views: [
      {
        key: "cases",
        path: "/api/disputes",
        about:
          "Per currency: cases opened, won and lost in the window, what is open now, the next evidence deadline, and the ledger's money-out beside them. Plus every open case and the recent ones.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 90,
            about:
              "The window for opened/won/lost and for the ledger comparison. Clamped to 1–400. `openNow` ignores it.",
          },
        ],
      },
    ],
    asks: [
      "How many disputes are open and when is the next evidence deadline?",
      "How many did we win and lose over the last quarter?",
    ],
  },

  {
    id: "events",
    title: "Business events — what Stripe said happened, and whether it was delivered",
    plugins: ["stripe"],
    about:
      "A cursor over Stripe's own event feed for eight types — subscriptions " +
      "created, updated and deleted, invoices paid and failed, disputes opened " +
      "and closed, and completed checkouts — with one row per event id, a " +
      "factual one-line summary assembled from the payload, the venture where " +
      "it can be established, and the full delivery state: delivered, deferred " +
      "by quiet hours, suppressed and why, or attempted and failed.",
    rules: [
      "`suppressed` IS NOT `failed`. Four different things stop a message and " +
        "`suppressedBy` names which: “first collection” (backlog from before " +
        "the cursor existed), “collapsed into <id>” (one of several failures " +
        "for the same customer within the hour), “alert N (<rule>)” (an " +
        "aggregate alert already covered this class in the same window), and " +
        "“type muted”. None of them is an error. A row with `attempts > 0` and " +
        "an `error` is the one that actually failed.",
      "AN EVENT IS A NOTIFICATION, NOT SETTLEMENT. `invoice.paid` means Stripe " +
        "sent an event; the ledger is the only place on this box where money is " +
        "measured. Never total the amounts on these rows into revenue.",
      "`deliveredAt` MEANS TELEGRAM ACCEPTED THE MESSAGE. It is not proof " +
        "anybody read it.",
      "THE SUMMARIES ARE ASSEMBLED, NOT WRITTEN. Each is built from fields that " +
        "were in the payload. Quote one as it stands; do not embellish it with " +
        "a reason the payload did not carry.",
      "Events older than the first collection were never seen and cannot be " +
        "recovered — Stripe keeps events for thirty days and the first walk " +
        "reaches back one day on purpose.",
      "Muting a type stops the MESSAGE, not the ingestion. The events keep " +
        "arriving in this document.",
      "A `customer.subscription.updated` with `suppressedBy` naming nothing a " +
        "person acts on is Stripe emitting an update for a metadata change. It " +
        "is recorded and is not news.",
    ],
    views: [
      {
        key: "recent",
        path: "/api/business-events",
        about:
          "Events over a window in days, newest first, with counts by type and by delivery state, and the current settings (quiet hours, muted types, collapse and reconcile windows).",
        params: [
          { name: "days", type: "number", required: false, fallback: 7, about: "Window in days. Clamped to 1–90." },
          { name: "limit", type: "number", required: false, fallback: 100, about: "Rows returned. Clamped to 1–500." },
          { name: "type", type: "string", required: false, about: "One Stripe event type, to filter the rows (the counts still cover the whole window)." },
        ],
      },
      {
        key: "undelivered",
        path: "/api/business-events/undelivered",
        about:
          "Everything over thirty days that is neither delivered nor suppressed: deferred by quiet hours, failed, or out of attempts.",
        params: [],
      },
    ],
    actions: [
      {
        key: "mute_type",
        method: "POST",
        path: "/api/business-events/mute",
        about:
          "Stop one event type producing messages, including anything of that type still waiting. Ingestion continues. Reversible with unmute_type.",
        params: [
          {
            name: "type",
            type: "string",
            required: true,
            about:
              "A watched Stripe event type, e.g. `invoice.payment_failed`. The route lists the watched set if it does not recognise one.",
            exampled: true,
          },
        ],
      },
      {
        key: "unmute_type",
        method: "POST",
        path: "/api/business-events/unmute",
        about: "Let a muted type produce messages again. Events already suppressed stay suppressed.",
        params: [{ name: "type", type: "string", required: true, about: "The event type to unmute.", exampled: true }],
      },
      {
        key: "resend",
        method: "POST",
        path: "/api/business-events/:id/resend",
        about:
          "Queue one event for the next delivery pass. The attempts count is not reset, and quiet hours, the age fence and the collapse rule all still apply.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "Stripe's event id, `evt_…`.", exampled: true },
        ],
        /* THE ONE ACTION IN THIS AREA THAT PUTS SOMETHING OUTSIDE THIS BOX.
           `requeue` hands the row to the next delivery pass, which calls
           `notify` — and a Telegram message cannot be unsent. The blast
           radius is small (the destination is the owner's own locked chat)
           but the field is a claim a client is entitled to trust, and "it
           only messages the owner" is not the same as "it can be undone". */
        destructive: true,
      },
    ],
    asks: [
      "Did anything happen on Stripe overnight that I was not told about?",
      "What is sitting undelivered?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  recovery: { name: "recovery-queue", category: "finance" },
  disputes: { name: "dispute-cases", category: "finance" },
  events: { name: "business-events", category: "finance" },
};
