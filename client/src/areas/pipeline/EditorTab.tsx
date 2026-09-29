import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WorkflowEditor } from "./WorkflowEditor";
import { pipelineApi, type PipelineDoc, type Stage } from "./api";
import { SynthesisSettings } from "./ProposalsTab";
import { humanDay, humanWhen, relative } from "./explain";

/**
 * STEPS & SCHEDULE: everything about the nightly workflow you can change.
 *
 * WHEN IT RUNS comes first because it is the one setting most people touch;
 * THE STEPS are the workflow itself, edited as blocks; the proposal dials and
 * the pre-workflow stage list are technical and stay folded away.
 *
 * THE TWO KINDS OF STAGE (in the folded list) ARE DRAWN DIFFERENTLY. A stage
 * the pipeline starts carries a switch that works. A self-scheduled one
 * carries the words "own timer" and NO switch, because a switch that did not
 * stop the work would be the worst control on this dashboard.
 */
export function EditorTab() {
  const doc = useApi(() => pipelineApi.all(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (doc.error) return <p className="text-destructive text-[14.5px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14.5px]">Reading the schedule…</p>;
  const { schedule, stages, last, cycle, unknownDeps } = doc.data;

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
      <section className="border-line-soft bg-card rounded-2xl p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[15px] font-medium">When it runs</h2>
          <span className="text-muted-foreground text-[12.5px]">
            {schedule.enabled
              ? `Every night at ${String(schedule.hour).padStart(2, "0")}:00 (${schedule.timezone})` +
                (schedule.nextRunAt ? ` · next ${humanWhen(schedule.nextRunAt)}, ${relative(schedule.nextRunAt)}` : "") +
                (schedule.maxMinutes ? ` · stops after ${schedule.maxMinutes} minutes` : "")
              : "Switched off — nothing runs on its own."}
          </span>
        </div>
        {schedule.skipTonight && (
          <p className="text-warn mb-3 text-[13px]">
            The scheduled run for {humanDay(schedule.skipTonight.day)} will not run.
            {schedule.skipTonight.reason ? ` ${schedule.skipTonight.reason}` : ""} Starting one by hand still works.
          </p>
        )}
        <ScheduleForm
          key={`${schedule.enabled}:${schedule.hour}:${schedule.timezone}:${schedule.zoneWasSet}:${schedule.maxMinutes}:${schedule.maxUsd}:${schedule.blackouts.map((b) => b.raw).join("|")}`}
          schedule={schedule}
          onSaved={() => doc.reload()}
        />
      </section>

      <section className="border-line-soft bg-card rounded-2xl p-4 sm:p-5">
        <p className="text-muted-foreground mb-3 text-[12.5px]">
          The steps run top to bottom. Click a step to change what it does, switch it off, or give it more time. Reports
          and the overnight summary also appear in the{" "}
          <Link className="underline" to={`/chat/${schedule.session}`}>
            Pipeline
          </Link>{" "}
          conversation.
        </p>
        <WorkflowEditor onSaved={doc.reload} currentStage={last?.currentStage} />
      </section>

      <details className="border-line-soft bg-card group rounded-2xl">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[14px] font-medium sm:px-5">
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          Proposal settings
          <span className="text-muted-foreground text-[12.5px] font-normal">how many ideas the Find-the-next-actions step may file</span>
        </summary>
        <div className="px-4 pb-4 sm:px-5">
          <SynthesisSettings />
        </div>
      </details>

      {!doc.data.workflowSaved && (
        <details className="border-line-soft bg-card group rounded-2xl">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[14px] font-medium sm:px-5">
            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
            Existing schedules and background services
            <span className="text-muted-foreground text-[12.5px] font-normal">
              {stages.filter((s) => s.scheduledBy === "pipeline").length} run by the pipeline,{" "}
              {stages.filter((s) => s.scheduledBy === "self").length} on their own timers
            </span>
          </summary>
          <div className="px-4 pb-4 sm:px-5">
            {cycle.length > 0 && (
              <p className="text-destructive mb-2 text-[13.5px]">
                These stages declare a dependency cycle and are skipped every night until it is fixed: {cycle.join(", ")}.
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
            {said && <p className="text-muted-foreground mt-2 text-[13.5px]">{said}</p>}
            {failure && <p className="text-destructive mt-2 text-[13.5px]">{failure}</p>}
          </div>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ a stage */

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
          self ? "bg-accent text-muted-foreground" : "bg-ok/15 text-ok",
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
    <fieldset disabled={saving} className="flex min-w-0 flex-col gap-3">
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
            ? `The missed run of ${humanDay(schedule.catchUpDay)} is due on the next available scheduler check.`
            : schedule.nextRunAt
            ? `Next run: ${humanWhen(schedule.nextRunAt)}.`
            : "The schedule is off; nothing will run on its own."}{" "}
          Cost is counted only where model prices are set.
        </span>
      </div>
      {error && <p className="text-destructive text-[13.5px]">{error}</p>}
      {connected === false && (
        <p className="text-warn text-[13.5px]">
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

