/**
 * THE FOUR THINGS THIS AREA CANNOT DERIVE AND WILL NOT GUESS.
 *
 * Every other figure in this area is read from Umami or Meta. These four are
 * decisions about the owner's own business that no API can answer, so they are
 * settings on the area's own plugin id rather than constants in a file:
 *
 *   sitesPerPass  how much of somebody else's analytics server one pass may
 *                 ask about. A cost decision, not a measurement.
 *   conversions   WHICH events count as a conversion for a venture. There is
 *                 nothing in Umami that says `signup-completed` matters and
 *                 `signup-viewed` does not; the owner knows and the box does
 *                 not.
 *   revenue       which event property carries money, per venture, for the
 *                 blended efficiency line.
 *   units         what a numeric event property is IN. A property called
 *                 `revenue` might be cents, dollars or credits, and a document
 *                 that prints a sum without a unit has printed a number
 *                 wearing a costume.
 *
 * THE PLUGIN ID IS THIS AREA'S OWN. Settings registries merge across areas by
 * plugin id, so two areas writing config for `umami` would clobber each other.
 * These live under `webanalytics`, which nothing else uses.
 */
import { configValue } from "../../db.ts";

export const PLUGIN = "webanalytics";

/** How many websites one collection pass reads in full. Four, because a full
 *  read of one site is about fifty requests against somebody's own analytics
 *  server and the connected instance carries eighteen sites — four a tick on a
 *  half-hourly scheduler cycles the whole instance in a bit over two hours. */
export const DEFAULT_SITES_PER_PASS = 4;

/** How long before a site is due again. Twelve hours: these are day-grained
 *  distributions and reading them twice a day is already generous. */
export const SITE_EVERY_HOURS = 12;

/** And for the ad side, which is five requests per ad account and can afford
 *  to be current. */
export const ADS_EVERY_HOURS = 6;

/* --------------------------------------------------------------- parsing */

/**
 * `slug = a, b, c` per line, comments and blanks dropped.
 *
 * TWO LINES FOR THE SAME SLUG MERGE, deliberately — a list typed over several
 * lines is the natural way to write a long one — which is why the checks below
 * count LINES THAT PARSED rather than comparing the map's size with the line
 * count. That comparison rejected valid input: two lines for one venture came
 * back as "1 line did not carry a slug".
 */
export function parseVentureLists(raw: string | null | undefined): Map<string, string[]> {
  return parseVentureListsCounted(raw).parsed;
}

/** The same parse, plus how many non-blank lines it could not read. The checks
 *  need the second number and nothing else does. */
export function parseVentureListsCounted(raw: string | null | undefined): {
  parsed: Map<string, string[]>;
  lines: number;
  unread: number;
} {
  const out = new Map<string, string[]>();
  let lines = 0;
  let unread = 0;
  for (const line of String(raw ?? "").split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    lines++;
    const at = text.indexOf("=");
    const slug = at < 1 ? "" : text.slice(0, at).trim().toLowerCase();
    const values =
      at < 1
        ? []
        : text
            .slice(at + 1)
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
    if (!slug || !values.length) {
      unread++;
      continue;
    }
    out.set(slug, [...(out.get(slug) ?? []), ...values]);
  }
  return { parsed: out, lines, unread };
}

export type RevenueSource = { event: string; property: string };

/** `slug = event.property` per line. The LAST dot separates them, so an event
 *  called `checkout.completed` with a property `revenue` still parses. */
export function parseRevenue(raw: string | null | undefined): Map<string, RevenueSource> {
  const out = new Map<string, RevenueSource>();
  for (const [slug, values] of parseVentureLists(raw)) {
    const value = values[0];
    if (!value) continue;
    const dot = value.lastIndexOf(".");
    if (dot < 1 || dot === value.length - 1) continue;
    out.set(slug, { event: value.slice(0, dot), property: value.slice(dot + 1) });
  }
  return out;
}

/** `event.property = unit` per line. Same last-dot rule on the left. */
export function parseUnits(raw: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of String(raw ?? "").split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const at = text.indexOf("=");
    if (at < 1) continue;
    const left = text.slice(0, at).trim();
    const unit = text.slice(at + 1).trim();
    if (!left.includes(".") || !unit) continue;
    out.set(left.toLowerCase(), unit.slice(0, 40));
  }
  return out;
}

/* ------------------------------------------------------------- live reads */

export const sitesPerPass = (): number => {
  const raw = Number(configValue(PLUGIN, "sitesPerPass") ?? "");
  return Number.isInteger(raw) && raw >= 1 && raw <= 50 ? raw : DEFAULT_SITES_PER_PASS;
};

export const conversionEvents = (): Map<string, string[]> =>
  parseVentureLists(configValue(PLUGIN, "conversions"));

export const revenueSources = (): Map<string, RevenueSource> =>
  parseRevenue(configValue(PLUGIN, "revenue"));

export const propertyUnits = (): Map<string, string> => parseUnits(configValue(PLUGIN, "units"));

/** The unit for one event property, or null. NULL IS PUBLISHED AS "the unit
 *  was never stated" and never as a default currency. */
export const unitFor = (event: string, property: string): string | null =>
  propertyUnits().get(`${event}.${property}`.toLowerCase()) ?? null;

/* ---------------------------------------------------------------- checks */

export function checkSitesPerPass(value: string): string | null {
  if (!value.trim()) return null;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < 1 || n > 50)
    return "A whole number of websites per pass, 1 to 50. Each one is about fifty requests to your analytics server.";
  return null;
}

/**
 * The three checks count LINES THAT DID NOT PARSE, never `map.size` against the
 * line count.
 *
 * The size comparison was wrong in the one case the parser goes out of its way
 * to support: two lines naming the same venture merge into one key, so a
 * perfectly good pair of lines was reported as "1 line did not carry a slug"
 * and refused at save.
 */
export function checkVentureLists(value: string): string | null {
  const { lines, unread } = parseVentureListsCounted(value);
  if (!lines) return null;
  if (unread === lines) return "Each line is `venture-slug = event-name, event-name`.";
  if (unread)
    return `${unread} line(s) did not carry a slug and at least one event name.`;
  return null;
}

export function checkRevenue(value: string): string | null {
  const { parsed, lines, unread } = parseVentureListsCounted(value);
  if (!lines) return null;
  if (unread)
    return `${unread} line(s) are not \`venture-slug = event-name.property-name\`.`;
  /* A line can parse as a list and still not name a property. */
  const bad = [...parsed].filter(([, values]) => {
    const v = values[0] ?? "";
    const dot = v.lastIndexOf(".");
    return dot < 1 || dot === v.length - 1;
  });
  if (bad.length)
    return `${bad.map(([slug]) => slug).join(", ")}: expected \`event-name.property-name\`, where the property is a NUMERIC event property Umami reports.`;
  return null;
}

export function checkUnits(value: string): string | null {
  const lines = value.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const parsed = parseUnits(value);
  /* `parseUnits` keys on `event.property`, which is unique per line by
     construction, so a size comparison IS a count of unread lines here — but
     it is spelled out rather than inferred. */
  const unread = lines.length - parsed.size;
  if (unread > 0)
    return `${unread} line(s) are not \`event-name.property-name = unit\`, for example \`payment-completed.revenue = USD\`.`;
  return null;
}
