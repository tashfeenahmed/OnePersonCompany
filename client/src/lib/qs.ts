/**
 * THE QUERY STRING A LIST ROUTE IS CALLED WITH.
 *
 * Seven copies of this had been written across the api modules, in two
 * behaviours. Four of them filtered `undefined` and the empty string but NOT
 * `null` — and the client's own idiom for "no venture selected" is `?? null`,
 * so those four sent the literal five characters `?venture=null` to a route
 * that then filtered a list by a venture named "null" and answered with
 * nothing. An empty page, no error, nothing in the console.
 *
 * NULL AND UNDEFINED AND "" ARE ALL "DO NOT SEND THIS PARAMETER". There is no
 * value a caller can pass that means "send the word null", because no route
 * here wants one.
 *
 * `false` IS SENT. It is a real answer to a real flag — `?bots=false` asks the
 * server for something different from omitting `bots` — and a filter that
 * dropped it would silently turn every "off" into "whatever the default is".
 *
 * ENCODING IS URLSearchParams', so a space is `+` rather than `%20`. Five of
 * the seven copies were already URLSearchParams and two hand-rolled
 * `encodeURIComponent`; both forms decode identically on the server, and one
 * implementation that handles `&`, `#` and `=` correctly beats two that each
 * have to remember to.
 */

/** What a route parameter can be before it is written down. */
export type QueryValue = string | number | boolean | null | undefined;

/**
 * `{ venture: "acme", days: 30, kind: null }` → `"?venture=acme&days=30"`.
 *
 * Returns the EMPTY STRING when nothing survives the filter, so callers can
 * write `` call(`/people${qs(params)}`) `` without a trailing `?` on the bare
 * path.
 */
export function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * ONE PATH SEGMENT, ENCODED.
 *
 * Not the same job as `qs` and not interchangeable with it: a segment is
 * positional, so a `/` inside one silently becomes a route boundary rather
 * than an argument. The values that reach these are real: an entity is a Bing
 * site like `https://example.com/`, a person is an email address, a paper id
 * carries a colon. A venture key is an id or a slug and would survive
 * untouched, but it goes through here anyway — a rule with an exception in it
 * is a rule somebody applies inconsistently.
 */
export const seg = (value: string): string => encodeURIComponent(value);
