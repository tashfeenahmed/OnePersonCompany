/**
 * THE PEOPLE DOCUMENT — every figure on it computed on the read.
 *
 * The tables hold observations: counts per person, counts per person per day,
 * and the extremes. Cadence, staleness, temperature, the sent/received balance
 * and the venture link are all derived HERE, on every request, for the reason
 * the uptime route derives availability that way — a stored "cold" describes a
 * moment that has passed by the time anybody looks at it, and it survives a
 * collector that has stopped running, which is the exact condition the page
 * exists to reveal.
 *
 * WHAT THE DOCUMENT PROMISES, and it is narrower than the word "CRM" suggests:
 *
 *   * It is METADATA. No subject, snippet or body is in any of these tables.
 *     The document cannot say what anybody talked about and must never be read
 *     as if it could.
 *   * Every count is PER WINDOW, and the window is on the document. Where the
 *     scan's message cap bit, `scanFrom` is later than the window's start and
 *     every count is a FLOOR — `floors: true` says so rather than leaving it to
 *     be worked out.
 *   * A VENTURE LINK IS A GUESS. It comes from the contact's domain matching a
 *     venture's host, it carries `derived: true` and a reason, and somebody at
 *     a venture's own domain is usually connected to it and sometimes is a
 *     stranger who bought a mailbox there.
 *   * `temperature: null` is "no rhythm yet", not "cold". Under four gaps —
 *     five separate days of contact — no claim is made at all.
 *   * `sent` and `received` ARE PER CONTACT AND DO NOT SUM TO MAIL VOLUME. A
 *     message to five people counts once for each of the five.
 */
import { Hono } from "hono";
import { getPlugin } from "../../db.ts";
import {
  COLD_RATIO,
  COOLING_RATIO,
  DEFAULT_MAX_RECEIVED,
  MAX_SENT,
  MIN_GAPS,
  MIN_QUIET_DAYS,
  WEIGHT_BASIS,
  bareHost,
  contactRows,
  dayRows,
  people,
  settings,
  type Person,
} from "./contacts.ts";
import { briefRow, briefWeeks, isoWeek, writeBrief, type Figures } from "./brief.ts";

export const peopleRoutes = new Hono();

const DEFINITIONS = {
  privacy:
    "Metadata only. No subject line, snippet or body is requested from Gmail " +
    "or stored here; every field on a contact is a name, an address, a count " +
    "or a timestamp.",
  temperature:
    `Staleness measured against THIS contact's own rhythm, never a fixed ` +
    `number of days: cooling at ${COOLING_RATIO}× their median gap between ` +
    `contact days, cold at ${COLD_RATIO}×, and nothing is called cooling ` +
    `before ${MIN_QUIET_DAYS} days of silence. Fewer than ${MIN_GAPS} ` +
    `measurable gaps and the temperature is null — no rhythm, no claim.`,
  stale:
    "A separate and simpler question, and the owner's own: no mail either way " +
    "for the number of days set in the People settings. Cold is relative to " +
    "the relationship; stale is relative to the calendar.",
  membership:
    "A contact meets the minimum each way when there are at least that many " +
    "messages in BOTH directions. Everything scanned is stored; the list " +
    "shows the mutual ones unless ?all=1 is passed, and only mutual contacts " +
    "have a day series.",
  floors:
    "Counts and firstSeen are floors, not totals: the window is rolling, each " +
    "direction has a message cap, and Gmail lists newest first — so a " +
    "truncated scan holds the most recent part of the window.",
  volume:
    "sent and received are PER CONTACT. A message addressed to five people " +
    "counts once for each of them, so summing the columns does not give mail " +
    "volume and must not be reported as one.",
  ventureLink:
    "Derived, never asserted. The contact's domain matches a venture's host. " +
    "It carries derived: true and its own reason.",
  weightBasis: WEIGHT_BASIS,
};

function shape(p: Person) {
  return {
    mailbox: p.mailbox,
    address: p.address,
    name: p.name,
    domain: p.domain,
    firstSeen: p.firstSeen,
    lastReceived: p.lastReceived,
    lastSent: p.lastSent,
    lastAt: p.lastAt,
    received: p.received,
    sent: p.sent,
    threads: p.threads,
    contactDays: p.contactDays,
    cadenceDays: p.cadenceDays,
    cadenceGaps: p.cadenceGaps,
    quietDays: p.quietDays,
    daysSinceSent: p.daysSinceSent,
    daysSinceReceived: p.daysSinceReceived,
    ratio: p.ratio,
    temperature: p.temperature,
    why: p.why,
    stale: p.stale,
    mutual: p.mutual,
    weight: p.weight,
    link: p.link,
  };
}

/** The scan's own state, off the stored rows rather than off a run row: what
 *  matters to a reader is which window the numbers in front of them cover. */
function windowState() {
  const rows = contactRows();
  const s = settings();
  const scannedAt = rows.map((r) => r.scanned_at).sort().at(-1) ?? null;
  const scanFrom = rows.map((r) => r.scan_from).filter(Boolean).sort()[0] ?? null;
  /*
    THE WINDOW REPORTED IS THE ONE THESE ROWS WERE SCANNED OVER, not the one
    currently typed into the settings. They differ for exactly as long as it
    takes to collect after a change, and in that gap the setting is a statement
    about the NEXT scan while the counts on the page are still the old
    window's. Quoting the setting would caption last week's arithmetic with
    this morning's decision. `windowDaysSetting` is published beside it so a
    reader can see a pending change rather than be surprised by it.
  */
  const scannedWindow = rows.length ? Math.max(...rows.map((r) => r.window_days)) : s.windowDays;
  const expected = scannedAt ? Date.parse(scannedAt) - scannedWindow * 86_400_000 : null;
  return {
    windowDays: scannedWindow,
    windowDaysSetting: s.windowDays,
    minEachWay: s.minEachWay,
    staleDays: s.staleDays,
    maxReceived: s.maxReceived,
    maxSent: MAX_SENT,
    selfDomains: [...s.selfDomains],
    scannedAt,
    /** The oldest message any scan reached. */
    scanFrom,
    /** True when the cap bit: the counts are floors, not totals. */
    floors:
      scanFrom !== null && expected !== null && Date.parse(scanFrom) > expected + 86_400_000,
    mailboxes: [...new Set(rows.map((r) => r.mailbox))].sort(),
  };
}

const NOT_COLLECTED = {
  error:
    "No contacts have been folded yet. Connect a Gmail account under " +
    "Integrations and press Collect on the People plugin — this reads mail " +
    "HEADERS only.",
};

peopleRoutes.get("/", (c) => {
  const all = people();
  const state = windowState();

  const wantAll = c.req.query("all") === "1";
  const wantStale = c.req.query("stale") === "1";
  const domain = (c.req.query("domain") ?? "").trim().toLowerCase();
  const venture = (c.req.query("venture") ?? "").trim().toLowerCase();
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));

  let rows = wantAll ? all : all.filter((p) => p.mutual);
  if (wantStale) rows = rows.filter((p) => p.stale);
  if (domain) rows = rows.filter((p) => p.domain === domain || p.domain.endsWith(`.${domain}`));
  if (venture) {
    const bare = bareHost(venture);
    rows = rows.filter(
      (p) =>
        p.link !== null &&
        (p.link.slug === venture ||
          p.link.ventureId === venture ||
          p.link.ventureName.toLowerCase() === venture ||
          p.domain === bare ||
          p.domain.endsWith(`.${bare}`)),
    );
  }
  if (q)
    rows = rows.filter(
      (p) => p.address.includes(q) || (p.name ?? "").toLowerCase().includes(q) || p.domain.includes(q),
    );

  /* Weight orders the list; it is not a score of a relationship, and the
     document says so in `definitions.weightBasis`. */
  rows.sort((a, b) => b.weight - a.weight || a.address.localeCompare(b.address));

  const mutual = all.filter((p) => p.mutual);
  return c.json({
    ...state,
    counts: {
      scanned: all.length,
      mutual: mutual.length,
      matched: rows.length,
      returned: Math.min(rows.length, limit),
      warm: mutual.filter((p) => p.temperature === "warm").length,
      cooling: mutual.filter((p) => p.temperature === "cooling").length,
      cold: mutual.filter((p) => p.temperature === "cold").length,
      noRhythm: mutual.filter((p) => p.temperature === null).length,
      stale: mutual.filter((p) => p.stale).length,
    },
    /* The domains behind the list, so a filter can be offered without the
       client inventing one. */
    domains: [...new Set(mutual.map((p) => p.domain))].sort(),
    contacts: rows.slice(0, limit).map(shape),
    definitions: DEFINITIONS,
    note:
      all.length === 0
        ? NOT_COLLECTED.error
        : state.floors
          ? `The message cap bit: this scan reached back only to ${state.scanFrom}. Every count below is a floor.`
          : null,
  });
});

/* The literal segment BEFORE the parameter. An address cannot be "brief", but
   the order says the intent and survives a router that ranks differently. */
peopleRoutes.get("/brief", async (c) => {
  const week = (c.req.query("week") ?? "").trim();
  const row = briefRow(week || undefined);
  if (!row)
    return c.json(
      {
        week: week || isoWeek(),
        markdown: null,
        error:
          "No brief has been written yet. One is written automatically once " +
          "there are correspondences to write about; POST /api/people/brief " +
          "writes this week's now.",
        weeks: briefWeeks(),
      },
      404,
    );
  let figures: Figures | null = null;
  try {
    figures = JSON.parse(row.figures) as Figures;
  } catch {
    figures = null;
  }
  return c.json({
    week: row.week,
    writtenAt: row.written_at,
    model: row.model,
    markdown: row.markdown,
    error: row.error,
    /* `temps` is next week's raw material and hundreds of rows long. It is the
       one thing on the row the reader is not shown. */
    figures: figures ? { ...figures, temps: undefined } : null,
    weeks: briefWeeks(),
    definitions: {
      idempotence:
        "One brief per ISO week. The timer checks every six hours and does " +
        "nothing when the week already has a row, so a laptop that was shut " +
        "writes the week's brief when it opens rather than skipping it.",
      prose:
        "The paragraph, where there is one, was written by the active model " +
        "from the figures below and NOTHING else, and was refused entirely if " +
        "it used a name, number or address the figures do not carry. Where " +
        "there is no paragraph the figures are the brief.",
      comparison:
        "`firstBrief: true` means there was no previous brief to compare " +
        "against, so nobody is reported as newly cooled — the wentQuiet list " +
        "is then who is cooling or cold right now.",
    },
  });
});

/**
 * Write this week's brief now.
 *
 * NOT A SKILL ACTION. It exists for the page's button and for the first run of
 * an install, where waiting six hours to see whether the feature works is not
 * a reasonable ask. `force=1` rewrites THIS week only; an earlier week's row is
 * the record and nothing here can touch it.
 */
peopleRoutes.post("/brief", async (c) => {
  const force = c.req.query("force") === "1";
  try {
    const r = await writeBrief({ force });
    return c.json({ week: r.week, written: r.written, reason: r.reason, error: r.row?.error ?? null });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

peopleRoutes.get("/:address", (c) => {
  const address = decodeURIComponent(c.req.param("address")).trim().toLowerCase();
  const matches = people().filter((p) => p.address === address);
  if (!matches.length)
    return c.json(
      {
        error: `No contact ${address} in the current window. That is not the same as “never wrote to them”: the window is ${settings().windowDays} days and the scan has a message cap.`,
      },
      404,
    );
  return c.json({
    ...windowState(),
    /* One person can appear in two mailboxes, and they are two relationships
       with the same human. They are listed side by side and never added up. */
    seenIn: matches.map((p) => ({
      ...shape(p),
      days: dayRows(p.mailbox, p.address),
    })),
    definitions: DEFINITIONS,
  });
});

/* --------------------------------------------------------------- the health */

/** Whether the plugin row exists at all, for a client that wants to say
 *  "nothing connected" rather than "no contacts". */
peopleRoutes.get("/meta/state", (c) =>
  c.json({
    connected: getPlugin("people")?.connected === 1,
    ...windowState(),
    defaults: { maxReceived: DEFAULT_MAX_RECEIVED, maxSent: MAX_SENT },
  }),
);
