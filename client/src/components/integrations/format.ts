/**
 * THE TWO RENDERINGS THAT ARE ONLY EVER ASKED FOR ON A PANEL.
 *
 * Everything else this file used to hold — the age, the count, the percentage,
 * the bytes, the duration — is in `@/lib/format` now, with the six to nine
 * other copies each of them had grown elsewhere. They are re-exported below so
 * a panel can keep importing its formatters from one place, and the re-exports
 * carry the two corrections that came with the merge:
 *
 *   - the old `num` is `count`, which groups in en-GB rather than en-IE. The
 *     two agree on every figure a panel draws, and one locale is one locale.
 *   - `pct` NOW TAKES A 0–1 FRACTION. This copy took an already-scaled percent
 *     and two other exported `pct`s took a fraction, all three with the
 *     signature `(number) => string`, so an editor's auto-import silently
 *     decided whether a page said 0.4% or 40%. A panel holding a percent the
 *     server already scaled divides at the call site, where a reviewer can see
 *     it happen.
 *
 * `clock` and `dayLabel` stay because nothing else asks for them: they are the
 * calendar's two shapes, and a calendar is the only surface that wants a bare
 * time of day with no date attached to it.
 */

export {
  ago,
  bytes,
  count,
  /** Seconds, not milliseconds — average visit length and box uptime. */
  durationS as duration,
  pct,
  when,
} from "@/lib/format";

/** A clock time out of one of Google's RFC3339 strings, in the offset the
 *  event was created in — nothing here is normalised to UTC. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "Fri 12 Sep" out of a YYYY-MM-DD day. */
export function dayLabel(day: string): string {
  const at = Date.parse(`${day}T12:00:00`);
  if (Number.isNaN(at)) return day;
  return new Date(at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
