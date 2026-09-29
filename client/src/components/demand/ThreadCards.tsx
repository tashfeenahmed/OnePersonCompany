import { useState } from "react";
import { ArrowUpRight, MessageCircle, ThumbsUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThreadCard } from "@/data/widgets";

/**
 * CONVERSATIONS AS CARDS, one thread per card: where and when, the title,
 * the post's own words, and what it has drawn. Read at 14–15px rather than a
 * feed's 12.5, because these are the rows somebody reads to decide whether to
 * reply.
 */
const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const rel = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `${rel} · ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
};

function Card({ t }: { t: ThreadCard }) {
  const [open, setOpen] = useState(false);
  const long = (t.body?.length ?? 0) > 360;
  return (
    <article
      className={cn(
        "bg-background/60 flex flex-col gap-2 rounded-[12px] border p-4",
        t.unanswered ? "border-warn/40" : "border-transparent",
      )}
    >
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
        <span
          className={cn(
            "rounded-[5px] px-1.5 py-px text-[11px] font-medium text-white",
            t.source === "Reddit" ? "bg-[#ff4500]" : "bg-[#ff6600]",
          )}
        >
          {t.source === "Reddit" ? "Reddit" : "HN"}
        </span>
        <span className="text-foreground font-medium">{t.where}</span>
        {when(t.createdAt) && <span>{when(t.createdAt)}</span>}
        {t.unanswered && <span className="text-warn ml-auto font-medium">no replies yet</span>}
      </div>
      <h3 className="text-[15px] leading-snug font-semibold">{t.title}</h3>
      {t.body ? (
        <p className={cn("text-foreground/85 text-[14px] leading-relaxed whitespace-pre-line", !open && long && "line-clamp-6")}>
          {t.body}
        </p>
      ) : (
        <p className="text-muted-foreground text-[13px] italic">A link post — the conversation is in the replies.</p>
      )}
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-muted-foreground hover:text-foreground self-start text-[12.5px] underline underline-offset-2">
          {open ? "Show less" : "Read more"}
        </button>
      )}
      <div className="text-muted-foreground mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[12.5px]">
        {t.points !== null && (
          <span className="inline-flex items-center gap-1"><ThumbsUp className="size-3.5" strokeWidth={1.7} />{t.points}</span>
        )}
        {t.comments !== null && (
          <span className="inline-flex items-center gap-1"><MessageCircle className="size-3.5" strokeWidth={1.7} />{t.comments}</span>
        )}
        <span className="bg-muted rounded-full px-2 py-px text-[11.5px]">“{t.term}”</span>
        <a href={t.url} target="_blank" rel="noreferrer" className="hover:text-foreground ml-auto inline-flex items-center gap-0.5 font-medium underline underline-offset-2">
          Open thread <ArrowUpRight className="size-3.5" strokeWidth={1.8} />
        </a>
      </div>
    </article>
  );
}

export function ThreadCards({ threads, caption }: { threads: ThreadCard[]; caption?: string }) {
  if (!threads.length) return <p className="text-muted-foreground mt-1 text-[13px]">Nothing here right now.</p>;
  return (
    <div className="mt-1">
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
        {threads.map((t) => <Card key={`${t.source}:${t.url}`} t={t} />)}
      </div>
      {caption && <p className="text-muted-foreground mt-2 text-[12px]">{caption}</p>}
    </div>
  );
}
