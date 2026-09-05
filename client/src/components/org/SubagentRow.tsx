import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { RoleIcon } from "@/components/org/RoleIcon";
import { standing } from "@/components/org/roleLook";
import { ago } from "@/lib/live";
import { cn } from "@/lib/utils";
import type { Subagent } from "@/lib/api/subagents";

/**
 * ONE WORKER, AS A ROW — the same row in the org chart, on the roster and on a
 * venture's overview.
 *
 * THREE PAGES DRAW THIS AND THEREFORE ONE FILE DOES. They want slightly
 * different amounts of it: the chart has 19 cards on screen at once and can
 * afford a name and a dot, the roster has room for the title and when the last
 * report landed, the overview wants a way in that says what pressing it does.
 * That is a density knob and a trailing slot, not three components — the thing
 * being drawn is the same thing, and a chart that words a status differently
 * from the roster it links to is two facts where there was one.
 *
 * THE WHOLE ROW IS THE LINK, and the trailing slot is inside it rather than
 * beside it. A row with its own nested <a> is invalid HTML that browsers
 * silently un-nest, and "Dispatch" going somewhere the rest of the row does
 * not would be two destinations in a strip 22 pixels tall.
 */
export function SubagentRow({
  sa,
  to,
  dense,
  label,
  trailing,
}: {
  sa: Subagent;
  to: string;
  /** The chart's density: name and dot, no title and no timestamp. */
  dense?: boolean;
  /** What to call it, when the row's context makes the full name redundant —
   *  see `shortName`. The name itself by default. */
  label?: string;
  /** Drawn at the right end, after the status. */
  trailing?: ReactNode;
}) {
  const state = standing(sa);
  const last = sa.lastRun;

  return (
    <Link
      to={to}
      title={`${sa.name} — ${sa.title}. ${
        last
          ? `Last run ${ago(last.finishedAt ?? last.queuedAt)}: ${last.title}`
          : "Nothing run yet."
      }`}
      className={cn(
        "hover:bg-accent group flex items-center gap-2 rounded-md transition-colors",
        dense ? "px-1.5 py-[3px]" : "-mx-1.5 px-1.5 py-1.5",
        /* A worker the owner has switched off is drawn faded rather than
           hidden. It is still on the org — somebody has to be able to switch
           it back on, and a missing row is not a way to say "off". */
        !sa.enabled && "opacity-55",
      )}
    >
      <RoleIcon
        role={sa.role}
        className="text-muted-foreground size-3.5 shrink-0"
      />
      <span
        className={cn(
          "min-w-0 truncate",
          dense ? "text-[11.5px]" : "text-[12.5px]",
        )}
      >
        {label ?? sa.name}
      </span>
      {!dense && (
        <span className="text-muted-foreground hidden shrink-0 text-[11.5px] sm:inline">
          {sa.title}
        </span>
      )}

      <span
        className={cn("ml-auto size-1.5 shrink-0 rounded-full", state.tone)}
      />
      <span className="text-muted-foreground shrink-0 text-[11px]">
        {state.word}
      </span>

      {/* When the last report landed, which is the fact that says whether this
          worker is part of the business or an idea somebody had. Left out of
          the dense row for space, and left out entirely when there has never
          been a run — `standing` has already said "never run" and repeating it
          as "never" would be the same absence twice. */}
      {!dense && last && (
        <span className="text-muted-foreground hidden w-[64px] shrink-0 text-right text-[11px] sm:block">
          {ago(last.finishedAt ?? last.queuedAt)}
        </span>
      )}

      {trailing}
    </Link>
  );
}
