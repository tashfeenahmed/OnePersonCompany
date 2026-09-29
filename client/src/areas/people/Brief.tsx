import { useState } from "react";
import { Loader2, Newspaper, RefreshCw } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/format";
import { peopleApi } from "@/lib/api/people";
import { humanizeStamps, weekLabel } from "@/lib/mailText";
import { EmptyState, FilterChips, SmallPrint } from "@/areas/mailflow/parts";

/**
 * WEEKLY NOTE (route /mail/brief) — once a week, what changed between the
 * owner and the people they write with: counts the server measures, plus a
 * paragraph an AI writes over them when one is reachable. Earlier weeks are
 * chips at the top; "Write it again" rewrites the current week only.
 */
export function Brief() {
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  const doc = useApi(() => peopleApi.brief(week ?? undefined), [week]);
  const d = doc.data;
  const weeks = d?.weeks ?? [];
  const current = weeks[0]?.week ?? d?.week ?? null;

  async function write() {
    setWriting(true);
    setProblem(null);
    try {
      const out = await peopleApi.writeBrief(true);
      if (out.error) setProblem(out.error);
      setWeek(null);
      doc.reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setWriting(false);
    }
  }

  return (
    <PageShell
      title="Weekly note"
      wide
      action={
        <Button variant="outline" size="sm" onClick={write} disabled={writing} title="Rewrite this week's note now">
          {writing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {writing ? "Writing…" : "Write it again"}
        </Button>
      }
    >
      {weeks.length > 1 && (
        <FilterChips
          label="Week"
          className="mb-4"
          value={d?.week ?? current ?? ""}
          onChange={(k) => setWeek(k === current ? null : k)}
          chips={weeks.slice(0, 12).map((w) => ({ key: w.week, label: weekLabel(w.week) }))}
        />
      )}

      {d?.markdown && (
        <p className="text-muted-foreground mb-3 text-[12.5px]">
          {weekLabel(d.week)}
          {d.writtenAt ? ` · written ${ago(d.writtenAt)}` : ""}
        </p>
      )}

      {problem && <p className="text-destructive mb-3 text-[13.5px]">{problem}</p>}
      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" /> Loading…
        </p>
      )}

      {/* A 404 here is "no note yet", an ordinary state rather than a failure. */}
      {(doc.error || (d && !d.markdown)) && !doc.loading && (
        <EmptyState
          icon={Newspaper}
          title="No weekly note yet"
          body="One is written automatically each week. Press “Write it again” to make this week's now."
        />
      )}

      {d?.markdown && (
        <div className="border-line-soft bg-card rounded-xl border p-4 sm:p-5">
          <Markdown text={humanizeStamps(d.markdown)} />
        </div>
      )}

      {d?.error && d.markdown && (
        <p className="text-muted-foreground mt-3 text-[12.5px]">
          The AI summary couldn't be written this week, so this note has the numbers only.
        </p>
      )}
      {d?.figures?.firstBrief && (
        <p className="text-muted-foreground mt-3 text-[12.5px]">
          This is the first note, so there's nothing to compare with yet. Next week's can say what changed.
        </p>
      )}

      {(d?.error || doc.error) && (
        <SmallPrint summary="Details" className="mt-6">
          {d?.error && <p>{d.error}</p>}
          {doc.error && <p>{doc.error}</p>}
          {d?.model && <p>Written by {d.model}.</p>}
        </SmallPrint>
      )}
    </PageShell>
  );
}
