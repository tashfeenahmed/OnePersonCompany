import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/useApi";
import { runtimeApi, type NativeJob } from "@/lib/api/runtime";
import { cn } from "@/lib/utils";

/**
 * WHAT THIS RUNTIME IS SCHEDULED TO DO, AND WHAT CAME OF IT.
 *
 * IT IS A READER AND SAYS SO. Hermes and OpenClaw each have a scheduler of
 * their own and each is running it; this dashboard has a run queue and a
 * nightly pipeline besides. There is no "new job" button here and there will
 * not be one — a third place to create recurring work would be a third clock,
 * and the first question about a missed job would become "which of the three
 * was it in". The panel says whose the scheduling is, in the server's own
 * sentence.
 *
 * TWO RECORDS PER JOB, DRAWN AS TWO. `lastStatus` is what the RUNTIME'S own
 * store says; `lastSeen` is the run whose output this box actually read and
 * relayed. They can disagree — a run that died before writing its output
 * leaves one and not the other — and showing only one would hide exactly the
 * case worth noticing.
 *
 * AN UNREADABLE STORE IS NOT AN EMPTY SCHEDULE. When the server says
 * `readable: false` this prints its note, which carries the path that was
 * looked in, rather than "no jobs".
 */
function statusTone(status: string | null | undefined): string {
  if (!status) return "bg-muted-foreground";
  if (/fail|error|interrupt|blocked/i.test(status)) return "bg-destructive";
  if (/complete|ok|done/i.test(status)) return "bg-ok";
  return "bg-warn";
}

function JobRow({ job }: { job: NativeJob }) {
  const seen = job.lastSeen;
  return (
    <div className="border-line-soft flex flex-col gap-1 border-b py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("size-[7px] rounded-[3px]", statusTone(job.lastStatus))} aria-hidden />
        <span className="text-[14px] font-medium">{job.name ?? job.id}</span>
        {job.schedule && (
          <span className="text-muted-foreground text-[12.5px]">{job.schedule}</span>
        )}
        {job.enabled === false && (
          <span className="text-muted-foreground text-[12.5px]">disabled</span>
        )}
      </div>
      <div className="text-muted-foreground text-[12.5px]">
        {/* THE RUNTIME'S OWN RECORD. */}
        {job.lastStatus
          ? `Runtime says: ${job.lastStatus}${job.lastRunAt ? ` · ${job.lastRunAt.slice(0, 16).replace("T", " ")}` : ""}`
          : "Runtime records no run yet"}
        {job.nextRunAt ? ` · next ${job.nextRunAt.slice(0, 16).replace("T", " ")}` : ""}
      </div>
      <div className="text-muted-foreground text-[12.5px]">
        {/* WHAT THIS BOX READ. */}
        {seen
          ? `Read here: ${seen.status ?? "unknown"}${seen.at ? ` · ${seen.at.slice(0, 16).replace("T", " ")} UTC` : ""} · ` +
            (seen.delivered
              ? "relayed"
              : seen.suppressedBy
                ? `not relayed (${seen.suppressedBy})`
                : seen.deliveryError
                  ? `not relayed — ${seen.deliveryError}`
                  : "waiting to relay")
          : "No output read on this side yet."}
      </div>
      {job.lastError && <div className="text-destructive text-[12.5px]">{job.lastError}</div>}
    </div>
  );
}

export function RuntimeJobsPanel({ id }: { id: "hermes" | "openclaw" }) {
  const doc = useApi(() => runtimeApi.jobs(), []);
  const { reload } = doc;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reading = doc.data?.runtimes.find((r) => r.runtime === id) ?? null;

  async function refresh() {
    setBusy(true);
    setNote(null);
    try {
      const r = await runtimeApi.refresh();
      setNote(
        `${r.found} new result${r.found === 1 ? "" : "s"} found · ${r.delivered} relayed` +
          (r.deferred ? ` · ${r.deferred} held for quiet hours` : "") +
          (r.held ? ` · ${r.held} queued for the next pass` : "") +
          (r.failed ? ` · ${r.failed} could not be sent` : ""),
      );
      reload();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Separator className="my-5" />
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14.5px] font-medium">Scheduled jobs</h3>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? "Reading…" : "Read now"}
        </Button>
      </div>

      {doc.error && <p className="text-destructive mt-2 text-[13.5px]">{doc.error}</p>}

      {doc.data && (
        <p className="text-muted-foreground mt-1.5 text-[12.5px]">{doc.data.scheduling}</p>
      )}

      {reading && !reading.readable && (
        <div className="bg-card border-line-soft mt-3 rounded-[14px] border p-4.5">
          <p className="text-[13.5px]">Not readable for this runtime.</p>
          <p className="text-muted-foreground mt-1 text-[12.5px]">{reading.note}</p>
        </div>
      )}

      {reading?.readable && (
        <div className="mt-2">
          {reading.jobs.length === 0 ? (
            <p className="text-muted-foreground text-[13.5px]">{reading.note}</p>
          ) : (
            <>
              <p className="text-muted-foreground mb-1 text-[12.5px]">{reading.note}</p>
              {reading.jobs.map((j) => (
                <JobRow key={j.id} job={j} />
              ))}
            </>
          )}
        </div>
      )}

      {note && <p className="text-muted-foreground mt-2 text-[12.5px]">{note}</p>}

      {doc.data && (
        <p className="text-muted-foreground mt-2 text-[12.5px]">
          {doc.data.counts.seen} result{doc.data.counts.seen === 1 ? "" : "s"} seen ·{" "}
          {doc.data.counts.delivered} relayed · {doc.data.counts.pending} waiting ·{" "}
          {doc.data.counts.suppressed} deliberately not sent · read every{" "}
          {doc.data.passMinutes} minutes ·{" "}
          {doc.data.settings.relay
            ? "relay on"
            : "relay off — results are recorded here and nothing is pushed"}
          {" · "}
          <Link className="underline" to="/plugins/runtime">
            settings
          </Link>
        </p>
      )}
    </>
  );
}
