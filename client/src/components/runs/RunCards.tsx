import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { RunCard } from "@/lib/api/runs";
import { URGENCY } from "@/components/runs/format";

/**
 * WHAT THE RUN PUT ON THE BOARD — or, for an older run, what it only proposed.
 *
 * Every kind's brief ends by asking for a fenced json block of cards, and
 * SINCE 2026-09-18 THE SERVER FILES THEM into Backlog the moment the run is
 * done (see server integrations/runs/cards.ts). The owner asked for that: a
 * worker that found something should write it down, not offer it in chat and
 * wait. So on a new run this panel is a RECORD — the cards, each marked filed,
 * and a link to the board — and there is nothing to press.
 *
 * THE BUTTON IS STILL HERE FOR THE RUNS THAT PREDATE THAT. A report finished
 * under the old rule was never filed, and the server does not file it
 * retroactively — a hundred cards from a fortnight of test runs appearing in
 * Backlog on the day of a deploy is a feed, not a board. For those,
 * `filedByServer` is zero and the panel behaves as it always did: checked by
 * default, one press files the ticked ones, filed ones go grey and stay.
 *
 * IT FILES INTO BACKLOG AND SETS THE VENTURE, whichever side does the filing.
 * Nothing here picks a column: a run that decided which column its cards
 * belonged in would be making a scheduling claim it has no standing for.
 */
export function RunCards({
  cards,
  ventureId,
  filedByServer = 0,
}: {
  cards: RunCard[];
  /** The run's venture, stamped on every card so they land under it on the
   *  board. Null for a run that named no venture — a papers run on a typed
   *  topic — and the cards are filed unfiled, which is the truth. */
  ventureId: string | null;
  /** How many of these the server already put in Backlog when the run
   *  finished. Positive means the panel is a record, not a form. */
  filedByServer?: number;
}) {
  const [chosen, setChosen] = useState<Set<number>>(
    () => new Set(cards.map((_, i) => i)),
  );
  const [filed, setFiled] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  if (!cards.length) return null;

  const record = filedByServer > 0;
  const pending = [...chosen].filter((i) => !filed.has(i));

  async function file() {
    setBusy(true);
    setRefused(null);
    const done = new Set(filed);
    try {
      /* IN SERIES, not Promise.all. Every board write answers with the whole
         board document and takes a position within a column; six of them at
         once is six writers racing for the same sort keys for no gain — this
         is at most a handful of rows and the wait is a spinner nobody watches
         for long. */
      for (const i of pending) {
        const card = cards[i]!;
        await api.boardAddCard({
          title: card.title,
          body: card.body || null,
          ventureId,
          urgency: card.urgency,
        });
        done.add(i);
        setFiled(new Set(done));
      }
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card mt-5 rounded-[14px] p-4.5">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[14px] font-medium tracking-tight">
          {record ? "Filed on the board" : "File these on the board"}
        </span>
        <span className="text-muted-foreground text-[12.5px]">
          {record
            ? `${filedByServer} ${filedByServer === 1 ? "card" : "cards"} from this run ${filedByServer === 1 ? "is" : "are"} in Backlog.`
            : `${cards.length} ${cards.length === 1 ? "suggestion" : "suggestions"} from this run. Nothing has been written until you press.`}
        </span>
      </div>

      <div className="flex flex-col gap-px">
        {cards.map((card, i) => {
          const isFiled = record || filed.has(i);
          return (
            <label
              key={i}
              className={cn(
                "-mx-1.5 flex items-start gap-2.5 rounded-md px-1.5 py-1.5",
                record ? "cursor-default" : "hover:bg-accent cursor-pointer",
                isFiled && !record && "cursor-default opacity-55 hover:bg-transparent",
              )}
            >
              {!record && (
                <input
                  type="checkbox"
                  /* The browser's own checkbox, unstyled. Nothing else in this
                      app has one, so there is no house checkbox to match — and a
                      hand-drawn box would have to reimplement the focus ring and
                      the indeterminate state for six rows. */
                  className="mt-[3px] size-3.5 shrink-0"
                  checked={isFiled || chosen.has(i)}
                  disabled={isFiled || busy}
                  onChange={(e) =>
                    setChosen((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      return next;
                    })
                  }
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[14px] leading-snug">{card.title}</span>
                  {card.urgency !== 1 && (
                    <span className="text-muted-foreground shrink-0 rounded-[8px] border px-1.5 py-px text-[11.5px] leading-[1.5]">
                      {URGENCY[card.urgency] ?? card.urgency}
                    </span>
                  )}
                  {isFiled && (
                    <span className="text-ok flex shrink-0 items-center gap-1 text-[12px]">
                      <Check className="size-3" strokeWidth={2} />
                      filed
                    </span>
                  )}
                </span>
                {card.body && (
                  <span className="text-muted-foreground mt-0.5 block text-[13px] leading-relaxed">
                    {card.body}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        {!record && (
          <Button disabled={busy || !pending.length} onClick={() => void file()}>
            {busy && <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} />}
            {pending.length === 0
              ? filed.size
                ? "All filed"
                : "Nothing ticked"
              : `File ${pending.length} on the board`}
          </Button>
        )}
        {(record || filed.size > 0) && (
          <Link
            to="/board"
            className="text-muted-foreground hover:text-foreground text-[13px]"
          >
            {record ? "Open the board" : `${filed.size} ${filed.size === 1 ? "card is" : "cards are"} in Backlog — open the board`}
          </Link>
        )}
      </div>

      {refused && (
        <p className="text-destructive mt-2 text-[13.5px] leading-relaxed">
          {refused}
          {filed.size > 0 &&
            ` ${filed.size} ${filed.size === 1 ? "card" : "cards"} had already been written; pressing again files only the rest.`}
        </p>
      )}
    </div>
  );
}
