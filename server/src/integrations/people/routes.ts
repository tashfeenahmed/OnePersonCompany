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
import {
  LINK_KEYS,
  MAX_EMAIL,
  MAX_IMPORT,
  MAX_LINK,
  MAX_NAME,
  MAX_NOTE,
  MAX_TAG,
  MAX_TAGS,
  NEW_FOR_DAYS,
  avatarRow,
  deleteWatch,
  dispatchDossier,
  importPeople,
  insertWatch,
  updateWatch,
  watchByName,
  watchFile,
  watchList,
  watchPerson,
  watchRow,
  type Links,
} from "./watch.ts";
import { pullPerson } from "./activity.ts";

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

/* ------------------------------------------------------------ the watchlist */

/**
 * THE HAND-TYPED HALF OF THIS AREA, and it is declared HERE — above
 * `/:address` — because "watch" would otherwise be read as an email address
 * and answered with a 404 about a contact nobody asked for. Hono matches in
 * declaration order, so the literal segment has to be written first; the
 * comment above `/brief` makes the same point and this is the second case of
 * it.
 *
 * Everything about the list itself is in watch.ts. What lives here is the
 * validation, which is a decision about what the OWNER is allowed to type and
 * therefore belongs at the door.
 */

type Bad = { error: string };
const isBad = (v: unknown): v is Bad =>
  typeof v === "object" && v !== null && "error" in (v as Record<string, unknown>);

/** The five text columns and their caps. `note` is the only one with room for
 *  a sentence; the rest are a line each, because a card that wraps four times
 *  is a dossier somebody typed into the wrong box. */
const TEXT_FIELDS = [
  { key: "name", column: "name", max: MAX_NAME, label: "A name" },
  { key: "company", column: "company", max: MAX_NAME, label: "The company" },
  { key: "role", column: "role", max: MAX_NAME, label: "The role" },
  { key: "email", column: "email", max: MAX_EMAIL, label: "The email address" },
  { key: "note", column: "note", max: MAX_NOTE, label: "The note" },
] as const;

/**
 * READ THE BODY, AND SAY WHICH FIELD WAS WRONG.
 *
 * Absent stays absent, which is what makes one reader serve both doors: a POST
 * fills the gaps with empty strings afterwards, a PATCH writes only the
 * columns that came. Sending a field EMPTY is a real edit — clearing a company
 * — and is not the same as leaving it out, so "" is kept rather than skipped.
 *
 * THE EMAIL IS TRIMMED AND NOT VALIDATED. There is no format check because
 * there is nothing here that sends mail: this address is a line in a brief and
 * a thing to search on, and refusing "jane (at) acme.io" would be this box
 * arguing with the owner about his own notes.
 */
function readWatchBody(
  body: Record<string, unknown>,
): Bad | { values: Record<string, string>; links?: Links; tags?: string[] } {
  const values: Record<string, string> = {};
  for (const f of TEXT_FIELDS) {
    if (!(f.key in body)) continue;
    const raw = body[f.key];
    if (typeof raw !== "string") return { error: `${f.label} is text.` };
    const t = raw.trim();
    if (t.length > f.max)
      return { error: `${f.label} is longer than ${f.max.toLocaleString()} characters.` };
    values[f.column] = t;
  }

  /*
    TAGS ARE VALIDATED AND NOT INTERPRETED. A tag is a shelf label the owner
    invents — "investor", "same market", "met at a conference" — and this box
    has no taxonomy to check it against and no business having one. What is
    checked is that there are not thirty of them and that none is a paragraph:
    past that, a tag list is a filing decision and filing is his.

    Sending `tags: []` CLEARS them, the same way an empty string clears a
    company. Leaving the key out changes nothing.
  */
  let tags: string[] | undefined;
  if ("tags" in body && body.tags !== undefined) {
    const raw = body.tags;
    if (!Array.isArray(raw)) return { error: "tags is a list of short labels." };
    if (raw.length > MAX_TAGS) return { error: `That is more than ${MAX_TAGS} tags.` };
    tags = [];
    for (const v of raw) {
      if (typeof v !== "string") return { error: "Every tag is text." };
      const t = v.trim();
      if (!t) continue;
      if (t.length > MAX_TAG) return { error: `“${t.slice(0, 20)}…” is longer than ${MAX_TAG} characters — that is a note, not a tag.` };
      if (!tags.some((held) => held.toLowerCase() === t.toLowerCase())) tags.push(t);
    }
  }

  if (!("links" in body) || body.links === undefined) return { values, tags };
  const raw = body.links;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return {
      error: `links is an object of where to find them — ${LINK_KEYS.join(", ")}.`,
    };
  const links: Links = {};
  for (const key of LINK_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") return { error: `links.${key} is text.` };
    const t = v.trim();
    if (t.length > MAX_LINK) return { error: `links.${key} is longer than ${MAX_LINK} characters.` };
    /* Empty clears it: the object stored is only the places there is
       something to go and look at, so an empty string simply never arrives. */
    if (t) links[key] = t;
  }
  /* Anything not in LINK_KEYS is dropped in silence — see watch.ts for why a
     400 would be the worse answer during a half-deployed change. */
  return { values, links, tags };
}

const WATCH_DEFINITIONS = {
  source:
    "TYPED BY THE OWNER. Nothing collects this list and nothing refreshes it: " +
    "a name is here because he put it here, and most of these people have " +
    "never written to him — they will not appear in the contacts document.",
  dossiers:
    "Counted on the read out of the run ledger, by TITLE: a dossier run is " +
    "titled “Dossier — <name>”, so a run attaches to a person when the name " +
    "in the title is theirs, either exactly or followed by a comma and a " +
    "qualifying clause. `count` is FINISHED dossiers only; a failed one is in " +
    "`last` and is counted nowhere else.",
  deletion:
    "Removing somebody from the list deletes no run. The dossiers stay in the " +
    "ledger, where they are the box's work rather than this list's property.",
  identity:
    "Every field but the name is optional and is exactly what he typed. An " +
    "empty field means it was not written down — it does not mean nobody " +
    "knows it, and a dossier brief omits the line rather than saying “unknown”.",
  metrics:
    "Pulled from KEYLESS public sources — GitHub's API, Bluesky's public " +
    "AppView, Algolia's Hacker News index, an RSS feed — and every figure is " +
    "nullable. null is NOT KNOWN: there is no link of that kind on the card, " +
    "or the source did not answer. It is never 0. `metrics.at` is when the " +
    "pull RAN; a source that failed leaves its last figure standing and says " +
    "so in `warnings`.",
  activity:
    "`activityAt` is when the sources were last read, and null means never " +
    "pulled — which is a different thing from pulled and quiet. Events are " +
    "somebody else's public timeline, cached: at most 300 per person, and " +
    "nothing about them is private or inferred.",
  newEvents:
    `Events this box FIRST SAW in the last ${NEW_FOR_DAYS} days, which is not ` +
    "the same as events that happened in them. A person pulled for the first " +
    "time has a whole timeline that is new to this box, so the number reads " +
    "high on the day they are added and must never be reported as “they " +
    "published this many things this week”.",
  contact:
    "The mailbox's side of a watched person, matched on their email address " +
    "first and otherwise on first-and-last name folded for accents and case. " +
    "`matchedBy: \"name\"` is a GUESS; an ambiguous name match returns null " +
    "rather than a stranger's correspondence, and null is the ordinary answer " +
    "because most people on this list have never written to him.",
  tags:
    "His own shelf labels, at most " + MAX_TAGS + " of " + MAX_TAG + " " +
    "characters. Nothing derives them and there is no taxonomy behind them.",
  avatar:
    "`avatar` is a RELATIVE URL ON THIS BOX — /api/people/watch/<id>/avatar — " +
    "and never the address the picture came from. The bytes are downloaded " +
    "once by the pull, from the GitHub or Bluesky profile that was being read " +
    "anyway, and stored here: a card pointing an <img> at somebody else's CDN " +
    "would tell that CDN every time this file was opened, on a page about " +
    "people the owner is quietly watching. null means no picture was found — " +
    "no GitHub or Bluesky avatar, no imported URL, or nobody has pulled this " +
    "person yet — and it is never a claim that they have no photograph.",
};

peopleRoutes.get("/watch", (c) =>
  c.json({
    people: watchList(),
    definitions: WATCH_DEFINITIONS,
  }),
);

/**
 * TAKE A LIST OF PEOPLE AND LEAVE THE WATCHLIST HOLDING ALL OF THEM.
 *
 * DECLARED BEFORE `/watch/:id` for the reason `/watch` is declared before
 * `/:address`: Hono matches in declaration order, and "import" is a perfectly
 * good watch id as far as a router is concerned.
 *
 * THE ONE RULE WORTH READING BEFORE CALLING THIS: an import FILLS GAPS AND
 * OVERWRITES NOTHING. A person already on the list keeps every field he typed
 * — company, role, email, note, and each link separately — and gains only the
 * ones that were empty. Tags are unioned. So running the same file twice
 * changes nothing the second time, and a file that disagrees with his notes
 * loses the argument, which is the only safe default for a door that takes a
 * few hundred rows in one request.
 */
peopleRoutes.post("/watch/import", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const rows = body?.people;
  if (!Array.isArray(rows))
    return c.json(
      { error: "Send { people: [...] } — a list of rows with at least a name each." },
      400,
    );
  if (rows.length > MAX_IMPORT)
    return c.json(
      {
        error: `That is ${rows.length.toLocaleString()} rows. This door takes ${MAX_IMPORT} at a time — a watchlist is a list somebody keeps, not a CRM export.`,
      },
      413,
    );

  const out = importPeople(rows);
  return c.json({
    ...out,
    definitions: {
      ...WATCH_DEFINITIONS,
      merge:
        "Existing rows are matched by name, case-insensitively, and only their " +
        "EMPTY fields are filled. Nothing typed here is ever overwritten by an " +
        "import, links merge one key at a time, and tags are unioned.",
      counts:
        "`updated` counts rows that actually CHANGED. Re-importing the same " +
        "file reports zero, because nothing was filled in. Rows with no name " +
        "are skipped, and phone and location are not read — this table has no " +
        "column for them and the note is his own words.",
      returned: "The rows added or merged, name-sorted. Not the whole list.",
    },
  });
});

/**
 * THE STORED FACE, SERVED FROM THIS BOX.
 *
 * DECLARED ABOVE `/watch/:id` for the reason `/watch/import` is: Hono matches
 * in declaration order, and while these two patterns differ in segment count
 * today, a later `/watch/:id` catch-all would swallow this one silently — the
 * failure being a broken image on every card rather than an error anybody
 * reads.
 *
 * THIS ROUTE IS THE WHOLE POINT OF STORING THE BYTES. Every alternative to it
 * — an `avatar` field holding GitHub's own URL, a redirect to it, a proxy that
 * fetched on demand — ends with a third party learning when the owner looks at
 * which watched person. The picture was downloaded once, by a pull, on this
 * box's own schedule; this hands it back over loopback and nobody outside
 * hears about the reader.
 *
 * PRIVATE AND A DAY LONG. Private because it is a face on the owner's own
 * watchlist and no shared cache has any business holding it; a day because the
 * bytes only change when a pull replaces them, and the ETag — the instant they
 * were fetched — makes the revalidation free when it does.
 *
 * 404 WITH A SENTENCE rather than an empty body, because the caller is a card
 * that has to draw something, and "never pulled" and "has no picture anywhere"
 * are different things to say.
 */
peopleRoutes.get("/watch/:id/avatar", (c) => {
  const id = c.req.param("id");
  const row = watchRow(id);
  if (!row) return c.json({ error: `Nobody on the watchlist has the id ${id}.` }, 404);

  const face = avatarRow(id);
  if (!face)
    return c.json(
      {
        error: row.activity_at
          ? `${row.name} has no stored picture. Neither their GitHub nor their Bluesky profile offered one, and no import carried a URL.`
          : `${row.name} has never been pulled, so no picture has been fetched. POST /api/people/watch/${id}/pull.`,
      },
      404,
    );

  /* The instant the bytes were read. They are replaced whole or not at all, so
     the timestamp identifies the body exactly — there is nothing to hash. */
  const etag = `"${face.fetched_at}"`;
  if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag });

  const bytes = face.bytes;
  return c.body(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    200,
    {
      "Content-Type": face.mime,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=86400",
      ETag: etag,
    },
  );
});

/**
 * ONE WATCHED PERSON'S FILE.
 *
 * FOUR PANELS AND FOUR DIFFERENT KINDS OF CLAIM, kept apart on purpose:
 * `person` is what he typed plus the tracked numbers, `contact` is measured
 * from mail headers and may be a name-match guess, `events` are a cached copy
 * of somebody else's public feed, and `dossiers` are runs this box performed.
 * A merged "profile" object would have no way to say which half of a sentence
 * came from where.
 *
 * IT DOES NOT PULL. Reading a page must not spend somebody else's rate limit,
 * and a GET that fetched four APIs would take four seconds and would fire on
 * every refresh. The sweep pulls every twenty hours; the button POSTs.
 */
peopleRoutes.get("/watch/:id", (c) => {
  const id = c.req.param("id");
  const file = watchFile(id);
  if (!file) return c.json({ error: `Nobody on the watchlist has the id ${id}.` }, 404);
  return c.json({ ...file, definitions: WATCH_DEFINITIONS });
});

peopleRoutes.post("/watch", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return c.json({ error: "Send a JSON object with at least a name." }, 400);

  const read = readWatchBody(body);
  if (isBad(read)) return c.json(read, 400);

  const name = read.values.name ?? "";
  if (!name) return c.json({ error: "A name is the one thing a watch entry needs." }, 400);

  /* CASE-INSENSITIVE, because the join onto the dossiers is the name: a
     second row under a different casing would not be a duplicate on the page,
     it would be two cards splitting one person's dossier record between
     them. Refused rather than merged — merging would be this box deciding two
     names are one person. */
  const clash = watchByName(name);
  if (clash)
    return c.json(
      {
        error: `${clash.name} is already on the list.`,
        id: clash.id,
      },
      409,
    );

  const row = insertWatch({
    name,
    company: read.values.company ?? "",
    role: read.values.role ?? "",
    email: read.values.email ?? "",
    note: read.values.note ?? "",
    links: read.links ?? {},
    tags: read.tags ?? [],
  });
  return c.json(watchPerson(row.id)!, 201);
});

peopleRoutes.patch("/watch/:id", async (c) => {
  const id = c.req.param("id");
  const existing = watchRow(id);
  if (!existing) return c.json({ error: `Nobody on the watchlist has the id ${id}.` }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return c.json({ error: "Send a JSON object of the fields to change." }, 400);

  const read = readWatchBody(body);
  if (isBad(read)) return c.json(read, 400);

  const changes: Record<string, string> = { ...read.values };
  if ("name" in changes) {
    if (!changes.name) return c.json({ error: "A watch entry cannot lose its name." }, 400);
    const clash = watchByName(changes.name, id);
    if (clash) return c.json({ error: `${clash.name} is already on the list.`, id: clash.id }, 409);
  }
  /*
    A RENAME MOVES THE DOSSIERS, and it does so by doing nothing at all: the
    record is computed from the title on every read, so the runs that attach
    are whatever attaches to the NEW name. That is the honest behaviour —
    correcting a misspelt name should find the reports written under the
    correct one — and it is worth knowing that the old name's dossiers, if any
    were written, stop appearing here. They are still in the ledger.
  */
  if (read.links !== undefined) changes.links = JSON.stringify(read.links);
  if (read.tags !== undefined) changes.tags = JSON.stringify(read.tags);
  if (!Object.keys(changes).length)
    return c.json(
      { error: "Nothing to change. Send name, company, role, email, note, links or tags." },
      400,
    );

  updateWatch(id, changes);
  return c.json(watchPerson(id)!);
});

/** Off the list. NOT off the ledger — see `definitions.deletion`. */
peopleRoutes.delete("/watch/:id", (c) => {
  const id = c.req.param("id");
  if (!watchRow(id)) return c.json({ error: `Nobody on the watchlist has the id ${id}.` }, 404);
  deleteWatch(id);
  return c.json({ id, deleted: true });
});

/**
 * Ask the People Analyst for a dossier on this person.
 *
 * A THIN DOOR ONTO ONE DISPATCH. Everything it does is compose the brief out
 * of the row and hand it to the sub-agents area, whose answer goes back
 * unchanged — the 201 with the run, the 409 when the worker is switched off,
 * the 413 when the note is a document. There is no INSERT here: a run this
 * file created itself would skip the switched-off check and the standing
 * instructions, and would be a report nobody was asked to write.
 */
peopleRoutes.post("/watch/:id/dossier", async (c) => {
  const id = c.req.param("id");
  const row = watchRow(id);
  if (!row) return c.json({ error: `Nobody on the watchlist has the id ${id}.` }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const focus = typeof body?.focus === "string" ? body.focus.trim() : "";
  if (body?.focus !== undefined && typeof body.focus !== "string")
    return c.json({ error: "focus is a line or two of text, or absent." }, 400);
  const parent =
    typeof body?.parentSessionId === "string" && body.parentSessionId.trim()
      ? body.parentSessionId.trim()
      : undefined;

  const out = dispatchDossier(row, { focus, parentSessionId: parent });
  return c.json(out.json, out.status);
});

/**
 * READ THIS PERSON'S PUBLIC SOURCES NOW.
 *
 * NOT DESTRUCTIVE AND NOT EXPENSIVE, which is the whole difference between
 * this door and the one above it. `dossier` dispatches an agent: it takes the
 * run slot, pays for a long completion on the owner's account and cannot be
 * refunded by cancelling. This makes at most six anonymous GETs against public
 * APIs and writes what they said. It spends nothing, and marking it
 * destructive to be safe would teach a client to ignore the flag on the door
 * that really is.
 *
 * IT ANSWERS 200 EVEN WHEN EVERY SOURCE FAILED. The failures are the
 * `warnings` on the document — a 502 would throw away the three sources that
 * did answer and the numbers already on the row, which is the page going blank
 * over somebody else's outage.
 */
peopleRoutes.post("/watch/:id/pull", async (c) => {
  const id = c.req.param("id");
  const row = watchRow(id);
  if (!row) return c.json({ error: `Nobody on the watchlist has the id ${id}.` }, 404);

  try {
    await pullPerson(row);
  } catch (e) {
    /* Every source already fails soft into a warning, so reaching here means
       the store itself refused. That is this box's fault and is said plainly. */
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return c.json({ ...watchFile(id)!, definitions: WATCH_DEFINITIONS });
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
