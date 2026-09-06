// Canonical destinations for tools moved out of the Apps area.
export const MOVED_APPS: Readonly<Record<string, string>> = {
  board: "/board",
  email: "/mail/email",
  mailbox: "/mail/email",
  "email-stats": "/dashboards/reports/email-stats",
  triage: "/mail/triage",
  outbox: "/mail/outbox",
  studio: "/social/studio",
  autopilot: "/social/autopilot",
  video: "/social/video",
  seo: "/growth/seo",
  serp: "/growth/serp",
  aso: "/growth/aso",
  growth: "/growth/overview",
  ops: "/ops",
};

export function appPage(slug: string, runId?: string): string {
  const base = Object.hasOwn(MOVED_APPS, slug) ? MOVED_APPS[slug]! : `/outputs/${encodeURIComponent(slug)}`;
  return runId ? `${base}/${encodeURIComponent(runId)}` : base;
}

export function sidebarPath(path: string): string {
  return path === "/apps" ? "/outputs" : path;
}
