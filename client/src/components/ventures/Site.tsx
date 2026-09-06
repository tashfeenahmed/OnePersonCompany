import { useState } from "react";
import { Camera, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import type { Venture } from "@/lib/api";
import { BrandMeasuredSection } from "@/areas/seoops/BrandMeasuredSection";
import {
  ventureApi,
  type CaptureVenture,
  type Rebrand,
  type RenderedReading,
} from "@/lib/api/ventures";
import { bytes } from "@/lib/format";

/**
 * WHAT THE SITE ACTUALLY LOOKS LIKE, AND WHAT COLOURS IT ACTUALLY USES.
 *
 * A venture's brand is read from raw HTML and its stylesheets, which is the
 * finer measurement and the one the rest of the app draws from: the favicon in
 * every list, the title, the ranked palette. But a page built by JavaScript
 * has almost no colour in the HTML it ships, and for those the only honest
 * reading is of the page AFTER a browser has run it.
 *
 * SO THERE ARE TWO READINGS HERE AND THEY ARE NOT MERGED. The static one is
 * the venture's; the rendered one is stored beside the photograph. The only
 * thing that ever crosses between them is a single colour — the strongest
 * brandable one out of the rendered page becomes the venture's colour, and
 * only when the owner has not chosen one by hand. This tab says which reading
 * is in use rather than letting the reader assume, because "we measured two
 * palettes" is useless without "and this is the one on the cards".
 *
 * A CAPTURE IS THE TOP OF THE PAGE, NOT THE PAGE. 1280x800 after six seconds
 * of loading, capped at twenty-five. The server says so in its own words and
 * they are quoted here rather than paraphrased into "screenshot", which would
 * imply a full-page scroll nobody took.
 */
export function Site({ venture }: { venture: Venture }) {
  const { data, error, loading, reload } = useApi(() => ventureApi.capture(), []);
  const [busy, setBusy] = useState<"shot" | "brand" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [rebrand, setRebrand] = useState<Rebrand | null>(null);
  /* Bumped after a capture so the <img> refetches: the URL never changes —
     /api/capture/<slug>/shot is always the newest picture — so without this
     the browser would proudly show the old one. */
  const [shotAt, setShotAt] = useState(0);

  const mine: CaptureVenture | null =
    data?.ventures.find((v) => v.slug === venture.slug) ?? null;
  const browser = data?.browser ?? null;

  async function capture() {
    setBusy("shot");
    setFailed(null);
    try {
      const res = await ventureApi.captureNow(venture.slug);
      /* 200 with `ok: false` is the normal shape of "the browser ran and the
         page never loaded". The status is not the test; this field is. */
      if (!res.ok) setFailed(res.error ?? "The capture produced no picture.");
      setShotAt(Date.now());
      reload();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function reread() {
    setBusy("brand");
    setFailed(null);
    try {
      setRebrand(await ventureApi.rebrand(venture.slug));
      reload();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /* The newest rendered reading: this session's if one was just taken, and the
     stored one otherwise. */
  const rendered: RenderedReading | null =
    rebrand?.rendered ?? mine?.rendered?.reading ?? null;
  const renderedAt = rebrand ? rebrand.rendered.readAt : (mine?.rendered?.ts ?? null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-16">
      <div className="mx-auto flex w-full max-w-[940px] flex-col gap-6">
        {error && <p className="text-destructive text-[12.5px]">{error}</p>}
        {failed && <p className="text-destructive text-[12.5px]">{failed}</p>}

        {!venture.website && (
          <p className="text-muted-foreground text-[12.5px]">
            {venture.name} has no website, so there is nothing to photograph and
            nothing to read. Add one on the edit page.
          </p>
        )}

        {venture.website && (
          <>
            {/* ------------------------------------------------ picture */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-[13px] font-medium">The page</h2>
                {venture.website && (
                  <a
                    href={venture.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11.5px]"
                  >
                    open it
                    <ExternalLink className="size-3" strokeWidth={1.6} />
                  </a>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  disabled={busy !== null || !browser?.found}
                  title={browser?.found ? undefined : (browser?.error ?? undefined)}
                  onClick={() => void capture()}
                >
                  <Camera className="size-3.5" strokeWidth={1.6} />
                  {busy === "shot" ? "Photographing…" : "Capture now"}
                </Button>
              </div>

              {browser && (
                <p className="text-muted-foreground mb-2 text-[11.5px] leading-snug">
                  {browser.found ? browser.note : browser.error}
                  {browser.found && (
                    <>
                      {" "}
                      Taken with{" "}
                      <span title={browser.path ?? undefined}>
                        {browser.source === "configured"
                          ? "the browser configured under Site capture"
                          : "a browser found on this machine"}
                      </span>
                      .
                    </>
                  )}
                </p>
              )}

              {mine?.picture ? (
                <figure className="flex flex-col gap-1.5">
                  <img
                    src={`${mine.picture.url}${shotAt ? `?t=${shotAt}` : ""}`}
                    alt={`${venture.name}, ${new Date(mine.picture.ts).toLocaleString()}`}
                    width={mine.last?.width ?? undefined}
                    height={mine.last?.height ?? undefined}
                    className="w-full rounded-[10px] border"
                  />
                  <figcaption className="text-muted-foreground text-[11.5px]">
                    Captured {new Date(mine.picture.ts).toLocaleString()}
                    {mine.picture.ageDays !== null &&
                      ` · ${mine.picture.ageDays === 0 ? "today" : `${mine.picture.ageDays} days ago`}`}
                    {mine.last?.width && mine.last.height
                      ? ` · ${mine.last.width}×${mine.last.height}`
                      : ""}
                    {mine.last?.bytes ? ` · ${bytes(mine.last.bytes)}` : ""}
                    {data && ` · re-taken every ${data.refreshEveryDays} days`}
                    {mine.due && " · due for a fresh one"}
                    {mine.picture.onDisk === false &&
                      " · the file is no longer on disk, so this will not load"}
                  </figcaption>
                </figure>
              ) : (
                <p className="text-muted-foreground text-[12.5px]">
                  {loading
                    ? "Reading the capture table…"
                    : "No picture has ever been taken of this one."}
                </p>
              )}

              {/* The newest ATTEMPT, when it is not the newest picture: a
                  failed run does not delete the last good photograph, and an
                  old picture with no explanation looks like a stale page. */}
              {mine?.last && !mine.last.ok && (
                <p className="text-destructive mt-1.5 text-[11.5px]">
                  The last attempt, {new Date(mine.last.ts).toLocaleString()},
                  failed: {mine.last.error ?? "no reason was recorded."}
                </p>
              )}
            </section>

            {/* -------------------------------------------------- brand */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-[13px] font-medium">The two readings</h2>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy !== null || !browser?.found}
                  onClick={() => void reread()}
                >
                  <RefreshCw className="size-3.5" strokeWidth={1.6} />
                  {busy === "brand"
                    ? "Rendering…"
                    : "Re-read brand from the rendered page"}
                </Button>
              </div>
              <p className="text-muted-foreground mb-2.5 text-[11.5px] leading-snug">
                The static reading is parsed from the HTML the server sent and
                its stylesheets; the rendered one is taken from the DOM after a
                browser ran the page. They are kept apart because a coarser
                measurement must not overwrite a finer one.
              </p>

              <div className="grid gap-2 sm:grid-cols-2">
                <Reading
                  title="Static — from the HTML"
                  when={venture.brand.enrichedAt}
                  note={
                    venture.brand.error ??
                    "The venture’s own. This is where the favicon, the title and the ranked palette on every other page come from."
                  }
                  bad={!!venture.brand.error}
                  pageTitle={venture.brand.title}
                  swatches={venture.brand.palette.ranked.map((c) => c.hex)}
                  extra={
                    [
                      venture.brand.fonts.length
                        ? `Fonts: ${venture.brand.fonts.join(", ")}`
                        : null,
                      /* What could not be measured, and why — the half of the
                         reading that says where it stopped. */
                      ...venture.brand.notes,
                    ]
                      .filter(Boolean)
                      .join(" ") || null
                  }
                />
                <Reading
                  title="Rendered — from the DOM"
                  when={renderedAt}
                  note={
                    rendered
                      ? `${rendered.counts} colours counted across the rendered page.`
                      : "Never read. Nothing on this venture comes from a rendered page yet."
                  }
                  pageTitle={rendered?.title ?? null}
                  swatches={(rendered?.palette.ranked ?? []).map((c) => c.hex)}
                  extra={rendered?.notes.length ? rendered.notes.join(" ") : null}
                />
              </div>

              {/* WHICH ONE IS IN USE. Two palettes on a page with no statement
                  about which one the app draws is a screen that measured
                  something and answered nothing. */}
              <div className="mt-3 rounded-[10px] border px-3 py-2.5">
                <div className="flex items-center gap-2 text-[12.5px]">
                  <span
                    className="size-[14px] rounded-[4px] border"
                    style={{ background: rebrand?.color ?? venture.color }}
                  />
                  <span>
                    {venture.name}’s colour is{" "}
                    {(rebrand?.color ?? venture.color).toUpperCase()}
                  </span>
                  <span className="text-muted-foreground text-[11.5px]">
                    {source(rebrand?.colorSource ?? venture.colorSource)}
                  </span>
                </div>
                <p className="text-muted-foreground mt-1.5 text-[11.5px] leading-snug">
                  {rebrand
                    ? rebrand.note
                    : venture.colorSource === "owner"
                      ? "It was typed by the owner, so no measurement may replace it."
                      : "Re-reading the rendered page may replace it, and will say so when it does."}
                </p>
                <p className="text-muted-foreground mt-1.5 text-[11.5px] leading-snug">
                  {rebrand
                    ? rebrand.brandNote
                    : "The brand block — the favicon, the title, the ranked palette — is read from the raw HTML by the venture’s own enrichment and is never touched by a rendered reading."}
                </p>
              </div>

              {/* A THIRD READING, AND THE ONLY ONE TAKEN IN A LIVE DOCUMENT.
                  The two above are both parses of text — one of the HTML that
                  was shipped, one of the DOM after the browser ran. Neither
                  can ask what a colour RESOLVED to or how much of the page is
                  painted with it. This one does, through the DevTools
                  protocol, and it says on every field which of the three (or
                  the owner) produced it. It is opt-in per venture and never
                  overwrites either reading above. */}
              <BrandMeasuredSection venture={venture.slug} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

/** One of the two readings, drawn identically so the difference between them
 *  is the content rather than the treatment. */
function Reading({
  title,
  when,
  note,
  bad,
  pageTitle,
  swatches,
  extra,
}: {
  title: string;
  when: string | null;
  note: string;
  bad?: boolean;
  pageTitle: string | null;
  swatches: string[];
  extra: string | null;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border p-3">
      <div className="text-[12.5px] font-medium">{title}</div>
      <div className="text-muted-foreground text-[11.5px]">
        {when ? new Date(when).toLocaleString() : "never"}
      </div>
      {pageTitle && <div className="text-[12.5px]">{pageTitle}</div>}
      {swatches.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {swatches.slice(0, 8).map((hex) => (
            <span
              key={hex}
              title={hex}
              className="size-[16px] rounded-[4px] border"
              style={{ background: hex }}
            />
          ))}
        </div>
      )}
      <p
        className={
          bad
            ? "text-destructive text-[11.5px] leading-snug"
            : "text-muted-foreground text-[11.5px] leading-snug"
        }
      >
        {note}
      </p>
      {extra && (
        <p className="text-muted-foreground text-[11.5px] leading-snug">{extra}</p>
      )}
    </div>
  );
}

function source(kind: "owner" | "site" | "default"): string {
  if (kind === "owner") return "chosen by the owner";
  if (kind === "site") return "measured from the site";
  return "one of the seven defaults";
}


