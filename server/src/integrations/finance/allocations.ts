/**
 * HOW A SHARED COST REACHES A BUSINESS.
 *
 * Seven Hetzner boxes cost €63 a month and not one of them belongs to a
 * venture: the control plane serves everything, the testing box serves
 * whatever is being tested this week. Until somebody says how they are split,
 * every venture's margin is overstated by its share of them — which is the
 * single most common way a portfolio of small businesses looks profitable and
 * is not.
 *
 * THE SHARE IS STORED, THE BASIS IS A LABEL. `basis` says how the number was
 * arrived at — equally, by hand, in proportion to revenue, in proportion to
 * traffic — and it is NOT a rule that gets re-evaluated on every read. That is
 * deliberate: a margin computed in March from March's revenue split must stay
 * computed that way in June, or last quarter's P&L changes every time a
 * customer signs up. Recomputing is an ACTION the owner takes, dated by
 * `updated_at`, and it rewrites the shares from that day forward.
 *
 * SHARES MAY SUM TO LESS THAN ONE, and that is a real answer rather than a
 * missing one: the remainder is unallocated overhead. It is reported on every
 * document that shows an allocation, because a portfolio whose costs are 40%
 * unallocated has a different story than one whose costs are all assigned.
 * Shares summing to MORE than one are refused — that is double counting, and
 * it makes the portfolio's margin better than the portfolio's.
 */
import { db, now, ventureRowById } from "../../db.ts";
import { BASES, money, type Basis } from "./money.ts";
import { ventureRevenue, ventureTraffic, ventures } from "./attribution.ts";
import { configValue, type VentureRow } from "../../db.ts";
import { PLUGIN } from "./expenses.ts";

export type AllocationRow = {
  expense_id: string;
  venture_id: string;
  share: number;
  basis: string;
  note: string | null;
  updated_at: string;
};

export const validBasis = (v: string): v is Basis => (BASES as string[]).includes(v);

export function allocationsOf(expenseId: string): AllocationRow[] {
  return db
    .prepare("SELECT * FROM finance_allocations WHERE expense_id = ? ORDER BY venture_id")
    .all(expenseId) as unknown as AllocationRow[];
}

export function allAllocations(): AllocationRow[] {
  return db
    .prepare("SELECT * FROM finance_allocations ORDER BY expense_id, venture_id")
    .all() as unknown as AllocationRow[];
}

export const shapeAllocation = (r: AllocationRow) => ({
  ventureId: r.venture_id,
  venture: ventureRowById(r.venture_id)?.name ?? null,
  share: Number(r.share.toFixed(6)),
  basis: r.basis as Basis,
  note: r.note,
  updatedAt: r.updated_at,
});

/**
 * Replace an expense's whole split in one statement.
 *
 * WHOLE AND NOT PIECEMEAL, because a split is only meaningful as a set: adding
 * one venture's 30% to an existing 100% is a state nobody meant to be in, and
 * a route that allowed it would let the sum drift above one a request at a
 * time. Returns an error string rather than throwing, so the route can answer
 * with it.
 */
export function setAllocations(
  expenseId: string,
  shares: { ventureId: string; share: number; note?: string | null }[],
  basis: Basis,
): string | null {
  let sum = 0;
  for (const s of shares) {
    if (!ventureRowById(s.ventureId)) return `There is no venture with the id “${s.ventureId}”.`;
    if (!Number.isFinite(s.share) || s.share < 0 || s.share > 1)
      return `A share is a fraction between 0 and 1; “${s.share}” is not one.`;
    sum += s.share;
  }
  /* A hair over one is floating point, not double counting: three equal thirds
     sum to 1.0000000000000002. Anything past a tenth of a percent is a real
     mistake and is refused with the sum quoted. */
  if (sum > 1.001)
    return `Those shares add up to ${(sum * 100).toFixed(1)}%. A cost cannot be allocated more than once; reduce them to 100% or less.`;

  const ts = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM finance_allocations WHERE expense_id = ?").run(expenseId);
    const ins = db.prepare(
      "INSERT INTO finance_allocations (expense_id, venture_id, share, basis, note, updated_at) VALUES (?,?,?,?,?,?)",
    );
    for (const s of shares) {
      if (s.share === 0) continue;
      ins.run(expenseId, s.ventureId, s.share, basis, s.note ?? null, ts);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return null;
}

/* -------------------------------------------------------- computed bases */

export type ComputedSplit = {
  shares: { ventureId: string; share: number; note: string }[];
  /** Ventures the basis could not weigh, and why. They get NO share rather
   *  than a zero one — see the note on `ventureTraffic`. */
  skipped: { ventureId: string; why: string }[];
  basis: Basis;
  explanation: string;
};

/**
 * Equal shares across every venture that exists.
 *
 * The simplest honest split and the one worth defaulting to: it says "nobody
 * has measured this, so it is spread evenly", which is visibly a convention
 * rather than a measurement. Ventures at the `idea` stage are INCLUDED, because
 * an idea with no revenue still runs on the same control plane — excluding
 * them would move their cost onto the businesses that earn.
 */
export function equalSplit(): ComputedSplit {
  const list = ventures();
  const share = list.length ? 1 / list.length : 0;
  return {
    shares: list.map((v) => ({
      ventureId: v.id,
      share,
      note: `One of ${list.length} ventures.`,
    })),
    skipped: [],
    basis: "equal",
    explanation: `Split evenly across all ${list.length} ventures. A convention, not a measurement.`,
  };
}

/**
 * In proportion to measured net revenue in one month.
 *
 * A VENTURE WITH NO MEASURED REVENUE IS SKIPPED, not given a zero. Zero share
 * would mean "this business consumes none of the shared infrastructure", which
 * is exactly wrong for a pre-launch venture sitting on the same box. The skip
 * is reported so the owner can see that the split covers five of nineteen.
 *
 * ONE CURRENCY AT A TIME IS IMPOSSIBLE HERE, so the weight is the venture's
 * net revenue in its LARGEST currency, and the explanation says so. Weighing
 * across currencies would need a rate; picking the largest is a defensible
 * proxy for size and is labelled rather than hidden.
 */
export function revenueSplit(month: string): ComputedSplit {
  const weights: { venture: VentureRow; weight: number; currency: string }[] = [];
  const skipped: { ventureId: string; why: string }[] = [];
  for (const v of ventures()) {
    const rev = ventureRevenue(v, month);
    const amounts = Object.entries(rev.net.byCurrency).sort((a, b) => b[1] - a[1]);
    const best = amounts[0];
    if (!best || best[1] <= 0) {
      skipped.push({ ventureId: v.id, why: `No measured net revenue in ${month}.` });
      continue;
    }
    weights.push({ venture: v, weight: best[1], currency: best[0] });
  }
  const total = weights.reduce((n, w) => n + w.weight, 0);
  if (total <= 0)
    return {
      shares: [],
      skipped,
      basis: "revenue",
      explanation: `No venture had measured net revenue in ${month}, so there is nothing to weigh. Nothing was written.`,
    };
  return {
    shares: weights.map((w) => ({
      ventureId: w.venture.id,
      share: w.weight / total,
      note: `${money(w.weight)} ${w.currency} of measured net revenue in ${month}.`,
    })),
    skipped,
    basis: "revenue",
    explanation:
      `Weighted by each venture's measured net revenue in ${month}, taken in its largest currency — currencies are ` +
      `not converted, so a venture earning in two is weighed by the bigger one. ${skipped.length} venture(s) had no ` +
      `measured revenue that month and were left out of the split entirely rather than given a nought share.`,
  };
}

/** In proportion to Cloudflare edge requests over the month, for ventures with
 *  a linked zone. Same skip rule as revenue, same reason. */
export function trafficSplit(month: string): ComputedSplit {
  const weights: { venture: VentureRow; weight: number }[] = [];
  const skipped: { ventureId: string; why: string }[] = [];
  for (const v of ventures()) {
    const n = ventureTraffic(v.id, month);
    if (n === null) {
      skipped.push({ ventureId: v.id, why: "No Cloudflare zone is linked to this venture." });
      continue;
    }
    if (n <= 0) {
      skipped.push({ ventureId: v.id, why: `Its zones served no requests in ${month}.` });
      continue;
    }
    weights.push({ venture: v, weight: n });
  }
  const total = weights.reduce((n, w) => n + w.weight, 0);
  if (total <= 0)
    return { shares: [], skipped, basis: "traffic", explanation: `No linked zone served a request in ${month}. Nothing was written.` };
  return {
    shares: weights.map((w) => ({
      ventureId: w.venture.id,
      share: w.weight / total,
      note: `${w.weight.toLocaleString("en-GB")} Cloudflare requests in ${month}.`,
    })),
    skipped,
    basis: "traffic",
    explanation:
      `Weighted by Cloudflare edge requests over ${month} on each venture's linked zones. Edge requests are not ` +
      `people and this is not a traffic figure — it is a size proxy for splitting a bill. ${skipped.length} ` +
      `venture(s) had no linked zone or no requests and were left out of the split.`,
  };
}

export function computeSplit(basis: Basis, month: string): ComputedSplit {
  if (basis === "revenue") return revenueSplit(month);
  if (basis === "traffic") return trafficSplit(month);
  return equalSplit();
}

/* ------------------------------------------------------------ the default */

export type DefaultRule = "none" | "equal";

/**
 * What happens to a shared expense NOBODY has allocated.
 *
 * `none` is the default and it is the conservative one: the cost stays
 * unallocated overhead, every venture's margin is honest about not carrying
 * it, and the portfolio document says how much is sitting there. `equal`
 * spreads it across every venture at read time WITHOUT writing rows, so it is
 * visibly a fallback: the allocation editor still shows the expense as
 * unallocated, and the P&L labels those lines `fallback: "equal"`.
 */
export function defaultRule(): DefaultRule {
  return (configValue(PLUGIN, "default_allocation") ?? "").trim().toLowerCase() === "equal" ? "equal" : "none";
}

/**
 * The share of ONE expense that lands on ONE venture, and where it came from.
 *
 * The single function the P&L uses, so venture margins and the portfolio
 * document cannot disagree about a split.
 */
export function shareFor(
  ventureId: string,
  rows: AllocationRow[],
  rule: DefaultRule,
  ventureCount: number,
): { share: number; basis: Basis | "fallback-equal" } {
  const mine = rows.find((r) => r.venture_id === ventureId);
  if (mine) return { share: mine.share, basis: mine.basis as Basis };
  if (rows.length) return { share: 0, basis: "manual" };
  if (rule === "equal" && ventureCount > 0) return { share: 1 / ventureCount, basis: "fallback-equal" };
  return { share: 0, basis: "fallback-equal" };
}
