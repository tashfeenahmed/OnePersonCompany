/**
 * THE SKILL REGISTRY — what an agent is allowed to know about this box's data,
 * written down once, in code.
 *
 * WHY IT IS CODE AND NOT A TABLE. Every entry below is a claim about a route:
 * which URL answers it, what its parameters mean in the units the route
 * actually clamps to, and — the part that matters — the honesty rules that
 * route's own header spent paragraphs establishing. Those rules change when
 * the route changes, in the same commit, by the same person. A table would let
 * the two drift silently, and the failure mode of drift here is not a missing
 * card: it is an agent confidently telling the owner that his MRR is the sum
 * of a dollar figure and a euro one because the row that said "never do that"
 * was written against a version of the route that no longer exists.
 *
 * WHY IT IS NOT SCRAPED FROM THE ROUTES EITHER. The header comments are
 * argument, not schema — several hundred words each about why a figure is null
 * rather than zero. A generator would have to summarise them, and a summary of
 * an honesty rule is how the rule gets softened. So they are restated here, by
 * hand, at the length an agent can act on, and the rule is that a restatement
 * may be SHORTER than the route's own but may never be WEAKER.
 *
 * WHAT AN ENTRY IS. One data integration — not one route and not one plugin.
 * `/api/mobile` is one entry over two app stores because that is one question;
 * `/api/hetzner`'s four endpoints are one entry with four VIEWS because they
 * are four cuts of one fleet; `/api/gsc` and `/api/bing` are two entries for
 * the reason they are two routes, which is that nothing may ever add them.
 *
 * `plugins` IS AN ANY-OF, and that is deliberate rather than lazy. The domain
 * portfolio answers with one registrar connected and both; mail answers with
 * Gmail alone. A skill that required every plugin in its list would go dark the
 * moment one credential was removed and take the other half's data with it,
 * which is the opposite of what every one of these routes does on failure.
 *
 * SOME OF IT WRITES NOW, AND THE ENTRY IS WHERE THAT IS DECIDED. `views` are
 * GETs and `actions` are not: an action names a POST, PATCH or DELETE on a
 * route of this box, and the proxy will make that call. The owner asked for
 * two things by name — an agent that can work his board, and an agent that can
 * read his mail — so the honest place for the write is here, beside the rules
 * that say when to make it, rather than in a chat message asking him to go and
 * do it himself. An entry with no `actions` is exactly as read-only as it was
 * before, and most of them have none.
 *
 * WHAT IS STILL DELIBERATELY NOT HERE, now that "nothing writes" is no longer
 * the whole answer. There is no send, no forward and no reply: `/api/mailbox`
 * has no such route to proxy — its one write flips the UNREAD label and is not
 * published here — so an agent cannot send mail as the owner, and that is a
 * fact about the code rather than a rule it might talk itself out of. There is
 * no venture delete: a venture is the folder months of board cards, dashboards
 * and chat sessions hang off, and removing one is a decision the owner makes in
 * the page that can tell him what goes with it. `/api/plugins`, the credential
 * store and the agent routes are not here at all — they are how the dashboard
 * is administered, not what it measured, and an agent that could rewrite a
 * credential could rewrite the door it came in through.
 *
 * `/api/mailbox` WAS EXCLUDED HERE AND NOW IS NOT, so the old note is replaced
 * rather than quietly deleted. It said that handing an agent a tool onto live
 * Gmail would widen a surface that was narrowed on purpose. The surface is the
 * same width it always was; what changed is that the owner asked for it, and
 * the questions he asks of it — "what did that client actually say" — cannot be
 * answered out of any table on this box, because no table here has a column for
 * a subject or a body. So the narrowing moved from "there is no tool" to the
 * rules on the entry: nothing is stored, nothing is logged, nothing is marked
 * read, quote only what was asked about, and read no more threads than the
 * question needs. That is weaker than absence, it is what was asked for, and it
 * is written down here so that it is at least visible.
 */
import { PORT } from "../config.ts";
import { getPlugin } from "../db.ts";
import { manifestSkills } from "../integrations/index.ts";
import { PRESENT_BRIEF } from "./present.ts";

/* ------------------------------------------------------------------- types */

export type SkillParam = {
  name: string;
  type: "number" | "string";
  required: boolean;
  /** What the route uses when the parameter is absent. Stated rather than
   *  implied, because "the default window" is the single most common thing an
   *  agent gets wrong when it quotes a figure back. */
  fallback?: number | string;
  /** The meaning AND the clamp. A route that silently clamps 5000 to 400 has
   *  answered a different question than the one asked, and an agent that did
   *  not know that will caption the answer with the number it sent. */
  about: string;
  /**
   * WHERE THE VALUE GOES ON THE WIRE, and it is here rather than inferred
   * because two of these routes address a resource in the path — a thread is
   * `/api/mailbox/threads/<id>`, a venture is `/api/ventures/<key>` — and a
   * parameter that must be substituted into a path is a different thing from
   * one that is appended to it. Left out it is `query` on a view and `body` on
   * an action, which is what every other parameter here is; the proxy reads it
   * out of the same place either way, so a caller never has to know.
   */
  in?: "query" | "path" | "body";
  /**
   * Shown in the pack's and the CLI's worked example even though it is not
   * required. For the one parameter an agent keeps leaving out because the
   * example did not have it: a dispatch's `parentSessionId`. An example is the
   * line the model copies; a table row under it is the line it reads.
   */
  exampled?: boolean;
};

export type SkillView = {
  /** The `?view=` value that selects it. The FIRST view of an entry is what a
   *  bare `/api/skills/<id>` returns. */
  key: string;
  /** The real route this proxies to. Always a GET, always on this box. */
  path: string;
  about: string;
  params: SkillParam[];
};

/**
 * A WRITE, NAMED AND BOUNDED.
 *
 * The difference between this and a view is not the verb, it is that calling
 * one changes something the owner will find changed later. So an action names
 * exactly one route, exactly one method and exactly the parameters that route
 * reads — there is no passthrough, no `body` escape hatch and no way to reach a
 * route nobody wrote an entry for. An agent handed these can create a card and
 * cannot create a column, because there is no entry for a column and the proxy
 * has nowhere else to send a request.
 *
 * `path` MAY CARRY `:name` SEGMENTS, filled from the parameters marked
 * `in: "path"`. That is how "update THAT card" is expressed without letting the
 * caller compose a URL: it sends an id, and this file decides where in the path
 * an id goes.
 *
 * `destructive` IS A CLAIM AND NOT A MOOD. It is published as MCP's
 * `destructiveHint`, a field a client is entitled to trust when it decides
 * whether to ask a person first, and it answers exactly that question: IS
 * THERE ANYTHING HERE A PERSON CANNOT TAKE BACK? Four things qualify —
 *
 *   the record  it cannot be undone from here: deleting a card, where
 *               archiving the same card is reversible;
 *   money       it spends: a model call per picture, a dispatched run;
 *   a message   it sends: a briefing to a phone, a video to a channel;
 *   a machine   it reaches one that is not this one: an ssh that sleeps a
 *               desktop.
 *
 * The last three were once left unmarked on the grounds that the ROW survives,
 * which is true and is not what the field is for: a briefing somebody has
 * already read is not made unsent by a row still being there. Marking a
 * genuinely reversible action to be safe would still train a client to ignore
 * the field, so the four above are the whole of it.
 */
export type SkillAction = {
  /** The `<action>` in `POST /api/skills/<id>/<action>`. Snake case, a verb
   *  first, and unique within its skill. */
  key: string;
  /** The method the REAL route wants. The proxy speaks it; the caller always
   *  POSTs, because a caller that had to choose could choose wrong. */
  method: "POST" | "PATCH" | "DELETE";
  /** The real route, with `:name` segments where a path parameter goes. */
  path: string;
  about: string;
  params: SkillParam[];
  /** Nothing here can be taken back — the record, the money, the message or
   *  the machine. See the type header for the four. */
  destructive?: boolean;
};

export type Skill = {
  id: string;
  title: string;
  /**
   * ANY of these connected makes the skill live. An empty list means the skill
   * needs no credential at all — the board, which holds what the owner typed.
   */
  plugins: string[];
  /** Written for an agent rather than for a person: what the data is, what
   *  units it is in, and what window it covers. */
  about: string;
  /**
   * THE HONESTY RULES, carried forward from the route's own header. These are
   * the reason this file exists. A skill that drops one of these is worse than
   * no skill, because an agent with a tool and no rule will use the tool.
   */
  rules: string[];
  views: SkillView[];
  /**
   * WHAT CALLING IT CAN CHANGE. Absent on every entry that only reads, which is
   * most of them, and that absence is the thing to read first: a skill with no
   * `actions` key cannot be made to write by any request the proxy will accept.
   */
  actions?: SkillAction[];
  /** One or two questions this actually answers, so an agent can recognise the
   *  shape of the question rather than matching on the noun. */
  asks: string[];
  /**
   * THE `openWorld` RULE, STATED HERE AND NOWHERE ELSE.
   *
   * TRUE WHEN CALLING THIS REACHES A MACHINE THAT IS NOT THIS ONE — in either
   * direction. Fetching the open web (a live search, a competitor's page,
   * OpenAlex), sending the owner's data to a third party (a URL submitted to a
   * search engine, an image posted to an inference API, a video handed to a
   * platform), or publishing anything anywhere. FALSE only for a loopback read
   * of a document a collector on this box already wrote.
   *
   * IT IS A CLAIM AND NOT A CATEGORY. The MCP layer publishes it as an
   * `openWorldHint` annotation, and a client that reads `openWorldHint: false`
   * may decide the tool is safe to call without asking a person. Saying that
   * about a request that leaves the machine is a lie told in a field designed
   * to be trusted — so an entry with ANY action that reaches out declares it,
   * even where most of its views do not.
   */
  openWorld?: boolean;
};

/* ------------------------------------------------------- the universal rules */

/**
 * The four that apply to every document on this box, and therefore belong in
 * one place rather than in nineteen copies that can drift apart.
 *
 * They are also what goes in the prompt preamble for an agent with no skill
 * mechanism at all: if a remote model can only be told four things about this
 * data, these are the four, because each of them is a way to produce a
 * confident number that is wrong.
 */
export const UNIVERSAL_RULES: string[] = [
  "Money is never added across currencies. Where a document carries " +
    "`currency.combined: null` there is no total, the note beside it says why, " +
    "and you must not compute one — this box fetches no exchange rate.",
  "A figure the source de-duplicated cannot be summed: unique visitors, " +
    "Cloudflare uniques, Meta reach and frequency. Ranked breakdowns (Search " +
    "Console queries, Bing queries) are rankings and never totals.",
  "`null` means asked and not told. It is not zero, not \"none\" and not a " +
    "failure unless the document says so. Report it as \"not reported\".",
  "Quote the window and the units the document names, and say which figure you " +
    "used: an estimate and a payout are different money, and so are payment " +
    "attempts and settlement.",
];

/* ---------------------------------------------------------------- the entries */

/**
 * Every entry, connected or not. `skills()` is the filtered view; this is the
 * whole list, so `/api/skills` can also say what is NOT available and why —
 * "there is no AdSense data" and "nobody asked AdSense" are different answers
 * and only one of them is about the business.
 */
const BUILTIN_ENTRIES: Skill[] = [
  {
    id: "stripe",
    title: "Stripe — subscriptions, settlement and the book",
    plugins: ["stripe"],
    about:
      "The revenue side, per currency, computed on every read: MRR and ARR " +
      "from live subscriptions, churn, the settled ledger (gross, fees, tax " +
      "withheld, net), payment attempts including declines and Radar blocks, " +
      "the balance Stripe is holding, and the payouts that have actually left. " +
      "Windows are in days and default to 30.",
    rules: [
      "MRR is a NORMALISATION this app computes, not a figure Stripe publishes. " +
        "Active subscriptions only, each price normalised to a month by its own " +
        "billing interval — an annual plan counts as a twelfth a month — net of " +
        "recurring coupons. `mrr[].basis` carries that sentence; quote it.",
      "Trials, past-due subscriptions and one-off payments are NOT in MRR and " +
        "can never be. This account sells one-off research studies beside a " +
        "subscription; those are in gross, in net, and in no product's MRR.",
      "`charges` is payment ATTEMPTS and `revenue` is SETTLEMENT. They are dated " +
        "differently and nothing crosses them. Net revenue is always the ledger's " +
        "answer, never the charge walk's.",
      "`fees` is Stripe's own cut; `taxWithheld` is sales tax Stripe remits " +
        "onward. Only `fees` may produce a processing rate — folding them " +
        "together turns 8% into 15%.",
      "Blocked and declined never share a denominator: a Radar block is an " +
        "attack repelled, a decline is a bank refusing a real customer.",
      "A cancellation that never collected a payment is not churn. Churn rows " +
        "carry `approximate` and name their denominator; `unresolvedCancellations` " +
        "is how many are still counted as real because the invoice lookup has not " +
        "reached them.",
      "`history.from` is how far back the figures actually reach. A window wider " +
        "than that is a FLOOR, not a total.",
    ],
    views: [
      {
        key: "default",
        path: "/api/stripe",
        about: "The whole book: MRR, subscriptions, churn, revenue, charges, balance, payouts.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "Window in days for the money and churn figures. Clamped to 1–400.",
          },
        ],
      },
    ],
    asks: [
      "What is my MRR right now, and how much of it is annual plans counted as a twelfth?",
      "What did Stripe actually settle last 30 days, net of its fee?",
    ],
  },

  {
    id: "hetzner",
    title: "Hetzner — the fleet, its bill and its load",
    plugins: ["hetzner"],
    about:
      "The servers as the last successful collection saw them: how many, how " +
      "many running, where, what each plan and its primary IPv4 cost per month " +
      "in EUR net of VAT, the block volumes, and per-box CPU and throughput " +
      "samples at fifteen-minute grain.",
    rules: [
      "Every figure is EUR, net of VAT, because that is what Hetzner's API " +
        "returns. It is never added to a dollar figure from Stripe, OpenAI or " +
        "the app stores.",
      "A null `monthlyEur` means Hetzner quoted no price for that plan at that " +
        "server's own location. It does not mean the box is free.",
      "This is the last collection, not a live call. `seenAt` says when.",
      "CPU is already divided by the box's cores, so every reading is 'how much " +
        "of THAT box is in use, out of 100'. A box carrying `cpuScaled: false` " +
        "has an unknown core count and was passed through undivided.",
      "The fleet CPU line is a MEAN across the boxes reporting at each moment " +
        "and never a sum — seven percentages added produce a number in no unit. " +
        "Bandwidth is the other way round and does add.",
      "There is no memory figure and no disk-capacity figure, and there cannot " +
        "be: Hetzner measures from the hypervisor, which cannot see inside the " +
        "guest. The disk numbers are THROUGHPUT.",
    ],
    views: [
      {
        key: "default",
        path: "/api/hetzner/summary",
        about: "Counts, monthly cost, the split by location and by account.",
        params: [],
      },
      {
        key: "servers",
        path: "/api/hetzner/servers",
        about: "Every box: name, IPv4, status, plan, specs, location, its own monthly cost.",
        params: [],
      },
      {
        key: "volumes",
        path: "/api/hetzner/volumes",
        about: "Block storage, with the server each volume is attached to.",
        params: [],
      },
      {
        key: "load",
        path: "/api/hetzner/load",
        about: "Per-box CPU and network/disk throughput over a window, plus the fleet's own line.",
        params: [
          {
            name: "hours",
            type: "number",
            required: false,
            fallback: 24,
            about: "How far back the samples go. Clamped to 1–720.",
          },
        ],
      },
    ],
    asks: [
      "How many servers am I running and what do they cost a month?",
      "Which box has been busiest over the last day?",
    ],
  },

  {
    id: "domains",
    title: "Domains — the portfolio across both registrars",
    plugins: ["dynadot", "spaceship"],
    about:
      "Every domain name held at Dynadot and Spaceship on one shape: expiry " +
      "date, days left computed against today, auto-renew, registrar lock, " +
      "privacy, and which account read it. Plus a summary — counts by " +
      "registrar, by account and by TLD, and the renewal windows.",
    rules: [
      "The countdowns are computed on THIS read against today's date. Nothing " +
        "stored says 'renews in 30 days'.",
      "Null is a third answer. `autoRenewOff` is a list of things to fix; " +
        "`autoRenewUnknown` is a list of names no registrar would vouch for. " +
        "Never fold them together.",
      "`lapsed` is counted on its own and appears in NONE of the `expiring7/30/90` " +
        "windows. A name whose date has already passed must not hide inside a " +
        "figure that also means 'there is a week to sort this out'.",
      "Each account replaces only its own rows, so one registrar being down " +
        "cannot take the other's names off the list.",
    ],
    views: [
      {
        key: "default",
        path: "/api/domains",
        about: "The portfolio and its summary.",
        params: [],
      },
    ],
    asks: [
      "Which domains lapse this month, and which have auto-renew off?",
      "How many domains do I hold, and at which registrars?",
    ],
  },

  {
    id: "costs",
    title: "Costs — OpenAI, OpenRouter and Replicate",
    plugins: ["openai", "openrouter", "replicate"],
    about:
      "What the model spending costs, each provider in its own units and its " +
      "own shape: OpenAI per day per project, OpenRouter per day per model AND " +
      "per key as two cuts that do not join, and Replicate's prediction history " +
      "with no money in it at all. Totals are summed on the read over a window " +
      "in days, default 30.",
    rules: [
      "USD and EUR are reported side by side and THERE IS NO BLENDED TOTAL. " +
        "`currency.combined` is null with the reason attached, and you must not " +
        "make one — a total would need a real dated exchange rate this box does " +
        "not fetch.",
      "OpenAI has no per-model answer. The Costs API groups by project or by " +
        "line item, never both, so there is no per-model figure to find and none " +
        "may be inferred. Its recent buckets lag about a day; the route names the " +
        "last complete day.",
      "OpenRouter's three headline totals measure three different things — " +
        "lifetime spend across every key that ever existed, the sum of the keys " +
        "that still exist, and about a month of activity. Say which one you used.",
      "OpenRouter's `byok_usage` is inference it routed and did not bill for. It " +
        "is never added to `usd`.",
      "Replicate reports NO cost. `cost` is null — asked and not told — and stays " +
        "null; `cannot` lists exactly which endpoints were probed and what they " +
        "answered. Never report it as $0.",
      "THIS IS MODEL SPEND, NOT WHAT THE OPERATION COSTS. Servers, volumes, " +
        "domain renewals, subscriptions and electricity are not here and never " +
        "will be — they are in the `ledger` skill, which also carries the " +
        "per-venture split. Answer “what does this cost me a month” from `ledger`, " +
        "and use this document for the provider half of it.",
    ],
    views: [
      {
        key: "default",
        path: "/api/costs",
        about: "All three providers, each in its own units, over the window.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "Window in days. Minimum 1.",
          },
        ],
      },
    ],
    asks: [
      "What did I spend on models last month, and which project spent it?",
      "How much OpenRouter credit is left?",
    ],
  },

  {
    id: "mobile",
    title: "App Store Connect and Google Play — revenue, estimates and installs",
    plugins: ["appstore", "playstore"],
    about:
      "Check App Store Connect (iOS) and Google Play (Android) revenue once either plugin is connected. " +
      "Use the revenue view for a specific report month or the latest available month, per store, account and app. " +
      "The default view includes both stores: store presence and ratings, installs and " +
      "units per day, each store's ESTIMATE of what a period earned, and — " +
      "separately — net proceeds from its financial reports. Per currency throughout. " +
      "The days window (default 30) applies only to daily figures, not monthly financial reports.",
    rules: [
      "THE ESTIMATE AND THE PAYOUT ARE DIFFERENT THINGS. Never add them, never " +
        "average them, never substitute one for the other. Only a payout may be " +
        "called revenue. Apple's estimate is its daily sales report's developer " +
        "proceeds; its payout is the finance report. Google's estimate is what " +
        "buyers were charged; its payout is reported net merchant earnings.",
      "The estimate is the only figure that exists for a month still running, " +
        "which is exactly why it keeps its own name.",
      "Nothing is added across currencies. One month of this account took money " +
        "in nine buyer currencies differing by four orders of magnitude; " +
        "`currency.combined` is null and `currency.seen` lists what turned up.",
      "A null payout means the store issued no report — not a payout of zero. A " +
        "null rating means no ratings, not zero stars.",
      "Apple pays per FISCAL MONTH and Google stamps its financial exports by " +
        "MONTH, so no window narrower than a month is measurable on the payout " +
        "side at all.",
      "For revenue questions use view=revenue with store=all, appstore, or playstore and optional month=YYYY-MM. " +
        "Without month, each store selects its own latest available financial report; do not assume their months match. " +
        "These are net proceeds reported by the store, not confirmation of a bank deposit.",
      "Read connected, status, reportAvailable, collection dates and account errors before quoting revenue. " +
        "A disconnected store or missing report is not zero. Partial account coverage is not a complete total. " +
        "The tool reads collected reports; it does not refresh credentials or call the stores live.",
    ],
    views: [
      {
        key: "default",
        path: "/api/mobile",
        about: "Both stores: presence, installs, the estimate block and the payout block.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "Window in days for the daily figures. Clamped to 1–400.",
          },
        ],
      },
      {
        key: "revenue",
        path: "/api/mobile/revenue",
        about: "Monthly App Store Connect and Google Play net revenue, per currency, account and app, with report availability.",
        params: [
          { name: "store", type: "string", required: false, fallback: "all", about: "all, appstore (iOS), or playstore (Android)." },
          { name: "month", type: "string", required: false, about: "YYYY-MM report month. Omit for each store's latest available financial report. Apple uses fiscal months." },
        ],
      },
    ],
    asks: [
      "What is my App Store and Google Play revenue for a particular month?",
      "What did the apps actually pay out last closed month?",
      "How many installs across both stores in the last 30 days?",
    ],
  },

  {
    id: "mail",
    title: "Mail — the inboxes and the sending domains",
    plugins: ["gmail", "resend"],
    about:
      "Two ends of the same pipe. Gmail: per mailbox, what is waiting, the " +
      "label counters, and received/sent per day. Resend: the sending domains, " +
      "each DNS record's own status, and what became of every email sent — " +
      "delivered, bounced, complained. Window in days, default 30.",
    rules: [
      "No figure spans the two halves. An inbox thread waiting on a reply and a " +
        "transactional password reset are not the same kind of thing.",
      "Received and sent are counted apart and never added.",
      "`needing_reply` is null for a label nobody scanned and 0 for a label with " +
        "a clear queue. Those are different answers.",
      "There is no subject, no body, no recipient and no correspondent address " +
        "in this data and there cannot be — the schema has no column for one, " +
        "and correspondents are stored as salted HMACs. Do not claim to know who " +
        "wrote or what about.",
      "Resend's `last_event` MOVES: an email delivered this morning can be " +
        "bounced this afternoon, so every rate is computed on this read.",
    ],
    views: [
      {
        key: "default",
        path: "/api/mail",
        about: "Both providers: mailboxes, inbox state, volume, sending domains, DNS, delivery.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "Window in days. Minimum 1.",
          },
        ],
      },
    ],
    asks: [
      "How much mail is waiting on a reply?",
      "Is any sending domain's DNS broken, and what bounced this month?",
      "For what a message actually SAYS, this is the wrong skill — use `mailbox`, " +
        "which reads Gmail live. This one counts and never quotes.",
    ],
  },

  /**
   * THE ONE THAT READS THE MAIL ITSELF, and it is filed next to the one that
   * counts it so that the difference is impossible to miss. `mail` above is a
   * collector's tables and structurally cannot hold a subject; this is a live
   * proxy onto Gmail that holds nothing at all.
   */
  {
    id: "mailbox",
    title: "Mailbox — the threads themselves, read live",
    plugins: ["gmail"],
    about:
      "The actual mail: threads with their subjects, correspondents and message " +
      "bodies, fetched from Gmail on the read and stored nowhere. One Gmail " +
      "account receives every domain in this portfolio through Cloudflare " +
      "forwarding, so a 'mailbox' here is a Gmail QUERY on the To line " +
      "(`to:(@acme.com)`) rather than a folder. `sent` is the other end: " +
      "what the products themselves sent people, through Resend.",
    rules: [
      "NOTHING READ HERE IS STORED AND NOTHING IS LOGGED. The route holds no " +
        "cache, writes no row and prints no line of any message. Whatever you " +
        "carry out of a call is the only copy — so put in your answer what the " +
        "owner asked about and not the rest of the thread.",
      "READ NO MORE MAIL THAN THE QUESTION NEEDS. One thread answers \"what did " +
        "she say\"; a page of twenty-five to answer it is twenty-four private " +
        "conversations opened for nothing. Search with `q` before you page.",
      "QUOTE NARROWLY AND ATTRIBUTE. Say who wrote it and when, quote the line " +
        "that answers the question, and do not summarise a whole thread the owner " +
        "did not ask you to summarise.",
      "READING MARKS NOTHING AS READ. An unread thread stays unread; the route " +
        "that flips that label is not published here. So the owner's inbox looks " +
        "exactly as it did before you looked at it, and you must not tell him you " +
        "have cleared anything.",
      "THERE IS NO SEND, NO REPLY AND NO FORWARD. This skill has no actions at " +
        "all — there is no route behind it that could write a message. Draft the " +
        "reply in the conversation and let the owner send it himself.",
      "`query` on the answer is the Gmail search that actually ran, verbatim. An " +
        "empty result means that query found nothing, which is NOT the same as the " +
        "correspondent having sent nothing — quote the query when you report a " +
        "nil, and check `mailboxIgnored`, which names a mailbox filter that was " +
        "dropped because no connected key covers it.",
      "The `mailbox` a thread is attributed to is decided from the To, Cc and " +
        "Delivered-To lines against the domains the Resend keys cover. It is an " +
        "inference from headers a forwarder rewrote, so it is good enough to " +
        "group by and not good enough to assert as fact about a customer.",
    ],
    views: [
      {
        key: "threads",
        path: "/api/mailbox/threads",
        about:
          "A page of threads: subject, who wrote, when, the snippet, the labels, " +
          "how many messages, and which mailbox it arrived at. Bodies are NOT here.",
        params: [
          {
            name: "q",
            type: "string",
            required: false,
            about:
              "A Gmail search, in Gmail's own syntax (`from:`, `subject:`, " +
              "`newer_than:7d`, `has:attachment`). Truncated at 500 characters. It is " +
              "ANDed with the mailbox filter below rather than replacing it.",
          },
          {
            name: "mailbox",
            type: "string",
            required: false,
            fallback: "all",
            about:
              "Narrow to one venture domain (`acme.com`), to `gmail` for mail " +
              "addressed to the Google account itself, or `all`. A domain no " +
              "connected key covers is IGNORED and named in `mailboxIgnored` — the " +
              "answer widens rather than coming back empty.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 25,
            about:
              "Threads on the page. Clamped to 1–50; anything unparseable becomes 25. " +
              "Each row costs a separate fetch from Gmail, so a big page is slow as " +
              "well as nosy.",
          },
          {
            name: "page",
            type: "string",
            required: false,
            about:
              "Gmail's own opaque cursor, taken from `nextPage` on a previous answer. " +
              "It is not an ordinal and there is no page 2.",
          },
          {
            name: "account",
            type: "number",
            required: false,
            about:
              "Which connected Gmail account, by the id in the `mailboxes` view. " +
              "Absent means the primary; an unparseable one also means the primary.",
          },
        ],
      },
      {
        key: "thread",
        path: "/api/mailbox/threads/:id",
        about:
          "One conversation, every message in it, with the bodies — sanitised HTML " +
          "and a plain-text alternative. Remote images are stripped unless asked " +
          "for by message id, because a remote image in mail is usually a tracking " +
          "pixel and loading one tells the sender it was opened.",
        params: [
          {
            name: "id",
            type: "string",
            required: true,
            in: "path",
            about: "The thread id, from a row in the `threads` view.",
          },
          {
            name: "account",
            type: "number",
            required: false,
            about: "The Gmail account the thread belongs to. Absent means the primary.",
          },
        ],
      },
      {
        key: "mailboxes",
        path: "/api/mailbox/mailboxes",
        about:
          "What can be filtered on: every connected sending domain, plus the Gmail " +
          "account itself, and whether there is a mailbox to read at all.",
        params: [],
      },
      {
        key: "sent",
        path: "/api/mailbox/sent",
        about:
          "What the PRODUCTS sent — password resets, receipts, notifications — " +
          "through Resend, newest first, with what became of each. Without a " +
          "`domain` it merges one page from each domain and has no next page.",
        params: [
          {
            name: "domain",
            type: "string",
            required: false,
            about:
              "One sending domain. A domain no connected key covers answers 404 with " +
              "the list of the ones that are covered. Naming a domain is also what " +
              "turns paging on.",
          },
          {
            name: "page",
            type: "string",
            required: false,
            about:
              "Resend's cursor, from `nextPage`. Only meaningful with a `domain` — " +
              "the merged view has no cursor that could mean anything across ten " +
              "independent lists.",
          },
        ],
      },
    ],
    asks: [
      "What did the customer who wrote about the refund actually say?",
      "Is there anything in the acme.com mailbox from this week I have not answered?",
    ],
  },

  {
    id: "github",
    title: "GitHub — repos, traffic and the rate budget",
    plugins: ["github"],
    about:
      "Every repo the connected tokens can see: stars, forks, open issues, last " +
      "push, language, and — where the token has push access — GitHub's " +
      "fourteen-day traffic: views, unique visitors, clones, top referrers and " +
      "top paths. Plus what is left of the API budget.",
    rules: [
      "VIEWS ADD UP AND UNIQUES DO NOT — not across days and not across repos. " +
        "GitHub de-duplicates within each day for the series and across the whole " +
        "fortnight for its header figure, so adding fourteen daily uniques counts " +
        "every returning visitor again. Every unique figure here says which kind " +
        "it is; repeat that word.",
      "Days marked `partial` — including today, whose bucket GitHub has not " +
        "finished — are off the line and out of the totals.",
      "A repo with a `trafficNote` and no traffic is one the token cannot push " +
        "to. GitHub serves those endpoints to nobody else, at any budget. It is " +
        "not a repo with no visitors.",
      "The rate-limit figure is only quoted while it still means something; past " +
        "its reset it is a number about an hour that has ended.",
      "Organisations are named explicitly, never swept, so a repo that is missing " +
        "may simply be one nobody asked about.",
    ],
    views: [
      {
        key: "default",
        path: "/api/github",
        about: "The repos, the daily traffic line, the referrers, and the budget left.",
        params: [],
      },
    ],
    asks: [
      "Which of my repos is getting the most traffic, and from where?",
      "How many stars across the account, and what changed recently?",
    ],
  },

  {
    id: "npm",
    title: "npm — package downloads",
    plugins: ["npm"],
    about:
      "One row per package per day, bucketed into ISO weeks when it is read, " +
      "for the packages the owner has listed by hand. No credential is " +
      "involved: npm's downloads API is public.",
    rules: [
      "IT IS DOWNLOADS, NEVER INSTALLS. npm counts HTTP tarball fetches, and a " +
        "CI job, a Docker layer rebuild, a mirror warming its cache and a person " +
        "typing `npm i -g` are one download each. Use the word `downloads`.",
      "Weeks are ISO, Monday to Sunday. npmjs.com's own 'last week' is a rolling " +
        "seven days ending yesterday, so the two legitimately disagree.",
      "A week marked `partial` is never compared with a complete one — three days " +
        "beside seven reads as a collapse in demand and is nothing of the kind.",
      "The package list is a setting the owner maintains. A package that is not " +
        "in it is missing because nobody added it, not because it has no downloads.",
    ],
    views: [
      {
        key: "default",
        path: "/api/npm",
        about: "Per package: downloads by day and by ISO week, with a summary.",
        params: [],
      },
    ],
    asks: [
      "How many downloads did my packages get last week?",
      "Is any package's download trend falling?",
    ],
  },

  {
    id: "gsc",
    title: "Google Search Console — clicks, impressions and position",
    plugins: ["gsc"],
    about:
      "Every verified Search Console property: finalised daily clicks, " +
      "impressions and impression-weighted average position; the ranked query " +
      "and page breakdowns; what fraction of impressions those ranked rows " +
      "actually cover; and the sitemaps each property has submitted. Window in " +
      "days, default 90.",
    rules: [
      "THE QUERY ROWS DO NOT ADD UP TO THE PROPERTY. Google withholds queries " +
        "too rare to keep a searcher anonymous and caps the rows it returns — " +
        "measured across these properties the ranked rows carry between 0% and " +
        "77% of their own property's impressions, about 19% across the portfolio. " +
        "`coverage` states the fraction. NEVER sum the query column into a total; " +
        "the totals come from the daily rows, which do sum to Google's own answer " +
        "exactly.",
      "The window ends THREE DAYS BACK. Search Console takes two to three days " +
        "to finalise a day, so there is no answer here about the last three days " +
        "and none may be estimated. `window.end` names the last day covered.",
      "Positions are impression-weighted means and are null rather than zero " +
        "wherever there were no impressions. Google reports 0.0 for a property " +
        "nobody saw; that is the absence of a rank, not a rank.",
      "The sitemap figures are what was SUBMITTED. How many pages are indexed is " +
        "the Index Coverage report, which has no API at all — there is no indexed " +
        "count here and none can be produced.",
      "Never add a Search Console impression to a Bing one. They count different " +
        "searches by different people under different anonymisation rules.",
    ],
    views: [
      {
        key: "default",
        path: "/api/gsc",
        about: "Totals, the daily series, per property, the query/page rankings, coverage, sitemaps.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 90,
            about: "Window in days. Clamped to 7–400, and it ends three days before today.",
          },
        ],
      },
    ],
    asks: [
      "How much search traffic did my sites get, and which property grew?",
      "What is my average position on acme.so, and over what window?",
    ],
  },

  {
    id: "bing",
    title: "Bing Webmaster — traffic, index, links and keyword demand",
    plugins: ["bing-webmaster"],
    about:
      "Four different kinds of answer for each verified Bing site: what Bing " +
      "showed and what was clicked per day; what its index holds and what its " +
      "crawler did; two disagreeing inbound-link figures; and — the one thing " +
      "nothing else on this box can give — search volume for phrases the owner " +
      "named, whether or not anything of his ranks for them.",
    rules: [
      "Never add a Bing impression to a Google one. There is no total across the " +
        "two anywhere in this app and none may be computed.",
      "Keyword volume is BING's impressions in ONE market. It is a shape, not a " +
        "census, and it is not 'how many people search this'.",
      "A keyword state of `void` means UNMEASURED — a control phrase with " +
        "year-round volume came back empty, so Bing was not answering. `na` means " +
        "Bing answered and reported none. Neither is a volume of zero.",
      "`in_links` is what the crawler counted and `linked_pages` is what the link " +
        "index could name; they disagree and both are kept. There is no referring-" +
        "domain figure here and none can be produced — the count carries no domain.",
      "The window ends on the newest day BING reported, not today. Bing publishes " +
        "no finalisation lag.",
    ],
    views: [
      {
        key: "default",
        path: "/api/bing",
        about: "Traffic, index and crawl, links, and the keyword demand list.",
        params: [],
      },
    ],
    asks: [
      "How many people search for the phrases I am watching?",
      "What is Bing's index holding for my sites, and what did it refuse to crawl?",
    ],
  },

  {
    id: "cloudflare",
    title: "Cloudflare — zones, traffic and where each name really delegates",
    plugins: ["cloudflare"],
    about:
      "Every zone: its DNS records, proxy count, mail posture (SPF, DMARC, DKIM, " +
      "MX) and the nameservers Cloudflare assigned it; unsampled daily traffic " +
      "rollups — requests, cache, bytes, threats, page views; and the join this " +
      "box is uniquely able to make between the nameservers Cloudflare assigned " +
      "and the ones the registrar actually delegates to. Window in days, " +
      "default 7.",
    rules: [
      "THE WINDOW ENDS YESTERDAY. Cloudflare is still writing today's UTC bucket, " +
        "so today is carried separately marked `partial` and is in no total.",
      "Uniques do not add. Cloudflare de-duplicates within one zone and one day " +
        "and nowhere else, so `summary.uniques` is null with the reason attached; " +
        "`uniquesByDay` and `uniquesByZone` are named for what they summed over, " +
        "and `uniquesBusiestDay` is the only real headcount on the wire.",
      "A zone with `traffic: null` and a `trafficNote` was not measured. A zone " +
        "with an object full of zeroes was measured and served nothing. Never " +
        "draw 'no visitors' under the first.",
      "A cache ratio over zero requests is null, not 0%.",
      "An EMPTY registrar list is the ordinary answer — nothing on this account " +
        "is registered at Cloudflare Registrar. `readable` beside `count` keeps a " +
        "refusal apart from a portfolio of zero.",
      "Alignment has FIVE states and is not a boolean: `aligned`, `off-cloudflare` " +
        "(the records on every other card are not what the internet is served), " +
        "`elsewhere-on-cloudflare`, `unknown` (not safe — unknown), and " +
        "`no-registrar-row` (registered somewhere with no API here — not a lapse).",
    ],
    views: [
      {
        key: "default",
        path: "/api/cloudflare",
        about: "Zones, daily traffic, the summary, mail posture, the alignment join, registrar.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 7,
            about: "Complete UTC days, ending yesterday. Today is reported apart, as partial.",
          },
        ],
      },
    ],
    asks: [
      "How many requests did my zones serve last week, and which was busiest?",
      "Is any domain pointed away from the Cloudflare zone I am editing?",
    ],
  },

  {
    id: "meta",
    title: "Meta — Pages, the ad account, and Instagram",
    plugins: ["meta"],
    about:
      "The Facebook Pages and their follower counts, the ad account in its own " +
      "currency — spend, impressions, clicks, leads and cost per lead, per day " +
      "and over Meta's own window — the campaigns, and the Instagram answer. " +
      "Window in days, default 30.",
    rules: [
      "REACH AND FREQUENCY CANNOT BE SUMMED OR AVERAGED. Meta de-duplicates them " +
        "over each row's own window, so thirty daily reaches are not a thirty-day " +
        "reach and no arithmetic recovers one. Meta's own window figures are " +
        "stored WITH `window_from`/`window_to`; quote those dates, never '30d'.",
      "A day with no row is a day that did not deliver, not a day measured at " +
        "zero. The route says how many days of the window carried delivery.",
      "Meta reports the same lead under several names; ONE is counted and the " +
        "rest ignored. Do not add them.",
      "The attribution window is requested explicitly and named on the wire " +
        "(`7d_click,1d_view`). A conversion count whose window is not stated is " +
        "not a measurement.",
      "ROAS is null because this account buys lead-form submissions — there is no " +
        "purchase event and no revenue for Meta to divide by. It is not 0× and it " +
        "is not a verdict on the campaigns.",
      "A Page here is a FOLLOWER COUNT and nothing else. Page reach is gone twice " +
        "over — the metric was retired and this token cannot mint a Page token — " +
        "and both reasons are in `cannot`.",
      "Instagram `none-linked` means the token works, lists the Pages by name, " +
        "and none of them has a linked Instagram Business account. `followers` is " +
        "null, NOT 0, and the fix is to link one in Business Suite.",
      "The ad account bills in EUR. Nothing is added across currencies.",
    ],
    views: [
      {
        key: "default",
        path: "/api/meta",
        about: "Pages, Instagram state, ad accounts, spend by currency, campaigns, what cannot be read.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "Window in days for the daily ad figures. Minimum 1.",
          },
        ],
      },
    ],
    asks: [
      "What did Meta ads cost last month and how many leads did they buy?",
      "How many followers across my Facebook Pages?",
    ],
  },

  {
    id: "adsense",
    title: "AdSense — estimated ad earnings",
    plugins: ["adsense"],
    about:
      "Estimated ad earnings per site per day and per calendar month, with page " +
      "views, impressions, clicks and a derived RPM — or, when no consent has " +
      "been granted, which of four unauthorised states the integration is in and " +
      "what would change it. Window in days, default 30.",
    rules: [
      "EVERY FIGURE HERE IS AN ESTIMATE and says so. AdSense revises recent days " +
        "afterwards, so recent numbers move.",
      "Nothing adds an AdSense figure to a Stripe one. One is an ad network's " +
        "estimate, the other is a bank settlement.",
      "READ `state` FIRST. `not-connected`, `refused`, `service-disabled` and " +
        "`authorised` are four different situations and only the last has real " +
        "figures behind it. Not-authorised is a state, not a failure.",
      "`earnings` null means asked and not told. It is never a confident $0.",
      "RPM is divided out on the read. Averaging thirty daily RPMs gives a figure " +
        "no report of Google's would agree with.",
    ],
    views: [
      {
        key: "default",
        path: "/api/adsense",
        about: "The state, the earnings if any, per site and per month.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "Window in days. Clamped to 1–400.",
          },
        ],
      },
    ],
    asks: [
      "What are my sites estimated to have earned from ads this month?",
      "Why is there no AdSense data?",
    ],
  },

  {
    id: "demand",
    title: "Demand — what strangers asked for on Reddit and Hacker News",
    plugins: ["reddit", "hackernews"],
    about:
      "The only part of this box that measures something the owner does not own: " +
      "threads matching the phrases on a watch list, from Reddit's search feed, " +
      "Hacker News, and the SearXNG node that answers when Reddit will not — " +
      "with which tier answered, and which phrases nobody would let us ask. " +
      "Window in days, default 30.",
    rules: [
      "The THREAD COUNT spans the sources and it is the only figure that does. " +
        "UPVOTES ARE NEVER ADDED across Reddit and Hacker News — a Reddit upvote " +
        "and an HN point are two crowds' currencies with no exchange rate.",
      "A row with no post date is in NO WINDOW at all and is counted apart as " +
        "`unaged`. Those are the SearXNG-tier rows: a web index knows a title and " +
        "a URL and not when it was posted or who agreed.",
      "Which tier answered is part of the measurement. `skipped` means this run " +
        "chose not to ask that phrase — it is not evidence that nobody is talking " +
        "about it.",
      "The watch list is a setting the owner wrote. A phrase that is not in it is " +
        "missing because nobody added it.",
      "Reddit rows younger than about a day and a half are published unscored " +
        "rather than published wrong: the archive still reports its own placeholder.",
    ],
    views: [
      {
        key: "default",
        path: "/api/demand",
        about: "Reddit, Hacker News and the search node, per phrase, with the query outcomes.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "Window in days, applied to rows that carry a date.",
          },
        ],
      },
    ],
    asks: [
      "Is anybody talking about the things on my watch list?",
      "Which watch phrases could not be asked about this week, and why?",
    ],
  },

  {
    id: "stock",
    title: "Stock media — the remaining request allowance",
    plugins: ["pexels", "pixabay"],
    about:
      "Pexels' and Pixabay's monthly request allowance, what is left of it, and " +
      "the burn rate computed as a slope through the readings. Window in days, " +
      "default 30.",
    rules: [
      "This measures a CONSTRAINT, not a result. Neither service keeps a usage " +
        "history and nothing on this box records what the video workers pulled, " +
        "so there is no 'clips used' figure and none can be produced.",
      "The burn rate is computed on the read from the FALLING segments only — " +
        "when the allowance refills the counter jumps up, and a naive " +
        "first-minus-last would read that as negative consumption.",
      "Absent quota headers produce nulls and the answer is 'quota not reported', " +
        "never a confident zero. Pixabay in particular has never been run against " +
        "a live response here.",
    ],
    views: [
      {
        key: "default",
        path: "/api/stock",
        about: "Each library's allowance, what is left, and the burn rate.",
        params: [
          {
            name: "days",
            type: "number",
            required: false,
            fallback: 30,
            about: "Window in days for the burn-rate slope. Clamped to 1–400.",
          },
        ],
      },
    ],
    asks: [
      "Will the b-roll pipeline run out of Pexels requests this month?",
    ],
  },

  {
    id: "telegram",
    title: "Telegram — the bridge",
    plugins: ["telegram"],
    about:
      "The one integration here that is a DOOR rather than a measurement: which " +
      "bot the token belongs to, which chat it is locked to, whether the poller " +
      "is actually running, how far through the update stream it has got, and " +
      "how many messages from other chats it threw away.",
    rules: [
      "This describes the bridge, not the business. Nothing here is a metric " +
        "about a product.",
      "A high 'ignored' count is the lock working as designed — messages from " +
        "chats other than the paired one — not a fault.",
      "The bot pairs with the FIRST chat that messages it after the lock is " +
        "cleared. Whether the poller is running and whether a bot is connected " +
        "are two different facts.",
    ],
    views: [
      {
        key: "default",
        path: "/api/telegram",
        about: "The bot, the paired chat, the poller, and what it ignored.",
        params: [],
      },
    ],
    asks: [
      "Is the Telegram bot actually polling, and which chat is it paired with?",
    ],
  },

  {
    id: "ventures",
    title: "Ventures — the businesses this is all about",
    plugins: [],
    about:
      "The projects themselves: each one's name, what the owner says it is, its " +
      "website, and the STAGE he has put it at — idea, pre-launch or launched. " +
      "Beside that is what was measured FROM the site: its favicon, its title and " +
      "description, its colour palette and its fonts. It needs no credential, so " +
      "it is always available, and its ids are what every board card's " +
      "`ventureId` and every venture-scoped question refers to.",
    rules: [
      "STAGE IS THE OWNER'S DECLARATION AND IT IS THE THING TO TAILOR ADVICE TO. " +
        "`idea` — not built yet; validate demand, size it, decide whether to " +
        "build. `pre-launch` — being built or about to ship; get to a first " +
        "release: launch checklist, landing page, first users. `launched` — live " +
        "and serving people; grow it, keep it healthy, watch revenue and churn. " +
        "Growth advice for an idea, or validation advice for a launched product, " +
        "is advice about a business he does not have.",
      "THE DESCRIPTION IS THE OWNER'S OWN WORDS. Quote it; never rewrite, polish " +
        "or 'improve' it through the update action unless he asked you to change " +
        "exactly that.",
      "EVERYTHING UNDER `brand` WAS MEASURED FROM THE SITE, not chosen by anybody. " +
        "Say so when you quote it — \"the site's primary reads as #c1663f\" and not " +
        "\"your brand colour is #c1663f\". `brand.palette.ranked` is what the roles " +
        "were assigned from, and `brand.notes` says what could not be measured.",
      "A NULL FAVICON OR AN EMPTY PALETTE MEANS THE SITE COULD NOT BE READ, not " +
        "that the site has none. `brand.error` says the read failed outright and " +
        "`brand.enrichedAt: null` means it has never been attempted — neither is a " +
        "finding about the business.",
      "CREATING A VENTURE IS CREATING A FOLDER the owner will see on his Ventures " +
        "page forever. Only do it when he has asked for a new one by name, and " +
        "report the id and the slug that came back.",
      "THERE IS NO DELETE HERE, deliberately. A venture is what board cards, " +
        "dashboards and chat sessions hang off, and removing one is a decision " +
        "made in the page that can say what goes with it. If he asks you to delete " +
        "a venture, say where the button is.",
      "COLOUR IS NOT AN ACTION PARAMETER. It is either the owner's own choice or " +
        "the one measured from the site, and an agent picking a brand colour is an " +
        "agent making a decision nobody asked it to make.",
    ],
    views: [
      {
        key: "default",
        path: "/api/ventures?brief=1",
        about:
          "Every venture in the owner's own order — id, slug, name, description, " +
          "website, host, stage — the count at each stage, and the sentence that " +
          "says what each stage means. Small enough to read whole; what was " +
          "measured from each site is under `one`.",
        params: [],
      },
      {
        key: "one",
        path: "/api/ventures/:key",
        about: "One venture, whole, including everything measured from its site.",
        params: [
          {
            name: "key",
            type: "string",
            required: true,
            in: "path",
            about:
              "Its id (`v-acme`), its slug (`acme`), or its name or host " +
              "as the owner says it (`Acme`, `acme.com`), case " +
              "insensitively. All address the same record; the id is what board " +
              "cards carry.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "create",
        method: "POST",
        path: "/api/ventures",
        about:
          "Write down a new venture. When a website is given the site is read " +
          "there and then — favicon, title, colours — which takes a few seconds; a " +
          "site that cannot be read still creates the venture and says why in " +
          "`brand.error`. Answers with the venture, including the slug it was given.",
        params: [
          {
            name: "name",
            type: "string",
            required: true,
            about:
              "What he calls it. At most 80 characters. The URL slug is made from " +
              "this ONCE, at creation, and a later rename never changes it.",
          },
          {
            name: "description",
            type: "string",
            required: false,
            about:
              "What it is, in his words — the sentence he would use, not a marketing " +
              "line you wrote for him.",
          },
          {
            name: "website",
            type: "string",
            required: false,
            about:
              "Its address. A bare `acme.com` is accepted and normalised to " +
              "https://. Anything that is not an http(s) URL is refused.",
          },
          {
            name: "stage",
            type: "string",
            required: false,
            fallback: "idea",
            about:
              "`idea`, `pre-launch` or `launched` — nothing else. Absent means " +
              "`idea`. Ask which one rather than guessing from the website: a live " +
              "landing page is a common thing for an idea to have.",
          },
        ],
      },
      {
        key: "update",
        method: "PATCH",
        path: "/api/ventures/:key",
        about:
          "Change one thing about a venture. A field left out is untouched; a " +
          "field sent as null is cleared. Changing the website re-reads the site.",
        params: [
          {
            name: "key",
            type: "string",
            required: true,
            in: "path",
            about: "The venture's id or slug.",
          },
          {
            name: "name",
            type: "string",
            required: false,
            about: "A new name. The slug does not follow it — old links keep working.",
          },
          {
            name: "description",
            type: "string",
            required: false,
            about:
              "New words for what it is, or null to clear them. His words, not " +
              "yours — see the rules.",
          },
          {
            name: "website",
            type: "string",
            required: false,
            about:
              "A new address, which re-reads the site, or null to remove it — which " +
              "also drops everything measured from it.",
          },
          {
            name: "stage",
            type: "string",
            required: false,
            about:
              "`idea`, `pre-launch` or `launched`. Moving a venture between stages " +
              "is the owner's call about his own business; do it when he says so, " +
              "not because a launch looked done to you.",
          },
        ],
      },
    ],
    asks: [
      "What am I working on, and which of them have actually launched?",
      "Add a new venture called Ledgerpost — it's an idea, no site yet.",
    ],
  },

  {
    id: "board",
    title: "The board — what the owner wrote down",
    plugins: [],
    about:
      "The kanban board: every column with its cards in order, each card's " +
      "title, body, urgency, due date and venture, plus counts and what any WIP " +
      "limit says. It needs no credential, so it is always available.",
    rules: [
      "THESE ROWS ARE THE RECORD, not a collector's transcript. Every other skill " +
        "here is a window onto what a provider reported; these are the owner's own " +
        "words and nothing collects them. A card lost is work lost.",
      "THIS ONE WRITES, through the five actions below and through nothing else. " +
        "Never create, move, edit, archive or delete a card the owner did not ask " +
        "you to. \"While I was in there I tidied the column\" is the failure this " +
        "rule exists to prevent, and it is not recoverable from a chat transcript.",
      "ASK BEFORE YOU ARCHIVE AND ASK AGAIN BEFORE YOU DELETE. Archiving hides a " +
        "card from every read of the board; deleting removes the row and there is " +
        "no undo anywhere in this app. Where either would do, archive.",
      "SAY WHAT YOU DID AND NAME THE ID. Every one of these answers with the WHOLE " +
        "board rather than with the card, so read the id back out of the reply and " +
        "quote it — the owner has no other way to find what you touched.",
      "`ventureId` is one of the ids from the `ventures` skill and nothing else. An " +
        "invented one is accepted by the route and resolves to no venture, which " +
        "draws the card as unfiled and looks like a bug in the page.",
      "Urgency is 0 low, 1 normal, 2 high, 3 urgent — the numbers are the order and " +
        "the words are the client's. A due date is a day, `YYYY-MM-DD`, and a due " +
        "date that has passed is a fact about the card, not a system failure.",
    ],
    views: [
      {
        key: "default",
        path: "/api/board",
        about: "Every column with its cards in order, plus the totals.",
        params: [],
      },
    ],
    actions: [
      {
        key: "create_card",
        method: "POST",
        path: "/api/board/cards",
        about:
          "Write a new card down. It lands at the FOOT of its column. Answers with " +
          "the whole board; the new card is the last one in that column.",
        params: [
          {
            name: "title",
            type: "string",
            required: true,
            about: "The one line the card is. Trimmed; at most 200 characters, refused above that.",
          },
          {
            name: "body",
            type: "string",
            required: false,
            about:
              "The note under the title, or null for none. At most 8000 characters, " +
              "refused above that rather than truncated.",
          },
          {
            name: "column",
            type: "string",
            required: false,
            fallback: "backlog",
            about:
              "Which column, by its key (`backlog`, `next`, `doing`, `blocked`, `done` " +
              "on the seeded board) or by its numeric id. Absent means Backlog. A card " +
              "created straight into Done is stamped finished on the way in.",
          },
          {
            name: "urgency",
            type: "number",
            required: false,
            fallback: 1,
            about: "0 low, 1 normal, 2 high, 3 urgent. Anything else is refused.",
          },
          {
            name: "due",
            type: "string",
            required: false,
            about:
              "The day it is due, as `YYYY-MM-DD`, or null for none. Only that format " +
              "— \"next tuesday\" is refused, and a date that does not exist is refused.",
          },
          {
            name: "ventureId",
            type: "string",
            required: false,
            about: "The venture this is about — an id from the `ventures` skill — or null.",
          },
        ],
      },
      {
        key: "update_card",
        method: "PATCH",
        path: "/api/board/cards/:id",
        about:
          "Change what a card says. A field you leave out is untouched; a field sent " +
          "as null is CLEARED. Send only what changed — resending the whole card " +
          "overwrites an edit the owner made a second ago. Send at least one field.",
        params: [
          {
            name: "id",
            type: "number",
            required: true,
            in: "path",
            about: "The card's numeric id, from the board document.",
          },
          {
            name: "title",
            type: "string",
            required: false,
            about:
              "The new title, at most 200 characters. It cannot be cleared: a card " +
              "with no title is not a card.",
          },
          {
            name: "body",
            type: "string",
            required: false,
            about: "The new note, at most 8000 characters, or null to clear it.",
          },
          {
            name: "urgency",
            type: "number",
            required: false,
            about: "0 low, 1 normal, 2 high, 3 urgent.",
          },
          {
            name: "due",
            type: "string",
            required: false,
            about: "A new due date as `YYYY-MM-DD`, or null to remove the one it has.",
          },
          {
            name: "ventureId",
            type: "string",
            required: false,
            about: "A venture id from the `ventures` skill, or null to unfile the card.",
          },
        ],
      },
      {
        key: "move_card",
        method: "POST",
        path: "/api/board/cards/:id/move",
        about:
          "Put a card in a column, above a named neighbour or at the foot of it. " +
          "Arriving in Done stamps when it was finished; leaving Done clears that " +
          "stamp, because a card back in Doing is not a finished card with a date.",
        params: [
          {
            name: "id",
            type: "number",
            required: true,
            in: "path",
            about: "The card to move.",
          },
          {
            name: "columnId",
            type: "string",
            required: true,
            about:
              "The column to move it into, by key (`backlog`, `next`, `doing`, " +
              "`blocked`, `done`) or by numeric id.",
          },
          {
            name: "before",
            type: "number",
            required: false,
            about:
              "The id of the card to land IMMEDIATELY ABOVE, or absent/null for the " +
              "foot of the column. It is a neighbour and never an index — a position " +
              "number from the document means nothing here and must never be sent. If " +
              "that card is no longer in that column the move is refused with a 409 " +
              "saying the board moved: read the board again rather than guessing.",
          },
        ],
      },
      {
        key: "archive_card",
        method: "POST",
        path: "/api/board/cards/:id/archive",
        about:
          "Take a card out of the way without losing it. It keeps its column, its " +
          "position and its done stamp, and every read of the board filters it out. " +
          "Archiving an already archived card changes nothing and is not an error.",
        params: [
          {
            name: "id",
            type: "number",
            required: true,
            in: "path",
            about: "The card to archive.",
          },
        ],
      },
      {
        key: "delete_card",
        method: "DELETE",
        path: "/api/board/cards/:id",
        about:
          "Remove the row. THERE IS NO UNDO — not here, not in the page, not in a " +
          "backup. Archive instead unless the owner has said, in this conversation, " +
          "to delete this particular card.",
        params: [
          {
            name: "id",
            type: "number",
            required: true,
            in: "path",
            about: "The card to delete.",
          },
        ],
        destructive: true,
      },
    ],
    asks: [
      "What is on my board right now, and what is overdue?",
      "Add a card to Next: chase the Stripe dispute, due Friday.",
    ],
  },

  {
    id: "search",
    title: "Web search — the local SearXNG node",
    plugins: ["searxng"],
    about:
      "A TOOL, not a report: it performs a live web search through whichever " +
      "SearXNG instance is active and hands back the links. Nothing about it is " +
      "a measurement of this business.",
    rules: [
      "This is the one skill here that reaches OFF this machine and it happens " +
        "when you call it. Everything else reads what a collector already " +
        "gathered.",
      "The results are somebody else's index. They are evidence of what is on the " +
        "web, not of what this business did.",
      "A node that is down answers with an error rather than an empty result set; " +
        "an empty result set means the node answered and found nothing.",
    ],
    views: [
      {
        key: "default",
        path: "/api/search",
        about: "One search, through the active SearXNG instance.",
        params: [
          { name: "q", type: "string", required: true, about: "The search query." },
          {
            name: "page",
            type: "number",
            required: false,
            fallback: 1,
            about: "Which page of results.",
          },
          {
            name: "categories",
            type: "string",
            required: false,
            about: "SearXNG categories, comma separated (e.g. `general`, `news`).",
          },
          {
            name: "engines",
            type: "string",
            required: false,
            about: "Restrict to named engines, comma separated.",
          },
          { name: "language", type: "string", required: false, about: "Language code, e.g. `en`." },
        ],
      },
    ],
    asks: [
      "Search the web for what a competitor announced this week.",
    ],
    openWorld: true,
  },
];

/**
 * Every entry: the built-ins above, then each integration area's own — see
 * integrations/manifest.ts. Spread at import, which is safe only while no
 * manifest imports THIS file at value level — an area that needs the base URL
 * takes PORT from config.ts rather than apiBase() from here.
 */
export const ENTRIES: Skill[] = [...BUILTIN_ENTRIES, ...manifestSkills()];


/* ------------------------------------------------------------- what is live */

/**
 * Is this entry's data actually reachable right now?
 *
 * ANY of the named plugins being connected is enough — see the header. An
 * entry with no plugins at all is always live, which today is the board.
 *
 * Read on every call rather than cached: a plugin connected two minutes ago
 * should be answerable now, and this is one indexed row per plugin.
 */
export function isLive(entry: Skill): boolean {
  if (entry.plugins.length === 0) return true;
  return entry.plugins.some((id) => getPlugin(id)?.connected === 1);
}

/** Which of an entry's plugins are actually the ones answering. Reported, so a
 *  reader can tell "both registrars" from "Dynadot only". */
export function livePlugins(entry: Skill): string[] {
  return entry.plugins.filter((id) => getPlugin(id)?.connected === 1);
}

/** The catalog as it stands right now: only what is connected. */
export function skills(): Skill[] {
  return ENTRIES.filter(isLive);
}

/** One entry by id, connected or not — the routes decide what to do about it. */
export function entry(id: string): Skill | null {
  return ENTRIES.find((s) => s.id === id) ?? null;
}

/** The view a request selected, or null if it named one that does not exist.
 *  An absent `view` is the first one, which is the entry's default. */
export function view(s: Skill, key: string | null | undefined): SkillView | null {
  if (!key) return s.views[0] ?? null;
  return s.views.find((v) => v.key === key) ?? null;
}

/* -------------------------------------------------------------- the base URL */

/**
 * Where an agent should send its requests.
 *
 * Built from the same PORT the server binds, so it cannot disagree with
 * reality — an agent handed a hardcoded 8787 by a config that had been changed
 * would fail with a connection refused and no way to know why.
 */
export function apiBase(): string {
  return `http://127.0.0.1:${PORT}`;
}

/* ------------------------------------------------------------- the preamble */

/**
 * The fallback for an agent with no skill mechanism of its own — a remote
 * Hermes, a remote OpenClaw, anything that arrives later.
 *
 * IT IS DELIBERATELY SHORT. A managed agent gets the whole registry as skill
 * packs it loads on demand; this is what fits in a system turn without pushing
 * the conversation out of the window, so it is the base URL, one line per
 * connected skill, and the four rules that are true of every document. An
 * agent that has this knows the data EXISTS and how to ask for the rest;
 * `GET /api/skills` is the rest.
 *
 * THE LINES ARE IDS AND PARAMETERS, NOT DESCRIPTIONS, and that is the one real
 * decision in this function. Eighteen one-sentence descriptions plus the four
 * rules is about two thousand characters, so something has to give — and what
 * gives is the descriptions rather than the names, because a name the agent has
 * never seen is a question it will answer out of its own head, while a name
 * without a description is one `GET /api/skills` away from a full explanation.
 * The rules are never trimmed at all: a truncated list of tools is a smaller
 * loss than a truncated list of rules.
 *
 * The cap is a real cap rather than a hope — the lines are dropped from the end
 * until the whole thing fits — and it was raised from 1500 to 1800 when actions
 * arrived, because at 1500 it had begun to drop. Two entries were added and the
 * head gained a sentence about writing, and what fell off the end was
 * `ventures`, `board` and `search` — which is to say both of the ids that can
 * CHANGE something and the only one that reaches the internet. The tail is
 * dropped last-first because registry order is roughly importance order, and
 * that stopped being true the moment the interesting entries were appended to
 * the bottom of the list. Raising the number is the honest fix; reordering the
 * registry to protect a character count would be arranging the source to suit
 * a string.
 */
export function preamble(limit = 2000): string {
  const base = apiBase();
  const head =
    `You can read this dashboard's own live data over HTTP. ` +
    `GET ${base}/api/skills/<id> returns one JSON document; ` +
    `GET ${base}/api/skills says what each id is, its parameters and its own ` +
    `reporting rules — read it before quoting a figure. Reads are GETs; the ids ` +
    `marked +writes also take actions — POST JSON to ` +
    `${base}/api/skills/<id>/<action>, listed there with their rules.` +
    `\n\nIds available now (parameters in brackets):\n`;
  const rules = `\nAlways:\n${UNIVERSAL_RULES.map((r) => `- ${r}`).join("\n")}\n`;
  const lines = skills().map((s) => {
    const params = s.views[0]?.params.map((p) => p.name).join(",");
    /* The marker is a flag and not a list. Naming the seven action keys here
       would cost more than every parameter on every other line put together, to
       say something `/api/skills` says in full a request later; what the agent
       cannot work out for itself is WHICH ids have any. */
    const writes = s.actions?.length ? " +writes" : "";
    return `- ${s.id}${params ? ` (${params})` : ""}${writes}`;
  });

  let body = lines.join("\n");
  while (lines.length > 1 && head.length + body.length + rules.length > limit) {
    lines.pop();
    body = `${lines.join("\n")}\n- …and more, see ${base}/api/skills`;
  }
  /* How to draw the figures, after the rules and never trimmed: an agent that
     can read a document should also be able to show it. */
  return `${head}${body}\n${rules}\n${PRESENT_BRIEF}\n`;
}
