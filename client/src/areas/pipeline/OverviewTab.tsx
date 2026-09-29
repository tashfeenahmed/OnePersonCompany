import { Fragment, useMemo } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, ChevronRight, Info, Moon, Settings2, XCircle } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { roundsApi } from "@/lib/api/chief";
import { cn } from "@/lib/utils";
import { pipelineApi, type PipelineDoc, type Run, type RunDoc } from "./api";
import {
  PHASES,
  attention,
  humanWhen,
  outcomeTone,
  phaseOf,
  relative,
  runHeadline,
  runTone,
  took,
  TONE_FILL,
  type AttentionItem,
} from "./explain";
import { RunActions } from "./RunActions";
import { useWorkflow } from "./useWorkflow";
import { HealthBadge, HistoryStrip, Legend, RunTimeline, StepGlyph, type Health } from "./WorkflowParts";
import { stepInfoFrom, type StepInfo } from "./steps";

/**
 * THE WORKFLOWS OVERVIEW: what needs you, what workflows exist and how each
 * is doing, and the most recent run step by step. Everything here answers a
 * question at a glance; editing lives on the Steps & schedule tab and the
 * full history on Runs.
 */
export function OverviewTab() {
  const wf = useWorkflow();
  const { doc, def, queue, history, lookup, maxMinutesOf, reload } = wf;

  /* The last real run opened in full, for the errors each step reported —
     the list carries outcomes only. */
  const lastId = history[0]?.id ?? null;
  const lastDetail = useApi(() => (lastId ? pipelineApi.one(lastId) : Promise.resolve(null)), [lastId]);
  const items = useMemo(() => {
    if (!doc.data) return [];
    return buildAttention(doc.data, lastDetail.data, lookup, queue.data?.queue.length ?? null);
  }, [doc.data, lastDetail.data, lookup, queue.data]);

  if (doc.error) return <p className="text-destructive text-[14.5px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14.5px]">Reading your workflows…</p>;
  const data = doc.data;
  const running = !!data.activity?.running;
  const focusId = running && data.activity.runId ? data.activity.runId : (data.last?.id ?? null);
  const focusRun = running ? null : data.last;

  return (
    <div className="flex flex-col gap-6">
      <AttentionPanel items={items} lastRun={data.last} running={running} />

      <section>
        <h2 className="mb-2.5 text-[15px] font-medium">Your workflows</h2>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <NightlyCard
            doc={data}
            name={def.data?.definition.name ?? "Nightly business review"}
            blocks={def.data?.definition.blocks.filter((b) => b.enabled).map((b) => lookup(b.id)).filter((x): x is StepInfo => !!x) ?? []}
            history={history}
            health={healthOf(data, history, items)}
            onChanged={reload}
          />
          <RoundsCard />
        </div>
      </section>

      <section className="border-line-soft bg-card rounded-2xl p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[15px] font-medium">{running ? "Running now, step by step" : "The last run, step by step"}</h2>
          {focusRun && (
            <span className="text-muted-foreground text-[12.5px]">
              {humanWhen(focusRun.startedAt)} · took {took(focusRun.ms)} · {runHeadline(focusRun)}
            </span>
          )}
          <Link to="/workflows/runs" className="text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1 text-[12.5px]">
            All runs <ChevronRight className="size-3.5" />
          </Link>
        </div>
        {focusId ? (
          <RunTimeline key={focusId} id={focusId} lookup={lookup} maxMinutesOf={maxMinutesOf} />
        ) : (
          <p className="text-muted-foreground text-[13.5px]">
            The workflow has not run yet. Press Preview to see what it would do, or Run now to start it.
          </p>
        )}
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- attention */

function buildAttention(
  data: PipelineDoc,
  last: RunDoc | null,
  lookup: (id: string) => StepInfo | undefined,
  queued: number | null,
): AttentionItem[] {
  const info = last ? stepInfoFrom(last, lookup) : null;
  return attention({
    scheduleOn: data.schedule.enabled,
    running: !!data.activity?.running,
    skipNight: data.schedule.skipTonight,
    catchUpDay: data.schedule.catchUpDay,
    maxMinutes: data.schedule.maxMinutes,
    queued,
    last:
      last && info
        ? {
            startedAt: last.run.startedAt,
            steps: last.stages.map((s) => {
              const i = info(s.stageId);
              return {
                title: i.title,
                kind: i.kind ?? (s.area === "subagents" ? "agent" : null),
                outcome: s.outcome,
                error: s.error,
              };
            }),
          }
        : null,
    stages: data.stages
      .filter((s) => s.scheduledBy === "pipeline")
      .map((s) => ({ title: s.title, enabled: s.enabled, cadence: s.cadence, lastRun: s.lastRun })),
  });
}

function healthOf(data: PipelineDoc, history: Run[], items: AttentionItem[]): Health {
  if (data.activity?.running) return "running";
  if (!data.schedule.enabled) return "off";
  const last = history[0];
  if (!last) return "new";
  const tone = runTone(last);
  if (tone === "fail") return "failing";
  if (tone === "warn" || items.some((i) => i.tone !== "info")) return "attention";
  return "healthy";
}

function AttentionPanel({ items, lastRun, running }: { items: AttentionItem[]; lastRun: Run | null; running: boolean }) {
  if (!items.length) {
    if (!lastRun || running) return null;
    return (
      <div className="bg-ok-bg text-ok flex items-center gap-2.5 rounded-2xl px-4 py-3 text-[13.5px]">
        <CheckCircle2 className="size-4.5 shrink-0" strokeWidth={1.8} />
        Nothing needs you. The last run finished every step it was due to run.
      </div>
    );
  }
  return (
    <section aria-label="Needs your attention" className="flex flex-col gap-2">
      <h2 className="text-[15px] font-medium">Needs your attention</h2>
      {items.map((it) => {
        const Icon = it.tone === "fail" ? XCircle : it.tone === "warn" ? AlertTriangle : Info;
        return (
          <div
            key={it.title}
            className={cn(
              "flex flex-wrap items-start gap-3 rounded-2xl border px-4 py-3",
              it.tone === "fail"
                ? "border-destructive/25 bg-destructive/5"
                : it.tone === "warn"
                  ? "border-warn/25 bg-warn/5"
                  : "border-line-soft bg-card",
            )}
          >
            <Icon
              className={cn(
                "mt-0.5 size-4.5 shrink-0",
                it.tone === "fail" ? "text-destructive" : it.tone === "warn" ? "text-warn" : "text-muted-foreground",
              )}
              strokeWidth={1.8}
            />
            <div className="min-w-0 flex-1 basis-[calc(100%-2.5rem)] sm:basis-0">
              <p className="text-[13.5px] font-medium">{it.title}</p>
              <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-relaxed">{it.detail}</p>
            </div>
            {it.action && (
              <Link
                to={it.action.to}
                className="border-line-soft bg-background hover:bg-accent ml-7 flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12.5px] sm:ml-0"
              >
                {it.action.label}
                <ArrowRight className="size-3.5" />
              </Link>
            )}
          </div>
        );
      })}
    </section>
  );
}

/* ------------------------------------------------------------ the nightly */

function NightlyCard({
  doc,
  name,
  blocks,
  history,
  health,
  onChanged,
}: {
  doc: PipelineDoc;
  name: string;
  blocks: StepInfo[];
  history: Run[];
  health: Health;
  onChanged: () => void;
}) {
  const { schedule } = doc;
  const last = history[0] ?? null;
  const lastSteps = new Map((last?.steps ?? []).map((s) => [s.stageId, s.outcome]));
  const phases = PHASES.map((p) => ({ ...p, steps: blocks.filter((b) => phaseOf(b.kind, b.area) === p.key) })).filter(
    (p) => p.steps.length,
  );
  const skipping = schedule.skipTonight && schedule.skipTonight.day === schedule.nextNightDay;
  const hour = `${String(schedule.hour).padStart(2, "0")}:00`;

  return (
    <article className="border-line-soft bg-card flex min-w-0 flex-col gap-4 rounded-2xl p-4 sm:p-5">
      <header className="flex flex-wrap items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400">
          <Moon className="size-5" strokeWidth={1.6} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[16px] font-medium">{name}</h3>
            <HealthBadge health={health} />
          </div>
          <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">
            Every night it refreshes your data, has specialist sub-agents review your ventures, turns what they find
            into proposals and board cards, and writes your morning brief.
          </p>
        </div>
        <Link
          to="/workflows/editor"
          className="text-muted-foreground hover:text-foreground hover:bg-accent flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]"
        >
          <Settings2 className="size-3.5" /> Edit steps
        </Link>
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Next run">
          {!schedule.enabled ? (
            <span className="text-muted-foreground">Schedule off</span>
          ) : schedule.nextRunAt ? (
            <>
              <span>{relative(schedule.nextRunAt)}</span>
              <span className="text-muted-foreground block text-[12px]">
                {humanWhen(schedule.nextRunAt)}
                {skipping ? " · will be skipped" : ""}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Not scheduled</span>
          )}
        </Fact>
        <Fact label="Last run">
          {last ? (
            <>
              <span className="capitalize">{humanWhen(last.startedAt)}</span>
              <span className="text-muted-foreground block text-[12px]">{relative(last.startedAt)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">never</span>
          )}
        </Fact>
        <Fact label="Result">
          {last ? (
            <span className={cn(runTone(last) === "fail" ? "text-destructive" : runTone(last) === "warn" ? "text-warn" : "")}>
              {runHeadline(last)}
            </span>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label="Took">
          {last ? took(last.ms) : "—"}
          <span className="text-muted-foreground block text-[12px]">
            {schedule.maxMinutes ? `limit ${took(schedule.maxMinutes * 60_000)}` : "no time limit"}
          </span>
        </Fact>
      </dl>

      {/* THE STEP DIAGRAM: four phases left to right, each step's picture with
          a dot for how it did last time. */}
      {phases.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-2 text-[12px]">
            {blocks.length} steps, run in this order{schedule.enabled ? ` every night at ${hour}` : ""}. Dots show how each did last run.
          </p>
          <div className="flex flex-col gap-2 md:flex-row md:items-stretch">
            {phases.map((p, i) => (
              <Fragment key={p.key}>
                {i > 0 && (
                  <ArrowRight className="text-muted-foreground/60 hidden size-4 shrink-0 self-center md:block" aria-hidden />
                )}
                <div className="border-line-soft bg-background/50 min-w-0 flex-1 rounded-xl border px-3 py-2.5">
                  <p className="text-[12.5px] font-medium">
                    <span className="text-muted-foreground mr-1.5 tabular-nums">{i + 1}</span>
                    {p.label}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.steps.map((s) => {
                      const o = lastSteps.get(s.id);
                      return (
                        <span key={s.id} className="relative" title={`${s.title}${o ? ` — ${o === "over-budget" ? "out of time" : o}` : ""}`}>
                          <StepGlyph step={s} size="sm" />
                          <span
                            className={cn(
                              "ring-card absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2",
                              o ? TONE_FILL[outcomeTone(o)] : "bg-muted",
                            )}
                          />
                        </span>
                      );
                    })}
                  </div>
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-muted-foreground mb-1.5 text-[12px]">Last {Math.min(14, history.length)} runs</p>
          <HistoryStrip runs={history} />
        </div>
        <Legend />
      </div>

      <RunActions doc={doc} onDone={onChanged} className="border-line-soft border-t pt-3" />
    </article>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-[11.5px] tracking-wide uppercase">{label}</dt>
      <dd className="mt-0.5 text-[13.5px]">{children}</dd>
    </div>
  );
}

/* -------------------------------------------------------------- the rounds */

/** The older, separate workflow: a once-a-day walk that hands jobs to roles. */
function RoundsCard() {
  const doc = useApi(() => roundsApi.all(), []);
  const d = doc.data;
  const roles = d
    ? d.schedule.roles.map((r) => d.schedule.availableRoles.find((a) => a.role === r)?.title ?? r)
    : [];
  const health: Health = !d ? "new" : d.schedule.enabled ? (d.last ? "healthy" : "new") : "off";
  return (
    <article className="border-line-soft bg-card flex min-w-0 flex-col gap-3 rounded-2xl p-4 sm:p-5">
      <header className="flex items-start gap-3">
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-xl">
          <CalendarClock className="size-5" strokeWidth={1.6} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[16px] font-medium">Venture rounds</h3>
            {d && <HealthBadge health={health} />}
          </div>
          <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">
            Once a day, gives each venture that is due a job for the roles you picked
            {roles.length ? ` (${roles.join(", ")})` : ""}.
          </p>
        </div>
      </header>
      {doc.error && <p className="text-destructive text-[13px]">{doc.error}</p>}
      {d && (
        <dl className="grid grid-cols-2 gap-3">
          <Fact label="Next run">
            {d.schedule.enabled && d.schedule.nextRunAt ? (
              <>
                {relative(d.schedule.nextRunAt)}
                <span className="text-muted-foreground block text-[12px]">{humanWhen(d.schedule.nextRunAt)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Switched off</span>
            )}
          </Fact>
          <Fact label="Last run">
            {d.last ? (
              <>
                <span className="capitalize">{humanWhen(d.last.startedAt)}</span>
                <span className="text-muted-foreground block text-[12px]">
                  {d.last.dispatched} job{d.last.dispatched === 1 ? "" : "s"} started, {d.last.skipped} ventures not due
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">never</span>
            )}
          </Fact>
        </dl>
      )}
      <p className="text-muted-foreground text-[12px]">
        While the nightly workflow has specialist steps switched on, rounds stand down on their own so work is never done twice.
      </p>
      <Link
        to="/workflows/rounds"
        className="text-muted-foreground hover:text-foreground mt-auto flex items-center gap-1 text-[12.5px]"
      >
        Open venture rounds <ChevronRight className="size-3.5" />
      </Link>
    </article>
  );
}
