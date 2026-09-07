import { reportDocument, type ReportDocumentInput } from "@/lib/reportDocument";

/**
 * PRINT A REPORT ON ITS OWN PAPER.
 *
 * The document from `reportDocument` is loaded into an iframe that exists for
 * exactly as long as the print dialog does, and it is the FRAME that prints —
 * `contentWindow.print()` — so the dialog shows the report alone rather than
 * the app page with a print stylesheet over it.
 *
 * THE SANDBOX HAS NO `allow-scripts`, and that is the boundary: the body is
 * the page's own rendered markdown, which carries no script, but a frame that
 * could not run one even if it did is cheaper than an argument about whether
 * it might. `allow-same-origin` is what lets this call print on the frame at
 * all; `allow-modals` is what lets a sandboxed frame show a dialog — without
 * it the call silently does nothing, which is the failure this file exists to
 * not have.
 *
 * OFF-SCREEN, NOT `display: none`. A frame with no layout has no pages to
 * print in some browsers, and prints blank. It is parked out of view instead
 * and taken down after `afterprint` — or after a long timeout, for a browser
 * that never fires it.
 *
 * Resolves false only when the browser refused the dialog; the caller says so
 * in words, because a button that does nothing is worse than one that says
 * why.
 */
export function printReport(input: ReportDocumentInput): Promise<boolean> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin allow-modals");
    frame.setAttribute("aria-hidden", "true");
    frame.title = "Print";
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:794px;height:1123px;border:0;opacity:0;pointer-events:none;";

    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      /* Not on the same tick: Safari tears the dialog down with the frame if
         the frame goes before the dialog has finished opening. */
      setTimeout(() => frame.remove(), 1000);
      resolve(ok);
    };

    frame.addEventListener("load", () => {
      const w = frame.contentWindow;
      if (!w) return finish(false);
      w.addEventListener("afterprint", () => finish(true));
      /* A browser that never fires afterprint — some do not from a frame —
         still gets its frame taken down, a minute later, after the dialog
         has long since been dealt with. */
      setTimeout(() => finish(true), 60_000);
      try {
        w.focus();
        w.print();
      } catch {
        finish(false);
      }
    });

    frame.srcdoc = reportDocument(input);
    document.body.appendChild(frame);
  });
}
