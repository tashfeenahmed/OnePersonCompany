/** Workdash's Shorts control: one to five clips per source, one by default. */
export function shortsClipCount(value: unknown): number {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(5, Math.round(n))) : 1;
}
