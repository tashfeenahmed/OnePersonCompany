import { useEffect, useState } from "react";
import { WorkflowEditor } from "./WorkflowEditor";
import { runPage } from "../../../../shared/runRoutes";
import { Link } from "react-router-dom";
import { CalendarOff, ChevronRight, Loader2, Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/Markdown";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { ago, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  pipelineApi,
  synthesisApi,
  type Outcome,
  type PipelineDoc,
  type Run,
  type Stage,
  type StageResult,
  type SynthesisDoc,
} from "./api";

/**
 * ONE SCHEDULE, ONE NIGHT'S RESULT, AND THE PROPOSALS THAT CAME OUT OF IT.
 *
 * THE STAGE LIST IS THE PAGE. Everything else on this tab is a consequence of
 * it. It is indented by dependency depth, because "the briefing runs after the
 * rounds and the synthesis" is a fact about the schedule that a flat list
 * cannot show and that the owner needs in order to understand why a stage was
 * skipped.
 *
 * THE TWO KINDS OF STAGE ARE DRAWN DIFFERENTLY AND LABELLED. A stage the
 * pipeline starts carries a switch that works. A self-scheduled one carries the
 * word "own timer" and NO switch, because a switch that did not stop the work
 * would be the worst control on this dashboard. Its last-run reading has its
 * own sentence in the tooltip, since it is the newest row that area wrote and
 * not a log of its timer.
 *
 * `skipped` IS NOT DRAWN AS A PROBLEM. A stage inside its cadence, or inside a
 * blackout the owner set, is the schedule working. Only `failed` and
 * `over-budget` are coloured, and they are coloured differently from each
 * other, because one is a fault and the other is a budget.
 *
 * BOTH BUTTONS SAY WHAT THEY COST, beside themselves rather than in a tooltip.
 * "Plan tonight" spends nothing and is offered first for that reason.
 */
export function PipelineTab() {
  const doc = useApi(() => pipelineApi.all(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [latestOpen, setLatestOpen] = useState(false);
  const reload = doc.reload;
  useEffect(() => { const t=setInterval(() => { if(document.visibilityState === "visible") reload(); },5000); return () => clearInterval(t); },[reload]);

  if (doc.error) return <p className="text-destructive text-[14.5px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14.5px]">Reading the schedule…</p>;

  const { schedule, stages, runs, last, cycle, unknownDeps } = doc.data;

  const go = (label: string, fn: () => Promise<string | null>) => {
    setBusy(label);
    setFailure(null);
    setSaid(null);
    fn()
      .then((s) => setSaid(s))
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(null);
        doc.reload();
      });
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-[13.5px]">
        Your nightly review, built from editable blocks. Reports and the overnight result appear in the{" "}
        <Link className="underline" to={`/chat/${schedule.session}`}>
          Pipeline
        </Link>{" "}
        conversation.
      </p>

      <details className="rounded-2xl border border-line-soft bg-card">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"><span>{schedule.enabled ? `Every night at ${String(schedule.hour).padStart(2,"0")}:00 · ${schedule.timezone}` : "Nightly schedule is off"}</span><span className="text-xs text-muted-foreground">Edit schedule</span></summary>
      <ScheduleForm
        key={`${schedule.enabled}:${schedule.hour}:${schedule.timezone}:${schedule.zoneWasSet}:${schedule.maxMinutes}:${schedule.maxUsd}:${schedule.blackouts.map((b) => b.raw).join("|")}`}
        schedule={schedule}
        onSaved={() => doc.reload()}
      />
      </details>

      {doc.data.activity?.running && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-blue-400/30 bg-blue-500/5 p-4 text-sm"><Loader2 className="size-4 animate-spin" /><span className="flex-1">Workflow running</span><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => go("stop", async () => { await pipelineApi.stop(); return "Stop requested. Finishing cancellation of the active block."; })}>Stop run</Button><div className="w-full"><RunDetail id={doc.data.activity.runId!} /></div></div>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || doc.data.activity?.running || !doc.data.workflowSaved}
          onClick={() =>
            go("plan", async () => {
              /* The rehearsal is its OWN call to its own route. There is no
                 flag on this button that could make it run for real. */
              const out = await pipelineApi.plan();
              return out.run ? `Planned: ${out.run.summary.split("\n")[0]}` : (out.why ?? null);
            })
          }
        >
          {busy === "plan" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" strokeWidth={1.6} />}
          Plan tonight
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || doc.data.activity?.running || !doc.data.workflowSaved}
          onClick={() =>
            go("run", async () => {
              if(doc.data!.workflowSaved) { await pipelineApi.start(); return "Workflow started. Follow its progress below."; }
              const out = await pipelineApi.run();
              return out.run
                ? `${out.run.completed} completed, ${out.run.skipped} skipped, ${out.run.failed} failed.`
                : (out.why ?? null);
            })
          }
        >
          {busy === "run" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" strokeWidth={1.6} />}
          {doc.data.workflowSaved ? "Run saved workflow" : "Run the night now"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null}
          onClick={() =>
            go("skip", async () => {
              const out = await pipelineApi.skipTonight(schedule.skipTonight !== null);
              return out.note;
            })
          }
        >
          <CalendarOff className="size-3.5" strokeWidth={1.6} />
          {schedule.skipTonight ? "Un-skip next night" : "Skip next night"}
        </Button>
        <span className="text-muted-foreground text-[12.5px]">
          {doc.data.workflowSaved ? "Preview spends nothing. Runs use your selected model and runtime budgets." : "Save your workflow to preview or run these blocks."}
        </span>
      </div>
      {said && <p className="text-muted-foreground text-[13.5px]">{said}</p>}
      {failure && <p className="text-destructive text-[13.5px]">{failure}</p>}
      <WorkflowEditor onSaved={doc.reload} currentStage={last?.currentStage} />
      {schedule.skipTonight && (
        <p className="text-warn-foreground text-[13.5px]">
          The scheduled night for {schedule.skipTonight.day} will not run.
          {schedule.skipTonight.reason ? ` ${schedule.skipTonight.reason}` : ""} Starting one by hand
          still works.
        </p>
      )}

      {/* ---------------------------------------------------------- the graph */}
      {!doc.data.workflowSaved && <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">Existing schedules and background services</summary>
        <div className="mb-2 flex items-baseline gap-3">
          <h2 className="text-[16px] font-medium">The stages</h2>
          <span className="text-muted-foreground text-[12.5px]">
            {stages.filter((s) => s.scheduledBy === "pipeline").length} run by the pipeline,{" "}
            {stages.filter((s) => s.scheduledBy === "self").length} on their own timers
          </span>
        </div>
        {cycle.length > 0 && (
          <p className="text-destructive mb-2 text-[13.5px]">
            These stages declare a dependency cycle and are skipped every night until it is fixed:{" "}
            {cycle.join(", ")}.
          </p>
        )}
        {unknownDeps.length > 0 && (
          <p className="text-muted-foreground mb-2 text-[12.5px]">
            Dependencies naming stages nothing registered (ignored):{" "}
            {unknownDeps.map((d) => `${d.stage} → ${d.dep}`).join(", ")}.
          </p>
        )}
        <div className="flex flex-col gap-1">
          {stages.map((s) => (
            <StageRow key={s.id} stage={s} busy={busy !== null} onChanged={() => doc.reload()} onRun={go} />
          ))}
        </div>
      </details>}

      {/* --------------------------------------------------------- last night */}
      <div>
        <h2 className="mb-2 text-[16px] font-medium">Latest run</h2>
        {last ? (
          <><RunCard run={last} expanded={latestOpen} onToggle={() => setLatestOpen(value => !value)} />{latestOpen && <RunDetail id={last.id} />}</>
        ) : (
          <p className="text-muted-foreground text-[14.5px]">
            No night has run yet. Plan one above to see what it would do, or switch the schedule on.
          </p>
        )}
      </div>

      {runs.length > 0 && (
        <div>
          <h2 className="mb-2 text-[16px] font-medium">The ledger</h2>
          <div className="flex flex-col gap-1.5">
            {runs.map((r) => (
              <div key={r.id} className="flex flex-col">
                <button
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                  aria-expanded={open === r.id}
                  className="border-line-soft bg-card hover:bg-accent/40 flex flex-wrap items-center gap-3 rounded-[14px] px-4 py-2.5 text-left text-[13.5px]"
                >
                  <ChevronRight
                    className={cn("size-3.5 shrink-0 transition-transform", open === r.id && "rotate-90")}
                    strokeWidth={1.6}
                  />
                  <span className="text-muted-foreground shrink-0">{ago(r.startedAt)}</span>
                  <span className="shrink-0">
                    {r.dry ? "planned" : r.trigger === "schedule" ? "on the schedule" : "by hand"}
                  </span>
                  <span className="text-muted-foreground truncate">
                    {r.completed} completed · {r.skipped} skipped · {r.failed} failed
                    {r.overBudget ? ` · ${r.overBudget} over budget` : ""}
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0">
                    {r.usd === null ? "cost not priced" : `$${r.usd.toFixed(4)}`}
                  </span>
                </button>
                {open === r.id && <RunDetail id={r.id} />}
              </div>
            ))}
          </div>
        </div>
      )}

      <Proposals />
    </div>
  );
}

/* ------------------------------------------------------------------ a stage */

const OUTCOME_STYLE: Record<Outcome, string> = {
  completed: "text-ok-foreground",
  /* NOT a warning colour. A stage inside its cadence, or one that keeps its own
     timer, is the schedule working — colouring it would teach the owner to
     ignore the colours that matter. */
  skipped: "text-muted-foreground",
  failed: "text-destructive",
  "over-budget": "text-warn-foreground",
};

function StageRow({
  stage,
  busy,
  onChanged,
  onRun,
}: {
  stage: Stage;
  busy: boolean;
  onChanged: () => void;
  onRun: (label: string, fn: () => Promise<string | null>) => void;
}) {
  const self = stage.scheduledBy === "self";
  return (
    <div
      className="border-line-soft bg-card flex flex-wrap items-center gap-3 rounded-[14px] px-4 py-2.5 text-[13.5px]"
      style={{ marginLeft: `${Math.min(stage.depth, 4) * 18}px` }}
    >
      <span className="font-medium">{stage.title}</span>
      <span className="text-muted-foreground shrink-0 text-[12.5px]">{stage.area}</span>
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-[12px]",
          self ? "bg-accent text-muted-foreground" : "bg-ok/15 text-ok-foreground",
        )}
        title={
          self
            ? "This work keeps its own timer in its own area. The pipeline lists it and never starts it, so switching it off here would change nothing — its own settings do."
            : "The nightly walk starts this and nothing else does."
        }
      >
        {self ? "own timer" : "pipeline"}
      </span>
      <span className="text-muted-foreground shrink-0 text-[12.5px]">{stage.cadence}</span>
      {stage.deps.length > 0 && (
        <span className="text-muted-foreground shrink-0 text-[12.5px]">after {stage.deps.join(", ")}</span>
      )}
      <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px]" title={stage.lastRunMeans}>
        {stage.lastRun ? ago(stage.lastRun) : "never"}
      </span>
      {!self && (
        <>
          <label className="flex shrink-0 items-center gap-1.5">
            <input
              type="checkbox"
              checked={stage.enabled}
              disabled={busy}
              onChange={(e) => {
                onRun(`setting:${stage.id}`, async () => { await pipelineApi.setStage(stage.id, { enabled: e.target.checked }); onChanged(); return null; });
              }}
            />
            <span className="text-muted-foreground text-[12.5px]">on</span>
          </label>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              onRun(`stage:${stage.id}`, async () => {
                const out = await pipelineApi.run({ stage: stage.id });
                const r = out.stages[0];
                return r ? `${stage.id}: ${r.outcome} — ${r.note ?? r.reason ?? r.error ?? ""}` : (out.why ?? null);
              })
            }
          >
            Run
          </Button>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- a night */

function RunCard({ run, expanded, onToggle }: { run: Run; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="border-line-soft bg-card rounded-[14px] px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-3 text-[13.5px]">
        <span className="font-medium">
          {run.dry ? "Planned" : run.trigger === "schedule" ? "On the schedule" : "By hand"}
        </span>
        <span className="text-muted-foreground">{ago(run.startedAt)}</span>
        <span className="text-muted-foreground">
          {run.completed} completed · {run.skipped} skipped · {run.failed} failed
        </span>
        <span className="text-muted-foreground ml-auto">
          {run.usd === null ? "cost not priced on this box" : `$${run.usd.toFixed(4)}`}
        </span>
      </div>
      {/* The summary is MARKDOWN — it is written once and read in three places
          (this card, the chat transcript, the phone), so it is drawn with the
          same renderer every other prose on this dashboard uses rather than
          shown raw with its asterisks in it. */}
      <div className="mt-2 text-[13.5px]">
        <Markdown text={run.summary} />
      </div>
      {run.note && <p className="text-warn-foreground mt-2 text-[13px]">{run.note}</p>}
      <button onClick={onToggle} aria-expanded={expanded} className="text-muted-foreground mt-1 text-[12.5px] underline">
        {expanded ? "Hide stages" : "Show stages"}
      </button>
    </div>
  );
}

function RunDetail({ id }: { id: string }) {
  const doc = useApi(() => pipelineApi.one(id), [id]);
  useEffect(() => { if(doc.data?.run.finishedAt) return; const t=setInterval(doc.reload,3000); return () => clearInterval(t); },[doc.reload,doc.data?.run.finishedAt]);
  if (doc.error) return <p className="text-destructive px-3 py-2 text-[13.5px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground px-3 py-2 text-[13.5px]">Reading…</p>;
  return (
    <div className="border-line-soft mt-1 ml-6 flex flex-col gap-1 border-l pl-3">
      {doc.data.run.currentStage && <p className="text-blue-400 text-sm">Running: {doc.data.workflowSnapshot?.find(b => b.id === doc.data!.run.currentStage)?.title ?? doc.data.run.currentStage}</p>}
      {doc.data.run.note && <p className="text-warn-foreground text-sm">{doc.data.run.note}</p>}
      {doc.data.stages.map((s: StageResult, i: number) => (
        <div key={`${s.stageId}-${i}`} className="flex flex-wrap items-baseline gap-2 text-[13px]">
          <span className="w-44 shrink-0 font-medium">{doc.data!.workflowSnapshot?.find(b => b.id===s.stageId)?.title ?? s.stageId}</span>
          <span className={cn("w-24 shrink-0", OUTCOME_STYLE[s.outcome])}>{s.outcome}</span>
          <span className="text-muted-foreground">{s.error ?? s.reason ?? s.note ?? ""}</span>
          {s.ms !== null && s.ms > 0 && (
            <span className="text-muted-foreground ml-auto shrink-0">{Math.round(s.ms / 100) / 10}s</span>
          )}
        </div>
      ))}
      {doc.data.jobs?.length > 0 && <div className="mt-3 space-y-1 border-t border-line-soft pt-3"><p className="mb-2 text-xs text-muted-foreground">Sub-agent reports</p>{doc.data.jobs.map(job => <Link className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-muted" key={job.agent_run_id} to={runPage(job.kind,job.agent_run_id)}><span>{job.venture_name ?? job.venture_id} · {doc.data!.workflowSnapshot?.find(b => b.id===job.block_id)?.title ?? job.block_id}</span><span className="text-xs text-muted-foreground">{job.status ?? "record unavailable"} →</span></Link>)}</div>}
    </div>
  );
}

/* ------------------------------------------------------------- the settings */

function ScheduleForm({ schedule, onSaved }: { schedule: PipelineDoc["schedule"]; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({
    enabled: schedule.enabled ? "on" : "",
    hour: String(schedule.hour),
    /* EMPTY WHEN THE OWNER NEVER CHOSE ONE. `timezone` is now always a real
       zone, so filling the box with it would turn "this machine's, whatever it
       is" into "Europe/Dublin, chosen" the next time Save is pressed. */
    timezone: schedule.zoneWasSet ? schedule.timezone : "",
    blackouts: schedule.blackouts.map((b) => b.raw).join("\n"),
    "max-minutes": schedule.maxMinutes === null ? "0" : String(schedule.maxMinutes),
    "max-usd": schedule.maxUsd === null ? "" : String(schedule.maxUsd),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* WHETHER THE SAVE RECONNECTED THE PLUGIN. The write goes through the same
     door as every other plugin's settings and that door answers with the
     plugin's connection state, so a save that left it unconfigured says so
     instead of looking like it worked. */
  const [connected, setConnected] = useState<boolean | null>(null);

  const set = (k: string, v: string) => setValues((old) => ({ ...old, [k]: v }));

  return (
    <fieldset disabled={saving} className="min-w-0 border-line-soft bg-card flex flex-col gap-3 rounded-[14px] px-4 py-3.5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            checked={values.enabled === "on"}
            onChange={(e) => set("enabled", e.target.checked ? "on" : "")}
          />
          Run a nightly pipeline
        </label>
        <Field label="Hour" width="w-20">
          <Input value={values.hour} onChange={(e) => set("hour", e.target.value)} />
        </Field>
        <Field
          label={schedule.zoneWasSet ? "Time zone" : `Time zone (this machine's — ${schedule.timezone})`}
          width="w-52"
        >
          <Input
            value={values.timezone}
            placeholder={schedule.timezone}
            onChange={(e) => set("timezone", e.target.value)}
          />
        </Field>
        <Field label="Minutes a night may take (0 = no cap)" width="w-28">
          <Input value={values["max-minutes"]} onChange={(e) => set("max-minutes", e.target.value)} />
        </Field>
        <Field label="Dollars a night may spend (blank = no cap)" width="w-28">
          <Input value={values["max-usd"]} onChange={(e) => set("max-usd", e.target.value)} />
        </Field>
      </div>
      <Field label="Blackout windows — one per line, HH:MM-HH:MM [stages=a,b] [days=0..6]" width="w-full">
        <textarea
          value={values.blackouts}
          rows={2}
          onChange={(e) => set("blackouts", e.target.value)}
          className="border-line-soft bg-background w-full rounded-md border px-2 py-1.5 text-[13.5px]"
          placeholder="22:00-23:30"
        />
      </Field>
      {schedule.blackoutErrors.length > 0 && (
        <p className="text-destructive text-[12.5px]">{schedule.blackoutErrors.join(" ")}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setError(null);
            pipelineApi
              .save("pipeline", values)
              .then((r) => {
                setConnected(r.connected);
                onSaved();
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
              .finally(() => setSaving(false));
          }}
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Save the schedule
        </Button>
        <span className="text-muted-foreground text-[12.5px]">
          {schedule.catchUpDay
            ? `The missed night of ${schedule.catchUpDay} is due on the next available scheduler check.`
            : schedule.nextRunAt
            ? `Next night: ${when(schedule.nextRunAt, { year: true })}.`
            : "The schedule is off; nothing will run on its own."}{" "}
          {schedule.notes.cost}
        </span>
      </div>
      {error && <p className="text-destructive text-[13.5px]">{error}</p>}
      {connected === false && (
        <p className="text-warn-foreground text-[13.5px]">
          Saved, but the pipeline plugin still reads as not connected — nothing will run on this
          schedule until it is.
        </p>
      )}
    </fieldset>
  );
}

function Field({ label, width, children }: { label: string; width: string; children: React.ReactNode }) {
  return (
    <label className={cn("flex flex-col gap-1", width)}>
      <span className="text-muted-foreground text-[12.5px]">{label}</span>
      {children}
    </label>
  );
}

/* ------------------------------------------------------------- proposals */

/**
 * THE SYNTHESIS PASS'S OUTPUT, BOTH HALVES.
 *
 * The dropped proposals are shown beside the filed ones, and that is the whole
 * point of the section: a pass that files two out of nine and hides the seven
 * is one the owner cannot calibrate — he cannot tell whether it considered the
 * obvious thing and refused it, or never thought of it.
 */
function Proposals() {
  const doc = useApi(() => synthesisApi.all({ limit: 40 }), []);
  const [showDropped, setShowDropped] = useState(true);

  if (doc.error) return <p className="text-destructive text-[14.5px]">{doc.error}</p>;
  if (!doc.data) return null;
  const { proposals, next, coverage, config, notes } = doc.data;
  const shown = showDropped ? proposals : proposals.filter((p) => p.verdict === "filed");

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline gap-3">
        <h2 className="text-[16px] font-medium">Proposed actions</h2>
        <span className="text-muted-foreground text-[12.5px]">
          Next up: {next.map((n) => n.name).join(", ") || "nothing"}.
        </span>
        <label className="text-muted-foreground ml-auto flex items-center gap-1.5 text-[12.5px]">
          <input type="checkbox" checked={showDropped} onChange={(e) => setShowDropped(e.target.checked)} />
          show what was refused
        </label>
      </div>

      {/* THE FIVE DIALS, ON THE PAGE THAT SHOWS WHAT THEY DO. They are settings
          on the `synthesis` pseudo-plugin and were reachable only by curling
          the config route: that plugin has no entry on the Integrations page,
          because it holds no credential and does not appear in the catalog the
          page draws from. So they live here, beside the proposals they govern,
          which is where somebody changing them is already looking. */}
      <SynthesisForm
        key={`${config.venturesPerNight}:${config.perVenture}:${config.perNight}:${config.repeatDays}:${config.model}`}
        config={config}
        onSaved={() => doc.reload()}
      />
      <p className="text-muted-foreground mb-2 text-[12.5px]">{notes.dropped}</p>
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-[14.5px]">
          Nothing has been proposed yet. The pass runs as a stage of the night, and can be run for one
          venture from that venture's page.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {shown.map((p) => (
            <div
              key={p.id}
              className="border-line-soft bg-card flex flex-col gap-1 rounded-[14px] px-4 py-2.5 text-[13.5px]"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className={cn("shrink-0 text-[12px]", p.verdict === "filed" ? "text-ok-foreground" : "text-muted-foreground")}>
                  {p.verdict}
                </span>
                <span className="font-medium">{p.title}</span>
                <span className="text-muted-foreground shrink-0 text-[12.5px]">{p.venture ?? "unfiled"}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px]">{ago(p.at)}</span>
              </div>
              {p.evidenceLine && (
                <p className="text-muted-foreground text-[12.5px]">
                  {p.evidenceKey}: {p.evidenceLine}
                </p>
              )}
              {p.reason && <p className="text-muted-foreground text-[12.5px]">Refused — {p.reason}</p>}
            </div>
          ))}
        </div>
      )}
      <p className="text-muted-foreground mt-2 text-[12.5px]">
        Coverage: {coverage.filter((c) => c.lastPassAt).length} of {coverage.length} ventures have had a
        pass; {coverage.filter((c) => !c.proposalsOn).length} have proposals switched off.
      </p>
    </div>
  );
}

/**
 * THE SYNTHESIS DIALS.
 *
 * Four values, all of them decisions rather than credentials, all of them about
 * how much of the owner's morning this pass is allowed to fill. They are stored
 * on the `synthesis` pseudo-plugin and validated once on the server, which is
 * why this form does no checking of its own beyond keeping the boxes small —
 * a second validator here would be a second set of rules to keep in step.
 */
function SynthesisForm({
  config,
  onSaved,
}: {
  config: SynthesisDoc["config"];
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({
    "ventures-per-night": String(config.venturesPerNight),
    "per-venture": String(config.perVenture),
    "per-night": String(config.perNight),
    "repeat-days": String(config.repeatDays),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const set = (k: string, v: string) => setValues((old) => ({ ...old, [k]: v }));

  return (
    <fieldset disabled={saving} className="min-w-0 border-line-soft bg-card mb-2 flex flex-wrap items-end gap-3 rounded-[14px] px-4 py-3.5">
      <Field label="Ventures a night" width="w-24">
        <Input value={values["ventures-per-night"]} onChange={(e) => set("ventures-per-night", e.target.value)} />
      </Field>
      <Field label="Most per venture" width="w-24">
        <Input value={values["per-venture"]} onChange={(e) => set("per-venture", e.target.value)} />
      </Field>
      <Field label="Most in one night" width="w-24">
        <Input value={values["per-night"]} onChange={(e) => set("per-night", e.target.value)} />
      </Field>
      <Field label="Days before repeating an idea" width="w-32">
        <Input value={values["repeat-days"]} onChange={(e) => set("repeat-days", e.target.value)} />
      </Field>
      <Button
        size="sm"
        disabled={saving}
        onClick={() => {
          setSaving(true);
          setError(null);
          synthesisApi
            .saveConfig(values)
            .then((r) => {
              setConnected(r.connected);
              onSaved();
            })
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setSaving(false));
        }}
      >
        {saving && <Loader2 className="size-3.5 animate-spin" />}
        Save
      </Button>
      <span className="text-muted-foreground w-full text-[12.5px]">
        Each venture in the rotation costs one model call over its whole evidence packet, so the first
        box is the main dial on what a night spends. Defaults:{" "}
        {config.defaults.venturesPerNight} / {config.defaults.perVenture} / {config.defaults.perNight} /{" "}
        {config.defaults.repeatDays} days. Uses your shared LLM selection from the sidebar.
      </span>
      {error && <p className="text-destructive w-full text-[13.5px]">{error}</p>}
      {connected === false && (
        <p className="text-warn-foreground w-full text-[13.5px]">
          Saved, but the synthesis plugin still reads as not connected — no venture will be read
          until it is.
        </p>
      )}
    </fieldset>
  );
}
