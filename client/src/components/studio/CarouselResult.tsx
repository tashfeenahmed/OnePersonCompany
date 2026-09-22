import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, CircleDashed, Download, GalleryHorizontal, Loader2, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { publishingApi } from "@/areas/publishing/api";
import { useApi } from "@/hooks/useApi";
import { carouselApi, type Carousel, type CarouselSlide, type SlideVerdict } from "@/lib/api/carousel";
import { cn } from "@/lib/utils";

/**
 * SIX SLIDES, IN ORDER, EACH WITH WHAT THE CHECKS SAID ABOUT IT.
 *
 * THE VERDICT IS ON THE SLIDE, NOT IN A LOG. A carousel whose fourth slide
 * failed its check twice is still six pictures, and the one that failed is the
 * one somebody should look at before posting — so every slide carries its own
 * badge and, under it, the issues in the checker's words. "Unverified" is drawn
 * as a dashed circle and never as a tick: nobody looked at that picture.
 *
 * "SEND TO PUBLISHING" FILES ONE DRAFT HOLDING ALL SIX, in order — one post,
 * not six. Like the image post card's button it chooses no destination: the
 * queue does that, and refuses the places that cannot take a carousel (TikTok,
 * and Instagram while the slides are PNG) rather than posting slide one. It is
 * offered only when all six pictures exist; the server refuses anything less.
 * The slides still download one at a time or as a zip.
 *
 * WHILE THE RUN IS MOVING this is re-read whenever the parent's `version`
 * changes — the count of finished steps — so each slide appears as it lands
 * rather than all six at the end.
 */
export function CarouselResult({ runId, version = 0, onDelete }: { runId: string; version?: number; onDelete?: () => Promise<void> }) {
  const doc = useApi(() => carouselApi.get(runId).catch(() => null), [runId, version]);
  /* The last answer stays on screen while the next is fetched, so a slide
     landing does not blank the five already drawn. */
  const [shown, setShown] = useState<Carousel | null>(null);
  if (doc.data && doc.data !== shown) setShown(doc.data);
  const c = doc.data ?? (shown?.runId === runId ? shown : null);
  if (!c) return null;
  return <CarouselPanel carousel={c} onDelete={onDelete} />;
}

const VERDICT: Record<SlideVerdict, { label: string; icon: typeof CheckCircle2; className: string }> = {
  pass: { label: "Passed the checks", icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400" },
  fail: { label: "Failed a check", icon: AlertTriangle, className: "text-destructive" },
  unverified: { label: "Unverified — no vision model looked", icon: CircleDashed, className: "text-muted-foreground" },
};

export function CarouselPanel({ carousel: c, onDelete }: { carousel: Carousel; onDelete?: () => Promise<void> }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const passed = c.slides.filter((s) => s.verdict === "pass").length;
  const any = c.slides.some((s) => s.image);
  const complete = c.slides.length === 6 && c.slides.every((s) => s.image);

  /** One DRAFT publishing item with all six slides. The server writes a
   *  caption from the plan first if the carousel has none. */
  async function sendToPublishing() {
    setSending(true);
    setProblem(null);
    setSent(null);
    try {
      const res = await publishingApi.queue({ sourceKind: "carousel", sourceId: c.runId, ventureId: c.ventureId ?? undefined });
      setSent(res.note);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function remove() {
    if (!onDelete || busy) return;
    setBusy(true);
    setProblem(null);
    try { await onDelete(); } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="bg-card mb-4 grid gap-3.5 rounded-[14px] p-4.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <GalleryHorizontal className="size-[15px] shrink-0 self-center" strokeWidth={1.8} />
        <span className="text-[14.5px] font-medium tracking-tight">{c.title ?? "Carousel"}</span>
        <span className="text-muted-foreground text-[13px]">
          {c.width}×{c.height} · {c.slides.length} of 6 slides
          {any ? ` · ${passed} passed` : ""}
          {c.attempts > 1 ? ` · coded ${c.attempts} times` : ""}
        </span>
      </div>
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
        Coded by {c.coderModel ?? "the workspace model"}
        {c.visionModel ? `, checked by ${c.visionModel}` : ""}. The six were drawn as one strip and cut apart; every slide was also measured for text outside its frame or across a cut.
        {c.visionNote ? ` ${c.visionNote}` : ""}
      </p>
      {c.error && <p className="text-destructive text-[13px] leading-relaxed">{c.error}</p>}

      {/* THE STRIP, as it swipes: the one picture the six were cut from, so a
          shape that runs across a cut can be seen joining up. */}
      {c.strip && (
        <div className="overflow-x-auto rounded-[10px] border">
          <img src={c.strip} alt={`All six slides of ${c.title ?? "the carousel"}, side by side`} loading="lazy" className="block h-40 w-auto max-w-none" />
        </div>
      )}
      {c.stripIssues.length > 0 && (
        <ul className="text-muted-foreground grid gap-0.5 text-[12px] leading-snug">
          {c.stripIssues.map((i) => <li key={i}>– {i}</li>)}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {c.slides.map((s) => <SlideCard key={s.n} runId={c.runId} slide={s} ratio={`${c.width} / ${c.height}`} />)}
      </div>

      {c.caption && (
        <div className="grid gap-1">
          <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">Caption</div>
          <p className="text-[13.5px] leading-relaxed whitespace-pre-line">{c.caption}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {any && (
          <Button asChild variant="outline" size="sm">
            <a href={carouselApi.zip(c.runId)} download>
              <Download className="size-[14px]" strokeWidth={1.8} />
              Download all as a zip
            </a>
          </Button>
        )}
        {complete && (
          <Button variant="outline" size="sm" disabled={sending} onClick={() => void sendToPublishing()}>
            {sending ? <Loader2 className="size-[14px] animate-spin" /> : <Send className="size-[14px]" strokeWidth={1.8} />}
            Send to publishing
          </Button>
        )}
        {onDelete && (
          <Button variant={armed ? "destructive" : "ghost"} size="sm" disabled={busy} className="ml-auto"
            onClick={() => (armed ? void remove() : setArmed(true))}>
            {busy ? <Loader2 className="size-[14px] animate-spin" /> : <Trash2 className="size-[14px]" strokeWidth={1.8} />}
            {armed ? "Delete it and the six pictures" : "Delete"}
          </Button>
        )}
      </div>
      {problem && <p className="text-destructive text-[13px]">{problem}</p>}
      {sent && (
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          {sent} All six slides go as one post. <Link to="/social/publishing" className="underline decoration-dotted">Open the queue</Link>.
        </p>
      )}
    </div>
  );
}

function SlideCard({ runId, slide: s, ratio }: { runId: string; slide: CarouselSlide; ratio: string }) {
  const v = VERDICT[s.verdict] ?? VERDICT.unverified;
  return (
    <figure className="grid min-w-0 content-start gap-1.5">
      <div className="bg-muted overflow-hidden rounded-[10px] border" style={{ aspectRatio: ratio }}>
        {s.image
          ? <a href={s.image} target="_blank" rel="noreferrer"><img src={s.image} alt={`Slide ${s.n}: ${s.headline}`} loading="lazy" className="size-full object-contain" /></a>
          : <span className="text-muted-foreground grid size-full place-items-center p-2 text-center text-[12px]">No picture{s.note ? ` — ${s.note}` : ""}</span>}
      </div>
      <figcaption className="grid gap-1">
        <div className="flex items-center gap-1.5 text-[12.5px]">
          <span className="text-muted-foreground tabular-nums">{s.n}</span>
          <v.icon className={cn("size-[13px] shrink-0", v.className)} strokeWidth={1.9} aria-label={v.label} />
          <span className={cn("truncate", v.className)} title={v.label}>{s.verdict}{s.history.length > 1 && s.history[0]?.verdict === "fail" ? ` · fixed on try ${s.history.length}` : ""}</span>
          {s.image && (
            <a href={carouselApi.slideDownload(runId, s.n)} download className="text-muted-foreground hover:text-foreground ml-auto" aria-label={`Download slide ${s.n}`} title="Download this slide">
              <Download className="size-[13px]" strokeWidth={1.8} />
            </a>
          )}
        </div>
        {s.issues.length > 0 && (
          <ul className="text-muted-foreground grid gap-0.5 text-[11.5px] leading-snug">
            {s.issues.map((i) => <li key={i}>– {i}</li>)}
          </ul>
        )}
      </figcaption>
    </figure>
  );
}
