import { Activity, Clapperboard, Inbox, ListChecks, Mail, SearchCheck, Send, SendHorizontal, Smartphone, Sparkles, Sprout, Timer, TrendingUp } from "lucide-react";
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
  { slug: "publishing", label: "Publishing", icon: Send },
].map(page => ({ ...page, to: appPage(page.slug) }));

export const GROWTH_PAGES = [
  { slug: "seo", label: "SEO", icon: SearchCheck },
  { slug: "serp", label: "SERP", icon: ListChecks },
  { slug: "aso", label: "ASO", icon: Smartphone },
  { slug: "mobilehealth", label: "Mobile health", icon: Activity },
  { slug: "overview", label: "Growth", icon: TrendingUp },
].map(page => ({ ...page, to: appPage(page.slug === "overview" ? "growth" : page.slug) }));
