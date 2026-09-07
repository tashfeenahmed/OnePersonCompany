/**
 * THE THREE SENTENCES THE WATCHLIST'S NEW NUMBERS TURN INTO, AND WHY THEY ARE
 * A MODULE RATHER THAN THREE LINES INSIDE A COMPONENT.
 *
 * ALL THREE ARE ABOUT ABSENCE, AND ABSENCE IS WHERE A DASHBOARD LIES. The
 * server sends a seven-day delta as a PARTIAL object: a key is there when
 * there was a reading a week ago to subtract, and missing when there was not.
 * `{ ghFollowers: 0 }` means they gained nobody; a missing `ghFollowers` means
 * nobody knows. Those are one keystroke apart in a component (`deltas.x ?? 0`)
 * and they are opposite claims — the first is a measurement of a quiet week,
 * the second is a person added on Tuesday about whom nothing has been measured
 * at all. Writing that fallback once, here, where it can be tested, is the
 * only way it stays written correctly on every surface that draws it.
 *
 * THE SAME RULE RUNS THROUGH THE SWEEP LINE. "Pulled for everyone 3h ago" is a
 * claim about EVERY row on the list, and it is only true when every row has
 * been pulled — so `everyonePulled: false` gets a different sentence rather
 * than the same one with a softer stamp.
 *
 * PURE, AND `at` IS A PARAMETER. Nothing here reads the clock on its own, so
 * every one of these sentences can be checked exactly rather than approximately
 * at whatever second the test happened to run.
 */
import { count } from "./format.ts";

/** The five figures a delta can be about, as the server spells them. */
export type DeltaKey = "ghFollowers" | "ghRepos" | "bskyFollowers" | "bskyPosts" | "hnKarma";

export type Deltas = Partial<Record<DeltaKey, number>>;

/**
 * A SEVEN-DAY MOVEMENT AS A LABEL, or null for "there is nothing to say".
 *
 * NULL RATHER THAN A DASH OR A ZERO, and the caller is expected to draw
 * nothing at all. A dash beside a follower count reads as a measurement that
 * came back empty; what is actually true is that this person has not been
 * watched for a week yet, which is a fact about the list and not about them.
 * The absence of the label IS the honest rendering.
 *
 * ZERO IS DRAWN, and it is drawn as "0" rather than as "+0". A week with no
 * movement is a real answer and one of the more interesting ones on a
 * watchlist; hiding it would make "quiet" and "unknown" look identical, which
 * is the exact confusion the whole partial-object shape exists to prevent.
 *
 * SEPARATORS COME FROM `count`, so "+4,120" here matches "4,120" on the tile
 * above it rather than arriving as "+4120" from a second convention.
 */
export function deltaLabel(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n === 0) return "0";
  /* `count` carries its own minus sign; only the plus has to be added. */
  return n > 0 ? `+${count(n)}` : count(n);
}

/**
 * WHICH WAY IT MOVED, for whatever a surface colours or points with.
 *
 * FOUR ANSWERS AND NOT THREE. "flat" is a measured zero; null is no reading —
 * and a component that treated them alike would paint a neutral chip on a
 * person nothing is known about, next to an identical chip on a person who
 * genuinely stood still.
 *
 * THIS DELIBERATELY DOES NOT SAY GOOD OR BAD. Losing four thousand followers
 * is the more interesting direction on a watchlist, not the worse one — this
 * page is about noticing, not about scoring people — so the answer is a
 * direction and the choice of colour stays where the design is.
 */
export function deltaTone(n: number | null | undefined): "up" | "down" | "flat" | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}

/**
 * HOW LONG UNTIL A STAMP, IN THE SAME REGISTER `ago` USES FOR THE PAST.
 *
 * ROUNDED, NEVER FLOORED, and never below "1m": a due time forty seconds away
 * shown as "0m" reads as a stuck timer. A stamp already past answers null —
 * the caller has a different sentence for that case and should be made to
 * choose it rather than being handed "in -4h".
 */
function until(iso: string | null, at: number): string | null {
  if (!iso) return null;
  const when = Date.parse(iso);
  if (!Number.isFinite(when) || when <= at) return null;
  const mins = Math.round((when - at) / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** How long ago a stamp was, in the same register. Kept private and beside
 *  `until` so the two halves of one sentence cannot drift apart. */
function since(iso: string | null, at: number): string | null {
  if (!iso) return null;
  const when = Date.parse(iso);
  if (!Number.isFinite(when)) return null;
  const mins = Math.round((at - when) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * THE ONE LINE UNDER THE WATCHLIST: "Pulled for everyone 3h ago · next in 17h".
 *
 * IT REFUSES TO SAY "for everyone" UNLESS IT IS TRUE. With one person on the
 * list never pulled there is no moment at which the list was complete, and the
 * honest line says so and names nothing — quoting the oldest of the rest would
 * be a stamp about a smaller list than the one on screen.
 *
 * "due now" RATHER THAN A NEGATIVE COUNTDOWN, because that is what a null
 * `nextDueAt` means: somebody is already past their twenty hours and the next
 * hourly check will take them. It is the ordinary state of a box that has just
 * booted, not an error.
 */
export function sweepLine(
  sweep: { lastAt: string | null; nextDueAt: string | null; everyonePulled: boolean } | null | undefined,
  at: number = Date.now(),
): string {
  if (!sweep) return "";
  const next = until(sweep.nextDueAt, at);
  if (!sweep.everyonePulled || !sweep.lastAt)
    return next ? `Not everyone has been pulled yet · next in ${next}` : "Not everyone has been pulled yet";
  const last = since(sweep.lastAt, at);
  if (!last) return next ? `Next pull in ${next}` : "A pull is due now";
  return next ? `Pulled for everyone ${last} · next in ${next}` : `Pulled for everyone ${last} · due now`;
}
