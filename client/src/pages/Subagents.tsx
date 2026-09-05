import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bot,
  FileText,
  MessageSquareText,
  RefreshCw,
  SearchCheck,
  Swords,
  Telescope,
} from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import {
  backendPhrase,
  duration,
  since,
  statusTone,
  statusWord,
} from "@/components/runs/format";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/live";
import { cn } from "@/lib/utils";
import { isLive, runsApi, type KindInfo, type RunSummary } from "@/lib/api/runs";

/**
 * THE QUEUE — what the agent is working on, what is waiting, and what it did.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PAGE USED TO BE, AND WHY NONE OF IT SURVIVED.
 *
 * It was a roster: thirteen "standing workers" in two lanes, each with a
 * running flag, a waiting count, a target and eight coloured history ticks —
 * all of it typed into `data/subagents.ts` by hand, mirrored from a different
 * product (workdash) whose queue really does have those thirteen kinds. On
 * THIS box it drew a page that said "Dossiers is working on Ada Lovelace" on a
 * machine with no dossiers, no people table and no queue. The sidebar badge
 * read "2" for the same reason.
 *
 * A screen that shows a plausible number is worse than one that shows nothing:
 * nobody checks a page that has never been wrong. So the roster is gone, the
 * lanes are gone — there is one queue here, not two — and every figure below
 * comes off `GET /api/runs`. When the server has not shipped that area yet,
 * this page says so and draws no numbers at all.
 *
 * ---------------------------------------------------------------------------
 * ONE AT A TIME, AND THAT IS THE MOST IMPORTANT SENTENCE ON THE PAGE. The
 * server runs the oldest queued run when nothing else is running, and nothing
 * overlaps. That is why the header says it rather than leaving it to be
 * inferred from a queue that never has two green dots: somebody who queues a
 * paper and a research run and watches one of them sit there needs to know
 * that is the design and not a stuck job.
 *
 * WHO IS ACTUALLY DOING THE WORK IS PER-RUN AND IS ON EVERY ROW. A live agent
 * (hermes, openclaw) investigates with tools; when none is connected the run
 * falls back to one completion from the raw provider, told it has no tools and
 * must answer from the brief alone. Those two produce documents of very
 * different worth, so no row here is allowed to omit which one it was.
 *
 * THE KIND CARDS ARE THE WAY IN. This page is a queue, not a launcher — a run
 * is started from the app that owns it, where the venture picker and the
 * inputs are. Each card is therefore a link out rather than a Run button.
 */

/**
 * A kind's address and its mark.
 *
 * THE OTHER HALF OF THIS IS THE REGISTRY IN `pages/Apps.tsx`, which is where
 * the tab, the name and the order are declared. The two are kept in step by
 * hand and that is the honest cost of the apps being tabs: the server's `kind`
 * is not a URL, so somebody has to say which app a `geo` run belongs to. A
 * kind this map has never heard of still draws — without a link, which is the
 * correct thing to offer for an app that does not exist here.
 */
const KIND_APPS: Record<string, { slug: string; icon: typeof Bot }> = {
  research: { slug: "research", icon: Telescope },
  competitors: { slug: "competitors", icon: Swords },
  seo: { slug: "seo", icon: SearchCheck },
  demand: { slug: "demand", icon: MessageSquareText },
  geo: { slug: "visibility", icon: Bot },
  papers: { slug: "papers", icon: FileText },
};

/** Where a run is readable, or null for a kind with no app on this client. */
const addressOf = (run: { kind: string; id: string }) => {
  const app = KIND_APPS[run.kind];
  return app ? `/apps/${app.slug}/${run.id}` : null;
};

export function Subagents() {
  const [tick, setTick] = useState(0);
  const doc = useApi(() => runsApi.list({ limit: 50 }), [tick]);

  const runs = doc.data?.runs ?? [];
  const kinds = doc.data?.kinds ?? [];
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
    return () => clearInterval(t);
  }, [live]);

  const done = kinds.reduce((n, k) => n + k.counts.done, 0);
  const failed = kinds.reduce((n, k) => n + k.counts.failed, 0);

  const stats: [string, string][] = [
    [running ? "1" : "0", "working now"],
    [String(doc.data?.queued ?? 0), "waiting"],
    [String(done), done === 1 ? "report kept" : "reports kept"],
    [String(failed), failed === 1 ? "failure" : "failures"],
  ];

  return (
    <>
      <TopBar label="Sub-agents">
        <button
          onClick={() => setTick((n) => n + 1)}
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
        sub="Long agent work, started from an app and executed on the server. One run at a time: the oldest waiting one starts when the one before it finishes, and it carries on with every tab shut."
      >
        {doc.error ? (
          <p className="text-muted-foreground text-[13px]">
            The queue could not be read, so there is nothing to show — not even
            a zero, which would be a claim that nothing is running.{" "}
            <span className="text-destructive">{doc.error}</span>
          </p>
        ) : (
          <>
            <div className="mb-5.5 flex flex-wrap gap-2">
              {stats.map(([v, k]) => (
                <div
                  key={k}
                  className="bg-card min-w-[150px] flex-1 rounded-[10px] border px-3.5 py-3"
                >
                  <div className="text-[22px] font-normal tracking-[-0.03em] tabular-nums">
                    {doc.loading && !doc.data ? "—" : v}
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-[11.5px]">
                    {k}
                  </div>
                </div>
              ))}
            </div>

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

            {/* ------------------------------------------------- by the kind */}
            <div className="text-muted-foreground mt-7 mb-2 text-[11px] tracking-[0.06em] uppercase">
              The six kinds
            </div>
            <div className="mb-7 grid gap-1.5 sm:grid-cols-2">
              {kinds.map((k) => (
                <KindCard
                  key={k.kind}
                  info={k}
                  last={runs.find((r) => r.kind === k.kind) ?? null}
                />
              ))}
              {kinds.length === 0 && !doc.loading && (
                <p className="text-muted-foreground text-[13px]">
                  The server describes no kinds of run.
                </p>
              )}
            </div>

            {/* ---------------------------------------------------- history */}
            <div className="mb-2 flex items-baseline gap-2">
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
                Nothing has been run yet. Every one of the six apps starts its
                own kind of run, and they all queue here.
              </p>
            ) : (
              <div className="flex flex-col gap-px">
                {runs.map((r) => (
                  <HistoryRow key={r.id} run={r} />
                ))}
              </div>
            )}

            <p className="text-muted-foreground pt-5 text-[13px]">
              Every run above is kept until it is deleted — the reports are the
              ledger, not a 48-hour window. A run that was executing when the
              server restarted is marked failed with the reason, because it did
              not finish and nothing here is allowed to say it did.
            </p>
          </>
        )}
      </PageShell>
    </>
  );
}

/** The run in flight, with the two facts that change while you watch it. */
function Working({ run }: { run: RunSummary }) {
  const to = addressOf(run);
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
          · {run.outputChars.toLocaleString()} characters written ·{" "}
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

/** A kind, its counts and where its last run got to. The card is the way into
 *  the app; nothing is started from this page. */
function KindCard({ info, last }: { info: KindInfo; last: RunSummary | null }) {
  const app = KIND_APPS[info.kind];
  const Icon = app?.icon ?? Bot;
  const inflight = info.counts.running + info.counts.queued;

  const card = (
    <>
      <div className="bg-muted grid size-8 shrink-0 place-items-center rounded-[9px]">
        <Icon className="size-4" strokeWidth={1.6} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[13.5px] font-medium tracking-tight">
            {info.name}
          </span>
          <span className="text-muted-foreground font-mono text-[11px]">
            {info.kind}
          </span>
          {inflight > 0 && (
            <span className="text-warn text-[11.5px]">
              {inflight} in flight
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 text-[12px] leading-relaxed">
          {info.what}
        </p>
        <p className="text-muted-foreground mt-1 text-[11.5px]">
          {info.counts.done} kept · {info.counts.failed} failed ·{" "}
          {last
            ? `last ${statusWord(last.status)} ${ago(last.finishedAt ?? last.queuedAt)}`
            : "never run"}
        </p>
      </div>
    </>
  );

  return app ? (
    <Link
      to={`/apps/${app.slug}`}
      className="bg-card hover:border-line-strong flex items-start gap-3 rounded-[10px] border px-3.5 py-3 transition-colors"
    >
      {card}
    </Link>
  ) : (
    <div className="bg-card flex items-start gap-3 rounded-[10px] border px-3.5 py-3">
      {card}
    </div>
  );
}

/** A run's name, linked when this client has an app that can open it. */
function RunTitle({ run }: { run: RunSummary }) {
  const to = addressOf(run);
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
  const to = addressOf(run);
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
