/**
 * What came in, and what is contracted to keep coming in.
 *
 * ONE ROUTE FOR THE WHOLE BOARD, the way /api/costs is one route for the
 * spending side: a revenue dashboard asks the same question of the same rows
 * from a dozen cards, and a dozen requests to answer it once is a burst the
 * box does not need to serve.
 *
 * EVERY FIGURE HERE IS COMPUTED ON THE READ. Nothing in the database says
 * "MRR is $875"; it says "this subscription bills $29 a year, it started in
 * March and it has not ended", and the arithmetic happens when somebody asks.
 * A stored MRR is wrong the moment a subscription cancels and badly wrong
 * after a week of failed collections — which is the week somebody looks.
 *
 * TWO MEASUREMENTS THAT ARE NOT ADDED. `charges` is payment ATTEMPTS, dated by
 * the charge, and is the only place a decline exists. `revenue` is SETTLEMENT,
 * dated by the balance ledger's posting, and is the only place a fee exists.
 * Their two gross figures disagree by whatever crossed midnight, so they are
 * two objects on the wire and nothing crosses them. Net revenue is always the
 * ledger's answer.
 *
 * CURRENCY IS NEVER BLENDED. Every money figure below is a LIST keyed by
 * currency, even on an account that has only ever billed in one — because a
 * shape that can only hold one number is a shape that will silently add two
 * the day a second currency appears. The code is upper-case ISO 4217, the one
 * spelling this box uses, so a map merged with any other area's cannot hold
 * one currency under two keys.
 */
import { Hono } from "hono";
import {
  db,
  getPlugin,
  stripeBalances,
  stripeChargeDays,
  stripePayouts,
  stripeRecentCharges,
  stripeState,
  stripeSubscriptions,
  type StripeSubscriptionRecord,
} from "../db.ts";
import { HISTORY_CHUNK_DAYS, WALK_DAYS, isBilling } from "../providers/stripe.ts";
import { stripeSettled, ventureStripeBook } from "../integrations/finance/attribution.ts";
import { currencyCode, money } from "../shared/money.ts";
import * as accounts from "../accounts.ts";

export const stripeRoutes = new Hono();

/**
 * The windows churn and the money totals are cut to.
 *
 * Three rather than one, because a churn rate over seven days and one over
 * ninety are different questions and a dashboard that offers only the middle
 * one invites the reader to divide it themselves. Every one of them is
 * answerable from the same rows: the subscription walk is unbounded in time
 * and the day tables reach back as far as the ledger has been filled.
 */
export const WINDOWS = [7, 30, 90] as const;

/** Sixty days, which is where "ending soon" stops meaning anything. An annual
 *  subscription that turned off auto-renew on day one stays paid for eleven
 *  months; calling that "leaving" beside a monthly one that ends on Thursday
 *  is the lie every pending-churn figure tells until somebody fences it. */
const ENDING_SOON_DAYS = 60;

/** How many individual charges the document carries, newest first. The table
 *  holds ninety days of them, which on this account is nearer twelve hundred;
 *  a board lists a few dozen, and `recentTruncated` says when this cut bit. */
const RECENT_CAP = 200;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Has this plugin ever completed a collection?
 *
 * The difference between "$0" and "we do not know" is exactly this question. A
 * provider with no rows that has never run knows nothing and answers null; a
 * provider with no rows that ran fine an hour ago is reporting a real, empty
 * month. Folding them together puts a confident zero on a card whose
 * credential was refused.
 */
function everCollected(pluginId: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM runs WHERE plugin_id = ? AND ok = 1 LIMIT 1").get(pluginId),
  );
}

const connected = (id: string) => getPlugin(id)?.connected === 1;

/* --------------------------------------------------------------------- mrr */

/**
 * MRR, PER CURRENCY, AND THE NORMALISATION SAID OUT LOUD.
 *
 * An annual plan at $29 is counted as $2.4167 every month. That is the
 * standard convention and the only way a book of 444 annual and 254 monthly
 * items can be described by one figure at all — but it is arithmetic performed
 * ON the customer's cash flow rather than something Stripe reported, so the
 * split it rests on travels with it: `byInterval` says how much of the figure
 * is annual money spread out, and `basis` says the rule in a sentence a card
 * can print.
 *
 * WHAT IS NOT IN IT, and each for its own reason:
 *   trialing    — has never sent a cent. Counted in as revenue, it has to come
 *                 back out as churn when the trial ends.
 *   past_due    — billing and failing. Contracted revenue it is not.
 *   one-off     — a $3,000 research study and a $79 lifetime licence are real
 *                 money and are NOT recurring. They are in `charges` and in
 *                 `revenue` and they will never be in MRR.
 *   coupons     — already deducted; `discountedAway` is what came off.
 */
function mrrSection(subs: StripeSubscriptionRecord[]) {
  const billing = subs.filter((s) => isBilling(s.status));
  const currencies = [...new Set(billing.map((s) => currencyCode(s.currency)))].sort();

  return currencies.map((currency) => {
    const mine = billing.filter((s) => currencyCode(s.currency) === currency);
    const sum = (rows: StripeSubscriptionRecord[]) =>
      money(rows.reduce((n, s) => n + s.monthly_usd, 0));
    const annual = mine.filter((s) => s.bill_interval === "year");
    const monthly = mine.filter((s) => s.bill_interval === "month");
    const other = mine.filter(
      (s) => s.bill_interval !== "year" && s.bill_interval !== "month",
    );
    return {
      currency,
      amount: sum(mine),
      /** MRR annualised: the same contracted revenue over twelve months. Not a
       *  forecast, and not last year's takings. */
      arr: money(sum(mine) * 12),
      subscriptions: mine.length,
      byInterval: {
        monthly: { subscriptions: monthly.length, amount: sum(monthly) },
        annual: { subscriptions: annual.length, amount: sum(annual) },
        other: { subscriptions: other.length, amount: sum(other) },
      },
      /** List price not invoiced, per month, because of a recurring coupon.
       *  Already OUT of `amount` — this says how much, not how much more. */
      discountedAway: money(
        mine.reduce((n, s) => n + (s.listed_monthly_usd - s.monthly_usd), 0),
      ),
      discounted: mine.filter((s) => s.listed_monthly_usd > s.monthly_usd).length,
      basis:
        "Active subscriptions only, each price normalised to a month by its own " +
        "billing interval (an annual plan counts as a twelfth per month) and net of " +
        "recurring coupons. Trials, past-due subscriptions and one-off payments are " +
        "not in it.",
    };
  });
}

/* ------------------------------------------------------------------- churn */

/**
 * CHURN, WITH ITS DENOMINATOR NAMED — because there are four defensible ones
 * and a rate quoted without saying which is not a measurement.
 *
 * The rate here is REVENUE churn: MRR that the window opened with and has
 * since gone, over the book the window opened with. The starting book is
 * reconstructed — today's MRR, minus what has been added since, plus what has
 * been lost since — which is exact for additions and losses and IGNORES
 * upgrades and downgrades, because a subscription that changed plan leaves no
 * trace of its old price on the object. So it is marked `approximate`, and it
 * drifts further at ninety days than at seven.
 *
 * Subscriptions that started AND ended inside the window are out of BOTH
 * sides: they were never part of the book they would otherwise be a percentage
 * of. `newMrr` counts them on the other side of the same rule — money that has
 * started — so a month that gained and lost the same customer shows both
 * movements and no churn.
 *
 * A CANCELLATION THAT NEVER COLLECTED A PENNY IS NOT CHURN, and this is the
 * distinction that matters most on this account. Of 336 dead subscriptions,
 * 182 are expired checkouts that never activated and more are cancelled free
 * trials; together they are worth $0 and losing them cost nothing. Counting
 * them the naive way once produced $415 of imaginary churn in a $430 month —
 * revenue that had never existed — while the one real loss in the window was a
 * three-year customer whose card died. They are counted here, in their own
 * two buckets, and kept out of `churnedMrr`, `churnedSubs`, `netMrr` and both
 * rates:
 *
 *   trialNonConversion — had a trial, cancelled it. A conversion problem.
 *   failedActivation   — never had a trial and never paid: a checkout that
 *                        expired. An acquisition problem, in a different part
 *                        of the funnel entirely.
 *
 * `unresolvedCancellations` is how many rows have not yet had their invoice
 * question asked. They count as PAID until answered, because an unreachable
 * invoice list must never quietly reclassify a real loss as a trial and
 * flatter the retention story.
 */
function churnSection(subs: StripeSubscriptionRecord[], nowMs: number) {
  const billing = subs.filter((s) => isBilling(s.status));
  const currencies = [
    ...new Set([...billing, ...subs.filter((s) => s.ended_at)].map((s) => currencyCode(s.currency))),
  ].sort();

  const rows = [];
  for (const days of WINDOWS) {
    const edge = new Date(nowMs - days * 86_400_000).toISOString();
    for (const currency of currencies) {
      const mine = subs.filter((s) => currencyCode(s.currency) === currency);
      const standing = mine
        .filter((s) => isBilling(s.status))
        .reduce((n, s) => n + s.monthly_usd, 0);

      const ended = mine.filter((s) => s.ended_at && s.ended_at >= edge);
      // paid_cents === 0 is a CONFIRMED zero and the only thing that demotes a
      // row out of churn. null is "not asked yet" and counts as paid.
      const neverBilled = ended.filter((s) => s.paid_cents === 0);
      const real = ended.filter((s) => s.paid_cents !== 0);
      const fromStart = real.filter((s) => s.created_at < edge);

      const started = mine.filter(
        (s) => s.created_at >= edge && isBilling(s.status),
      );
      const gained = started.reduce((n, s) => n + s.monthly_usd, 0);
      const lost = real.reduce((n, s) => n + s.monthly_usd, 0);
      const lostFromStart = fromStart.reduce((n, s) => n + s.monthly_usd, 0);
      const startBook = standing - gained + lostFromStart;
      const startSubs = billing.filter((s) => currencyCode(s.currency) === currency).length
        - started.length + fromStart.length;

      const trials = neverBilled.filter((s) => s.trial_start);
      const expired = neverBilled.filter((s) => !s.trial_start);
      const byProduct = new Map<string, { mrr: number; subs: number }>();
      for (const s of real) {
        const p = byProduct.get(s.product ?? "Other") ?? { mrr: 0, subs: 0 };
        p.mrr += s.monthly_usd;
        p.subs += 1;
        byProduct.set(s.product ?? "Other", p);
      }

      if (!ended.length && !started.length && !standing) continue;

      rows.push({
        days,
        currency,
        mrr: money(standing),
        newMrr: money(gained),
        newSubs: started.length,
        churnedMrr: money(lost),
        churnedSubs: real.length,
        netMrr: money(gained - lost),
        /** Revenue churn: the headline. Null when the reconstructed book is
         *  zero or negative — a rate over nothing is not a small rate. */
        ratePct: startBook > 0 ? Number(((lostFromStart / startBook) * 100).toFixed(2)) : null,
        /*
          THE RATE'S ACTUAL NUMERATOR, published beside its denominator.
          `churnedMrr` is everything that churned in the window and is the
          bigger, more quotable figure; the RATE uses only the part that was in
          the book when the window opened, because a subscription that started
          and ended inside it was never part of what it is a percentage of. A
          card quoting churnedMrr over startBookMrr would be dividing two
          numbers that do not divide, and would disagree with the rate printed
          next to it.
        */
        churnedFromStartMrr: money(lostFromStart),
        churnedFromStartSubs: fromStart.length,
        startBookMrr: money(startBook),
        /*
          THE QUICK RATIO — MRR gained over MRR lost in the window, the SaaS
          quick ratio ChartMogul and Baremetrics publish:
            (new + expansion + reactivation) / (churned + contraction).
          4 or more is the usual "healthy" line; under 1 the book is shrinking.
          EXPANSION AND CONTRACTION ARE NOT IN IT: a subscription that changed
          plan leaves no trace of its old price on the object, so upgrades and
          downgrades are invisible here exactly as they are to `ratePct`. This
          is new-versus-churned only, and marked so. A customer who comes back
          on a new subscription is new MRR, which is how reactivation lands.
          A subscription that started AND ended inside the window is on BOTH
          sides — it did arrive and it did leave — which is the published
          definition. `newMrr` counts only what is still billing, so the gained
          side is published on its own (`quickRatioInMrr`) rather than left for
          a card to reconstruct. Never-billed cancellations (expired checkouts,
          cancelled trials) are on neither side, as they are out of churn.
          null when nothing churned: x/0 is not a ratio. `quickRatioInMrr` and
          `quickRatioOutMrr` still say whether that was growth or a still window.
        */
        quickRatio: lost > 0 ? Number(((gained + (lost - lostFromStart)) / lost).toFixed(2)) : null,
        quickRatioInMrr: money(gained + (lost - lostFromStart)),
        quickRatioOutMrr: money(lost),
        /** The same question asked of HEADS rather than of money, because a
         *  churned $99 plan and a churned $1 plan are one row each here and
         *  nothing alike above. Its own denominator, named the same way. */
        subRatePct:
          startSubs > 0 ? Number(((fromStart.length / startSubs) * 100).toFixed(2)) : null,
        startSubs,
        notChurn: {
          trialNonConversion: {
            subscriptions: trials.length,
            /** What they would have been worth had they converted. Never a
             *  loss: this money never existed. */
            wouldHaveBeen: money(trials.reduce((n, s) => n + s.monthly_usd, 0)),
          },
          failedActivation: {
            subscriptions: expired.length,
            wouldHaveBeen: money(expired.reduce((n, s) => n + s.monthly_usd, 0)),
          },
        },
        involuntary: real.filter(
          (s) => s.reason === "payment_failed" || s.reason === "payment_disputed",
        ).length,
        byProduct: [...byProduct.entries()]
          .map(([product, v]) => ({ product, mrr: money(v.mrr), subscriptions: v.subs }))
          .sort((a, b) => b.mrr - a.mrr),
        basis:
          "MRR the window opened with that has since churned, over that starting book — " +
          "reconstructed as today's MRR minus what has been added plus those losses. " +
          "Subscriptions that started and ended inside the window are out of both sides. " +
          "Cancellations that never collected a payment are not churn and are counted in " +
          "notChurn instead.",
        approximate: true,
      });
    }
  }
  return rows;
}

/* ----------------------------------------------------------------- revenue */

/**
 * The ledger, summed per currency over the window, with the fee split intact.
 * `net` is the ledger's own net and satisfies
 * gross - refunds - disputes - feesTotal + other to the cent.
 *
 * THE REDUCTION ITSELF LIVES IN THE FINANCE AREA, in `stripeSettled(from, to)`.
 * This route and the portfolio P&L used to reduce the same five columns of
 * `stripe_ledger_days` with different windows, different rounding and the
 * currency spelled two ways — so the two headlines disagreed and nothing
 * downstream could join them. The window is still this route's decision; the
 * arithmetic and the currency code are not.
 */
function revenueSection(days: number, nowMs: number) {
  const from = utcDay(nowMs - (days - 1) * 86_400_000);
  return stripeSettled(from, utcDay(nowMs)).map(({ days: series, ...c }) => ({
    ...c,
    days,
    /** Stripe's cut as a share of gross — from `fees`, never `feesTotal`.
     *  Deriving it from the total is how an 8% cost reads as 15%. `fees` is
     *  EX-TAX; `taxWithheld` is sales tax Stripe remits onward, a pass-through
     *  and not a cost, which is why it has a line and a rate of its own. */
    feeRatePct: c.gross > 0 ? Number(((c.fees / c.gross) * 100).toFixed(2)) : null,
    taxRatePct: c.gross > 0 ? Number(((c.taxWithheld / c.gross) * 100).toFixed(2)) : null,
    series,
    note:
      "From the Stripe balance ledger, not a rate card: the fee Stripe actually took, " +
      "including the ones a rate card never mentions. net = gross - refunds - disputes " +
      "- feesTotal + other. Dated by settlement, so it does not add to the charge series.",
  }));
}

/* ----------------------------------------------------------------- charges */

/** Payment attempts per day, per currency: the only cut that can see a
 *  failure. Succeeded charges only in `gross`, as every chart assumes. */
function chargeSection(days: number, nowMs: number) {
  const from = utcDay(nowMs - (days - 1) * 86_400_000);
  const rows = stripeChargeDays(from);
  const currencies = [...new Set(rows.map((r) => currencyCode(r.currency)))].sort();

  return currencies.map((currency) => {
    const mine = rows.filter((r) => currencyCode(r.currency) === currency);
    const byDay = new Map<string, { gross: number; refunded: number; succeeded: number; failed: number; blocked: number; declined: number }>();
    for (const r of mine) {
      const d = byDay.get(r.day) ?? {
        gross: 0, refunded: 0, succeeded: 0, failed: 0, blocked: 0, declined: 0,
      };
      d.gross += r.gross;
      d.refunded += r.refunded;
      d.succeeded += r.succeeded;
      d.failed += r.failed;
      d.blocked += r.blocked;
      d.declined += r.declined;
      byDay.set(r.day, d);
    }
    const total = (f: (r: (typeof mine)[number]) => number) =>
      mine.reduce((n, r) => n + f(r), 0);
    const succeeded = total((r) => r.succeeded);
    const declined = total((r) => r.declined);
    return {
      currency,
      days,
      gross: money(total((r) => r.gross)),
      refunded: money(total((r) => r.refunded)),
      refunds: total((r) => r.refunds),
      succeeded,
      failed: total((r) => r.failed),
      /*
        BLOCKED AND DECLINED NEVER SHARE A DENOMINATOR. A blocked attempt is
        Radar stopping card testing before a bank ever saw it — the system
        working, and nothing anybody can act on. A decline is a real customer's
        bank saying no. On this account the two together are half of all
        attempts, and reporting that as a payment failure rate would be an
        alarm about an attack rather than about the business.
      */
      blocked: total((r) => r.blocked),
      declined,
      /** Of the attempts a bank actually saw. Blocks are not in either half. */
      declineRatePct:
        succeeded + declined > 0
          ? Number(((declined / (succeeded + declined)) * 100).toFixed(1))
          : null,
      series: [...byDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, v]) => ({
          day,
          gross: money(v.gross),
          refunded: money(v.refunded),
          succeeded: v.succeeded,
          failed: v.failed,
          blocked: v.blocked,
          declined: v.declined,
        })),
      note:
        "Payment attempts, dated by the charge. Gross is succeeded charges only and " +
        "includes one-off payments, which are not in MRR. Refunds are counted against " +
        "the day of the charge, not the day of the refund.",
    };
  });
}

/* ------------------------------------------------------------------ recent */

/**
 * The charges themselves, newest first — the rows the day table above was
 * folded from, for the ninety days the walk keeps them.
 *
 * NOT CUT TO THE ROUTE'S WINDOW. The card slices by the window it is drawn
 * over, and `held` says how far back the rows go, so a ninety-day list under
 * a year-long window is labelled as ninety days rather than read as a quiet
 * year. The address is already masked in the table and is passed through as
 * it is; `failure` is Stripe's sentence for a decline, falling back to its
 * code when there is no sentence.
 */
function recentSection() {
  const { rows, total, oldest } = stripeRecentCharges(RECENT_CAP);
  return {
    recent: rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      currency: currencyCode(r.currency),
      status: r.status,
      paid: r.paid === 1,
      refunded: r.refunded === 1,
      createdAt: r.created_at,
      description: r.description,
      email: r.email_masked,
      failure: r.failure_message ?? r.failure_code,
      failureCode: r.failure_code,
      outcomeType: r.outcome_type,
    })),
    recentTruncated: total > rows.length,
    recentHeld: {
      /** The collector keeps this many days of individual charges. */
      days: WALK_DAYS,
      /** The day of the oldest charge actually held, or null before any. */
      from: oldest ? oldest.slice(0, 10) : null,
      total,
      note:
        "Individual charges are kept for the " + WALK_DAYS + " days the collector rewalks " +
        "and pruned past that edge, so a list under a wider window is that span and not " +
        "the window. The day aggregates above keep the whole history.",
    },
  };
}

/* ------------------------------------------------------------ per venture */

/**
 * THE SAME BOOK, CUT BY BUSINESS — and the only cut on this document an alert
 * rule can name.
 *
 * WHY IT IS AN OBJECT KEYED BY VENTURE ID rather than the array every other
 * breakdown here is. A rule is an address: skill, view, parameters and a
 * dotted path, and the path language addresses object keys and NUMERIC array
 * indexes. `byVenture.v-abc123.mrr` means one business for as long as that
 * business exists; `byVenture[2].mrr` would quietly become a different one the
 * day a venture is added above it, and the rule would go on tripping under the
 * old name.
 *
 * ONLY VENTURES WITH A LINKED STRIPE PRODUCT APPEAR. A venture nobody has
 * linked would be published as a row of zeroes, which reads as "this business
 * earns nothing" rather than "this box has not been told which products are
 * its" — the same distinction between null and zero the whole document keeps.
 *
 * WHAT A RULE SHOULD WATCH, said here because this is where somebody writing
 * one will look. `mrrAbsDelta` is the thirty-day move without its sign: the
 * engine's threshold operators compare in one direction and revenue moving is
 * a two-directional question, so `byVenture.<id>.mrrAbsDelta > 20` is "this
 * business's MRR moved by more than twenty" either way. `mrrMovePct` is the
 * same move as a percentage, for an owner who would rather write `> 10`.
 * `mrr` itself is the figure to watch with `changed`, and `oneOffCount` is the
 * one that notices that the lifetime purchases stopped.
 */
function ventureSection(days: number) {
  const rows = ventureStripeBook(days);
  return {
    byVenture: Object.fromEntries(rows.map((r) => [r.ventureId, r])),
    byVentureNote:
      "One entry per venture with a Stripe product linked to it, keyed by venture id so an " +
      "alert rule can address it (byVenture.<ventureId>.mrrAbsDelta). `mrr` is this venture's " +
      "share of the MRR above, on the same normalisation; `previousMrr` is the same figure " +
      "reconstructed as it stood " + days + " days ago from subscription start and end dates, " +
      "so it sees subscriptions that started or stopped and cannot see a price that changed. " +
      "`oneOff` is SETTLED CASH over the same window — lifetime and other one-off purchases, " +
      "which are not in MRR and never will be — and the two are never added. A scalar money " +
      "field is null where the venture bills in more than one currency; `mrrByCurrency` and " +
      "`oneOffByCurrency` hold the truth in that case, and null here means asked and not told.",
  };
}

/* ------------------------------------------------------------------- route */

stripeRoutes.get("/", (c) => {
  const asked = c.req.query("days");
  const state = [...stripeState().values()];
  /*
    `days=all` IS THE LEDGER'S OWN REACH, not a bigger clamp. The daily
    tables go back as far as the history walk has filled them — on this
    account to 2021 — and a cap of 400 would quietly hand a reader "all
    time" that stopped last summer. So "all" is measured from the earliest
    `historyFrom` any account reports, and a numeric ask keeps the cap: an
    unbounded number against an append-only table is still a way to ask for
    the whole database by accident.
  */
  const historyFrom = state.map((s) => s.historyFrom).filter(Boolean).sort()[0] ?? null;
  const days =
    asked === "all"
      ? Math.max(1, historyFrom ? Math.ceil((Date.now() - Date.parse(historyFrom)) / 86_400_000) + 1 : 400)
      : Math.min(Math.max(Number(asked ?? 30) || 30, 1), 400);
  const nowMs = Date.now();
  const isConnected = connected("stripe");
  const collected = everCollected("stripe");
  const subs = stripeSubscriptions();
  const billing = subs.filter((s) => isBilling(s.status));

  const pending = billing.filter((s) => s.cancel_at_period_end === 1);
  const soon = pending.filter(
    (s) => !s.cancel_at || Date.parse(s.cancel_at) <= nowMs + ENDING_SOON_DAYS * 86_400_000,
  );
  const perCurrency = (rows: StripeSubscriptionRecord[]) =>
    [...new Set(rows.map((s) => currencyCode(s.currency)))].sort().map((currency) => ({
      currency,
      amount: money(
        rows.filter((s) => currencyCode(s.currency) === currency).reduce((n, s) => n + s.monthly_usd, 0),
      ),
    }));

  const byProduct = new Map<string, { mrr: number; subs: number; currency: string }>();
  for (const s of billing) {
    const key = s.product ?? "Other";
    const p = byProduct.get(key) ?? { mrr: 0, subs: 0, currency: currencyCode(s.currency) };
    p.mrr += s.monthly_usd;
    p.subs += 1;
    byProduct.set(key, p);
  }
  const byPlan = new Map<string, { mrr: number; subs: number; currency: string }>();
  for (const s of billing) {
    const key = s.plan ?? s.product ?? "Other";
    const p = byPlan.get(key) ?? { mrr: 0, subs: 0, currency: currencyCode(s.currency) };
    p.mrr += s.monthly_usd;
    p.subs += 1;
    byPlan.set(key, p);
  }

  const balances = stripeBalances();
  const payouts = stripePayouts(10);
  const paid = payouts.filter((p) => p.status === "paid");
  const inFlight = payouts.filter((p) => p.status === "pending" || p.status === "in_transit");

  return c.json({
    window: { days },
    connected: isConnected,
    accounts: accounts.list("stripe").map((a) => ({
      id: a.id,
      label: a.label,
      connected: a.connected,
      lastOkAt: a.lastOkAt,
      lastError: a.lastError,
    })),
    /* null is "asked and not told": no subscriptions AND no successful
       collection. An account that collected fine and holds none is a real,
       empty book, and that is a zero. */
    mrr: subs.length || collected ? mrrSection(subs) : null,
    subscriptions: {
      /** The count MRR is built from. Not "live": a trial is live and is not
       *  money, and the two are never the same number here. */
      billing: billing.length,
      trialing: subs.filter((s) => s.status === "trialing").length,
      /** Billing and FAILING. Out of MRR, counted here, because it is the one
       *  of these three somebody can do something about today. */
      pastDue: subs.filter((s) => s.status === "past_due").length,
      canceled: subs.filter((s) => s.status === "canceled").length,
      /** A checkout that expired before its first payment ever succeeded.
       *  Never a customer, and never churn. */
      incompleteExpired: subs.filter((s) => s.status === "incomplete_expired").length,
      total: subs.length,
      pendingCancellation: {
        /** Still billing, still in MRR, gone at the end of the period. */
        count: pending.length,
        mrr: perCurrency(pending),
        endingSoon: {
          days: ENDING_SOON_DAYS,
          count: soon.length,
          mrr: perCurrency(soon),
        },
        note:
          "These are still billing and are still counted in MRR. An annual subscription " +
          "that switched off auto-renew stays paid for months, which is why the ones " +
          "ending inside " + ENDING_SOON_DAYS + " days are counted apart.",
      },
      /** Subscriptions whose cancellation has not yet been checked against
       *  their invoices. They count as real churn until it has been. */
      unresolvedCancellations: subs.filter(
        (s) => s.ended_at && s.paid_cents === null,
      ).length,
    },
    churn: churnSection(subs, nowMs),
    ...ventureSection(days),
    revenue: revenueSection(days, nowMs),
    charges: chargeSection(days, nowMs),
    ...recentSection(),
    products: [...byProduct.entries()]
      .map(([name, v]) => ({
        name,
        subscribers: v.subs,
        mrr: money(v.mrr),
        currency: v.currency,
      }))
      .sort((a, b) => b.mrr - a.mrr),
    plans: [...byPlan.entries()]
      .map(([name, v]) => ({
        name,
        subscribers: v.subs,
        mrr: money(v.mrr),
        currency: v.currency,
      }))
      .sort((a, b) => b.mrr - a.mrr)
      .slice(0, 12),
    balance: balances.map((b) => ({
      currency: b.currency,
      /** What could be paid out today. */
      available: b.available,
      /** Money Stripe has and will not release yet. Beside the available
       *  figure and never inside it — two different facts. */
      pending: b.pending,
      account: b.account_label,
      seenAt: b.seen_at,
    })),
    payouts: {
      last: paid[0]
        ? {
            amount: paid[0].amount,
            currency: paid[0].currency,
            arrivalDate: paid[0].arrival_date,
            automatic: paid[0].automatic === 1,
          }
        : null,
      inFlight: inFlight.map((p) => ({
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        arrivalDate: p.arrival_date,
      })),
      /*
        NO "NEXT PAYOUT" DATE, AND THAT IS A PROPERTY OF THE ACCOUNT. Every
        payout on it is manual — somebody presses the button — so Stripe
        publishes no schedule to read. The catalog's mock card said "next
        payout Friday", which was a promise the API cannot keep for this
        account, and it is not made here.
      */
      automatic: payouts.length ? payouts.every((p) => p.automatic === 1) : null,
      note: payouts.length
        ? payouts.every((p) => p.automatic === 1)
          ? "Payouts are automatic. Stripe still publishes no schedule, so the next date is not offered."
          : "Payouts on this account are manual, so there is no schedule and no next date."
        : "No payout has been seen yet.",
    },
    /*
      HOW MUCH OF THE PAST THESE DAY FIGURES ACTUALLY COVER. Every run rewalks
      ninety days and adds one older chunk, so a window wider than the history
      is a FLOOR rather than a total — and a reader who wants to know that
      should read it here rather than infer it from a chart that starts flat.
    */
    history: {
      from: historyFrom,
      complete: state.length > 0 && state.every((s) => s.backfilled),
      rewalkDays: WALK_DAYS,
      chunkDays: HISTORY_CHUNK_DAYS,
      note:
        "Every collection rewalks the last " + WALK_DAYS + " days — the span in which a " +
        "refund or a dispute can still move a day — and adds " + HISTORY_CHUNK_DAYS +
        " days of older history, until it finds nothing older. Settled days are read once.",
    },
    /** What this integration will not answer, said once so no card promises
     *  it. Each line is a question a reader will ask of these figures. */
    cannot: [
      "MRR as Stripe's own number — Stripe publishes none. It is computed here from subscription prices, and the normalisation is stated with every figure.",
      "revenue by product for a one-off paid OUTSIDE Checkout — an invoice settled by hand, a charge made in the dashboard. Those carry no session and so no product, and they are counted in gross and in net and in nobody's product. A one-off bought through Checkout or a Payment Link does carry its product, and is in `byVenture[].oneOff`; none of it is in MRR or in the subscription product mix, and it never will be.",
      "when the next payout lands — Stripe publishes no schedule, and on this account payouts are pressed by hand.",
      "churn to the cent — the starting book is reconstructed and cannot see upgrades or downgrades, which is why every churn row carries approximate.",
    ],
    seenAt:
      [...subs.map((s) => s.seen_at), ...balances.map((b) => b.seen_at)]
        .sort()
        .at(-1) ?? null,
    generatedAt: new Date().toISOString(),
  });
});
