import { cn } from "@/lib/utils";

// Vite fingerprints these files and serves them through the production /assets route.
const artwork = import.meta.glob<string>("../assets/modules/*.webp", { eager: true, query: "?url&no-inline", import: "default" });

const icons: Record<string, string> = {
  "/action-inbox": "action-inbox",
  "/board": "board",
  "/ventures": "ventures",
  "/people": "people",
  "/workflows": "workflows",
  "/mail/email": "email",
  "/mail/triage": "triage",
  "/mail/outbox": "outbox",
  "/mail/nurture": "nurture",
  "/social/studio": "studio",
  /* Two rows that moved INTO the Studio, so the key is the address they have
     now: this map is keyed by the path the sidebar row links to, and a row
     whose path is not in it draws no artwork at all. Their old addresses are
     redirects and are never a row. */
  "/social/studio/autopilot": "autopilot",
  "/social/video": "video",
  "/social/motion": "motion",
  "/social/studio/publishing": "publishing",
  "/social/posts": "posts",
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
