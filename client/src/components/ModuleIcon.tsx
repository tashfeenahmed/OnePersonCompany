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
  "/social/autopilot": "autopilot",
  "/social/video": "video",
  "/social/motion": "motion",
  "/social/publishing": "publishing",
  "/outputs/posts": "posts",
  "/activity": "activity",
  "/customers": "customers",
  "/alerts": "alerts",
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
