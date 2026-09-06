import { cn } from "@/lib/utils";

// Vite fingerprints these files and serves them through the production /assets route.
const artwork = import.meta.glob<string>("../assets/modules/*.webp", { eager: true, query: "?url&no-inline", import: "default" });

const icons: Record<string, string> = {
  "/action-inbox": "action-inbox",
  "/board": "board",
  "/outputs": "outputs",
  "/ventures": "ventures",
  "/people": "people",
  "/workflows": "workflows",
  "/mail/email": "email",
  "/mail/triage": "triage",
  "/mail/outbox": "outbox",
  "/social/studio": "studio",
  "/social/autopilot": "autopilot",
  "/social/video": "video",
  "/growth/seo": "seo",
  "/growth/serp": "serp",
  "/growth/aso": "aso",
  "/growth/overview": "growth",
  "/activity": "activity",
  "/alerts": "alerts",
  "/dashboards": "dashboards",
  "/subagents": "subagents",
  "/org": "org",
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
