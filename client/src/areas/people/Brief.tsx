import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/format";
import { peopleApi } from "@/lib/api/people";

/**
 * THE WEEKLY READING OF WHAT CHANGED between the owner and the people they
 * write with — figures the server counts, and one paragraph a model writes
 * over them.
 *
 * ITS OWN FILE FOR THE REASON CONTACTS HAS ONE: it was a component inside
 * People.tsx, and People is gone. A brief about correspondence is mail, so it
 * is a tab of the Email page now — see pages/Email.tsx.
 */
export function Brief() {
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const doc = useApi(() => peopleApi.brief(), []);
  const d = doc.data;

  /* WHICH WEEK, WRITTEN BY WHAT, AND WHEN. PageShell's `sub` said this, and
     PageShell drops its words when a page is embedded — which this one always
     is now. "Brief" in the shell's header above cannot say which week you are
     reading, so the sentence is drawn in the page instead. */
  const sub = doc.loading
    ? "Reading the brief…"
    : d?.markdown
      ? `${d.week} · ${d.model ? `paragraph by ${d.model}` : "figures only"}${d.writtenAt ? ` · written ${ago(d.writtenAt)}` : ""}`
      : "One brief per ISO week, written automatically.";

  async function write() {
    setWriting(true);
    setProblem(null);
    try {
      await peopleApi.writeBrief(true);
      doc.reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setWriting(false);
    }
  }

  return (
    <PageShell
      title="Relations brief"
      wide
      action={
        <Button variant="ghost" size="sm" onClick={write} disabled={writing}>
          {writing ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.6} />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.6} />
          )}
          Rewrite this week
        </Button>
      }
    >
      <p className="text-muted-foreground mb-4 text-[12.5px]">{sub}</p>
      {problem && <p className="text-destructive mb-3 text-[14.5px]">{problem}</p>}
      {doc.error && (
        <p className="text-muted-foreground text-[14.5px]">
          {/* A 404 here is "no brief yet", which is an ordinary state and not a
              failure — the error text from the route says so in words. */}
          {doc.error}
        </p>
      )}
      {d?.error && (
        <p className="text-muted-foreground border-line-soft mb-4 rounded-lg border p-3 text-[13.5px]">
          {d.error}
        </p>
      )}
      {d?.markdown && (
        <div className="border-line-soft rounded-xl border p-4">
          <Markdown text={d.markdown} />
        </div>
      )}
      {d?.figures?.firstBrief && (
        <p className="text-muted-foreground mt-3 text-[12.5px]">
          There was no previous brief to compare against, so nobody is reported as newly cooled.
          Next week's can say what changed.
        </p>
      )}
      {d && d.weeks.length > 1 && (
        <p className="text-muted-foreground mt-3 text-[12.5px]">
          Earlier weeks on record: {d.weeks.map((w) => w.week).join(", ")}
        </p>
      )}
    </PageShell>
  );
}
