import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { peopleApi, type ScanResult } from "@/lib/api/people";
import { CommitmentRow } from "./parts";

/**
 * WHAT THE OWNER SAID THEY WOULD DO — lifted out of their own sent mail.
 *
 * ITS OWN FILE BECAUSE IT HAS TWO HOMES. It is People's fourth tab, where the
 * question is about a correspondence, and it is a tab of the Email page, where
 * the question is about the mailbox. One component, both places: a copy would
 * be two Scan buttons that drifted apart.
 */
export function Commitments() {
  const [status, setStatus] = useState<"open" | "done" | "dismissed" | "all">("open");
  const [days, setDays] = useState("14");
  const [busy, setBusy] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const doc = useApi(() => peopleApi.commitments({ status, limit: 300 }), [status]);
  const d = doc.data;

  async function runScan() {
    setBusy("scan");
    setProblem(null);
    setScan(null);
    try {
      setScan(await peopleApi.scan(Number(days) || 14));
      doc.reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, action: "done" | "dismiss" | "reopen") {
    setBusy(id);
    setProblem(null);
    try {
      await peopleApi.decide(id, action);
      doc.reload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageShell
      title="Commitments"
      sub={
        doc.loading
          ? "Reading the promises…"
          : d
            ? `${d.counts.open} open · ${d.counts.done} done · ${d.counts.dismissed} dismissed${d.overdue ? ` · ${d.overdue} past a date he stated` : ""}`
            : ""
      }
      wide
    >
      <p className="text-muted-foreground mb-4 text-[12.5px]">
        Found in your own sent mail. The bodies are read and dropped — what is kept is the
        sentence you wrote, who it was to, and the date. A promise with no date stated is
        undated, never overdue.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["open", "done", "dismissed", "all"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "secondary" : "ghost"}
            onClick={() => setStatus(s)}
          >
            {s}
          </Button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <Input
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-[68px]"
            aria-label="Days of sent mail to scan"
          />
          <span className="text-muted-foreground text-[12.5px]">days</span>
          <Button size="sm" variant="ghost" onClick={runScan} disabled={busy === "scan"}>
            {busy === "scan" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.6} />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.6} />
            )}
            Scan sent mail
          </Button>
        </span>
      </div>

      {problem && <p className="text-destructive mb-3 text-[14.5px]">{problem}</p>}

      {/* Every refusal is a number. A scan that reported only what it kept
          would read as a quiet fortnight when it might be a pattern that has
          started eating real sentences. */}
      {scan && (
        <p
          className={cn(
            "border-line-soft mb-4 rounded-lg border p-3 text-[13px]",
            scan.ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {scan.ok
            ? `Read ${scan.scanned} of ${scan.listed} sent messages over ${scan.days} days: ` +
              `${scan.candidates} candidate sentences, ${scan.filed} filed, ` +
              `${scan.alreadyKnown} already known, ${scan.droppedByModel} judged not a promise, ` +
              `${scan.refusedSpans} model spans refused as not verbatim, ` +
              `${scan.noRecipient} with no readable recipient. ` +
              (scan.model ? `Refined by ${scan.model}.` : "No model answered — sentences are unrefined.")
            : (scan.error ?? "The scan failed.")}
          {scan.note ? ` ${scan.note}` : ""}
        </p>
      )}

      {doc.error && <p className="text-destructive text-[14.5px]">{doc.error}</p>}
      {d?.note && <p className="text-muted-foreground text-[14.5px]">{d.note}</p>}

      {d && d.commitments.length > 0 && (
        <div className="border-line-soft overflow-hidden rounded-xl border">
          {d.commitments.map((c) => (
            <CommitmentRow
              key={c.id}
              c={c}
              busy={busy === c.id}
              onDecide={(action) => decide(c.id, action)}
            />
          ))}
        </div>
      )}

      {!doc.loading && d && !d.commitments.length && !d.note && (
        <p className="text-muted-foreground text-[14.5px]">
          Nothing {status === "all" ? "on record" : status} — which is a statement about the
          windows that have been scanned, not about every promise you have ever made.
        </p>
      )}
    </PageShell>
  );
}
