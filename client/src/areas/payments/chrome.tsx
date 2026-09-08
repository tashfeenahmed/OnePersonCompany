import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { money, pct, splitMoney } from "@/lib/format";

/**
 * THE FURNITURE OF THE PAYMENTS PAGE, in one file so the eleven cards cannot
 * disagree about what a section label or a figure looks like.
 *
 * MONEY SETS ITS CENTS A SIZE DOWN, the way the Costs board does: a currency
 * figure at 36px with cents at the same size reads as a six-digit number, and
 * the reader's eye has to find the point. `Money` is that rule; everything
 * else here is a card shell or a coloured swatch.
 *
 * EVERY TAG SAYS WHAT KIND OF NUMBER SITS BESIDE IT. "now" is a level — the
 * book as it stands, which the window control does not move. "approx" is a
 * figure computed on the customers' cash flow rather than reported by Stripe.
 * "floor" is a lower bound. A number without a tag is a sum over the window.
 */

export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: "warn" }) {
  return (
    <div
      className={cn(
        "bg-card rounded-[14px] px-4.5 py-3.5",
        tone === "warn" && "border-warn/40 border",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHead({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-start gap-x-3 gap-y-1">
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px] font-medium">{title}</div>
        {sub && <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-snug">{sub}</div>}
      </div>
      {action && <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-7 mb-3 flex items-baseline gap-2.5">
      <h2 className="text-muted-foreground text-[11px] font-semibold tracking-[0.09em] uppercase">{children}</h2>
      <span aria-hidden className="bg-line-soft h-px flex-1" />
    </div>
  );
}

/** A currency figure with its cents set smaller. `size` is the whole-number
 *  size; the cents are always 55% of it. */
export function Money({
  value,
  currency,
  size = 36,
  className,
}: {
  value: number | null | undefined;
  currency: string;
  size?: number;
  className?: string;
}) {
  const text = money(value, currency);
  const split = splitMoney(text);
  return (
    <span
      className={cn("font-semibold tracking-[-0.03em] tabular-nums", className)}
      style={{ fontSize: size, lineHeight: 1.1 }}
      title={text}
    >
      {split ? (
        <>
          {split.whole}
          <span className="text-muted-foreground font-semibold" style={{ fontSize: Math.round(size * 0.55) }}>
            {split.cents}
          </span>
        </>
      ) : (
        text
      )}
    </span>
  );
}

const TAG_TITLES = {
  now: "A level, not a window: the book as it stands this minute. The window control at the top does not move this figure.",
  approx: "Computed on the customers' cash flow from subscription prices, not a number Stripe reports. The basis is printed beside it.",
  floor: "A lower bound. Something in this figure has a count and no price, so the true amount is at least this and never more precise.",
  metered: "Summed over the window from Stripe's own records — charges dated by the attempt, or the balance ledger dated by the posting.",
} as const;

export function Tag({ kind, title }: { kind: keyof typeof TAG_TITLES; title?: string }) {
  return (
    <span
      className="border-line-soft text-muted-foreground rounded-full border px-1.5 py-px text-[10.5px] font-medium tracking-wide"
      title={title ?? TAG_TITLES[kind]}
    >
      {kind}
    </span>
  );
}

/** A swatch, a word, and optionally the figure it stands for. */
export function Key({ color, label, children }: { color?: string; label: string; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]">
      {color && <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />}
      <span className="text-muted-foreground">{label}</span>
      {children !== undefined && <b className="font-semibold tabular-nums">{children}</b>}
    </span>
  );
}

export type Part = { label: string; value: number; color: string };

/**
 * One bar split into parts, each proportional to its share of the total.
 * Parts with nothing in them draw nothing; a bar whose total is zero draws
 * nothing at all rather than an empty rail suggesting a measurement.
 */
export function ProportionBar({ parts, label, height = 8 }: { parts: Part[]; label: string; height?: number }) {
  const total = parts.reduce((n, p) => n + Math.max(0, p.value), 0);
  if (total <= 0) return null;
  return (
    <div
      role="img"
      aria-label={`${label}: ${parts.map((p) => `${p.label} ${pct(p.value / total)}`).join(", ")}`}
      className="mt-2 flex w-full overflow-hidden rounded-full"
      style={{ height }}
    >
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <span
            key={p.label}
            title={`${p.label} · ${pct(p.value / total)}`}
            style={{ width: `${(p.value / total) * 100}%`, background: p.color }}
            className="h-full"
          />
        ))}
    </div>
  );
}

/** One line of a card's list: a label on the left, a figure on the right. */
export function Row({
  label,
  value,
  tone,
  sub,
  indent,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "ok" | "warn" | "bad";
  sub?: ReactNode;
  indent?: boolean;
}) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1 text-[13.5px]", indent && "pl-3")}>
      <div className="min-w-0">
        <div className={cn("truncate", indent && "text-muted-foreground text-[13px]")}>{label}</div>
        {sub && <div className="text-muted-foreground text-[12px] leading-snug">{sub}</div>}
      </div>
      <div
        className={cn(
          "shrink-0 tabular-nums",
          tone === "ok" && "text-ok",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** A bordered group inside a card: rows that belong together, set apart. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("border-line-soft mt-2 border-t pt-2", className)}>{children}</div>;
}

/** The sentence under a figure that says how it was made. */
export function Basis({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-muted-foreground mt-2 text-[12px] leading-relaxed", className)}>{children}</p>;
}
