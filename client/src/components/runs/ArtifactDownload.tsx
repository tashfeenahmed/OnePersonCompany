import { Download } from "lucide-react";

export function ArtifactDownload({ runId }: { runId: string }) {
  return (
    <a href={`/api/runs/${encodeURIComponent(runId)}/artifacts`} download
      title="Download the report and saved evidence. Papers include the PDF, source, bibliography and figures where available."
      className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]">
      <Download className="size-3.5" strokeWidth={1.6} />
      All artifacts
    </a>
  );
}
