/**
 * The three renderings this area must never get wrong, in one file so the four
 * panels cannot disagree about them.
 */
import type { Amounts } from "@/lib/api/finance";

/**
 * A price, or an em dash.
 *
 * NULL IS A DASH AND NEVER "0.00". Twenty-three domain renewals arrive with a
 * date and no price because no registrar API publishes one; drawing those as
 * zero would tell the owner their domains are free.
 */
export function amount(n: number | null | undefined, currency: string): string {
  if (n === null || n === undefined) return "—";
  return `${n.toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency.toUpperCase()}`;
}

/** A list of per-currency amounts, side by side and never added. The
 *  separator is a middle dot rather than a plus for exactly that reason. */
export function currencies(a: Amounts | { currency: string; amount: number }[] | undefined): string {
  const rows = Array.isArray(a) ? a : (a?.amounts ?? []);
  if (!rows.length) return "—";
  return rows.map((r) => amount(r.amount, r.currency)).join("  ·  ");
}

/** "in 41 days", "12 days ago", "today". A renewal date's whole value is the
 *  distance to it. */
export function inDays(n: number): string {
  if (n === 0) return "today";
  if (n < 0) return `${Math.abs(n)}d ago`;
  return `in ${n}d`;
}

export const pct = (share: number): string => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

/* ------------------------------------------------- edits that lose data */

/**
 * The percentage one venture's allocation field is SHOWING: the owner's draft
 * if they have typed one, otherwise the stored share, otherwise nothing.
 *
 * IT IS A FUNCTION RATHER THAN AN EXPRESSION IN THE FIELD because the SAVE has
 * to read the same answer. It did not: the field fell back to the stored share
 * and the save fell back to "0", so editing one venture's number in a 40/40/20
 * split and pressing Save sent 50/0/0 — and `PUT /allocations` replaces the
 * whole set, so the other two shares were gone and two ventures' margins
 * silently improved. One function, two callers, no drift.
 */
export function shownShare(
  draft: string | undefined,
  allocations: { ventureId: string; share: number }[],
  ventureId: string,
): string {
  if (draft !== undefined) return draft;
  const current = allocations.find((a) => a.ventureId === ventureId);
  return current ? String(Number((current.share * 100).toFixed(2))) : "";
}

/**
 * What the owner typed in a money cell, as the API should receive it.
 *
 * AN EMPTY FIELD IS "I DO NOT KNOW" AND A TYPO IS NEITHER. `Number("12o")` is
 * NaN, `JSON.stringify` sends NaN as null, and the route reads null as an
 * unpriced row — which then adds `amount` to `owner_fields`, so no provider
 * refresh would ever restore the real figure. A mistyped price used to erase a
 * price AND lock the row against the only thing that could fix it.
 */
export function parseAmount(text: string): { amount: number | null } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { amount: null };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0)
    return { error: `“${trimmed}” is not an amount. Type a number, or clear the field if you do not know the price.` };
  return { amount: n };
}
