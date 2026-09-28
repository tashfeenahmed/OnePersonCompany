type Board = { columns: { id: number; cards: { id: number }[] }[] };

/**
 * The cards a drag carries. Grabbing a selected card carries the whole
 * selection, in board order (left column first, top card first) so the block
 * lands the way it read; grabbing anything else carries just that card.
 * Selected ids no longer on the board (archived or deleted since) drop out.
 */
export function carriedCards(board: Board, selected: ReadonlySet<number>, grabbed: number): number[] {
  if (!selected.has(grabbed)) return [grabbed];
  return board.columns.flatMap((c) => c.cards.map((card) => card.id)).filter((id) => selected.has(id));
}

/**
 * The card a group lands above. A drop "above" one of the carried cards means
 * above the first card after it that is not being carried — or the foot of
 * the column when there is none. The server refuses an anchor inside the group.
 */
export function groupAnchor(board: Board, columnId: number, before: number | null, carried: readonly number[]): number | null {
  if (before === null || !carried.includes(before)) return before;
  const cards = board.columns.find((c) => c.id === columnId)?.cards ?? [];
  const from = cards.findIndex((c) => c.id === before);
  for (let i = from + 1; i < cards.length; i++) if (!carried.includes(cards[i]!.id)) return cards[i]!.id;
  return null;
}
