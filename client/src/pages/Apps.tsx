import { Link, Navigate, useParams } from "react-router-dom";
import { BarChart3, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmailStats } from "@/pages/EmailStats";
import { Mailbox } from "@/pages/Mailbox";

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
    "Email" is the mailbox — the threads and the reader, every venture's mail
    in one list, filtered by the domain it arrived at. "Email stats" beside it
    is the instrument panel for the same mail: counts, queues, bounce rates.
    Two apps rather than two tabs inside one, because they are used at
    different moments — one to answer mail, the other to see whether mail is
    being answered.
  */
  { slug: "email", name: "Email", icon: Mail, page: Mailbox },
  { slug: "email-stats", name: "Email stats", icon: BarChart3, page: EmailStats },
];

export function Apps() {
  const { app } = useParams();
  const first = APPS[0]!;

  if (!app) return <Navigate to={`/apps/${first.slug}`} replace />;

  const current = APPS.find((a) => a.slug === app);

  return (
    <>
      {/* The strip: links, not buttons, because each tab IS the app's address
          and can be middle-clicked or copied out of the bar. */}
      <header className="flex h-12 shrink-0 items-center gap-2 px-4.5">
        <div className="flex items-center gap-0.5 overflow-x-auto">
          {APPS.map((a) => {
            const active = a.slug === current?.slug;
            return (
              <Link
                key={a.slug}
                to={`/apps/${a.slug}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-[7px] rounded-lg px-2.5 py-1.5 text-[12.5px] whitespace-nowrap",
                  active && "bg-accent text-foreground font-medium",
                )}
              >
                <a.icon className="size-3.5" strokeWidth={1.6} />
                {a.name}
              </Link>
            );
          })}
        </div>
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
