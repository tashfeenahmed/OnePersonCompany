import { Fragment } from "react";
import { SquarePen } from "lucide-react";
import { statusTone, statusWord } from "@/components/runs/format";
import { dayLabel, runLabel } from "@/components/org/dossiers";
import { clock, day } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RunSummary } from "@/lib/api/runs";

/**
 * THE LIST OF CONVERSATIONS WITH THIS WORKER — which is to say, its runs.
 *
 * ---------------------------------------------------------------------------
 * A RUN IS A CHAT AND THIS RAIL IS THE CHAT LIST. The middle of the page draws
 * ONE run at a time as an exchange — the brief, the tool calls, the report —
 * exactly as the app's own sidebar lists sessions and the middle draws the
 * open one. Every row is here, not the newest twenty: the server sends the
 * whole ledger as summaries, and a row that could not be opened would be a
 * history the owner can see and not read.
 *
 * A ROW OPENS THE RUN ON THIS PAGE, at `?run=<id>`. It used to be two verbs —
 * scroll to an exchange in a transcript, or leave for the Outputs tab — and on
 * the People Analyst, whose transcript was only the unfiled pile, a filed
 * dossier was neither: the click did nothing. One verb now. The open row is
 * marked, the way the chat rail marks the open session.
 *
 * NEW BRIEF IS AT THE TOP, because that is where New chat is. It clears the
 * selection rather than sending anything: the empty page with the composer
 * focused, at `?run=new`, which is an address the back button understands.
 *
 * GROUPED BY DAY BECAUSE THAT IS HOW WORK IS REMEMBERED. "Today" and
 * "Yesterday" are the two the owner actually reasons in — the rest are dates,
 * because "8d ago" as a HEADING makes a reader do arithmetic to find the
 * Tuesday they are thinking of. Under a date heading, each row carries the
 * CLOCK — "14:02" — because that is the half of the stamp the heading does not
 * already say; "3h ago" beside "Today" was the same fact twice, and beside
 * "5 Sep" it was arithmetic again.
 *
 * THE TALLY UNDER THE NAME is Workdash's: finished, failed, and how many are
 * still going, over the whole ledger rather than a 48-hour window, because
 * this ledger is kept rather than expired.
 *
 * A NOTE UNDER THE TALLY WHEN THE LIST IS NARROWED. The caller can hand this
 * rail a subset — the People Analyst's unfiled pile is the one that does — and
 * a column showing eleven of sixty rows with nothing saying so is a rail that
 * looks like it has lost the rest.
 *
 * HIDDEN BELOW `lg`, and below it the page is the open run and the composer.
 * That used to be defensible because the middle carried a transcript of the
 * last twenty as well; it no longer does, so what a narrow screen loses is the
 * history — which is still whole on the kind's own Outputs page, one link from
 * every reply. A drawer for it is the honest fix and is not built yet; a rail
 * squeezed into 320px beside a report is not.
 */
export function RunRail({
  name,
  runs,
  note,
  label,
  activeId,
  onPick,
  onNew,
}: {
  /** The worker's name, as the rail's own heading. */
  name: string;
  /** ALL of them, newest first — the ledger, not the transcript. Or the
   *  subset the caller is showing, in which case `note` says which. */
  runs: RunSummary[];
  /** What narrows this list, when something does. Null is the whole ledger. */
  note?: string | null;
  /** A better name for a run than its title, when the caller has one — the
   *  brief's first line, for a run whose title is only the venture's name.
   *  Null falls back to the title with its kind prefix stripped. */
  label?: (run: RunSummary) => string | null;
  /** The run open on the page, if one is. */
  activeId: string | null;
  onPick: (run: RunSummary) => void;
  /** Clear the selection and start a new brief. Absent on a rail that has
   *  nowhere to send one. */
  onNew?: () => void;
}) {
  /* Grouped in the order they arrive rather than re-sorted. The server's order
     is the claim that the top row is the newest, and a second sort here would
     be this file quietly disagreeing with it. */
  const groups: { label: string; runs: RunSummary[] }[] = [];
  for (const run of runs) {
    const label = dayLabel(run.queuedAt) ?? day(run.queuedAt, { year: true });
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.runs.push(run);
    else groups.push({ label, runs: [run] });
  }

  const done = runs.filter((r) => r.status === "done").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const going = runs.filter((r) => r.status === "running" || r.status === "queued").length;

  return (
    /* WHITE, NOT THE SIDEBAR'S TINT — the same change the watchlist's rail
       made, for the same reason: the app's rail is already a tinted gutter,
       and a second tinted column beside it reads as one gutter with a seam
       down the middle. This rail is a surface somebody reads, and on paper a
       surface somebody reads is paper. The hairline stays: it is what
       separates the two now that the fill no longer does. */
    <aside className="border-line-soft hidden w-[264px] shrink-0 flex-col border-r bg-white lg:flex dark:bg-background">
      <div className="border-line-soft shrink-0 border-b px-3.5 pt-3.5 pb-2.5">
        <div className="truncate text-[13.5px] font-medium">{name}</div>
        <div className="text-muted-foreground text-[12px] tabular-nums">
          {runs.length === 0
            ? "no runs"
            : `${runs.length} ${runs.length === 1 ? "run" : "runs"} · ${done} finished` +
              (failed > 0 ? ` · ${failed} failed` : "") +
              (going > 0 ? ` · ${going} going` : "")}
        </div>
        {note && (
          <div className="text-muted-foreground text-[12px]">{note}</div>
        )}
      </div>

      {/* NEW BRIEF, WHERE NEW CHAT IS. Marked when it is what the page is
          showing, for the same reason a row is: the blank composer is a state
          of this rail, not a gesture that leaves it. */}
      {onNew && (
        <div className="shrink-0 px-2 pt-2">
          <button
            onClick={onNew}
            aria-current={activeId === null ? "true" : undefined}
            className={cn(
              "flex w-full items-center gap-2 rounded-[9px] px-1.5 py-1.5 text-left text-[13px] transition-colors",
              activeId === null ? "bg-accent text-foreground" : "hover:bg-accent",
            )}
          >
            <SquarePen className="size-3.5 shrink-0" strokeWidth={1.7} />
            New brief
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-6">
        {runs.length === 0 ? (
          <p className="text-muted-foreground px-1.5 py-1 text-[12.5px]">
            No runs yet.
          </p>
        ) : (
          groups.map((group) => (
            <Fragment key={group.label}>
              <div className="text-muted-foreground px-1.5 pt-2.5 pb-1 text-[11.5px] tracking-[0.04em] uppercase">
                {group.label}
              </div>
              {group.runs.map((run) => {
                const live = run.status === "running" || run.status === "queued";
                const open = run.id === activeId;
                const stamp = run.finishedAt ?? run.startedAt ?? run.queuedAt;
                return (
                  <button
                    key={run.id}
                    onClick={() => onPick(run)}
                    aria-current={open ? "true" : undefined}
                    title={`${run.title} · ${statusWord(run.status)} · ${day(stamp, { year: true })} ${clock(stamp)}`}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[9px] px-1.5 py-1.5 text-left transition-colors",
                      open ? "bg-accent text-foreground" : "hover:bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        statusTone(run.status),
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {label?.(run) ?? runLabel(run.title)}
                    </span>
                    {/* THE CLOCK, OR WHAT IT IS DOING INSTEAD. A run in flight
                        has no time worth reading yet — "working" is the fact
                        somebody scanning this column is looking for. */}
                    <span className="text-muted-foreground shrink-0 text-[11.5px] tabular-nums">
                      {live ? statusWord(run.status) : clock(stamp)}
                    </span>
                  </button>
                );
              })}
            </Fragment>
          ))
        )}
      </div>
    </aside>
  );
}
