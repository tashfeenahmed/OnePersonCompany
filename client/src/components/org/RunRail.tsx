import { Fragment } from "react";
import { statusTone, statusWord } from "@/components/runs/format";
import { dayLabel, runLabel } from "@/components/org/dossiers";
import { ago, day } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RunSummary } from "@/lib/api/runs";

/**
 * EVERYTHING THIS WORKER HAS EVER DONE, DOWN THE SIDE.
 *
 * ---------------------------------------------------------------------------
 * THE TRANSCRIPT IS THE LAST TWENTY AND THIS IS ALL OF THEM. The middle of the
 * page is a conversation, and a conversation that went back three hundred
 * turns would be unreadable and slow to fetch — so the server sends twenty
 * with their reports in full and the whole ledger as bare summaries. That
 * split used to show up as a single grey sentence above the transcript ("the
 * last 20 of 63 runs, the rest are on the Dossiers page"), which told the
 * owner their history existed and then sent them somewhere else to see it.
 * This is the rest of it, in the place the eye already goes for a list.
 *
 * A ROW IS EITHER A SCROLL OR A NAVIGATION, and which one depends on whether
 * the run is in the transcript rather than on how it is drawn. A run that is
 * on this page moves the page to it; a run that is not opens its own report.
 * Both are "take me to this run", and the rail does not make the reader learn
 * which of the two it will be.
 *
 * GROUPED BY DAY BECAUSE THAT IS HOW WORK IS REMEMBERED. "Today" and
 * "Yesterday" are the two the owner actually reasons in — the rest are dates,
 * because "8d ago" as a HEADING makes a reader do arithmetic to find the
 * Tuesday they are thinking of. The right-hand column keeps the relative form,
 * which is the one that is useful per row.
 *
 * HIDDEN BELOW `lg`, AND THE PAGE STILL WORKS. It is a second view of runs the
 * page already reaches — the transcript is here, the rest are one link away —
 * so on a narrow screen it is the thing that goes rather than the thing that
 * gets a hamburger of its own.
 */
export function RunRail({
  name,
  runs,
  label,
  inTranscript,
  onPick,
}: {
  /** The worker's name, as the rail's own heading. */
  name: string;
  /** ALL of them, newest first — the ledger, not the transcript. */
  runs: RunSummary[];
  /** A better name for a run than its title, when the caller has one — the
   *  brief's first line, for a run whose title is only the venture's name.
   *  Null falls back to the title with its kind prefix stripped. */
  label?: (run: RunSummary) => string | null;
  /** Which ids the page can scroll to rather than navigate to. */
  inTranscript: (id: string) => boolean;
  onPick: (run: RunSummary) => void;
}) {
  /* Grouped in the order they arrive rather than re-sorted. The server's order
     is the claim that the top row is the newest, and a second sort here would
     be this file quietly disagreeing with it. */
  const groups: { label: string; runs: RunSummary[] }[] = [];
  for (const run of runs) {
    const label = dayLabel(run.queuedAt) ?? day(run.queuedAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.runs.push(run);
    else groups.push({ label, runs: [run] });
  }

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
        <div className="text-muted-foreground text-[12px]">
          {runs.length === 0
            ? "no runs"
            : `${runs.length} ${runs.length === 1 ? "run" : "runs"}`}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-6">
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
                return (
                  <button
                    key={run.id}
                    onClick={() => onPick(run)}
                    title={run.title}
                    className="hover:bg-accent flex w-full items-center gap-2 rounded-[9px] px-1.5 py-1.5 text-left transition-colors"
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
                    {/* THE AGE, OR WHAT IT IS DOING INSTEAD. A run in flight
                        has no age worth reading — "just now" is true of every
                        one of them — and "working" is the fact somebody
                        scanning this column is looking for. */}
                    <span className="text-muted-foreground shrink-0 text-[11.5px]">
                      {live ? statusWord(run.status) : ago(run.queuedAt)}
                    </span>
                    {/* The one row the page cannot scroll to says so by being
                        drawn no differently: it opens the run's own page, which
                        is where its report is. */}
                    {!inTranscript(run.id) && <span className="sr-only">opens its own page</span>}
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
