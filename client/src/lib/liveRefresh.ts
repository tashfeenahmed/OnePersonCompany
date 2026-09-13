/** Focus and polling share one clock; explicit refreshes can always begin. */
export class LiveRefreshGate<Key> {
  private key: Key | undefined;
  private startedAt = -Infinity;
  due(now: number) { return now - this.startedAt >= 60_000; }
  begin(key: Key, now: number) {
    const changedWindow = this.key !== key;
    this.key = key;
    this.startedAt = now;
    return changedWindow;
  }
}
/** null is a failed refresh; [] is a successful empty/disconnected response. */
export function mergeReadings<T>(previous: Record<string, T[]>, results: readonly (readonly [string, readonly T[] | null])[]): Record<string, T[]> {
  const next = {...previous};
  for (const [key, points] of results) {
    if (points === null) continue;
    if (points.length) next[key] = [...points];
    else delete next[key];
  }
  return next;
}
