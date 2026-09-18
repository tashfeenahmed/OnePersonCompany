import {
  Activity, Bell, CalendarDays, ChartNoAxesCombined, Columns3, FolderKanban, Inbox,
  LayoutDashboard, Mail, MessageSquare, Network, Palette, Plug, ScrollText,
  Server, Settings, Workflow, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Navigation always uses Lucide, including pinned pages and the owner menu.
const icons: Record<string, LucideIcon> = {
  "/action-inbox": Inbox,
  "/board": Columns3,
  "/ventures": FolderKanban,
  "/workflows": Workflow,
  "/mail": Mail,
  "/social/studio": Palette,
  "/activity": Activity,
  "/insights": ChartNoAxesCombined,
  "/alerts": Bell,
  "/calendar": CalendarDays,
  "/dashboards": LayoutDashboard,
  "/outputs": ScrollText,
  "/subagents": Network,
  "/integrations": Plug,
  "/ops": Server,
  "/settings": Settings,
  "/chat": MessageSquare,
};

/** Decorative: the adjacent link supplies the accessible name. */
export function ModuleIcon({ path, className }: { path: string; className?: string }) {
  const Icon = Object.hasOwn(icons, path) ? icons[path] : undefined;
  if (!Icon) return null;
  return <Icon aria-hidden="true" strokeWidth={1.6} className={cn("size-4 shrink-0", className)} />;
}
