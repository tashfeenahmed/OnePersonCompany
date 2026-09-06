import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { finance, type Allocation, type Basis } from "@/lib/api/finance";
import { amount, pct, shownShare } from "./format";

/**
 * THE ALLOCATION EDITOR — how a shared bill reaches a business.
 *
 * THE UNALLOCATED REMAINDER IS DRAWN, ALWAYS. A split that covers 60% of a
 * server is a real and useful state, and a UI that normalised it to 100%
 * behind the owner's back would move a third of the control plane onto three
 * ventures that were never charged for it. The bar shows the assigned part and
 * the remainder, and the remainder has a figure on it.
 *
 * THE THREE COMPUTED BASES WRITE SHARES AND THEN STOP. Pressing "equal" or
 * "by revenue" computes a split once, from today's evidence, and stores it —
 * it does not install a rule that re-evaluates. The explanation the server
 * returns says which month it weighed and how many ventures it had to leave
 * out, and it is shown rather than swallowed.
 */

const BASES: { key: Basis; label: string; hint: string }[] = [
  { key: "equal", label: "Split equally", hint: "One share each, across every venture. A convention, not a measurement." },
  { key: "revenue", label: "By revenue", hint: "Weighted by measured net revenue this month, in each venture's largest currency. Ventures with no measured revenue are left out entirely rather than given a nought share." },
  { key: "traffic", label: "By traffic", hint: "Weighted by Cloudflare edge requests this month on each venture's linked zones. Edge requests are not people; this is a size proxy for splitting a bill." },
];

export function Allocation() {
  const doc = useApi(() => finance.allocations(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  const [manual, setManual] = useState<Record<string, string>>({});

  if (doc.error) return <p className="text-muted-foreground text-[13px]">The API is not answering: {doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[13px]">Reading the rules…</p>;
  const d = doc.data;

  const auto = async (id: string, basis: Basis) => {
    try {
      const r = await finance.autoAllocate(id, basis);
      setMessage({ id, text: `${r.explanation}${r.skipped.length ? ` (${r.skipped.length} venture(s) left out)` : ""}` });
      doc.reload();
    } catch (err) {
      setMessage({ id, text: err instanceof Error ? err.message : String(err) });
    }
  };

  /** The field and the save read the SAME answer — see `shownShare`, which is
   *  where the reason lives and where the regression test points. */
  const shown = (expenseId: string, ventureId: string, allocations: Allocation[]) =>
    shownShare(manual[`${expenseId}:${ventureId}`], allocations, ventureId);

  const saveManual = async (id: string, allocations: Allocation[]) => {
    const bad = d.ventures
      .map((v) => shown(id, v.id, allocations))
      .find((raw) => raw.trim() !== "" && !Number.isFinite(Number(raw)));
    if (bad !== undefined) {
      setMessage({ id, text: `“${bad}” is not a percentage. Type a number, or leave the field empty for none.` });
      return;
    }
    const shares = d.ventures
      .map((v) => ({ ventureId: v.id, share: Number(shown(id, v.id, allocations) || "0") / 100 }))
      .filter((s) => Number.isFinite(s.share) && s.share > 0);
    try {
      await finance.setAllocations(id, shares, "manual");
      setMessage({ id, text: "Saved." });
      doc.reload();
    } catch (err) {
      setMessage({ id, text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <>
      <p className="text-muted-foreground mb-4 text-[12.5px] leading-relaxed">
        {d.shared.length} shared cost{d.shared.length === 1 ? "" : "s"} belong to no single venture. The default rule
        for one with no split of its own is <span className="text-foreground font-medium">{d.defaultRule}</span> —
        change it on the Finance integration's settings page.
      </p>

      <div className="space-y-2">
        {d.shared.map((e) => {
          const isOpen = open === e.id;
          return (
            <div key={e.id} className="bg-card rounded-[10px] border px-3.5 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[13px] font-medium">{e.label}</span>
                <span className="text-muted-foreground text-[12px] tabular-nums">{amount(e.monthly, e.currency)} / month</span>
                <span className="text-muted-foreground text-[11.5px]">{e.category}</span>
                <button
                  onClick={() => { setOpen(isOpen ? null : e.id); setMessage(null); }}
                  className="hover:bg-accent ml-auto rounded-lg border px-2 py-1 text-[11.5px]"
                >
                  {isOpen ? "Close" : e.allocations.length ? "Edit split" : "Allocate"}
                </button>
              </div>

              {/* The bar: assigned on the left, unallocated on the right, and
                  the remainder always visible rather than normalised away. */}
              <div className="mt-2 flex h-1.5 overflow-hidden rounded-full">
                {e.allocations.map((a) => (
                  <div key={a.ventureId} className="bg-ok" style={{ width: `${a.share * 100}%` }} title={`${a.venture}: ${pct(a.share)} (${a.basis})`} />
                ))}
                <div className="bg-warn/40 flex-1" title={`${pct(e.unallocatedShare)} unallocated`} />
              </div>
              <div className="text-muted-foreground mt-1 text-[11px]">
                {e.allocations.length
                  ? `${e.allocations.map((a) => `${a.venture} ${pct(a.share)}`).join(" · ")} · ${pct(e.unallocatedShare)} unallocated`
                  : "No rule. Nobody's margin carries this."}
              </div>

              {isOpen && (
                <div className="mt-3 border-t pt-3">
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {BASES.map((b) => (
                      <button
                        key={b.key}
                        onClick={() => void auto(e.id, b.key)}
                        title={b.hint}
                        className="hover:bg-accent rounded-lg border px-2.5 py-1 text-[11.5px]"
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {d.ventures.map((v) => {
                      const key = `${e.id}:${v.id}`;
                      return (
                        <label key={v.id} className="flex items-center gap-2 text-[12px]">
                          <Input
                            value={shown(e.id, v.id, e.allocations)}
                            onChange={(ev) => setManual({ ...manual, [key]: ev.target.value })}
                            placeholder="0"
                            className="h-7 w-16 text-right text-[12px] tabular-nums"
                          />
                          <span className="text-muted-foreground">%</span>
                          <span className="truncate">{v.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => void saveManual(e.id, e.allocations)}
                    className="hover:bg-accent mt-3 rounded-lg border px-2.5 py-1 text-[11.5px]"
                  >
                    Save these shares
                  </button>
                  <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
                    Shares may add up to less than 100%. What is left over stays unallocated overhead and appears in
                    the portfolio P&amp;L — which is a truer answer than forcing a split nobody believes. More than
                    100% is refused: that is double counting.
                  </p>
                </div>
              )}

              {message?.id === e.id && (
                <p className={cn("mt-2 text-[11.5px] leading-relaxed", message.text.startsWith("Saved") ? "text-muted-foreground" : "text-foreground")}>
                  {message.text}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-muted-foreground mt-4 border-t pt-2 text-[11px] leading-relaxed">{d.note}</p>
    </>
  );
}
