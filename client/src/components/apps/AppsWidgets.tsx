import { Star } from "lucide-react";
import { VentureMark } from "@/components/VentureChrome";
import { useStore } from "@/lib/store";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AppEntry, AppReview } from "@/lib/api/apps";

/**
 * THE APPS BOARD'S OWN PIECES — the icon, the picker, the per-app cards and
 * the reviews — drawn from /api/mobilehealth/apps.
 *
 * THE PICKER IS THE BOARD'S FILTER. Choosing an app writes `?app=<key>` and
 * every Apps card narrows to it (see WidgetCard), so one click turns the
 * portfolio view into that app's page and the address can be sent.
 */

const n = (v: number) => v.toLocaleString();

/** The store icon when the app is released; the venture's favicon, then its
 *  initials, before that. */
export function AppIcon({ app, size = 20, className }: { app: Pick<AppEntry, "icon" | "name" | "ventureId">; size?: number; className?: string }) {
  const { state } = useStore();
  if (app.icon)
    return (
      <img
        src={app.icon}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 object-cover dark:ring-1 dark:ring-white/15", className)}
        style={{ width: size, height: size, borderRadius: size * 0.225 }}
      />
    );
  const venture =
    state.ventures.find((v) => v.id === app.ventureId) ??
    state.ventures.find((v) => app.name.toLowerCase().startsWith(v.name.toLowerCase()));
  if (venture) return <VentureMark venture={venture} size={size} className={className} />;
  return (
    <span
      aria-hidden
      className={cn("bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center font-medium", className)}
      style={{ width: size, height: size, borderRadius: size * 0.225, fontSize: size * 0.42 }}
    >
      {app.name.slice(0, 1)}
    </span>
  );
}

/** Short enough for a chip: "LLMAPI: AI Chat & API" → "LLMAPI". */
export const shortName = (name: string) => name.split(/[:–—]/)[0]!.trim();

export function Stars({ value, size = 12 }: { value: number; size?: number }) {
  return (
    <span className="inline-flex items-center gap-px" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={cn(value >= i - 0.25 ? "fill-amber-400 text-amber-400" : "text-border fill-transparent")}
          style={{ width: size, height: size }}
          strokeWidth={1.5}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------- the picker */

export function AppFilter({
  apps,
  selected,
  onPick,
}: {
  apps: AppEntry[];
  selected: string | null;
  onPick: (key: string | null) => void;
}) {
  const chip = (active: boolean) =>
    cn(
      "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] transition-colors",
      active ? "border-foreground bg-card" : "border-transparent bg-card/60 hover:bg-card",
    );
  return (
    <div role="group" aria-label="Filter the board by app" className="flex gap-1.5 overflow-x-auto pb-1">
      <button type="button" className={chip(selected === null)} onClick={() => onPick(null)}>
        All apps
        <span className="text-muted-foreground text-[11.5px]">{apps.length}</span>
      </button>
      {apps.map((a) => (
        <button
          key={a.key}
          type="button"
          title={a.name}
          className={chip(selected === a.key)}
          onClick={() => onPick(selected === a.key ? null : a.key)}
        >
          <AppIcon app={a} size={18} />
          {shortName(a.name)}
          {a.totals.ios + a.totals.android > 0 && (
            <span className="text-muted-foreground text-[11.5px] tabular-nums">{n(a.totals.ios + a.totals.android)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- the cards */

function storeState(a: AppEntry): { ios: string | null; iosTone: string; android: string | null } {
  const s = a.appstore;
  const ios = !s
    ? null
    : s.onStore
      ? "App Store"
      : (s.state ?? "not released").toLowerCase().replace(/_/g, " ");
  return { ios, iosTone: s?.onStore ? "text-ok" : "text-warn", android: a.play ? "Google Play" : null };
}

function MiniBars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-7 items-end gap-px" aria-hidden>
      {values.map((v, i) => (
        <span
          key={i}
          className="min-h-px flex-1 rounded-t-[1px]"
          style={{ height: `${(v / max) * 100}%`, background: "var(--chart-line-1)", opacity: v ? 0.85 : 0.2 }}
        />
      ))}
    </div>
  );
}

export function AppGrid({
  apps,
  selected,
  onPick,
}: {
  apps: AppEntry[];
  selected: string | null;
  onPick: (key: string | null) => void;
}) {
  return (
    <div className="mt-1 grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
      {apps.map((a) => {
        const s = storeState(a);
        const installs = a.totals.ios + a.totals.android;
        return (
          <button
            key={a.key}
            type="button"
            onClick={() => onPick(selected === a.key ? null : a.key)}
            className={cn(
              "bg-background/60 hover:bg-background flex flex-col gap-2 rounded-[12px] border p-3 text-left transition-colors",
              selected === a.key ? "border-foreground" : "border-transparent",
            )}
          >
            <div className="flex items-center gap-2.5">
              <AppIcon app={a} size={36} />
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-medium">{a.name}</div>
                <div className="text-muted-foreground flex flex-wrap gap-x-1.5 text-[11.5px]">
                  {s.ios && <span className={s.iosTone}>{s.ios}</span>}
                  {s.ios && s.android && <span>·</span>}
                  {s.android && <span className="text-ok">{s.android}</span>}
                </div>
              </div>
            </div>
            <div className="flex items-end justify-between gap-2">
              <div>
                <div className="text-[20px] leading-none font-semibold tabular-nums">{n(installs)}</div>
                <div className="text-muted-foreground mt-0.5 text-[11.5px]">
                  installs · iOS {n(a.totals.ios)} · Android {n(a.totals.android)}
                </div>
              </div>
            </div>
            <MiniBars values={a.daily.map((d) => d.ios + d.android)} />
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              {a.rating ? (
                <span className="inline-flex items-center gap-1">
                  <Stars value={a.rating.average} size={11} />
                  <span className="text-foreground tabular-nums">{a.rating.average.toFixed(1)}</span>
                  {a.rating.count !== null && <span>({n(a.rating.count)})</span>}
                </span>
              ) : (
                <span>no ratings yet</span>
              )}
              {a.reviews.count > 0 && <span>{a.reviews.count} reviews</span>}
              {a.stability && a.stability.crashes + a.stability.anrs > 0 && (
                <span className="text-warn">{a.stability.crashes + a.stability.anrs} crashes/ANRs</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------- the reviews */

export function ReviewList({ reviews, apps, limit = 8 }: { reviews: AppReview[]; apps: AppEntry[]; limit?: number }) {
  if (!reviews.length) return <p className="text-muted-foreground mt-1 text-[12.5px]">No reviews yet.</p>;
  const byKey = new Map(apps.map((a) => [a.key, a]));
  return (
    <div className="mt-1 flex flex-col divide-y">
      {reviews.slice(0, limit).map((r) => {
        const app = byKey.get(r.key);
        return (
          <div key={`${r.store}:${r.id}`} className="py-2.5 first:pt-0">
            <div className="flex items-center gap-2 text-[12px]">
              {app && <AppIcon app={app} size={16} />}
              <span className="font-medium">{app ? shortName(app.name) : r.key}</span>
              {r.rating !== null && <Stars value={r.rating} size={11} />}
              <span className="text-muted-foreground ml-auto shrink-0">
                {r.store === "appstore" ? "App Store" : "Play"}
                {r.territory ? ` · ${r.territory}` : ""}
                {r.created ? ` · ${ago(r.created)}` : ""}
              </span>
            </div>
            {r.title && <div className="mt-1 text-[13px] font-medium">{r.title}</div>}
            {r.body && <p className="text-foreground/85 mt-0.5 line-clamp-3 text-[13px] leading-snug">{r.body}</p>}
            {r.replied && <div className="text-muted-foreground mt-1 text-[11.5px]">replied</div>}
          </div>
        );
      })}
    </div>
  );
}
