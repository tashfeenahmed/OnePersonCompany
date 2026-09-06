import { appPage } from "../../../../shared/navigation";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { ago, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { roundsApi, type Job, type Round, type Schedule } from "@/lib/api/chief";

/**
 * THE SCHEDULE, THE LAST WALK, AND THE LEDGER OF EVERYTHING IT DECIDED.
 *
 * THE LEDGER IS THE POINT OF THIS TAB, not the button. A round that dispatched
 * nothing and a round that never ran look identical from the runs page, and the
 * question an owner actually asks in the morning is "why has that venture not
 * been looked at". So every job the walk considered has a row, with the reason it
 * became a run or did not, and `skipped` is drawn as an ordinary outcome rather
 * than in a warning colour — a venture inside its cadence is the schedule
 * working.
 *
 * THE BUTTON SAYS WHAT IT COSTS. It dispatches real runs into the single slot
 * and spends real tokens on the owner's account, so it says so beside itself
 * rather than in a tooltip.
 */
export function RoundsTab() {
  const doc = useApi(() => roundsApi.all(), []);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (doc.error) return <p className="text-destructive text-[13.5px]">{doc.error}</p>;
  if (!doc.data)
    return <p className="text-muted-foreground text-[13.5px]">Reading the schedule…</p>;

  const { schedule, rounds, last, jobs } = doc.data;
  /* WHICH PAGE A DISPATCHED RUN IS READ AT, taken from the server's own role
     table rather than guessed from the role name. A rail that guessed would
     send a `visibility` run to /apps/visibility and a `writer` run to
     /apps/writer, and neither exists. */
  const apps = new Map(schedule.availableRoles.map((r) => [r.role, r.app]));

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-[12.5px]">
        Once a day, this box walks every venture and gives the roles below a job
        on the ones that are due — skipping quiet stages, respecting the
        per-venture cadence, and never spending more than the cap of the single
        run slot. The work lands under the{" "}
        <Link className="underline" to={`/chat/${schedule.session}`}>
          Rounds
        </Link>{" "}
        conversation.
      </p>

      {/* KEYED ON THE SAVED SETTINGS, so a save that the server corrected
          (an hour clamped, a role dropped as unknown) comes back into the boxes
          instead of leaving the owner looking at what they typed. No effect
          syncing props into state — the remount is the sync. */}
      <ScheduleForm
        key={`${schedule.enabled}:${schedule.hour}:${schedule.timezone}:${schedule.roles.join(",")}:${schedule.maxRuns}:${schedule.daysBetween}:${schedule.quietStages.join(",")}`}
        schedule={schedule}
        onSaved={() => doc.reload()}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setFailure(null);
            setSaid(null);
            roundsApi
              .startNow()
              .then((out) =>
                setSaid(
                  out.round
                    ? `Dispatched ${out.round.dispatched}, skipped ${out.round.skipped} of ${out.round.ventures} ventures.`
                    : (out.why ?? null),
                ),
              )
              .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                setBusy(false);
                doc.reload();
              });
          }}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" strokeWidth={1.6} />}
          Walk the estate now
        </Button>
        <span className="text-muted-foreground text-[11.5px]">
          This queues real runs into the one slot and spends tokens.
        </span>
      </div>
      {said && <p className="text-muted-foreground text-[12.5px]">{said}</p>}
      {failure && <p className="text-destructive text-[12.5px]">{failure}</p>}

      {/* --------------------------------------------------------- last walk */}
      <div>
        <h2 className="mb-2 text-[15px] font-medium">The last round</h2>
        {last ? <RoundCard round={last} /> : (
          <p className="text-muted-foreground text-[13.5px]">
            No round has run yet. Switch the schedule on above, or walk it once
            by hand.
          </p>
        )}
      </div>

      {rounds.length > 1 && (
        <div>
          <h2 className="mb-2 text-[15px] font-medium">Before that</h2>
          <div className="flex flex-col gap-1.5">
            {rounds.slice(1, 8).map((r) => (
              <div
                key={r.id}
                className="border-line-soft bg-card flex items-center gap-3 rounded-[10px] border px-3 py-2 text-[12.5px]"
              >
                <span className="text-muted-foreground">{ago(r.startedAt)}</span>
                <span>{r.trigger === "manual" ? "by hand" : "scheduled"}</span>
                <span className="ml-auto tabular-nums">
                  {r.dispatched} dispatched · {r.skipped} skipped
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ----------------------------------------------------------- ledger */}
      <div>
        <h2 className="mb-1 text-[15px] font-medium">Every scheduled job</h2>
        <p className="text-muted-foreground mb-2 text-[11.5px]">
          Including the ones that became nothing. A skip is a decision — a quiet
          stage, a venture inside its cadence, a spent cap or a worker already
          busy — and a refusal is a worker you switched off.
        </p>
        {jobs.length === 0 ? (
          <p className="text-muted-foreground text-[13.5px]">Nothing has been scheduled yet.</p>
        ) : (
          <div className="border-line-soft overflow-x-auto rounded-[10px] border">
            <table className="w-full text-[12.5px]">
              <tbody>
                {jobs.slice(0, 60).map((j) => (
                  <JobRow key={j.id} job={j} apps={apps} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RoundCard({ round }: { round: Round }) {
  return (
    <div className="border-line-soft bg-card rounded-[10px] border p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12.5px]">
        <span className="font-medium">
          {round.dispatched} run{round.dispatched === 1 ? "" : "s"} dispatched
        </span>
        <span className="text-muted-foreground">
          {round.skipped} skipped of {round.ventures} ventures
        </span>
        <span className="text-muted-foreground ml-auto">
          {ago(round.startedAt)} · {round.trigger === "manual" ? "by hand" : "scheduled"}
          {/* An unfinished round is a crash and reads as one. It takes seconds. */}
          {!round.finishedAt && " · still walking"}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {round.notes.map((n) => (
          <div key={n.ventureId} className="flex items-baseline gap-2 text-[12.5px]">
            <span
              className={cn(
                "inline-block size-1.5 shrink-0 rounded-full",
                n.outcome === "dispatched" ? "bg-ok" : "bg-muted-foreground/40",
              )}
            />
            <span className="min-w-0 truncate">{n.venture}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate">
              {n.outcome === "dispatched" ? n.roles.join(", ") : n.reason}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function JobRow({ job, apps }: { job: Job; apps: Map<string, string> }) {
  const tone =
    job.outcome === "dispatched"
      ? "text-foreground"
      : job.outcome === "failed"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <tr className="border-line-soft border-b last:border-0">
      <td className="text-muted-foreground px-3 py-1.5 whitespace-nowrap">{ago(job.ts)}</td>
      <td className="px-3 py-1.5 whitespace-nowrap">{job.ventureId ?? "—"}</td>
      <td className="text-muted-foreground px-3 py-1.5 whitespace-nowrap">{job.role ?? "—"}</td>
      <td className={cn("px-3 py-1.5 whitespace-nowrap", tone)}>{job.outcome}</td>
      <td className="text-muted-foreground px-3 py-1.5">
        {job.runId && job.role && apps.get(job.role) ? (
          <Link className="underline" to={appPage(apps.get(job.role)!, job.runId)}>
            {job.runId}
          </Link>
        ) : (
          job.reason
        )}
      </td>
    </tr>
  );
}

/**
 * THE SCHEDULE, WRITTEN THROUGH THE SETTINGS DOOR.
 *
 * It PUTs to `/api/plugins/rounds/config`, which is where every non-secret
 * setting on this box is written, so the validation the owner gets here is the
 * same validation the Integrations page gets — one registry, one set of
 * refusals. The alternative, a second route on `/api/rounds`, would be a second
 * validator to keep in step.
 */
function ScheduleForm({ schedule, onSaved }: { schedule: Schedule; onSaved: () => void }) {
  const [form, setForm] = useState({
    enabled: schedule.enabled ? "on" : "off",
    hour: String(schedule.hour),
    timezone: schedule.timezone ?? "",
    roles: schedule.roles.join(", "),
    max: String(schedule.maxRuns),
    days: String(schedule.daysBetween),
    quiet: schedule.quietStages.join(", "),
  });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="border-line-soft bg-card rounded-[10px] border p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={form.enabled === "on" ? "default" : "outline"}
          onClick={() => set("enabled", form.enabled === "on" ? "off" : "on")}
        >
          {form.enabled === "on" ? "Rounds are on" : "Rounds are off"}
        </Button>
        <span className="text-muted-foreground text-[11.5px]">
          {schedule.nextRunAt
            ? `Next run ${when(schedule.nextRunAt, { year: true })} (${schedule.timezone ?? schedule.resolvedTimezone})`
            : "Nothing is scheduled while this is off."}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Hour of the round" hint="0–23, in the time zone below.">
          <Input value={form.hour} onChange={(e) => set("hour", e.target.value)} />
        </Field>
        <Field label="Time zone" hint={`Empty means this machine's own — ${schedule.resolvedTimezone}.`}>
          <Input
            value={form.timezone}
            placeholder={schedule.resolvedTimezone}
            onChange={(e) => set("timezone", e.target.value)}
          />
        </Field>
        <Field
          label="Roles each round dispatches"
          hint={`Comma separated. Each one is a whole run per venture worked: ${schedule.availableRoles
            .map((r) => r.role)
            .join(", ")}.`}
        >
          <Input value={form.roles} onChange={(e) => set("roles", e.target.value)} />
        </Field>
        <Field label="Most runs in one round" hint={`The cap on the single slot. Default ${schedule.defaults.maxRuns}.`}>
          <Input value={form.max} onChange={(e) => set("max", e.target.value)} />
        </Field>
        <Field
          label="Days between rounds on one venture"
          hint={`A venture worked by a round is left alone this long. Default ${schedule.defaults.daysBetween}.`}
        >
          <Input value={form.days} onChange={(e) => set("days", e.target.value)} />
        </Field>
        <Field label="Stages a round skips" hint="idea, pre-launch, launched — comma separated.">
          <Input value={form.quiet} onChange={(e) => set("quiet", e.target.value)} />
        </Field>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => {
            setSaving(true);
            setFailure(null);
            roundsApi
              .save(form)
              .then(() => onSaved())
              .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
              .finally(() => setSaving(false));
          }}
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          Save the schedule
        </Button>
        {failure && <span className="text-destructive text-[11.5px]">{failure}</span>}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1">
      <span className="text-[12.5px] font-medium">{label}</span>
      {children}
      <span className="text-muted-foreground text-[11px] leading-snug">{hint}</span>
    </div>
  );
}
