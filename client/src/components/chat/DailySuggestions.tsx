import { useEffect } from "react";
import { Activity, Bot, ClipboardList, Lightbulb, NotebookPen, Sparkles, TriangleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
import type { HomeSuggestion, HomeSuggestions } from "../../../../shared/homeSuggestions";

const icons = { alert: TriangleAlert, board: ClipboardList, report: Bot, activity: Activity, venture: Lightbulb, journal: NotebookPen, workspace: Sparkles };

export function DailySuggestions({ ventureId, onChoose }: { ventureId: string | null; onChoose: (suggestion: HomeSuggestion) => void }) {
  const suggestions = useApi(() => {
    const query = new URLSearchParams({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    if (ventureId) query.set("venture", ventureId);
    return call<HomeSuggestions>(`/home/suggestions?${query}`);
  }, [ventureId]);
  const { reload } = suggestions;

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") reload(); };
    // Covers midnight in the workspace's zone and work finished in another tab.
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("opc:data-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("opc:data-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload]);

  if (suggestions.error) return <p className="text-muted-foreground text-sm" role="status">
    Today’s suggestions couldn’t load. <button className="underline underline-offset-2" onClick={suggestions.reload}>Try again</button>
  </p>;

  return <div className="grid gap-2 sm:grid-cols-2" aria-label="Daily suggestions" aria-busy={!suggestions.data}>
    {!suggestions.data ? Array.from({ length: 6 }, (_, i) => <div key={i} className="bg-card h-32 animate-pulse rounded-[14px] motion-reduce:animate-none" aria-hidden="true" />) : suggestions.data.suggestions.map(s => {
      const Icon = icons[s.kind];
      return <div key={s.id} className="bg-card hover:bg-card-hover min-w-0 rounded-[14px] transition-colors">
        <button type="button" onClick={() => onChoose(s)} className="focus-visible:ring-ring flex w-full items-start gap-2.5 rounded-[14px] px-4 py-3 text-left focus-visible:ring-2 focus-visible:outline-none" aria-label={s.title}>
          <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" strokeWidth={1.6} aria-hidden="true" />
          <span className="min-w-0">
            <span className="line-clamp-2 text-[14px] font-medium tracking-tight" title={s.title}>{s.title}</span>
            <span className="text-muted-foreground mt-1 line-clamp-2 text-[12.5px]" title={s.reason}>{s.reason}</span>
          </span>
        </button>
        <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-4 pb-3 pl-[42px] text-[11px]">
          <Link to={s.source.href} className="hover:text-foreground shrink-0 underline-offset-2 hover:underline">{s.source.label}</Link>
          {s.ventureName && <><span aria-hidden="true">·</span><span className="truncate" title={s.ventureName}>{s.ventureName}</span></>}
        </div>
      </div>;
    })}
  </div>;
}
