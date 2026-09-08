import { useState } from "react";
import { Link } from "react-router-dom";
import { PageShell } from "@/components/PageShell";
import { WindowPicker } from "@/components/WindowPicker";
import { useApi } from "@/hooks/useApi";
import { api, type MobileReport, type StripeReport } from "@/lib/api";
import { activityApi, type LeakageCurrency } from "@/lib/api/activity";
import { customersApi, type DisputeDoc, type RecoveryQueue } from "@/lib/api/customers";
import { ago, count, money, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  AttemptsCard,
  BalanceCard,
  DailyRevenueCard,
  DeclineCard,
  DisputesCard,
  MixCard,
  MovementCard,
  PlanCard,
  StoreCards,
  WinbackCard,
} from "./Cards";
import { Basis, Card, CardHead, Key, Money, ProportionBar, SectionLabel, Tag } from "./chrome";
import { HUE } from "./hues";
import { planSplit, worthALook } from "./math";

/**
 * PAYMENTS — what came in, what is contracted to keep coming in, and where
 * money is leaking out. One page, the way Workdash's Payments page is one
 * page, and reached from the Dashboards strip beside Finance for the reason
 * Finance is: the revenue cards already live on a board, and this is that
 * subject one level deeper.
 *
 * FIVE DOCUMENTS, ONE CONTROL. The window picker governs the Stripe report,
 * the leakage buckets and the dispute cases, which are sums over days. It
 * does not govern MRR, the subscription book, the balance, the winback list
 * or the app-store months — those are levels or calendar months — and every
 * card drawing one of them wears a "now" tag saying so.
 *
 * NOTHING IS ADDED ACROSS CURRENCIES, and nothing is added across sources.
 * Google's and Apple's money never joins Stripe's; the disputes' case count
 * never joins the ledger's dispute debit. Where two measurements of the same
 * thing disagree they are both drawn, with the reason.
 *
 * WHAT THIS BOX DOES NOT KEEP is said at the bottom rather than drawn as a
 * near-enough substitute: there is no per-charge list and no decline code
 * table, because the collector stores days, not charges.
 */

const WINDOWS = [7, 30, 90] as const;

const one = <T,>(rows: T[] | null | undefined): T | null => (rows && rows.length ? rows[0]! : null);

export function Payments() {
  const [days, setDays] = useState<number>(30);
  const stripe = useApi(() => api.stripe(days), [days]);
  const leakage = useApi(() => activityApi.leakage(days), [days]);
  const disputes = useApi(() => customersApi.disputes(days), [days]);
  const queue = useApi(() => customersApi.queue({ limit: 200 }), []);
  const mobile = useApi(() => api.mobile(days), [days]);

  const s = stripe.data;

  return (
    <PageShell
      title="Payments"
      sub="What Stripe collected, what the book bills every month, and what is slipping away — beside the two app stores, which settle on their own."
      wide
      action={
        <WindowPicker
          value={days}
          onChange={(w) => setDays(Number(w))}
          options={WINDOWS}
          right={s?.seenAt ? `collected ${ago(s.seenAt)}` : undefined}
        />
      }
    >
      {stripe.error && <p className="text-destructive mb-4 text-[13.5px]">The API is not answering for Stripe: {stripe.error}</p>}
      {!s && !stripe.error && <p className="text-muted-foreground text-[14px]">Reading the ledger…</p>}
      {s && !s.connected && (
        <Card>
          <p className="text-[13.5px]">
            Stripe is not connected. Paste a read-only restricted key on the{" "}
            <Link to="/integrations/stripe" className="underline underline-offset-2">Integrations page</Link> and this page fills on the next collection.
          </p>
        </Card>
      )}
      {s && s.connected && (
        <Body
          s={s}
          days={days}
          leak={one(leakage.data?.currencies)}
          disputes={disputes.data}
          queue={queue.data}
          mobile={mobile.data}
        />
      )}
    </PageShell>
  );
}

function Body({
  s,
  days,
  leak,
  disputes,
  queue,
  mobile,
}: {
  s: StripeReport;
  days: number;
  leak: LeakageCurrency | null;
  disputes: DisputeDoc | null;
  queue: RecoveryQueue | null;
  mobile: MobileReport | null;
}) {
  const mrr = one(s.mrr);
  const churn = s.churn.find((c) => c.days === days) ?? one(s.churn);
  const revenue = one(s.revenue);
  const charges = one(s.charges);
  const cur = mrr?.currency ?? revenue?.currency ?? "USD";
  const d = one(disputes?.currencies);

  const alerts = worthALook({
    days,
    succeeded: charges?.succeeded ?? 0,
    failed: charges?.failed ?? 0,
    blocked: charges?.blocked ?? 0,
    declined: charges?.declined ?? 0,
    pastDue: s.subscriptions.pastDue,
    disputesNeedingResponse: d?.cases.needsResponseNow ?? 0,
    disputesAtStake: d?.cases.openNowAmount ?? 0,
    nextEvidenceDueBy: d?.cases.nextEvidenceDueBy ?? null,
    failingInvoices: queue?.counts.byKind.payment_failed ?? 0,
    fmtMoney: (n) => money(n, cur),
  });

  return (
    <>
      <section aria-label="Recurring revenue" className="grid gap-3 xl:grid-cols-3">
        <MrrTile s={s} />
        <GrossTile s={s} days={days} />
        <BookTile s={s} />
      </section>

      {alerts.length > 0 && (
        <Card tone="warn" className="mt-3">
          <CardHead title="Worth a look" />
          <ul className="space-y-1 text-[13.5px] leading-relaxed">
            {alerts.map((a) => (
              <li key={a}>· {a}</li>
            ))}
          </ul>
        </Card>
      )}

      {leak && (
        <>
          <SectionLabel>Money on the floor</SectionLabel>
          <FloorCard leak={leak} mrr={mrr} />
        </>
      )}

      <SectionLabel>The last {days} days, in detail</SectionLabel>
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-3 xl:col-span-2">
          <DeclineCard charges={charges} days={days} />
          <DailyRevenueCard revenue={revenue} charges={charges} days={days} />
          <FeesCard revenue={revenue} />
          {/* The four short cards share the wide column in pairs, so the
              column ends level with the narrow one rather than a screen
              above it. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <MixCard subs={s.subscriptions} churn={churn} />
            <AttemptsCard charges={charges} days={days} />
            <DisputesCard disputes={disputes} days={days} />
            <BalanceCard stripe={s} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <MovementCard churn={churn} pending={s.subscriptions.pendingCancellation} />
          <WinbackCard queue={queue} />
          <PlanCard plans={s.plans} mrr={s.mrr} />
          <StoreCards mobile={mobile} />
        </div>
      </div>

      <Cannot s={s} leak={leak} />
    </>
  );
}

/* -------------------------------------------------------------- hero tiles */

function MrrTile({ s }: { s: StripeReport }) {
  const mrr = one(s.mrr);
  const split = planSplit(s.plans);
  const hues = [HUE.one, HUE.two, HUE.three, HUE.four];
  return (
    <Card>
      <div className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
        MRR · Stripe
        <Tag kind="now" title="What the subscription book bills today; the ARR line is that × 12. A run rate has no window: the control at the top governs the gross tile beside this one and every chart below, but not this figure." />
      </div>
      <div className="mt-1">{mrr ? <Money value={mrr.amount} currency={mrr.currency} /> : <span className="text-[36px]">—</span>}</div>
      {mrr && (
        <div className="text-muted-foreground mt-1 text-[12.5px]" title="ARR is MRR × 12 — contracted revenue annualised, not a forecast, and it assumes not one subscription changes. Neither figure is money collected: that is the gross tile beside this one.">
          ARR {money(mrr.arr, mrr.currency)}/yr — this × 12, not a forecast
        </div>
      )}
      {mrr && mrr.discountedAway > 0 && (
        <div className="text-muted-foreground text-[12.5px]">
          net of {money(mrr.discountedAway, mrr.currency)}/mo in coupons on {mrr.discounted} sub{mrr.discounted === 1 ? "" : "s"}
        </div>
      )}
      {mrr && split.top.length > 0 && (
        <>
          <ProportionBar
            label="MRR by plan"
            parts={split.top.map((p, i) => ({ label: p.name, value: p.mrr, color: hues[i] ?? HUE.faint }))}
          />
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {split.top.slice(0, 2).map((p, i) => (
              <Key key={p.name} color={hues[i]} label={p.name}>{money(p.mrr, p.currency)}</Key>
            ))}
            {split.top.length + split.more > 2 && (
              <span className="text-muted-foreground text-[12px]">+{split.top.length + split.more - 2} more plans</span>
            )}
          </div>
        </>
      )}
      {mrr && (
        <div className="text-muted-foreground mt-2 text-[12px]">
          {count(mrr.byInterval.annual.subscriptions)} annual · {count(mrr.byInterval.monthly.subscriptions)} monthly
          {mrr.byInterval.other.subscriptions > 0 ? ` · ${count(mrr.byInterval.other.subscriptions)} other` : ""}
        </div>
      )}
    </Card>
  );
}

function GrossTile({ s, days }: { s: StripeReport; days: number }) {
  const c = one(s.charges);
  const r = one(s.revenue);
  const attempts = c ? c.succeeded + c.failed : 0;
  return (
    <Card>
      <div className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
        Gross · {days}d
        <Tag kind="metered" />
      </div>
      <div className="mt-1">{c ? <Money value={c.gross} currency={c.currency} /> : <span className="text-[36px]">—</span>}</div>
      {c && (
        <div className="text-muted-foreground mt-1 text-[12.5px]" title="Charges that settled in this window, before refunds.">
          {count(c.succeeded)} of {count(attempts)} attempts settled
          {c.refunds > 0 ? ` · ${money(c.refunded, c.currency)} refunded` : ""}
        </div>
      )}
      {r && (
        <div className="text-muted-foreground text-[12.5px]">
          {money(r.net, r.currency)} net after {money(r.feesTotal, r.currency)} in fees and tax
          {r.feeRatePct !== null ? ` (${pct(r.feeRatePct / 100)})` : ""}
        </div>
      )}
      {c && attempts > 0 && (
        <>
          <ProportionBar
            label={`Payment attempts over ${days} days`}
            parts={[
              { label: "succeeded", value: c.succeeded, color: HUE.ok },
              { label: "failed", value: c.failed, color: HUE.bad },
            ]}
          />
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            <Key color={HUE.ok} label="succeeded">{count(c.succeeded)}</Key>
            <Key color={HUE.bad} label="failed">{count(c.failed)}</Key>
          </div>
        </>
      )}
    </Card>
  );
}

function BookTile({ s }: { s: StripeReport }) {
  const b = s.subscriptions;
  const book = b.billing + b.trialing + b.pastDue;
  const parts = [
    b.trialing > 0 ? `${count(b.trialing)} trialing` : null,
    b.pastDue > 0 ? `${count(b.pastDue)} past due` : null,
  ].filter(Boolean);
  return (
    <Card>
      <div className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
        Active subscriptions
        <Tag kind="now" title="The book as it stands — how many subscriptions are billing right now. Not a count of anything that happened in a window, so it does not move with the control. What arrived and what left inside the window is the movement card further down." />
      </div>
      <div className="mt-1 text-[36px] font-semibold tracking-[-0.03em] tabular-nums" style={{ lineHeight: 1.1 }}>
        {count(b.billing)}
      </div>
      <div className="text-muted-foreground mt-1 text-[12.5px]">{parts.length ? parts.join(" · ") : "none trialing, none past due"}</div>
      {book > 0 && (
        <>
          <ProportionBar
            label="The live subscription book by state"
            parts={[
              { label: "active", value: b.billing, color: HUE.ok },
              { label: "trialing", value: b.trialing, color: HUE.one },
              { label: "past due", value: b.pastDue, color: HUE.warn },
            ]}
          />
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            <Key color={HUE.ok} label="active">{count(b.billing)}</Key>
            {b.trialing > 0 && <Key color={HUE.one} label="trialing">{count(b.trialing)}</Key>}
            {b.pastDue > 0 && <Key color={HUE.warn} label="past due">{count(b.pastDue)}</Key>}
          </div>
        </>
      )}
      {b.pendingCancellation.count > 0 && (
        <div className="text-muted-foreground mt-2 text-[12px]">
          {count(b.pendingCancellation.count)} asked to cancel and still billing
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- the floor */

function FloorCard({ leak, mrr }: { leak: LeakageCurrency; mrr: NonNullable<StripeReport["mrr"]>[number] | null }) {
  const cur = leak.currency;
  const t = leak.totals;
  const months = mrr && mrr.amount > 0 ? t.perMonth / mrr.amount : null;
  return (
    <Card>
      <CardHead
        title="Money on the floor"
        sub="Already earned, or contracted, and not arriving — each bucket over its own window, printed on the row"
        action={
          <div className="text-right">
            <div className="flex items-baseline justify-end gap-1.5">
              <Money value={t.window} currency={cur} size={26} />
              <span className="text-muted-foreground text-[12px]">left in {t.windowLabel}</span>
            </div>
            <div className="flex items-baseline justify-end gap-1.5">
              <Money value={t.perMonth} currency={cur} size={20} />
              <span className="text-muted-foreground text-[12px]">
                a month, not arriving{months !== null ? ` · ${pct(months, { digits: 1 })} of MRR` : ""}
              </span>
            </div>
          </div>
        }
      />
      <ul className="grid gap-x-6 sm:grid-cols-2">
        {leak.buckets.map((b) => (
          <li key={b.id} className="border-line-soft flex items-start justify-between gap-3 border-b py-2 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[13.5px]">
                {b.label}
                {b.floor && <Tag kind="floor" />}
              </div>
              <div className="text-muted-foreground text-[12px] leading-snug">{b.why}</div>
            </div>
            <div className="shrink-0 text-right tabular-nums" title={b.arithmetic}>
              <div className={cn("text-[14px]", b.amount === null && "text-muted-foreground")}>
                {b.amount === null ? "—" : `${money(b.amount, cur)}${b.floor ? "+" : ""}`}
              </div>
              <div className="text-muted-foreground text-[11.5px]">
                {b.count === null ? "" : `${count(b.count)} · `}
                {b.window}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <Basis>
        {t.windowIs}. {t.perMonthIs}. {t.note} An em dash is an amount Stripe does not record — a declined card and
        an abandoned checkout have a count and no price — so neither total is more than a floor.
      </Basis>
    </Card>
  );
}

/* ------------------------------------------------------------------- fees */

function FeesCard({ revenue }: { revenue: StripeReport["revenue"][number] | null }) {
  if (!revenue) return null;
  const cur = revenue.currency;
  const fb = revenue.feeBreakdown;
  const rows: [string, number, string][] = [
    ["Processing", fb.processing, HUE.one],
    ["Managed payments", fb.managedPayments, HUE.two],
    ["Billing", fb.billing, HUE.three],
    ["Dispute fees", fb.disputes, HUE.bad],
    ["Other", fb.other, HUE.faint],
  ];
  return (
    <Card>
      <CardHead
        title="What Stripe kept"
        sub={`${money(revenue.feesTotal, cur)} over ${revenue.days} days · ${revenue.feeRatePct !== null ? `${pct(revenue.feeRatePct / 100)} of gross in fees` : "no rate"}${revenue.taxRatePct !== null ? `, ${pct(revenue.taxRatePct / 100)} withheld as tax` : ""}`}
        action={<Tag kind="metered" />}
      />
      <ProportionBar
        label="Stripe's fees by kind"
        parts={[...rows.map(([label, value, color]) => ({ label, value, color })), { label: "tax withheld", value: revenue.taxWithheld, color: HUE.mid }]}
      />
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {rows.filter(([, v]) => v > 0).map(([label, value, color]) => (
          <Key key={label} color={color} label={label.toLowerCase()}>{money(value, cur)}</Key>
        ))}
        {revenue.taxWithheld > 0 && <Key color={HUE.mid} label="tax withheld">{money(revenue.taxWithheld, cur)}</Key>}
      </div>
      <Basis>{revenue.note}</Basis>
    </Card>
  );
}

/* ----------------------------------------------------------------- cannot */

function Cannot({ s, leak }: { s: StripeReport; leak: LeakageCurrency | null }) {
  const lines = [
    "A list of individual charges — the collector stores each day's attempts and settlement, not the charges themselves. The recovery queue holds the failing invoices one by one.",
    "Decline codes and the bank's reasons. Stripe's two words for a failure, blocked and declined, are kept; the code behind each is not.",
    ...s.cannot,
  ];
  return (
    <div className="border-line-soft mt-6 rounded-[14px] border px-3.5 py-3">
      <div className="text-muted-foreground mb-1.5 text-[12.5px] font-medium">What this page will not say</div>
      <ul className="text-muted-foreground space-y-1 text-[13px] leading-relaxed">
        {lines.map((l) => (
          <li key={l}>· {l}</li>
        ))}
        <li>
          · {s.history.note} History reaches back to {s.history.from ?? "the first collection"}
          {s.history.complete ? " and is complete." : " and is still being filled in."}
        </li>
      </ul>
      {leak && leak.noAmount.length > 0 && (
        <p className="text-muted-foreground mt-2 text-[12px]">
          Buckets with a count and no amount: {leak.noAmount.join(", ")}.
        </p>
      )}
    </div>
  );
}
