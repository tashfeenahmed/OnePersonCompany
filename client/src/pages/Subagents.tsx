import { useEffect, useMemo, useState } from "react";
import { WORK_CHANGED } from "@/hooks/useRunQueue";
import { Link } from "react-router-dom";
import { ChevronRight, RefreshCw } from "lucide-react";
import { Tiles } from "@/components/integrations/Panel";
import { QueueControls } from "@/components/runs/QueueControls";
import { PageShell, TopBar } from "@/components/PageShell";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { SubagentRow } from "@/components/org/SubagentRow";
import { RoleIcon } from "@/components/org/RoleIcon";
import { runAddress, teamAddress } from "@/components/org/roleLook";
import {
  backendPhrase,
  duration,
  since,
  statusTone,
  statusWord,
} from "@/components/runs/format";
import { useApi } from "@/hooks/useApi";
import { ago, count } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isLive, runsApi, type RunSummary } from "@/lib/api/runs";
import { subagentApi, type OrgVentureTeam } from "@/lib/api/subagents";

/**
 * THE ROSTER: everybody who works here, what they are doing, and the one queue
 * they all wait in.
 *
 * ---------------------------------------------------------------------------
 * THIS PAGE HAS BEEN A ROSTER BEFORE AND IT WAS A LIE. It shipped with
 * thirteen "standing workers" typed into `data/subagents.ts` by hand, mirrored
 * from a different product, drawing a page that said "Dossiers is working on
 * Ada Lovelace" on a machine with no dossiers and no queue. That was deleted
 * and replaced with the queue alone, on the rule that a screen showing a
 * plausible number is worse than one showing nothing.
 *
 * THE ROSTER IS BACK BECAUSE THE WORKERS ARE NOW REAL. There are six per
 * venture, they exist as rows, they are provisioned rather than invented, and
 * every status below is a fact about the queue: `running` is a run executing
 * right now, `queued` is a count of runs waiting, `lastRun` is a report with an
 * address. Nothing on this page is a sample.
 *
 * ONE AT A TIME, STILL, and it is still the most important sentence here. The
 * server runs the oldest queued run when nothing else is running. A hundred
 * and fourteen workers do not mean a hundred and fourteen things at once —
 * they mean a hundred and fourteen names for the work, and one worker at the
 * front of one queue.
 *
 * WHY BOTH THIS AND THE CHART. The chart answers "who works for whom" and is a
 * picture; this answers "what is happening" and is a list, with the live queue
 * at the top of it. Neither is a tab of the other because they are read at
 * different moments — one when you are thinking about the business, one when
 * you are waiting for a report.
 */

export function Subagents() {
  const [tick, setTick] = useState(0);
  const doc = useApi(() => runsApi.list({ limit: 50 }), [tick]);
  /* THE ROSTER IS ASKED FOR ON ITS OWN, SLOWER CLOCK. The queue document is
     four counts and fifty rows and is polled every second and a half while
     something is moving; the org is a hundred and fourteen workers with a
     last run each, and re-reading that at the same rate would be the page
     costing more than the work it is watching. */
  const [orgTick, setOrgTick] = useState(0);
  const org = useApi(() => subagentApi.org(), [orgTick]);

  const runs = doc.data?.runs ?? [];
  const running = doc.data?.running ?? null;
  const queued = runs
    .filter((r) => r.status === "queued")
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

  /* Fast while something is moving, slow while nothing is. A run takes
     minutes; a queue nobody is draining does not need to be asked about four
     times a minute. */
  const live = !!running || queued.length > 0;
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), live ? 1500 : 10_000);
    /* And the moment a chat turn ends, which is when a dispatch has just
       happened — see hooks/useRunQueue.ts. */
    const now = () => setTick((n) => n + 1);
    window.addEventListener(WORK_CHANGED, now);
    return () => {
      clearInterval(t);
      window.removeEventListener(WORK_CHANGED, now);
    };
  }, [live]);
  useEffect(() => {
    const t = setInterval(() => setOrgTick((n) => n + 1), live ? 6000 : 60_000);
    return () => clearInterval(t);
  }, [live]);

  const kinds = doc.data?.kinds ?? [];
  const done = kinds.reduce((n, k) => n + k.counts.done, 0);
  const failed = kinds.reduce((n, k) => n + k.counts.failed, 0);
  const team = org.data?.summary ?? null;

  const stats: [string, string][] = [
    [running ? "1" : "0", "working now"],
    [String(doc.data?.queued ?? 0), "waiting"],
    [team ? String(team.subagents) : "—", "sub-agents"],
    [String(done), done === 1 ? "report kept" : "reports kept"],
    [String(failed), failed === 1 ? "failure" : "failures"],
  ];

  return (
    <>
      <TopBar label="Sub-agents">
        <button
          onClick={() => {
            setTick((n) => n + 1);
            setOrgTick((n) => n + 1);
          }}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]"
        >
          <RefreshCw
            className={cn("size-3.5", doc.loading && !doc.data && "animate-spin")}
            strokeWidth={1.6}
          />
          Refresh
        </button>
      </TopBar>

      <PageShell
        title="Sub-agents"
        sub="Manage each venture's workers and their shared job queue. Reorder or hold waiting jobs below; work continues while the server is running."
      >
        <QueueControls />
        {doc.error ? (
          <p className="text-muted-foreground text-[13px]">
            The queue could not be read, so there is nothing to show — not even
            a zero, which would be a claim that nothing is running.{" "}
            <span className="text-destructive">{doc.error}</span>
          </p>
        ) : (
          <>
            {/* A FIGURE NOBODY HAS READ YET IS A DASH, not the last one still
                on screen and not a zero. */}
            <Tiles
              items={stats.map(([v, k]) => ({ v: doc.loading && !doc.data ? "—" : v, k }))}
            />

            {/* --------------------------------------------------- right now */}
            <div className="text-muted-foreground mb-2 text-[11px] tracking-[0.06em] uppercase">
              Right now
            </div>
            {running ? (
              <Working run={running} />
            ) : (
              <p className="text-muted-foreground mb-3 text-[13px]">
                {doc.loading && !doc.data
                  ? "Reading the queue…"
                  : "Nothing is running. The tick that starts the next waiting run comes round every few seconds."}
              </p>
            )}

            {queued.length > 0 && (
              <div className="mt-2 mb-3 flex flex-col gap-px">
                {queued.map((r, i) => (
                  <div
                    key={r.id}
                    className="border-line-soft flex items-center gap-2.5 border-b py-1.5 last:border-b-0"
                  >
                    <span className="text-muted-foreground w-4 shrink-0 text-[11.5px] tabular-nums">
                      {i + 1}
                    </span>
                    <span className="bg-warn size-1.5 shrink-0 rounded-full" />
                    <RunTitle run={r} />
                    <span className="text-muted-foreground ml-auto shrink-0 text-[11.5px]">
                      queued {ago(r.queuedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ----------------------------------------------- the roster */}
            <div className="mt-7 mb-2 flex items-baseline gap-2">
              <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                The roster
              </div>
              {team && (
                <span className="text-muted-foreground ml-auto text-[11.5px]">
                  {team.subagents} across {org.data?.ventures.length ?? 0}{" "}
                  ventures · {team.enabled} on
                </span>
              )}
            </div>
            <Roster
              ventures={org.data?.ventures ?? []}
              loading={org.loading && !org.data}
              error={org.error}
            />

            {org.data?.roles.length ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm">What each worker does</summary>
                <div className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {org.data.roles.map((r) => (
                  <div
                    key={r.role}
                    className="text-muted-foreground flex items-start gap-2 text-[11.5px]"
                  >
                    <RoleIcon role={r.role} className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <span className="text-foreground">{r.title}</span> ·{" "}
                      {r.what}
                    </span>
                  </div>
                ))}
                </div>
              </details>
            ) : null}

            {/* ---------------------------------------------------- history */}
            <div className="mt-7 mb-2 flex items-baseline gap-2">
              <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                Everything, newest first
              </div>
              <span className="text-muted-foreground ml-auto text-[11.5px]">
                {runs.length === 0
                  ? ""
                  : `last ${runs.length} ${runs.length === 1 ? "run" : "runs"}`}
              </span>
            </div>
            {runs.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                No jobs yet. Start a job from an app to track it here.
              </p>
            ) : (
              <div className="flex flex-col gap-px">
                {runs.map((r) => (
                  <HistoryRow key={r.id} run={r} />
                ))}
              </div>
            )}

            <p className="text-muted-foreground pt-5 text-[13px]">
              Reports stay until you delete them. Interrupted jobs are marked
              failed and can be retried from their report. AI visibility jobs
              can also resume saved model steps.
            </p>
          </>
        )}
      </PageShell>
    </>
  );
}

/**
 * EVERY WORKER, UNDER THE VENTURE THEY WORK FOR.
 *
 * COLLAPSED BY DEFAULT, EXCEPT WHERE SOMETHING IS HAPPENING. Nineteen ventures
 * times six is a hundred and fourteen rows, which as a flat list is a wall
 * nobody reads; as nineteen closed rows it is a page you can see the shape of.
 * The exception is the whole trick: a venture with a run in flight or waiting
 * opens itself, so "what is happening" never requires a press.
 *
 * The group header carries the counts, so a closed venture still says whether
 * anything under it is alive.
 */
function Roster({
  ventures,
  loading,
  error,
}: {
  ventures: OrgVentureTeam[];
  loading: boolean;
  error: string | null;
}) {
  const busy = useMemo(
    () =>
      new Set(
        ventures
          .filter((v) => v.subagents.some((s) => s.running || s.queued > 0))
          .map((v) => v.id),
      ),
    [ventures],
  );
  /* Null means "nobody has pressed anything yet", so the busy set decides. A
     press puts an explicit set in here and from then on it is the owner's. */
  const [open, setOpen] = useState<Set<string> | null>(null);
  const isOpen = (id: string) => (open ? open.has(id) : busy.has(id));
  const toggle = (id: string) =>
    setOpen(() => {
      const next = new Set(open ?? busy);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (error)
    return (
      <p className="text-muted-foreground text-[13px]">
        The roster could not be read, so nobody is listed — an empty list would
        say this box employs nobody.{" "}
        <span className="text-destructive">{error}</span>
      </p>
    );
  if (!ventures.length)
    return (
      <p className="text-muted-foreground text-[13px]">
        {loading
          ? "Counting everyone in…"
          : "No ventures, so no workers. Every venture gets its six the moment it exists."}
      </p>
    );

  return (
    <div className="flex flex-col gap-px">
      {ventures.map((v) => {
        const on = isOpen(v.id);
        const working = v.subagents.filter((s) => s.running).length;
        const waiting = v.subagents.reduce((n, s) => n + s.queued, 0);
        const off = v.subagents.filter((s) => !s.enabled).length;
        const last = v.subagents
          .map((s) => s.lastRun)
          .filter((r): r is RunSummary => !!r)
          .sort((a, b) =>
            (b.finishedAt ?? b.queuedAt).localeCompare(a.finishedAt ?? a.queuedAt),
          )[0];
        return (
          <div key={v.id} className="border-line-soft border-b last:border-b-0">
            <button
              onClick={() => toggle(v.id)}
              aria-expanded={on}
              className="hover:bg-accent -mx-1.5 flex w-[calc(100%+12px)] items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors"
            >
              <ChevronRight
                className={cn(
                  "text-muted-foreground size-3.5 shrink-0 transition-transform",
                  on && "rotate-90",
                )}
                strokeWidth={1.8}
              />
              <VentureMark
                venture={{
                  name: v.name,
                  color: v.color,
                  brand: { favicon: v.favicon },
                }}
                size={16}
              />
              <span className="truncate text-[12.5px] font-medium">{v.name}</span>
              <StagePill stage={v.stage} />
              <span className="text-muted-foreground ml-auto shrink-0 text-[11.5px]">
                {working > 0 && (
                  <span className="text-foreground">
                    {working} working ·{" "}
                  </span>
                )}
                {waiting > 0 && `${waiting} waiting · `}
                {off > 0 && `${off} off · `}
                {v.subagents.length} workers
              </span>
              <span className="text-muted-foreground hidden w-[92px] shrink-0 text-right text-[11.5px] sm:block">
                {last ? ago(last.finishedAt ?? last.queuedAt) : "never run"}
              </span>
            </button>

            {on && (
              <div className="border-line-soft mb-1.5 ml-[9px] flex flex-col gap-px border-l pl-3">
                {v.subagents.map((sa) => (
                  <SubagentRow
                    key={sa.id}
                    sa={sa}
                    to={teamAddress(v.slug, sa.role)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The run in flight, with the two facts that change while you watch it. */
function Working({ run }: { run: RunSummary }) {
  const to = runAddress(run);
  const elapsed = since(run.startedAt);
  const body = (
    <>
      <span className="bg-ok mt-[7px] size-1.5 shrink-0 animate-pulse rounded-full" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-[13.5px] font-medium tracking-tight">
            {run.title}
          </span>
          <span className="text-muted-foreground text-[11.5px]">
            {run.kind}
            {run.ventureName && ` · ${run.ventureName}`}
          </span>
        </span>
        <span className="text-muted-foreground mt-0.5 block text-[12px]">
          {elapsed ? `Working for ${elapsed}` : "Working"} ·{" "}
          {run.steps > 0
            ? `${run.steps} ${run.steps === 1 ? "tool call" : "tool calls"}`
            : "no tool calls yet"}{" "}
          · {count(run.outputChars)} characters written ·{" "}
          {backendPhrase(run)}
        </span>
      </span>
    </>
  );
  return to ? (
    <Link
      to={to}
      className="bg-card hover:border-line-strong flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3 transition-colors"
    >
      {body}
    </Link>
  ) : (
    <div className="bg-card flex items-start gap-2.5 rounded-[10px] border px-3.5 py-3">
      {body}
    </div>
  );
}

/** A run's name, linked when this client has an app that can open it. */
function RunTitle({ run }: { run: RunSummary }) {
  const to = runAddress(run);
  const label = (
    <>
      {run.title}
      {run.ventureName && (
        <span className="text-muted-foreground"> · {run.ventureName}</span>
      )}
    </>
  );
  return to ? (
    <Link to={to} className="min-w-0 truncate text-[12.5px] hover:underline">
      {label}
    </Link>
  ) : (
    <span className="min-w-0 truncate text-[12.5px]">{label}</span>
  );
}

function HistoryRow({ run }: { run: RunSummary }) {
  const to = runAddress(run);
  const took = duration(run.ms);
  const inner = (
    <>
      <span
        className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px]">
        {run.title}
        {run.ventureName && (
          <span className="text-muted-foreground"> · {run.ventureName}</span>
        )}
      </span>
      <span className="text-muted-foreground hidden w-[92px] shrink-0 truncate text-right font-mono text-[11px] sm:block">
        {run.kind}
      </span>
      <span className="text-muted-foreground hidden w-[168px] shrink-0 truncate text-right text-[11.5px] lg:block">
        {backendPhrase(run)}
      </span>
      <span className="text-muted-foreground w-[132px] shrink-0 text-right text-[11.5px]">
        {isLive(run.status)
          ? statusWord(run.status)
          : `${took ? `${took} · ` : ""}${ago(run.finishedAt ?? run.queuedAt)}`}
      </span>
    </>
  );
  return to ? (
    <Link
      to={to}
      className="hover:bg-accent -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors"
    >
      {inner}
    </Link>
  ) : (
    <div className="-mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5">
      {inner}
    </div>
  );
}
