import { lazy } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { TopBar } from "@/components/PageShell";
import { SOCIAL_PAGES } from "@/data/navigation";

const Video = lazy(() => import("@/areas/video/Video").then(m => ({ default: m.Video })));
const Posts = lazy(() => import("@/areas/socialfeed/Posts").then(m => ({ default: m.Posts })));

/**
 * WHAT EACH SECTION DRAWS — its rail rows, and the pages its addresses
 * resolve to. The two used to be the same list, which is why the pages a
 * section renders were the pages the sidebar offered. They have come apart:
 * SOCIAL_PAGES is one row now (the Studio, routed on its own in App.tsx
 * because it is the one page that wants no top bar), while /social still has
 * two addresses that render — a video run, opened from the Studio's rail, and
 * the Posts timeline on its way into Publishing as a tab. Autopilot,
 * Publishing and Motion are drawn inside the Studio and their slugs never
 * reach this map at all.
 *
 * MAIL LEFT THE SAME WAY THE STUDIO DID. Its four addresses were four pages
 * under this strip; they are six tabs of one header now, routed at /mail/*
 * by pages/Email.tsx. One section is left, and this file stays generic
 * because the shape it holds — a section of addresses drawn under a strip
 * that names them — is the shape any next section arrives in.
 *
 * `labels` names the pages that are no longer rows, because the strip above
 * the page still has to say what you are looking at.
 */
const SECTIONS = {
  social: {
    pages: SOCIAL_PAGES,
    label: "Social media",
    routes: { video: Video, posts: Posts },
    labels: { video: "Video", posts: "Posts" } as Record<string, string>,
  },
};

function SectionPages({ section, selectedPage }: { section: keyof typeof SECTIONS; selectedPage?: string }) {
  const { page: routePage } = useParams();
  const page = selectedPage ?? routePage;
  const location = useLocation();
  const { pages: items, label, routes, labels } = SECTIONS[section];
  if (!page) return <Navigate to={`${items[0]!.to}${location.search}${location.hash}`} state={location.state} replace />;
  const Page = (routes as Record<string, typeof Video | undefined>)[page] ?? null;
  const title = items.find(item => item.slug === page)?.label ?? labels[page] ?? label;
  return <>
    {/* EVERY SECTION PAGE STANDS ALONE. The strip of tabs that used to sit
        here was the same rows the sidebar already lists under the section's
        heading, drawn a second time an inch to the right; each page gets the
        plain top bar every other page has instead, and the sidebar is the
        one way between them. */}
    <TopBar label={title} />
    {Page ? <Page /> : <div className="p-6"><h1 className="text-xl">Page not found</h1><Link to={items[0]!.to} className="underline">Go to {label.toLowerCase()}</Link></div>}
  </>;
}

export function SocialSection({ page }: { page?: string }) { return <SectionPages section="social" selectedPage={page} />; }
