/**
 * The four ways a number gets written on an integration panel, in one place so
 * ten panels cannot each round differently.
 *
 * NOTHING HERE INVENTS A VALUE. Every function takes `null` and returns the em
 * dash for it, because null on these documents means the server was asked and
 * could not tell — a bounce rate over no visits, a load average from a box
 * that did not answer, a follower change from a single reading. Turning one
 * into "0" here would put a measurement on the page that nobody made, which is
 * the one thing this whole codebase is arranged around not doing.
 *
 * A separate file from the components beside it so that importing `ago` into a
 * panel does not cost the panel its fast refresh.
 */

/** "4m ago". A collected-at stamp is only useful as an age. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** A count, grouped. The dash is not a zero. */
export function num(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-IE");
}

/** A percentage the server already computed. One decimal, because that is the
 *  precision these documents carry. */
export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${Math.round(n * 10) / 10}%`;
}

/** Bytes as the unit a person would say. Powers of 1024, because every source
 *  of these figures — free(1), df(1) — counts that way. */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Seconds as a duration. Used for average visit and box uptime. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

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
