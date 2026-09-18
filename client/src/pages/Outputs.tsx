import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import { TopBar } from "@/components/PageShell";
import { VentureMark } from "@/components/VentureChrome";
import { useApi } from "@/hooks/useApi";
import { WORK_CHANGED } from "@/hooks/useRunQueue";
import { useStore } from "@/lib/store";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { runsApi, type Coverage } from "@/lib/api/runs";
import { OUTPUTS, orderedOutputs, outputBySlug, type OutputDef } from "@/data/outputs";
import { MOVED_APPS, appPage } from "../../../shared/navigation";
import { Competitors } from "@/pages/runs/Competitors";
import { Demand } from "@/pages/runs/Demand";
import { Dossiers } from "@/pages/runs/Dossiers";
import { Papers } from "@/pages/runs/Papers";
import { Research } from "@/pages/runs/Research";
import { Visibility } from "@/pages/runs/Visibility";
import { Seo } from "@/pages/runs/Seo";
import { Serp } from "@/areas/growth/pages/Serp";
import { Aso } from "@/areas/growth/pages/Aso";

/**
 * THE OUTPUTS: nine report pages, each the work of one kind of sub-agent,
 * each a page of its own with the ventures down its left side.
 *
 * ---------------------------------------------------------------------------
 * THIS WAS A TAB STRIP UNDER THE SUB-AGENTS PAGE, and reaching a research
 * report was sidebar → Sub-agents → Outputs → Research → change the dropdown.
 * Four steps, behind a word nobody reaching for a report would look for. The
 * pages are their own now: the sidebar's Outputs row unfolds into them (see
 * components/SidebarOutputs.tsx), and each one is /outputs/<slug> as it
 * always was, so every link ever made to a report still lands.
 *
 * THE VENTURE RAIL IS THE FILTER, and it is a list of who has been looked at.
 * "All ventures" first, then every venture that has a run of this kind with
 * its count and how long ago, then — dimmed, at the foot — the ones that
 * have none. The dim rows are not decoration: a portfolio of twenty-four
 * where nineteen have never had a competitor sweep is a fact the rail should
 * show, and it is the nightly rounds' to-do list. The selection is the URL
 * (`?venture=<slug>`), so a filtered list is an address and the back button
 * walks it.
 *
 * THE COUNTS COME FROM THE WHOLE LEDGER, through /api/runs/coverage, and not
 * from the forty-row page the report page reads. A rail built from that page
 * would say a venture had nothing when its reports were simply older than
 * the page, which is a lie in the one place that is meant to show coverage.
 */
const PAGES: Record<string, () => React.JSX.Element> = {
  research: Research,
  competitors: Competitors,
  demand: Demand,
  visibility: Visibility,
  papers: Papers,
  dossier: Dossiers,
  seo: Seo,
  serp: Serp,
  aso: Aso,
};

export function OutputsPage() {
  const { output: app, runId } = useParams();
  const location = useLocation();
  const { state } = useStore();

  const first = orderedOutputs(state.appOrder)[0]!;

  if (app && Object.hasOwn(MOVED_APPS, app)) return <Navigate to={`${appPage(app, runId)}${location.search}${location.hash}`} state={location.state} replace />;
  if (!app) return <Navigate to={`${appPage(first.slug)}${location.search}${location.hash}`} state={location.state} replace />;

  const current = outputBySlug(app);
  const Page = current ? PAGES[current.slug] : undefined;

  return (
    <>
      <TopBar label={current ? `Outputs · ${current.name}` : "Outputs"} />
      {current && Page ? (
        <div className="flex min-h-0 flex-1">
          <VentureRail output={current} />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Page />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <div className="max-w-[380px] text-center">
            <h1 className="text-[20px] font-normal tracking-[-0.02em]">
              No output at this address
            </h1>
            <p className="text-muted-foreground mt-1.5 text-[14px] leading-relaxed">
              Nothing here is called “{app}”.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-1.5">
              {OUTPUTS.map((a) => (
                <Link
                  key={a.slug}
                  to={appPage(a.slug)}
                  className="hover:bg-accent rounded-lg border px-2.5 py-1.5 text-[13.5px]"
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

/* ------------------------------------------------------------ the rail */

/** The `?venture=` value that means "no filter". Absent means the same. */
export const ALL = "all";
/** The `?venture=` value for runs filed under no venture — a paper on a
 *  typed topic, a dossier. Only offered on kinds that allow it. */
export const NONE = "none";

function VentureRail({ output }: { output: OutputDef }) {
  const { state } = useStore();
  const [params] = useSearchParams();
  const { runId } = useParams();
  const selected = params.get("venture") ?? ALL;

  /* RE-READ WHEN WORK CHANGES, and when the open run changes: a run started
     from the page beside this rail should appear in its count without a
     reload, and WORK_CHANGED is what the queue hook fires when one does. The
     rail is otherwise static — nine numbers do not need a poll. */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(WORK_CHANGED, bump);
    return () => window.removeEventListener(WORK_CHANGED, bump);
  }, []);
  const coverage = useApi(() => runsApi.coverage(output.kind), [output.kind, tick, runId]);
  const cov: Coverage | null = coverage.data;

  const byVenture = new Map((cov?.ventures ?? []).map((b) => [b.ventureId, b]));
  const total = (cov?.ventures ?? []).reduce((n, b) => n + b.count, 0) + (cov?.none?.count ?? 0);
  /* Looked-at first, newest first — the order the server sent — then the rest
     by name. Both halves are drawn; only the second is dim. */
  const seen = (cov?.ventures ?? [])
    .map((b) => state.ventures.find((v) => v.id === b.ventureId))
    .filter((v): v is NonNullable<typeof v> => !!v);
  const unseen = state.ventures
    .filter((v) => !byVenture.has(v.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const to = (venture: string | null) =>
    venture ? `${appPage(output.slug)}?venture=${encodeURIComponent(venture)}` : appPage(output.slug);

  const row = (key: string, active: boolean, body: React.ReactNode, count: number | null, title?: string, dim = false) => (
    <Link
      key={key}
      to={to(key === ALL ? null : key)}
      aria-current={active ? "page" : undefined}
      title={title}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors",
        active ? "bg-accent text-foreground font-medium" : "hover:bg-accent hover:text-foreground",
        !active && (dim ? "text-muted-foreground/60" : "text-muted-foreground"),
      )}
    >
      {body}
      {count !== null && count > 0 && (
        <span className="ml-auto shrink-0 text-[12px] tabular-nums opacity-80">{count}</span>
      )}
    </Link>
  );

  return (
    <nav
      aria-label={`${output.name} by venture`}
      className="border-line-soft hidden w-[220px] shrink-0 flex-col overflow-y-auto border-r px-2 py-3 md:flex"
    >
      <div className="text-muted-foreground px-2 pb-1.5 text-[11.5px] font-medium tracking-[0.08em] uppercase">
        Ventures
      </div>
      {row(ALL, selected === ALL, <span className="truncate">All ventures</span>, cov ? total : null)}
      {cov && !cov.needsVenture && (cov.none?.count ?? 0) > 0 &&
        row(NONE, selected === NONE, <span className="truncate">No venture</span>, cov.none!.count,
          cov.none!.lastAt ? `Last run ${ago(cov.none!.lastAt)}` : undefined)}

      {seen.length > 0 && <div className="border-line-soft my-1.5 border-t" />}
      {seen.map((v) => {
        const b = byVenture.get(v.id)!;
        return row(
          v.slug,
          selected === v.slug || selected === v.id,
          <>
            <VentureMark venture={v} size={14} />
            <span className="truncate">{v.name}</span>
            {(b.running > 0 || b.queued > 0) && <span className="bg-ok size-1.5 shrink-0 animate-pulse rounded-full" />}
          </>,
          b.count,
          b.lastAt ? `${b.count} ${b.count === 1 ? "run" : "runs"} · last ${ago(b.lastAt)}` : undefined,
        );
      })}

      {unseen.length > 0 && (
        <>
          <div className="border-line-soft my-1.5 border-t" />
          <div className="text-muted-foreground/70 px-2 py-1 text-[11.5px]">
            {coverage.loading && !cov ? "Counting…" : `${unseen.length} not yet looked at`}
          </div>
          {unseen.map((v) =>
            row(
              v.slug,
              selected === v.slug || selected === v.id,
              <>
                <VentureMark venture={v} size={14} />
                <span className="truncate">{v.name}</span>
              </>,
              null,
              `No ${output.name.toLowerCase()} runs for ${v.name} yet`,
              true,
            ),
          )}
        </>
      )}

      {coverage.error && (
        <p className="text-destructive px-2 pt-2 text-[12px] leading-relaxed">{coverage.error}</p>
      )}
    </nav>
  );
}
