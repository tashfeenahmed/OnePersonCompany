type Board = { id: string; slug: string; ventureId?: string | null };
type Venture = { id: string; slug: string };

/** Pins resolve the current board by ID, so names and locations can change. */
export function dashboardDestination(board: Board, ventures: Venture[]): string | null {
  if (!board.ventureId) return `/dashboards/${encodeURIComponent(board.slug)}`;
  const venture = ventures.find(v => v.id === board.ventureId);
  return venture ? `/ventures/${encodeURIComponent(venture.slug)}/dashboards/${encodeURIComponent(board.slug)}` : null;
}
