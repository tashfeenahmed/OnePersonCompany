/**
 * WHEN THE ACTION INBOX SHOWS NOTHING, WHY — decided here, drawn by the page.
 *
 * The inbox answers two very different questions with one sentence today:
 * "nothing anywhere is waiting for you" (a good morning, worth saying as
 * itself) and "the filter you typed hides everything" (a dead end that asks
 * to be undone). A reader who cannot tell them apart stops trusting the empty
 * list, which is the failure mode an inbox exists to avoid.
 *
 * The rule lives here rather than inline in the page for the usual reason:
 * it is a decision about meaning, and every other such decision in this
 * client is a pure function with its own test (`payments.ts`, `boardCompletion.ts`).
 */

export type InboxCounts = {
  /** Rows the server reported, before the page's own search and filter. */
  total: number;
  /** Rows the page has resolved or snoozed since the last load. */
  handled: number;
  /** Whether a search string or a source filter is narrowing the list. */
  filtered: boolean;
};

export type InboxEmpty =
  /** The server had nothing to hand over at all: every source is clear. */
  | { kind: "clear" }
  /** The server had rows; the owner's own view hid or resolved them all. */
  | { kind: "view-empty"; hidden: number }
  /** Not empty at all — draw the list. */
  | { kind: "list" };

/**
 * `visible` counts the rows the page would draw. `counts.total` is what the
 * server sent, so "you have cleared the inbox" and "your filter matches
 * nothing" stay distinguishable even after every visible row was resolved
 * from this screen — those rows still existed, and the sentence should know.
 */
export function inboxEmpty(visible: number, counts: InboxCounts): InboxEmpty {
  if (visible > 0) return { kind: "list" };
  if (counts.total === 0 && counts.handled === 0) return { kind: "clear" };
  return { kind: "view-empty", hidden: Math.max(0, counts.total - visible) };
}
