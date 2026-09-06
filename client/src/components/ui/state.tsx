import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * THE THREE STATES EVERY DATA PAGE IS IN, AND THE ONE RULE THEY CARRY.
 *
 * Three area pages had copy-pasted this scaffold whole. A diff of two of them
 * came back with two hunks — `flex` against `flex flex-wrap`, and four words of
 * a comment — which is what a copy looks like just before it stops being one.
 * The two `Num` copies had already got there: one wrapped its figure in
 * `tabular-nums` and the other did not, so the same number was monospaced on
 * one analytics page and proportional on the page beside it, and each variant
 * re-decided its own rounding.
 *
 * `Num` IS THE POINT OF THIS FILE. The rule it carries — a figure the server
 * could not give is an em dash and NEVER a zero — is stated in prose in five
 * places in this codebase and was implemented in eight. It is implemented
 * here, once. A "0" where a measurement is missing is not a formatting
 * preference; it is the interface asserting something nobody measured, on
 * pages that exist to not do that.
 *
 * Components only, so the file keeps its fast refresh. The pure formatters are
 * in `@/lib/format`.
 */

/** Reading something, said as the thing being read rather than as a spinner
 *  alone — "reading reviews…" tells you which of four panels is slow. */
export function Loading({ what, className }: { what: ReactNode; className?: string }) {
  return (
    <p className={cn("text-muted-foreground flex items-center gap-2 text-[13px]", className)}>
      <Loader2 className="size-3.5 animate-spin" strokeWidth={1.6} /> reading {what}…
    </p>
  );
}

/**
 * The server's own words about why there is nothing to draw.
 *
 * NOT AN EMPTY STATE. A page that failed to load and a page with nothing on it
 * look identical if both are drawn as blank, and only one of them is worth
 * pressing reload for.
 */
export function Failed({ error, className }: { error: ReactNode; className?: string }) {
  return (
    <p className={cn("text-destructive flex items-start gap-2 text-[13px]", className)}>
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.6} /> {error}
    </p>
  );
}

/**
 * ONE FIGURE, OR AN EM DASH.
 *
 * Every number on these pages that could be absent goes through here, so a
 * null is a dash everywhere rather than a zero in the one place somebody
 * forgot. NaN counts as absent too: "NaN" on a dashboard is the same failure
 * as "0", one line further along.
 *
 * `tabular-nums` ALWAYS. Figures in a column that do not share a digit width
 * do not line up, and a list of counts that does not line up is read wrongly.
 */
export function Num({
  value,
  suffix,
  digits = 0,
  className,
}: {
  value: number | null | undefined;
  /** A unit drawn small after the figure — "%", "ms", " reviews". */
  suffix?: ReactNode;
  digits?: number;
  className?: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return <span className={cn("text-muted-foreground", className)}>—</span>;
  return (
    <span className={cn("tabular-nums", className)}>
      {value.toLocaleString(undefined, { maximumFractionDigits: digits })}
      {suffix ? <span className="text-muted-foreground text-[11px]">{suffix}</span> : null}
    </span>
  );
}

/**
 * The titled block those same pages put each answer in.
 *
 * `flex-wrap` on the heading row, because the meta line beside a title is
 * often a date range and a caveat; without it the two pages that copied this
 * wrapped differently at the same width while presenting themselves as the
 * same block.
 */
export function SectionCard({
  title,
  meta,
  children,
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-line-soft bg-card mb-4 rounded-xl border p-4", className)}>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-[14px] font-medium">{title}</h2>
        {meta && <span className="text-muted-foreground text-[11.5px]">{meta}</span>}
      </div>
      {children}
    </section>
  );
}
