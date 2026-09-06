import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { count, pct } from "@/lib/format";

/**
 * A RANKED LIST WITH A SHARE BAR — top browsers, top sources, top spend.
 *
 * Two pages drew this with the same truncated label width, the same track and
 * fill classes and the same right-aligned figure, and had then diverged on the
 * only thing that matters here: WHAT "THE REST" MEANS. One added a change
 * column and a footnote saying how many values were not drawn; the other added
 * a remainder ROW inside the list. So two lists a reader would swear were the
 * same control were answering different questions about the same shape of
 * data, and neither said which.
 *
 * BOTH ANSWERS ARE REAL, so both are supported and both are explicit. A top-N
 * list that shows neither is a distribution with a hole in it: the shares add
 * up to less than everything and nothing on the screen admits it. Every caller
 * therefore says, in its props, which kind of "rest" it has.
 *
 * A SHARE IS A 0–1 FRACTION, like everywhere else on this client. It is either
 * given per row — because the server computed it against a total this page
 * cannot see, such as a capped query's real denominator — or derived from
 * `total`. If neither is available the share column is not drawn at all,
 * rather than filled with a number derived from the rows alone, which would be
 * a share of the top ten pretending to be a share of everything.
 */

export type RankedRow = {
  label: string;
  value: number;
  /** The row's share of the whole, 0–1. Omit to derive it from `total`; pass
   *  `null` for a row whose share genuinely is not known. */
  share?: number | null;
  /** Change against the previous window, 0–1 (0.12 is +12%). `null` renders as
   *  a dash: no previous window is not "no change". */
  change?: number | null;
  /** A second line under the label — a hostname, a version, a date. */
  sub?: ReactNode;
  /** Hover text. Defaults to the label, which is what a truncated label needs. */
  title?: string;
};

export function RankedBars({
  rows,
  total,
  remainder,
  showChange = false,
  format = (n) => count(n),
  footnote,
  className,
}: {
  rows: readonly RankedRow[];
  /** The whole the shares are of. Required for `remainder`, and used to derive
   *  a share for any row that did not carry one. */
  total?: number | null;
  /**
   * The label for a final muted row holding `total` minus the rows above it —
   * "everything else", "other versions". Drawn only when `total` is known and
   * the leftover is positive. Pass nothing where the un-drawn rest is
   * described in a `footnote` instead; pass nothing where there is no rest.
   */
  remainder?: string;
  /** Draw the change column. Off by default: a list with no previous window to
   *  compare against should not carry a column of dashes. */
  showChange?: boolean;
  /** How the figure is written. Counts by default; a spend list passes
   *  `(n) => money(n, "USD")`, a disk list `(n) => bytes(n)`. */
  format?: (value: number) => ReactNode;
  /** The caveat under the list: how many values were not drawn, and whether
   *  the denominator is the whole distribution or a row limit. */
  footnote?: ReactNode;
  className?: string;
}) {
  const shareOf = (row: RankedRow): number | null =>
    row.share !== undefined ? row.share : total ? row.value / total : null;

  const drawn = rows.reduce((sum, r) => sum + r.value, 0);
  const rest = remainder !== undefined && total !== null && total !== undefined ? total - drawn : 0;
  const restRow: RankedRow | null =
    remainder !== undefined && rest > 0 ? { label: remainder, value: rest } : null;

  const all = restRow ? [...rows, restRow] : [...rows];
  const max = Math.max(1, ...all.map((r) => Math.abs(r.value)));
  const anyShare = all.some((r) => shareOf(r) !== null);

  return (
    <div className={className}>
      <div className="space-y-1">
        {all.map((row) => {
          const isRest = row === restRow;
          return (
            <div
              key={isRest ? "rest-row" : row.label}
              className="flex items-center gap-2 text-[12.5px]"
            >
              <span
                className={cn("w-[150px] shrink-0 truncate", isRest && "text-muted-foreground")}
                title={row.title ?? row.label}
              >
                {row.label}
                {row.sub && <span className="text-muted-foreground text-[11px]"> {row.sub}</span>}
              </span>

              <span className="bg-accent relative h-3 flex-1 overflow-hidden rounded-sm">
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-sm",
                    isRest ? "bg-line-strong" : "bg-ok",
                  )}
                  /* At least 2%, so a row that is genuinely tiny still reads as
                     a row rather than as an empty track nobody measured. */
                  style={{ width: `${Math.max(2, (Math.abs(row.value) / max) * 100)}%` }}
                />
              </span>

              <span
                className={cn(
                  "w-[78px] shrink-0 text-right tabular-nums",
                  isRest && "text-muted-foreground",
                )}
              >
                {format(row.value)}
              </span>

              {anyShare && (
                <span className="text-muted-foreground w-[52px] shrink-0 text-right text-[11px] tabular-nums">
                  {pct(shareOf(row))}
                </span>
              )}

              {showChange && (
                <span
                  className={cn(
                    "w-[62px] shrink-0 text-right text-[11px] tabular-nums",
                    row.change !== null && row.change !== undefined && row.change > 0
                      ? "text-ok"
                      : "text-muted-foreground",
                  )}
                >
                  {row.change === null || row.change === undefined
                    ? "—"
                    : `${row.change > 0 ? "+" : ""}${pct(row.change, { digits: 0 })}`}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {footnote && <p className="text-muted-foreground mt-2 text-[11px]">{footnote}</p>}
    </div>
  );
}
