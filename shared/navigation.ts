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
  /* AUTOPILOT AND PUBLISHING LIVE INSIDE THE STUDIO. Both are rows in its
     left rail and draw in its column, beside the list of everything that has
     been made — the schedule that fills that list, and the queue a finished
     piece leaves by. Their old addresses redirect here, so what changes by
     naming the new ones is only where the sidebar's own rows point. */
  autopilot: "/social/studio/autopilot",
  video: "/social/video",
  motion: "/social/motion",
  publishing: "/social/studio/publishing",
  /* A campaign run is read on the Publishing page's Campaigns tab, so the run
     kind resolves to the same address as the page. */
  campaign: "/social/studio/publishing",
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

/* WHAT A ROW USED TO BE CALLED. The sidebar's saved order and the owner's
   pins are both stored as bare paths, and both DROP anything they cannot find
   in today's nav list — so a page that moves loses its pin and its place in
   the order unless the old spelling is translated. */
const RENAMED: Readonly<Record<string, string>> = {
  "/apps": "/outputs",
  "/social/autopilot": "/social/studio/autopilot",
  "/social/publishing": "/social/studio/publishing",
};

/** A stored path brought up to date. */
export function sidebarPath(path: string): string {
  return Object.hasOwn(RENAMED, path) ? RENAMED[path]! : path;
}
