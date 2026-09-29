import { useEffect, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  ChevronDown,
  Circle,
  Database,
  ExternalLink,
  LayoutList,
  Loader2,
  Mail,
  MinusCircle,
  Newspaper,
  Search,
  ShieldCheck,
  Sparkles,
  TimerOff,
  Users,
  XCircle,
} from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { RoleIcon } from "@/components/org/RoleIcon";
import { VentureMark } from "@/components/VentureChrome";
import { useApi } from "@/hooks/useApi";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { runPage } from "../../../../shared/runRoutes";
import { pipelineApi, type Run, type RunDoc, type StageResult } from "./api";
import { KIND_OUTPUT, stepInfoFrom, type StepInfo } from "./steps";

export type { StepInfo } from "./steps";
import {
  KIND_PLAIN,
  OUTCOME_WORD,
  PHASES,
  TONE_FILL,
  TONE_TEXT,
  humaniseText,
  humanWhen,
  outcomeTone,
  phaseOf,
  runHeadline,
  runTone,
  took,
  triggerWord,
  type Phase,
  type StepOutcome,
  type Tone,
} from "./explain";

/**
 * THE SHARED PIECES OF THE WORKFLOWS PAGE: what a step looks like, what a run
 * looks like, and the strip of coloured squares that is a run's history.
 * Overview and Runs draw the same run with the same component, so a step
 * never reads one way on one tab and another way on the next.
 */

/* ------------------------------------------------------------- step identity */


const KIND_ICON: Record<string, ComponentType<{ className?: string; strokeWidth?: number }>> = {
  collect: Database,
  alerts: ShieldCheck,
  triage: Mail,
  synthesis: Sparkles,
  board: LayoutList,
  "seo-ops": Search,
  relationships: Users,
  memory: Brain,
  briefing: Newspaper,
};

/** The picture for a step: the sub-agent's own artwork, or an icon for the kind. */
export function StepGlyph({ step, size = "md" }: { step: StepInfo; size?: "sm" | "md" }) {
  const box = size === "sm" ? "size-6 rounded-md" : "size-9 rounded-xl";
  if (step.role) return <RoleIcon role={step.role} className={size === "sm" ? "size-6" : "size-9"} />;
  const Icon = (step.kind && KIND_ICON[step.kind]) || Sparkles;
  return (
    <span className={cn("bg-muted text-muted-foreground flex shrink-0 items-center justify-center", box)}>
      <Icon className={size === "sm" ? "size-3.5" : "size-4.5"} strokeWidth={1.6} />
    </span>
  );
}

/* ------------------------------------------------------------ status marks */

export function ToneIcon({ tone, className }: { tone: Tone | "pending"; className?: string }) {
  const c = cn("size-4 shrink-0", className);
  if (tone === "ok") return <CheckCircle2 className={cn(c, "text-ok")} strokeWidth={1.8} aria-label="done" />;
  if (tone === "fail") return <XCircle className={cn(c, "text-destructive")} strokeWidth={1.8} aria-label="failed" />;
  if (tone === "warn") return <TimerOff className={cn(c, "text-warn")} strokeWidth={1.8} aria-label="out of time" />;
  if (tone === "skip") return <MinusCircle className={cn(c, "text-muted-foreground")} strokeWidth={1.8} aria-label="not needed" />;
  if (tone === "running") return <Loader2 className={cn(c, "animate-spin text-blue-400")} strokeWidth={1.8} aria-label="running" />;
  return <Circle className={cn(c, "text-muted-foreground/50")} strokeWidth={1.8} aria-label="waiting" />;
}

const BADGE: Record<string, { label: string; cls: string }> = {
  healthy: { label: "Healthy", cls: "bg-ok-bg text-ok" },
  attention: { label: "Needs attention", cls: "bg-warn/15 text-warn" },
  failing: { label: "Failing", cls: "bg-destructive/10 text-destructive" },
  running: { label: "Running now", cls: "bg-blue-500/10 text-blue-400" },
  off: { label: "Off", cls: "bg-muted text-muted-foreground" },
  new: { label: "Not run yet", cls: "bg-muted text-muted-foreground" },
};

export type Health = keyof typeof BADGE;

export function HealthBadge({ health, className }: { health: Health; className?: string }) {
  const b = BADGE[health]!;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium", b.cls, className)}>
      {health === "running" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
      {b.label}
    </span>
  );
}

/* ---------------------------------------------------------- history strip */

/**
 * ONE SQUARE PER RUN, oldest on the left, so "the last week went red" is a
 * shape rather than a sentence. Each square links to that run.
 */
export function HistoryStrip({ runs, max = 14, className }: { runs: Run[]; max?: number; className?: string }) {
  const shown = runs.slice(0, max).reverse();
  if (!shown.length) return <p className="text-muted-foreground text-[12.5px]">No runs yet.</p>;
  return (
    <div className={cn("flex items-end gap-1", className)} aria-label="Run history, oldest first">
      {shown.map((r) => {
        const tone = runTone(r);
        return (
          <Link
            key={r.id}
            to={`/workflows/runs?run=${encodeURIComponent(r.id)}`}
            title={`${humanWhen(r.startedAt)} — ${runHeadline(r)}`}
            aria-label={`${humanWhen(r.startedAt)}: ${runHeadline(r)}`}
            className={cn("h-5 w-3.5 rounded-[3px] transition-transform hover:scale-y-110", TONE_FILL[tone])}
          />
        );
      })}
    </div>
  );
}

export function Legend({ className }: { className?: string }) {
  const items: [Tone, string][] = [
    ["ok", "Done"],
    ["fail", "Failed"],
    ["warn", "Out of time"],
    ["skip", "Not needed"],
  ];
  return (
    <div className={cn("text-muted-foreground flex flex-wrap items-center gap-3 text-[12px]", className)}>
      {items.map(([t, l]) => (
        <span key={t} className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-[2px]", TONE_FILL[t])} />
          {l}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ one run, open */

type Row = { info: StepInfo; result: StageResult | null; tone: Tone | "pending" };

/**
 * A RUN, STEP BY STEP, grouped into the four phases, each step with its status
 * icon, what it did in a sentence, how long it took and a link to what it made.
 * The server's own words sit in "Technical details", closed.
 */
export function RunTimeline({
  id,
  lookup,
  maxMinutesOf,
}: {
  id: string;
  lookup: (id: string) => StepInfo | undefined;
  maxMinutesOf?: (id: string) => number | null;
}) {
  const doc = useApi(() => pipelineApi.one(id), [id]);
  const reload = doc.reload;
  const finished = !!doc.data?.run.finishedAt;
  useEffect(() => {
    if (finished) return;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [reload, finished]);

  if (doc.error) return <p className="text-destructive text-[13.5px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[13.5px]">Reading the run…</p>;
  const data = doc.data;
  const info = stepInfoFrom(data, lookup);
  const results = new Map(data.stages.map((s) => [s.stageId, s]));
  const order = data.workflowSnapshot?.map((b) => b.id) ?? [];
  for (const s of data.stages) if (!order.includes(s.stageId)) order.push(s.stageId);
  const running = !data.run.finishedAt;
  const rows: Row[] = order.map((sid) => {
    const r = results.get(sid) ?? null;
    const tone: Tone | "pending" = r
      ? outcomeTone(r.outcome)
      : running && data.run.currentStage === sid
        ? "running"
        : "pending";
    return { info: info(sid), result: r, tone };
  });
  const slowest = Math.max(1, ...data.stages.map((s) => s.ms ?? 0));
  const phases = PHASES.map((p) => ({ ...p, rows: rows.filter((r) => phaseOf(r.info.kind, r.info.area) === p.key) })).filter(
    (p) => p.rows.length,
  );

  return (
    <div className="flex flex-col gap-4">
      {data.run.note && (
        <p className="bg-warn/10 text-warn rounded-xl px-3 py-2 text-[13px]">{humaniseText(data.run.note)}</p>
      )}
      {phases.map((p, pi) => (
        <PhaseBlock key={p.key} phase={p.key} label={p.label} about={p.about} index={pi + 1} rows={p.rows}>
          {p.rows.map((row) => (
            <StepRow
              key={row.info.id}
              row={row}
              slowest={slowest}
              jobs={data.jobs.filter((j) => j.block_id === row.info.id)}
              limit={maxMinutesOf?.(row.info.id) ?? null}
              finishedRun={!running}
            />
          ))}
        </PhaseBlock>
      ))}
      {!phases.length && <p className="text-muted-foreground text-[13.5px]">This run recorded no steps.</p>}
      {data.run.summary && (
        <details className="border-line-soft rounded-xl border px-3 py-2">
          <summary className="text-muted-foreground cursor-pointer text-[12.5px]">The summary sent to chat</summary>
          <div className="mt-2 text-[13px]">
            <Markdown text={humaniseText(data.run.summary)} />
          </div>
        </details>
      )}
    </div>
  );
}

function PhaseBlock({
  label,
  about,
  index,
  rows,
  children,
}: {
  phase: Phase;
  label: string;
  about: string;
  index: number;
  rows: Row[];
  children: React.ReactNode;
}) {
  const done = rows.filter((r) => r.tone === "ok" || r.tone === "skip").length;
  const bad = rows.filter((r) => r.tone === "fail").length;
  const late = rows.filter((r) => r.tone === "warn").length;
  return (
    <section>
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="bg-muted text-muted-foreground flex size-5 items-center justify-center rounded-full text-[11px] font-medium">
          {index}
        </span>
        <h3 className="text-[14px] font-medium">{label}</h3>
        <span className="text-muted-foreground text-[12.5px]">{about}</span>
        <span className="text-muted-foreground ml-auto text-[12px]">
          {done}/{rows.length} fine{bad ? ` · ${bad} failed` : ""}
          {late ? ` · ${late} out of time` : ""}
        </span>
      </div>
      <ol className="border-line-soft ml-2.5 flex flex-col border-l pl-4">{children}</ol>
    </section>
  );
}

function StepRow({
  row,
  slowest,
  jobs,
  limit,
  finishedRun,
}: {
  row: Row;
  slowest: number;
  jobs: RunDoc["jobs"];
  limit: number | null;
  finishedRun: boolean;
}) {
  const { info, result, tone } = row;
  const { state } = useStore();
  const [open, setOpen] = useState(false);
  const said = result
    ? humaniseText(
        result.outcome === "failed"
          ? (result.error ?? result.note ?? "It failed without saying why.")
          : result.outcome === "over-budget"
            ? `Didn't start: ${result.reason ?? "the night had no time left."}`
            : result.outcome === "skipped"
              ? (result.reason ?? result.note ?? "Nothing was due.")
              : (result.note ?? "Finished."),
      )
    : tone === "running"
      ? "Working on it now…"
      : finishedRun
        ? "Never reached — the run stopped before this step."
        : "Waiting for the steps before it.";
  const out = info.kind ? KIND_OUTPUT[info.kind] : undefined;
  const ms = result?.ms ?? null;
  const word = result ? OUTCOME_WORD[result.outcome as StepOutcome] ?? result.outcome : tone === "running" ? "Running" : "Waiting";

  return (
    <li className="relative py-2">
      <span className="bg-background absolute top-2.5 -left-[25px] rounded-full">
        <ToneIcon tone={tone} />
      </span>
      <div className="flex items-start gap-3">
        <StepGlyph step={info} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13.5px] font-medium">{info.title}</span>
            <span className={cn("text-[12px] font-medium", TONE_TEXT[tone === "pending" ? "none" : tone])}>{word}</span>
            <span className="text-muted-foreground ml-auto flex items-center gap-2 text-[12px] tabular-nums">
              {result && result.ms !== null && result.ms > 0 && (
                <span className="bg-muted hidden h-1.5 w-20 overflow-hidden rounded-full sm:block" aria-hidden>
                  <span
                    className={cn("block h-full rounded-full", TONE_FILL[tone === "pending" ? "none" : tone])}
                    style={{ width: `${Math.max(4, Math.round(((ms ?? 0) / slowest) * 100))}%` }}
                  />
                </span>
              )}
              {result && (result.ms ?? 0) > 0 ? took(result.ms) : ""}
            </span>
          </div>
          <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-relaxed break-words">{said}</p>
          {(jobs.length > 0 || (out && result?.outcome === "completed")) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {jobs.map((j) => {
                const v = state.ventures.find((x) => x.id === j.venture_id);
                return (
                  <Link
                    key={j.agent_run_id}
                    to={runPage(j.kind, j.agent_run_id)}
                    className="border-line-soft hover:bg-accent flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px]"
                  >
                    {v && <VentureMark venture={v} size={14} />}
                    <span>{j.venture_name ?? j.venture_id ?? "Report"}</span>
                    <span className={cn("text-[11.5px]", jobTone(j.status))}>{jobWord(j.status)}</span>
                    <ArrowRight className="text-muted-foreground size-3" />
                  </Link>
                );
              })}
              {out && result?.outcome === "completed" && (
                <Link
                  to={out.to}
                  className="border-line-soft hover:bg-accent text-muted-foreground flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px]"
                >
                  {out.label}
                  <ExternalLink className="size-3" />
                </Link>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1 text-[11.5px]"
          >
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
            Technical details
          </button>
          {open && (
            <dl className="bg-muted/40 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-lg px-3 py-2 text-[11.5px]">
              <dt className="text-muted-foreground">What it does</dt>
              <dd>{(info.kind && KIND_PLAIN[info.kind]) || "—"}</dd>
              <dt className="text-muted-foreground">Step id</dt>
              <dd className="font-mono">{info.id}</dd>
              {info.kind && (
                <>
                  <dt className="text-muted-foreground">Kind</dt>
                  <dd className="font-mono">{info.kind}</dd>
                </>
              )}
              {result && (
                <>
                  <dt className="text-muted-foreground">Started</dt>
                  <dd>{humanWhen(result.startedAt)}</dd>
                  <dt className="text-muted-foreground">Finished</dt>
                  <dd>{result.finishedAt ? humanWhen(result.finishedAt) : "—"}</dd>
                  <dt className="text-muted-foreground">Took</dt>
                  <dd>
                    {took(result.ms)}
                    {limit ? ` of ${limit} min allowed` : ""}
                  </dd>
                  <dt className="text-muted-foreground">Outcome</dt>
                  <dd className="font-mono">{result.outcome}</dd>
                  {result.note && (
                    <>
                      <dt className="text-muted-foreground">Note</dt>
                      <dd className="break-words">{humaniseText(result.note)}</dd>
                    </>
                  )}
                  {result.reason && (
                    <>
                      <dt className="text-muted-foreground">Reason</dt>
                      <dd className="break-words">{humaniseText(result.reason)}</dd>
                    </>
                  )}
                  {result.error && (
                    <>
                      <dt className="text-muted-foreground">Error</dt>
                      <dd className="text-destructive break-words whitespace-pre-wrap">{result.error}</dd>
                    </>
                  )}
                  {Object.keys(result.counts).length > 0 && (
                    <>
                      <dt className="text-muted-foreground">Counts</dt>
                      <dd>
                        {Object.entries(result.counts)
                          .map(([k, v]) => `${v} ${k}`)
                          .join(" · ")}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">Cost</dt>
                  <dd>{result.usd === null ? "not priced on this box" : `$${result.usd.toFixed(4)}`}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      </div>
    </li>
  );
}

function jobWord(status: string | null): string {
  if (status === "done") return "report ready";
  if (status === "running") return "writing…";
  if (status === "queued") return "waiting in queue";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  return "record gone";
}
function jobTone(status: string | null): string {
  if (status === "done") return "text-ok";
  if (status === "failed") return "text-destructive";
  if (status === "cancelled") return "text-warn";
  return "text-muted-foreground";
}

/* ------------------------------------------------------------ the run line */

export function RunLine({ run, open, onToggle }: { run: Run; open: boolean; onToggle: () => void }) {
  const tone = runTone(run);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="hover:bg-accent/40 flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left text-[13.5px]"
    >
      <ToneIcon tone={tone} />
      <span className="w-36 shrink-0 font-medium capitalize">{humanWhen(run.startedAt)}</span>
      <span className="text-muted-foreground w-32 shrink-0 text-[12.5px]">{triggerWord(run)}</span>
      <span className={cn("min-w-0 flex-1 truncate", tone === "ok" ? "" : TONE_TEXT[tone])}>{runHeadline(run)}</span>
      {run.steps && run.steps.length > 0 && (
        <span className="hidden items-center gap-0.5 md:flex" aria-hidden>
          {run.steps.map((s, i) => (
            <span key={`${s.stageId}-${i}`} className={cn("h-3 w-1.5 rounded-[1.5px]", TONE_FILL[outcomeTone(s.outcome)])} />
          ))}
        </span>
      )}
      <span className="text-muted-foreground w-16 shrink-0 text-right text-[12.5px] whitespace-nowrap tabular-nums">
        {run.finishedAt ? ((run.ms ?? 0) < 1000 && run.ms !== null ? "<1s" : took(run.ms)) : "running"}
      </span>
      <ChevronDown className={cn("text-muted-foreground size-4 shrink-0 transition-transform", open && "rotate-180")} />
    </button>
  );
}
