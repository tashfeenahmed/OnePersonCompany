/**
 * THE ONE WINDOW EVERY DASHBOARD PAGE IS DRAWN OVER.
 *
 * Before this file every route was fetched at its own default — Stripe over
 * thirty days, Cloudflare over seven, Search Console over ninety — and each
 * card baked its span into its name ("Net revenue · 30d"). A board could not
 * be read across: the revenue tile and the traffic tile beside it were about
 * different fortnights, and nothing on the page said so.
 *
 * The selection lives in the store (`dashboardWindow`), not in the URL: it is
 * a preference about how the owner reads EVERY board, not a fact about one
 * address, and it follows the workspace to every browser. What this file
 * holds is the vocabulary the store, the fetch layer, the builders and the
 * cards all share, so a label written here is the label everywhere.
 *
 * "ALL" IS NOT A NUMBER AND IS NEVER TURNED INTO A FAKE ONE. Every route
 * clamps `days`; `daysFor` asks each for the most it will answer, and the
 * document that comes back says how much history actually landed. The card
 * then reports that ("30 complete days — everything Cloudflare has been
 * collected for") rather than captioning a month "all time".
 */

/** A span in days, or the whole record. */
export type WindowValue = number | "all";

/** The four the picker offers. A week, a month, a quarter — the spans every
 *  collector on this box actually stores — and everything. */
export const DASHBOARD_WINDOWS: readonly WindowValue[] = [7, 30, 90, "all"];

/** What a store that has never had one chosen reads as. A month, because it
 *  is what most of the routes defaulted to before there was a picker. */
export const DEFAULT_WINDOW: WindowValue = 30;

/** Whether a stored value is one this picker can draw. An older cache, or a
 *  hand-edited export, may carry anything. */
export function isWindowValue(v: unknown): v is WindowValue {
  return v === "all" || (typeof v === "number" && Number.isInteger(v) && v > 0);
}

/** "7d", "30d", "90d", "all time" — the suffix a card name carries. */
export function windowLabel(w: WindowValue): string {
  return w === "all" ? "all time" : `${w}d`;
}

/** "last 7 days", "all time" — the phrase a sentence carries. */
export function windowWords(w: WindowValue): string {
  return w === "all" ? "all time" : `last ${w} days`;
}

/**
 * The `days` a route is asked for. A number passes through; "all" becomes
 * the most the route will answer, which is the caller's to know — every
 * route clamps differently and the clamp is the route's own statement of
 * how far back it can look.
 */
export function daysFor(w: WindowValue, max: number): number {
  return w === "all" ? max : Math.min(w, max);
}

/**
 * The window a widget is drawn over, or null for a card that has none.
 *
 * `"selected"` — the picker's window, which the fetch layer asked the route
 * for. The catalog name carries no span and the card appends one.
 * `"now"` — a level: a balance, MRR, the subscription book, the DNS state.
 * The picker does not move it and the card says "now" so nobody reads a
 * balance as a month's takings.
 * Absent — the name is complete as written. Either it has no window at all
 * ("Zones", "Every handle") or its span is the source's own and cannot move:
 * GitHub publishes fourteen days of traffic, Meta's `last_30d` is Meta's.
 * Those names keep their literal suffix and their builders say why.
 */
export type WidgetWindow = "selected" | "now";

/** A card's name with its window on it. */
export function widgetName(
  def: { name: string; window?: WidgetWindow },
  w: WindowValue,
): string {
  if (def.window === "selected") return `${def.name} · ${windowLabel(w)}`;
  if (def.window === "now") return `${def.name} · now`;
  return def.name;
}

/**
 * What a route ACTUALLY answered against what the picker asked, for a card's
 * small print. Empty when they agree, so `also()` drops it.
 *
 * `got` is the days the document covers — a route's own `window.days` where
 * it clamped, or the complete days that landed where the source holds less
 * than the clamp. `keeper` names who holds the record ("Cloudflare", "this
 * box"). "All time" over thirty days of Cloudflare rollups is thirty days
 * and the card must say so; "90d" over a source that stops at sixty is sixty.
 */
export function windowNote(asked: WindowValue, got: number, keeper: string): string {
  if (asked === "all") return `${got} days is everything ${keeper} holds`;
  if (got < asked) return `${keeper} holds ${got} days, not ${asked}`;
  return "";
}

/**
 * Whether a change "against the previous window" can be drawn. Over all
 * time there is no previous window, so the answer is a dash — never a zero,
 * which would read as "nothing moved".
 */
export function hasPrevious(w: WindowValue): boolean {
  return w !== "all";
}
