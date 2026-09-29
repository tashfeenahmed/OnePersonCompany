import { useState, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { HostMark } from "@/components/HostMark";
import { VentureMark } from "@/components/VentureChrome";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { avatarHue, initials, TRIAGE_LABELS, triageKey, type Tone } from "@/lib/mailText";

/**
 * THE PIECES EVERY EMAIL TAB IS DRAWN FROM, so the tabs look like one app:
 * a sender avatar, a coloured chip, a row of filter chips, an empty state
 * that says what to do, and a fold for the technical small print.
 */

/* ------------------------------------------------------------------ avatar */

/**
 * A round initial for a person. When the address belongs to one of the
 * owner's own ventures the venture's favicon is drawn instead — mail from your
 * own product should look like your product.
 */
export function Avatar({
  name,
  address,
  size = 32,
  className,
}: {
  name: string;
  address?: string | null;
  size?: number;
  className?: string;
}) {
  const domain = (address ?? "").split("@")[1]?.replace(/>.*$/, "") ?? "";
  const hue = avatarHue(address || name);
  return (
    <span
      aria-hidden
      className={cn("relative inline-grid shrink-0 place-items-center rounded-full font-medium", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: `hsl(${hue} 55% 50% / 0.16)`,
        color: `hsl(${hue} 45% 42%)`,
      }}
    >
      {initials(name)}
      {domain && (
        <HostMark
          host={domain}
          size={Math.round(size * 0.5)}
          className="bg-background absolute -right-1 -bottom-1 rounded-[4px] ring-2 ring-[var(--background)]"
        />
      )}
    </span>
  );
}

/* ------------------------------------------------------------------- chips */

const TONE_VARIANT: Record<Tone, "destructive" | "warn" | "ok" | "muted"> = {
  bad: "destructive",
  warn: "warn",
  ok: "ok",
  muted: "muted",
};

/** A small coloured label. */
export function ToneChip({
  tone,
  children,
  title,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <Badge variant={TONE_VARIANT[tone]} title={title} className={cn("font-normal", className)}>
      {children}
    </Badge>
  );
}

/** What the sorter made of a thread: "Needs reply", "FYI", "Newsletter"… */
export function TriageChip({
  score,
  urgency,
  className,
}: {
  score: string | null | undefined;
  urgency?: string | null;
  className?: string;
}) {
  const t = TRIAGE_LABELS[triageKey(score)];
  return (
    <>
      <ToneChip tone={t.tone} title={t.hint} className={className}>
        {t.short}
      </ToneChip>
      {urgency === "high" && (
        <ToneChip tone="bad" title="Marked urgent when sorted" className={className}>
          Urgent
        </ToneChip>
      )}
    </>
  );
}

/** A venture a message belongs to, as its favicon and name. Pass the venture's
 *  domain as `host`, or its id as `ventureId`. */
export function VentureTag({ host, ventureId, name }: { host?: string | null; ventureId?: string | null; name: string }) {
  const { state } = useStore();
  const venture = ventureId ? state.ventures.find((v) => v.id === ventureId) : undefined;
  return (
    <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-[12px]">
      {venture ? <VentureMark venture={venture} size={13} /> : host && <HostMark host={host} size={13} />}
      <span className="truncate">{name}</span>
    </span>
  );
}

/* ------------------------------------------------------------ filter chips */

export type FilterChip<K extends string> = {
  key: K;
  label: string;
  count?: number;
  /** A count worth noticing is drawn in the alert colour. */
  urgent?: boolean;
  title?: string;
};

/** One-of-many filter, drawn as rounded chips with counts. Scrolls sideways on
 *  a phone rather than wrapping into three rows. */
export function FilterChips<K extends string>({
  chips,
  value,
  onChange,
  className,
  label,
}: {
  chips: FilterChip<K>[];
  value: K;
  onChange: (key: K) => void;
  className?: string;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-1", className)}>
      {chips.map((c) => {
        const active = c.key === value;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={active}
            title={c.title}
            onClick={() => onChange(c.key)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] whitespace-nowrap transition-colors",
              active
                ? "bg-foreground text-background border-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground border-line-soft",
            )}
          >
            {c.label}
            {c.count !== undefined && (
              <span
                className={cn(
                  "min-w-[1.25rem] rounded-full px-1.5 text-center text-[11.5px] tabular-nums",
                  active
                    ? "bg-background/20"
                    : c.urgent && c.count > 0
                      ? "bg-destructive/15 text-destructive"
                      : "bg-muted",
                )}
              >
                {c.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ empty states */

/** Nothing to show — said kindly, with what to do next. */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-12 text-center", className)}>
      {Icon && (
        <span className="bg-muted mb-3 grid size-10 place-items-center rounded-full">
          <Icon className="text-muted-foreground size-5" strokeWidth={1.6} />
        </span>
      )}
      <p className="text-[15px] font-medium">{title}</p>
      {body && <p className="text-muted-foreground mt-1 max-w-sm text-[13.5px] leading-relaxed">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A link styled as a button, for empty states that point somewhere. */
export function LinkButton({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="hover:bg-accent border-line-soft inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13.5px]"
    >
      {children}
    </Link>
  );
}

/* --------------------------------------------------------------- the fold */

/** Technical and diagnostic detail, folded away by default. The contents are
 *  only mounted once opened, so a fold can hold something that fetches. */
export function SmallPrint({
  summary = "Details",
  children,
  className,
}: {
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={cn("group text-muted-foreground text-[12.5px]", className)}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="hover:text-foreground flex cursor-pointer list-none items-center gap-1 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" strokeWidth={1.6} />
        {summary}
      </summary>
      {open && <div className="mt-2 space-y-1.5 pl-[18px] leading-relaxed">{children}</div>}
    </details>
  );
}

/** A red line for something that went wrong, in the server's own words. */
export function Problem({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={cn("text-destructive text-[13.5px] leading-relaxed", className)}>
      {children}
    </p>
  );
}
