import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleAlert, Loader2, Server, ShieldAlert, Timer } from "lucide-react";
import { ago, when } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/settings/Section";
import { PluginSettingsForm } from "@/components/settings/PluginSettingsForm";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { deployApi, type Check, type Lease, type RefusedRoute, type Retention, type Schedule, type Verdict } from "@/lib/api/deploy";

/**
 * SETTINGS → DEPLOYMENT — the page you open when the dashboard was fine
 * yesterday and is silent today.
 *
 * IT ANSWERS FIVE QUESTIONS AND IN THIS ORDER, because that is the order they
 * are asked in: is this thing supervised at all, is it healthy, how long does
 * it keep what it collects, when is each source next collected, and how
 * boxed-in is the agent. Anything the server
 * would not say is drawn as "unknown" rather than guessed — `running: null` is
 * a supervisor that could not be asked, and printing that as "stopped" would
 * be the page inventing the one fact somebody came here for.
 *
 * THE UNIT FILE IS SHOWN BEFORE THE BUTTON. Installing a service puts a
 * process into the owner's login session that restarts itself; that is a thing
 * to read first. The dry-run button writes the same file into `deploy/out/`
 * and installs nothing.
 *
 * THE ISOLATION BLOCK NEVER SAYS "SECURE". It says which of three measured
 * levels this box is on and what would change by moving up one. `same-user` is
 * the shipped state and is described as what it is — an API boundary that
 * holds and a filesystem one that does not — because a page that congratulated
 * somebody for the default would be worse than no page.
 */

/* A COLLECTOR THAT HAS NEVER RUN IS NOT A DATE NOBODY RECORDED. `when` draws
   an unknown date as the em dash; on this panel the absence is the answer, so
   the word is passed in.

   `ago` NOW SWITCHES TO DAYS AT 24 HOURS, not 48. This copy was the one that
   disagreed with the other six, so the same collected-at stamp read "36h ago"
   here and "2d ago" on the integrations panel. */
const NEVER = { nullText: "never" } as const;

const DOT: Record<Verdict, string> = { ok: "bg-ok", warn: "bg-warn", fail: "bg-destructive" };

function CheckRow({ check }: { check: Check }) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[check.status])} />
      <div className="min-w-0">
        <div className="text-[14px] capitalize">{check.key}</div>
        <div className="text-muted-foreground text-[13.5px]">{check.detail}</div>
      </div>
    </div>
  );
}

/**
 * ONE TABLE'S RETENTION WINDOW.
 *
 * WHERE THE NUMBER CAME FROM IS A COLUMN, not a footnote: "400 days because
 * you set it" and "30 days because the fleet collector decided" are different
 * answers to "can I keep more", and only one of them has a knob.
 */
function RetentionRow({ r }: { r: Retention }) {
  return (
    <tr className="border-line-soft border-t align-top">
      <td className="py-1.5 pr-3 font-mono text-[12.5px]">{r.table}</td>
      <td className="text-muted-foreground py-1.5 pr-3 font-mono text-[12.5px]">
        {r.column}
        {r.grain === "day" && " · day key"}
        {r.where && <span className="block opacity-70">only where {r.where}</span>}
      </td>
      <td className="py-1.5 pr-3 text-[13.5px] tabular-nums whitespace-nowrap">{r.days}d</td>
      <td className="text-muted-foreground py-1.5 text-[12.5px]">
        {r.source === "setting" ? <span className="font-mono">{r.setting ?? "a setting"}</span> : "this area chose it"}
        {r.note && <span className="block opacity-80">{r.note}</span>}
      </td>
    </tr>
  );
}

/**
 * THE ROUTES THE AGENT KEY IS REFUSED ON, WITH THE WALL EACH ONE IS BEHIND.
 *
 * This was one joined line of prefixes, which said that a boundary exists and
 * nothing about it. There are three walls — an owner proof, the owner's own
 * browser, and a signed-in session — and which one guards restoring a backup
 * is exactly the question somebody opens this page with.
 *
 * THE SENTENCE PER LEVEL IS DRAWN ONCE, under the list, rather than on every
 * row: it is the same sentence for every route at that level and repeating it
 * twenty times would bury the list it explains.
 */
function RefusedRoutes({ rows }: { rows: RefusedRoute[] }) {
  const levels = [...new Map(rows.map((r) => [r.level, r.demands])).entries()];
  return (
    <div className="text-muted-foreground grid gap-1 text-[12.5px]">
      <span>That key is refused on {rows.length} owner controls:</span>
      <div className="grid gap-0.5">
        {rows.map((r) => (
          <div key={r.prefix} className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono">{r.paths ? r.paths.join("  ") : `${r.prefix}/*`}</span>
            <span className="opacity-70">
              {r.methods === "all" ? "reads and writes" : "writes"} · {r.level}
            </span>
          </div>
        ))}
      </div>
      {levels.map(([level, demands]) => (
        <p key={level} className="max-w-[620px]">
          <span className="text-foreground">{level}</span> — {demands}
        </p>
      ))}
    </div>
  );
}

function ScheduleRow({ s }: { s: Schedule }) {
  return (
    <tr className="border-line-soft border-t">
      <td className="py-1.5 pr-3 text-[14px]">{s.pluginId}</td>
      <td className="text-muted-foreground py-1.5 pr-3 text-[12.5px]">{s.connected ? "connected" : "not connected"}</td>
      <td className="py-1.5 pr-3 text-[13.5px] tabular-nums">
        {s.everyMinutes === null ? (
          <span className="text-muted-foreground">never on the schedule</span>
        ) : (
          <>
            every {s.everyMinutes}m{s.custom ? "" : <span className="text-muted-foreground"> (box default)</span>}
          </>
        )}
      </td>
      <td className="text-muted-foreground py-1.5 pr-3 text-[13.5px]">{ago(s.lastStartedAt)}</td>
      <td className="text-muted-foreground py-1.5 text-[13.5px]">
        {s.everyMinutes === null ? "—" : s.due ? "due now" : when(s.nextDueAt, NEVER)}
      </td>
    </tr>
  );
}

/**
 * ONE LEASE.
 *
 * THE BUTTON ASKS TWICE FOR A LEASE THAT IS STILL BEATING, and that is not
 * politeness. Releasing a live lease does not stop the job — it removes the
 * only reason nothing will sleep the machine the job is running on — so the
 * cost of the wrong click is a forty-minute render destroyed by a sleep. The
 * server answers 409 for exactly that case and `force` is what lifts it; this
 * confirm is the deliberate second decision the flag is meant to represent.
 */
function LeaseRow({ lease, onRelease, busy }: { lease: Lease; onRelease: (id: string, force: boolean) => void; busy: boolean }) {
  /* THE SERVER'S OWN ANSWER, not a second copy of the two-minute rule. A page
     that computed this itself would eventually offer a plain Release for a
     lease the route then refuses with a 409 nobody expected. */
  const beating = lease.beating;
  return (
    <div className="border-line-soft flex items-center justify-between gap-3 border-t py-2">
      <div className="min-w-0">
        <div className="text-[14px]">
          {lease.kind} on {lease.resource}
          {lease.note ? <span className="text-muted-foreground"> — {lease.note}</span> : null}
        </div>
        <div className="text-muted-foreground text-[12.5px]">
          taken {ago(lease.acquiredAt)} ·{" "}
          {lease.live
            ? `${beating ? "beating" : `no heartbeat for ${Math.round(lease.heartbeatAgeS / 60)}m`}, lapses in ${Math.max(0, Math.round(lease.expiresInS / 60))}m`
            : `lapsed ${ago(lease.expiresAt)}`}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          if (
            beating &&
            !window.confirm(
              `${lease.kind} on ${lease.resource} is still running — it sent a heartbeat ${lease.heartbeatAgeS}s ago.\n\n` +
                `Releasing the lease will NOT stop it. It only removes the reason nothing will put ${lease.resource} ` +
                `to sleep while it works, so the job can be killed by a sleep partway through.\n\nRelease it anyway?`,
            )
          )
            return;
          onRelease(lease.id, beating);
        }}
      >
        {beating ? "Release anyway" : "Release"}
      </Button>
    </div>
  );
}

export function DeploymentSettings() {
  const status = useApi(() => deployApi.status(), []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [unit, setUnit] = useState<string | null>(null);
  const [log, setLog] = useState<{ which: string; lines: string[]; note: string } | null>(null);

  const d = status.data;

  /* Every button on this page returns some shape of "here is what happened":
     an install returns steps, a release returns a note, and a failure throws.
     One handler over all of them, typed as the union of what they answer with
     rather than as `unknown`, so a route that stops returning a note is a type
     error here rather than a silently blank panel. */
  async function act(fn: () => Promise<{ note?: string; steps?: string[]; error?: string | null; ok?: boolean }>) {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const res = await fn();
      setNote(res.steps?.length ? res.steps.join("\n") : (res.note ?? "Done."));
      if (res.error) setProblem(res.error);
      status.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (status.error)
    return (
      <Section title="Deployment" hint="How this app runs when nobody is sitting in front of it.">
        <p className="text-destructive text-[13.5px]">{status.error}</p>
      </Section>
    );

  if (!d)
    return (
      <Section title="Deployment" hint="How this app runs when nobody is sitting in front of it.">
        <p className="text-muted-foreground flex items-center gap-2 text-[13.5px]">
          <Loader2 className="size-3.5 animate-spin" /> Asking the supervisor and running the health checks…
        </p>
      </Section>
    );

  const svc = d.service;
  const iso = d.isolation;

  return (
    <>
      {/* ------------------------------------------------------ the service */}
      <Section
        title="Service"
        hint={
          svc.platform === "unsupported"
            ? `There is no service format here for this platform. Run \`npm start\` under whatever supervisor this system uses.`
            : `A ${svc.platform === "darwin" ? "launchd user agent" : "systemd user service"} in your own account — no root, nothing in /etc. It restarts on failure and comes back at login.`
        }
      >
        <div className="grid gap-1.5 text-[13.5px]">
          <div className="flex items-center gap-2">
            <Server className="text-muted-foreground size-3.5" />
            <span>
              {svc.installed ? "Installed" : "Not installed"} ·{" "}
              {svc.running === null ? (
                <span className="text-muted-foreground">the supervisor could not be asked whether it is running</span>
              ) : svc.running ? (
                <>running as pid {svc.pid}</>
              ) : (
                "not running"
              )}
            </span>
          </div>
          <div className="text-muted-foreground">Unit: {svc.unitPath}</div>
          <div className="text-muted-foreground">
            Environment: {svc.envPath} {svc.envPresent ? "" : "(not written yet)"}
          </div>
          <div className="text-muted-foreground">
            Logs: {svc.logs.out} · {svc.logs.err}
          </div>
          {svc.pid !== null && svc.pid !== svc.thisProcessPid && (
            <div className="text-warn flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                The supervised process is pid {svc.pid} and this answer came from pid {svc.thisProcessPid}. Two copies of
                this app are running; a setting changed in one will not be read by the other.
              </span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  const p = await deployApi.plan();
                  setUnit(p.unitText);
                } catch (err) {
                  setProblem(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Show the unit file
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => deployApi.writePlan())}>
            Write it to deploy/out/
          </Button>
          {svc.platform !== "unsupported" &&
            (svc.installed ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => deployApi.uninstall())}>
                Uninstall the service
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void act(() => deployApi.install())}>
                Install the service
              </Button>
            ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  const t = await deployApi.logs("err", 40);
                  setLog({ which: t.which, lines: t.lines, note: t.note });
                } catch (err) {
                  setProblem(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Tail the error log
          </Button>
        </div>

        {note && <pre className="text-muted-foreground max-h-48 overflow-auto text-[12.5px] whitespace-pre-wrap">{note}</pre>}
        {problem && <p className="text-destructive text-[13.5px]">{problem}</p>}
        {unit && (
          <pre className="bg-card border-line-soft max-h-72 overflow-auto rounded border p-3 text-[12.5px] whitespace-pre">
            {unit}
          </pre>
        )}
        {log && (
          <pre className="bg-card border-line-soft max-h-64 overflow-auto rounded border p-3 text-[12.5px] whitespace-pre-wrap">
            {log.lines.length ? log.lines.join("\n") : log.note}
          </pre>
        )}
      </Section>

      {/* ------------------------------------------------------- the health */}
      <Section
        title="Health"
        hint="Five checks over this process. `ok` on the probe means only that the process answered; the verdict is here."
      >
        <div className="flex items-center gap-2 text-[14px]">
          <span className={cn("size-2 rounded-full", DOT[d.health.status])} />
          {d.health.status === "ok" ? (
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="text-ok size-3.5" /> Everything checked passed.
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <CircleAlert className="size-3.5" /> {d.health.status === "fail" ? "Something needs fixing." : "Something is worth a look."}
            </span>
          )}
        </div>
        <div className="divide-line-soft divide-y">
          {d.health.checks.map((c) => (
            <CheckRow key={c.key} check={c} />
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------- the retention */}
      <Section
        title="How long history is kept"
        hint="One row per table, verbatim from the registry the prune walks — not a setting that describes some of it. A table that is NOT on this list is a table nothing ages out."
      >
        {d.health.retention.length === 0 ? (
          <p className="text-muted-foreground text-[13.5px]">
            Nothing has registered a window, so nothing on this box is pruned.
          </p>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-muted-foreground text-[12.5px]">
                  <th className="pb-1 pr-3 font-normal">Table</th>
                  <th className="pb-1 pr-3 font-normal">Aged on</th>
                  <th className="pb-1 pr-3 font-normal">Kept</th>
                  <th className="pb-1 font-normal">Where the number comes from</th>
                </tr>
              </thead>
              <tbody>
                {[...d.health.retention]
                  .sort((a, b) => a.table.localeCompare(b.table))
                  .map((r) => (
                    <RetentionRow key={r.table} r={r} />
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ----------------------------------------------------- the schedule */}
      <Section
        title="Collection schedule"
        hint={`The scheduler looks once a minute and collects each source on its own cadence. The box default is ${d.scheduler.defaultMinutes} minutes; a per-source value is a setting on that plugin's own Integrations page.`}
      >
        <div className="text-muted-foreground flex items-center gap-2 text-[12.5px]">
          <Timer className="size-3.5" />
          {d.scheduler.running ? `Running · last tick ${ago(d.scheduler.lastTickAt)}` : "The scheduler is off (OPC_COLLECT_MINUTES=0). Nothing is collected automatically."}
        </div>
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-muted-foreground text-[12.5px]">
                <th className="pb-1 pr-3 font-normal">Source</th>
                <th className="pb-1 pr-3 font-normal">State</th>
                <th className="pb-1 pr-3 font-normal">Cadence</th>
                <th className="pb-1 pr-3 font-normal">Last started</th>
                <th className="pb-1 font-normal">Next due</th>
              </tr>
            </thead>
            <tbody>
              {d.scheduler.sources.map((s) => (
                <ScheduleRow key={s.pluginId} s={s} />
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ---------------------------------------------------- the isolation */}
      <Section title="Agent isolation" hint="Measured, not intended — file modes read from this machine and the configured user compared with the running one.">
        <div className="grid gap-1.5 text-[13.5px]">
          <div className="flex items-center gap-2">
            <ShieldAlert className={cn("size-3.5", iso.level === "same-user" ? "text-warn" : "text-ok")} />
            <span className="font-medium">{iso.level}</span>
            <span className="text-muted-foreground">· running as {iso.runningAs}</span>
          </div>
          <p className="text-muted-foreground max-w-[620px]">{iso.summary}</p>
          {iso.problem && <p className="text-destructive">{iso.problem}</p>}
          <p className="text-muted-foreground max-w-[620px]">{iso.nextStep}</p>
          <div className="text-muted-foreground text-[12.5px]">
            Agent home: {iso.agentHome} · scoped key: {iso.scopedKey.file}
          </div>
          <RefusedRoutes rows={iso.scopedKey.refusedPrefixes} />
          {iso.agentKeyProblem && (
            <p className="text-destructive max-w-[620px]">
              {iso.agentKeyProblem}
            </p>
          )}
          <div className="text-muted-foreground text-[12.5px]">
            {iso.secretsLocked
              ? "Every credential file is no wider than it is meant to be."
              : "At least one credential file is open wider than it should be — see the modes below."}
          </div>
          <div className="text-muted-foreground grid gap-0.5 text-[12.5px]">
            {iso.files.map((f) => (
              <div key={f.path} className={cn(f.readableByOthers === true && "text-warn")}>
                {f.mode ?? "—"} {f.path}
                {f.present ? "" : " (not there yet)"}
                <span className="opacity-60"> · wants {f.intended}</span>
              </div>
            ))}
          </div>
          {/* THE CONTAINER PATH IS NAMED AND EXPLICITLY NOT CLAIMED. It is a
              real, stronger arrangement; nothing here can see whether you are
              on it, so the page says that rather than drawing a third level. */}
          <p className="text-muted-foreground max-w-[620px] text-[12.5px]">
            {iso.containerPath.note}
            {iso.containerPath.runtime ? ` A container runtime is installed here (${iso.containerPath.runtime}).` : " No container runtime is installed here."}
          </p>
        </div>
        <PluginSettingsForm plugin="deploy" saveLabel="Save the agent user" onSaved={() => status.reload()} />
      </Section>

      {/* -------------------------------------------------------- the leases */}
      <Section
        title="Machine leases"
        hint="What is using a shared machine right now. A live lease is the only thing that refuses to sleep one — it is not a lock, and two live leases on one machine are ordinary."
      >
        {d.leases.live.length === 0 && d.leases.stale.length === 0 && (
          <p className="text-muted-foreground text-[13.5px]">Nothing holds a lease. Every machine here may be slept.</p>
        )}
        {d.leases.live.map((l) => (
          <LeaseRow key={l.id} lease={l} busy={busy} onRelease={(id, force) => void act(() => deployApi.releaseLease(id, force))} />
        ))}
        {d.leases.stale.length > 0 && (
          <>
            <p className="text-muted-foreground pt-2 text-[12.5px]">
              {d.leases.stale.length} lease(s) lapsed without being released — a job that died. They already count as not
              live; sweeping them is bookkeeping.
            </p>
            {d.leases.stale.map((l) => (
              <LeaseRow key={l.id} lease={l} busy={busy} onRelease={(id, force) => void act(() => deployApi.releaseLease(id, force))} />
            ))}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => deployApi.releaseStale())}>
              Release the lapsed ones
            </Button>
          </>
        )}
        {d.leases.wake.length > 0 && (
          <div className="grid gap-1.5 pt-2">
            <div className="text-[14px]">Wake ownership</div>
            {d.leases.wake.map((w) => (
              <div key={w.resource} className="border-line-soft flex items-center justify-between gap-3 border-t py-2">
                <div className="min-w-0">
                  <div className="text-[13.5px]">
                    {w.resource} —{" "}
                    {w.owns
                      ? "woken by this app, so it may be slept by it"
                      : w.expired
                        ? "woken by this app, but too long ago to still count as ours"
                        : w.foundState === "awake"
                          ? "was already awake, so this app will not sleep it"
                          : "this app could not tell what state it was in, so it will not sleep it"}
                  </div>
                  <div className="text-muted-foreground text-[12.5px]">
                    {w.wokeBy} · {when(w.wokeAt, NEVER)}
                  </div>
                </div>
                {!w.owns && w.releasedAt === null && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => deployApi.releaseWake(w.resource))}>
                    Forget the wake
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
