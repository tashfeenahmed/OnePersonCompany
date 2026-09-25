import { useEffect, useState, type MouseEvent } from "react";
import { Loader2, Play, X } from "lucide-react";
import { Link, Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import { TopBar } from "@/components/PageShell";
import { VentureMark } from "@/components/VentureChrome";
import { useApi } from "@/hooks/useApi";
import { WORK_CHANGED } from "@/hooks/useRunQueue";
import { useStore } from "@/lib/store";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { runsApi, type Coverage } from "@/lib/api/runs";
import { peopleApi, type WatchPerson } from "@/lib/api/people";
import { PersonAvatar } from "@/components/org/PersonAvatar";
import { UNFILED } from "@/components/org/Watchlist";
import { attaches } from "@/components/org/dossiers";
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
          {current.slug === "dossier" ? <PeopleRail /> : <VentureRail output={current} />}
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

  const pick = usePick(output.slug);
  const runPicked = async () => {
    /* The kind's own defaults, as the brief form would send them — an
       untouched form is what a bulk run is. */
    const doc = await runsApi.list({ kind: output.kind, limit: 1 });
    const info = doc.kinds.find((k) => k.kind === output.kind);
    const input: Record<string, string> = {};
    for (const f of info?.inputs ?? []) if (f.default) input[f.key] = f.default;
    const failed: string[] = [];
    for (const slug of pick.keys) {
      const v = state.ventures.find((x) => x.slug === slug);
      if (!v) continue;
      try {
        await runsApi.start({ kind: output.kind, ventureId: v.id, input });
      } catch (err) {
        failed.push(`${v.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return failed;
  };

  const row = (key: string, active: boolean, body: React.ReactNode, count: number | null, title?: string, dim = false) => (
    <Link
      key={key}
      to={to(key === ALL ? null : key)}
      aria-current={active ? "page" : undefined}
      title={title}
      onMouseDown={pick.noTextSelect}
      onClick={(e) => (key === ALL || key === NONE ? pick.clear() : pick.click(e, key))}
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors select-none",
        pick.has(key) ? pickedRow : active ? "bg-accent text-foreground font-medium" : "hover:bg-accent hover:text-foreground",
        !active && !pick.has(key) && (dim ? "text-muted-foreground/60" : "text-muted-foreground"),
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
      className="border-line-soft hidden w-[220px] shrink-0 flex-col border-r md:flex"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <div
        className="text-muted-foreground px-2 pb-1.5 text-[11.5px] font-medium tracking-[0.08em] uppercase"
        title="Shift-click to pick several, then run them all"
      >
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
      </div>
      <RunPicked pick={pick} run={runPicked} />
    </nav>
  );
}

/* ------------------------------------------------------- picking several */

const pickedRow = "bg-foreground/[0.07] text-foreground ring-1 ring-inset ring-foreground/15";

type Pick = ReturnType<typeof usePick>;

/**
 * SHIFT-CLICK PICKS, A PLAIN CLICK NAVIGATES. ⌘/Ctrl-click picks too, so the
 * gesture from Finder works; a plain click on anything clears the pick, since
 * wandering off to read a report is putting the batch down. The pick is
 * per page — moving to another output starts empty.
 */
function usePick(scope: string) {
  const [keys, setKeys] = useState<string[]>([]);
  const [keysFor, setKeysFor] = useState(scope);
  if (keysFor !== scope) {
    setKeysFor(scope);
    setKeys([]);
  }
  return {
    keys,
    has: (key: string) => keys.includes(key),
    clear: () => setKeys([]),
    click: (e: MouseEvent, key: string) => {
      if (!(e.shiftKey || e.metaKey || e.ctrlKey)) {
        setKeys([]);
        return;
      }
      e.preventDefault();
      setKeys((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));
    },
    /* Shift-mousedown would otherwise select the text between two rows. */
    noTextSelect: (e: MouseEvent) => {
      if (e.shiftKey) e.preventDefault();
    },
  };
}

/** The one button a pick grows: run every picked row with the kind's
 *  defaults. They join the box's queue like any other run. */
function RunPicked({ pick, run }: { pick: Pick; run: () => Promise<string[]> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const n = pick.keys.length;
  if (n === 0 && failed.length === 0) return null;

  const go = async () => {
    setBusy(true);
    try {
      const bad = await run();
      setFailed(bad);
      pick.clear();
    } catch (err) {
      setFailed([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event(WORK_CHANGED));
    }
  };

  return (
    <div className="border-line-soft shrink-0 border-t p-2">
      {n > 0 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void go()}
            className="bg-foreground text-background flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium disabled:opacity-60"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <Play className="size-3.5" strokeWidth={1.8} />
            )}
            {busy ? "Queueing…" : `Run ${n}`}
          </button>
          <button
            type="button"
            aria-label="Clear the pick"
            onClick={pick.clear}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 items-center justify-center rounded-lg"
          >
            <X className="size-4" strokeWidth={1.7} />
          </button>
        </div>
      )}
      {failed.length > 0 && (
        <p className="text-destructive px-1 pt-1.5 text-[12px] leading-relaxed">
          {failed.join(" ")}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------ the people rail */

/**
 * THE PEOPLE PAGE'S RAIL LISTS PEOPLE. A dossier is about a person and is
 * filed under no venture, so a venture rail beside it was a column of two
 * dozen businesses with nothing in them. This is the watchlist instead —
 * the names the owner typed on Team → People — with the dossier count the
 * server keeps for each, and the unfiled pile at the foot. `?person=<id>`
 * narrows the runs beside it (see runs/Dossiers.tsx).
 */
function PeopleRail() {
  const [params] = useSearchParams();
  const { runId } = useParams();
  const selected = params.get("person");

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(WORK_CHANGED, bump);
    return () => window.removeEventListener(WORK_CHANGED, bump);
  }, []);
  const watch = useApi(() => peopleApi.watch(), [tick, runId]);
  /* The unfiled count needs the ledger; 200 is the shelf's own window. */
  const ledger = useApi(() => runsApi.list({ kind: "dossier", limit: 200 }), [tick, runId]);

  const people: WatchPerson[] = [...(watch.data?.people ?? [])].sort((a, b) => {
    const at = (p: WatchPerson) => p.dossiers.last?.finishedAt ?? p.dossiers.last?.queuedAt ?? "";
    return at(b).localeCompare(at(a)) || a.name.localeCompare(b.name);
  });
  const seen = people.filter((p) => p.dossiers.count > 0 || p.dossiers.running || p.dossiers.queued > 0);
  const unseen = people.filter((p) => !seen.includes(p));
  const total = ledger.data?.runs.length ?? null;
  const unfiled = (ledger.data?.runs ?? []).filter((r) => !people.some((p) => attaches(r.title, p.name))).length;

  const pick = usePick("dossier");
  const runPicked = async () => {
    const failed: string[] = [];
    for (const id of pick.keys) {
      const p = people.find((x) => x.id === id);
      if (!p) continue;
      try {
        await peopleApi.dossierFor(p.id);
      } catch (err) {
        failed.push(`${p.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return failed;
  };

  const base = appPage("dossier");
  const row = (key: string | null, body: React.ReactNode, count: number | null, opts: { title?: string; dim?: boolean; pickable?: boolean } = {}) => {
    const active = selected === key;
    const picked = key !== null && pick.has(key);
    return (
      <Link
        key={key ?? "all"}
        to={key ? `${base}?person=${encodeURIComponent(key)}` : base}
        aria-current={active ? "page" : undefined}
        title={opts.title}
        onMouseDown={pick.noTextSelect}
        onClick={(e) => (opts.pickable && key ? pick.click(e, key) : pick.clear())}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors select-none",
          picked ? pickedRow : active ? "bg-accent text-foreground font-medium" : "hover:bg-accent hover:text-foreground",
          !active && !picked && (opts.dim ? "text-muted-foreground/60" : "text-muted-foreground"),
        )}
      >
        {body}
        {count !== null && count > 0 && (
          <span className="ml-auto shrink-0 text-[12px] tabular-nums opacity-80">{count}</span>
        )}
      </Link>
    );
  };

  const personRow = (p: WatchPerson, dim: boolean) =>
    row(
      p.id,
      <>
        <PersonAvatar person={p} size={16} />
        <span className="truncate">{p.name}</span>
        {(p.dossiers.running || p.dossiers.queued > 0) && (
          <span className="bg-ok size-1.5 shrink-0 animate-pulse rounded-full" />
        )}
      </>,
      p.dossiers.count,
      {
        title: p.dossiers.last
          ? `${p.dossiers.count} ${p.dossiers.count === 1 ? "dossier" : "dossiers"} · last ${ago(p.dossiers.last.finishedAt ?? p.dossiers.last.queuedAt)}`
          : `No dossier on ${p.name} yet`,
        dim,
        pickable: true,
      },
    );

  return (
    <nav aria-label="Dossiers by person" className="border-line-soft hidden w-[220px] shrink-0 flex-col border-r md:flex">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <div
          className="text-muted-foreground px-2 pb-1.5 text-[11.5px] font-medium tracking-[0.08em] uppercase"
          title="Shift-click to pick several, then run them all"
        >
          People
        </div>
        {row(null, <span className="truncate">Everyone</span>, total)}
        {unfiled > 0 &&
          row(UNFILED, <span className="truncate">Unfiled</span>, unfiled, {
            title: "Dossiers naming nobody on the watchlist",
          })}

        {seen.length > 0 && <div className="border-line-soft my-1.5 border-t" />}
        {seen.map((p) => personRow(p, false))}

        {unseen.length > 0 && (
          <>
            <div className="border-line-soft my-1.5 border-t" />
            <div className="text-muted-foreground/70 px-2 py-1 text-[11.5px]">
              {unseen.length} without a dossier
            </div>
            {unseen.map((p) => personRow(p, true))}
          </>
        )}

        {watch.data && people.length === 0 && (
          <p className="text-muted-foreground px-2 py-2 text-[12.5px] leading-relaxed">
            Nobody on the watchlist.{" "}
            <Link to="/team/people" className="underline">
              Add people
            </Link>{" "}
            to see them here.
          </p>
        )}
        {watch.loading && !watch.data && (
          <p className="text-muted-foreground px-2 py-2 text-[12.5px]">Reading the list…</p>
        )}
        {(watch.error || ledger.error) && (
          <p className="text-destructive px-2 pt-2 text-[12px] leading-relaxed">{watch.error ?? ledger.error}</p>
        )}
      </div>
      <RunPicked pick={pick} run={runPicked} />
    </nav>
  );
}
