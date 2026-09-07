/**
 * THE WATCHLIST — the people the owner is keeping an eye on, and the dossiers
 * written about them.
 *
 * THIS IS THE ONE TABLE IN THIS AREA NOBODY COLLECTS. Contacts are a fold of
 * Gmail headers, commitments a fold of the owner's own sent mail, the brief a
 * fold of both. This list is typed. No scan can add a row to it, no timer can
 * refresh one, and a name on it does not become more or less true because the
 * mailbox went quiet. Most of these people have never written to the owner at
 * all — an investor worth reading up on, a founder in the same market, the
 * person on the other side of a deal — and that is exactly why the list is not
 * a filter over people_contacts: "who do I correspond with" and "who am I
 * watching" are two questions, and the second one's answer is mostly people
 * the first one has never heard of.
 *
 * THE NAME IS THE ONLY REQUIRED FIELD, and it is also the join. A dossier's
 * title comes out of `dossierTitle`, which takes the first naming clause of a
 * brief — so a dispatch whose brief begins with the person's name produces
 * `Dossier — <name>`, and every later dossier on the same person produces the
 * same string. That string is the whole of the tie between this month's
 * dossier and last month's, in the runs area as much as here. `attaches` is
 * the rule in one place, exported so the client draws the same set of runs on
 * a person's card as this file counts.
 *
 * NOTHING DERIVED IS STORED. The dossier record — how many, whether one is
 * running, when the last one went in — is counted out of `agent_runs` on every
 * read, for the same reason contacts.ts computes temperature on the read: a
 * stored count is wrong the moment a run finishes, and it would outlive a run
 * that was deleted. The cost is one indexed scan of the dossier runs per list
 * request, which is a table of tens.
 *
 * A DISPATCH FROM HERE IS THE SAME DISPATCH AS EVERYWHERE ELSE. This file
 * composes a brief and hands it to `dispatch()` in the subagents area — it
 * does not insert a run. A second INSERT would skip the switched-off check,
 * the standing instructions and the session filing, and would produce runs
 * that look like the People Analyst's and were never given to it.
 *
 * DELETING A WATCH ROW DELETES NO RUN. Taking somebody off the list is losing
 * interest in them; it is not a claim that the reports were never written, and
 * the ledger is the box's record rather than this list's property.
 */
import { db, now } from "../../db.ts";
import { dispatch, type DispatchBody } from "../subagents/routes.ts";
import { ensureTeam, subagentId, subagentRow } from "../subagents/store.ts";

/** The identity lines. Short on purpose: this is a card, not a CRM record —
 *  anything longer than a line belongs in the note or in a dossier. */
export const MAX_NAME = 120;
export const MAX_EMAIL = 200;
export const MAX_NOTE = 4000;
export const MAX_LINK = 500;

/**
 * THE FIVE PLACES, AND NO SIXTH.
 *
 * A closed list rather than a free-form map because these are what a dossier
 * run is told to go and read, and an open map would let a caller put anything
 * at all into a brief handed to an agent with a browser. Unknown keys are
 * DROPPED rather than refused: the client's fields and this list will drift by
 * one for as long as it takes to deploy both halves, and a 400 in that window
 * would lose the whole edit rather than the one field nobody here knows.
 */
export const LINK_KEYS = ["website", "github", "x", "linkedin", "bluesky"] as const;
export type LinkKey = (typeof LINK_KEYS)[number];
export type Links = Partial<Record<LinkKey, string>>;

/** How each link is labelled in a brief. Sentence-cased the way a person
 *  writes them, because the brief is read by a model as prose. */
const LINK_LABEL: Record<LinkKey, string> = {
  website: "Website",
  github: "GitHub",
  x: "X",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
};

export type WatchRow = {
  id: string;
  name: string;
  company: string;
  role: string;
  email: string;
  note: string;
  links: string;
  created_at: string;
  updated_at: string;
};

export type DossierRecord = {
  /** DONE runs only. A dossier that failed is not a dossier. */
  count: number;
  running: boolean;
  queued: number;
  /** The newest by `queued_at` WHATEVER its status — including a failure,
   *  which is the state a reader most needs to see. */
  last: { id: string; status: string; finishedAt: string | null; queuedAt: string } | null;
};

export type WatchPerson = {
  id: string;
  name: string;
  company: string;
  role: string;
  email: string;
  note: string;
  links: Links;
  createdAt: string;
  updatedAt: string;
  dossiers: DossierRecord;
};

/* ------------------------------------------------------------------ the id */

/** `pw-` and six characters of base 36, minted until one is free — the shape
 *  and the loop `mintRunId` uses, for the same reason: an id the owner can
 *  read out loud, and no sequence anybody can count rows off. */
export function mintWatchId(): string {
  for (;;) {
    const id = `pw-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!watchRow(id)) return id;
  }
}

/* -------------------------------------------------------------- the joining */

/** What `dossierTitle` puts in front of the person. Written once here rather
 *  than matched loosely, because a title that does not start with it is a
 *  title from somewhere else and is compared whole. */
const TITLE_PREFIX = "Dossier — ";

/**
 * DOES THIS RUN'S TITLE NAME THIS PERSON?
 *
 * ONE FUNCTION, EXPORTED, because the client draws the same set of runs on a
 * person's card that this file counts into `dossiers`. Two copies of this rule
 * would disagree the first time either was tightened, and the disagreement
 * would look like a missing dossier rather than like a bug.
 *
 * The comma case is the whole of why this is not an equality test.
 * `dossierTitle` deliberately KEEPS the qualifying clause — "Jane Doe, founder
 * of Acme" is how one Jane Doe is told from another, and it is what the run
 * shelf groups by — so a watch row named "Jane Doe" must still find the
 * dossiers filed under the longer form. The prefix must end at a COMMA and
 * nowhere else: matching on `startsWith(name)` alone would attach every
 * dossier on "Jane Doe-Smith" to Jane Doe.
 */
export function attaches(title: string, name: string): boolean {
  const who = (title.startsWith(TITLE_PREFIX) ? title.slice(TITLE_PREFIX.length) : title)
    .trim()
    .toLowerCase();
  const person = name.trim().toLowerCase();
  if (!person) return false;
  return who === person || who.startsWith(`${person},`);
}

type DossierRunRow = {
  id: string;
  title: string;
  status: string;
  queued_at: string;
  finished_at: string | null;
};

/**
 * Every portfolio-wide dossier run, newest first.
 *
 * `venture_id IS NULL` is not a tidiness filter: the People Analyst belongs to
 * no venture, and a dossier filed under one is a different kind of run — the
 * run app's own form can start one against a venture — which this list has no
 * claim on. Read once per request and filtered in JavaScript rather than
 * joined per person, because `attaches` is the rule and it is not SQL.
 */
function dossierRuns(): DossierRunRow[] {
  return db
    .prepare(
      `SELECT id, title, status, queued_at, finished_at
         FROM agent_runs
        WHERE kind = 'dossier' AND venture_id IS NULL
        ORDER BY queued_at DESC`,
    )
    .all() as unknown as DossierRunRow[];
}

/** The record for one person out of an already-read list of runs. */
function record(runs: DossierRunRow[], name: string): DossierRecord {
  const mine = runs.filter((r) => attaches(r.title, name));
  /* `dossierRuns` is ordered newest first, so the first match is the newest —
     whatever became of it. A `last` that skipped failures would answer "the
     last dossier finished in March" on a person whose three attempts since
     have all broken, which is the one thing a reader needs to know. */
  const last = mine[0] ?? null;
  return {
    count: mine.filter((r) => r.status === "done").length,
    running: mine.some((r) => r.status === "running"),
    queued: mine.filter((r) => r.status === "queued").length,
    last: last
      ? { id: last.id, status: last.status, finishedAt: last.finished_at, queuedAt: last.queued_at }
      : null,
  };
}

/* ---------------------------------------------------------------- the store */

export function watchRow(id: string): WatchRow | undefined {
  return db.prepare("SELECT * FROM people_watch WHERE id = ?").get(id) as WatchRow | undefined;
}

export function watchRows(): WatchRow[] {
  return db.prepare("SELECT * FROM people_watch").all() as unknown as WatchRow[];
}

/** The duplicate check, and it is case-insensitive because "jane doe" and
 *  "Jane Doe" are one person with two dossier piles otherwise — the join is on
 *  the name, so a second row under a different casing would silently split the
 *  record in half. `exceptId` lets a rename keep its own row. */
export function watchByName(name: string, exceptId?: string): WatchRow | undefined {
  const wanted = name.trim().toLowerCase();
  return watchRows().find((r) => r.name.trim().toLowerCase() === wanted && r.id !== exceptId);
}

export function parseLinks(raw: string): Links {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Links = {};
    for (const key of LINK_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === "string" && v.trim()) out[key] = v.trim();
    }
    return out;
  } catch {
    /* A row whose JSON will not parse is a row somebody edited with a shell.
       No links is the honest answer; throwing would take the whole list down
       over one field nothing depends on. */
    return {};
  }
}

export function shape(row: WatchRow, runs: DossierRunRow[]): WatchPerson {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    role: row.role,
    email: row.email,
    note: row.note,
    links: parseLinks(row.links),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dossiers: record(runs, row.name),
  };
}

/** The whole list, sorted by name the way a person reads one — case-folded,
 *  so "adam" does not sort after "Zoe" the way a byte comparison would. */
export function watchList(): WatchPerson[] {
  const runs = dossierRuns();
  return watchRows()
    .map((r) => shape(r, runs))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

export function watchPerson(id: string): WatchPerson | null {
  const row = watchRow(id);
  return row ? shape(row, dossierRuns()) : null;
}

export function insertWatch(fields: {
  name: string;
  company: string;
  role: string;
  email: string;
  note: string;
  links: Links;
}): WatchRow {
  const id = mintWatchId();
  const ts = now();
  db.prepare(
    `INSERT INTO people_watch (id, name, company, role, email, note, links, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.name,
    fields.company,
    fields.role,
    fields.email,
    fields.note,
    JSON.stringify(fields.links),
    ts,
    ts,
  );
  return watchRow(id)!;
}

export function updateWatch(id: string, changes: Partial<Record<string, string>>): WatchRow {
  const sets: string[] = [];
  const args: (string | null)[] = [];
  for (const [column, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    args.push(value);
  }
  sets.push("updated_at = ?");
  args.push(now(), id);
  db.prepare(`UPDATE people_watch SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return watchRow(id)!;
}

export function deleteWatch(id: string): void {
  db.prepare("DELETE FROM people_watch WHERE id = ?").run(id);
}

/* --------------------------------------------------------------- the brief */

/**
 * THE BRIEF A DOSSIER RUN IS GIVEN, and the FIRST LINE IS THE NAME ALONE.
 *
 * That is not formatting. `dossierTitle` takes the first naming clause of the
 * first line and turns it into `Dossier — <name>`, and `attaches` finds the
 * run again by that string. A brief that opened with "Please look into Jane
 * Doe" would title the run `Dossier — Please look into Jane Doe`, which no
 * watch row would ever match and no second dossier would ever join — so the
 * person's card would show nothing while the ledger filled up with reports
 * about them.
 *
 * EVERYTHING ELSE IS ONLY WHAT WAS TYPED. A line is written when the field has
 * something in it and is omitted otherwise; there is no "Company: unknown",
 * because a worker told a field is unknown treats that as a thing to go and
 * find, and an empty field on a watch card means the owner did not write it
 * down rather than that nobody knows it.
 *
 * `focus` GOES LAST AND IN ITS OWN PARAGRAPH, after a blank line, so it reads
 * as the request rather than as one more identity line — and so that
 * `dossierTitle`, which only ever looks at the first line, cannot pick it up.
 */
export function composeBrief(person: {
  name: string;
  company?: string;
  role?: string;
  email?: string;
  note?: string;
  links?: Links;
}, focus?: string): string {
  const lines: string[] = [];
  if (person.role?.trim()) lines.push(`Role: ${person.role.trim()}`);
  if (person.company?.trim()) lines.push(`Company: ${person.company.trim()}`);
  if (person.email?.trim()) lines.push(`Email: ${person.email.trim()}`);
  for (const key of LINK_KEYS) {
    const v = person.links?.[key]?.trim();
    if (v) lines.push(`${LINK_LABEL[key]}: ${v}`);
  }
  if (person.note?.trim()) lines.push(`Note: ${person.note.trim()}`);

  const head = person.name.trim();
  const body = lines.length ? `${head}\n\n${lines.join("\n")}` : head;
  const asked = focus?.trim();
  return asked ? `${body}\n\nLook into: ${asked}` : body;
}

/**
 * Hand one person to the People Analyst.
 *
 * THE RUN IS NOT INSERTED HERE. `dispatch` is the one door onto a run and it
 * is called rather than copied: it holds the switched-off check, the owner's
 * standing instructions, the brief-length limit and the filing of the run
 * under the conversation that asked for it. Its answer — status and JSON — is
 * returned untouched, so a caller from this list gets exactly what a caller
 * from the sub-agents page gets, including the 409 when the worker is off.
 */
export function dispatchDossier(row: WatchRow, opts: { focus?: string; parentSessionId?: string }) {
  /* Provisioning is part of the dispatch, the same as it is on the sub-agents
     door: a box that has never opened that page still has a People Analyst by
     the time this line returns. */
  ensureTeam();
  const worker = subagentRow(subagentId("", "people"));
  if (!worker)
    return {
      status: 404 as const,
      json: {
        error: "There is no People Analyst on this box, so there is nobody to write a dossier.",
      },
    };
  const body: DispatchBody = {
    brief: composeBrief(
      {
        name: row.name,
        company: row.company,
        role: row.role,
        email: row.email,
        note: row.note,
        links: parseLinks(row.links),
      },
      opts.focus,
    ),
  };
  if (opts.parentSessionId) body.parentSessionId = opts.parentSessionId;
  return dispatch(worker, body);
}
