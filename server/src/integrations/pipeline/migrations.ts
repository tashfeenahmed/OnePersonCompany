/** The pipeline's tables. Pure SQL, no imports — see integrations/manifest.ts. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "220_pipeline_runs",
    sql: `
      -- ONE NIGHT, ONE ROW.
      --
      -- Before this table there were fourteen timers on this box and no
      -- statement anywhere of what the estate did between midnight and six.
      -- Each timer knew its own last pass and none of them knew about the
      -- others, so "why did nothing happen last night" had fourteen answers
      -- and no way to ask the question once. A pipeline run is that one
      -- question: what was planned, in what order, what came of each piece,
      -- and what it cost.
      --
      -- \`dry\` IS A COLUMN AND NOT A SEPARATE TABLE. A planned night and a
      -- walked night are the same walk with the executors withheld, and the
      -- value of a dry run is that its plan is filed beside the real ones so
      -- "what would tonight do" and "what did last night do" are read from
      -- one place in one shape. A dry row is never counted as a stage's last
      -- successful pass — the cadence check in registry.ts excludes it.
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id           TEXT PRIMARY KEY,
        started_at   TEXT NOT NULL,
        -- NULL while walking. A night takes minutes; a row that stays open is
        -- a crash and should read as one rather than as work in progress.
        finished_at  TEXT,
        -- 'schedule' | 'manual' | 'stage'. A single-stage run is its own
        -- trigger because "it ran twice yesterday" has different explanations
        -- depending on which, exactly as chief_rounds records.
        trigger      TEXT NOT NULL,
        dry          INTEGER NOT NULL DEFAULT 0,
        planned      INTEGER NOT NULL DEFAULT 0,
        completed    INTEGER NOT NULL DEFAULT 0,
        skipped      INTEGER NOT NULL DEFAULT 0,
        failed       INTEGER NOT NULL DEFAULT 0,
        over_budget  INTEGER NOT NULL DEFAULT 0,
        -- Dollars the night spent through the metered model provider, or NULL
        -- when no price per million tokens is configured. NULL is not zero:
        -- an unpriced box spends real money it cannot count, and a 0.00 there
        -- would be the one figure on this page that is a lie.
        usd          REAL,
        ms           INTEGER,
        -- The overnight result, in prose, as it was pushed. Stored so the page
        -- shows the same sentences the phone got.
        summary      TEXT NOT NULL DEFAULT '',
        note         TEXT
      );
      CREATE INDEX IF NOT EXISTS pipeline_runs_started ON pipeline_runs(started_at DESC);
    `,
  },

  {
    name: "221_pipeline_stage_results",
    sql: `
      -- EVERY STAGE THE NIGHT CONSIDERED, INCLUDING THE ONES IT DID NOT RUN.
      --
      -- The rounds ledger taught this: a table with a row only for work that
      -- happened cannot answer why work did not. \`outcome\` is one of
      -- completed | skipped | failed | over-budget, and the three that are not
      -- "completed" carry the sentence that explains them.
      --
      -- \`reason\` AND \`error\` ARE TWO COLUMNS ON PURPOSE. A skip is a
      -- decision — the owner switched it off, it is not due, it is inside a
      -- blackout, a dependency did not complete — and a failure is a fault.
      -- One column would make the morning read the owner's own settings as
      -- breakage.
      CREATE TABLE IF NOT EXISTS pipeline_stage_results (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL,
        stage_id    TEXT NOT NULL,
        area        TEXT NOT NULL DEFAULT '',
        started_at  TEXT NOT NULL,
        finished_at TEXT,
        outcome     TEXT NOT NULL,
        reason      TEXT,
        error       TEXT,
        -- One line for the overnight summary, written by the stage itself.
        note        TEXT,
        ms          INTEGER,
        -- What this stage spent, read from budget_usage against the run
        -- context the stage ran inside. NULL when nothing is priced.
        usd         REAL,
        -- Whatever the stage counted, as JSON. Never summed across stages.
        counts      TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS pipeline_stage_results_run ON pipeline_stage_results(run_id);
      CREATE INDEX IF NOT EXISTS pipeline_stage_results_stage
        ON pipeline_stage_results(stage_id, started_at DESC);
    `,
  },

  {
    name: "222_pipeline_stage_prefs",
    sql: `
      -- THE OWNER'S OVERRIDES, ONE ROW PER STAGE HE HAS TOUCHED.
      --
      -- A row here is an EDIT and not a copy of the default. A stage nobody
      -- has changed has no row at all, which is what lets a release change a
      -- default and have it take effect — the alternative, seeding a row per
      -- stage at boot, freezes every default the day the box is installed.
      --
      -- Every column is nullable for the same reason: "I switched this off"
      -- and "I set a dollar cap" are separate edits, and a NULL means "still
      -- the stage's own default" rather than zero.
      CREATE TABLE IF NOT EXISTS pipeline_stage_prefs (
        stage_id    TEXT PRIMARY KEY,
        enabled     INTEGER,
        -- daily | weekly | monthly. How often the stage is DUE, which is a
        -- different question from whether it is enabled.
        cadence     TEXT,
        max_usd     REAL,
        max_minutes REAL,
        updated_at  TEXT NOT NULL
      );
    `,
  },

  {
    name: "223_pipeline_skips",
    sql: `
      -- "NOT TONIGHT." One row, holding the calendar day the owner said to
      -- leave alone, in his own zone. A table rather than a setting because it
      -- expires by itself: the night reads the day it holds, compares it with
      -- today, and a stale value is simply not today any more.
      CREATE TABLE IF NOT EXISTS pipeline_skips (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        day     TEXT NOT NULL,
        set_at  TEXT NOT NULL,
        reason  TEXT
      );
    `,
  },

  {
    name: "224_synthesis_proposals",
    sql: `
      -- WHAT THE SYNTHESIS PASS PROPOSED, AND WHAT IT THREW AWAY.
      --
      -- THE DROPPED ROWS ARE THE POINT. A pass that filed two cards out of
      -- nine and kept no record of the seven is a pass nobody can trust: the
      -- owner cannot tell whether it thought of the obvious thing and rejected
      -- it, or never thought of it. \`verdict\` is 'filed' or 'dropped' and
      -- \`reason\` is the gate's own sentence, written to be read by a person.
      --
      -- \`evidence\` IS THE PACKET THE MODEL SAW, as JSON, and it is stored
      -- rather than referenced because the sources move: the traffic delta
      -- that justified a proposal on Tuesday is a different number on Friday,
      -- and a proposal whose evidence cannot be re-read is an assertion.
      --
      -- \`card_origin\` IS THE BOARD'S OWN IDEMPOTENCY KEY, kept here so the
      -- proposal and the card it became can be joined without a foreign key
      -- onto a table whose rows the owner deletes at will.
      CREATE TABLE IF NOT EXISTS synthesis_proposals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT,
        at          TEXT NOT NULL,
        venture_id  TEXT NOT NULL,
        rank        INTEGER NOT NULL DEFAULT 0,
        title       TEXT NOT NULL,
        rationale   TEXT NOT NULL DEFAULT '',
        -- The one evidence line the action rests on, quoted from the packet.
        evidence_line TEXT,
        evidence    TEXT NOT NULL DEFAULT '{}',
        verdict     TEXT NOT NULL,
        reason      TEXT,
        card_origin TEXT
      );
      CREATE INDEX IF NOT EXISTS synthesis_proposals_at ON synthesis_proposals(at DESC);
      CREATE INDEX IF NOT EXISTS synthesis_proposals_venture
        ON synthesis_proposals(venture_id, at DESC);
    `,
  },

  {
    name: "225_synthesis_coverage",
    sql: `
      -- WHOSE TURN IT IS.
      --
      -- Nineteen ventures and a handful of proposals a night: without a
      -- rotation the same three businesses at the top of the list get looked
      -- at every night for ever and the other sixteen never do. This table is
      -- the least-recently-covered order, and it is a table rather than a
      -- derivation from synthesis_proposals because a venture that produced
      -- NOTHING was still covered — deriving from the proposals would put it
      -- straight back at the front of the queue.
      CREATE TABLE IF NOT EXISTS synthesis_coverage (
        venture_id   TEXT PRIMARY KEY,
        last_pass_at TEXT NOT NULL,
        passes       INTEGER NOT NULL DEFAULT 0,
        last_run_id  TEXT
      );
    `,
  },

  {
    name: "226_synthesis_venture_prefs",
    sql: `
      -- "NEVER PROPOSE ANYTHING FOR THIS ONE."
      --
      -- Per venture, because a portfolio has businesses in it that are parked,
      -- sold, or somebody else's problem this quarter, and a global switch
      -- would make the owner choose between proposals for everything and
      -- proposals for nothing. Absent row = proposals are on, which is the
      -- default a fresh install wants.
      CREATE TABLE IF NOT EXISTS synthesis_venture_prefs (
        venture_id  TEXT PRIMARY KEY,
        proposals   INTEGER NOT NULL DEFAULT 1,
        updated_at  TEXT NOT NULL
      );
    `,
  },
  {
    name: "227_pipeline_stage_window",
    sql: `
      -- THE PART OF THE NIGHT A STAGE MAY START IN.
      --
      -- The stage shape always carried \`defaultWindow\`, and the walk always
      -- honoured it — but every registered stage ships null and there was no
      -- column to override one, so the branch was unreachable code wearing a
      -- feature's clothes. A review caught it. This is the column that makes it
      -- real: \`HH:MM-HH:MM\` in the pipeline's own zone, or NULL for anywhere
      -- inside the nightly window, set through PATCH /api/pipeline/stages/:id.
      --
      -- It is on the OVERRIDES table rather than beside the blackouts because
      -- it is the opposite claim. A blackout says "not here, whatever you are";
      -- a window says "this one, only here" — one is the owner protecting his
      -- evening, the other is him putting the expensive stage after the cheap
      -- ones. Two settings, two tables, and the walk reads them with the same
      -- function.
      ALTER TABLE pipeline_stage_prefs ADD COLUMN window TEXT;
    `,
  },

];
