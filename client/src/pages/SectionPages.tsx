import { lazy } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { TopBar } from "@/components/PageShell";
import { MAIL_PAGES, SOCIAL_PAGES } from "@/data/navigation";

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
const PAGES = { email: Mailbox, triage: Triage, outbox: Outbox, nurture: Nurture, studio: Studio, autopilot: Autopilot, video: Video, motion: Motion, publishing: Publishing, posts: Posts };
const SECTIONS = {
  mail: { pages: MAIL_PAGES, label: "Mail" },
  social: { pages: SOCIAL_PAGES, label: "Social media" },
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
    {/* EVERY SECTION PAGE STANDS ALONE. The strip of tabs that used to sit
        here was the same rows the sidebar already lists under the section's
        heading, drawn a second time an inch to the right; each page gets the
        plain top bar every other page has instead, and the sidebar is the
        one way between them. */}
    <TopBar label={current?.label ?? label} />
    {Page ? <Page /> : <div className="p-6"><h1 className="text-xl">Page not found</h1><Link to={items[0]!.to} className="underline">Go to {label.toLowerCase()}</Link></div>}
  </>;
}

export function MailSection() { return <SectionPages section="mail" />; }
export function SocialSection({ page }: { page?: string }) { return <SectionPages section="social" selectedPage={page} />; }
