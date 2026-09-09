import { cn } from "@/lib/utils";

// Vite fingerprints these files and serves them through the production /assets route.
const artwork = import.meta.glob<string>("../assets/modules/*.webp", { eager: true, query: "?url&no-inline", import: "default" });

const icons: Record<string, string> = {
  "/action-inbox": "action-inbox",
  "/board": "board",
  "/ventures": "ventures",
  "/workflows": "workflows",
  /* THE ONLY MAIL ROW. Triage, Outbox, Nurture and People each had a key here
     and every one of them is a tab of the Email page now. This map is keyed by
     the path a SIDEBAR ROW links to and a path that is not in it draws no
     artwork at all, so a key with no row is dead weight; triage.webp,
     people.webp and the rest are still in assets/modules, ready for whatever
     names those paths again. */
  "/mail": "email",
  /* THE ONLY SOCIAL ROW. Autopilot, Video, Motion, Publishing and Posts each
     had a key here and each of them is inside the Studio now — two in its
     column, two as tabs, and a video run opened from its rail. This map is
     keyed by the path a SIDEBAR ROW links to and a path that is not in it
     draws no artwork at all, so a key with no row is dead weight; their
     artwork (autopilot.webp and the rest) is still in assets/modules, ready
     for whatever names those paths again. */
  "/social/studio": "studio",
  "/activity": "activity",
  "/customers": "customers",
  "/alerts": "alerts",
  /* THE ONE ROW WEARING SOMEBODY ELSE'S ARTWORK. Every icon in this set was
     generated to order — see design/module-icons/prompts.json — and there is
     no calendar among them. The kanban board is the nearest honest stand-in
     (a ruled grid of columns and cards is what a week view is), and it is
     deliberately not a lookalike drawn by hand in a different style: one icon
     that does not match is a smaller fault than one that almost does. Replace
     it with a `calendar.webp` generated from that file's prompt structure. */
  "/calendar": "board",
  "/dashboards": "dashboards",
  /* The org-tree artwork: the Sub-agents page IS the org chart. */
  "/subagents": "org",
  "/integrations": "integrations",
  "/ops": "ops",
  "/settings": "settings",
  "/chat": "chat",
};

/** Decorative artwork: the adjacent link supplies the accessible name. */
export function ModuleIcon({ path, className }: { path: string; className?: string }) {
  const icon = icons[path];
  if (!icon) return null;
  return <img
    src={artwork[`../assets/modules/${icon}.webp`]}
    alt=""
    aria-hidden="true"
    width={20}
    height={20}
    draggable={false}
    decoding="async"
    className={cn("module-icon size-5 shrink-0 select-none object-contain", className)}
  />;
}
