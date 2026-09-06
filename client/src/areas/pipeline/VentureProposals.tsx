import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/live";
import { cn } from "@/lib/utils";
import { synthesisApi } from "./api";

/**
 * ONE VENTURE'S PROPOSED ACTIONS, on the venture's own page.
 *
 * WHY IT SHOWS THE REFUSALS TOO. The first question the owner asks of a section
 * like this is "why has it never suggested the obvious thing", and the honest
 * answer is usually that it did and the gate refused it — because the card is
 * already on the board, or because it rested on a figure this box does not
 * measure for this venture. Hiding that turns a working feature into one that
 * looks asleep.
 *
 * THE BUTTON SAYS WHAT IT COSTS. One model call over the whole evidence packet;
 * survivors of the gate become ordinary board cards in Backlog, which the owner
 * can delete. Nothing here does the work.
 */
export function VentureProposals({ ventureId }: { ventureId: string }) {
  /* Six rows and no stored packets. Each packet is the whole evidence document
     the model saw; twelve of them arrived on every Overview render, on a page
     that draws one line from each. The evidence LINE is on the row either way. */
  const doc = useApi(() => synthesisApi.all({ ventureId, limit: 6 }), [ventureId]);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (doc.error || !doc.data) return null;
  const { proposals, coverage } = doc.data;
  const mine = coverage.find((c) => c.ventureId === ventureId);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-[15px] font-medium">Proposed actions</h2>
        <span className="text-muted-foreground text-[11.5px]">
          {mine?.lastPassAt ? `last looked at ${ago(mine.lastPassAt)}` : "no pass yet"}
          {mine && !mine.proposalsOn ? " · proposals are switched off for this venture" : ""}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setFailure(null);
            setSaid(null);
            synthesisApi
              .run(ventureId)
              .then((out) =>
                setSaid(out.ran ? `${out.filed} filed, ${out.dropped} refused.` : (out.why ?? null)),
              )
              .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
              .finally(() => {
                setBusy(false);
                doc.reload();
              });
          }}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" strokeWidth={1.6} />}
          Look at this venture now
        </Button>
      </div>
      <p className="text-muted-foreground text-[11.5px]">
        One model call over this venture's revenue, traffic, alerts, board, goals, memory and recent
        runs. Survivors of the gate become board cards in Backlog; nothing is done.
      </p>
      {said && <p className="text-muted-foreground text-[12.5px]">{said}</p>}
      {failure && <p className="text-destructive text-[12.5px]">{failure}</p>}

      {proposals.length === 0 ? (
        <p className="text-muted-foreground text-[12.5px]">
          Nothing has been proposed for this venture yet.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {proposals.map((p) => (
            <div
              key={p.id}
              className="border-line-soft bg-card flex flex-col gap-1 rounded-[10px] border px-3 py-2 text-[12.5px]"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span
                  className={cn(
                    "shrink-0 text-[11px]",
                    p.verdict === "filed" ? "text-ok-foreground" : "text-muted-foreground",
                  )}
                >
                  {p.verdict}
                </span>
                <span className="font-medium">{p.title}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-[11.5px]">{ago(p.at)}</span>
              </div>
              {p.why && <p className="text-muted-foreground text-[11.5px]">{p.why}</p>}
              {p.evidenceLine && (
                <p className="text-muted-foreground text-[11.5px]">
                  Evidence ({p.evidenceKey}): {p.evidenceLine}
                </p>
              )}
              {p.reason && <p className="text-muted-foreground text-[11.5px]">Refused — {p.reason}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
