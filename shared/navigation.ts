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
  motion: "/social/motion",
  publishing: "/social/publishing",
  /* A campaign run is read on the Publishing page's Campaigns tab, so the run
     kind resolves to the same address as the page. */
  campaign: "/social/publishing",
  posts: "/social/posts",
  /* The three growth readings are reports on the Dashboards page, beside
     Email stats. The SEO, SERP and ASO run apps are not listed: they are
     sub-agents' work and read at /outputs/<slug> with the other five. */
  mobilehealth: "/dashboards/reports/mobile-health",
  webanalytics: "/dashboards/reports/web-analytics",
  growth: "/dashboards/reports/growth",
  ops: "/ops",
};

export function appPage(slug: string, runId?: string): string {
  const base = Object.hasOwn(MOVED_APPS, slug) ? MOVED_APPS[slug]! : `/outputs/${encodeURIComponent(slug)}`;
  return runId ? `${base}/${encodeURIComponent(runId)}` : base;
}

export function sidebarPath(path: string): string {
  return path === "/apps" ? "/outputs" : path;
}
