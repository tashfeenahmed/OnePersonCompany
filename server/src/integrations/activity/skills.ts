/**
 * The activity area's skill entries.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph, and its header says why that
 * must not happen.
 *
 * THREE ENTRIES, AND EACH ONE EXISTS BECAUSE ITS RULES ARE DIFFERENT. `users`
 * is a population and its trap is double counting a window. `activity` is a
 * timeline and its trap is quoting an invented moment. `leakage` is money and
 * its trap is a total that spans two units. One entry with nine rules would
 * have been an entry an agent skims.
 *
 * NONE OF THEM HAS AN ACTION. Everything here is a read of a document a
 * collector or a derivation already wrote; the one write in the area is the
 * feed's refresh button, which changes nothing an agent could not get by
 * waiting for the next pass.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "users",
    title: "Users — who signed up, per product, from the products themselves",
    plugins: ["users"],
    about:
      "The people using each product, read from a JSON endpoint the product " +
      "itself publishes — one account per product, the account's label being " +
      "the product's name. Two forms: a full list of users (id, created, plan, " +
      "paid, country) or, for a product that cannot list them, a counts-only " +
      "document with a total and one window of its own choosing. Addresses are " +
      "stored as a salted hash and only the mail domain is readable. Windows " +
      "are fixed at 7 and 30 days; the daily series window is `days`, " +
      "default 90.",
    rules: [
      "`total` FROM THE PRODUCT WINS over a count of the rows this box holds. " +
        "`rowsHeld` is a FLOOR — nothing here is ever deleted and no endpoint " +
        "promises to list everybody — so where `partialList` is true, quote the " +
        "total and say how many are listed.",
      "NEW COUNTS ARE PER WINDOW AND ARE NEVER SUMMED ACROSS WINDOWS. `new7d` " +
        "is contained inside `new30d`; adding them counts the first week twice. " +
        "They are two answers, not two addends.",
      "A COUNTS-ONLY PRODUCT HAS `new7d: null` AND `new30d: null`, because it " +
        "publishes no rows to bucket. That is not zero signups. Its own window " +
        "is in `newWindow` with the number of days it chose, and it must be " +
        "quoted in those words. `summary.windowsMissing` says how many products " +
        "are in this state, and the portfolio windows exclude them.",
      "HASHED ADDRESSES ARE NOT SEARCHABLE BY ADDRESS. There is no parameter on " +
        "any view here that takes an email, and `q` matches the product's own " +
        "id, the plan, the country and the mail DOMAIN only. Asking this skill " +
        "to find a person by their address is asking for a capability it does " +
        "not have.",
      "`paid` IS THREE-VALUED. `paidUnknown` counts rows whose product does not " +
        "publish the field at all. Those are not free users, and a conversion " +
        "rate computed over them is wrong by however many they are.",
      "`shape: null` and `reachable: null` mean the endpoint has never been " +
        "collected — not that it is down and not that it is empty. A failing " +
        "endpoint keeps its last good rows, dated, beside the reason.",
      "`problems` is the contract validator's own words about the last " +
        "document. A non-empty list with `reachable: true` means the document " +
        "was accepted and some ROWS were skipped; a non-empty list with " +
        "`reachable: false` means the whole document was refused and the " +
        "figures are the previous one's.",
    ],
    views: [
      {
        key: "default",
        path: "/api/users",
        about:
          "Per product: the shape of its contract, its own total, rows held, new in 7 and 30 days, paid/free/unknown, the daily series, and which venture it belongs to.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 90,
            about: "How much of the daily series to return. Clamped to 1–400. The 7- and 30-day counts are fixed and do not follow this.",
          },
        ],
      },
      {
        key: "product",
        path: "/api/users/:product",
        about:
          "One product's users, filtered and paged. `:product` is the account's label or its id. Refused with a 409 for a counts-only product, which has no list.",
        params: [
          {
            name: "product",
            type: "string",
            required: true,
            in: "path",
            about: "The product endpoint's label (“APP-1”) or its account id.",
            exampled: true,
          },
          {
            name: "q",
            type: "string",
            required: false,
            about: "Matches the product's own user id, the plan, the country and the mail DOMAIN. It cannot match an address.",
          },
          { name: "plan", type: "string", required: false, about: "Exact plan, as the product spells it. The values present are in `facets.plans`." },
          { name: "country", type: "string", required: false, about: "Exact country, as the product spells it." },
          { name: "paid", type: "string", required: false, about: "“true”, “false”, or “unknown” for rows whose product did not say." },
          { name: "days", type: "number", required: false, about: "Only users created in the last this many days. Clamped to 1–4000." },
          { name: "limit", type: "number", required: false, fallback: 100, about: "Rows per page. Clamped to 1–1000." },
          { name: "offset", type: "number", required: false, fallback: 0, about: "Rows to skip. `matching` is the size of the filtered set." },
        ],
      },
    ],
    asks: [
      "How many people signed up to each product this week?",
      "Which product's users are actually paying?",
    ],
  },

  {
    id: "activity",
    title: "Activity — what happened, and when, across everything",
    plugins: [],
    about:
      "One feed merged from six sources already being collected: signups from " +
      "the products' own endpoints, charges/declines/refunds/disputes from the " +
      "Stripe tables, agent runs that finished, board cards that reached Done, " +
      "pushes from GitHub, and alerts if another area has built them. Plus " +
      "per-day counts by kind over the same filter. The window is `days`, " +
      "default 14.",
    rules: [
      "HALF OF THESE TIMESTAMPS ARE COMPUTED FROM DAILY ROWS, AND THE FEED SAYS " +
        "WHICH. `exact: true` means the source published that moment — a " +
        "signup's own createdAt, a run's finished_at, a card's done_at, " +
        "GitHub's pushed_at. `exact: false` means the source publishes a UTC " +
        "DAY and the timestamp is the start of it: never quote a time of day " +
        "for one, say the day. `coverage.dayResolutionKinds` lists them.",
      "NOTHING IN THIS FEED IS AN INVENTED MOMENT. A source that cannot say " +
        "WHEN does not appear at all — an active-subscription count going up is " +
        "real and is not here, because Stripe reports it as a level.",
      "CHARGE, REFUND, DISPUTE AND PAYMENT_FAILED EVENTS HAVE NO VENTURE and " +
        "cannot get one: Stripe's day tables are per account and per currency, " +
        "not per product. Filtering by venture therefore excludes every one of " +
        "them, and the document says so in `filter.note`.",
      "THE DAY COUNTS ARE COUNTS OF EVENTS, NEVER OF MONEY. Four refunds is " +
        "four whether they were four dollars or four thousand. Amounts are on " +
        "the events, per currency, and are not added across kinds.",
      "A `payment_failed` EVENT COUNTS DECLINES ONLY. Radar blocks are in the " +
        "detail beside it and are never added to it — a block is card testing " +
        "stopped before a bank saw it.",
      "AN EMPTY FEED IS NOT A BROKEN ONE. `coverage.lastPassAt` says when the " +
        "pass last wrote anything; `coverage.oldest` is the oldest event in the " +
        "table, not the oldest thing that ever happened — a first pass only " +
        "derives back `derivesBackDays`.",
      "`counts.truncated` means the feed was cut at `limit` and the list is the " +
        "newest slice. `counts.matching` is the real size of the filtered set " +
        "and is the number to quote.",
    ],
    views: [
      {
        key: "default",
        path: "/api/activity",
        about:
          "The feed, newest first, with per-day counts by kind over the same filter and a coverage block saying which kinds are exact.",
        params: [
          { name: "days", type: "number", required: false, fallback: 14, about: "How far back. Clamped to 1–400." },
          { name: "venture", type: "string", required: false, about: "A venture slug, id or name. Excludes every kind that structurally has no venture." },
          { name: "kind", type: "string", required: false, about: "One kind or several comma-separated: signup, charge, refund, dispute, payment_failed, run, card, push, alert." },
          { name: "limit", type: "number", required: false, fallback: 200, about: "Events returned. Clamped to 1–1000; the day counts are over the whole window regardless." },
        ],
      },
    ],
    asks: [
      "What happened this week?",
      "Has anything at all shipped for this venture in the last month?",
    ],
  },

  {
    id: "leakage",
    title: "Money on the floor — what Stripe tried to collect and did not",
    plugins: ["stripe"],
    about:
      "Computed from the Stripe tables on every read and never stored: cards " +
      "declined (apart from Radar blocks), money refunded, money lost to " +
      "disputes with the fee, subscriptions past due, the recurring coupon " +
      "discount, and abandoned checkouts. Per currency. Every bucket carries " +
      "the arithmetic that produced it — which table, which columns, which " +
      "window. The window is `days`, default 30.",
    rules: [
      "PER CURRENCY, AND THERE IS NO BLENDED TOTAL. `combined` is null at both " +
        "levels and stays null: this box fetches no exchange rate.",
      "ATTEMPTS ARE NOT SETTLEMENT. Declines come from the charge-day table, " +
        "which is attempts; refunds and disputes come from the ledger, which is " +
        "money that moved. They are dated differently — by the charge and by " +
        "the ledger posting — and no total spans them.",
      "DECLINED AND BLOCKED ARE NEVER ADDED AND NEVER SHARE A DENOMINATOR. " +
        "`failedTotal` is Stripe's own sum of the two and is published so " +
        "nobody has to compute it; it is not a business figure.",
      "A WINDOW FIGURE AND A PER-MONTH RATE ARE NOT ADDED. `totals.window` is " +
        "money that left in the window. `totals.perMonth` is past-due MRR plus " +
        "the coupon discount — dollars per month for as long as they last. " +
        "Quote them as two numbers with their units.",
      "TWO BUCKETS CARRY `amount: null` AND IT IS NOT ZERO. Declines have no " +
        "amount because the charge-day table records attempts as counts; " +
        "abandoned checkouts have none because nothing was ever invoiced. While " +
        "`noAmount` is non-empty every total is a FLOOR. `count: null` is the " +
        "mirror of the same rule — the source that produced the amount cannot " +
        "count what it is made of — and is never reported as none.",
      "THERE IS NO DISPUTE RATE ON THIS DOCUMENT AND YOU MUST NOT COMPUTE ONE. " +
        "Stripe measures disputes against lifetime successful transactions and " +
        "this box holds no lifetime charge count. Any ratio you could build " +
        "here has the wrong denominator and is exactly the figure a risk " +
        "reviewer would be quoted. `wrongFigures` lists this and three others " +
        "the route refuses; read it before dividing anything.",
      "THE DISPUTE BUCKET'S `count` IS NULL ON PURPOSE AND MUST STAY THAT WAY " +
        "IN ANYTHING YOU SAY. Its `amount` is the LEDGER's — money that moved, " +
        "dated by the balance posting, with Stripe's dispute fee in it — and " +
        "the ledger has no notion of a case to count. The CASE figures are " +
        "under `disputeCases`, from stripe_disputes, dated by when the bank " +
        "opened them and excluding the fee. Never divide one by the other: " +
        "amount ÷ any count there is a “mean chargeback” that is wrong in both " +
        "directions at once. `disputeCases.openNow` is current state and has " +
        "no window, and `coverage.disputeCases: 0` means none was ingested — " +
        "which is not the same as an account with none.",
      "`listedIfBilled` IS A HYPOTHETICAL and is in no total: what the " +
        "abandoned checkouts would be worth at list price if every one of them " +
        "had paid. It is not money that was lost.",
    ],
    views: [
      {
        key: "default",
        path: "/api/leakage",
        about:
          "Per currency: the buckets with their arithmetic, the two totals that are real, the counts, and the figures this route refuses to produce.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "The window for the charge and ledger buckets. Clamped to 1–400. Past due, coupons and abandoned checkouts are current state and ignore it.",
          },
        ],
      },
    ],
    asks: [
      "What money is on the floor right now?",
      "How much did we refund this month, and how much went to disputes?",
    ],
  },
];

/** Where these land in Hermes' skill directory. Filed by subject, like every
 *  other pack — see skills/hermes.ts on why the categories are not vendors. */
export const PACKS: Record<string, { name: string; category: string }> = {
  users: { name: "app-users", category: "finance" },
  activity: { name: "activity-feed", category: "productivity" },
  leakage: { name: "money-on-the-floor", category: "finance" },
};
