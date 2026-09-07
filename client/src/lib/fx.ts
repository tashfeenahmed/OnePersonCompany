import type { Rate, ReferenceRates } from "@/lib/api/finance";

/**
 * ONE UNIT OF `from` IN `to`, and where the number came from.
 *
 * The ledger adds nothing across currencies, and the cards keep to that: a
 * converted figure is drawn with a "≈" and the rate named beside it, never as
 * a bare total. This is the one place the arithmetic lives, so the donut and
 * the monthly tile cannot disagree about what a euro was worth.
 *
 * A rate the owner typed on the Finance page is the last word for its pair.
 * Otherwise the ECB's cross rate through the euro — the same reference every
 * desk quotes for a pair the bank does not publish — dated by the file it came
 * from. Null when neither can answer, and the caller then draws the figure in
 * its own currency with no share rather than guessing.
 */
export function rateBetween(
  from: string,
  to: string,
  typed: Rate[],
  reference: ReferenceRates | null,
): { rate: number; source: "typed" | "ecb"; asOf: string | null } | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return { rate: 1, source: "typed", asOf: null };
  const own = typed.find((r) => r.from.toUpperCase() === f && r.to.toUpperCase() === t);
  if (own) return { rate: own.rate, source: "typed", asOf: own.asOf };
  if (!reference) return null;
  const perEuro = (c: string) => (c === reference.base.toUpperCase() ? 1 : (reference.rates[c] ?? null));
  const a = perEuro(f);
  const b = perEuro(t);
  if (a === null || b === null) return null;
  return { rate: b / a, source: "ecb", asOf: reference.asOf };
}
