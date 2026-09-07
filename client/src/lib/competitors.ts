/**
 * THE RULES THE COMPETITOR TABLE DRAWS BY.
 *
 * ---------------------------------------------------------------------------
 * A LEAF. No imports, no DOM, no `@/` alias — so `competitors.test.ts` can
 * strip the types and run it under node, the way `report.ts` and `format.ts`
 * next door already do. Everything here is a decision about what a row MEANS
 * rather than what it looks like, and each one fails as a plausible wrong
 * answer rather than as a crash, which is the whole reason they are out of the
 * component: a staleness threshold that never fires makes a two-month-old
 * price read as today's, and a change badge that never clears is a badge
 * nobody reads.
 *
 * THE REGISTER IS CUMULATIVE AND THE BADGES ARE NOT, and that distinction is
 * this file's main job. Who is in this market is everything every sweep has
 * ever verified — it has no window, and cutting it to a week would report
 * three rivals for a market with eleven. What CHANGED is news, and news
 * expires: a price move from June is history, and after `CHANGE_FRESH_DAYS` it
 * stops wearing a badge and lives in the disclosure instead.
 */

/** One recorded movement, as the wire carries it. Declared here rather than
 *  imported from `api/runs.ts` because that file cannot be loaded under node —
 *  it resolves the `@/` alias — and this one has to be. The two shapes are
 *  structurally identical, which is what keeps them assignable. */
export type ChangeLike = {
  at: string;
  field: string;
  from: string | null;
  to: string;
  note: string;
};

/**
 * PAST THIS MANY DAYS, "VERIFIED" IS A WARNING RATHER THAN A REASSURANCE.
 *
 * Six weeks. It is set against how often the sweep actually runs rather than
 * against how fast a market moves: a rival nobody has confirmed in six weeks
 * has been skipped by several sweeps in a row, which means the model stopped
 * finding it — a real signal, and one worth a colour. A threshold at a week
 * would paint the whole table amber the moment the owner stopped running
 * sweeps daily, and a table that is always amber says nothing.
 */
export const COMPETITOR_STALE_DAYS = 45;

/** How long a change stays news. A month: long enough that a sweep run
 *  fortnightly still shows the owner what moved since they last looked, short
 *  enough that the badge clears. */
export const CHANGE_FRESH_DAYS = 30;

/** Whether a row's verified date should be drawn as a warning. Null — a date
 *  the server could not read — is NOT stale: it is unknown, and colouring it
 *  as a warning would be inventing a claim about it. */
export function isStale(verifiedAgo: number | null): boolean {
  return verifiedAgo !== null && verifiedAgo > COMPETITOR_STALE_DAYS;
}

/**
 * "verified 12 days ago", in the words the column uses.
 *
 * THE SERVER COUNTS THE DAYS AND THIS ONLY WORDS THEM. `verifiedAgo` arrives
 * already computed — see the route — because a browser with a skewed clock, or
 * one that has just crossed midnight into the next day, would otherwise
 * disagree with the box that recorded the date about how old a row is.
 */
export function verifiedLabel(verifiedAgo: number | null): string {
  if (verifiedAgo === null) return "never verified";
  if (verifiedAgo === 0) return "verified today";
  if (verifiedAgo === 1) return "verified yesterday";
  return `verified ${verifiedAgo} days ago`;
}

/**
 * The newest change worth putting a badge on, or null.
 *
 * NEWEST WINS AND OLD ONES DO NOT COUNT. A rival with four movements on file
 * wears one badge, carrying the most recent note, and only while that note is
 * inside the window. Everything else is still readable in the disclosure — the
 * history is not hidden, it just stops shouting.
 *
 * AN UNPARSEABLE DATE IS NOT NEWS. A hand-edited row with a broken timestamp
 * must not badge forever, so a change this cannot date is skipped rather than
 * treated as today.
 */
export function recentChange(
  changes: ChangeLike[] | undefined,
  now: Date = new Date(),
): ChangeLike | null {
  let best: ChangeLike | null = null;
  let bestAt = -Infinity;
  for (const c of changes ?? []) {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at)) continue;
    if (now.getTime() - at > CHANGE_FRESH_DAYS * 86_400_000) continue;
    if (at <= bestAt) continue;
    bestAt = at;
    best = c;
  }
  return best;
}

/**
 * THE `json competitors` BLOCK OUT OF AN OLD REPORT.
 *
 * ---------------------------------------------------------------------------
 * IT IS HISTORY, AND IT IS STILL ON DISK. The sweep used to be ONE turn that
 * wrote a markdown report with a ```` ```json competitors ```` block in it
 * beside the cards: the block was the only thing that updated the profile
 * table, so it had to be in the answer the owner read, and it rendered as a
 * screenful of raw JSON at the foot of every report. The sweep is now two
 * turns and the rivals come back in a turn nobody sees — see the server's
 * `integrations/runs/competitors.ts` — so nothing writes one of these any
 * more.
 *
 * BUT EVERY SWEEP RUN BEFORE THAT STILL HAS ONE, and those rows are read every
 * time somebody opens an old report. So the block comes out HERE rather than
 * being migrated out of the column: a migration that rewrote finished reports
 * would be editing what a run actually said, which is the one thing a ledger
 * is for. The stored answer keeps its block; the reader stops being shown it.
 *
 * NOTHING IS PARSED, unlike the cards. This block has no panel to become — the
 * register is fetched from `/api/competitors`, which is the authority on it —
 * so the only question is where it starts and where it stops.
 *
 * THE CLOSING FENCE IS REQUIRED, for `readCards`' reason: a half-written block
 * on a report that is still streaming matches nothing, stays in the markdown
 * as the unterminated fence it is, and disappears the moment it closes.
 */
const COMPETITORS_FENCE = /^[ \t]*```(?:json[ \t]+)?competitors[ \t]*\n[\s\S]*?^[ \t]*```[ \t]*$/gim;

export function stripCompetitorsFence(md: string): string {
  return md.replace(COMPETITORS_FENCE, "").trimEnd();
}
