/**
 * WHERE A DRAGGED CARD LANDS, from where the pointer is.
 *
 * A dashboard is a flow grid: cards in order, each with a width, wrapped into
 * rows by the browser. "Drop it anywhere" therefore means "insert it at the
 * position under the pointer, wherever on the canvas that is" — between two
 * cards, at the start or end of a row, in the empty space below the last row.
 * The old HTML5 drag could only land ON another card, so a drop into the empty
 * half of the canvas did nothing, and a drop over the add-widget tile did
 * nothing, and both felt like the page ignoring the owner.
 *
 * Pure geometry, no DOM: the rectangles of the cards that are NOT being
 * dragged, in their list order, and a point. The answer is an insertion index
 * into that same list — so a caller reinserts the dragged card there — and,
 * for the indicator, which card to mark and on which side.
 *
 *   rows      cards grouped by their top edge (a wrapped row shares one)
 *   the row   the one whose vertical band holds the pointer; above the first
 *             row is the first, below the last is the last
 *   the slot  before the first card in that row whose centre is right of the
 *             pointer; after the row's last card otherwise
 */
export type Rect = { id: string; left: number; top: number; width: number; height: number };
export type Slot = { index: number; mark: { id: string; side: "before" | "after" } | null };

export function slotFor(rects: Rect[], x: number, y: number): Slot {
  if (!rects.length) return { index: 0, mark: null };

  /* Rows: consecutive cards whose tops are within a few pixels. The grid
     aligns a row's tops exactly; the tolerance is for sub-pixel layout. */
  const rows: Rect[][] = [];
  for (const r of rects) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.top - r.top) < 8) row.push(r);
    else rows.push([r]);
  }

  let row = rows.find((cards) => {
    const top = Math.min(...cards.map((c) => c.top));
    const bottom = Math.max(...cards.map((c) => c.top + c.height));
    return y >= top && y < bottom;
  });
  if (!row) {
    /* Between rows, above or below: the nearest row by vertical distance,
       which below the last row is the last — where "the end" lives. */
    let best = Infinity;
    for (const cards of rows) {
      const top = Math.min(...cards.map((c) => c.top));
      const bottom = Math.max(...cards.map((c) => c.top + c.height));
      const d = y < top ? top - y : y - bottom;
      if (d < best) {
        best = d;
        row = cards;
      }
    }
  }
  const cards = row!;
  const before = cards.find((c) => x < c.left + c.width / 2);
  if (before) return { index: rects.indexOf(before), mark: { id: before.id, side: "before" } };
  const last = cards[cards.length - 1]!;
  return { index: rects.indexOf(last) + 1, mark: { id: last.id, side: "after" } };
}

/** The list with `id` moved to `index` of the list-without-it. */
export function moveTo<T extends { id: string }>(list: T[], id: string, index: number): T[] {
  const rest = list.filter((w) => w.id !== id);
  const moved = list.find((w) => w.id === id);
  if (!moved) return list;
  const at = Math.max(0, Math.min(index, rest.length));
  rest.splice(at, 0, moved);
  return rest;
}
