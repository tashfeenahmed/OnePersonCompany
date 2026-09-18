import { appPage } from "../../../../shared/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, Loader2, Play, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VentureSelect } from "@/components/VentureSelect";
import { ShapePicker } from "@/components/studio/ShapePicker";
import { ASPECT_OPTIONS } from "@/data/mediaShapes";
import { RunReport } from "@/components/runs/RunReport";
import {
  backendPhrase,
  ordinal,
  statusTone,
  statusWord,
} from "@/components/runs/format";
import { useApi } from "@/hooks/useApi";
import { useStore, type Venture } from "@/lib/store";
import { ago, duration } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  isLive,
  runsApi,
  type KindInfo,
  type RunSummary,
} from "@/lib/api/runs";

/**
 * THE SHAPE EVERY RUN APP HAS, WRITTEN ONCE.
 *
 * Nine apps — Research, Competitors, SEO, Demand, AI visibility, SERP, ASO,
 * Papers, People — are the same page with a different `kind` string: the
 * runs, one open below them, and a brief to start another. The pages in
 * `pages/runs/` are four lines each because the DIFFERENCES between the
 * kinds live on the server: `GET /api/runs` sends a `KindInfo` per kind with
 * its name, its sentence, whether a venture is required and which inputs to
 * draw, and this builds itself out of that. A tenth kind is a server change
 * and a routing entry; nothing in here has to learn about it.
 *
 * WHAT EACH APP ADDS IS AN `extras` SLOT AND NOT A FORK. Competitors has a
 * profiles table, Papers a library and a shelf, AI visibility a grid of
 * answers — three accumulations that are ABOUT the runs without being runs.
 * They are passed in rather than branched on here, so this file never grows a
 * `if (kind === "papers")`.
 *
 * ---------------------------------------------------------------------------
 *
 * THE RUNS ARE AT THE TOP AND THE REPORT IS UNDER THEM, since 2026-09-18.
 * It was the other way round — brief, then the open report, then the history
 * — and opening a run pushed the list off the bottom of the screen, so
 * reading three reports in a row meant scrolling back up past each one to
 * find the next. The list is the thing you navigate by; it stays where it is.
 * The report grows downward under it, which is where a document you chose
 * from a list belongs.
 *
 * THE BRIEF FOLDS. It is the form for starting a run, and on a page whose
 * job is mostly reading, a form on top of every visit is furniture. It is
 * open when there is nothing to read — no runs for this venture, no report
 * open — and one press away otherwise. Nothing typed into it is lost by
 * folding it.
 *
 * WHICH VENTURE IS THE ADDRESS. The Outputs page's rail writes `?venture=`
 * and this reads it: a slug or an id filters the list to that venture and
 * pre-fills the brief with it; `all` or nothing is every venture; `none` is
 * the runs filed under no venture, which only a kind that allows that ever
 * has. The old "this venture / every venture" toggle is gone — the rail is
 * that toggle, and a filtered list is a URL somebody can send.
 *
 * IT POLLS, AND THE ALTERNATIVE WAS WORSE. A run is minutes of work that
 * survives the tab closing; a page holding an EventSource would tie the work's
 * visibility to one browser connection, and a refresh mid-research would leave
 * a report being written on a server nobody was watching. So the server owns
 * the run and this asks — every 1.5 seconds while anything is moving, and not
 * at all when nothing is. The report is flushed to the row as it grows, which
 * is what makes polling look like streaming.
 *
 * THE RUN IS ADDRESSED, at `/outputs/<app>/<run id>`. A report somebody wants
 * a second opinion on is a link, and the back button walks the history list
 * the way it walks anything else. Starting a run navigates to its address, so
 * the URL is right from the first second rather than only after it finished.
 *
 * ONE AT A TIME, AND THE PAGE SAYS SO RATHER THAN HIDING IT. There is one
 * queue on this box and it drains in series — a research run and a paper
 * queued together do not overlap. A page that showed a spinner without saying
 * "something else is working" would read as a hang, so a queued run says what
 * is ahead of it and how far down it is.
 */
export function RunApp({
  kind,
  slug,
  name,
  extras,
}: {
  /** The server's own discriminator: `research`, `competitors`, … */
  kind: string;
  /** This app's URL segment, for the run addresses this page hands out. */
  slug: string;
  /** The tab's own name, used as the heading until the server's `KindInfo`
   *  lands — and as the heading FOREVER if it never does. A page whose title
   *  is an ellipsis while the API is down tells somebody they are lost when
   *  they are only offline. The server's name wins the moment it arrives, so
   *  this is a fallback rather than a second source of truth. */
  name: string;
  /** Whatever this app has that is not a run — drawn under the open report,
   *  which is where an accumulation belongs: under the thing that produced
   *  it. */
  extras?: (ctx: {
    venture: Venture | null;
    input: Record<string, string>;
    /** The id of the open run once it has STOPPED moving, or "" while none
     *  has. An accumulation keys its fetch on this, so it refetches itself the
     *  moment a run finishes and never on the ticks while one is writing. A
     *  derived string rather than a counter, because a counter would have to
     *  be bumped from an effect and effects that set state are how a page ends
     *  up rendering itself twice per poll. */
    settled: string;
  }) => ReactNode;
}) {
  const { state } = useStore();
  const ventures = state.ventures;
  const navigate = useNavigate();
  const { runId } = useParams();
  const [params] = useSearchParams();

  /*
    THE FILTER, READ OFF THE ADDRESS. `?venture=` is a slug or an id (both are
    in the wild: the rail writes slugs, the venture Overview's links know the
    id), or `all`, or `none`, or absent — which is `all`. An unknown value
    filters to nothing rather than to everything: a link to a venture that was
    deleted should show an empty list, not the whole portfolio dressed as that
    venture's.
  */
  const asked = params.get("venture") ?? "all";
  const filterVenture =
    asked === "all" || asked === "none"
      ? null
      : (ventures.find((v) => v.id === asked || v.slug === asked) ?? null);
  const filter: "all" | "none" | "venture" | "missing" =
    asked === "all" ? "all" : asked === "none" ? "none" : filterVenture ? "venture" : "missing";
  const search = params.toString() ? `?${params.toString()}` : "";

  /*
    WHICH VENTURE THE BRIEF IS FOR — the filter when there is one, else what
    the owner picked in the form, else the workspace's default, else the first.
    THREE STATES, NOT TWO: `undefined` is "nobody has picked", which is what
    lets the address and the default keep applying; `null` is "the owner chose
    no venture", which they may do on a kind that does not need one.
  */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const chosen =
    filter === "venture"
      ? filterVenture!.id
      : filter === "none" && picked === undefined
        ? null
        : picked !== undefined
          ? picked
          : state.workspace.defaultVentureId;
  const venture = ventures.find((v) => v.id === chosen) ?? null;

  const [values, setValues] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [busyRun, setBusyRun] = useState(false);
  const [reload, setReload] = useState(0);
  /* Null until the owner presses the fold, so the default below applies. */
  const [composing, setComposing] = useState<boolean | null>(null);

  /* The kind's own runs — for this venture when one is chosen, so the page
     is forty of ITS runs rather than forty of everybody's with a filter over
     them — and, on the same document, every kind's description. */
  /*
    POLLED BY RELOADING, NOT BY CHANGING A DEPENDENCY. `useApi` empties its
    document the moment a dependency changes, so a tick in the list made the
    report and the history vanish for a frame every second and a half — the
    page collapsed, the browser reset the scroll to the top, and the reader
    lost their place on every tool call. `reload()` keeps the last document
    on screen until the next one lands, which is what a poll is.
  */
  const listVenture = filter === "venture" ? filterVenture!.id : null;
  const list = useApi(
    () => runsApi.list({ kind, venture: listVenture, limit: 40 }),
    [kind, listVenture, reload],
  );
  const info: KindInfo | null =
    list.data?.kinds.find((k) => k.kind === kind) ?? null;
  const runs = list.data?.runs ?? [];

  const open = useApi(
    () => (runId ? runsApi.get(runId) : Promise.resolve(null)),
    [runId],
  );
  const detail = open.data;

  /*
    THE QUEUE IS GLOBAL AND THIS PAGE'S LIST IS NOT — this page asks for one
    kind — so the position is the SERVER'S to work out and it sends it on the
    run. An earlier draft fetched the unfiltered list to count it here, which
    was a second request per poll to recompute something the other end already
    knew.
  */
  const position = detail?.queuePosition ?? null;

  /* Anything moving anywhere means keep asking; nothing moving means stop. A
     page left open on a finished report makes no requests at all. */
  const anyLive =
    (detail ? isLive(detail.status) : false) ||
    runs.some((r) => isLive(r.status)) ||
    (list.data?.running ? true : false) ||
    (list.data?.queued ?? 0) > 0;

  const reloadList = list.reload;
  const reloadOpen = open.reload;
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => {
      reloadList();
      reloadOpen();
    }, 1500);
    return () => clearInterval(t);
  }, [anyLive, reloadList, reloadOpen]);

  /* When the open run stops moving, the accumulations under it have something
     new to read. Derived rather than counted — see `extras.settled`. */
  const settled = detail && !isLive(detail.status) ? detail.id : "";

  /*
    THE KIND'S DEFAULTS ARE READ AT RENDER, NOT SEEDED INTO STATE.

    Seeding them would mean an effect that writes state on the first render
    after the kinds land — one extra render per visit, and a subtle bug the
    day a default changes on the server: the box would already hold the old
    one and would not take the new. So `values` holds only what somebody
    TYPED, and an untouched field falls through to the server's default. An
    emptied field is an empty string in the map, which is not undefined, so
    clearing a defaulted box stays cleared.
  */
  const valueOf = (f: { key: string; default: string | null }) =>
    values[f.key] ?? f.default ?? "";

  const needsVenture = info?.needsVenture ?? true;
  const missing = (info?.inputs ?? []).filter(
    (f) => f.required && !valueOf(f).trim(),
  );
  const canStart =
    !!info && !starting && (!needsVenture || !!venture) && !missing.length;

  /* Where a run this page starts, opens or closes lands: the same address,
     with the same filter, so starting a run for ScallopBot leaves you on
     ScallopBot's list with the new run open at the top of it. */
  const here = (id?: string) => `${appPage(slug, id)}${search}`;

  async function start() {
    if (!info) return;
    setStarting(true);
    setRefused(null);
    try {
      const input: Record<string, string> = {};
      for (const f of info.inputs) {
        const v = valueOf(f).trim();
        if (v) input[f.key] = v;
      }
      const run = await runsApi.start({
        kind,
        ventureId: venture?.id ?? null,
        input,
      });
      setReload((n) => n + 1);
      setComposing(false);
      navigate(here(run.id));
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function restart(resume: boolean) {
    if (!detail) return;
    if (!confirm(resume ? "Resume this job using completed model checkpoints?" : "Start a new job with the same inputs? This may repeat paid work.")) return;
    setBusyRun(true);
    try { const result = await (resume ? runsApi.resume(detail.id) : runsApi.retry(detail.id)); setReload(n => n + 1); navigate(here(result.id)); }
    catch (error) { setRefused(error instanceof Error ? error.message : String(error)); }
    finally { setBusyRun(false); }
  }

  async function cancel() {
    if (!detail) return;
    setBusyRun(true);
    try {
      await runsApi.cancel(detail.id);
      reloadOpen();
      setReload((n) => n + 1);
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRun(false);
    }
  }

  async function remove() {
    if (!detail) return;
    if (!confirm(`Delete “${detail.title}”? The report goes with it.`)) return;
    setBusyRun(true);
    try {
      await runsApi.remove(detail.id);
      setReload((n) => n + 1);
      navigate(here());
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRun(false);
    }
  }

  /* The server already narrowed to the venture; `none` and `missing` are the
     two it cannot express, so they are applied here. Forty rows at most. */
  const shown =
    filter === "none" ? runs.filter((r) => r.ventureId === null)
    : filter === "missing" ? []
    : runs;

  const running = list.data?.running ?? null;
  const busyHere =
    !!detail && isLive(detail.status) && detail.kind === kind;

  /* The fold's default: open when there is nothing else to look at. */
  const composeOpen = composing ?? (!runId && shown.length === 0 && !!list.data);

  /* What the fields actually hold — typed values over the server's defaults —
     rather than only what somebody touched. An `extras` slot that filtered on
     `values.topic` would otherwise see nothing until the box was edited, and
     would draw an empty library beside a field with words in it. */
  const resolved: Record<string, string> = {};
  for (const f of info?.inputs ?? []) resolved[f.key] = valueOf(f);

  const scopeWord =
    filter === "venture" ? filterVenture!.name
    : filter === "none" ? "no venture"
    : filter === "missing" ? `“${asked}”, which is not a venture here`
    : "every venture";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
      <div className="mx-auto w-full max-w-[940px]">
        <div className="mt-2 mb-5">
          <h1 className="mb-1 text-[27px] font-normal tracking-[-0.025em]">
            {info?.name ?? name}
            {filter === "venture" && (
              <span className="text-muted-foreground"> · {filterVenture!.name}</span>
            )}
          </h1>
          <p className="text-muted-foreground text-[14.5px]">
            {info?.what ??
              (list.error
                ? "The runs API did not answer, so nothing can be started here right now."
                : "Reading what this kind of run does…")}
          </p>
        </div>

        {list.error && (
          <p className="text-muted-foreground mb-4 text-[14px]">
            <span className="text-destructive">{list.error}</span>
          </p>
        )}

        {/* ------------------------------------------------------ the brief */}
        {info && (
          <div className="bg-card rounded-[14px]">
            <button
              type="button"
              aria-expanded={composeOpen}
              onClick={() => setComposing(!composeOpen)}
              className="flex w-full items-center gap-2 px-4.5 py-3 text-left"
            >
              {composeOpen ? (
                <ChevronDown className="text-muted-foreground size-4 shrink-0" strokeWidth={1.7} />
              ) : (
                <Plus className="text-muted-foreground size-4 shrink-0" strokeWidth={1.7} />
              )}
              <span className="text-[14px] font-medium tracking-tight">
                {busyHere ? "A run is in progress" : "New run"}
              </span>
              {!composeOpen && venture && (
                <span className="text-muted-foreground text-[12.5px]">for {venture.name}</span>
              )}
            </button>
            {composeOpen && (
              <div className="grid gap-3.5 px-4.5 pb-4.5">
                <div className="grid gap-1.5">
                  <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
                    {needsVenture ? "For which venture" : "About which venture"}
                  </div>
                  {ventures.length === 0 ? (
                    <p className="text-muted-foreground text-[13.5px]">
                      There are no ventures yet, and this run is made out of one —
                      the name, the sentence you wrote, the stage, the site. Add a
                      venture first.
                    </p>
                  ) : filter === "venture" ? (
                    /* The rail chose. Changing it here would start a run for a
                       venture whose list you are not looking at, which is how a
                       report ends up "missing". Pick another venture in the rail. */
                    <p className="text-[13.5px]">{filterVenture!.name}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      <VentureSelect
                        ventures={ventures}
                        value={venture?.id ?? null}
                        onChange={setPicked}
                        none={needsVenture ? null : "No venture"}
                        className="w-72"
                      />
                    </div>
                  )}
                  {!needsVenture && filter !== "venture" && (
                    <p className="text-muted-foreground text-[12.5px]">
                      Optional here. Without one the run is about whatever you type
                      below and is filed under no venture.
                    </p>
                  )}
                </div>

                {info.inputs.map((f) => (
                  <div key={f.key} className="grid gap-1.5">
                    <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
                      {f.label}
                      {!f.required && (
                        <span className="ml-1.5 tracking-normal normal-case">
                          optional
                        </span>
                      )}
                    </div>
                    {/* A CLOSED LIST WHERE THE SERVER PUBLISHED ONE. Buttons
                        rather than a <select> because there are two or three of
                        them and the hint under each one is worth reading — and
                        because everything else on this page is a chip. A `select`
                        with no options falls through to the text input below,
                        which is the honest fallback for a field this client does
                        not understand. */}
                    {f.kind === "select" && f.key === "aspect" && f.options?.length && f.options.every((o) => ASPECT_OPTIONS.some((a) => a.key === o.value)) ? (
                      <div className="max-w-sm">
                        <ShapePicker
                          label={f.label}
                          value={valueOf(f)}
                          onChange={(value) => setValues((v) => ({ ...v, [f.key]: value }))}
                          options={f.options.map((o) => ASPECT_OPTIONS.find((a) => a.key === o.value)!)}
                        />
                      </div>
                    ) : f.kind === "select" && f.options?.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {f.options.map((o) => (
                          <button
                            key={o.value}
                            onClick={() =>
                              setValues((v) => ({ ...v, [f.key]: o.value }))
                            }
                            className={cn(
                              "rounded-[12px] border px-2.5 py-1.5 text-[13.5px] transition-colors",
                              valueOf(f) === o.value
                                ? "border-foreground"
                                : "hover:border-line-strong",
                            )}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    ) : f.kind === "textarea" ? (
                      <Textarea
                        value={valueOf(f)}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [f.key]: e.target.value }))
                        }
                        rows={3}
                        maxLength={4000}
                        placeholder={f.hint}
                        className="text-[14.5px]"
                      />
                    ) : (
                      <Input
                        type={f.kind === "number" ? "number" : "text"}
                        value={valueOf(f)}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [f.key]: e.target.value }))
                        }
                        placeholder={f.hint}
                        className="text-[14.5px]"
                      />
                    )}
                  </div>
                ))}

                <div className="flex flex-wrap items-center gap-2.5">
                  <Button
                    disabled={!canStart || busyHere}
                    onClick={() => void start()}
                  >
                    {starting || busyHere ? (
                      <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} />
                    ) : (
                      <Play className="size-[15px]" strokeWidth={1.8} />
                    )}
                    {busyHere
                      ? detail?.status === "queued"
                        ? position === null
                          ? "Queued"
                          : position === 1
                            ? "Next in the queue"
                            : `${ordinal(position)} in the queue`
                        : "Working…"
                      : starting
                        ? "Starting…"
                        : "Start the run"}
                  </Button>
                  <span className="text-muted-foreground text-[13px]">
                    {busyHere && detail?.status === "queued" && running
                      ? `One run at a time on this box — ${running.title} is working.`
                      : busyHere
                        ? "It carries on if you close the tab. Come back to this address."
                        : needsVenture && !venture
                          ? "Pick a venture first."
                          : missing.length
                            ? `${missing.map((f) => f.label).join(" and ")} still to fill in.`
                            : "Minutes, not seconds. It runs on the server and survives the tab closing."}
                  </span>
                </div>

                {refused && (
                  <p className="text-destructive text-[13.5px] leading-relaxed">
                    {refused}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* ------------------------------------------------------- the runs */}
        <div className="mt-6 mb-2 flex flex-wrap items-baseline gap-2">
          <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
            Runs
          </div>
          <span className="text-muted-foreground text-[12.5px]">for {scopeWord}</span>
          <span className="text-muted-foreground ml-auto text-[12.5px]">
            {info
              ? `${info.counts.done} finished · ${info.counts.failed} failed${
                  info.counts.running + info.counts.queued > 0
                    ? ` · ${info.counts.running + info.counts.queued} in flight`
                    : ""
                } across every venture`
              : list.loading
                ? "loading…"
                : ""}
          </span>
        </div>

        {shown.length === 0 ? (
          <p className="text-muted-foreground text-[14px]">
            {list.loading && !list.data
              ? "Reading the history…"
              : filter === "venture"
                ? `Nothing has been run for ${filterVenture!.name} yet.`
                : filter === "none"
                  ? "Nothing has been run without a venture."
                  : filter === "missing"
                    ? "No venture by that name, so there is nothing to list."
                    : "Nothing has been run here yet."}
          </p>
        ) : (
          <div className="flex flex-col gap-px">
            {shown.map((r) => (
              <HistoryRow
                key={r.id}
                run={r}
                open={r.id === runId}
                showVenture={filter !== "venture"}
                onOpen={() => navigate(r.id === runId ? here() : here(r.id))}
              />
            ))}
          </div>
        )}

        {/* ---------------------------------------------------- the open run */}
        {runId && (
          <div className="border-line-soft mt-6 border-t pt-5">
            {open.error ? (
              <p className="text-muted-foreground text-[14px]">
                No run at this address.{" "}
                <span className="text-destructive">{open.error}</span>
              </p>
            ) : detail ? (
              <RunReport
                run={detail}
                busy={busyRun}
                onCancel={() => void cancel()}
                onDelete={() => void remove()}
                onRetry={() => void restart(false)}
                onResume={() => void restart(true)}
              />
            ) : (
              <p className="text-muted-foreground text-[14px]">Reading the run…</p>
            )}
          </div>
        )}

        {/* ------------------------------------------------------- the extras */}
        {extras && (
          <div className="mt-7">
            {extras({ venture, input: resolved, settled })}
          </div>
        )}
      </div>
    </div>
  );
}

/** One run: what it was about, how it ended, and what wrote it. Pressing the
 *  open one closes it — the list is the control, and a control that can only
 *  open is half a control. */
function HistoryRow({
  run,
  open,
  showVenture,
  onOpen,
}: {
  run: RunSummary;
  open: boolean;
  /** Off when the whole list is one venture's: its name on every row would
   *  be the heading repeated forty times. */
  showVenture: boolean;
  onOpen: () => void;
}) {
  const took = duration(run.ms, { nullText: "" });
  return (
    <button
      onClick={onOpen}
      aria-expanded={open}
      className={cn(
        "hover:bg-accent -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors",
        open && "bg-accent",
      )}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))}
      />
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{run.title}</span>
      {showVenture && run.ventureName && (
        <span className="text-muted-foreground hidden shrink-0 text-[12.5px] sm:block">
          {run.ventureName}
        </span>
      )}
      <span className="text-muted-foreground hidden w-[152px] shrink-0 truncate text-right text-[12.5px] lg:block">
        {backendPhrase(run)}
      </span>
      <span className="text-muted-foreground w-[124px] shrink-0 text-right text-[12.5px]">
        {isLive(run.status)
          ? statusWord(run.status)
          : `${took ? `${took} · ` : ""}${ago(run.finishedAt ?? run.queuedAt)}`}
      </span>
    </button>
  );
}
