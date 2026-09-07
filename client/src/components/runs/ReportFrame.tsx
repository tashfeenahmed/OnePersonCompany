import { useEffect, useMemo, useRef, useState } from "react";
import { FileDown } from "lucide-react";
import { unfenceHtml } from "@/lib/report";
import { cn } from "@/lib/utils";

/**
 * A MODEL-WRITTEN HTML DOCUMENT, IN ITS BOX, WITH A WAY TO GET IT OUT.
 *
 * ---------------------------------------------------------------------------
 * THE DOSSIER IS THE ONE REPORT ON THIS BOX THE MODEL DESIGNS ITSELF — column,
 * accent rule, fact strip, timeline — because a profile of a person is read
 * rather than skimmed. See the server's `integrations/people/dossier.ts` for
 * the brief that asks for it. This is where such a document is drawn, and it
 * is drawn the way the email reader draws a stranger's newsletter: inside a
 * two-layer box, with the sandbox as the hard boundary and a CSP closing
 * everything the sandbox does not.
 *
 * THE SANDBOX HAS NO `allow-scripts` AND NEVER WILL. Nothing that survived the
 * server's sanitiser and this one can execute, because there is no script
 * engine in there to execute it. Everything else the frame is granted is
 * granted for a reason:
 *   — `allow-same-origin` is what lets this read `contentDocument` to measure
 *     the document and size the frame to it, so a dossier reads as a page
 *     rather than as a scrollbox with a scrollbar down the middle of it;
 *   — `allow-popups` and `allow-popups-to-escape-sandbox` are for the source
 *     links, which the wrapper retargets to new tabs — without scripts a plain
 *     click would navigate THE FRAME, and the linked site would load where the
 *     dossier just was;
 *   — `allow-modals` is what makes Export work. A print dialog is a modal, and
 *     a sandboxed frame may not show one without this flag; the call simply
 *     does nothing instead. It is close to inert on its own — the flag governs
 *     what the FRAME may put on screen, and with no scripts the frame has no
 *     way to ask for anything. The only thing that ever calls print() here is
 *     the button below.
 *
 * TWO SANITISERS, ON PURPOSE. The server strips the document on the way into
 * the row (`integrations/runs/html.ts`, no DOM, a tag scanner) and this strips
 * it again on the way onto the screen, with a real parser. They are not the
 * same code and that is the point: a single filter is one missed case away
 * from being no filter, and rows written before the server's existed have
 * never been through it at all.
 */

/**
 * The document the frame is given: OUR head first — charset, CSP, a two-line
 * reset — then the report's own head content, then its body.
 *
 * DOMParser PARSES WITHOUT EXECUTING OR FETCHING ANYTHING, which is what makes
 * it safe to run over a document before framing it. What comes out has no
 * script, no frame, no form, no `http-equiv` and no inline handler, and every
 * anchor leaves through a new tab.
 *
 * THE CANVAS IS ALWAYS LIGHT, whatever the app's theme. The analyst designs
 * against a white page and says so in its own stylesheet; re-lighting somebody
 * else's document to match the chrome around it produces grey text on grey.
 * It is the same call the email reader makes for HTML mail.
 */
function reportSrcDoc(html: string, fileName?: string): string {
  let head = "";
  let body = html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const el of Array.from(doc.querySelectorAll("script, iframe, object, embed, form, link, base")))
      el.remove();
    for (const el of Array.from(doc.querySelectorAll("meta")))
      if (el.getAttribute("http-equiv")) el.remove();
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        else if (
          ["href", "src", "xlink:href"].includes(attr.name.toLowerCase()) &&
          attr.value.trim().toLowerCase().startsWith("javascript:")
        )
          el.removeAttribute(attr.name);
      }
    }
    /* noreferrer as well as noopener, because the reader of a dossier is
       nobody's analytics event. */
    for (const a of Array.from(doc.querySelectorAll("a"))) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
    head = doc.head?.innerHTML ?? "";
    body = doc.body?.innerHTML ?? html;
  } catch {
    /* An unparseable document goes in raw; the sandbox and the CSP still
       hold, and half a dossier on screen beats an empty panel. */
  }
  /* THE TITLE IS THE FILE NAME THE PRINT DIALOG SUGGESTS, in every browser
     that suggests one, and `document.title` is the FIRST <title> in the
     document — so ours goes in ahead of the report's own, and a report with a
     title of its own keeps it whenever the caller had nothing better. Written
     into the document rather than assigned at click time: a page that mutates
     the frame it just rendered is a page with two authors of what is on
     screen. */
  const named = fileName?.trim()
    ? `<title>${fileName.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src data:; form-action 'none'; base-uri 'none'">
<style>:root { color-scheme: light; } html { background: #ffffff; } body { margin: 0; }</style>
${named}${head}</head><body>${body}</body></html>`;
}

export function ReportFrame({
  html,
  title,
  fileName,
  className,
}: {
  /** The report as the run wrote it. A markdown fence, if the model added
   *  one and the row predates the server taking it off, comes off here. */
  html: string;
  /** The frame's accessible name — screen readers announce it, and it is what
   *  a browser calls the frame in its own devtools. */
  title: string;
  /** Names the file the print dialog suggests. Falls back to the document's
   *  own <title>, which the analyst writes as the person's name. */
  fileName?: string;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(480);
  const [refused, setRefused] = useState(false);
  const srcDoc = useMemo(() => reportSrcDoc(unfenceHtml(html), fileName), [html, fileName]);

  /* MEASURED, NOT GUESSED. `scrollHeight` of the framed document is the only
     honest height for it; a fixed one gives a report its own scrollbar inside
     the page's, which is the thing this component exists to avoid. Fonts and
     layout settle after first paint, so it is measured twice rather than
     once — the same two beats the email reader uses. */
  useEffect(() => {
    const measure = () => {
      const body = ref.current?.contentDocument?.body;
      if (body) setHeight(Math.max(240, body.scrollHeight + 16));
    };
    const t1 = setTimeout(measure, 60);
    const t2 = setTimeout(measure, 400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [srcDoc]);

  /*
    PRINT THE FRAME, NOT THE PAGE.

    `contentWindow.print()` prints the iframe's own document — the dossier
    alone, on its own paper, with none of the rail, header or shelf around it.
    Printing the app and hiding the chrome with @media print is the other way
    to do this and it is worse in the way that matters: the report is a
    complete document the model designed, page breaks and all, and the honest
    thing is to hand the printer THAT rather than a re-styled excerpt of it.
    `lib/printReport.ts` does the other half of the job — the markdown reports,
    which have no document of their own until one is built for them.

    "Save as PDF" is the browser's, not this app's: there is no way to write a
    PDF from a browser without going through the print dialog, short of
    shipping a rendering library. So the button says Export and the title
    attribute says what will actually appear.
  */
  const exportPdf = () => {
    const w = ref.current?.contentWindow;
    if (!w) return;
    try {
      w.focus();
      w.print();
      setRefused(false);
    } catch {
      /* The sandbox refused the modal, or the frame went away mid-click. Say
         so, rather than leaving a button that silently does nothing. */
      setRefused(true);
    }
  };

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="mb-1.5 flex items-center justify-end gap-2">
        {refused && (
          <span className="text-destructive text-[12px]">
            The browser would not open the print dialog.
          </span>
        )}
        <button
          onClick={exportPdf}
          title="Opens your browser's print dialog — choose “Save as PDF” as the destination"
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px]"
        >
          <FileDown className="size-3.5" strokeWidth={1.6} />
          Export PDF
        </button>
      </div>
      <iframe
        ref={ref}
        title={title}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals"
        srcDoc={srcDoc}
        onLoad={() => {
          const body = ref.current?.contentDocument?.body;
          if (body) setHeight(Math.max(240, body.scrollHeight + 16));
        }}
        style={{ height }}
        className="border-line-soft w-full rounded-xl border bg-white"
      />
    </div>
  );
}
