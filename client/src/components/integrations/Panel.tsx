import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * THE FURNITURE EVERY INTEGRATION PANEL SHARES, and the reason it is shared.
 *
 * HetznerPanel wrote all of this by hand, which was right when it was the only
 * one. Ten more panels writing it by hand would be ten separators at ten
 * paddings, and — worse — ten chances for one of them to draw a null as a nought
 * because nobody looked at what the others did with it. So the SHAPE is here
 * and the SENTENCES stay in each panel: every panel still says what its own
 * figures mean and what they cannot mean.
 *
 * Components only, so the file keeps its fast refresh. The formatting helpers
 * live in ./format.ts beside it.
 */

/** A titled block: the rule, the uppercase heading, the freshness line on the
 *  right and an optional "Collect now". */
export function PanelSection({
  title,
  meta,
  onCollect,
  collecting,
  children,
}: {
  title: string;
  meta?: ReactNode;
  onCollect?: () => void;
  collecting?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          {title}
        </div>
        {meta && (
          <span className="text-muted-foreground ml-auto text-[12.5px]">{meta}</span>
        )}
        {onCollect && (
          <Button
            variant="outline"
            size="sm"
            className={meta ? undefined : "ml-auto"}
            onClick={onCollect}
            disabled={collecting}
          >
            <RefreshCw
              className={cn("size-3.5", collecting && "animate-spin")}
              strokeWidth={1.8}
            />
            {collecting ? "Collecting…" : "Collect now"}
          </Button>
        )}
      </div>
      {children}
    </>
  );
}

/** One tile. The VALUE IS ALREADY FORMATTED by the caller — this component
 *  never touches a number, so it cannot round one, and a caller that means
 *  "nothing was measured" passes an em dash rather than a nought. */
export type Tile = {
  v: ReactNode;
  /** The label under the figure, and the row's key. */
  k: string;
  /** The hover sentence: what this figure is of, or why it is missing. */
  title?: string;
  /** A tile whose value is WORDS rather than a figure — "not counted", a list
   *  of locations, a provider's name. Drawn a size down and truncated to one
   *  line, and without `tabular-nums`, which lines up digits and nothing else.
   *  Pass the full text as `title` so the truncation costs the reader nothing. */
  text?: boolean;
};

/**
 * THE ROW OF BIG FIGURES.
 *
 * ONE GEOMETRY, and it is a decision rather than a default. A tile row drawn
 * locally picks its own minimum width and figure size, so rows on adjacent
 * pages line up with neither each other nor the window they wrap at — and
 * `tabular-nums` is the easiest of the three to drop, while being the only one
 * making a column of figures readable as a column.
 *
 * `flex-1` WITH A MINIMUM rather than a grid: these rows carry between two and
 * six tiles depending on what the server could answer, and a fixed column
 * count would leave a hole where an absent figure used to be.
 */
export function Tiles({ items, className }: { items: Tile[]; className?: string }) {
  return (
    <div className={cn("mb-4 flex flex-wrap gap-2", className)}>
      {items.map((t) => (
        <div
          key={t.k}
          title={t.title}
          className="bg-card min-w-[132px] flex-1 rounded-[14px] px-4.5 py-3.5"
        >
          <div
            className={cn(
              "font-normal",
              t.text
                ? "truncate text-[16px] tracking-[-0.02em]"
                : "text-[20px] tracking-[-0.03em] tabular-nums",
            )}
          >
            {t.v}
          </div>
          <div className="text-muted-foreground mt-0.5 text-[12.5px]">{t.k}</div>
        </div>
      ))}
    </div>
  );
}

/** The bordered list every panel puts its per-thing rows in. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-[14px] bg-card">{children}</div>;
}

export function Row({
  children,
  first,
  className,
}: {
  children: ReactNode;
  first?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-3.5 py-2.5",
        !first && "border-line-soft border-t",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A used/free bar.
 *
 * NULL DRAWS NOTHING. An empty bar and a bar at 0% look identical, and one of
 * them means "this box did not answer" — so a missing meter renders the reason
 * as words instead of an encouragingly empty trough.
 */
export function MeterBar({
  meter,
  label,
  right,
}: {
  meter: { percent: number; level: string } | null;
  label: string;
  right?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="text-muted-foreground min-w-0 truncate font-mono">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {meter ? `${meter.percent}%` : <span className="text-muted-foreground">not read</span>}
        </span>
        {right && <span className="text-muted-foreground shrink-0 text-[12.5px]">{right}</span>}
      </div>
      <div className="bg-accent mt-1 h-1.5 overflow-hidden rounded-full">
        {meter && (
          <div
            className={cn(
              "h-full rounded-full",
              meter.level === "critical"
                ? "bg-destructive"
                : meter.level === "warn"
                  ? "bg-amber-500"
                  : "bg-ok",
            )}
            style={{ width: `${Math.min(100, Math.max(1, meter.percent))}%` }}
          />
        )}
      </div>
    </div>
  );
}

/** The grey folded line panels use for a source's own caveat — the same
 *  treatment tool call lines get, because both are the machine's own words. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="text-muted-foreground mt-2.5 text-[12.5px] leading-relaxed">
      {children}
    </p>
  );
}

/**
 * NOTHING HERE YET — said in words.
 *
 * NOT DRAWN AS A BLANK. A list that failed to load and a list with nothing in
 * it look identical when both are empty space, and only one of them is worth
 * pressing reload for. So this state always says which it is, in the caller's
 * own sentence: "connected, and the last collection found nothing" is a
 * different thing from "not connected", and both are different from an error.
 *
 * TWO PLACEMENTS, ONE IDEA. The default follows a section rule, because on an
 * integration panel this stands in place of a whole `PanelSection`. `boxed`
 * draws the dashed placeholder instead, for an empty state INSIDE a section —
 * a column with no cards, a dashboard with no widgets — where it has to occupy
 * the space the list would have taken or the page jumps when the first row
 * arrives. Four copies of that box had drifted to four paddings; this is one.
 *
 * THE ACTION IS THE POINT WHERE THERE IS ONE. Most of these states are
 * ordinary — nothing has happened yet — but a few are one press from being
 * fixed, and a sentence that names the fix without linking to it makes the
 * reader go and find it.
 */
export function PanelEmpty({
  children,
  action,
  boxed,
  className,
}: {
  children: ReactNode;
  /** The one press that would end this state. */
  action?: { to: string; label: string };
  boxed?: boolean;
  className?: string;
}) {
  const link = action && (
    <Link
      to={action.to}
      className="text-foreground hover:bg-accent ml-auto shrink-0 rounded-lg border px-2.5 py-1"
    >
      {action.label}
    </Link>
  );

  /* The row only becomes a flex row when there is something to push to the
     far end of it. Without that guard a sentence containing a link or an
     emphasis would have each of its parts laid out as a flex item, breaking
     the one thing this component draws. */
  if (boxed)
    return (
      <div
        className={cn(
          "border-line-soft text-muted-foreground rounded-[14px] border border-dashed px-4 py-6 text-[13.5px]",
          action ? "flex items-center gap-3" : "text-center",
          className,
        )}
      >
        {children}
        {link}
      </div>
    );

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <p
        className={cn(
          "text-muted-foreground text-[14px]",
          action && "flex items-center gap-3",
          className,
        )}
      >
        {children}
        {link}
      </p>
    </>
  );
}

/**
 * "SUGGEST FROM VENTURES" — the two-step shape, shared by the three plugins
 * whose entire configuration is a list.
 *
 * TWO STEPS, ALWAYS, and the first one writes nothing. This box's whole reason
 * to exist is that the list is the configuration: uptime checks what is in it,
 * backlinks asks about what is in it, presence looks up what is in it. A button
 * that filled that field from a guess would start measuring things nobody
 * chose — and the Cloudflare half in particular offers every zone on the
 * account, most of which are parked domains with nothing on them. So the
 * candidates are SHOWN, in full, and adding them is a second press.
 *
 * The suggestions are also only ever appended. Nothing here removes a line the
 * owner typed, because a list they curated is a decision and this is a guess.
 */
export function Suggest({
  items,
  onSuggest,
  onAdd,
  busy,
  noun,
  nothing,
  note,
  problem,
}: {
  /** Null before anybody asked; empty means asked and there was nothing. */
  items: string[] | null;
  onSuggest: () => void;
  onAdd: () => void;
  busy: boolean;
  noun: string;
  nothing: string;
  note?: ReactNode;
  problem: string | null;
}) {
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onSuggest} disabled={busy}>
          <Sparkles className="size-3.5" strokeWidth={1.8} />
          Suggest from ventures
        </Button>
        {items !== null && !items.length && (
          <span className="text-muted-foreground text-[13px]">{nothing}</span>
        )}
        {problem && <span className="text-destructive text-[13px]">{problem}</span>}
      </div>

      {!!items?.length && (
        <div className="mt-2 rounded-[14px] bg-card p-3.5">
          <div className="mb-1.5 text-[13.5px] font-medium">
            {items.length} {noun}
            {items.length === 1 ? "" : "s"} not on the list yet
          </div>
          <p className="text-muted-foreground font-mono text-[12.5px] leading-relaxed">
            {items.join(" · ")}
          </p>
          {note && <Note>{note}</Note>}
          <Button size="sm" className="mt-3" onClick={onAdd} disabled={busy}>
            {busy ? "Saving…" : `Add all ${items.length} to the list`}
          </Button>
        </div>
      )}
    </div>
  );
}
