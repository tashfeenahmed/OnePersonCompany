import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function SidebarSection({ title, active, defaultOpen, pathname, children }: {
  title: string;
  active: boolean;
  defaultOpen: boolean;
  pathname: string;
  children: ReactNode;
}) {
  const contentId = useId();
  const [expansion, setExpansion] = useState({ pathname, open: defaultOpen || active });
  // Reveal the destination on navigation; background refreshes never undo a manual toggle.
  if (expansion.pathname !== pathname) {
    setExpansion({ pathname, open: active || expansion.open });
  }
  const setOpen = (open: boolean) => setExpansion({ pathname, open });

  return <section className="sidebar-section" data-open={expansion.open}>
    <button
      type="button"
      aria-expanded={expansion.open}
      aria-controls={contentId}
      className={cn("flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "text-foreground/80")}
      onClick={() => setOpen(!expansion.open)}
      onKeyDown={event => {
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault(); setOpen(event.key === "ArrowRight");
        }
      }}
    >
      {title}
      <ChevronRight aria-hidden="true" className="sidebar-section-chevron size-3.5 shrink-0" strokeWidth={1.75} />
    </button>
    <div id={contentId} className="sidebar-section-panel" aria-hidden={!expansion.open} inert={!expansion.open}>
      <div className="min-h-0 overflow-hidden"><div className="pb-1">{children}</div></div>
    </div>
  </section>;
}
