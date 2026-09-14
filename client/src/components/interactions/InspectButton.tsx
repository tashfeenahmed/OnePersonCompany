import type { ReactNode } from "react";
import { Expand } from "lucide-react";
import { useDetailDrawer } from "./DetailDrawer";
export function InspectButton({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const open = useDetailDrawer();
  return <button type="button" aria-label={`Inspect ${title}`} title={`Inspect ${title}`} className="widget-action shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary" onPointerDown={e => e.stopPropagation()} onClick={() => open({ title, description, content: children })}><Expand className="size-3.5"/></button>;
}
