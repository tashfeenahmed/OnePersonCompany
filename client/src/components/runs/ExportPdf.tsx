import { useState, type RefObject } from "react";
import { FileDown } from "lucide-react";
import { printReport } from "@/lib/printReport";
import type { ReportFact } from "@/lib/reportDocument";
import { cn } from "@/lib/utils";

/**
 * THE ONE WAY A REPORT LEAVES THIS APP.
 *
 * It used to be a Markdown download — the run's raw text as a `.md` file —
 * which is an export for the person who wants to paste the report into another
 * model, and nobody else. A report is read on paper or sent to somebody, and
 * both of those are a PDF. So this opens the browser's print dialog on the
 * report alone, where "Save as PDF" is the destination; see `printReport` for
 * why it is a dialog and not a file.
 *
 * `body` IS A REF TO THE RENDERED REPORT, read at the moment of the click
 * rather than passed as markdown: the page has already done the rendering, and
 * a second renderer for the printer would be a second place for a table to
 * come out wrong.
 */
export function ExportPdf({
  title,
  subtitle,
  facts,
  brief,
  footer,
  body,
  disabled,
  className,
}: {
  title: string;
  subtitle?: string | null;
  facts?: ReportFact[];
  brief?: string | null;
  footer?: string | null;
  body: RefObject<HTMLElement | null>;
  disabled?: boolean;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  async function go() {
    const html = body.current?.innerHTML ?? "";
    if (!html.trim()) return;
    setBusy(true);
    setRefused(false);
    const ok = await printReport({ title, subtitle, facts, brief, footer, bodyHtml: html });
    setBusy(false);
    setRefused(!ok);
  }

  return (
    <span className={cn("flex items-center gap-2", className)}>
      {refused && (
        <span className="text-destructive text-[12px]">
          The browser would not open the print dialog.
        </span>
      )}
      <button
        onClick={() => void go()}
        disabled={disabled || busy}
        title="Opens your browser's print dialog — choose “Save as PDF” as the destination"
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] disabled:opacity-50"
      >
        <FileDown className="size-3.5" strokeWidth={1.6} />
        {busy ? "Printing…" : "Export PDF"}
      </button>
    </span>
  );
}
