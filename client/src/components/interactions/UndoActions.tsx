import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { call } from "@/lib/api";
import { randomId } from "@/lib/id";

export type UndoResult = { undo?: { token: string; expiresAt: number } | null };
type Action = { key: string; label: string; run: () => Promise<UndoResult>; refresh?: () => void };
type Toast = { id: string; key?: string; label: string; receipt?: NonNullable<UndoResult["undo"]>; error?: string; refresh?: () => void };
const Context = createContext<{ perform: (action: Action) => Promise<boolean>; busy: ReadonlySet<string>; handled: ReadonlySet<string>; notifications: ReactNode }>({ perform: async () => false, busy: new Set(), handled: new Set(), notifications: null });
// eslint-disable-next-line react-refresh/only-export-components
export const useUndoActions = () => useContext(Context);
export function UndoActionsProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [handled, setHandled] = useState<ReadonlyMap<string, number>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const active = useRef(new Set<string>());
  const working = (key: string, value: boolean) => { if (value) active.current.add(key); else active.current.delete(key); setBusy(new Set(active.current)); };
  const changed = () => window.dispatchEvent(new Event("opc:data-changed"));
  useEffect(() => {
    if (!toasts.length && !handled.size) return;
    const timer = setInterval(() => {
      setToasts(rows => { const next = rows.filter(t => t.error || (t.receipt?.expiresAt ?? 0) > Date.now()); return next.length === rows.length ? rows : next; });
      setHandled(rows => { const next = new Map([...rows].filter(([,until]) => until > Date.now())); return next.size === rows.size ? rows : next; });
    }, 1000);
    return () => clearInterval(timer);
  }, [toasts.length, handled.size]);
  async function perform(action: Action) {
    if (active.current.has(action.key)) return false;
    working(action.key, true);
    try {
      const result = await action.run();
      setHandled(rows => new Map([...rows, [action.key, Date.now() + 30_000]]));
      if (result.undo) setToasts(rows => [...rows, { id: result.undo!.token, key: action.key, label: action.label, receipt: result.undo!, refresh: action.refresh }]);
      action.refresh?.(); changed(); return true;
    } catch (error) {
      setToasts(rows => [...rows, { id: randomId(), label: "Couldn’t update this item", error: error instanceof Error ? error.message : String(error) }]);
      return false;
    } finally { working(action.key, false); }
  }
  async function undo(toast: Toast) {
    if (active.current.has(toast.id)) return;
    working(toast.id, true);
    try {
      await call(`/action-inbox/undo/${toast.receipt!.token}`, { method: "POST" });
      setToasts(rows => rows.filter(t => t.id !== toast.id));
      setHandled(rows => { const next = new Map(rows); next.delete(toast.key!); return next; });
      toast.refresh?.(); changed();
    } catch (error) {
      setToasts(rows => rows.map(t => t.id === toast.id ? { ...t, receipt: undefined, error: error instanceof Error ? error.message : String(error) } : t));
      toast.refresh?.(); changed();
    } finally { working(toast.id, false); }
  }
  const notifications = <div className="pointer-events-none fixed inset-x-3 bottom-5 z-[70] mx-auto flex max-h-[45vh] max-w-md flex-col gap-2 overflow-y-auto" aria-label="Recent actions">
      {toasts.map(t => <div key={t.id} className="dashboard-enter pointer-events-auto flex items-center gap-3 rounded-xl border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg">
        <div className="min-w-0 flex-1" role={t.error ? "alert" : "status"}><p>{t.label}</p>{t.error && <p className="mt-1 text-xs text-destructive">{t.error}</p>}</div>
        {t.receipt && <button className="shrink-0 rounded px-2 py-1 font-medium underline underline-offset-4 disabled:opacity-40" disabled={busy.has(t.id)} onClick={() => void undo(t)} aria-label={`Undo: ${t.label}`}>Undo</button>}
        <button className="rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Dismiss notification" onClick={() => setToasts(rows => rows.filter(r => r.id !== t.id))}><X className="size-4"/></button>
      </div>)}
    </div>;
  return <Context.Provider value={{ perform, busy, handled: new Set(handled.keys()), notifications }}>{children}</Context.Provider>;
}
