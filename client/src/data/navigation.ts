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
