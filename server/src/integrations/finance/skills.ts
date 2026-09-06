/**
 * The finance area's two skill entries, and they are two rather than one for
 * the reason /api/gsc and /api/bing are two: they answer different questions
 * and nothing may add them.
 *
 * `ledger` is what the operation OWES — a rate card the owner maintains,
 * seeded from what this box measures. Its writes are the point: an agent asked
 * "add the accountant, €150 a month" should be able to do it, and an agent
 * asked "what should I cancel" should be able to record the answer.
 *
 * `profit` is what each business KEEPS. It has no actions at all and will not
 * get any: every number in it is computed from tables somebody else owns, and
 * the only way to change a margin is to change a cost or earn some money.
 *
 * THE RULES ON BOTH ARE THE PRODUCT. A profit figure is the single easiest
 * number on this dashboard to get confidently wrong — by adding euro to
 * dollars, by treating a run rate as a receipt, by reading a part-month as a
 * month, or by quoting an allocated share of a shared server as a measurement
 * of what a venture used. Each of those has a rule below.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "ledger",
    title: "Operating cost ledger — what the operation owes, and what renews",
    /* Always live. The ledger is the owner's own rate card: it holds rows that
       no credential produced, and it must answer on a box with nothing
       connected at all — that is the state in which somebody first types their
       costs in. */
    plugins: [],
    about:
      "Every recurring cost of the operation in one table: servers and volumes seeded from Hetzner, domain " +
      "renewals seeded from the registrars, electricity priced from typed-in wattage and observed uptime, and " +
      "anything else the owner adds by hand — services, subscriptions, salaries. Each row has an amount in ONE " +
      "currency, a period (monthly, yearly or once), an optional venture (absent means shared), a renewal date " +
      "where the source has one, and a renewal decision. Monthly and annual totals are computed on every read, " +
      "per currency.",
    rules: [
      "MONEY IS NEVER ADDED ACROSS CURRENCIES. Every total is a list keyed by currency code — Hetzner is EUR net " +
        "of VAT, most else is USD — and `combined` is null on all of them. A converted figure exists only at " +
        "/api/finance/converted, only when the owner has typed a display currency AND a rate for every currency " +
        "present, and it is `approximate: true` with the rate and its date attached. Never compute one yourself.",
      "`amount: null` IS A COST WITH NO KNOWN PRICE, never a free one. Twenty-three domain renewals seed this way " +
        "because neither registrar's API publishes a renewal price. Those rows are excluded from every total and " +
        "counted in `unpriced`; a total with `unpriced > 0` is a FLOOR on what the operation costs.",
      "A yearly bill contributes a twelfth to `monthly` and its exact price to `annual`. A ONE-OFF contributes " +
        "NOTHING to either — it is listed with its amount and never amortised, because a fee paid once is not a " +
        "run rate.",
      "`source` other than `manual` means the row is refreshed from a provider on every collection. Columns listed " +
        "in `ownerFields` are ones the owner corrected by hand and a refresh never touches them. A row whose " +
        "server or domain has gone is ARCHIVED, not deleted — it is out of the totals and still on record, which " +
        "is why a closed month's margin does not change.",
      "`renewalDecision` is what the OWNER decided, not what the provider will do. A domain marked `cancel` with " +
        "auto-renew on at the registrar will still be charged. Say both when you report one.",
      "A shared row (`ventureId: null`) is not free and belongs to nobody until an allocation rule says otherwise. " +
        "`unallocated` is real money no venture's margin is carrying.",
      "Electricity rows carry `confidence`: `metered` means the HOURS were observed from workstation samples, " +
        "`estimated` means they were modelled from an always-on assumption. The WATTAGE is typed in either way — " +
        "nothing on this box can read a wall socket — so no electricity figure is a measurement of money.",
    ],
    views: [
      {
        key: "default",
        path: "/api/finance",
        about: "Counts, the monthly and annual run rate per currency, renewals due, and how much shared cost is unallocated.",
        params: [],
      },
      {
        key: "expenses",
        path: "/api/finance/expenses",
        about: "Every row of the ledger with its allocations, filtered optionally by venture or category.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture id, slug or name — or the literal “shared” for the rows that belong to no venture." },
          { name: "category", type: "string", required: false, about: "server, domain, service, subscription, salary or other." },
          { name: "archived", type: "string", required: false, fallback: "false", about: "“true” to include rows whose server or domain has gone." },
        ],
      },
      {
        key: "renewals",
        path: "/api/finance/renewals",
        about: "What renews soonest, with the days left, the decision recorded and whether a price is known.",
        params: [
          { name: "days", type: "number", required: false, fallback: 90, about: "How far ahead to look. Clamped to 1–730. Renewals already past are always included, with a negative `inDays`." },
        ],
      },
      {
        key: "unallocated",
        path: "/api/finance/unallocated",
        about: "Shared costs with no allocation rule — the money no venture's margin is carrying.",
        params: [],
      },
      {
        key: "power",
        path: "/api/finance/power",
        about: "The machine power profiles, the electricity they came to for a month, and how much of the month was actually sampled.",
        params: [
          { name: "month", type: "string", required: false, about: "YYYY-MM. Defaults to the month in progress, which is a part-month." },
        ],
      },
    ],
    actions: [
      {
        key: "add_expense",
        method: "POST",
        path: "/api/finance/expenses",
        about:
          "Add a recurring cost the owner told you about. Give it ONE currency and its real period; leave " +
          "`amount` out entirely if the price is not known rather than guessing one.",
        params: [
          { name: "label", type: "string", required: true, about: "What the bill is for, as it would appear on a statement." },
          { name: "category", type: "string", required: true, about: "server, domain, service, subscription, salary or other." },
          { name: "currency", type: "string", required: true, about: "Three letters — EUR, USD. Never mix two in one row." },
          { name: "period", type: "string", required: true, about: "monthly, yearly or once. A one-off is never amortised into a run rate." },
          { name: "amount", type: "number", required: false, about: "The price at that period. Omit for a cost whose price nobody has established; do not invent one." },
          { name: "ventureId", type: "string", required: false, about: "The venture's id, when the cost is wholly one venture's. Omit for a shared cost — that is the default and it is not a failure state." },
          { name: "renewalOn", type: "string", required: false, about: "YYYY-MM-DD, when it next renews." },
          { name: "notes", type: "string", required: false, about: "Where the figure came from, in a sentence." },
        ],
      },
      {
        key: "update_expense",
        method: "PATCH",
        path: "/api/finance/expenses/:id",
        about:
          "Correct a row. On a seeded row this is how a price the provider does not publish gets in — the columns " +
          "you set join `ownerFields` and no refresh will ever overwrite them again.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The expense id." },
          { name: "amount", type: "number", required: false, about: "The price at the row's period." },
          { name: "currency", type: "string", required: false, about: "Three letters." },
          { name: "period", type: "string", required: false, about: "monthly, yearly or once." },
          { name: "label", type: "string", required: false, about: "A better name for the bill." },
          { name: "ventureId", type: "string", required: false, about: "Move it to a venture, or send null to make it shared." },
          { name: "renewalOn", type: "string", required: false, about: "YYYY-MM-DD." },
          { name: "notes", type: "string", required: false, about: "Free text." },
        ],
      },
      {
        key: "set_renewal",
        method: "POST",
        path: "/api/finance/expenses/:id/renewal",
        about:
          "Record what the owner decided about the next renewal. It records a DECISION and cancels nothing: say so " +
          "when you confirm it, and say whether auto-renew is on at the provider.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The expense id." },
          { name: "decision", type: "string", required: true, about: "keep, cancel or undecided." },
        ],
      },
      {
        key: "refresh",
        method: "POST",
        path: "/api/finance/refresh",
        about:
          "Re-seed the ledger from Hetzner, the registrars and the power profiles now. Adds, refreshes and " +
          "archives; it cannot touch a manual row or a column the owner corrected.",
        params: [],
      },
    ],
    asks: [
      "What does the whole operation cost me a month, and what is not priced yet?",
      "What renews in the next 60 days that I have not decided about?",
      "How much shared cost is sitting on no business's books?",
    ],
  },

  {
    id: "profit",
    title: "Venture profit and loss — revenue, costs and margin, per month",
    plugins: [],
    about:
      "One month of one venture, or the whole portfolio: measured revenue by source and currency, direct costs, " +
      "its share of shared costs, the model spend of its own agent runs, and the margin that leaves. A closed " +
      "month carries `actual: true`; the month in progress carries the measured part AND a projection with the " +
      "method named on it.",
    rules: [
      "NEVER ADD CURRENCIES. `margin` is a list with one row per currency and each row is its own arithmetic. A " +
        "venture earning in USD and paying for a server in EUR has two margins, and reporting one number for it " +
        "would be inventing an exchange rate.",
      "ACTUAL VERSUS PROJECTED IS THE FIRST THING TO SAY. `actual: false` means the month has not finished and " +
        "every measured figure is a part-month; `projected` scales revenue and model spend by the daily average " +
        "of the measured part. COSTS ARE NOT PROJECTED — a monthly bill is owed in full whatever the date — so " +
        "never present a projected margin as if the cost side were also scaled.",
      "`subscriptionRunRate` IS NOT REVENUE. It is live MRR for the venture's linked Stripe products: a run rate " +
        "this app normalises from today's subscription book, not money that arrived in that month. It is never " +
        "added to `revenue.net`.",
      "STRIPE'S SETTLED MONEY IS A PORTFOLIO FIGURE. `stripe_ledger_days` has no product dimension, so a " +
        "per-venture settled figure does not exist unless the owner switches on the mrr-share split — and where " +
        "they have, every such line is `estimated: true` with the share it was computed from. `revenue.unavailable` " +
        "says which sources could not answer and why; quote it rather than reporting a small revenue as the truth.",
      "ALLOCATED COSTS ARE ESTIMATES. A line with `direct: false` is a share of a real bill decided by a rule the " +
        "owner picked — equal, manual, revenue or traffic — and not a measurement of what this venture used. Its " +
        "`basis` and `share` are on the line; say them.",
      "`costs.complete: false` MEANS THE MARGIN IS A CEILING. Some cost this venture carries has no price yet; " +
        "`costs.unpriced` names them. Report the margin as “at best” in that case.",
      "MODEL SPEND IS THE PROVIDER'S INVOICE, APPORTIONED. `modelSpend.usd` is the model dollars the providers " +
        "actually billed for the month, split across ventures by their share of metered tokens — an allocation, " +
        "flagged `basis: \"invoice-token-share\"` and `estimated: true`, because no provider publishes spend per " +
        "venture. `usd: null` means no invoice covers the month. `modelSpend.reservationUsd` is the runtime's own " +
        "enforcement meter — what a budget RESERVED before each call at a flat price per million — and is never a " +
        "cost and never added to `usd`. The TOKEN count is measured either way. Per-provider, per-day spend is on " +
        "/api/costs.",
      "AdSense lines are matched to a venture by HOSTNAME, not by a stored link, and AdSense earnings are Google's " +
        "own estimate revised after the month closes. `basis: \"host\"` on a line is the flag for that.",
    ],
    views: [
      {
        key: "portfolio",
        path: "/api/finance/profit/portfolio",
        about: "Every venture's line for a month, plus the portfolio's measured Stripe settlement, the unallocated shared cost and the power lines.",
        params: [
          { name: "month", type: "string", required: false, about: "YYYY-MM. Defaults to the month in progress, which is a part-month." },
        ],
      },
      {
        key: "venture",
        path: "/api/finance/profit/:venture",
        about: "One venture's P&L for one month: revenue lines by source, cost lines direct and allocated, model spend, margin, projection.",
        params: [
          { name: "venture", type: "string", required: true, in: "path", about: "A venture id, slug, name or host." },
          { name: "month", type: "string", required: false, about: "YYYY-MM. Defaults to the month in progress." },
        ],
      },
    ],
    asks: [
      "Which of my ventures actually made money last month, after its share of the servers?",
      "What is Acme's margin this month so far, and what would it be at this rate?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  ledger: { name: "expense-ledger", category: "finance" },
  profit: { name: "venture-profit", category: "finance" },
};
