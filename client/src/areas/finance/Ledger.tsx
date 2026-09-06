import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { finance, type Expense } from "@/lib/api/finance";
import { amount, currencies } from "./format";

/**
 * THE LEDGER TABLE — every recurring cost, editable in place.
 *
 * INLINE EDIT RATHER THAN A DIALOG, because the common task here is typing a
 * price into a row that a registrar could not supply, twenty-three times. A
 * dialog per row would make that an afternoon. A field commits on blur or
 * Enter and reverts on Escape, and the row shows what happened.
 *
 * THE SEEDED ROWS LOOK DIFFERENT FROM THE TYPED ONES and that is the point. A
 * row with a source is refreshed from a provider every half hour; a column the
 * owner has corrected wears a mark, because "will this be overwritten" is the
 * question somebody asks before they bother typing.
 *
 * A NULL PRICE IS A DASH AND A PROMPT, never a zero. See ./format.
 */

const CATEGORIES = ["server", "domain", "service", "subscription", "salary", "other"] as const;
const PERIODS = ["monthly", "yearly", "once"] as const;

function Cell({
  value,
  placeholder,
  owned,
  numeric,
  onSave,
}: {
  value: string;
  placeholder?: string;
  owned?: boolean;
  numeric?: boolean;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);

  if (!editing)
    return (
      <button
        onClick={() => { setDraft(value); setEditing(true); }}
        className={cn(
          "hover:bg-accent -mx-1 w-full rounded px-1 py-0.5 text-left text-[12.5px]",
          numeric && "text-right tabular-nums",
          !value && "text-muted-foreground",
        )}
        title={owned ? "You typed this. A provider refresh will not overwrite it." : undefined}
      >
        {value || placeholder || "—"}
        {owned && <span className="text-muted-foreground ml-1 text-[10px]">✎</span>}
      </button>
    );

  return (
    <Input
      autoFocus
      value={draft}
      disabled={busy}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setEditing(false);
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      onBlur={async () => {
        if (draft === value) { setEditing(false); return; }
        setBusy(true);
        try { await onSave(draft); } finally { setBusy(false); setEditing(false); }
      }}
      className={cn("h-7 px-1 text-[12.5px]", numeric && "text-right tabular-nums")}
    />
  );
}

function Row({ e, onChange }: { e: Expense; onChange: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const owned = new Set(e.ownerFields);

  const patch = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await finance.updateExpense(e.id, body);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      <tr className="border-line-soft border-b align-top">
        <td className="py-1.5 pr-3">
          <Cell value={e.label} owned={owned.has("label")} onSave={(v) => patch({ label: v })} />
          <div className="text-muted-foreground mt-0.5 text-[11px]">
            {e.source === "manual" ? "typed" : e.source}
            {e.confidence ? ` · ${e.confidence}` : ""}
            {e.archived ? " · archived" : ""}
          </div>
        </td>
        <td className="py-1.5 pr-3">
          <select
            value={e.category}
            onChange={(ev) => void patch({ category: ev.target.value })}
            className="bg-transparent text-[12.5px] outline-none"
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </td>
        <td className="py-1.5 pr-3 text-right">
          <Cell
            numeric
            value={e.amount === null ? "" : String(e.amount)}
            placeholder="— set a price"
            owned={owned.has("amount")}
            onSave={(v) => patch({ amount: v.trim() === "" ? null : Number(v) })}
          />
        </td>
        <td className="py-1.5 pr-3">
          <Cell value={e.currency} owned={owned.has("currency")} onSave={(v) => patch({ currency: v })} />
        </td>
        <td className="py-1.5 pr-3">
          <select
            value={e.period}
            onChange={(ev) => void patch({ period: ev.target.value })}
            className="bg-transparent text-[12.5px] outline-none"
          >
            {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </td>
        <td className="py-1.5 pr-3 text-right tabular-nums text-[12.5px]">
          {amount(e.monthly, e.currency)}
        </td>
        <td className="py-1.5 pr-3 text-[12.5px]">
          {e.shared ? <span className="text-muted-foreground">shared</span> : e.venture}
        </td>
        <td className="py-1.5 text-[12.5px]">
          <Cell
            value={e.renewalOn ?? ""}
            placeholder="—"
            owned={owned.has("renewal_on")}
            onSave={(v) => patch({ renewalOn: v.trim() || null })}
          />
        </td>
      </tr>
      {error && (
        <tr><td colSpan={8} className="text-destructive pb-1.5 text-[11.5px]">{error}</td></tr>
      )}
    </>
  );
}

export function Ledger() {
  const [showArchived, setShowArchived] = useState(false);
  const doc = useApi(() => finance.expenses({ archived: showArchived }), [showArchived]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ label: "", category: "service", currency: "EUR", period: "monthly", amount: "" });
  const [addError, setAddError] = useState<string | null>(null);

  if (doc.error) return <p className="text-muted-foreground text-[13px]">The API is not answering: {doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[13px]">Reading the ledger…</p>;
  const d = doc.data;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <div className="text-[25px] font-normal tracking-[-0.03em] tabular-nums">{currencies(d.monthly)}</div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">
            per month · {d.count} rows{d.monthly.unpriced ? ` · ${d.monthly.unpriced} with no price yet` : ""}
          </div>
        </div>
        <div>
          <div className="text-[25px] font-normal tracking-[-0.03em] tabular-nums">{currencies(d.annual)}</div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">per year, each bill at its own cadence</div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <label className="text-muted-foreground flex items-center gap-1.5 text-[11.5px]">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            show archived
          </label>
          <button
            onClick={() => setAdding((v) => !v)}
            className="hover:bg-accent rounded-lg border px-2.5 py-1 text-[12px]"
          >
            {adding ? "Cancel" : "Add a cost"}
          </button>
          <button
            onClick={() => void finance.refresh().then(() => doc.reload())}
            className="hover:bg-accent rounded-lg border px-2.5 py-1 text-[12px]"
            title="Re-read the servers, volumes and domain renewals now. Your own corrections are never overwritten."
          >
            Refresh from providers
          </button>
        </div>
      </div>

      {adding && (
        <div className="bg-card mb-4 rounded-[10px] border p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11.5px]">
              <div className="text-muted-foreground mb-1">What the bill is for</div>
              <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} className="h-8 w-56 text-[12.5px]" />
            </label>
            <label className="text-[11.5px]">
              <div className="text-muted-foreground mb-1">Category</div>
              <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="bg-card h-8 rounded-md border px-2 text-[12.5px]">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-[11.5px]">
              <div className="text-muted-foreground mb-1">Amount</div>
              <Input value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} placeholder="leave empty if unknown" className="h-8 w-36 text-[12.5px]" />
            </label>
            <label className="text-[11.5px]">
              <div className="text-muted-foreground mb-1">Currency</div>
              <Input value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} className="h-8 w-20 text-[12.5px]" />
            </label>
            <label className="text-[11.5px]">
              <div className="text-muted-foreground mb-1">Period</div>
              <select value={draft.period} onChange={(e) => setDraft({ ...draft, period: e.target.value })} className="bg-card h-8 rounded-md border px-2 text-[12.5px]">
                {PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <button
              onClick={async () => {
                setAddError(null);
                try {
                  await finance.createExpense({
                    ...draft,
                    amount: draft.amount.trim() === "" ? null : Number(draft.amount),
                  });
                  setDraft({ label: "", category: "service", currency: "EUR", period: "monthly", amount: "" });
                  setAdding(false);
                  doc.reload();
                } catch (err) {
                  setAddError(err instanceof Error ? err.message : String(err));
                }
              }}
              className="hover:bg-accent h-8 rounded-lg border px-3 text-[12px]"
            >
              Add
            </button>
          </div>
          <p className="text-muted-foreground mt-2 text-[11px] leading-relaxed">
            Leave the amount empty if you do not know the price. It will be listed, excluded from every total, and
            counted as unpriced — which is the honest answer, and better than a guess that gets quoted back at you.
          </p>
          {addError && <p className="text-destructive mt-1 text-[11.5px]">{addError}</p>}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr className="text-muted-foreground border-b text-left text-[11px]">
              <th className="pb-1.5 pr-3 font-normal">Cost</th>
              <th className="pb-1.5 pr-3 font-normal">Category</th>
              <th className="pb-1.5 pr-3 text-right font-normal">Amount</th>
              <th className="pb-1.5 pr-3 font-normal">Cur</th>
              <th className="pb-1.5 pr-3 font-normal">Period</th>
              <th className="pb-1.5 pr-3 text-right font-normal">Per month</th>
              <th className="pb-1.5 pr-3 font-normal">Venture</th>
              <th className="pb-1.5 font-normal">Renews</th>
            </tr>
          </thead>
          <tbody>
            {d.expenses.map((e) => <Row key={e.id} e={e} onChange={doc.reload} />)}
          </tbody>
        </table>
      </div>

      <p className="text-muted-foreground mt-4 border-t pt-2 text-[11px] leading-relaxed">{d.note}</p>
    </>
  );
}
