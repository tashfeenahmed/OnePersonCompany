import { appPage } from "../../../../shared/navigation";
import { useState } from "react";
import { BookOpen, X } from "lucide-react";
import { Link } from "react-router-dom";
import { PaperFacts, PaperFrame, PaperLinks } from "@/components/runs/PaperView";
import { useApi } from "@/hooks/useApi";
import { runsApi } from "@/lib/api/runs";
import type { Venture } from "@/lib/store";
import { ago } from "@/lib/format";

/**
 * WHAT HAS BEEN WRITTEN, AND WHAT IT WAS WRITTEN OUT OF.
 *
 * Two lists that are easy to conflate and must not be. THE SHELF is papers
 * this box wrote. THE LIBRARY is papers other people wrote, which the scout
 * pulled off OpenAlex and arXiv before the model was allowed to say anything —
 * and which are the ONLY things a written paper is permitted to cite. That
 * rule is the whole reason the library is on screen: a citation list nobody
 * can check is the failure mode of a machine-written paper, and this is where
 * you check it.
 *
 * THE LIBRARY IS NOT A SEARCH RESULT AND IS NOT REFETCHED PER KEYSTROKE. It is
 * what the scouts have accumulated for this venture or this topic across every
 * run, so a second paper on the same subject starts from a library rather than
 * from nothing — and so the "net-new against every paper written before" rule
 * has something to be net-new against.
 *
 * "READ" OPENS THE PAPER IN PLACE, and that is the one control here that is a
 * button rather than a link. A typeset paper is a thing to LOOK at — the
 * columns, the figures, the numbered bibliography are the whole point of
 * setting it — and a shelf that could only hand over a download would hide
 * exactly what changed. One at a time, because two 70vh viewers on one page is
 * a page nobody can scroll; opening a second closes the first.
 *
 * WHAT EACH ROW CLAIMS ABOUT ITSELF COMES FROM THE SERVER. `typeset` says
 * whether the file was compiled by Typst or printed by a browser, and the row
 * says which in those words — a browser print is not a typeset paper, and a
 * shelf that drew both as "paper" would be the place that lie started.
 */
export function PaperShelf({
  venture,
  topic,
  refreshKey,
}: {
  venture: Venture | null;
  /** Whatever is in the topic box, so a run with no venture still has a
   *  library to show. Empty is "everything the scouts have". */
  topic: string;
  /** The id of the run that just settled — see `RunApp`'s `extras`. */
  refreshKey: string;
}) {
  const key = venture?.id ?? null;
  /* Which paper is open in the reader, by run id. Held here rather than per
     row so that opening one closes the other without either row knowing about
     the other — see the header. */
  const [reading, setReading] = useState<string | null>(null);
  const papers = useApi(() => runsApi.papers(key), [key, refreshKey]);
  const library = useApi(
    () => runsApi.library({ venture: key, topic: topic.trim() || null }),
    [key, topic.trim(), refreshKey],
  );

  const written = papers.data?.papers ?? [];
  const entries = library.data?.papers ?? [];

  return (
    <>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
          Written here
        </div>
        <span className="text-muted-foreground ml-auto text-[11.5px]">
          {papers.loading && !papers.data
            ? "loading…"
            : papers.error
              ? papers.error
              : written.length === 0
                ? "nothing written yet"
                : `${written.length} ${written.length === 1 ? "paper" : "papers"}`}
        </span>
      </div>

      {written.length === 0 ? (
        <p className="text-muted-foreground mb-7 text-[13px]">
          No paper has been written{venture ? ` for ${venture.name}` : ""} yet. A
          run scouts the literature first, then writes against what it found —
          and every paper after the first has to say something the ones before
          it did not.
        </p>
      ) : (
        <div className="mb-7 flex flex-col gap-1.5">
          {written.map((p) => {
            const open = reading === p.runId;
            return (
              <div key={p.runId} className="bg-card rounded-[10px] border p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Link
                    to={appPage("papers", p.runId)}
                    className="text-[13px] leading-snug font-medium tracking-tight hover:underline"
                  >
                    {p.title}
                  </Link>
                  <span className="text-muted-foreground text-[11.5px]">
                    {p.topic} · {ago(p.ts)}
                  </span>
                  {/* The url the SERVER hands over, not one built here — and
                      absent rather than dead when there is no PDF, because the
                      links beside it already offer the source and the markdown.
                      `pdfOnDisk` false is a file that has gone missing under
                      the row; the link stays and 404s with the reason, which is
                      more use than hiding it. */}
                  <span className="ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      onClick={() => setReading(open ? null : p.runId)}
                      className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px]"
                    >
                      {open ? (
                        <X className="size-3.5" strokeWidth={1.6} />
                      ) : (
                        <BookOpen className="size-3.5" strokeWidth={1.6} />
                      )}
                      {open ? "Close" : "Read"}
                    </button>
                    <PaperLinks paper={p} />
                  </span>
                </div>
                <div className="mt-0.5">
                  <PaperFacts paper={p} />
                </div>
                {p.thesis && (
                  <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
                    {p.thesis}
                  </p>
                )}
                {p.contributions.length > 0 && (
                  <ul className="text-muted-foreground mt-1 list-disc pl-4 text-[12px] leading-relaxed">
                    {p.contributions.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
                {open && (
                  <div className="mt-2.5">
                    <PaperFrame paper={p} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
          The library
        </div>
        <span className="text-muted-foreground text-[11.5px]">
          what the scouts found on OpenAlex and arXiv — the only things a paper
          here may cite
        </span>
        <span className="text-muted-foreground ml-auto text-[11.5px]">
          {library.loading && !library.data
            ? "loading…"
            : library.error
              ? library.error
              : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">
          The library is empty{topic.trim() ? ` for “${topic.trim()}”` : ""}. It
          fills the moment a run scouts.
        </p>
      ) : (
        <div className="flex flex-col gap-px">
          {entries.map((e) => (
            <div
              key={`${e.source}:${e.extId}`}
              className="-mx-1.5 flex items-baseline gap-2.5 rounded-md px-1.5 py-1"
            >
              <span className="min-w-0 flex-1 text-[12.5px] leading-snug">
                {e.url ? (
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                  >
                    {e.title}
                  </a>
                ) : (
                  e.title
                )}
                {e.authors.length > 0 && (
                  <span className="text-muted-foreground">
                    {" — "}
                    {e.authors.slice(0, 3).join(", ")}
                    {e.authors.length > 3 && " et al."}
                  </span>
                )}
              </span>
              <span className="text-muted-foreground shrink-0 text-[11.5px] tabular-nums">
                {/* Null is drawn as a dash, never as a year. A record with no
                    publication date is common on OpenAlex and guessing one
                    would put a false date in a citation. */}
                {e.year ?? "—"}
              </span>
              <span className="text-muted-foreground w-[62px] shrink-0 text-right text-[11.5px]">
                {e.source}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
