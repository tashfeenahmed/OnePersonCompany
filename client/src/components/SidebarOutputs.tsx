import { useId, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ModuleIcon } from "./ModuleIcon";
import { SidebarPinButton } from "./SidebarPinButton";
import { SortableList } from "./SortableList";
import { orderedOutputs } from "@/data/outputs";
import { appPage } from "../../../shared/navigation";

/**
 * THE OUTPUTS ROW, WHICH OPENS LIKE DASHBOARDS.
 *
 * One row that unfolds into the nine report pages — Research, Competitors,
 * Demand and the rest — each a link to its own page. It is the Dashboards
 * accordion with a different list under it, and deliberately so: two rows
 * that expand should expand the same way, or the rail teaches two gestures
 * for one idea.
 *
 * OPEN WHEN YOU ARE INSIDE IT, and it stays as you left it otherwise. Arriving
 * at a report page unfolds the row — a rail that hides the page you are on
 * is not a rail — and closing it by hand is remembered until the next
 * navigation, which is the rule the Dashboards row follows.
 *
 * DRAGGABLE, into the owner's order. The same `appOrder` the old tab strip
 * kept, so an order dragged there is the order here.
 */
export function SidebarOutputs({ pinned, onTogglePin }: { pinned: boolean; onTogglePin: () => void }) {
  const { state, setAppOrder } = useStore();
  const { pathname } = useLocation();
  const here = pathname === "/outputs" || pathname.startsWith("/outputs/");
  const [expanded, setExpanded] = useState({ pathname, open: here });
  if (expanded.pathname !== pathname) setExpanded({ pathname, open: expanded.open || here });
  const contentId = useId();
  const outputs = orderedOutputs(state.appOrder);
  return <div>
    <div className={cn("sidebar-row flex min-w-0 items-center gap-0.5 rounded-lg pr-1 transition-colors focus-within:bg-accent", here && !expanded.open ? "bg-accent font-medium" : "hover:bg-accent")}>
      <button type="button" data-sort-handle aria-label="Outputs" aria-expanded={expanded.open} aria-controls={contentId}
        onClick={() => setExpanded({ pathname, open: !expanded.open })}
        className="sidebar-dashboard-toggle flex min-w-0 flex-1 items-center gap-2 py-1 pl-1.5 text-left text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg">
        <span className="relative size-4 shrink-0">
          <ModuleIcon path="/outputs" className="sidebar-dashboard-icon absolute inset-0" />
          <ChevronRight aria-hidden="true" strokeWidth={1.7} className={cn("sidebar-dashboard-chevron absolute inset-0 size-4", expanded.open && "rotate-90")} />
        </span>
        <span className="truncate">Outputs</span>
      </button>
      <SidebarPinButton label="Outputs" pinned={pinned} onClick={onTogglePin} />
    </div>
    <div id={contentId} aria-hidden={!expanded.open} inert={!expanded.open || undefined}
      className={cn("sidebar-dashboard-accordion grid", expanded.open ? "grid-rows-[1fr] visible" : "grid-rows-[0fr] invisible")}>
      <div className="min-h-0 overflow-hidden">
        <div className="my-1 ml-[13px] border-l border-line-soft pl-2">
          <SortableList items={outputs.map(o => ({ key: o.slug, label: o.name, output: o }))}
            describedAs="output" onReorder={setAppOrder}
            renderItem={item => {
              const to = appPage(item.output.slug);
              const active = pathname === to || pathname.startsWith(`${to}/`);
              return <div className={cn("sidebar-row flex min-w-0 items-center gap-0.5 rounded-lg pr-1 transition-colors", active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
                <Link to={to} aria-current={active ? "page" : undefined} title={item.output.name} draggable={false}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1.5 text-[13px] outline-none">
                  <item.output.icon aria-hidden="true" strokeWidth={1.6} className="size-3.5 shrink-0" />
                  <span className="truncate">{item.output.name}</span>
                </Link>
              </div>;
            }} />
        </div>
      </div>
    </div>
  </div>;
}
