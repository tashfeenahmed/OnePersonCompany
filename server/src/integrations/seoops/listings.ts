/**
 * THE DIRECTORY LEDGER — where each venture has and has not been listed, and
 * who says so.
 *
 * ONE RULE DECIDES THE WHOLE SHAPE: THE CRAWLER MAY ONLY RATCHET FORWARD.
 * `signals/presence` probes nine sources and answers present / absent /
 * blocked / error every day. That is a good measurement and it is the wrong
 * thing to drive a checklist with, because it changes its mind: a directory
 * behind a WAF answers `blocked` on Tuesday, a listing under a slug the probe
 * does not guess answers `absent` on Wednesday, and a checklist wired straight
 * to it un-ticks work that was really done. So detection may move a row to
 * `detected` and to nowhere else, and only from `not_listed` or `pending`.
 * Everything past that — `confirmed`, `submitted`, `skipped` — means a PERSON
 * looked, and only a person can undo one.
 *
 * `skipped` IS A FIRST-CLASS ANSWER AND NOT A FAILURE. Most of the app tier
 * does not apply to a website and most of the code tier does not apply to a
 * SaaS; a list that cannot be told so is a list with forty permanent red marks
 * on it that the owner learns to ignore. Skipping is how the number starts
 * meaning something.
 *
 * WHAT IS DELIBERATELY NOT PORTED FROM WORKDASH: the broad `site:` search
 * sweep. Its own header records what that was worth — every metasearch backend
 * but one lost to CAPTCHAs, and the one that answered returned Polish news
 * stories for a `site:github.com` query. Coverage bought that way is noise
 * wearing a tick, and this ledger's whole value is that a tick means something.
 * The directories nothing here can probe carry `detect: null` and are worked
 * through by hand, which is honest and is also what they were always going to
 * be.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, now, ventureRowById, ventureRows, type VentureRow } from "../../db.ts";
import { hostOf, sameHost, settings } from "./settings.ts";

/* ------------------------------------------------------------ the states */

/**
 * The closed set. A state worth tracking is worth adding to this line, and an
 * unknown one is REFUSED rather than tidied into the nearest neighbour.
 *
 *   not_listed  nobody has looked, or nothing was found
 *   pending     the owner is preparing a submission
 *   submitted   sent, and waiting on somebody else's queue
 *   detected    a probe found a page carrying the brand. EVIDENCE, not a tick.
 *   confirmed   the owner looked at that page and it is theirs
 *   skipped     this directory does not apply to this venture
 */
export const LISTING_STATES = [
  "not_listed",
  "pending",
  "submitted",
  "detected",
  "confirmed",
  "skipped",
] as const;
export type ListingState = (typeof LISTING_STATES)[number];

/** What counts as progress on a count. `submitted` is in, because the work is
 *  done and the queue is somebody else's. */
export const DONE_STATES: ListingState[] = ["submitted", "confirmed"];

/**
 * WHICH STATES DETECTION MAY LEAVE. The forward-only rule, as data.
 *
 * A row a person has touched — pending, submitted, confirmed, skipped — is
 * theirs, and a probe that disagrees with it is a probe that is wrong more
 * often than the person is. `detected` may be refreshed by detection (its
 * `last_checked` moves) but not downgraded.
 */
export const DETECTABLE_FROM: ListingState[] = ["not_listed", "pending", "detected"];

/**
 * MAY DETECTION WRITE THIS TRANSITION?
 *
 * Pure, exported and tested, because it is the one rule in this file that a
 * later edit could quietly reverse. `from` is what the ledger holds (null for
 * a row that does not exist yet); `to` is what the probe wants to say.
 */
export function detectionMay(from: ListingState | null, to: ListingState): boolean {
  /* Detection has exactly one word. It cannot confirm, cannot submit, cannot
     skip and — the point of the whole rule — cannot un-list. */
  if (to !== "detected") return false;
  if (from === null) return true;
  return DETECTABLE_FROM.includes(from);
}

/* ------------------------------------------------------ the catalogue */

export type Directory = {
  id: string;
  name: string;
  url: string;
  tier: string;
  /** The presence source whose detection may move this row forward, or null. */
  detect: string | null;
  note: string;
};

type CatalogueDoc = {
  directories?: (Partial<Directory> & { drop?: boolean })[];
};

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}$/i;

/**
 * A SUBMISSION URL THE PAGE MAY RENDER AS AN HREF, or an empty string.
 *
 * The same rule `safeUrl` below applies to the ledger's own url, applied to the
 * one on the catalogue row — because the catalogue is merged with JSON the
 * owner types and `ListingsPanel` renders `submitUrl` as an `href`, where
 * `javascript:` would otherwise survive. Self-inflicted, and a field that is
 * strict on one url on a row and lax on the other beside it is a field nobody
 * can reason about. https only, like every other link this dashboard renders
 * from text it did not write.
 */
function cleanUrl(value: unknown): string {
  const raw = String(value ?? "").trim().slice(0, 400);
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

function clean(entry: Partial<Directory> & { drop?: boolean }): Directory | null {
  const id = String(entry.id ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) return null;
  return {
    id,
    name: String(entry.name ?? id).trim().slice(0, 80) || id,
    url: cleanUrl(entry.url),
    tier: String(entry.tier ?? "general").trim().toLowerCase().slice(0, 20) || "general",
    detect: entry.detect ? String(entry.detect).trim().toLowerCase().slice(0, 40) : null,
    note: String(entry.note ?? "").trim().slice(0, 400),
  };
}

let shipped: { list: Directory[]; error: string | null } | null = null;

/** The list that ships with the area. Read once — it is a file in the source
 *  tree and cannot change under a running process. */
function shippedCatalogue(): { list: Directory[]; error: string | null } {
  if (shipped) return shipped;
  try {
    const raw = readFileSync(join(import.meta.dirname, "directories.json"), "utf8");
    const doc = JSON.parse(raw) as CatalogueDoc;
    const list = (doc.directories ?? []).map(clean).filter((d): d is Directory => d !== null);
    shipped = { list, error: null };
  } catch (err) {
    /* The feature degrades to whatever the owner's setting holds rather than
       dying: a missing file is a deployment problem, not a data one. */
    shipped = {
      list: [],
      error: `The shipped directory list could not be read: ${
        err instanceof Error ? err.message.slice(0, 160) : "unknown error"
      }`,
    };
  }
  return shipped;
}

export type CatalogueResult = {
  directories: Directory[];
  /** What went wrong reading either list. Never silently empty. */
  errors: string[];
  /** Where each entry came from, so a surprising row can be traced. */
  fromSettings: string[];
};

/**
 * THE LIST, SHIPPED THEN MERGED WITH THE OWNER'S.
 *
 * The setting is JSON of the same shape. An entry with an id that already
 * exists REPLACES it; an entry with `"drop": true` removes it; anything else
 * is appended. Merging rather than replacing wholesale means the owner can add
 * one directory without pasting twenty-two back in, and can delete one without
 * this file having a per-entry "enabled" flag nobody would ever set.
 */
export function catalogue(): CatalogueResult {
  const base = shippedCatalogue();
  const errors: string[] = base.error ? [base.error] : [];
  const map = new Map(base.list.map((d) => [d.id, d]));
  const fromSettings: string[] = [];

  const raw = (settings().directoriesRaw ?? "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as CatalogueDoc | (Partial<Directory> & { drop?: boolean })[];
      const entries = Array.isArray(parsed) ? parsed : (parsed.directories ?? []);
      for (const entry of entries) {
        const id = String(entry.id ?? "").trim().toLowerCase();
        if (!ID_RE.test(id)) {
          errors.push(`An entry in the Directories setting has no usable id and was ignored.`);
          continue;
        }
        if (entry.drop === true) {
          map.delete(id);
          fromSettings.push(`${id} (removed)`);
          continue;
        }
        const shapedEntry = clean(entry);
        if (!shapedEntry) continue;
        map.set(id, shapedEntry);
        fromSettings.push(id);
      }
    } catch {
      errors.push(
        "The Directories setting is not valid JSON, so only the shipped list is in use. " +
          "Fix it on the plugin page — nothing was dropped.",
      );
    }
  }

  return { directories: [...map.values()], errors, fromSettings };
}

/* ---------------------------------------------------------------- the rows */

export type LedgerRow = {
  venture_id: string;
  directory_id: string;
  state: string;
  note: string | null;
  url: string | null;
  detected_at: string | null;
  submitted_at: string | null;
  confirmed_at: string | null;
  last_checked: string | null;
  set_by: string;
  updated_at: string;
};

export const ledgerRow = (ventureId: string, directoryId: string): LedgerRow | undefined =>
  db
    .prepare("SELECT * FROM listing_ledger WHERE venture_id = ? AND directory_id = ?")
    .get(ventureId, directoryId) as LedgerRow | undefined;

export const ledgerRows = (ventureId?: string | null): LedgerRow[] =>
  (ventureId
    ? db.prepare("SELECT * FROM listing_ledger WHERE venture_id = ? ORDER BY directory_id").all(ventureId)
    : db.prepare("SELECT * FROM listing_ledger ORDER BY venture_id, directory_id").all()) as unknown as LedgerRow[];

const MAX_NOTE = 400;

/** https only, like every link this dashboard renders from text it did not
 *  write, and REFUSED rather than blanked: dropping it would save the row
 *  without the one field the press was about. */
export function safeUrl(value: unknown): { url: string | null } | { error: string } {
  if (value === undefined) return { url: null };
  if (value === null || String(value).trim() === "") return { url: null };
  const s = String(value).trim().slice(0, 400);
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return { error: "A listing url must be an https link, or empty to clear it." };
    return { url: u.href };
  } catch {
    return { error: "A listing url must be an https link, or empty to clear it." };
  }
}

export type SetResult = { row: LedgerRow } | { error: string };

/**
 * ONE ROW, SET BY THE OWNER.
 *
 * The owner may make ANY transition, including back to `not_listed`: a person
 * who ticked the wrong row must be able to untick it, and a ledger that only
 * ratchets is one people stop touching. What this refuses is an invented
 * state, a silently renamed one, and a url that is not https.
 *
 * THE TWO TIMESTAMPS ARE STAMPED ONCE. Reaching `submitted` sets
 * `submitted_at` if it is unset; reaching `confirmed` sets `confirmed_at`.
 * Neither is restamped, because "submitted in April" is the fact and a second
 * press in August must not rewrite it, and neither is cleared by moving back —
 * the ledger keeps that it once happened.
 */
export function setListing(input: {
  ventureId: string;
  directoryId: string;
  state: string;
  note?: string | null | undefined;
  url?: unknown;
}): SetResult {
  const state = String(input.state ?? "").trim().toLowerCase() as ListingState;
  if (!LISTING_STATES.includes(state))
    return { error: `state must be one of: ${LISTING_STATES.join(", ")}.` };
  if (!ventureRowById(input.ventureId)) return { error: "No venture by that id." };
  if (!catalogue().directories.some((d) => d.id === input.directoryId))
    return { error: `No directory with the id "${input.directoryId}" is in the catalogue.` };

  const url = safeUrl(input.url);
  if ("error" in url) return url;

  const before = ledgerRow(input.ventureId, input.directoryId);
  const ts = now();
  const note =
    input.note === undefined ? (before?.note ?? null) : (String(input.note ?? "").trim().slice(0, MAX_NOTE) || null);

  db.prepare(
    `INSERT INTO listing_ledger
       (venture_id, directory_id, state, note, url, detected_at, submitted_at,
        confirmed_at, last_checked, set_by, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,'owner',?)
     ON CONFLICT(venture_id, directory_id) DO UPDATE SET
       state = excluded.state, note = excluded.note, url = excluded.url,
       detected_at = excluded.detected_at,
       submitted_at = excluded.submitted_at, confirmed_at = excluded.confirmed_at,
       set_by = 'owner', updated_at = excluded.updated_at`,
  ).run(
    input.ventureId,
    input.directoryId,
    state,
    note,
    input.url === undefined ? (before?.url ?? null) : url.url,
    /* AN OWNER MAY SAY `detected` TOO, and the date has to be stamped when they
       do. Only detection used to write this column, so a row the owner marked
       detected — "I found a page, I have not read it yet" — showed no date at
       all and read as if nothing had happened. Stamped once, like the other
       two, and kept when the row moves on. */
    state === "detected" ? (before?.detected_at ?? ts) : (before?.detected_at ?? null),
    state === "submitted" ? (before?.submitted_at ?? ts) : (before?.submitted_at ?? null),
    state === "confirmed" ? (before?.confirmed_at ?? ts) : (before?.confirmed_at ?? null),
    before?.last_checked ?? null,
    ts,
  );

  return { row: ledgerRow(input.ventureId, input.directoryId)! };
}

/* --------------------------------------------------------- the detection */

export type DetectionResult = {
  ventures: number;
  /** Presence products whose host matches no venture. Named rather than
   *  dropped: a product configured for presence and not filed as a venture is
   *  a thing the owner can fix in one edit. */
  unmatchedProducts: string[];
  moved: { venture: string; directory: string; from: string | null; url: string | null }[];
  refreshed: number;
  held: { venture: string; directory: string; state: string }[];
};

type PresenceRow = { product: string; host: string; source: string; status: string; url: string | null; evidence: string | null; ts: string };

function presenceRows(): PresenceRow[] {
  try {
    return db
      .prepare("SELECT product, host, source, status, url, evidence, ts FROM presence")
      .all() as unknown as PresenceRow[];
  } catch {
    return [];
  }
}

/** Which venture a presence product is about. Matched on HOST, because the
 *  host is the entity — presence/routes.ts's own words for its `/entities`
 *  answer — and two people can name one thing two ways. */
function ventureForHost(host: string, all: VentureRow[]): VentureRow | null {
  const h = hostOf(host);
  return all.find((v) => sameHost(hostOf(v.host || v.website), h)) ?? null;
}

/**
 * WALK THE PRESENCE TABLE AND MOVE WHAT MAY BE MOVED.
 *
 * Only a `present` cell counts, and only where the catalogue entry names that
 * presence source in `detect`. `blocked` and `error` are explicitly NOT
 * findings — presence/routes.ts spends a paragraph on why, and its conclusion
 * is carried here rather than restated more weakly: they mean the source could
 * not be asked.
 *
 * `held` is what detection WOULD have said and was not allowed to. It is on
 * the document so the rule is visible rather than invisible: a page that shows
 * "confirmed" beside "a probe also found this" is a page whose owner can see
 * the ledger and the crawler agreeing.
 */
export function detect(): DetectionResult {
  const rows = presenceRows();
  const all = ventureRows();
  const dirs = catalogue().directories;
  const out: DetectionResult = { ventures: 0, unmatchedProducts: [], moved: [], refreshed: 0, held: [] };
  const seenVentures = new Set<string>();
  const unmatched = new Set<string>();
  const ts = now();

  for (const row of rows) {
    if (row.status !== "present") continue;
    const dir = dirs.find((d) => d.detect === row.source);
    if (!dir) continue;
    const venture = ventureForHost(row.host, all);
    if (!venture) {
      unmatched.add(row.product);
      continue;
    }
    seenVentures.add(venture.id);

    const before = ledgerRow(venture.id, dir.id);
    const from = (before?.state ?? null) as ListingState | null;
    if (!detectionMay(from, "detected")) {
      out.held.push({ venture: venture.id, directory: dir.id, state: from ?? "not_listed" });
      /* The row is still touched on its `last_checked`, which is a fact about
         when we looked and says nothing about the state. */
      if (before)
        db.prepare("UPDATE listing_ledger SET last_checked = ? WHERE venture_id = ? AND directory_id = ?").run(
          ts,
          venture.id,
          dir.id,
        );
      continue;
    }

    if (from === "detected") {
      db.prepare(
        "UPDATE listing_ledger SET last_checked = ?, url = COALESCE(url, ?), updated_at = ? WHERE venture_id = ? AND directory_id = ?",
      ).run(ts, row.url, ts, venture.id, dir.id);
      out.refreshed += 1;
      continue;
    }

    db.prepare(
      `INSERT INTO listing_ledger
         (venture_id, directory_id, state, note, url, detected_at, submitted_at,
          confirmed_at, last_checked, set_by, updated_at)
       VALUES (?,?, 'detected', ?, ?, ?, ?, ?, ?, 'detection', ?)
       ON CONFLICT(venture_id, directory_id) DO UPDATE SET
         state = 'detected', url = COALESCE(listing_ledger.url, excluded.url),
         detected_at = COALESCE(listing_ledger.detected_at, excluded.detected_at),
         last_checked = excluded.last_checked, set_by = 'detection',
         updated_at = excluded.updated_at`,
    ).run(
      venture.id,
      dir.id,
      before?.note ?? null,
      row.url,
      ts,
      before?.submitted_at ?? null,
      before?.confirmed_at ?? null,
      ts,
      ts,
    );
    out.moved.push({ venture: venture.id, directory: dir.id, from, url: row.url });
  }

  out.ventures = seenVentures.size;
  out.unmatchedProducts = [...unmatched];
  return out;
}

/* ------------------------------------------------------------- the document */

export function shapeLedger(ventureId?: string | null) {
  const cat = catalogue();
  const ventures = ventureRows().filter((v) => !ventureId || v.id === ventureId);
  const rows = ledgerRows(ventureId);

  return {
    ventures: ventures.map((v) => {
      const mine = rows.filter((r) => r.venture_id === v.id);
      const cells = cat.directories.map((d) => {
        const row = mine.find((r) => r.directory_id === d.id);
        return {
          directory: d.id,
          name: d.name,
          tier: d.tier,
          submitUrl: d.url,
          detectableBy: d.detect,
          note: d.note,
          /** `not_listed` is the DEFAULT for a row nobody has touched, and it
           *  means "nobody has looked" as much as it means "not there". */
          state: (row?.state ?? "not_listed") as ListingState,
          ownerNote: row?.note ?? null,
          url: row?.url ?? null,
          detectedAt: row?.detected_at ?? null,
          submittedAt: row?.submitted_at ?? null,
          confirmedAt: row?.confirmed_at ?? null,
          lastChecked: row?.last_checked ?? null,
          setBy: row?.set_by ?? null,
        };
      });
      const count = (s: ListingState) => cells.filter((c) => c.state === s).length;
      return {
        ventureId: v.id,
        venture: v.name,
        slug: v.slug,
        host: v.host,
        directories: cells,
        summary: {
          confirmed: count("confirmed"),
          submitted: count("submitted"),
          detected: count("detected"),
          pending: count("pending"),
          skipped: count("skipped"),
          notListed: count("not_listed"),
          of: cells.length,
          /** Confirmed plus submitted, over the rows that are not skipped.
           *  Null when everything is skipped: a percentage of nothing is not a
           *  percentage. */
          donePct: (() => {
            const live = cells.filter((c) => c.state !== "skipped").length;
            if (!live) return null;
            return Number(
              ((cells.filter((c) => DONE_STATES.includes(c.state)).length / live) * 100).toFixed(1),
            );
          })(),
        },
      };
    }),
    catalogue: {
      count: cat.directories.length,
      tiers: [...new Set(cat.directories.map((d) => d.tier))].sort(),
      detectable: cat.directories.filter((d) => d.detect).length,
      fromSettings: cat.fromSettings,
      errors: cat.errors,
    },
    states: [...LISTING_STATES],
    notes: [
      "Detection may only move a row FORWARD to `detected`, and only from " +
        "not_listed, pending or detected. It can never move a row back: a " +
        "directory behind a WAF, or a listing under a slug the probe does not " +
        "guess, would otherwise un-tick work that was really done.",
      "`detected` is EVIDENCE, not a tick. Directories carry pages for products " +
        "that never submitted, and a page found by a probe has not been read by " +
        "anybody. Only `confirmed` means a person looked.",
      "`not_listed` is the default for a row nobody has touched. It means " +
        "\"nobody has looked\" as often as it means \"not there\".",
      "`skipped` is a real answer, not a failure: most of the app tier does not " +
        "apply to a website and most of the code tier does not apply to a SaaS.",
      "Only " +
        `${cat.directories.filter((d) => d.detect).length} of ${cat.directories.length} ` +
        "directories can be probed at all. The rest are worked through by hand, " +
        "which is what they were always going to be — no broad search sweep is " +
        "performed, deliberately.",
    ],
  };
}
