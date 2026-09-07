import { Clapperboard, Shapes, Inbox, Mail, MessageSquare, Send, SendHorizontal, Sparkles, Sprout, Timer } from "lucide-react";
import { appPage } from "../../../shared/navigation";

export const MAIL_PAGES = [
  { slug: "email", label: "Email", icon: Mail },
  { slug: "triage", label: "Triage", icon: Inbox },
  { slug: "outbox", label: "Outbox", icon: SendHorizontal },
  { slug: "nurture", label: "Nurture", icon: Sprout },
].map(page => ({ ...page, to: appPage(page.slug) }));

export const SOCIAL_PAGES = [
  { slug: "studio", label: "Studio", icon: Sparkles },
  { slug: "autopilot", label: "Autopilot", icon: Timer },
  { slug: "video", label: "Video", icon: Clapperboard },
  { slug: "motion", label: "Motion", icon: Shapes },
  { slug: "publishing", label: "Publishing", icon: Send },
  /* The return leg: the timeline read back from the platform, beside the
     queue going out to it. Added by the socialfeed area. */
  { slug: "posts", label: "Posts", icon: MessageSquare },
].map(page => ({ ...page, to: appPage(page.slug) }));
