import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { finance } from "@/lib/api/finance";
import { count, pct } from "@/lib/format";
import { amount, currencies } from "./format";

/**
 * PROFIT AND LOSS — the portfolio in one table, and one venture in full.
 *
 * THE ACTUAL / PROJECTED BADGE IS THE FIRST THING ON THE PAGE, because it is
 * the first thing a reader gets wrong. A month in progress is a part-month:
 * its revenue is what has landed so far and its costs are the whole month's
 * bill, so the margin shown mid-month is always worse than the month will be.
 * The badge says which, and the projection panel says the method.
 *
 * A MARGIN IS ONE ROW PER CURRENCY. There is no total column anywhere on this
 * page and there is not going to be one: a venture earning dollars on the App
 * Store and paying euro for a server has two margins.
 *
 * EVERY ALLOCATED COST LINE WEARS ITS SHARE AND ITS BASIS, because "this
 * venture costs €14" and "this venture is charged a quarter of a €57 control
 * plane by a rule you chose in March" are different claims and only the second
 * is true.
 */

function monthOptions(): string[] {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 13; i++) {
    out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  return out;
}

function Badge({ actual }: { actual: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[11.5px] font-medium",
        actual ? "bg-ok/20 text-foreground" : "bg-warn/25 text-foreground",
      )}
      title={actual ? "The month has closed; these are measurements of it." : "The month is still running. Revenue is the part measured so far; costs are the whole month's bill."}
    >
      {actual ? "actual" : "part-month"}
    </span>
  );
}

export function Pnl() {
  const months = monthOptions();
  const [month, setMonth] = useState(months[1] ?? months[0]!);
  const [open, setOpen] = useState<string | null>(null);
  const doc = useApi(() => finance.portfolio(month), [month]);

  if (doc.error) return <p className="text-muted-foreground text-[14px]">The API is not answering: {doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14px]">Computing…</p>;
  const d = doc.data;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="bg-card rounded-md border px-3 py-1.5 text-[13.5px]"
        >
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <Badge actual={d.actual} />
        <span className="text-muted-foreground text-[12.5px]">
          ledger {currencies(d.ledger.monthly)} / month · {currencies(d.ledger.unallocatedShared)} of it unallocated
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="text-muted-foreground border-b text-left text-[12px]">
              <th className="pb-1.5 pr-3 font-normal">Venture</th>
              <th className="pb-1.5 pr-3 text-right font-normal">Revenue (net)</th>
              <th className="pb-1.5 pr-3 text-right font-normal">Costs</th>
              <th className="pb-1.5 pr-3 text-right font-normal">Model $</th>
              <th className="pb-1.5 pr-3 text-right font-normal">Margin</th>
              <th className="pb-1.5 font-normal" />
            </tr>
          </thead>
          <tbody>
            {d.ventures.map((v) => (
              <tr key={v.venture.id} className="border-line-soft border-b align-top">
                <td className="py-1.5 pr-3 text-[13.5px]">
                  <Link to={`/ventures/${v.venture.slug}`} className="hover:underline">{v.venture.name}</Link>
                  <span className="text-muted-foreground ml-1.5 text-[12px]">{v.venture.stage}</span>
                </td>
                <td className="py-1.5 pr-3 text-right text-[13.5px] tabular-nums">{currencies(v.revenueNet)}</td>
                <td className="py-1.5 pr-3 text-right text-[13.5px] tabular-nums">{currencies(v.costTotal)}</td>
                <td className="py-1.5 pr-3 text-right text-[13.5px] tabular-nums">{amount(v.modelUsd, "USD")}</td>
                <td className="py-1.5 pr-3 text-right text-[13.5px] tabular-nums">
                  {v.margin.length === 0 ? "—" : v.margin.map((m) => (
                    <div key={m.currency} className={cn(m.margin < 0 && "text-destructive")}>
                      {amount(m.margin, m.currency)}
                    </div>
                  ))}
                  {!v.complete && <div className="text-muted-foreground text-[11.5px]">at best — a cost has no price</div>}
                </td>
                <td className="py-1.5 text-right">
                  <button
                    onClick={() => setOpen(open === v.venture.slug ? null : v.venture.slug)}
                    className="hover:bg-accent rounded-lg border px-2 py-0.5 text-[12px]"
                  >
                    {open === v.venture.slug ? "hide" : "detail"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && <VentureDetail slug={open} month={month} />}

      <section className="mt-6 grid gap-3 sm:grid-cols-2">
        <div className="bg-card rounded-[14px] border px-4.5 py-3.5">
          <div className="text-[13.5px] font-medium">Stripe, settled — the portfolio</div>
          {d.stripeSettled.length === 0 ? (
            <p className="text-muted-foreground mt-1 text-[13px]">Nothing settled in {d.month}, or Stripe is not connected.</p>
          ) : (
            <ul className="mt-1.5 space-y-0.5 text-[13px] tabular-nums">
              {d.stripeSettled.map((s) => (
                <li key={s.currency}>
                  {amount(s.net, s.currency)} net · gross {amount(s.gross, s.currency)} · fees {amount(s.fees, s.currency)} · tax withheld {amount(s.taxWithheld, s.currency)}
                </li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed">
            Measured here and only here: Stripe's ledger has no product dimension, so a per-venture settled figure is
            not a measurement.
          </p>
        </div>

        <div className="bg-card rounded-[14px] border px-4.5 py-3.5">
          <div className="text-[13.5px] font-medium">Nobody's margin is carrying</div>
          <div className="mt-1 text-[20px] tabular-nums">{currencies(d.ledger.unallocatedShared)}</div>
          <ul className="text-muted-foreground mt-1.5 space-y-0.5 text-[12.5px]">
            {/* THE REMAINDER, NOT THE WHOLE BILL. The heading's total is the
                unallocated part, so a 90%-allocated €7.09 box printed as
                "€7.09" beside a total of €0.71 read as a contradiction — and
                as a much larger hole than there is. */}
            {d.ledger.unallocatedLines.slice(0, 6).map((l) => (
              <li key={l.expenseId}>
                {l.label} — {amount(l.monthly === null ? null : l.monthly * (1 - l.allocated), l.currency)}
                {l.allocated > 0 ? ` of ${amount(l.monthly, l.currency)}, ${pct(l.allocated)} assigned` : ""}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed">
            Every venture's margin above is this much too good until these are allocated. Default rule:{" "}
            {d.ledger.defaultRule}.
          </p>
        </div>
      </section>

      {/* MODEL SPEND IS DRAWN WHETHER OR NOT A MACHINE HAS A POWER PROFILE,
          so it must not be nested inside the electricity block — on a box with
          no profile, which is the ordinary state, the figure would be fetched
          and never shown. The electricity cards sit beside it when there are
          any; the point of the pairing is the comparison, and half of it is
          always available. */}
      <section className="mt-3">
        <div className="text-[13.5px] font-medium">Model spend, and what the local machines drew</div>
        <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
          Model spend through this box's runtime in {d.month}: {amount(d.modelSpend.usd, "USD")} over{" "}
          {count(d.modelSpend.tokens)} tokens in {d.modelSpend.calls} calls. {d.modelSpend.note}
        </p>
        {d.power.length === 0 && (
          <p className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">
            No machine has a power profile, so there is no electricity figure to set beside that. Local inference
            will keep looking free until one is typed in on the Power tab.
          </p>
        )}
      </section>

      {d.power.length > 0 && (
        <section className="mt-3">
          <div className="text-[13.5px] font-medium">Electricity</div>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {d.power.map((p) => (
              <div key={p.machineId} className="bg-card rounded-[14px] border px-4.5 py-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-[17px] tabular-nums">{amount(p.amount, p.currency)}</span>
                  <span className="text-[13px] font-medium">{p.label}</span>
                  {p.confidence && (
                    <span className="bg-accent rounded-full px-1.5 py-0.5 text-[11.5px]">{p.confidence} hours</span>
                  )}
                </div>
                <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">{p.note}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <ul className="text-muted-foreground mt-5 space-y-1 border-t pt-2 text-[12px] leading-relaxed">
        {d.rules.map((r) => <li key={r}>{r}</li>)}
      </ul>
    </>
  );
}

function VentureDetail({ slug, month }: { slug: string; month: string }) {
  const doc = useApi(() => finance.venture(slug, month), [slug, month]);
  if (doc.error) return <p className="text-destructive mt-3 text-[13px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground mt-3 text-[13px]">Computing…</p>;
  const d = doc.data;

  return (
    <section className="bg-card mt-3 rounded-[14px] border px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[16px]">{d.venture.name} · {d.month}</h2>
        <Badge actual={d.actual} />
        <span className="text-muted-foreground text-[12.5px]">
          {d.elapsedDays.toFixed(1)} of {d.daysInMonth} days
        </span>
      </div>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-muted-foreground text-[12px]">Revenue, measured</div>
          <div className="text-[18px] tabular-nums">{currencies(d.revenue.net)}</div>
          {d.revenue.subscriptionRunRate.length > 0 && (
            <div className="text-muted-foreground mt-1 text-[12.5px]">
              live MRR {currencies(d.revenue.subscriptionRunRate)} — a run rate, not this month's money, and never
              added to the figure above
            </div>
          )}
          <ul className="mt-1.5 space-y-1 text-[12.5px]">
            {d.revenue.lines.map((l, i) => (
              <li key={i}>
                <span className="tabular-nums">{amount(l.net, l.currency)}</span>{" "}
                <span className="text-muted-foreground">{l.source}{l.estimated ? " · estimated" : ""} · {l.kind}</span>
              </li>
            ))}
            {d.revenue.lines.length === 0 && <li className="text-muted-foreground">No measured revenue for this month.</li>}
          </ul>
          {d.revenue.unavailable.map((u) => (
            <p key={u} className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">{u}</p>
          ))}
        </div>

        <div>
          <div className="text-muted-foreground text-[12px]">Costs</div>
          <div className="text-[18px] tabular-nums">{currencies(d.costs.ledgerTotal)}</div>
          <div className="text-muted-foreground mt-1 text-[12.5px]">
            direct {currencies(d.costs.direct)} · allocated {currencies(d.costs.allocated)}
          </div>
          <ul className="mt-1.5 space-y-1 text-[12.5px]">
            {d.costs.lines.slice(0, 12).map((l) => (
              <li key={l.expenseId}>
                <span className="tabular-nums">{amount(l.monthly, l.currency)}</span>{" "}
                <span className="text-muted-foreground">
                  {l.label}
                  {l.direct ? "" : ` · ${pct(l.share)} of it, basis ${l.basis}`}
                </span>
              </li>
            ))}
          </ul>
          {!d.costs.complete && (
            <p className="text-muted-foreground mt-1.5 text-[12px] leading-relaxed">
              No price yet for {d.costs.unpriced.join(", ")} — the margin below is a ceiling.
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 border-t pt-2.5">
        <div className="text-muted-foreground text-[12px]">Margin, one row per currency</div>
        <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
          {d.margin.length === 0 && <span className="text-muted-foreground text-[13px]">Nothing measured on either side.</span>}
          {d.margin.map((m) => (
            <div key={m.currency}>
              <div className={cn("text-[20px] tabular-nums", m.margin < 0 && "text-destructive")}>
                {amount(m.margin, m.currency)}
              </div>
              <div className="text-muted-foreground text-[12px]">
                {amount(m.revenue, m.currency)} in, {amount(m.cost, m.currency)} out
              </div>
            </div>
          ))}
        </div>
      </div>

      {d.projected && (
        <div className="mt-3 border-t pt-2.5">
          <div className="text-muted-foreground text-[12px]">
            Projected to the end of {d.month} — revenue and model spend only
          </div>
          <div className="mt-1 text-[14px] tabular-nums">
            {d.projected.revenueNet.map((r) => `${amount(r.amount, r.currency)}`).join("  ·  ") || "—"}
          </div>
          <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">{d.projected.method}</p>
          <p className="text-muted-foreground text-[12px] leading-relaxed">Costs: {d.projected.costs}.</p>
        </div>
      )}

      <ul className="text-muted-foreground mt-3 space-y-1 border-t pt-2 text-[12px] leading-relaxed">
        {d.rules.map((r) => <li key={r}>{r}</li>)}
      </ul>
    </section>
  );
}
