import { useState } from "react";
import { cn } from "@/lib/utils";
import type { RunStep } from "@/lib/api/runs";
import { duration } from "@/lib/format";

/**
 * WHAT THE RUN DID WHILE IT WAS WRITING, AS GREY LINES.
 *
 * The same shape and the same argument as `components/ToolCallLine` — one
 * collapsed line per tool call, grey, folded, expandable — and deliberately
 * NOT that component. `ToolCallLine` takes a `ChatToolCall`, which is a
 * transcript's record of a call inside a message; a run's step is a row in
 * `agent_runs.steps` with the same four facts under different names and no
 * message to sit inside. Adapting the look is one small file; adapting the
 * type would mean either a shim on every render or a shared union that exists
 * only because two pages happen to draw the same rectangle.
 *
 * WHY THE STEPS ARE ABOVE THE REPORT AND NOT INSIDE IT. In a chat the tool
 * lines are interleaved with the prose because that is when they happened. A
 * run's report is one document written at the end of the work: the tools all
 * ran first, and threading them through the markdown would put them at
 * positions the server never claimed. So they are a block above it, in order,
 * which is the only ordering that is true.
 *
 * A RUNNING CALL SHIMMERS AND A FINISHED ONE DOES NOT — `.tool-shimmer` in
 * index.css, which falls back to a static lighter grey under
 * `prefers-reduced-motion`. A call still marked running after the run ended
 * keeps saying so rather than being quietly closed at the moment the process
 * died, which would be inventing an end time.
 */
function took(step: RunStep): number | null {
  if (!step.finishedAt) return null;
  const ms = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function at(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function StepLine({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false);
  const ms = took(step);
  const running = !step.finishedAt;
  const took_ = duration(ms, { nullText: "" });

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "text-muted-foreground -mx-1.5 flex w-[calc(100%+0.75rem)] items-baseline rounded-[9px] px-1.5 py-0.5 text-left text-[14px] leading-[1.6] transition-colors",
          running
            ? "tool-shimmer focus-visible:ring-ring focus-visible:ring-1"
            : "hover:bg-accent hover:text-foreground focus-visible:bg-accent",
        )}
      >
        <span className="min-w-0 truncate">
          {step.tool}
          {step.label && ` · ${step.label}`}
        </span>
        <span className="shrink-0">
          {" · "}
          {running ? "running…" : took_ ? `completed in ${took_}` : "completed"}
        </span>
      </button>

      {open && (
        <div className="text-muted-foreground border-line-soft mt-1 mb-1 ml-1.5 flex flex-col gap-0.5 border-l pl-3 text-[14px] leading-[1.6]">
          {step.label && (
            <p className="break-words whitespace-pre-wrap">{step.label}</p>
          )}
          <p>Started {at(step.startedAt)}</p>
          <p>
            {step.finishedAt
              ? `Finished ${at(step.finishedAt)}${took_ ? ` · ${took_}` : ""}`
              : "No end recorded — the call was still going when the run stopped."}
          </p>
          <p className="break-all">Call {step.toolCallId}</p>
          {/* Said once rather than left as an empty section somebody concludes
              is broken. The agent's stream carries no tool result. */}
          <p>The stream carries no result, so there is nothing else to show.</p>
        </div>
      )}
    </div>
  );
}

export function RunSteps({ steps }: { steps: RunStep[] }) {
  if (!steps.length) return null;
  const running = steps.filter((s) => !s.finishedAt).length;
  return (
    <div className="mb-4">
      <div className="text-muted-foreground mb-1 text-[12px] tracking-[0.06em] uppercase">
        {steps.length} {steps.length === 1 ? "tool call" : "tool calls"}
        {running > 0 && ` · ${running} still going`}
      </div>
      <div className="flex flex-col gap-0.5">
        {steps.map((s) => (
          <StepLine key={s.toolCallId} step={s} />
        ))}
      </div>
    </div>
  );
}
