import { HostMark } from "@/components/HostMark";
import { VentureMark } from "@/components/VentureChrome";
import type { SiteCard } from "@/data/widgets";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * EVERY WEBSITE AS A SMALL CARD — the SEO board's picture of the portfolio.
 *
 * The favicon and the name, the audit's letter in a ring, the search clicks
 * with their own line, and three small figures under a rule. Read across the
 * grid, not down a table: which site is healthy, which is earning, which is
 * neither.
 *
 * THE RING IS A LETTER, NOT A SCORE. It fills by grade (A whole, D a
 * quarter) so the eye finds the bad ones; the rule behind the letter is the
 * builder's and is on the card's caption.
 */
const GRADE_TONE: Record<string, string> = {
  A: "text-ok",
  B: "text-ok",
  C: "text-warn",
  D: "text-destructive",
};
const GRADE_FILL: Record<string, number> = { A: 1, B: 0.75, C: 0.5, D: 0.25 };

function Ring({ grade }: { grade: SiteCard["grade"] }) {
  const R = 15;
  const C = 2 * Math.PI * R;
  const fill = grade ? GRADE_FILL[grade]! : 0;
  return (
    <div className={cn("relative size-[38px] shrink-0", grade ? GRADE_TONE[grade] : "text-muted-foreground")}>
      <svg viewBox="0 0 38 38" className="size-full -rotate-90" aria-hidden>
        <circle cx="19" cy="19" r={R} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={4} />
        {fill > 0 && (
          <circle
            cx="19"
            cy="19"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={`${C * fill} ${C}`}
          />
        )}
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[14px] font-semibold">{grade ?? "–"}</span>
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const W = 100;
  const H = 22;
  const max = Math.max(...values, 1);
  const pts = values
    .map((v, i) => `${((i / Math.max(1, values.length - 1)) * W).toFixed(1)},${(H - 1 - (v / max) * (H - 2)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[22px] w-full" style={{ color: "var(--chart-line-1)" }} aria-hidden>
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="currentColor" opacity={0.12} />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function Mark({ venture, host, size }: { venture?: string | null; host: string; size: number }) {
  const { state } = useStore();
  const v = venture ? state.ventures.find((x) => x.id === venture) : undefined;
  return v ? <VentureMark venture={v} size={size} /> : <HostMark host={host} size={size} />;
}

export function SiteGrid({
  sites,
  quiet,
  caption,
}: {
  sites: SiteCard[];
  quiet?: { name: string; host: string; venture?: string | null }[];
  caption?: string;
}) {
  if (!sites.length && !quiet?.length) return <p className="text-muted-foreground mt-1 text-[13px]">No sites yet.</p>;
  return (
    <div className="mt-1">
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
        {sites.map((s) => (
          <article key={s.host} className="bg-background/60 flex flex-col gap-2 rounded-[12px] p-3">
            <div className="flex items-center gap-2">
              <Mark venture={s.venture} host={s.host} size={20} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] leading-tight font-semibold">{s.name}</div>
                <div className="text-muted-foreground truncate text-[11.5px] leading-tight">{s.gradeNote}</div>
              </div>
              <Ring grade={s.grade} />
            </div>
            <div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[20px] leading-none font-semibold tracking-[-0.02em] tabular-nums">{s.clicks}</span>
                <span className="text-muted-foreground text-[11.5px]">clicks</span>
                {s.change !== null && (
                  <span
                    className={cn(
                      "ml-auto text-[11.5px] font-medium tabular-nums",
                      s.change > 0 ? "text-ok" : s.change < 0 ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {s.change > 0 ? "▲" : s.change < 0 ? "▼" : ""} {Math.abs(Math.round(s.change * 100))}%
                  </span>
                )}
              </div>
              <div className="mt-1">{s.spark && s.spark.length > 1 ? <Spark values={s.spark} /> : <div className="h-[22px]" />}</div>
            </div>
            <div className="grid grid-cols-3 gap-1 border-t pt-2">
              {s.stats.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <div className="truncate text-[13px] font-semibold tabular-nums">{value}</div>
                  <div className="text-muted-foreground truncate text-[10.5px]">{label}</div>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
      {!!quiet?.length && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-[12px]">No search traffic yet:</span>
          {quiet.map((q) => (
            <span key={q.host} className="bg-background/60 flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1 text-[12px]">
              <Mark venture={q.venture} host={q.host} size={14} />
              {q.name}
            </span>
          ))}
        </div>
      )}
      {caption && <p className="text-muted-foreground mt-2 text-[12px]">{caption}</p>}
    </div>
  );
}
