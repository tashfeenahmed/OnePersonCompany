import { ArtifactDownload } from "./ArtifactDownload";
import { FileCode2, FileText, Download } from "lucide-react";
import { runFileUrl, type Paper } from "@/lib/api/runs";
import { cn } from "@/lib/utils";

/**
 * THE PAPER ITSELF, ON THE PAGE.
 *
 * Everywhere a paper appears — under the run that wrote it, and on the shelf —
 * it appears the same way, because it is the same artefact and two renderings
 * of it would eventually disagree about which file is the paper. So the frame,
 * the facts line and the three links are written once here and used twice.
 *
 * THE PDF IS SHOWN, NOT OFFERED. A machine-written paper whose only visible
 * form is a download is a paper nobody reads: the whole point of typesetting it
 * is that it LOOKS like a paper, and a link saying "Open PDF" hides exactly the
 * thing that changed. The server serves it `Content-Disposition: inline`, so an
 * `<iframe>` renders it in the browser's own viewer with its own page controls,
 * and the frame is given real height — 70vh at least — because a paper in a
 * two-inch box is a thumbnail rather than a document.
 *
 * WHAT IT SAYS ABOUT ITSELF IS WHAT THE SERVER SAID. `typeset: "typst"` is a
 * typeset paper; `"chrome"` is markdown a browser printed, and the line says
 * so in those words rather than calling both of them a paper; `null` is drawn
 * as "not recorded" and never resolved into either. Same for `pages`, which is
 * absent rather than zero when the file could not be counted.
 *
 * A PAPER WITH NO PDF IS A REAL STATE AND IS DRAWN AS ONE. The typesetter
 * refused the document, or there was no browser on the box. The Typst source
 * survives that and is the only thing that explains it, so the link to it is
 * offered exactly when it exists.
 */

/** How the row and the panel describe the machine that made the file. */
function engineWords(paper: Paper): string {
  if (paper.typeset === "typst")
    return `typeset with Typst${paper.columns ? `, ${paper.columns} column${paper.columns === 1 ? "" : "s"}` : ""}`;
  if (paper.typeset === "chrome") return "markdown printed by the browser — not typeset";
  return "no engine recorded";
}

/** The one-line summary under a paper's title. Every clause is a fact the
 *  server sent; nothing here is computed from an absence. */
export function PaperFacts({ paper, className }: { paper: Paper; className?: string }) {
  const bits = [
    engineWords(paper),
    paper.pages !== null ? `${paper.pages} page${paper.pages === 1 ? "" : "s"}` : null,
    `${paper.cited.length} ${paper.cited.length === 1 ? "citation" : "citations"}`,
  ].filter(Boolean);
  return (
    <span className={cn("text-muted-foreground text-[12.5px]", className)}>{bits.join(" · ")}</span>
  );
}

/** The three files, as links. The PDF and the source open in a tab; the
 *  markdown downloads, because the server sends it as an attachment and a tab
 *  full of raw markdown is not what anybody meant by "open it". */
export function PaperLinks({ paper }: { paper: Paper }) {
  const item =
    "text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]";
  return (
    <>
      {paper.pdf ? (
        <a href={paper.pdf} target="_blank" rel="noreferrer" className={item}>
          <FileText className="size-3.5" strokeWidth={1.6} />
          PDF
        </a>
      ) : (
        <span className="text-muted-foreground px-2 py-1 text-[12.5px]">no PDF</span>
      )}
      {paper.source && (
        <a
          href={paper.source}
          target="_blank"
          rel="noreferrer"
          className={item}
          title="The Typst source the PDF was set from. It is the artefact; the PDF is a rendering of it."
        >
          <FileCode2 className="size-3.5" strokeWidth={1.6} />
          Typst source
        </a>
      )}
      <a href={runFileUrl(paper.runId, "markdown")} download className={item}>
        <Download className="size-3.5" strokeWidth={1.6} />
        Markdown
      </a>
      <ArtifactDownload runId={paper.runId} />
    </>
  );
}

/**
 * The document, in a frame sized to the column.
 *
 * `<object>` inside the `<iframe>`'s place would give a fallback slot, but the
 * fallback nobody can see is the one that matters here: when there is no PDF
 * the server answers JSON, so this does not point a frame at it at all — it
 * says what happened and offers the source instead, which is the thing that
 * explains a compile that failed.
 */
export function PaperFrame({ paper }: { paper: Paper }) {
  if (!paper.pdf)
    return (
      <div className="bg-muted/40 rounded-[14px] border p-3.5">
        <p className="text-[14px] leading-relaxed">
          There is no PDF for this paper.{" "}
          {paper.source
            ? "The typesetter refused the document when it was written — the Typst source below is what was set, and the run's report carries what the compiler objected to."
            : "No typesetter and no browser were found on this box when it was written, so nothing was rendered. The markdown is still the paper."}
        </p>
        <div className="mt-2 -ml-2 flex flex-wrap items-center gap-0.5">
          <PaperLinks paper={paper} />
        </div>
      </div>
    );

  return (
    <div className="bg-muted/40 overflow-hidden rounded-[14px] border">
      <iframe
        /* Keyed on the url so a different paper replaces the viewer rather than
           reusing one that is already scrolled to page four of another. */
        key={paper.pdf}
        src={paper.pdf}
        title={paper.title}
        className="block h-[70vh] min-h-[520px] w-full border-0"
      />
    </div>
  );
}
