/** Keep a completed reading on screen while a different range is collected.
 * The old range travels with its figures; failed new readings still replace it. */
export function readingPresentation<W, T extends { window: W; loading: boolean }>(current: T, settled: T | null, requested: W): T & { pendingWindow?: W } {
  if (current.window !== requested || (current.loading && settled && settled.window !== requested)) {
    return { ...(settled ?? current), loading: true, pendingWindow: requested };
  }
  return current;
}
