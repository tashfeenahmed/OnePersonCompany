/**
 * A FINISHED RUN'S CARDS GO STRAIGHT ONTO THE BOARD.
 *
 * Every analyst kind ends its report with a ```json cards``` fence — three to
 * eight actions the run thinks the owner should take. Until 2026-09-18 that
 * fence was a PROPOSAL: the run page drew it as a panel with a button, and
 * nothing was written until a person pressed. The owner asked for the
 * opposite — a worker that found something should write it down without
 * asking — so this files each card into Backlog the moment the run is done.
 *
 * INTO BACKLOG AND NOWHERE ELSE, with the run's venture on it. Nothing here
 * picks a column: a run that decided its work belonged in Next would be making
 * a scheduling claim it has no standing for. Backlog is the board's own "not
 * yet looked at", which is exactly what a card nobody has read is.
 *
 * THROUGH `fileCard`, WHICH IS WHAT THE BOARD AUTOMATION USES, and for its
 * dedupe rather than its column. The origin is `run:<id>:<n>`, so a report
 * re-read, re-filed or re-finished never writes the same card twice, and a
 * card the owner has since archived or deleted stays gone — the UNIQUE index
 * on `origin` and the filings receipt both refuse it. That receipt is also why
 * this does NOT go through the automation's `enabled` switch: that switch is
 * about the collectors (health, inbox, growth) sweeping data the owner did not
 * ask about. A run is work the owner asked for.
 *
 * VALIDATED THE WAY THE CLIENT VALIDATES. `readCards` on the run page drops
 * an entry with no title and clamps urgency to 0–3; a server that filed what
 * the page would refuse to draw would put cards on the board the report does
 * not show. Same rules, so the panel and the board agree on the count.
 *
 * NEVER THROWS INTO THE EXECUTOR. A run that finished is finished; a board
 * that cannot be written to (no Backlog column, a locked database) is a
 * problem for the log, not a reason to mark the report failed.
 */
import { db } from "../../db.ts";
import { fileCard } from "../../routes/board.ts";
import { fencedJson, kindDef } from "./kinds.ts";
import { runRow } from "./store.ts";

/** The prompt asks for three to eight; a model that wrote twenty did not
 *  read the brief, and twenty cards from one run is a feed, not a board. */
const MAX_CARDS = 8;

export type FiledCard = { title: string; body: string; urgency: number };

/** The cards a run's report carries, in the shape the board takes — the
 *  same tolerance and the same refusals as the client's `readCards`. */
export function cardsOf(output: string): FiledCard[] {
  const parsed = fencedJson(output, "cards");
  if (!Array.isArray(parsed)) return [];
  const out: FiledCard[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.title !== "string" || !r.title.trim()) continue;
    const urgency = Number(r.urgency);
    out.push({
      title: r.title.trim(),
      body: typeof r.body === "string" ? r.body.trim() : "",
      urgency: Number.isInteger(urgency) && urgency >= 0 && urgency <= 3 ? urgency : 1,
    });
    if (out.length === MAX_CARDS) break;
  }
  return out;
}

export const runCardOrigin = (runId: string, index: number) => `run:${runId}:${index}`;

/**
 * File a finished run's cards. Answers how many were written this call —
 * zero on a second call for the same run, which is the dedupe working.
 */
export function fileRunCards(runId: string): { filed: number; total: number } {
  const row = runRow(runId);
  if (!row || row.status !== "done") return { filed: 0, total: 0 };
  const cards = cardsOf(row.output);
  if (!cards.length) return { filed: 0, total: 0 };
  const name = kindDef(row.kind)?.name ?? row.kind;
  let filed = 0;
  for (const [i, card] of cards.entries()) {
    /* WHERE IT CAME FROM, on the card itself. The board draws no origin
       column, and a card that says "Rewrite the pricing page" with nothing
       under it reads as something the owner typed and forgot. One line, last,
       so the model's own reasoning stays the body. */
    const body = [card.body, `From the ${name} run ${row.id}.`].filter(Boolean).join("\n\n");
    const res = fileCard({
      origin: runCardOrigin(row.id, i),
      title: card.title,
      body,
      ventureId: row.venture_id,
      urgency: card.urgency,
    });
    if (res.filed) filed++;
  }
  return { filed, total: cards.length };
}

/** How many of a run's cards are on the board now — archived ones included,
 *  because they were filed; deleted ones not, because they are gone. The run
 *  page reads this to know whether to draw its panel as a record or as a
 *  button for a report that finished before cards were filed automatically. */
export function runCardsFiled(runId: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM board_cards WHERE origin LIKE ?").get(`run:${runId}:%`) as { n: number }
  ).n;
}
