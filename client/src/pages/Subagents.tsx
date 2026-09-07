import { appPage } from "../../../shared/navigation";
import { useEffect, useState } from "react";
import { WORK_CHANGED } from "@/hooks/useRunQueue";
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { Tiles } from "@/components/integrations/Panel";
import { QueueControls } from "@/components/runs/QueueControls";
import { PageShell, TopBar } from "@/components/PageShell";
import { SubTabs } from "@/components/TabStrip";
import { OrgChart } from "@/components/org/OrgChart";
import { RoleIcon } from "@/components/org/RoleIcon";
import { runAddress } from "@/components/org/roleLook";
import {
  backendPhrase,
  since,
  statusTone,
  statusWord,
} from "@/components/runs/format";
import { useApi } from "@/hooks/useApi";
import { ago, count, duration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isLive, runsApi, type RunSummary } from "@/lib/api/runs";
import { subagentApi, type Org } from "@/lib/api/subagents";

/**
 * THE SUB-AGENTS: who works here, and what they are doing — as two tabs.
 *
 * ---------------------------------------------------------------------------
 * THIS PAGE HAS BEEN A ROSTER BEFORE AND IT WAS A LIE. It shipped with
 * thirteen "standing workers" typed into `data/subagents.ts` by hand, mirrored
 * from a different product, drawing a page that said "Dossiers is working on
 * Ada Lovelace" on a machine with no dossiers and no queue. That was deleted
 * and replaced with the queue alone, on the rule that a screen showing a
 * plausible number is worse than one showing nothing.
 *
 * THE ROSTER IS BACK BECAUSE THE WORKERS ARE NOW REAL, and it is drawn as the
 * org chart rather than as a list: the owner at the top, the chief of staff
 * under them, and every venture with its workers under that. Every status on
 * it is a fact about the queue — `running` is a run executing right now,
 * `queued` is a count of runs waiting, a worker's last run is a report with an
 * address. Nothing on this page is a sample.
 *
 * TWO TABS, BECAUSE THE TWO QUESTIONS ARE ASKED AT DIFFERENT MOMENTS. "Who
 * works for whom" is asked when you are thinking about the business and wants
 * a picture; "what is happening" is asked when you are waiting for a report
 * and wants the live queue, the counts and the history. Stacking them made a
 * page where the chart pushed the queue off the bottom and the queue pushed
 * the chart off the top. The URL carries the choice (`?tab=runs`), so a link
 * to the queue is a link to the queue.
 *
 * ONE AT A TIME, STILL, and it is still the most important sentence here. The
 * server runs the oldest queued run when nothing else is running. A hundred
 * and fourteen workers do not mean a hundred and fourteen things at once —
 * they mean a hundred and fourteen names for the work, and one worker at the
 * front of one queue.
 */

const TABS = [
  { key: "roster", label: "Roster", title: "The org chart: the owner, the chief of staff and every venture's workers." },
  { key: "runs", label: "Runs", title: "What is running, what is waiting, and everything that has run." },
] as const;

export function Subagents() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "runs" ? "runs" : "roster";

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
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13.5px]"
        >
          <RefreshCw
            className={cn("size-3.5", doc.loading && !doc.data && "animate-spin")}
            strokeWidth={1.6}
          />
          Refresh
        </button>
      </TopBar>

      <PageShell
        wide
        title="Sub-agents"
        sub={
          tab === "roster"
            ? team
              ? `${team.subagents} workers across ${org.data?.ventures.length ?? 0} ventures, one per app, provisioned rather than created. ${team.enabled} switched on, ${team.running} working, ${team.queued} waiting.`
              : "Every venture's workers, who they report to, and what each of them is doing."
            : "The shared job queue. Reorder or hold waiting jobs; work continues while the server is running."
        }
        action={
          <SubTabs
            tabs={TABS}
            activeKey={tab}
            onSelect={(k) => setParams(k === "roster" ? {} : { tab: k })}
            className="mb-0"
          />
        }
      >
        {tab === "roster" ? (
          <Roster org={org} />
        ) : (
          <Runs
            doc={doc}
            runs={runs}
            running={running}
            queued={queued}
            stats={stats}
          />
        )}
      </PageShell>
    </>
  );
}

/* ------------------------------------------------------------- the roster */

/**
 * THE ORG CHART, WHOLE. No filter box here — that is the Org page's — because
 * a roster is the whole staff and a chart that had been quietly narrowed is
 * the one that says the SEO analyst does not exist.
 */
function Roster({ org }: { org: { data: Org | null; error: string | null; loading: boolean } }) {
  if (org.error)
    return (
      <p className="text-muted-foreground text-[14px]">
        The org could not be read, so none of it is drawn — an empty chart
        would be a claim that nobody works here.{" "}
        <span className="text-destructive">{org.error}</span>
      </p>
    );
  if (!org.data)
    return (
      <p className="text-muted-foreground text-[13.5px]">
        {org.loading ? "Counting everyone in…" : "Nothing came back."}
      </p>
    );

  return (
    <>
      <OrgChart
        owner={org.data.owner}
        chiefOfStaff={org.data.chiefOfStaff}
        ventures={org.data.ventures}
      />
      {!org.data.ventures.length && (
        <p className="text-muted-foreground text-[13.5px]">
          There are no ventures, so there is nobody to staff. Make one and its
          workers appear with it.
        </p>
      )}

      {/* ------------------------------------------------ the roles */}
      {org.data.roles.length > 0 && (
        <>
          <div className="mt-8 mb-2 flex items-baseline gap-2">
            <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
              What each worker does
            </div>
            <span className="text-muted-foreground ml-auto text-[12.5px]">
              {org.data.roles.length} roles, the same on every venture
            </span>
          </div>
          {/*
            ONE CARD PER ROLE, ALWAYS OPEN. This was a native accordion with a
            triangle nobody else on the page draws, folded shut over the one
            paragraph a new reader needs. Ten roles fit in a grid; a card
            carries the icon the chart uses for the same worker, the kind's
            own sentence, and a link to the app whose runs are its work.
          */}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {org.data.roles.map((r) => (
              <Link
                key={r.role}
                to={appPage(r.app)}
                title={`Every ${r.title.toLowerCase()}'s runs are read on the ${r.title} app page.`}
                className="bg-card hover:bg-card-hover flex flex-col gap-1.5 rounded-[14px] px-4 py-3.5 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <span className="bg-muted text-foreground grid size-7 shrink-0 place-items-center rounded-lg">
                    <RoleIcon role={r.role} className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                    {r.title}
                  </span>
                  <span className="text-muted-foreground shrink-0 font-mono text-[11.5px]">
                    {r.kind}
                  </span>
                </span>
                <span className="text-muted-foreground text-[12.5px] leading-relaxed">
                  {r.what}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
      <p className="text-muted-foreground mt-5 text-[12.5px] leading-relaxed">
        Nobody here was created by hand. Every venture gets the same workers —
        one per app — the moment it exists, and a venture that is deleted
        takes them with it. Press a worker to give it a brief, change its
        standing instructions or read what it has already done.
      </p>
    </>
  );
}

/* --------------------------------------------------------------- the runs */

function Runs({
  doc,
  runs,
  running,
  queued,
  stats,
}: {
  doc: { loading: boolean; error: string | null; data: unknown };
  runs: RunSummary[];
  running: RunSummary | null;
  queued: RunSummary[];
  stats: [string, string][];
}) {
  if (doc.error)
    return (
      <p className="text-muted-foreground text-[14px]">
        The queue could not be read, so there is nothing to show — not even a
        zero, which would be a claim that nothing is running.{" "}
        <span className="text-destructive">{doc.error}</span>
      </p>
    );
  const pending = doc.loading && !doc.data;
  return (
    <>
      <QueueControls />

      {/* A FIGURE NOBODY HAS READ YET IS A DASH, not the last one still on
          screen and not a zero. */}
      <Tiles items={stats.map(([v, k]) => ({ v: pending ? "—" : v, k }))} />

      {/* ----------------------------------------------------- right now */}
      <div className="text-muted-foreground mb-2 text-[12px] tracking-[0.06em] uppercase">
        Right now
      </div>
      {running ? (
        <Working run={running} />
      ) : (
        <p className="text-muted-foreground mb-3 text-[14px]">
          {pending
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
              <span className="text-muted-foreground w-4 shrink-0 text-[12.5px] tabular-nums">
                {i + 1}
              </span>
              <span className="bg-warn size-1.5 shrink-0 rounded-full" />
              <RunTitle run={r} />
              <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px]">
                queued {ago(r.queuedAt)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ------------------------------------------------------ history */}
      <div className="mt-7 mb-2 flex items-baseline gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          Everything, newest first
        </div>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {runs.length === 0
            ? ""
            : `last ${runs.length} ${runs.length === 1 ? "run" : "runs"}`}
        </span>
      </div>
      {runs.length === 0 ? (
        <p className="text-muted-foreground text-[14px]">
          No jobs yet. Start a job from an app to track it here.
        </p>
      ) : (
        <div className="flex flex-col gap-px">
          {runs.map((r) => (
            <HistoryRow key={r.id} run={r} />
          ))}
        </div>
      )}

      <p className="text-muted-foreground pt-5 text-[14px]">
        Reports stay until you delete them. Interrupted jobs are marked failed
        and can be retried from their report. AI visibility jobs can also
        resume saved model steps.
      </p>
    </>
  );
}

/** The run in flight, with the two facts that change while you watch it. */
function Working({ run }: { run: RunSummary }) {
  const elapsed = since(run.startedAt);
  return (
    <Link
      to={runAddress(run)}
      className="bg-card hover:bg-card-hover flex items-start gap-2.5 rounded-[14px] px-4.5 py-3.5 transition-colors"
    >
      <span className="bg-ok mt-[7px] size-1.5 shrink-0 animate-pulse rounded-full" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-[14.5px] font-medium tracking-tight">
            {run.title}
          </span>
          <span className="text-muted-foreground text-[12.5px]">
            {run.kind}
            {run.ventureName && ` · ${run.ventureName}`}
          </span>
        </span>
        <span className="text-muted-foreground mt-0.5 block text-[13px]">
          {elapsed ? `Working for ${elapsed}` : "Working"} ·{" "}
          {run.steps > 0
            ? `${run.steps} ${run.steps === 1 ? "tool call" : "tool calls"}`
            : "no tool calls yet"}{" "}
          · {count(run.outputChars)} characters written ·{" "}
          {backendPhrase(run)}
        </span>
      </span>
    </Link>
  );
}

/** A run's name, linked. Every kind has an address — `runPage` falls back to
 *  the kind's own outputs page — so there is no unlinked variant to draw. */
function RunTitle({ run }: { run: RunSummary }) {
  return (
    <Link to={runAddress(run)} className="min-w-0 truncate text-[13.5px] hover:underline">
      {run.title}
      {run.ventureName && (
        <span className="text-muted-foreground"> · {run.ventureName}</span>
      )}
    </Link>
  );
}

function HistoryRow({ run }: { run: RunSummary }) {
  const took = duration(run.ms, { nullText: "" });
  return (
    <Link
      to={runAddress(run)}
      className="hover:bg-accent -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors"
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", statusTone(run.status))}
      />
      <span className="min-w-0 flex-1 truncate text-[13.5px]">
        {run.title}
        {run.ventureName && (
          <span className="text-muted-foreground"> · {run.ventureName}</span>
        )}
      </span>
      <span className="text-muted-foreground hidden w-[92px] shrink-0 truncate text-right font-mono text-[12px] sm:block">
        {run.kind}
      </span>
      <span className="text-muted-foreground hidden w-[168px] shrink-0 truncate text-right text-[12.5px] lg:block">
        {backendPhrase(run)}
      </span>
      <span className="text-muted-foreground w-[132px] shrink-0 text-right text-[12.5px]">
        {isLive(run.status)
          ? statusWord(run.status)
          : `${took ? `${took} · ` : ""}${ago(run.finishedAt ?? run.queuedAt)}`}
      </span>
    </Link>
  );
}
