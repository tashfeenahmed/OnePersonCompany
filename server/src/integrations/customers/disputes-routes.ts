/**
 * DISPUTES, COUNTED FROM CASES — and the ledger figure kept beside them as a
 * cross-check rather than replaced by them.
 *
 * /api/activity/leakage used to say this out loud: "the COUNT is 0 because
 * there is no dispute-level table on this box: the ledger records the debit,
 * not the case." There is one now, and the honest thing to do with the old
 * figure is not to delete it but to publish both and name what each one
 * measures — because they will not agree, and every way they disagree is
 * informative:
 *
 *   THE CASE FIGURE is `SUM(amount)` over stripe_disputes, dated by when the
 *   cardholder's bank OPENED the case, excluding Stripe's dispute fee.
 *
 *   THE LEDGER FIGURE is `SUM(disputes) + SUM(dispute_fees)` over
 *   stripe_ledger_days, dated by the balance POSTING, including the fee,
 *   which is charged whatever the outcome.
 *
 * A case opened on 28 August and debited on 2 September is in one window and
 * not the other. A case WON has money returned to the balance, which the
 * ledger shows as a positive reversal and the case table shows as an outcome.
 * So the two are published side by side with a `difference` and a sentence
 * about why there is one, and nothing on this route adds them.
 *
 * DEADLINES ARE PUBLISHED TWICE — the ISO instant in UTC, and the same moment
 * rendered in the owner's own zone — because an evidence cut-off is the one
 * date on this box where being wrong by a day loses money by default, and
 * "23:59 UTC" and "00:59 tomorrow" are the same moment described two ways.
 */
import { Hono } from "hono";
import { ventureRows } from "../../db.ts";
import { NEEDS_RESPONSE_STATUSES, OPEN_DISPUTE_STATUSES } from "../../providers/stripe.ts";
import { currencyCode, money } from "../../shared/money.ts";
import {
  disputes as storedDisputes,
  disputeCount,
  ledgerDisputes as ledgerDisputeMoney,
  settings,
  type DisputeRecord,
} from "./store.ts";

export const disputeRoutes = new Hono();

/** The same instant in the owner's zone, as words. Never replaces the ISO
 *  value — it sits beside it. */
function local(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(at);
}

function shape(d: DisputeRecord, timezone: string, names: Map<string, string>) {
  const open = OPEN_DISPUTE_STATUSES.has(d.status);
  const dueMs = d.evidence_due_by ? Date.parse(d.evidence_due_by) : Number.NaN;
  return {
    id: d.id,
    account: d.account_label,
    venture: d.venture_id,
    ventureName: d.venture_id ? (names.get(d.venture_id) ?? null) : null,
    charge: d.charge,
    amount: d.amount,
    currency: currencyCode(d.currency),
    reason: d.reason,
    /** Stripe's own word. Kept verbatim because it is the word the account's
     *  risk page uses and a paraphrase would not match what the owner sees. */
    status: d.status,
    /** won | lost | null. NULL is "live, or closed with no verdict" and is
     *  never read as a win. */
    outcome: d.outcome,
    open,
    needsResponse: NEEDS_RESPONSE_STATUSES.has(d.status),
    evidenceDueBy: d.evidence_due_by,
    evidenceDueLocal: local(d.evidence_due_by, timezone),
    hoursLeft: Number.isNaN(dueMs) ? null : Math.round((dueMs - Date.now()) / 3_600_000),
    submissionCount: d.submission_count,
    openedAt: d.created_at,
    /** The first moment THIS BOX saw a terminal status. Stripe publishes no
     *  closed timestamp, so it is only ever as precise as the pass interval. */
    firstSeenClosedAt: d.closed_at,
    seenAt: d.seen_at,
  };
}

disputeRoutes.get("/", (c) => {
  const s = settings();
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 90) || 90, 1), 400);
  const fromDay = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const fromIso = `${fromDay}T00:00:00.000Z`;
  const names = new Map(ventureRows().map((v) => [v.id, v.name]));

  const all = storedDisputes({ limit: 2000 });
  const inWindow = all.filter((d) => d.created_at >= fromIso);
  const openAll = all.filter((d) => d.outcome === null && OPEN_DISPUTE_STATUSES.has(d.status));

  const currencies = [...new Set(all.map((d) => currencyCode(d.currency)))].sort();
  const ledger = ledgerDisputeMoney(fromDay);

  const perCurrency = currencies.map((currency) => {
    const is = (d: { currency: string }) => currencyCode(d.currency) === currency;
    const mine = inWindow.filter(is);
    const open = openAll.filter(is);
    const won = mine.filter((d) => d.outcome === "won");
    const lost = mine.filter((d) => d.outcome === "lost");
    const le = ledger.get(currency) ?? { disputes: 0, disputeFees: 0 };
    const ledgerDisputes = le.disputes;
    const ledgerFees = le.disputeFees;
    const caseLost = money(lost.reduce((n, r) => n + r.amount, 0));

    return {
      currency,
      window: `${days}d`,
      cases: {
        /** Opened inside the window, whatever they have become since. */
        opened: mine.length,
        openedAmount: money(mine.reduce((n, r) => n + r.amount, 0)),
        won: won.length,
        wonAmount: money(won.reduce((n, r) => n + r.amount, 0)),
        lost: lost.length,
        lostAmount: caseLost,
        /** Still live — CURRENT STATE, not windowed. A dispute opened four
         *  months ago and still under review is open today, and a window
         *  figure would hide exactly the case that needs answering. */
        openNow: open.length,
        openNowAmount: money(open.reduce((n, r) => n + r.amount, 0)),
        needsResponseNow: open.filter((d) => NEEDS_RESPONSE_STATUSES.has(d.status)).length,
        /** The soonest evidence cut-off among cases still needing a response.
         *  The one date on this document somebody has to act before. */
        nextEvidenceDueBy:
          open
            .filter((d) => NEEDS_RESPONSE_STATUSES.has(d.status) && d.evidence_due_by)
            .map((d) => d.evidence_due_by!)
            .sort()[0] ?? null,
        arithmetic:
          `COUNT and SUM(amount) over stripe_disputes, dated by the case's own created ` +
          `timestamp, for the last ${days} days, in ${currency}. The disputed ` +
          `amount only — Stripe's dispute FEE is not in any figure here.`,
      },
      ledger: {
        /** The same subject, measured the other way. Published for the
         *  cross-check and never added to the case figures. */
        moneyOut: money(ledgerDisputes + ledgerFees),
        disputes: ledgerDisputes,
        disputeFees: ledgerFees,
        arithmetic:
          `SUM(disputes) + SUM(dispute_fees) over stripe_ledger_days for the last ${days} days ` +
          `— SETTLEMENT, dated by the balance posting, and including the fee Stripe charges ` +
          `whatever the outcome.`,
      },
      /** case-lost minus ledger money-out, for this window. It is not an
       *  error term and it is not expected to be zero. */
      difference: money(caseLost - (ledgerDisputes + ledgerFees)),
      differenceIs:
        "cases LOST in this window minus money the ledger recorded leaving in it. The two " +
        "are dated differently (case opened vs balance posted), the ledger includes the " +
        "dispute fee and the case figure does not, and a case won returns money the ledger " +
        "already took. A non-zero difference is the normal state.",
    };
  });

  return c.json({
    window: { days, from: fromDay },
    timezone: s.timezone,
    timezoneFrom: s.timezoneFrom,
    /* NO PORTFOLIO TOTAL. The same rule every money route here keeps: this box
       fetches no exchange rate, so two currencies is two answers. */
    combined: null,
    currencies: perCurrency,
    counts: {
      /** By Stripe's own status, over every dispute this box holds, current
       *  state. A distribution, not a window. */
      byStatus: Object.fromEntries(
        [...new Set(all.map((d) => d.status))].sort().map((st) => [
          st,
          all.filter((d) => d.status === st).length,
        ]),
      ),
      byOutcome: {
        won: all.filter((d) => d.outcome === "won").length,
        lost: all.filter((d) => d.outcome === "lost").length,
        /** Neither. Live cases AND cases Stripe closed with no verdict —
         *  `warning_closed` is the bank withdrawing before it became a formal
         *  dispute, and it is not a win. */
        undecided: all.filter((d) => d.outcome === null).length,
      },
      total: all.length,
    },
    /** Every live case, soonest cut-off first. Cases with no published due
     *  date sit under the dated ones. */
    open: openAll
      .slice()
      .sort((a, b) => {
        const av = a.evidence_due_by ?? "";
        const bv = b.evidence_due_by ?? "";
        if (!av && !bv) return a.created_at.localeCompare(b.created_at);
        if (!av) return 1;
        if (!bv) return -1;
        return av.localeCompare(bv);
      })
      .map((d) => shape(d, s.timezone, names)),
    recent: inWindow.slice(0, 100).map((d) => shape(d, s.timezone, names)),
    coverage: {
      stored: disputeCount(),
      note:
        disputeCount() === 0
          ? "No dispute has been ingested. That is either an account with no disputes or a key " +
            "without permission to read them — the Customers integration's last run says which. " +
            "It is not a zero."
          : "Every pass rewalks the last ninety days and any case still open, so a status that " +
            "changed since is current. Cases older than that with a settled outcome are read once.",
    },
    cannot: [
      "a dispute RATE. Stripe measures disputes against SUCCESSFUL TRANSACTIONS lifetime, and this box holds a charge-day table that starts wherever the backfill got to. A ratio computed here would have roughly the right order and entirely the wrong denominator — and it is the number a risk reviewer would be quoted.",
      "submit evidence. This integration is GET-only by construction; evidence is uploaded in the Stripe dashboard, and the deadline above is when that has to have happened.",
      "attribute most disputes to a venture. A dispute names a CHARGE and a charge carries no product, so `venture` is filled only where every Stripe link on this box points at one business.",
    ],
  });
});
