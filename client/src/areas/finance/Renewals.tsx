import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { finance, type RenewalDecision } from "@/lib/api/finance";
import { inDays } from "@/lib/format";
import { amount } from "./format";

/**
 * RENEWALS DUE — the only rows in the ledger with a decision date.
 *
 * A DOMAIN IS THE ONLY COST HERE WHERE DOING NOTHING GOES BOTH WAYS: with
 * auto-renew on, doing nothing spends money; with it off, doing nothing
 * destroys an asset. So the row leads with the distance, and the decision is
 * three buttons rather than a form.
 *
 * SETTING A DECISION CANCELS NOTHING, and the page says so under the buttons
 * rather than leaving the owner to discover it on a statement. Nothing in this
 * app has a credential that could cancel a domain, and inventing the
 * impression that it does would be worse than not having the feature.
 */

const DECISIONS: RenewalDecision[] = ["keep", "cancel", "undecided"];

export function Renewals() {
  const [days, setDays] = useState(90);
  const doc = useApi(() => finance.renewals(days), [days]);

  if (doc.error) return <p className="text-muted-foreground text-[14px]">The API is not answering: {doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14px]">Reading renewals…</p>;
  const d = doc.data;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <div className="text-[27px] font-normal tracking-[-0.03em] tabular-nums">{d.count}</div>
          <div className="text-muted-foreground mt-0.5 text-[12.5px]">
            renew within {d.window.days} days · {d.undecided} undecided
            {d.overdue ? ` · ${d.overdue} already past` : ""}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {[30, 90, 180, 365].map((n) => (
            <button
              key={n}
              onClick={() => setDays(n)}
              className={cn(
                "text-muted-foreground hover:bg-accent rounded-lg px-2 py-1 text-[13px]",
                n === days && "bg-accent text-foreground font-medium",
              )}
            >
              {n}d
            </button>
          ))}
        </div>
      </div>

      {d.renewals.length === 0 ? (
        <p className="text-muted-foreground text-[14px]">Nothing renews in that window.</p>
      ) : (
        <div className="space-y-1.5">
          {d.renewals.map((r) => (
            <div key={r.id} className="bg-card flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[14px] px-4.5 py-3">
              <span className={cn("w-16 shrink-0 text-[13.5px] tabular-nums", r.inDays < 0 && "text-destructive")}>
                {inDays(r.inDays)}
              </span>
              <span className="text-[14px] font-medium">{r.label}</span>
              <span className="text-muted-foreground text-[13px] tabular-nums">{amount(r.amount, r.currency)} / {r.period}</span>
              <span className="text-muted-foreground text-[12.5px]">{r.venture ?? "shared"}</span>
              <div className="ml-auto flex items-center gap-0.5">
                {DECISIONS.map((decision) => (
                  <button
                    key={decision}
                    onClick={() => void finance.setRenewal(r.id, decision).then(() => doc.reload())}
                    className={cn(
                      "text-muted-foreground hover:bg-accent rounded-lg px-2 py-1 text-[12.5px]",
                      r.renewalDecision === decision && "bg-accent text-foreground font-medium",
                    )}
                  >
                    {decision}
                  </button>
                ))}
              </div>
              {r.notes && (
                <p className="text-muted-foreground w-full text-[12px] leading-relaxed">{r.notes}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-muted-foreground mt-4 border-t pt-2 text-[12px] leading-relaxed">{d.note}</p>
    </>
  );
}
