import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * "LAST N DAYS" — ONE CONTROL, ONCE.
 *
 * Six pages offered this and no two offered it the same way: two rows of
 * pills, three native selects and a row of outlined buttons, in four label
 * formats ("7d", "7 days", "last 7 days", "30 days") across four option sets.
 * None of it was a decision — each page invented the control it needed while
 * writing something else — and the cost lands on the reader, who cannot carry
 * a habit from one page to the next and has to find the window control again
 * on every screen.
 *
 * PILLS RATHER THAN A SELECT. These lists are three or four options long; a
 * select hides all of them behind a press and gives no clue that the page
 * could show a different span at all. The pills are also the affordance the
 * tab strip already uses, so a page has one visual language rather than two.
 *
 * THE LABEL IS SHORT AND THE ACCESSIBLE NAME IS LONG. "7d" is what fits in a
 * row of four; "last 7 days" is what a screen reader should say. Both, rather
 * than a compromise that is bad at each.
 */

/** A span, or the whole record. `"all"` exists because the journal genuinely
 *  has an "everything" reading and a number cannot express it. */
export type WindowValue = number | "all";

/** Six days is "6d"; "all" is a word, because it is not a length. */
function pillLabel(value: WindowValue): string {
  return value === "all" ? "all" : `${value}d`;
}

function longLabel(value: WindowValue): string {
  return value === "all" ? "everything" : `last ${value} day${value === 1 ? "" : "s"}`;
}

export function WindowPicker({
  value,
  onChange,
  options = [7, 30, 90],
  label = "Window",
  right,
  className,
}: {
  value: WindowValue;
  onChange: (value: WindowValue) => void;
  /** Defaults to a week, a month and a quarter — the three spans every
   *  collector on this box actually stores. */
  options?: readonly WindowValue[];
  /** The group's accessible name. Only worth changing where a page carries two
   *  of these, which nothing does yet. */
  label?: string;
  /** Anything that belongs on the same line, pushed to the far end: the note
   *  about which timezone the deadlines are in, a "waiting only" toggle. */
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-0.5", className)}>
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-0.5">
        {options.map((option) => {
          const selected = option === value;
          return (
            <button
              key={String(option)}
              type="button"
              aria-pressed={selected}
              aria-label={longLabel(option)}
              onClick={() => onChange(option)}
              className={cn(
                "text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors",
                selected && "bg-accent text-foreground font-medium",
              )}
            >
              {pillLabel(option)}
            </button>
          );
        })}
      </div>
      {right && <span className="text-muted-foreground ml-auto text-[11.5px]">{right}</span>}
    </div>
  );
}
