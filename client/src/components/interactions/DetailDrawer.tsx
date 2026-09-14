import { useUndoActions } from "./UndoActions";
import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { ArrowLeft, X } from "lucide-react";
import { useLocation } from "react-router-dom";

type Detail = { title: string; description?: string; content: ReactNode };
const Context = createContext<(detail: Detail) => void>(() => {});
// eslint-disable-next-line react-refresh/only-export-components
export const useDetailDrawer = () => useContext(Context);
export function DetailDrawerProvider({ children }: { children: ReactNode }) {
  const { notifications } = useUndoActions();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [history, setHistory] = useState<Detail[]>([]);
  const [open, setOpen] = useState(false);
  const origin = useRef<HTMLElement | null>(null);
  const location = useLocation();
  const [openedPath, setOpenedPath] = useState(location.pathname);
  const content = useRef<HTMLDivElement>(null);
  if (open && openedPath !== location.pathname) setOpen(false);
  return <Context.Provider value={next => { if (!open) { origin.current = document.activeElement as HTMLElement; setHistory([]); } else if (detail) setHistory(rows => [...rows, detail]); setDetail(next); setOpenedPath(location.pathname); setOpen(true); }}>
    {children}
    {!open && notifications}
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="detail-shade fixed inset-0 z-50 bg-black/20" />
        <Dialog.Content ref={content} onEscapeKeyDown={e => { const pinned = content.current?.querySelector<HTMLButtonElement>("[data-chart-pinned] button"); if(pinned){e.preventDefault(); pinned.click();} }} className="detail-drawer fixed inset-y-0 right-0 z-50 flex w-full max-w-[600px] flex-col border-l bg-background text-foreground shadow-xl outline-none" onCloseAutoFocus={e => { e.preventDefault(); if (origin.current?.isConnected) origin.current.focus({ preventScroll: true }); }}>
          <header className="flex shrink-0 items-start gap-4 border-b px-6 py-5">
            {history.length > 0 && <button type="button" aria-label="Back to previous details" className="rounded-lg p-2 hover:bg-accent" onClick={() => { setDetail(history.at(-1)!); setHistory(rows => rows.slice(0,-1)); }}><ArrowLeft className="size-4"/></button>}
            <div className="min-w-0 flex-1"><Dialog.Title className="text-lg font-semibold">{detail?.title}</Dialog.Title><Dialog.Description className={detail?.description ? "mt-1 text-xs text-muted-foreground" : "sr-only"}>{detail?.description ?? "Details for the selected item."}</Dialog.Description></div>
            <Dialog.Close className="rounded-lg p-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary" aria-label="Close details"><X className="size-4"/></Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6 pb-28">{detail?.content}</div>
          {open && notifications}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </Context.Provider>;
}
