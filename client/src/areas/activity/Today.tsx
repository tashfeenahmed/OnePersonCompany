import { count, money } from "@/lib/format";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { activityApi, type LeakageBucket } from "@/lib/api/activity";

/**
 * TODAY — money on the floor, with the arithmetic printed under every figure.
 *
 * THE ARITHMETIC IS THE FEATURE. A figure like "€2,311 lost to disputes" gets
 * quoted, and a quoted figure whose derivation lives in a server file is one
 * nobody can check. So every card prints the sentence the route sent with it:
 * which table, which columns, which window.
 *
 * AN EM DASH IS NOT A ZERO, and two of these buckets always carry one. A
 * decline has no amount because the charge-day table records attempts as
 * counts; an abandoned checkout has none because nothing was ever invoiced.
 * Drawing either as €0 would read as "cost us nothing" rather than "cannot
 * say", so they render as — and the totals below say they are a floor.
 *
 * THERE ARE TWO TOTALS AND NEVER ONE. Money that left in the window, and
 * dollars per month for as long as a condition lasts, are different units. The
 * page prints both with their units and refuses to add them, which is the same
 * refusal `combined: null` makes on the wire.
 */

function Bucket({ b, currency }: { b: LeakageBucket; currency: string }) {
  return (
    <div className="bg-card rounded-[14px] px-4.5 py-3.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            "text-[21px] font-normal tracking-[-0.03em] tabular-nums",
            b.amount === null && "text-muted-foreground",
          )}
        >
          {money(b.amount, currency)}
        </span>
        <span className="text-muted-foreground text-[13px]">
          {b.count !== null && b.count > 0 ? `${count(b.count)} · ` : ""}
          {b.window}
        </span>
      </div>
      <div className="mt-0.5 text-[13.5px] font-medium">{b.label}</div>
      <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">{b.why}</p>
      <p className="text-muted-foreground mt-1.5 border-t pt-1.5 text-[12px] leading-relaxed">
        {b.arithmetic}
      </p>
    </div>
  );
}

export function Today({ days }: { days: number }) {
  const report = useApi(() => activityApi.leakage(days), [days]);

  if (report.error)
    return <p className="text-muted-foreground text-[14px]">The API is not answering: {report.error}</p>;
  if (!report.data) return <p className="text-muted-foreground text-[14px]">Computing…</p>;
  const d = report.data;

  if (!d.currencies.length)
    return (
      <p className="text-muted-foreground text-[14px] leading-relaxed">{d.coverage.note}</p>
    );

  return (
    <>
      {d.currencies.map((c) => (
        <section key={c.currency} className="mb-7">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <div>
              <div className="text-[27px] font-normal tracking-[-0.03em] tabular-nums">
                {money(c.totals.window, c.currency)}
              </div>
              <div className="text-muted-foreground mt-0.5 text-[12.5px]">
                left in the last {c.totals.windowLabel} · {c.totals.windowIs}
              </div>
            </div>
            <div>
              <div className="text-[27px] font-normal tracking-[-0.03em] tabular-nums">
                {money(c.totals.perMonth, c.currency)}
              </div>
              <div className="text-muted-foreground mt-0.5 text-[12.5px]">
                per month · {c.totals.perMonthIs}
              </div>
            </div>
            {c.noAmount.length > 0 && (
              <div className="text-muted-foreground max-w-[300px] text-[12.5px] leading-relaxed">
                Both are a FLOOR: {c.noAmount.join(" and ")} carry no amount at all and add to
                neither.
              </div>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {c.buckets.map((b) => (
              <Bucket key={b.id} b={b} currency={c.currency} />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px]">
            <span className="text-muted-foreground">
              declined <span className="text-foreground tabular-nums">{c.counts.declined}</span>
            </span>
            <span className="text-muted-foreground" title="Radar stopping card testing before a bank saw it. Never added to the declines.">
              blocked by Radar <span className="text-foreground tabular-nums">{c.counts.blocked}</span>
            </span>
            <span className="text-muted-foreground">
              past due <span className="text-foreground tabular-nums">{c.counts.pastDue}</span>
            </span>
            <span className="text-muted-foreground">
              abandoned <span className="text-foreground tabular-nums">{c.counts.abandoned}</span>
            </span>
            <span
              className="text-muted-foreground"
              title="What those abandoned checkouts would have been worth at list price if every one of them had paid. A hypothetical, in no total on this page."
            >
              (at list, had they paid){" "}
              <span className="text-foreground tabular-nums">
                {money(c.counts.listedIfBilled, c.currency)}/mo
              </span>
            </span>
          </div>

          <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">{c.totals.note}</p>
        </section>
      ))}

      <div className="border-line-soft rounded-[14px] border border-dashed px-3.5 py-3">
        <div className="mb-2 text-[12px] tracking-[0.06em] uppercase">
          Figures this page refuses to produce
        </div>
        <div className="flex flex-col gap-2">
          {d.wrongFigures.map((w) => (
            <div key={w.figure}>
              <div className="text-[13.5px] font-medium">{w.figure}</div>
              <p className="text-muted-foreground text-[12.5px] leading-relaxed">{w.why}</p>
            </div>
          ))}
        </div>
      </div>

      <p className="text-muted-foreground mt-2.5 text-[12.5px] leading-relaxed">
        {d.coverage.note} Charge days from {d.coverage.chargeDaysFrom ?? "—"};{" "}
        {count(d.coverage.subscriptions)} subscriptions in the book.
      </p>
    </>
  );
}
