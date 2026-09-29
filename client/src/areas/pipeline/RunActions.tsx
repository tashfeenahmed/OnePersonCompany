import { useState } from "react";
import { CalendarOff, Eye, Loader2, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pipelineApi, type PipelineDoc } from "./api";
import { humanDay } from "./explain";

/**
 * THE FOUR THINGS YOU CAN DO TO THE NIGHTLY WORKFLOW FROM OUTSIDE THE EDITOR.
 *
 * "Preview" is the rehearsal: its own route on the server, which spends
 * nothing and starts no sub-agent. "Run now" is real work on your model and
 * budgets, so the line beside the buttons says which is which.
 */
export function RunActions({ doc, onDone, className }: { doc: PipelineDoc; onDone: () => void; className?: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const running = !!doc.activity?.running;
  const { schedule } = doc;

  const go = (label: string, fn: () => Promise<string | null>) => {
    setBusy(label);
    setFailure(null);
    setSaid(null);
    fn()
      .then((s) => setSaid(s))
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(null);
        onDone();
      });
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() =>
              go("stop", async () => {
                await pipelineApi.stop();
                return "Stop requested. The step in progress is being cancelled.";
              })
            }
          >
            {busy === "stop" ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" strokeWidth={1.6} />}
            Stop the run
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy !== null || !doc.workflowSaved}
            onClick={() =>
              go("run", async () => {
                await pipelineApi.start();
                return "Started. Follow it step by step below.";
              })
            }
          >
            {busy === "run" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" strokeWidth={1.6} />}
            Run now
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null || running || !doc.workflowSaved}
          onClick={() =>
            go("plan", async () => {
              const out = await pipelineApi.plan();
              return out.run ? `Preview: ${out.run.planned} steps would run. Nothing was started.` : (out.why ?? null);
            })
          }
        >
          {busy === "plan" ? <Loader2 className="size-3.5 animate-spin" /> : <Eye className="size-3.5" strokeWidth={1.6} />}
          Preview
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || !schedule.enabled}
          onClick={() =>
            go("skip", async () => {
              const out = await pipelineApi.skipTonight(schedule.skipTonight !== null);
              return out.note;
            })
          }
        >
          <CalendarOff className="size-3.5" strokeWidth={1.6} />
          {schedule.skipTonight ? `Don't skip ${humanDay(schedule.skipTonight.day)}` : "Skip the next run"}
        </Button>
      </div>
      <p className="text-muted-foreground text-[12px]">
        {doc.workflowSaved
          ? "Preview checks what would run and spends nothing. Run now does the real work on your selected model."
          : "Save the steps in the Steps & schedule tab before previewing or running them."}
      </p>
      {said && <p className="text-[13px]">{said}</p>}
      {failure && <p className="text-destructive text-[13px]">{failure}</p>}
    </div>
  );
}
