/**
 * THE TWO RENDERINGS THAT ARE ONLY EVER ASKED FOR ON A PANEL.
 *
 * The age, the count, the percentage, the bytes and the duration all live in
 * `@/lib/format` and are re-exported below, so a panel imports its formatters
 * from one place. Two traps ride along with them:
 *
 *   - `count` groups in en-GB. One locale is one locale.
 *   - `pct` TAKES A 0–1 FRACTION, and its signature is `(number) => string`
 *     like every other formatter's, so nothing catches a percent the server
 *     already scaled being passed straight in — the page says 0.4% instead of
 *     40% and no tool complains. A panel holding a scaled percent divides at
 *     the call site, where a reviewer can see it happen.
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
