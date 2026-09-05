import type { ReactNode } from "react";
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
        <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
          {title}
        </div>
        {meta && (
          <span className="text-muted-foreground ml-auto text-[11.5px]">{meta}</span>
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

/** The row of big figures. Each takes a value already formatted by the panel —
 *  this component never touches a number, so it cannot round one. */
export function Tiles({ items }: { items: { v: ReactNode; k: string; title?: string }[] }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {items.map((t) => (
        <div
          key={t.k}
          title={t.title}
          className="bg-card min-w-[132px] flex-1 rounded-[10px] border px-3.5 py-3"
        >
          <div className="text-[19px] font-normal tracking-[-0.03em] tabular-nums">
            {t.v}
          </div>
          <div className="text-muted-foreground mt-0.5 text-[11.5px]">{t.k}</div>
        </div>
      ))}
    </div>
  );
}

/** The bordered list every panel puts its per-thing rows in. */
export function Rows({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden rounded-[10px] border">{children}</div>;
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
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="text-muted-foreground min-w-0 truncate font-mono">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {meter ? `${meter.percent}%` : <span className="text-muted-foreground">not read</span>}
        </span>
        {right && <span className="text-muted-foreground shrink-0 text-[11.5px]">{right}</span>}
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
    <p className="text-muted-foreground mt-2.5 text-[11.5px] leading-relaxed">
      {children}
    </p>
  );
}

/** The state every one of these panels can be in: connected, and the last
 *  collection found nothing. Said as a sentence rather than drawn as an empty
 *  table, which reads as a failure to load. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <>
      <Separator className="mt-7 mb-5" />
      <p className="text-muted-foreground text-[13px]">{children}</p>
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
          <span className="text-muted-foreground text-[12px]">{nothing}</span>
        )}
        {problem && <span className="text-destructive text-[12px]">{problem}</span>}
      </div>

      {!!items?.length && (
        <div className="mt-2 rounded-[10px] border p-3.5">
          <div className="mb-1.5 text-[12.5px] font-medium">
            {items.length} {noun}
            {items.length === 1 ? "" : "s"} not on the list yet
          </div>
          <p className="text-muted-foreground font-mono text-[11.5px] leading-relaxed">
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
