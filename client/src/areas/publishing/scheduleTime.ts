/**
 * Is this `datetime-local` value in the past?
 *
 * A schedule whose instant has already gone is not a schedule: the publishing
 * scheduler takes anything whose time has passed on its very next tick, so
 * pressing "Schedule" with a stale picker value posts to a live audience
 * immediately. The server refuses the instant at its door; this keeps the
 * button from offering it in the first place.
 *
 * `datetime-local` inputs carry no timezone, and `new Date("YYYY-MM-DDTHH:mm")`
 * reads one as local time — which is exactly the reading the schedule call
 * sends (it posts `new Date(at).toISOString()`), so both doors agree.
 */
export function pastTime(localValue: string, nowMs = Date.now()): boolean {
  if (!localValue) return false; // empty means "not filled in", handled by !at
  const when = new Date(localValue).getTime();
  return Number.isNaN(when) || when <= nowMs;
}
