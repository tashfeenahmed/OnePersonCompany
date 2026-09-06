import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { RunCard } from "@/lib/api/runs";
import { URGENCY } from "@/components/runs/format";

/**
 * WHAT THE RUN THINKS YOU SHOULD DO, AS CARDS NOBODY HAS FILED YET.
 *
 * Every kind's brief ends by asking for a fenced json block of suggestions, and
 * THE SERVER DOES NOT FILE THEM. That is the product decision this panel is
 * the whole mechanism for: a board that fills itself is a different thing than
 * the one being built here — every card on that board is one somebody meant to
 * put there — so a run proposes and a person presses. The alternative was ten
 * cards appearing overnight from a report nobody read, which is how a board
 * becomes a feed you scroll past.
 *
 * CHECKED BY DEFAULT, because somebody who opened a finished report and got to
 * the bottom of it has already read the suggestions; making them tick six
 * boxes to agree with what they just read is friction pretending to be
 * consent. Unticking is one press, and the button says exactly how many will
 * be written.
 *
 * FILED ONES GO GREY AND STAY, they do not vanish. A card that disappeared on
 * being filed would leave the reader unsure whether it was written or lost,
 * and re-reading the report later would show a shorter list than the report
 * actually produced. The panel is part of the record of the run.
 *
 * IT FILES INTO BACKLOG AND SETS THE VENTURE. Nothing here picks a column: the
 * board's own default for a card typed in a hurry is Backlog, and a run that
 * decided which column its suggestions belonged in would be making a
 * scheduling claim it has no standing for.
 */
export function RunCards({
  cards,
  ventureId,
}: {
  cards: RunCard[];
  /** The run's venture, stamped on every card so they land under it on the
   *  board. Null for a run that named no venture — a papers run on a typed
   *  topic — and the cards are filed unfiled, which is the truth. */
  ventureId: string | null;
}) {
  const [chosen, setChosen] = useState<Set<number>>(
    () => new Set(cards.map((_, i) => i)),
  );
  const [filed, setFiled] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  if (!cards.length) return null;

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
    <div className="bg-card mt-5 rounded-[10px] border p-3.5">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium tracking-tight">
          File these on the board
        </span>
        <span className="text-muted-foreground text-[11.5px]">
          {cards.length} {cards.length === 1 ? "suggestion" : "suggestions"} from
          this run. Nothing has been written until you press.
        </span>
      </div>

      <div className="flex flex-col gap-px">
        {cards.map((card, i) => {
          const isFiled = filed.has(i);
          return (
            <label
              key={i}
              className={cn(
                "hover:bg-accent -mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5",
                isFiled && "cursor-default opacity-55 hover:bg-transparent",
              )}
            >
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
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[13px] leading-snug">{card.title}</span>
                  {card.urgency !== 1 && (
                    <span className="text-muted-foreground shrink-0 rounded-[6px] border px-1.5 py-px text-[10.5px] leading-[1.5]">
                      {URGENCY[card.urgency] ?? card.urgency}
                    </span>
                  )}
                  {isFiled && (
                    <span className="text-ok flex shrink-0 items-center gap-1 text-[11px]">
                      <Check className="size-3" strokeWidth={2} />
                      filed
                    </span>
                  )}
                </span>
                {card.body && (
                  <span className="text-muted-foreground mt-0.5 block text-[12px] leading-relaxed">
                    {card.body}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <Button disabled={busy || !pending.length} onClick={() => void file()}>
          {busy && <Loader2 className="size-[15px] animate-spin" strokeWidth={1.8} />}
          {pending.length === 0
            ? filed.size
              ? "All filed"
              : "Nothing ticked"
            : `File ${pending.length} on the board`}
        </Button>
        {filed.size > 0 && (
          <Link
            to="/board"
            className="text-muted-foreground hover:text-foreground text-[12px]"
          >
            {filed.size} {filed.size === 1 ? "card is" : "cards are"} in Backlog —
            open the board
          </Link>
        )}
      </div>

      {refused && (
        <p className="text-destructive mt-2 text-[12.5px] leading-relaxed">
          {refused}
          {filed.size > 0 &&
            ` ${filed.size} ${filed.size === 1 ? "card" : "cards"} had already been written; pressing again files only the rest.`}
        </p>
      )}
    </div>
  );
}
