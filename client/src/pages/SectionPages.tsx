import { lazy } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { SubTabs } from "@/components/TabStrip";
import { TopBar } from "@/components/PageShell";
import { GROWTH_PAGES, MAIL_PAGES, SOCIAL_PAGES } from "@/data/navigation";

const Mailbox = lazy(() => import("@/pages/Mailbox").then(m => ({ default: m.Mailbox })));
const Triage = lazy(() => import("@/areas/mailflow/Triage").then(m => ({ default: m.Triage })));
const Outbox = lazy(() => import("@/areas/mailflow/Outbox").then(m => ({ default: m.Outbox })));
const Nurture = lazy(() => import("@/areas/nurture/Nurture").then(m => ({ default: m.Nurture })));
const Studio = lazy(() => import("@/pages/Studio").then(m => ({ default: m.Studio })));
const Autopilot = lazy(() => import("@/areas/video/Autopilot").then(m => ({ default: m.Autopilot })));
const Video = lazy(() => import("@/areas/video/Video").then(m => ({ default: m.Video })));
const Motion = lazy(() => import("@/areas/video/Motion").then(m => ({ default: m.Motion })));
const Publishing = lazy(() => import("@/areas/publishing/Publishing").then(m => ({ default: m.Publishing })));
const Posts = lazy(() => import("@/areas/socialfeed/Posts").then(m => ({ default: m.Posts })));
const Seo = lazy(() => import("@/pages/runs/Seo").then(m => ({ default: m.Seo })));
const Serp = lazy(() => import("@/areas/growth/pages/Serp").then(m => ({ default: m.Serp })));
const Aso = lazy(() => import("@/areas/growth/pages/Aso").then(m => ({ default: m.Aso })));
const WebAnalytics = lazy(() => import("@/areas/webanalytics/WebAnalytics").then(m => ({ default: m.WebAnalytics })));
const Growth = lazy(() => import("@/areas/growth/pages/Growth").then(m => ({ default: m.Growth })));
const MobileHealth = lazy(() => import("@/areas/mobilehealth/MobileHealth").then(m => ({ default: m.MobileHealth })));
const PAGES = { email: Mailbox, triage: Triage, outbox: Outbox, nurture: Nurture, studio: Studio, autopilot: Autopilot, video: Video, motion: Motion, publishing: Publishing, posts: Posts, seo: Seo, serp: Serp, aso: Aso, mobilehealth: MobileHealth, webanalytics: WebAnalytics, overview: Growth };
const SECTIONS = {
  mail: { pages: MAIL_PAGES, label: "Mail" },
  social: { pages: SOCIAL_PAGES, label: "Social media" },
  growth: { pages: GROWTH_PAGES, label: "SEO & growth" },
};

function SectionPages({ section, selectedPage }: { section: keyof typeof SECTIONS; selectedPage?: string }) {
  const { page: routePage } = useParams();
  const page = selectedPage ?? routePage;
  const location = useLocation();
  const { pages: items, label } = SECTIONS[section];
  const current = items.find(item => item.slug === page);
  if (!page) return <Navigate to={`${items[0]!.to}${location.search}${location.hash}`} state={location.state} replace />;
  const Page = current ? PAGES[current.slug as keyof typeof PAGES] : null;
  return <>
    {/* THE SEO & GROWTH PAGES STAND ALONE. Their six tabs were the same six
        rows the sidebar already lists under "SEO & growth", drawn a second
        time an inch to the right; each page gets the plain top bar every
        other page has instead. Mail and Social keep the strip. */}
    {section === "growth" ? (
      <TopBar label={current?.label ?? label} />
    ) : (
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 px-4.5 py-1">
        <span className="mr-2 text-xs text-muted-foreground">{label}</span>
        <nav aria-label={label}>
          <SubTabs
            tabs={items.map(item => ({ key: item.slug, to: item.to, label: item.label }))}
            activeKey={current?.slug ?? null}
            className="mb-0"
          />
        </nav>
      </header>
    )}
    {Page ? <Page /> : <div className="p-6"><h1 className="text-xl">Page not found</h1><Link to={items[0]!.to} className="underline">Go to {label.toLowerCase()}</Link></div>}
  </>;
}

export function MailSection() { return <SectionPages section="mail" />; }
export function SocialSection({ page }: { page?: string }) { return <SectionPages section="social" selectedPage={page} />; }
export function GrowthSection() { return <SectionPages section="growth" />; }
