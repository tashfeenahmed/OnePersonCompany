// Canonical destinations for tools moved out of the Apps area.
export const MOVED_APPS: Readonly<Record<string, string>> = {
  board: "/board",
  email: "/mail/email",
  mailbox: "/mail/email",
  "email-stats": "/dashboards/reports/email-stats",
  triage: "/mail/triage",
  outbox: "/mail/outbox",
  nurture: "/mail/nurture",
  studio: "/social/studio",
  autopilot: "/social/autopilot",
  video: "/social/video",
  publishing: "/social/publishing",
  /* A campaign run is read on the Publishing page's Campaigns tab, so the run
     kind resolves to the same address as the page. */
  campaign: "/social/publishing",
  seo: "/growth/seo",
  serp: "/growth/serp",
  aso: "/growth/aso",
  mobilehealth: "/growth/mobilehealth",
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
