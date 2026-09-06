import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { Bot, FileText, MessageSquareText, Swords, Telescope, type LucideIcon } from "lucide-react";
import { TabStrip } from "@/components/TabStrip";
import { useStore } from "@/lib/store";
import { MOVED_APPS, appPage } from "../../../shared/navigation";
import { Competitors } from "@/pages/runs/Competitors";
import { Demand } from "@/pages/runs/Demand";
import { Papers } from "@/pages/runs/Papers";
import { Research } from "@/pages/runs/Research";
import { Visibility } from "@/pages/runs/Visibility";

// Report tools grouped by the sub-agent that produces the work.
const OUTPUTS: { slug: string; name: string; icon: LucideIcon; page: () => React.JSX.Element }[] = [
  { slug: "research", name: "Research", icon: Telescope, page: Research },
  { slug: "competitors", name: "Competitors", icon: Swords, page: Competitors },
  { slug: "demand", name: "Demand", icon: MessageSquareText, page: Demand },
  { slug: "visibility", name: "AI visibility", icon: Bot, page: Visibility },
  { slug: "papers", name: "Papers", icon: FileText, page: Papers },
];

export function SubagentOutputs() {
  const { output: app, runId } = useParams();
  const location = useLocation();
  const { state, setAppOrder } = useStore();

  /*
    THE OWNER'S ORDER OVER THE REGISTRY'S. `appOrder` is a list of slugs the
    owner dragged into place; anything the registry has that the list does not
    (a new app shipped since) is appended in registry order, and a slug the
    list has that the registry does not (an app removed) is simply not drawn.
    Neither case needs a migration, which is the point of resolving it here.
  */
  const known = state.appOrder ?? [];
  const rank = (a: (typeof OUTPUTS)[number]) => {
    const i = known.indexOf(a.slug);
    return i >= 0 ? i : known.length + OUTPUTS.indexOf(a);
  };
  const ordered = [...OUTPUTS].sort((a, b) => rank(a) - rank(b));
  const first = ordered[0]!;

  if (app && Object.hasOwn(MOVED_APPS, app)) return <Navigate to={`${appPage(app, runId)}${location.search}${location.hash}`} state={location.state} replace />;

  if (!app) return <Navigate to={`${appPage(first.slug)}${location.search}${location.hash}`} state={location.state} replace />;

  const current = OUTPUTS.find((a) => a.slug === app);

  return (
    <>
      {/* The strip: links, not buttons, because each tab IS the app's address
          and can be middle-clicked or copied out of the bar. */}
      <header className="shrink-0 border-b px-4.5 py-2">
        <p className="px-1 pb-1.5 text-xs text-muted-foreground">Sub-agent outputs</p>
        <TabStrip
          tabs={ordered.map((a) => ({
            key: a.slug,
            to: appPage(a.slug),
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
              No output at this address
            </h1>
            <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">
              Nothing here is called “{app}”.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-1.5">
              {OUTPUTS.map((a) => (
                <Link
                  key={a.slug}
                  to={appPage(a.slug)}
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
