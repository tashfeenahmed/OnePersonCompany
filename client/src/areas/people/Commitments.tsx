import { useState } from "react";
import { Handshake, Loader2, Search } from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { useApi } from "@/hooks/useApi";
import { peopleApi, type ScanResult } from "@/lib/api/people";
import { humanizeStamps, plural } from "@/lib/mailText";
import { EmptyState, FilterChips, Problem, SmallPrint } from "@/areas/mailflow/parts";
import { CommitmentRow } from "./parts";

/**
 * PROMISES (route /mail/commitments) — what the owner said they would do,
 * lifted out of their own sent mail. Each row is the promise, the sentence it
 * came from, who it was to and when it's due; Done / Dismiss / Reopen decide it.
 *
 * "Look for new promises" scans the last N days of sent mail. Its full tally
 * (how many sentences were judged, refused, unjudged…) is folded under the
 * one-line result, because an unjudged count must stay visible to anyone who
 * wants it — a scan with no model behind it looks like a quiet fortnight.
 */
type Status = "open" | "done" | "dismissed" | "all";

export function Commitments() {
  const [status, setStatus] = useState<Status>("open");
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
      title="Promises"
      wide
      action={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-[12.5px]">Check sent mail from the last</span>
          <SelectField
            aria-label="How far back to look"
            value={days}
            onValueChange={setDays}
            className="border-line-soft flex h-8 rounded-md border px-2 text-[13px]"
          >
            <SelectOption value="7">7 days</SelectOption>
            <SelectOption value="14">14 days</SelectOption>
            <SelectOption value="30">30 days</SelectOption>
            <SelectOption value="90">90 days</SelectOption>
          </SelectField>
          <Button size="sm" variant="outline" onClick={runScan} disabled={busy === "scan"}>
            {busy === "scan" ? <Loader2 className="animate-spin" /> : <Search />}
            {busy === "scan" ? "Looking…" : "Look for new promises"}
          </Button>
        </div>
      }
    >
      <FilterChips
        label="Show"
        value={status}
        onChange={setStatus}
        className="mb-4"
        chips={[
          { key: "open", label: "To do", count: d?.counts.open, urgent: true },
          { key: "done", label: "Done", count: d?.counts.done },
          { key: "dismissed", label: "Dismissed", count: d?.counts.dismissed },
          { key: "all", label: "All" },
        ]}
      />

      {d && d.overdue > 0 && status !== "done" && status !== "dismissed" && (
        <p className="text-destructive mb-3 text-[13.5px]">{plural(d.overdue, "promise")} past the date you gave.</p>
      )}

      {problem && <Problem className="mb-3">{problem}</Problem>}

      {scan && (
        <div className="border-line-soft mb-4 rounded-lg border p-3 text-[13px]">
          {scan.ok ? (
            <p>
              Checked {plural(scan.scanned, "sent email")} from the last {scan.days} days —{" "}
              {scan.filed ? `found ${plural(scan.filed, "new promise")}.` : "no new promises."}
              {!scan.judgeModel && (
                <span className="text-warn"> The AI didn't answer, so nothing could be checked.</span>
              )}
            </p>
          ) : (
            <p className="text-destructive">{scan.error ?? "The check failed."}</p>
          )}
          {scan.ok && (
            <SmallPrint summary="Details" className="mt-1.5">
              <p>
                {scan.scanned} of {scan.listed} sent emails read · {scan.candidates} sentences checked · {scan.filed} added ·{" "}
                {scan.alreadyKnown} already known · {scan.notPromise} not a promise · {scan.refusedSpans} refused as not
                word-for-word · {scan.noRecipient} with no readable recipient
                {scan.unshown ? ` · ${scan.unshown} past the per-email limit, not checked` : ""}.
              </p>
              <p>
                {scan.judgeModel
                  ? `Checked by ${scan.judgeModel}.`
                  : `No AI answered, so ${scan.unjudged} sentences went unchecked and nothing was added.`}
                {scan.unjudged && scan.judgeModel ? ` ${scan.unjudged} sentences went unchecked and were not added.` : ""}
                {scan.model ? ` Wording tightened by ${scan.model}.` : ""}
              </p>
              {scan.note && <p>{scan.note}</p>}
            </SmallPrint>
          )}
        </div>
      )}

      {doc.error && <Problem>{doc.error}</Problem>}
      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" /> Loading…
        </p>
      )}

      {d && d.commitments.length > 0 && (
        <div className="border-line-soft bg-card overflow-hidden rounded-xl border">
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

      {!doc.loading && d && !d.commitments.length && (
        <EmptyState
          icon={Handshake}
          title={status === "open" ? "No open promises" : "Nothing here"}
          body={
            (d.note ? humanizeStamps(d.note) : null) ??
            (status === "open"
              ? "Nothing you've promised in your sent mail is waiting. Use “Look for new promises” to check recent emails."
              : "Pick another filter above.")
          }
        />
      )}

      <SmallPrint summary="How this works" className="mt-8">
        <p>
          Promises are found in your own sent mail. Only the sentence you wrote, who it was to and the date are kept —
          the rest of the email is read and thrown away. A promise without a date is never marked overdue.
        </p>
      </SmallPrint>
    </PageShell>
  );
}
