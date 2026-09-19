import { Mail, Sparkles } from "lucide-react";
import { appPage } from "../../../shared/navigation";

/* ONE MAIL ROW, BECAUSE THERE IS ONE MAIL PAGE. Triage, Outbox and Nurture
   each had a row here and each of them is a TAB of the Email page now, beside
   the mailbox's two modes and the commitments lifted out of People — see
   pages/Email.tsx. Four rows for six views reached six ways was the rail
   teaching a menu the page no longer had. Their addresses are unchanged;
   they are simply not rows. */
export const MAIL_PAGES = [
  { slug: "email", label: "Email", icon: Mail },
].map(page => ({ ...page, to: appPage(page.slug) }));

/* ONE SOCIAL ROW, BECAUSE THERE IS ONE SOCIAL PAGE. Autopilot, Video,
   Motion, Publishing and Posts each had a row here and each of them is now
   somewhere inside the Studio: Autopilot and Publishing draw in its column,
   Motion is a tab in its composer, Posts is a tab in Publishing, and a video
   run is opened from the Studio's own rail. Six rows for one screen was the
   rail teaching a menu it no longer had. The addresses those rows pointed at
   still resolve — see App.tsx — they are just redirects now rather than
   places the sidebar sends anybody. */
export const SOCIAL_PAGES = [
  { slug: "studio", label: "Studio", icon: Sparkles },
].map(page => ({ ...page, to: appPage(page.slug) }));

/**
 * ONE LIST, IN THE BUILD'S DEFAULT ORDER. This was five headed groups once —
 * Manage, Insights, Work, Mail, Social media — each folding on its own; see
 * shared/sidebarNav.ts for why it is one list now. The order here is the
 * default the owner's own order (state.navOrder) is laid over: the daily
 * work first, then mail, then social, then the readings about the business,
 * then the machinery. What is above the fold with nothing dragged is the
 * first `VISIBLE` of these.
 *
 * SOCIAL IS ONE ROW. It was six — Studio, Autopilot, Video, Motion,
 * Publishing, Posts — and every one of the other five is now a place INSIDE
 * the Studio: two draw in its column, two are tabs, and a video run is opened
 * from its own rail. A rail listing six doors to one screen was teaching a
 * menu that had stopped existing. Their paths still resolve as redirects (see
 * App.tsx); they are simply not rows, so a saved order or a pin naming one is
 * dropped rather than translated — see shared/navigation.ts.
 *
 * MAIL IS ONE ROW, for the same reason and by the same move. It was four —
 * Email, Triage, Outbox, Nurture — and all four are tabs of one page at /mail
 * now, along with the mailbox's Sent mode and every tab People had: Contacts,
 * Stale, Brief and Commitments are questions about mail, so People stopped
 * being a row too and /people redirects onto them (see App.tsx). The row is
 * "here" for every address under it, which is what `isHere` below already does
 * for a prefix.
 *
 * ACTIVITY, ALERTS, INTEGRATIONS AND OPS ARE NOT ROWS EITHER — see MENU
 * below the list.
 */
export const NAV = [
  { to: "/board", label: "Board" },
  { to: "/ventures", label: "Ventures" },
  { to: "/calendar", label: "Calendar" },
  { to: "/workflows", label: "Workflows" },
  /* Social is one row now — the Studio — and it is the day's making, so it
     sits above the mail pages and above the fold. */
  ...SOCIAL_PAGES,
  ...MAIL_PAGES,
  { to: "/dashboards", label: "Dashboards" },
  /* OUTPUTS IS A ROW OF ITS OWN, since 2026-09-18, and it unfolds like
     Dashboards into the nine report pages. It was the Sub-agents page's
     third tab, four presses from a report; a report is the thing the workers
     exist to make and it deserves a door. See components/SidebarOutputs.tsx. */
  { to: "/outputs", label: "Outputs" },
  { to: "/subagents", label: "Sub-agents" },
];

/**
 * THE MACHINERY LIVES IN THE OWNER'S MENU, not the rail. The action inbox,
 * Activity, Alerts, Integrations and Ops are about the box rather than the
 * business — what it wants of him, what it did, what tripped, what it is
 * connected to, what it is running on — and the owner reaches for them the
 * way he reaches for Settings: seldom, and from the bottom. They sit between
 * Settings and Appearance in the menu on his name, in the order a check-up
 * runs. Customers stopped being a page altogether; its readings live on the
 * dashboards. Their addresses still resolve; a
 * saved order or a pin naming one is dropped, as for every other row that
 * stopped being a row.
 */
export const MENU = [
  { to: "/action-inbox", label: "Action inbox" },
  { to: "/activity", label: "Activity" },
  { to: "/insights", label: "Insights" },
  { to: "/alerts", label: "Alerts" },
  { to: "/integrations", label: "Integrations" },
  { to: "/ops", label: "Ops" },
];
