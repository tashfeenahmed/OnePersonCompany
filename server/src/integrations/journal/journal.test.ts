/**
 * The journal's logic: the streak arithmetic, the date gate, and the two rules
 * that turned out to need a database to state.
 *
 * THE STREAK IS THE PART WORTH TESTING because it is the only number this area
 * computes rather than stores, and because its one judgement — that an empty
 * TODAY does not end a run — is exactly the kind of rule that gets quietly
 * inverted by a refactor and then reads as broken every morning.
 *
 * MOST OF IT TOUCHES NO DATABASE: `streak` and `parseDay` take their inputs as
 * arguments, which is what makes them testable. The last three do, and they
 * earn it. "The agent's rows are not the owner's streak" and "deleting an entry
 * deletes its event" are both claims about what SQL does across two tables, and
 * both were regressions found in review — the first handed the owner a run he
 * had not done, the second left a deleted sentence on the timeline for ever.
 * Neither can be stated without rows. The harness gives each worker a
 * throwaway database (`test/setup.mjs`), so this is the schema, not a copy.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { db } from "../../db.ts";
import {
  OWNER_SOURCES,
  addEntry,
  agentFiledCount,
  dayBefore,
  deleteEntry,
  entryDays,
  parseDay,
  streak,
  today,
} from "./entries.ts";

test("a run of consecutive days ending today", () => {
  const s = streak(["2026-09-06", "2026-09-05", "2026-09-04"], "2026-09-06");
  assert.equal(s.current, 3);
  assert.equal(s.longest, 3);
  assert.equal(s.today, true);
  assert.equal(s.lastDay, "2026-09-06");
  assert.equal(s.days, 3);
  /* The provenance travels with the number: a streak is a claim about who did
     something, so the answer says whose days it counted. */
  assert.deepEqual([...s.sources], [...OWNER_SOURCES]);
  assert.equal(s.agentFiled, 0);
});

test("today being empty does not end the run", () => {
  /* The one judgement in the function. A streak that reset at midnight would
     read as broken for the whole of a working day that has not happened yet. */
  const s = streak(["2026-09-05", "2026-09-04"], "2026-09-06");
  assert.equal(s.current, 2);
  assert.equal(s.today, false);
});

test("two empty days end the run", () => {
  const s = streak(["2026-09-04", "2026-09-03"], "2026-09-06");
  assert.equal(s.current, 0);
  assert.equal(s.longest, 2);
  assert.equal(s.today, false);
  assert.equal(s.lastDay, "2026-09-04");
});

test("the longest run is not the current one", () => {
  const s = streak(
    ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-09-05", "2026-09-06"],
    "2026-09-06",
  );
  assert.equal(s.current, 2);
  assert.equal(s.longest, 4);
});

test("several entries on one day are one day", () => {
  const s = streak(["2026-09-06", "2026-09-06", "2026-09-06"], "2026-09-06");
  assert.equal(s.current, 1);
  assert.equal(s.days, 1);
});

test("an empty journal has no streak and no last day", () => {
  assert.deepEqual(streak([], "2026-09-06"), {
    current: 0,
    longest: 0,
    lastDay: null,
    today: false,
    days: 0,
    sources: OWNER_SOURCES,
    agentFiled: 0,
  });
});

test("a run across a month boundary", () => {
  const s = streak(["2026-08-30", "2026-08-31", "2026-09-01"], "2026-09-01");
  assert.equal(s.current, 3);
});

test("a run across a leap day", () => {
  const s = streak(["2028-02-28", "2028-02-29", "2028-03-01"], "2028-03-01");
  assert.equal(s.current, 3);
  assert.equal(s.longest, 3);
});

test("dayBefore steps a calendar day, not 24 hours of local time", () => {
  assert.equal(dayBefore("2026-03-30"), "2026-03-29"); // the EU clock change
  assert.equal(dayBefore("2026-01-01"), "2025-12-31");
  assert.equal(dayBefore("2028-03-01"), "2028-02-29");
});

test("a missing date means today", () => {
  const from = new Date("2026-09-06T10:00:00Z");
  assert.deepEqual(parseDay("", from), { day: today(from) });
  assert.deepEqual(parseDay(undefined, from), { day: today(from) });
});

test("the future is refused and the past is not", () => {
  const from = new Date("2026-09-06T10:00:00Z");
  assert.ok("error" in parseDay("2026-09-07", from));
  assert.deepEqual(parseDay("2026-09-05", from), { day: "2026-09-05" });
});

test("a date that is not one is refused rather than coerced", () => {
  const from = new Date("2026-09-06T10:00:00Z");
  assert.ok("error" in parseDay("yesterday", from));
  assert.ok("error" in parseDay("2026-02-30", from));
  assert.ok("error" in parseDay("1998-01-01", from));
});

test("an ISO instant is resolved in the box's own day, not in UTC", () => {
  /*
    THE BUG THIS IS HERE FOR. The ISO branch used to take `slice(0, 10)` — a UTC
    date — and compare it against `today()`, which is a LOCAL day. West of
    Greenwich that refused ten o'clock on a Sunday night as "in the future";
    east of it, work done just after midnight was filed under yesterday.

    The expectation is computed the same way the table's axis is, so this says
    the same thing in every timezone rather than only in the one it was written
    in — which is exactly the property the old hard-coded "2026-09-04" lacked.
  */
  const instant = "2026-09-04T18:22:01.000Z";
  const from = new Date("2026-09-06T10:00:00Z");
  assert.deepEqual(parseDay(instant, from), { day: today(new Date(instant)) });

  /* And an instant late TONIGHT is not the future, whichever side of Greenwich
     this box is on: its local day is today's. */
  const now_ = new Date();
  const tonight = new Date(
    now_.getFullYear(),
    now_.getMonth(),
    now_.getDate(),
    23,
    30,
  ).toISOString();
  assert.deepEqual(parseDay(tonight, now_), { day: today(now_) });
});

test("a bare date is taken as written, with no timezone arithmetic on it", () => {
  /* A date with no time in it is already a local day; putting it through the
     instant path would shift it by a timezone it never carried. */
  const from = new Date("2026-09-08T00:30:00.000Z");
  assert.deepEqual(parseDay("2026-09-04", from), { day: "2026-09-04" });
});

/* --------------------------------------------- the two rules that need rows */

/** A blank table, so these tests cannot see each other's rows. */
function emptyJournal() {
  db.exec("DELETE FROM journal_entries");
  try {
    db.exec("DELETE FROM activity_events WHERE key LIKE 'journal:%'");
  } catch {
    /* The activity area's table may not exist here; nothing to clear. */
  }
}

/** N days before today, as the local date the table stores. */
function dayAgo(n: number): string {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

test("the streak counts the owner's own rows and never the agent's", () => {
  /*
    THE LIE THIS PREVENTS. Every rule in this area says the agent files what the
    owner SAID and never its own work, and the source stamp is what makes that
    checkable — but a stamp on a row does nothing for a number computed over ALL
    the rows. Before this, an agent back-filling three days handed the owner a
    four-day run he had not done, in the one table whose entire value is that a
    person vouched for every row.
  */
  emptyJournal();
  assert.ok("entry" in addEntry({ kind: "did", text: "his own", at: dayAgo(0), source: "ui" }));
  for (const n of [1, 2, 3])
    assert.ok(
      "entry" in addEntry({ kind: "did", text: `agent back-fill ${n}`, at: dayAgo(n), source: "agent" }),
    );

  assert.deepEqual(entryDays(), [dayAgo(0)], "agent days must not reach the streak's input");

  const s = streak(entryDays(), today(), agentFiledCount());
  assert.equal(s.current, 1, "three agent rows must not extend a one-day run to four");
  assert.equal(s.longest, 1);
  assert.equal(s.days, 1);
  /* Left out, but not hidden: the count of what was excluded rides with it. */
  assert.equal(s.agentFiled, 3);

  /* A Telegram row IS the owner's own hand, and does count. */
  assert.ok(
    "entry" in addEntry({ kind: "did", text: "from the phone", at: dayAgo(1), source: "telegram" }),
  );
  assert.equal(streak(entryDays(), today(), agentFiledCount()).current, 2);
});

test("deleting an entry deletes its event on the activity feed", () => {
  /*
    THE FAILURE THIS PREVENTS. The activity pass derives an event per entry keyed
    `journal:<id>` and only ever UPSERTS what still exists — it has no way to
    notice a row that has gone. So a deleted entry used to be removed from the
    journal, answer 200, and leave its sentence, its venture and its link on the
    timeline for ever. Somebody pressing a trash icon is trying to make a thing
    stop being anywhere.
  */
  emptyJournal();
  const filed = addEntry({ kind: "met", text: "a sentence that must not survive", source: "ui" });
  assert.ok("entry" in filed);
  const id = filed.entry.id;
  const key = `journal:${id}`;

  db.prepare(
    `INSERT INTO activity_events (key, ts, exact, kind, venture_id, product, title, detail, source, found_at)
     VALUES (?, ?, 0, 'journal', NULL, NULL, ?, '{}', 'journal', ?)`,
  ).run(key, `${filed.entry.at}T00:00:00.000Z`, filed.entry.text, new Date().toISOString());
  assert.ok(db.prepare("SELECT 1 FROM activity_events WHERE key = ?").get(key), "fixture");

  assert.equal(deleteEntry(id), true);
  assert.equal(db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(id), undefined);
  assert.equal(
    db.prepare("SELECT 1 FROM activity_events WHERE key = ?").get(key),
    undefined,
    "the feed event must go with the entry",
  );
});

test("deleting an entry that never reached the feed still succeeds", () => {
  /* The guard around that second statement: a box whose activity area has never
     run a pass has no event to delete, and that must not cost the journal row. */
  emptyJournal();
  const filed = addEntry({ kind: "did", text: "never derived", source: "ui" });
  assert.ok("entry" in filed);
  assert.equal(deleteEntry(filed.entry.id), true);
  assert.equal(deleteEntry("j-does-not-exist"), false);
});
