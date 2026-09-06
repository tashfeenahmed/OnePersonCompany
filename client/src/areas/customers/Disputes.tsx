import { useState } from "react";
import { WindowPicker } from "@/components/WindowPicker";
import { money } from "@/lib/format";
import { useApi } from "@/hooks/useApi";
import { customersApi, type DisputeCase } from "@/lib/api/customers";
import { Empty, Notes, Problem, Stats } from "./Customers";

/**
 * DISPUTES — the cases, and the ledger figure beside them rather than under
 * them.
 *
 * THE TWO-COLUMN COMPARISON IS THE POINT OF THIS TAB. Before there was a
 * dispute table, the only figure on this box was the ledger's: money that
 * moved, dated by the balance posting, with Stripe's fee inside it. There is
 * now a case count too, dated by when the bank opened the case, without the
 * fee. They do not agree and they are not supposed to; drawing them in one
 * total would destroy the only thing either of them is good for.
 *
 * NOTHING IS COLOURED GREEN FOR "WON". A dispute won still cost the fee and
 * still counts against the account at Stripe, and `outcome: null` is a live
 * case rather than a good outcome. The one thing this tab emphasises is an
 * evidence deadline, because that is the single date on this dashboard where
 * being late loses the money by default.
 */

const WINDOWS = [30, 90, 365];

export function DisputesTab() {
  const [days, setDays] = useState(90);
  const q = useApi(() => customersApi.disputes(days), [days]);
  const d = q.data;

  const usd = d?.currencies[0];
  const stats: [string, string][] = [
    [d ? String(d.counts.byOutcome.lost) : "—", "lost, all time"],
    [d ? String(d.counts.byOutcome.won) : "—", "won, all time"],
    [usd ? String(usd.cases.openNow) : "—", "open now"],
    [usd ? String(usd.cases.needsResponseNow) : "—", "need a response"],
  ];

  return (
    <>
      <Stats items={stats} />

      <WindowPicker
        value={days}
        onChange={(w) => setDays(Number(w))}
        options={WINDOWS}
        className="mb-4"
        right={d ? `deadlines shown in ${d.timezone} (${d.timezoneFrom})` : undefined}
      />

      {q.error && <Problem error={q.error} />}

      {d && d.coverage.stored === 0 && <Empty>{d.coverage.note}</Empty>}

      {d?.currencies.map((c) => (
        <div key={c.currency} className="bg-card mb-3 rounded-[10px] border px-3.5 py-3">
          <div className="mb-2 text-[13.5px]">
            {c.currency.toUpperCase()} · {c.window}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-muted-foreground mb-1 text-[11.5px] font-medium">
                From the CASES
              </div>
              <dl className="space-y-0.5 text-[12.5px]">
                <Row k="Opened" v={`${c.cases.opened} · ${money(c.cases.openedAmount, c.currency)}`} />
                <Row k="Lost" v={`${c.cases.lost} · ${money(c.cases.lostAmount, c.currency)}`} />
                <Row k="Won" v={`${c.cases.won} · ${money(c.cases.wonAmount, c.currency)}`} />
                <Row
                  k="Open now (no window)"
                  v={`${c.cases.openNow} · ${money(c.cases.openNowAmount, c.currency)}`}
                />
              </dl>
              <p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
                {c.cases.arithmetic}
              </p>
            </div>
            <div>
              <div className="text-muted-foreground mb-1 text-[11.5px] font-medium">
                From the LEDGER
              </div>
              <dl className="space-y-0.5 text-[12.5px]">
                <Row k="Money out" v={money(c.ledger.moneyOut, c.currency)} />
                <Row k="Disputed amounts" v={money(c.ledger.disputes, c.currency)} />
                <Row k="Dispute fees" v={money(c.ledger.disputeFees, c.currency)} />
                <Row k="Difference" v={money(c.difference, c.currency)} />
              </dl>
              <p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
                {c.ledger.arithmetic}
              </p>
            </div>
          </div>
          <p className="text-muted-foreground border-line-soft mt-2.5 border-t pt-2 text-[11px] leading-relaxed">
            {c.differenceIs}
          </p>
        </div>
      ))}

      {d && d.open.length > 0 && (
        <>
          <h2 className="mt-5 mb-2 text-[13.5px]">Open cases</h2>
          <div className="space-y-1.5">
            {d.open.map((c) => (
              <CaseLine key={c.id} c={c} />
            ))}
          </div>
        </>
      )}

      {d && d.recent.length > 0 && (
        <>
          <h2 className="mt-5 mb-2 text-[13.5px]">Opened in this window</h2>
          <div className="space-y-1.5">
            {d.recent.slice(0, 40).map((c) => (
              <CaseLine key={c.id} c={c} />
            ))}
          </div>
        </>
      )}

      {d && <Notes title="What this document will not answer" lines={d.cannot} />}
      {d && <Notes title="Coverage" lines={[d.coverage.note]} />}
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  );
}

function CaseLine({ c }: { c: DisputeCase }) {
  return (
    <div className="bg-card rounded-[10px] border px-3.5 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-[13px] tabular-nums">{money(c.amount, c.currency)}</span>
        <span className="text-muted-foreground text-[12px]">{c.reason ?? "no reason given"}</span>
        {/* Stripe's own word, not a paraphrase — it is what the risk page says. */}
        <span className="text-muted-foreground text-[11.5px]">· {c.status}</span>
        {c.ventureName && (
          <span className="text-muted-foreground text-[11.5px]">· {c.ventureName}</span>
        )}
        <span className="text-muted-foreground ml-auto text-[11.5px]">
          opened {c.openedAt.slice(0, 10)}
        </span>
      </div>
      <div className="text-muted-foreground mt-1 text-[11.5px]">
        {c.needsResponse && c.evidenceDueLocal ? (
          <span className="text-foreground font-medium">
            Evidence due {c.evidenceDueLocal}
            {c.hoursLeft !== null && ` · ${c.hoursLeft}h`}
          </span>
        ) : c.open ? (
          "Open at Stripe. No response is being asked for in this status."
        ) : (
          `Outcome: ${c.outcome ?? "closed with no verdict — neither won nor lost"}`
        )}
      </div>
    </div>
  );
}
