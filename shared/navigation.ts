// Canonical destinations for tools moved out of the Apps area.
export const MOVED_APPS: Readonly<Record<string, string>> = {
  board: "/board",
  /* MAIL IS ONE PAGE WITH NINE TABS. The mailbox is what /mail opens on, and
     Triage, the Outbox, Nurture and everything People used to hold are tabs of
     the same header rather than pages of their own — the addresses are unchanged, so a tool named here
     still resolves to the view somebody meant. */
  email: "/mail",
  mailbox: "/mail",
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
  /* THE SCENE-LIST EDITOR IS A TAB IN THE STUDIO'S COMPOSER, so the tool
     called "motion" resolves to that tab. The `runId` form of `appPage` means
     nothing here and never did: a motion render is a `video` run and is read
     at /social/video/<id> like every other one. */
  motion: "/social/studio?make=motion",
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
  /* The mail row moved from /mail/email to /mail when the four mail pages
     became one, so an owner who dragged Email up their rail or pinned it keeps
     both. NOTHING FOR TRIAGE, OUTBOX OR NURTURE, for the reason spelled out
     below: they stopped being rows. Renaming them to /mail would land a pin
     made for Triage on the Inbox tab, which is not where that pin was
     pointing. */
  "/mail/email": "/mail",
  /* PEOPLE MOVED INTO THE MAIL PAGE — its Contacts tab is what /people opened
     on, so that is where a saved order or a pin naming it now points. THIS ONE
     IS A RENAME AND NOT A DROP, unlike Motion and Posts below: the page the
     owner pinned still exists at an address of its own, and pointing at the
     mail row instead would land it on the Inbox, which is not what they
     pinned. */
  "/people": "/mail/contacts",
  /* NOTHING FOR VIDEO, MOTION OR POSTS. Those three did not move — they
     STOPPED BEING ROWS. A rename here would put a pin the owner made for
     Motion onto the Studio, which is a different row they may already have
     pinned; dropping it is the honest end for a pin whose page is gone, and
     both readers drop what they cannot find. */
};

/** A stored path brought up to date. */
export function sidebarPath(path: string): string {
  return Object.hasOwn(RENAMED, path) ? RENAMED[path]! : path;
}
