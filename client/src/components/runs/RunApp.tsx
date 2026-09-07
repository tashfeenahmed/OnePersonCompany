import { appPage } from "../../../../shared/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { VentureSelect } from "@/components/VentureSelect";
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
 * Six apps — Research, Competitors, SEO, Demand, AI visibility, Papers — are
 * the same page with a different `kind` string: pick a venture, fill in what
 * the kind asks for, press once, then watch a report being written. The pages
 * in `pages/runs/` are four lines each because the DIFFERENCES between the
 * kinds live on the server: `GET /api/runs` sends a `KindInfo` per kind with
 * its name, its sentence, whether a venture is required and which inputs to
 * draw, and this builds itself out of that. A seventh kind is a server change
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
 * IT POLLS, AND THE ALTERNATIVE WAS WORSE. A run is minutes of work that
 * survives the tab closing; a page holding an EventSource would tie the work's
 * visibility to one browser connection, and a refresh mid-research would leave
 * a report being written on a server nobody was watching. So the server owns
 * the run and this asks — every 1.5 seconds while anything is moving, and not
 * at all when nothing is. The report is flushed to the row as it grows, which
 * is what makes polling look like streaming.
 *
 * THE RUN IS ADDRESSED, at `/apps/<app>/<run id>`. A report somebody wants a
 * second opinion on is a link, and the back button walks the history list the
 * way it walks anything else. Starting a run navigates to its address, so the
 * URL is right from the first second rather than only after it finished.
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
  /** Whatever this app has that is not a run — drawn between the open report
   *  and the history, which is where an accumulation belongs: under the thing
   *  that produced it and above the log of when. */
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
    WHICH VENTURE — the address wins, then the workspace's default, then the
    first one. `?venture=` is how the venture Overview's links arrive here, and
    it accepts an id or a slug because both are in the wild: the Overview knows
    the id, a link somebody typed knows the slug.
  */
  const asked = params.get("venture");
  /*
    THREE STATES, NOT TWO. `undefined` is "nobody has picked", which is what
    lets the address and the workspace default keep applying; `null` is "the
    owner chose no venture", which they may do on a kind that does not need
    one. Collapsing those two into null would mean pressing "No venture" put
    the page straight back onto the default.

    RESOLVED AT RENDER rather than seeded, so a `?venture=` link still lands on
    the right business when the ventures arrive AFTER this mounted — which is
    the ordinary case on a cold browser, where the store fetches them.
  */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const chosen =
    picked !== undefined
      ? picked
      : (ventures.find((v) => v.id === asked || v.slug === asked)?.id ??
        state.workspace.defaultVentureId);
  const venture = ventures.find((v) => v.id === chosen) ?? null;

  const [values, setValues] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [busyRun, setBusyRun] = useState(false);
  const [scope, setScope] = useState<"venture" | "all">("venture");
  const [reload, setReload] = useState(0);

  /* The kind's own runs and, on the same document, every kind's description —
     so one fetch configures the page and fills its history. */
  /*
    POLLED BY RELOADING, NOT BY CHANGING A DEPENDENCY. `useApi` empties its
    document the moment a dependency changes, so a tick in the list made the
    report and the history vanish for a frame every second and a half — the
    page collapsed, the browser reset the scroll to the top, and the reader
    lost their place on every tool call. `reload()` keeps the last document
    on screen until the next one lands, which is what a poll is.
  */
  const list = useApi(
    () => runsApi.list({ kind, limit: 40 }),
    [kind, reload],
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
      navigate(appPage(slug, run.id));
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
    try { const result = await (resume ? runsApi.resume(detail.id) : runsApi.retry(detail.id)); setReload(n => n + 1); navigate(appPage(slug, result.id)); }
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
      navigate(appPage(slug));
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRun(false);
    }
  }

  /* Filtered at render rather than memoised: it is forty rows, and a useMemo
     over an array this page rebuilds every poll memoises nothing. */
  const shown =
    scope === "venture" && venture
      ? runs.filter((r) => r.ventureId === venture.id)
      : runs;

  const running = list.data?.running ?? null;
  const busyHere =
    !!detail && isLive(detail.status) && detail.kind === kind;

  /* What the fields actually hold — typed values over the server's defaults —
     rather than only what somebody touched. An `extras` slot that filtered on
     `values.topic` would otherwise see nothing until the box was edited, and
     would draw an empty library beside a field with words in it. */
  const resolved: Record<string, string> = {};
  for (const f of info?.inputs ?? []) resolved[f.key] = valueOf(f);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-16">
      <div className="mx-auto w-full max-w-[940px]">
        <div className="mt-2 mb-6">
          <h1 className="mb-1 text-[27px] font-normal tracking-[-0.025em]">
            {info?.name ?? name}
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
          <div className="bg-card grid gap-3.5 rounded-[14px] p-4.5">
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
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {/* A menu, not chips: nineteen chips was a wall. */}
                  <VentureSelect
                    ventures={ventures}
                    value={venture?.id ?? null}
                    onChange={setPicked}
                    none={needsVenture ? null : "No venture"}
                    className="w-72"
                  />
                </div>
              )}
              {!needsVenture && (
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
                {f.kind === "select" && f.options?.length ? (
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

        {/* ---------------------------------------------------- the open run */}
        {runId && (
          <div className="mt-5">
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

        {/* ------------------------------------------------------ the history */}
        <div className="mt-7 mb-3 flex flex-wrap items-baseline gap-2">
          <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
            Past runs
          </div>
          {venture && (
            <div className="flex gap-1.5">
              {(
                [
                  ["venture", venture.name],
                  ["all", "Every venture"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setScope(key)}
                  className={cn(
                    "rounded-[9px] px-1.5 py-0.5 text-[12.5px] transition-colors",
                    scope === key
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <span className="text-muted-foreground ml-auto text-[12.5px]">
            {info
              ? `${info.counts.done} finished · ${info.counts.failed} failed${
                  info.counts.running + info.counts.queued > 0
                    ? ` · ${info.counts.running + info.counts.queued} in flight`
                    : ""
                }`
              : list.loading
                ? "loading…"
                : ""}
          </span>
        </div>

        {shown.length === 0 ? (
          <p className="text-muted-foreground text-[14px]">
            {list.loading && !list.data
              ? "Reading the history…"
              : venture && scope === "venture"
                ? `Nothing has been run for ${venture.name} yet.`
                : "Nothing has been run here yet."}
          </p>
        ) : (
          <div className="flex flex-col gap-px">
            {shown.map((r) => (
              <HistoryRow
                key={r.id}
                run={r}
                open={r.id === runId}
                onOpen={() => navigate(appPage(slug, r.id))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** One past run: what it was about, how it ended, and what wrote it. */
function HistoryRow({
  run,
  open,
  onOpen,
}: {
  run: RunSummary;
  open: boolean;
  onOpen: () => void;
}) {
  const took = duration(run.ms, { nullText: "" });
  return (
    <button
      onClick={onOpen}
      className={cn(
        "hover:bg-accent -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors",
        open && "bg-accent",
      )}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))}
      />
      <span className="min-w-0 flex-1 truncate text-[13.5px]">{run.title}</span>
      {run.ventureName && (
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
