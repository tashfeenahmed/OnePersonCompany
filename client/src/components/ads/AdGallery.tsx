import { useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AdCard } from "@/data/widgets";

/**
 * THE ADVERTISEMENTS THEMSELVES, as people saw them — the picture first, the
 * words under it, and four numbers. The owner's favourite part of the Ads
 * board, so it gets the room: big images in a grid rather than a feed row.
 *
 * A PICTURE THAT FAILS KEEPS ITS BOX. Meta's image URLs are signed and expire
 * within days; a card that collapsed when one did would reflow the grid and
 * read as "this ad had no picture".
 */
function Picture({ src, alt }: { src: string | null; alt: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="bg-muted relative aspect-[1.91/1] w-full overflow-hidden rounded-t-[12px]">
      {src && !broken ? (
        <img src={src} alt={alt} loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : (
        <div className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-1 text-[12px]">
          <ImageOff className="size-5" strokeWidth={1.5} />
          {src ? "image link expired" : "no image"}
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-ok/15 text-ok",
  paused: "bg-muted text-muted-foreground",
  "not running": "bg-warn/15 text-warn",
};

export function AdGallery({ ads, caption }: { ads: AdCard[]; caption?: string }) {
  if (!ads.length) return <p className="text-muted-foreground mt-1 text-[13px]">No advertisements yet.</p>;
  return (
    <div className="mt-1">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
        {ads.map((a) => (
          <article key={a.id} className="bg-background/60 flex flex-col overflow-hidden rounded-[12px] border border-transparent">
            <Picture src={a.image} alt={a.title ?? a.name} />
            <div className="flex flex-1 flex-col gap-1.5 p-3">
              <div className="flex items-center gap-2">
                <span className={cn("rounded-full px-2 py-px text-[11px] font-medium", STATUS_TONE[a.status] ?? STATUS_TONE.paused)}>{a.status}</span>
                {a.cta && <span className="text-muted-foreground truncate text-[11.5px]">{a.cta}</span>}
              </div>
              <h3 className="line-clamp-2 text-[14px] leading-snug font-semibold">{a.title ?? a.name}</h3>
              {a.body && <p className="text-foreground/80 line-clamp-3 text-[13px] leading-snug">{a.body}</p>}
              {a.stats.length > 0 ? (
                <div className="mt-auto grid grid-cols-4 gap-1 border-t pt-2">
                  {a.stats.map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <div className="truncate text-[14px] font-semibold tabular-nums">{value}</div>
                      <div className="text-muted-foreground text-[11px]">{label}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground mt-auto border-t pt-2 text-[12px]">never delivered</div>
              )}
            </div>
          </article>
        ))}
      </div>
      {caption && <p className="text-muted-foreground mt-2 text-[12px]">{caption}</p>}
    </div>
  );
}
