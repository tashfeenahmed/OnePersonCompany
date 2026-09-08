import { Link } from "react-router-dom";
import { Chart, Figures } from "@/components/charts";
import { RankedBars } from "@/components/RankedBars";
import { cn } from "@/lib/utils";
import { count, day, inDays, money, pct } from "@/lib/format";
import type { MobileReport, StripeReport } from "@/lib/api";
import type { DisputeDoc, RecoveryCase, RecoveryQueue } from "@/lib/api/customers";
import { Basis, Card, CardHead, Group, Key, ProportionBar, Row, Tag } from "./chrome";
import { HUE } from "./hues";
import { drift, failRate, splitLeaving, sumMonthly } from "./math";

/**
 * THE DETAIL CARDS — everything under "The last N days, in detail".
 *
 * Each card reads ONE section of one document and says so in its header, so
 * a reader who wonders where a figure came from can find it on the wire.
 * Where the Workdash page this mirrors had a figure this box does not keep —
 * the individual charges, Stripe's decline codes — the card says what it
 * has instead of it, rather than drawing the nearest thing under the old name.
 */

type Charges = StripeReport["charges"][number];
type Revenue = StripeReport["revenue"][number];
type Churn = StripeReport["churn"][number];

const one = <T,>(rows: T[] | null | undefined): T | null => (rows && rows.length ? rows[0]! : null);

/* ---------------------------------------------------------- why it fails */

export function DeclineCard({ charges, days }: { charges: Charges | null; days: number }) {
  if (!charges) return null;
  const attempts = charges.succeeded + charges.failed;
  const rate = failRate(charges.succeeded, charges.failed);
  if (rate === null) return null;
  const d = drift(charges.series);
  const cur = charges.currency;

  return (
    <Card>
      <CardHead
        title="Why payments fail"
        sub={`${count(charges.failed)} failed attempts in the last ${days} days · what Stripe records about each`}
        action={<Tag kind="metered" />}
      />
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className={cn("text-[32px] font-semibold tracking-[-0.03em] tabular-nums", rate >= 25 && "text-destructive")}>
          {pct(rate / 100, { digits: 0 })}
        </span>
        <span className="text-muted-foreground text-[13px]">of {count(attempts)} attempts failed in the last {days} days</span>
      </div>
      <ProportionBar
        label={`Payment attempts over ${days} days`}
        parts={[
          { label: "succeeded", value: charges.succeeded, color: HUE.ok },
          { label: "blocked by Stripe", value: charges.blocked, color: HUE.warn },
          { label: "declined by the bank", value: charges.declined, color: HUE.bad },
        ]}
      />
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        <Key color={HUE.ok} label="succeeded">{count(charges.succeeded)}</Key>
        <Key color={HUE.warn} label="blocked by Stripe">{count(charges.blocked)}</Key>
        <Key color={HUE.bad} label="declined by the bank">{count(charges.declined)}</Key>
      </div>
      {d && (
        <p className="text-muted-foreground mt-2 text-[12.5px]">
          {pct(d.short / 100, { digits: 0 })} over 7d against {pct(d.long / 100, { digits: 0 })} over 30d —{" "}
          <span
            className={cn(
              "font-medium",
              d.verdict === "getting worse" && "text-destructive",
              d.verdict === "recovering" && "text-ok",
            )}
          >
            {d.verdict}
          </span>{" "}
          <span>(a fixed pair, not the window above)</span>
        </p>
      )}
      <Basis>
        Stripe's own two words for a failure. "Blocked" is Stripe's fraud checks refusing the card before the bank was
        asked — the system working, not a customer lost. "Declined" is a real customer's bank saying no, which a retry
        or a follow-up gets most of back. Anything else Stripe records is neither, and is in the failed count only.
        Decline codes and reasons are not stored on this box; the recovery queue holds the failing invoices one at a
        time.
      </Basis>
      <Figures
        headers={["Day", "Succeeded", "Blocked", "Declined", "Gross"]}
        rows={charges.series
          .slice()
          .reverse()
          .slice(0, 14)
          .map((s) => [day(s.day), count(s.succeeded), count(s.blocked), count(s.declined), money(s.gross, cur)])}
      />
      {charges.series.length > 14 && (
        <p className="text-muted-foreground mt-1 text-[11.5px]">The last 14 days of {charges.series.length}; the figures above count every day.</p>
      )}
    </Card>
  );
}

/* --------------------------------------------------------- daily revenue */

export function DailyRevenueCard({
  revenue,
  charges,
  days,
}: {
  revenue: Revenue | null;
  charges: Charges | null;
  days: number;
}) {
  if (!revenue && !charges) return null;
  const cur = revenue?.currency ?? charges?.currency ?? "USD";
  const series = [
    charges && {
      label: "Gross charges",
      points: charges.series.map((p) => ({ ts: p.day, value: p.gross })),
    },
    revenue && {
      label: "Net settled",
      points: revenue.series.map((p) => ({ ts: p.day, value: p.net })),
    },
  ].filter((s): s is { label: string; points: { ts: string; value: number }[] } => Boolean(s));
  const first = charges?.series[0]?.day ?? revenue?.series[0]?.day;
  const last = charges?.series.at(-1)?.day ?? revenue?.series.at(-1)?.day;

  return (
    <Card>
      <CardHead
        title="Daily revenue"
        sub={first && last ? `${days} days, ${day(first)} – ${day(last)} · gross charges beside what settled net` : `Per day · last ${days} days`}
        action={
          <>
            {charges && <Key color={HUE.one} label="gross">{money(charges.gross, cur)}</Key>}
            {revenue && <Key color={HUE.two} label="net">{money(revenue.net, cur)}</Key>}
          </>
        }
      />
      <Chart series={series} unit="usd" />
      <Basis>
        Charges, not recognised revenue: a yearly plan lands here as one spike and in the MRR tile as a twelfth of
        itself, so this line and that figure answer different questions. Gross is dated by the charge; net is the
        balance ledger, dated by the posting, after Stripe's fee, tax withheld, refunds and disputes. Whatever crossed
        midnight sits in different days on the two lines, which is why they are two lines.
      </Basis>
      {revenue && (
        <Figures
          headers={["Day", "Gross", "Fees", "Net"]}
          rows={revenue.series
            .slice()
            .reverse()
            .slice(0, 14)
            .map((s) => [day(s.day), money(s.gross, cur), money(s.fees, cur), money(s.net, cur)])}
        />
      )}
      {revenue && revenue.series.length > 14 && (
        <p className="text-muted-foreground mt-1 text-[11.5px]">The last 14 days of {revenue.series.length}; the line above draws every day.</p>
      )}
    </Card>
  );
}

/* --------------------------------------------------------- mrr movement */

export function MovementCard({
  churn,
  pending,
}: {
  churn: Churn | null;
  pending: StripeReport["subscriptions"]["pendingCancellation"];
}) {
  if (!churn) return null;
  const cur = churn.currency;
  const m = (n: number) => money(n, cur);
  const lost = churn.byProduct.slice(0, 3);
  const pendingMrr = one(pending.mrr);
  const soonMrr = one(pending.endingSoon.mrr);

  return (
    <Card>
      <CardHead title="MRR movement" sub={`Won against lost · last ${churn.days} days`} action={<Tag kind="approx" />} />
      <ProportionBar
        label={`New against churned MRR over ${churn.days} days`}
        parts={[
          { label: "new", value: churn.newMrr, color: HUE.ok },
          { label: "churned", value: churn.churnedMrr, color: HUE.bad },
        ]}
      />
      <div className="mt-1">
        <Row label={`New · ${count(churn.newSubs)} sub${churn.newSubs === 1 ? "" : "s"}`} value={`+${m(churn.newMrr)}`} tone="ok" />
        <Row label={`Churned · ${count(churn.churnedSubs)} sub${churn.churnedSubs === 1 ? "" : "s"}`} value={`−${m(churn.churnedMrr)}`} tone="bad" />
        {churn.involuntary > 0 && (
          <Row indent label={`card failed or disputed · ${count(churn.involuntary)}`} value="" />
        )}
        {lost.length > 0 && (
          <p className="text-muted-foreground pl-3 text-[12px] leading-snug">
            Lost from {lost.map((p) => `${p.product} (${m(p.mrr)})`).join(", ")}
            {churn.byProduct.length > lost.length ? ` and ${churn.byProduct.length - lost.length} more.` : "."}
          </p>
        )}
        <Row label="Net" value={`${churn.netMrr >= 0 ? "+" : "−"}${m(Math.abs(churn.netMrr))}`} tone={churn.netMrr >= 0 ? "ok" : "bad"} />
      </div>

      {(churn.notChurn.trialNonConversion.subscriptions > 0 || churn.notChurn.failedActivation.subscriptions > 0) && (
        <Group>
          {churn.notChurn.trialNonConversion.subscriptions > 0 && (
            <Row
              label={`Trials cancelled · ${count(churn.notChurn.trialNonConversion.subscriptions)}`}
              value={`${m(churn.notChurn.trialNonConversion.wouldHaveBeen)}/mo`}
              sub="Would have billed this; never started. Free trials that ended without a payment — not churn, and in no figure above."
            />
          )}
          {churn.notChurn.failedActivation.subscriptions > 0 && (
            <Row
              label={`Failed checkouts · ${count(churn.notChurn.failedActivation.subscriptions)}`}
              value={`${m(churn.notChurn.failedActivation.wouldHaveBeen)}/mo`}
              sub="Would have billed this; never started. Expired before a first payment and before any trial — not churn, not a trial, in no figure above."
            />
          )}
        </Group>
      )}

      <Group>
        <Row label="Asked to cancel" value={count(pending.count)} tone={pending.count > 0 ? "warn" : undefined} />
        {pending.count > 0 && (
          <>
            <Row indent label={`ending within ${pending.endingSoon.days} days · ${count(pending.endingSoon.count)}`} value={soonMrr ? `${m(soonMrr.amount)}/mo` : "—"} />
            <Row indent label={`declined renewal, months out · ${count(pending.count - pending.endingSoon.count)}`} value={pendingMrr && soonMrr ? `${m(pendingMrr.amount - soonMrr.amount)}/mo` : "—"} />
            <Row label="Leaving with them, eventually" value={pendingMrr ? `${m(pendingMrr.amount)}/mo` : "—"} tone="warn" />
          </>
        )}
      </Group>

      <div className="border-line-soft mt-2 border-t pt-2">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
          <span className="text-[20px] font-semibold tabular-nums">{churn.ratePct === null ? "—" : pct(churn.ratePct / 100)}</span>
          <span className="text-muted-foreground text-[12.5px]">revenue churn over {churn.days} days</span>
          {churn.subRatePct !== null && (
            <span className="text-muted-foreground text-[12.5px]">· {pct(churn.subRatePct / 100)} of subscriptions</span>
          )}
        </div>
        <Basis className="mt-1">{churn.basis}</Basis>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- winback */

function LeavingRow({ c }: { c: RecoveryCase }) {
  const ctx = (c.context ?? {}) as { product?: string; interval?: string; plan?: string };
  const who = c.contact.address ?? (c.contact.domain ? `someone at ${c.contact.domain}` : "no address on the subscription");
  return (
    <li className="border-line-soft flex items-baseline justify-between gap-3 border-b py-1.5 text-[13px] last:border-b-0">
      <div className="min-w-0">
        <div className="truncate">
          {who}
          {c.ventureName && <span className="text-muted-foreground ml-1.5 text-[12px]">{c.ventureName}</span>}
        </div>
        <div className="text-muted-foreground truncate text-[12px]">
          {ctx.product ?? ctx.plan ?? "no product on this price"}
          {ctx.interval ? ` · ${ctx.interval === "year" ? "yearly" : ctx.interval === "month" ? "monthly" : ctx.interval}` : ""}
          {c.daysLeft !== null ? ` · ends ${inDays(c.daysLeft)}` : " · already ended"}
        </div>
      </div>
      <div className="shrink-0 text-right tabular-nums">
        {c.amount === null ? "—" : `${money(c.amount, c.currency ?? "USD")}/mo`}
        {c.status !== "open" && <div className="text-muted-foreground text-[11.5px]">{c.status}</div>}
      </div>
    </li>
  );
}

export function WinbackCard({ queue }: { queue: RecoveryQueue | null }) {
  if (!queue) return null;
  const churn = queue.items.filter((c) => c.kind === "churn");
  if (churn.length === 0) return null;
  const { soon, later, undated } = splitLeaving(churn);
  const cur = churn[0]?.currency ?? "USD";
  const total = sumMonthly(churn);
  const laterTotal = sumMonthly(later);

  return (
    <Card>
      <CardHead
        title="Leaving unless someone writes"
        sub={later.length ? `${soon.length} ending soon · ${later.length} declined renewal, months out` : `${churn.length} subscription${churn.length === 1 ? "" : "s"} cancelling · soonest first`}
        action={<Tag kind="now" title="Subscriptions that have already asked to cancel and are still billing, as the book stands. Not a count of anything inside a window." />}
      />
      {soon.length ? (
        <ul>
          {soon.map((c) => (
            <LeavingRow key={c.id} c={c} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-[13px]">
          Nothing ends in the next two months — every pending cancellation here is a renewal declined well in advance.
        </p>
      )}
      {later.length > 0 && (
        <details className="mt-2">
          <summary className="text-muted-foreground cursor-pointer text-[12.5px]">
            Declined renewal, lapsing months out · {later.length} sub{later.length === 1 ? "" : "s"} · {money(laterTotal.total, cur)}/mo — still paid up, no deadline to beat
          </summary>
          <ul className="mt-1">
            {later.map((c) => (
              <LeavingRow key={c.id} c={c} />
            ))}
          </ul>
        </details>
      )}
      {undated.length > 0 && (
        <p className="text-muted-foreground mt-2 text-[12px]">
          {undated.length} more already ended and stay in the queue until somebody resolves them.
        </p>
      )}
      <Group>
        <Row label={`Leaving with them · ${churn.length} sub${churn.length === 1 ? "" : "s"}`} value={`${money(total.total, cur)}/mo${total.unpriced ? " at least" : ""}`} tone="warn" />
      </Group>
      {total.unpriced > 0 && (
        <p className="text-muted-foreground text-[12px]">
          {total.unpriced} of these reported no amount, so the total is a floor rather than the figure.
        </p>
      )}
      <Basis>
        Everyone here is still paying, and still counted in the MRR above, until the date beside their name — none
        of this has churned yet. Preparing a follow-up happens in the{" "}
        <Link to="/customers" className="underline underline-offset-2">recovery queue</Link>, which writes a draft into the
        Outbox; nothing on this page sends anything.
        {!queue.contactAccess && " Addresses are shown as a domain because contact access is off."}
      </Basis>
    </Card>
  );
}

/* ---------------------------------------------------------------- plans */

export function PlanCard({ plans, mrr }: { plans: StripeReport["plans"]; mrr: StripeReport["mrr"] }) {
  const m = one(mrr);
  if (!plans.length || !m) {
    return (
      <Card>
        <CardHead title="Revenue by plan" sub="Active subscribers · current" action={<Tag kind="now" />} />
        <p className="text-muted-foreground text-[13px]">No active plans.</p>
      </Card>
    );
  }
  return (
    <Card>
      <CardHead
        title="Revenue by plan"
        sub="What each plan bills as the book stands"
        action={<Tag kind="now" title="A share of a run rate is not a window. The money that actually settled per window is the gross tile and the daily chart." />}
      />
      <RankedBars
        rows={plans.map((p) => ({
          label: p.name,
          value: p.mrr,
          share: m.amount > 0 ? p.mrr / m.amount : null,
          sub: `${count(p.subscribers)}×`,
        }))}
        total={m.amount}
        format={(n) => money(n, m.currency)}
        footnote={`Shares are of the whole MRR, ${money(m.amount, m.currency)} — the top ${plans.length} plans are drawn.`}
      />
    </Card>
  );
}

/* -------------------------------------------------------------- app stores */

function StoreMonths({ months }: { months: { month: string; currencies: { currency: string; amount: number }[] }[] }) {
  return (
    <div>
      {months.slice(0, 6).map((mo) => (
        <Row
          key={mo.month}
          label={mo.month}
          value={mo.currencies.length ? mo.currencies.map((c) => money(c.amount, c.currency)).join("  ·  ") : "—"}
        />
      ))}
    </div>
  );
}

export function StoreCards({ mobile }: { mobile: MobileReport | null }) {
  if (!mobile) return null;
  const play = mobile.play;
  const apple = mobile.appstore;
  const playMonths = play.connected ? play.payout.months : [];
  const appleMonths = apple.connected ? apple.payout.months : [];
  const appleEstimated = apple.connected ? apple.estimated.months : [];

  return (
    <>
      {play.connected && (playMonths.length > 0 || play.estimated.months.length > 0) && (
        <Card>
          <CardHead
            title="Google Play"
            sub="App revenue · Google settles this itself, so it appears in no Stripe figure"
            action={<Tag kind="now" title="Google publishes one figure per calendar month and nothing finer, so these rows are months whatever the window control says." />}
          />
          {playMonths.length > 0 ? (
            <div>
              {playMonths.slice(0, 6).map((mo) => (
                <div key={mo.month} className="border-line-soft border-b py-1.5 last:border-b-0">
                  {mo.currencies.map((c) => (
                    <Row
                      key={c.currency}
                      label={`${mo.month} · ${c.currency}`}
                      value={money(c.net, c.currency)}
                      sub={`charged ${money(c.charged, c.currency)} · refunds ${money(c.refunds, c.currency)} · Google's share ${money(c.fees, c.currency)} · ${count(c.transactions)} transactions`}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <StoreMonths months={play.estimated.months.map((m) => ({ month: m.month, currencies: m.currencies }))} />
          )}
          <Basis>{play.payout.note}</Basis>
        </Card>
      )}
      {apple.connected && (appleMonths.length > 0 || appleEstimated.length > 0) && (
        <Card>
          <CardHead
            title="App Store"
            sub="Apple settles this itself, so it appears in no Stripe figure"
            action={<Tag kind="now" title="Apple publishes one figure per calendar month and nothing finer, so these rows are months whatever the window control says." />}
          />
          {appleMonths.length > 0 ? (
            <>
              <StoreMonths months={appleMonths} />
              <Basis>{apple.payout.note}</Basis>
            </>
          ) : (
            <>
              <StoreMonths months={appleEstimated} />
              <Basis>
                {apple.estimated.note} No finance report has landed for the {apple.payout.monthsAsked} months asked, so
                these are Apple's estimated proceeds from the daily sales report, and only a payout counts as money.
              </Basis>
            </>
          )}
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ mix */

export function MixCard({ subs, churn }: { subs: StripeReport["subscriptions"]; churn: Churn | null }) {
  return (
    <Card>
      <CardHead title="Subscriptions" sub={churn ? `Mix · new & churned over ${churn.days} days` : "Mix"} action={<Tag kind="now" />} />
      <Row label="Active" value={count(subs.billing)} tone="ok" />
      <Row label="Trialing" value={count(subs.trialing)} />
      <Row label="Past due" value={count(subs.pastDue)} tone={subs.pastDue > 0 ? "warn" : undefined} />
      <Row label="Canceled" value={count(subs.canceled)} />
      <Row label="Never completed" value={count(subs.incompleteExpired)} sub="Reached the card form and left before a first payment." />
      {churn && (
        <Group>
          <Row label={`New · ${churn.days}d`} value={count(churn.newSubs)} tone="ok" />
          <Row label={`Churned · ${churn.days}d`} value={count(churn.churnedSubs)} tone={churn.churnedSubs > 0 ? "warn" : undefined} />
        </Group>
      )}
      {subs.unresolvedCancellations > 0 && (
        <p className="text-muted-foreground mt-2 text-[12px]">
          {subs.unresolvedCancellations} cancelled subscription{subs.unresolvedCancellations === 1 ? " has" : "s have"} not yet been checked for whether they ever billed.
        </p>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- attempts */

export function AttemptsCard({ charges, days }: { charges: Charges | null; days: number }) {
  if (!charges) return null;
  const attempts = charges.succeeded + charges.failed;
  const cur = charges.currency;
  return (
    <Card>
      <CardHead title="Payment attempts" sub={`Last ${days} days`} action={<Tag kind="metered" />} />
      {attempts === 0 ? (
        <p className="text-muted-foreground text-[13px]">No payment attempts in this window.</p>
      ) : (
        <>
          <ProportionBar
            label={`Payment attempts over ${days} days`}
            parts={[
              { label: "succeeded", value: charges.succeeded, color: HUE.ok },
              { label: "failed", value: charges.failed, color: HUE.bad },
            ]}
          />
          <div className="mt-1">
            <Row label="Succeeded" value={count(charges.succeeded)} tone="ok" />
            <Row label="Failed" value={count(charges.failed)} tone="bad" />
            <Row label="Refunds" value={count(charges.refunds)} />
          </div>
          <p className="text-muted-foreground mt-1 text-[12px] tabular-nums">
            refunded {money(charges.refunded, cur)} · gross {money(charges.gross, cur)} before refunds
          </p>
        </>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- disputes */

export function DisputesCard({ disputes, days }: { disputes: DisputeDoc | null; days: number }) {
  if (!disputes) return null;
  const c = one(disputes.currencies);
  const cur = c?.currency ?? "USD";
  const openNow = c?.cases.openNow ?? disputes.open.length;
  return (
    <Card>
      <CardHead
        title="Disputes"
        sub={openNow > 0 ? "Awaiting your response" : `${count(c?.cases.opened ?? 0)} opened in the last ${days} days`}
      />
      {openNow > 0 ? (
        <>
          <Row label="Open" value={count(openNow)} tone="bad" />
          <Row label="At stake" value={money(c?.cases.openNowAmount ?? 0, cur)} tone="bad" />
          {c?.cases.nextEvidenceDueBy && (
            <Row label="Next evidence due" value={day(c.cases.nextEvidenceDueBy)} tone="warn" />
          )}
        </>
      ) : (
        <p className="text-ok text-[13px]">No disputes need a response.</p>
      )}
      <Group>
        <Row label={`Opened · ${days}d`} value={count(c?.cases.opened ?? 0)} tone={(c?.cases.opened ?? 0) > 0 ? "warn" : undefined} />
        <Row label={`Amount · ${days}d`} value={money(c?.cases.openedAmount ?? 0, cur)} />
        {c && (
          <Row
            label={`Left the ledger · ${days}d`}
            value={money(c.ledger.moneyOut, cur)}
            sub={`${money(c.ledger.disputes, cur)} disputed + ${money(c.ledger.disputeFees, cur)} in Stripe's dispute fees, dated by the posting`}
          />
        )}
      </Group>
      <p className="text-muted-foreground mt-2 text-[12px] tabular-nums">
        all time: {count(disputes.counts.byOutcome.lost)} lost · {count(disputes.counts.byOutcome.won)} won · {count(disputes.counts.byOutcome.undecided)} undecided
      </p>
      <Basis>
        Cases and the ledger are two populations and are never added: a case is dated by when the bank opened it and
        excludes the fee; the ledger is dated by when money moved and includes it. The{" "}
        <Link to="/customers/disputes" className="underline underline-offset-2">Disputes tab</Link> lists each case with
        its deadline.
      </Basis>
    </Card>
  );
}

/* --------------------------------------------------------------- balance */

export function BalanceCard({ stripe }: { stripe: StripeReport }) {
  const { balance, payouts } = stripe;
  return (
    <Card>
      <CardHead
        title="Balance and payouts"
        sub={`Stripe account${stripe.accounts.length === 1 ? "" : "s"} · ${stripe.accounts.map((a) => a.label).join(", ")}`}
        action={<Tag kind="now" title="What is sitting in the Stripe account this minute. Balances are levels, not windows, so the control at the top does not touch them." />}
      />
      {balance.length === 0 && <p className="text-muted-foreground text-[13px]">No balance read yet.</p>}
      {balance.map((b) => (
        <div key={`${b.account}-${b.currency}`}>
          <Row label={`Available · ${b.currency.toUpperCase()}`} value={money(b.available, b.currency)} />
          <Row label={`Pending · ${b.currency.toUpperCase()}`} value={money(b.pending, b.currency)} sub="Settling, not yet payable." />
        </div>
      ))}
      <Group>
        <Row
          label="Last payout"
          value={payouts.last ? money(payouts.last.amount, payouts.last.currency) : "—"}
          sub={payouts.last ? `arrived ${day(payouts.last.arrivalDate)} · ${payouts.last.automatic ? "automatic" : "sent by hand"}` : "none recorded"}
        />
        {payouts.inFlight.map((p, i) => (
          <Row
            key={i}
            label={`In flight · ${p.status}`}
            value={money(p.amount, p.currency)}
            sub={`arrives ${day(p.arrivalDate)}`}
            tone="warn"
          />
        ))}
      </Group>
      <Basis>{payouts.note}</Basis>
    </Card>
  );
}
