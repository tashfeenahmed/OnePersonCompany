import { Link, Navigate, useParams } from "react-router-dom";
import { BarChart3, KanbanSquare, Mail, Sparkles } from "lucide-react";
import { TabStrip } from "@/components/TabStrip";
import { useStore } from "@/lib/store";
import { Board } from "@/pages/Board";
import { EmailStats } from "@/pages/EmailStats";
import { Mailbox } from "@/pages/Mailbox";
import { Studio } from "@/pages/Studio";

/**
 * APPS — one page, a tab per app, each app at its own address.
 *
 * THE SAME SHAPE AS DASHBOARDS, ON PURPOSE. A dashboard is a grid you glance
 * at; an app is a place you go to DO something across every venture at once.
 * They are different kinds of page, but they are navigated the same way — a
 * strip of tabs across the top, the URL as the selection — so the eye learns
 * one pattern rather than two. `/apps` lands on the first app and rewrites
 * itself to that app's own URL, exactly as `/dashboards` does, and an app name
 * that matches nothing says so rather than quietly showing a different one.
 *
 * THE LIST IS CODE, NOT STATE. Dashboards are made by the owner and live in the
 * store; apps are built here and shipped, so the registry below is the whole
 * truth about which exist. Adding one is an entry in this list and a page
 * component — nothing to migrate.
 */
const APPS: { slug: string; name: string; icon: typeof Mail; page: () => React.JSX.Element }[] = [
  /*
    The board is first because it is the only app here that is a place to PUT
    something. Email and Email stats are windows onto mail that arrived whether
    anybody opened them or not; the board holds work that exists nowhere else
    until somebody types it in, so it is the one worth landing on — the bare
    /apps rewrites itself to the first app in this list.
  */
  { slug: "board", name: "Board", icon: KanbanSquare, page: Board },
  /*
    "Email" is the mailbox — the threads and the reader, every venture's mail
    in one list, filtered by the domain it arrived at. "Email stats" beside it
    is the instrument panel for the same mail: counts, queues, bounce rates.
    Two apps rather than two tabs inside one, because they are used at
    different moments — one to answer mail, the other to see whether mail is
    being answered.
  */
  { slug: "email", name: "Email", icon: Mail, page: Mailbox },
  { slug: "email-stats", name: "Email stats", icon: BarChart3, page: EmailStats },
  /*
    The studio is last and is the only app here that MAKES something rather
    than showing something that already exists — a caption and a picture for
    one venture, out of what the box already knows about it. It is an app and
    not a venture tab because the venture is an input to it rather than its
    address: the same page, the same two fields, whichever business is picked.
  */
  { slug: "studio", name: "Studio", icon: Sparkles, page: Studio },
];

export function Apps() {
  const { app } = useParams();
  const { state, setAppOrder } = useStore();

  /*
    THE OWNER'S ORDER OVER THE REGISTRY'S. `appOrder` is a list of slugs the
    owner dragged into place; anything the registry has that the list does not
    (a new app shipped since) is appended in registry order, and a slug the
    list has that the registry does not (an app removed) is simply not drawn.
    Neither case needs a migration, which is the point of resolving it here.
  */
  const known = state.appOrder ?? [];
  const rank = (a: (typeof APPS)[number]) => {
    const i = known.indexOf(a.slug);
    return i >= 0 ? i : known.length + APPS.indexOf(a);
  };
  const ordered = [...APPS].sort((a, b) => rank(a) - rank(b));
  const first = ordered[0]!;

  if (!app) return <Navigate to={`/apps/${first.slug}`} replace />;

  const current = APPS.find((a) => a.slug === app);

  return (
    <>
      {/* The strip: links, not buttons, because each tab IS the app's address
          and can be middle-clicked or copied out of the bar. */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-4.5">
        <TabStrip
          tabs={ordered.map((a) => ({
            key: a.slug,
            to: `/apps/${a.slug}`,
            label: a.name,
            icon: a.icon,
          }))}
          activeKey={current?.slug ?? null}
          onReorder={setAppOrder}
        />
      </header>

      {current ? (
        <current.page />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="max-w-[380px] text-center">
            <h1 className="text-[19px] font-normal tracking-[-0.02em]">
              No app at this address
            </h1>
            <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">
              Nothing here is called “{app}”.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-1.5">
              {APPS.map((a) => (
                <Link
                  key={a.slug}
                  to={`/apps/${a.slug}`}
                  className="hover:bg-accent rounded-lg border px-2.5 py-1.5 text-[12.5px]"
                >
                  {a.name}
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
