import { HostMark } from "@/components/HostMark";
import type { SiteTile } from "@/data/widgets";
import { cn } from "@/lib/utils";

/**
 * ONE SMALL CARD PER WEBSITE — the Search board's "how is each site doing"
 * read at a glance: the favicon and the name, one figure large, its days as
 * bars, and three small figures under them. Everything arrives formatted.
 */
export function SiteTiles({ sites, caption }: { sites: SiteTile[]; caption?: string }) {
  return (
    <div className="mt-1">
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(172px,1fr))]">
        {sites.map((s) => (
          <div key={s.label} className="bg-background/60 flex min-w-0 flex-col gap-2 rounded-[12px] p-3">
            <div className="flex min-w-0 items-center gap-2">
              <HostMark host={s.host ?? s.label} size={20} fallback />
              <span className="truncate text-[13px] font-medium" title={s.label}>
                {s.label}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[22px] leading-none font-semibold tabular-nums">{s.value}</span>
              <span className="text-muted-foreground text-[11.5px]">{s.unit}</span>
              {s.change && (
                <span
                  className={cn(
                    "ml-auto text-[11.5px] tabular-nums",
                    s.change.good === true && "text-ok",
                    s.change.good === false && "text-bad",
                    s.change.good === null && "text-muted-foreground",
                  )}
                >
                  {s.change.text}
                </span>
              )}
            </div>
            {s.bars && s.bars.length > 1 && <TileBars values={s.bars} />}
            {s.figures && s.figures.length > 0 && (
              <div className="grid grid-cols-3 gap-1">
                {s.figures.slice(0, 3).map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <div className="truncate text-[12.5px] font-medium tabular-nums">{value}</div>
                    <div className="text-muted-foreground truncate text-[10.5px]">{label}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {caption && <p className="text-muted-foreground mt-2 text-[12px] leading-snug">{caption}</p>}
    </div>
  );
}

/** The site's days as bars, scaled to its own busiest day — a shape, not an
 *  axis: two tiles' bars are not comparable, the figures above them are. */
function TileBars({ values }: { values: number[] }) {
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
