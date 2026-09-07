import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ago, pct } from "@/lib/format";
import { Note, PanelSection, Row, Rows, Tiles } from "@/components/integrations/Panel";
import { seoopsApi, type ListingCell, type ListingState } from "@/lib/api/seoops";

/**
 * THE DIRECTORY LEDGER, EDITED IN PLACE, UNDER THE PROBES THAT FEED IT.
 *
 * It sits on the Presence plugin page rather than in a rail row of its own
 * because the two are one question asked twice: the matrix above says what a
 * crawler could find, this says what the owner actually did. Splitting them
 * across two pages would make the second one somewhere nobody goes.
 *
 * SIX STATES AND THE COLOURS SAY WHICH ARE THE OWNER'S. `confirmed` and
 * `submitted` are green because they are work; `detected` is deliberately NOT
 * green — a probe found a page and nobody has read it — and `not_listed` is
 * the muted default that means "nobody has looked" as often as it means "not
 * there". A page that drew detected and confirmed the same colour would be a
 * page telling the owner a crawler had done their work for them.
 *
 * THE SELECT WRITES IMMEDIATELY AND THE NOTE ON BLUR. Six directories times
 * twenty ventures is a lot of rows to make somebody press Save on, and every
 * write here is one small reversible fact.
 */
const TONE: Record<ListingState, ComponentProps<typeof Badge>["variant"]> = {
  confirmed: "ok",
  submitted: "ok",
  /* Evidence, not a tick — so it reads as "look at this", not "done". */
  detected: "warn",
  pending: "outline",
  skipped: "secondary",
  not_listed: "secondary",
};

/** The two edges the variants cannot carry: nothing has been asked for yet,
 *  and a row somebody deliberately took out of the count. */
const EDGE: Partial<Record<ListingState, string>> = {
  pending: "border-dashed",
  skipped: "opacity-60",
};

const LABEL: Record<ListingState, string> = {
  confirmed: "confirmed",
  submitted: "submitted",
  detected: "detected",
  pending: "preparing",
  skipped: "skipped",
  not_listed: "not listed",
};

export function ListingsPanel({ venture }: { venture?: string }) {
  const doc = useApi(() => seoopsApi.listings(venture), [venture]);
  const [busy, setBusy] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function set(
    ventureId: string,
    cell: ListingCell,
    patch: { state?: ListingState; note?: string | null; url?: string | null },
  ) {
    const key = `${ventureId}:${cell.directory}`;
    setBusy(key);
    setProblem(null);
    try {
      await seoopsApi.setListing({
        venture: ventureId,
        directory: cell.directory,
        state: patch.state ?? cell.state,
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
      });
      doc.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function detect() {
    setDetecting(true);
    setProblem(null);
    try {
      await seoopsApi.detectListings();
      doc.reload();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }

  if (doc.error) return <Note>The ledger is not answering: {doc.error}</Note>;
  if (!doc.data) return null;
  const d = doc.data;

  const totals = d.ventures.reduce(
    (a, v) => ({
      confirmed: a.confirmed + v.summary.confirmed,
      submitted: a.submitted + v.summary.submitted,
      detected: a.detected + v.summary.detected,
      skipped: a.skipped + v.summary.skipped,
    }),
    { confirmed: 0, submitted: 0, detected: 0, skipped: 0 },
  );

  /* Ventures with nothing recorded are collapsed by default. A portfolio of
     twenty would otherwise be twenty identical walls of "not listed". */
  const worked = d.ventures.filter((v) => v.summary.of - v.summary.notListed > 0);
  const untouched = d.ventures.filter((v) => v.summary.of === v.summary.notListed);
  const shown = venture ? d.ventures : worked.length ? worked : d.ventures.slice(0, 1);

  return (
    <PanelSection
      title="Directory ledger"
      meta={
        <span className="flex items-center gap-3">
          <span>
            {d.catalogue.count} directories · {d.catalogue.detectable} can be probed
          </span>
          <Button variant="outline" size="sm" disabled={detecting} onClick={() => void detect()}>
            {detecting ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <RefreshCw className="size-3.5" strokeWidth={1.8} />
            )}
            Ratchet from probes
          </Button>
        </span>
      }
    >
      <Tiles
        items={[
          { v: String(totals.confirmed), k: "confirmed by you" },
          { v: String(totals.submitted), k: "submitted, waiting" },
          { v: String(totals.detected), k: "detected — evidence, not a tick" },
          { v: String(totals.skipped), k: "skipped as not applicable" },
        ]}
      />

      {problem && <p className="text-destructive mb-2 text-[13.5px]">{problem}</p>}

      <Rows>
        {shown.map((v, i) => (
          <Row key={v.ventureId} first={i === 0}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[14px] font-medium">{v.venture}</span>
              {v.host && <span className="text-muted-foreground font-mono text-[12.5px]">{v.host}</span>}
              <span className="text-muted-foreground ml-auto text-[12.5px] tabular-nums">
                {v.summary.confirmed + v.summary.submitted} of {v.summary.of - v.summary.skipped} worked
                {v.summary.donePct === null ? " — every row skipped" : ` · ${pct(v.summary.donePct / 100)}`}
              </span>
            </div>

            <div className="border-line-soft mt-2 overflow-hidden rounded-[11px] border">
              {v.directories.map((cell, j) => {
                const key = `${v.ventureId}:${cell.directory}`;
                return (
                  <div key={cell.directory} className={cn(j > 0 && "border-line-soft border-t")}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-[13px]">
                      <button
                        className="hover:text-foreground text-left"
                        onClick={() => setOpen(open === key ? null : key)}
                        title={cell.note}
                      >
                        <span className="font-medium">{cell.name}</span>
                        <span className="text-muted-foreground"> · {cell.tier}</span>
                      </button>

                      <Badge variant={TONE[cell.state]} className={EDGE[cell.state]}>
                        {LABEL[cell.state]}
                      </Badge>

                      {cell.setBy && (
                        <span className="text-muted-foreground text-[12px]">
                          by {cell.setBy === "owner" ? "you" : "a probe"}
                        </span>
                      )}

                      <select
                        className="border-line-soft bg-card ml-auto rounded-[8px] px-1.5 py-0.5 text-[12.5px]"
                        value={cell.state}
                        disabled={busy === key}
                        onChange={(e) => void set(v.ventureId, cell, { state: e.target.value as ListingState })}
                      >
                        {d.states.map((s) => (
                          <option key={s} value={s}>
                            {LABEL[s]}
                          </option>
                        ))}
                      </select>

                      <a
                        href={cell.url ?? cell.submitUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-foreground text-[12.5px]"
                      >
                        {cell.url ? "open listing" : "submit"}
                      </a>
                    </div>

                    {open === key && (
                      <div className="border-line-soft bg-muted/20 border-t px-2.5 py-2">
                        <p className="text-muted-foreground mb-2 text-[12.5px] leading-relaxed">
                          {cell.note}
                          {cell.detectableBy
                            ? ` A probe can look at this one (${cell.detectableBy}); it may only ever move the row forward to “detected”.`
                            : " Nothing here can probe this one — it is yours to work through."}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <input
                            className="border-line-soft bg-card min-w-[220px] flex-1 rounded-[8px] px-3 py-1.5 text-[13px]"
                            placeholder="Listing url (https only)"
                            defaultValue={cell.url ?? ""}
                            onBlur={(e) => {
                              if (e.target.value.trim() === (cell.url ?? "")) return;
                              void set(v.ventureId, cell, { url: e.target.value.trim() || null });
                            }}
                          />
                          <input
                            className="border-line-soft bg-card min-w-[220px] flex-1 rounded-[8px] px-3 py-1.5 text-[13px]"
                            placeholder="Your note — why skipped, what you sent, what to chase"
                            defaultValue={cell.ownerNote ?? ""}
                            onBlur={(e) => {
                              if (e.target.value.trim() === (cell.ownerNote ?? "")) return;
                              void set(v.ventureId, cell, { note: e.target.value.trim() || null });
                            }}
                          />
                        </div>
                        <div className="text-muted-foreground mt-2 flex flex-wrap gap-3 text-[12px]">
                          {cell.submittedAt && <span>submitted {ago(cell.submittedAt)}</span>}
                          {cell.confirmedAt && <span>confirmed {ago(cell.confirmedAt)}</span>}
                          {cell.detectedAt && <span>first detected {ago(cell.detectedAt)}</span>}
                          {cell.lastChecked && <span>probe last looked {ago(cell.lastChecked)}</span>}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Row>
        ))}
      </Rows>

      {!venture && untouched.length > 0 && (
        <Note>
          {untouched.length} other venture{untouched.length === 1 ? " has" : "s have"} no directory row
          recorded yet. Open one from its own page to work through the list.
        </Note>
      )}
      {d.catalogue.errors.map((e) => (
        <Note key={e}>{e}</Note>
      ))}
      {d.notes.map((n) => (
        <Note key={n}>{n}</Note>
      ))}
    </PanelSection>
  );
}
