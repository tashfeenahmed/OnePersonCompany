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
