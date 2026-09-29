import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { Run } from "./api";
import { OUTCOME_WORD, TONE_FILL, humanWhen, outcomeTone, type StepOutcome } from "./explain";
import { RunActions } from "./RunActions";
import { useWorkflow } from "./useWorkflow";
import { Legend, RunLine, RunTimeline, StepGlyph } from "./WorkflowParts";
import type { StepInfo } from "./steps";

/**
 * EVERY RUN, NEWEST FIRST, and above them a grid of steps × recent runs so a
 * step that has failed every night for a week is a red row rather than a
 * pattern somebody has to notice by opening fourteen runs.
 */
export function RunsTab() {
  const { doc, history, lookup, maxMinutesOf, reload } = useWorkflow();
  const [params, setParams] = useSearchParams();
  const [previews, setPreviews] = useState(false);
  const open = params.get("run");
  const toggle = (id: string) => {
    const next = new URLSearchParams(params);
    if (open === id) next.delete("run");
    else next.set("run", id);
    setParams(next, { replace: true });
  };

  if (doc.error) return <p className="text-destructive text-[14.5px]">{doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14.5px]">Reading the runs…</p>;
  const data = doc.data;

  /* Real runs from the history, plus the previews among the recent runs when
     asked for, merged newest first. */
  const extra = previews ? data.runs.filter((r) => r.dry) : [];
  const runs: Run[] = [...history, ...extra.filter((r) => !history.some((h) => h.id === r.id))].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
  if (open && !runs.some((r) => r.id === open)) {
    const found = data.runs.find((r) => r.id === open);
    if (found) runs.unshift(found);
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="border-line-soft bg-card rounded-2xl p-4 sm:p-5">
        <RunActions doc={data} onDone={reload} />
      </section>

      <StepGrid runs={history.slice(0, 14)} lookup={lookup} />

      <section>
        <div className="mb-2 flex flex-wrap items-baseline gap-3">
          <h2 className="text-[15px] font-medium">All runs</h2>
          <span className="text-muted-foreground text-[12.5px]">Open one to see what each step did.</span>
          <label className="text-muted-foreground ml-auto flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" checked={previews} onChange={(e) => setPreviews(e.target.checked)} />
            Show previews
          </label>
        </div>
        {runs.length === 0 ? (
          <p className="text-muted-foreground text-[13.5px]">No runs yet.</p>
        ) : (
          <div className="border-line-soft bg-card divide-line-soft divide-y overflow-hidden rounded-2xl border">
            {runs.map((r) => (
              <div key={r.id}>
                <RunLine run={r} open={open === r.id} onToggle={() => toggle(r.id)} />
                {open === r.id && (
                  <div className="bg-background/40 px-4 pt-2 pb-4 sm:pl-11">
                    <RunTimeline id={r.id} lookup={lookup} maxMinutesOf={maxMinutesOf} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** Steps down the side, runs across (oldest on the left), one square each. */
function StepGrid({ runs, lookup }: { runs: Run[]; lookup: (id: string) => StepInfo | undefined }) {
  const cols = [...runs].reverse().filter((r) => r.steps && r.steps.length);
  if (!cols.length) return null;
  const ids: string[] = [];
  for (const r of cols) for (const s of r.steps!) if (!ids.includes(s.stageId)) ids.push(s.stageId);
  const current = ids.filter((id) => lookup(id));
  const rows = current.length ? current : ids;

  return (
    <section className="border-line-soft bg-card rounded-2xl p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h2 className="text-[15px] font-medium">Each step, run by run</h2>
        <span className="text-muted-foreground text-[12.5px]">Last {cols.length} runs, oldest on the left.</span>
        <Legend className="ml-auto" />
      </div>
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-y-1 text-[13px]">
          <thead>
            <tr>
              <th />
              {cols.map((r) => (
                <th key={r.id} className="text-muted-foreground px-0.5 pb-1 text-center text-[10.5px] font-normal whitespace-nowrap">
                  {new Date(r.startedAt).getDate()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((id) => {
              const info = lookup(id) ?? { id, title: id, kind: null, role: null };
              return (
                <tr key={id}>
                  <td className="pr-4">
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <StepGlyph step={info} size="sm" />
                      {info.title}
                    </span>
                  </td>
                  {cols.map((r) => {
                    const o = r.steps!.find((s) => s.stageId === id)?.outcome;
                    return (
                      <td key={r.id} className="px-0.5">
                        <span
                          title={`${info.title}, ${humanWhen(r.startedAt)}: ${o ? OUTCOME_WORD[o as StepOutcome] ?? o : "not in this run"}`}
                          className={cn("block size-4 rounded-[3px]", o ? TONE_FILL[outcomeTone(o)] : "bg-muted/50")}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
