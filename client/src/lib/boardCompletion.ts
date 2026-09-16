type Column = { id: number; key: string; title: string; cards: { id: number }[] };
type Board = { columns: Column[] };

/** Done keeps its meaning when renamed; custom completion lanes also count. */
export function isCompletionColumn(column: Column): boolean {
  const title = column.title.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "");
  return column.key === "done" || /^(done|complete|completed|finished|shipped|resolved|closed|delivered|published)$/i.test(title);
}

/** Compare the saved move with its starting board, never with an optimistic copy. */
export function completedBoardMove(before: Board, after: Board, cardId: number): boolean {
  const source = before.columns.find(column => column.cards.some(card => card.id === cardId));
  const target = after.columns.find(column => column.cards.some(card => card.id === cardId));
  return !!source && !!target && source.id !== target.id
    && !isCompletionColumn(source) && isCompletionColumn(target);
}
