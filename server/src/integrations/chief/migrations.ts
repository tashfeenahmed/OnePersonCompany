/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "140_chief_goals",
    sql: `
      -- WHAT THE OWNER IS ACTUALLY TRYING TO DO, which nothing on this box
      -- measured and every answer on it should have been read through.
      --
      -- Every other table here is a RECORD OF SOMETHING THAT HAPPENED: a
      -- charge, a run, a reading. This one holds an INTENTION, and it is the
      -- only document on the box that can make the difference between "traffic
      -- is down 12%" and "traffic is down 12% and you said this quarter is
      -- about revenue, not reach, so it may not matter". A dashboard without
      -- it can only ever report; with it, it can advise.
      --
      -- TWO SCOPES AND NO MORE. One workspace-level text — what the owner is
      -- doing with the whole estate — and one per venture. There is no third
      -- level (per role, per quarter, per board column) because a goal that
      -- has to be looked up by four keys is a goal nobody edits, and an
      -- unedited goal is worse than none: it is a stale intention the agent
      -- will faithfully steer by.
      --
      -- \`venture_id\` IS '' AND NOT NULL for the global row, which looks like
      -- a nullable column badly used and is not. SQLite treats NULLs as
      -- DISTINCT in a UNIQUE index, so \`UNIQUE (scope, venture_id)\` with a
      -- NULL global row would permit two global goals and then quietly answer
      -- with whichever one the planner reached first. '' is a value, the
      -- unique index bites, and there is exactly one global text for ever.
      --
      -- NO FOREIGN KEY on \`venture_id\`, for the reason 080_subagents gives
      -- at length: \`ventures\` belongs to another area's directory and a
      -- constraint across the seam orders two independent migrations against
      -- each other. A goal whose venture has been deleted is pruned on the
      -- next read instead.
      CREATE TABLE IF NOT EXISTS chief_goals (
        scope       TEXT NOT NULL,
        venture_id  TEXT NOT NULL DEFAULT '',
        -- Markdown, the owner's own words. '' is a real state — "there is no
        -- goal written for this venture" — and is stored rather than deleted
        -- so that the row's \`updated_at\` still says when it was cleared.
        text        TEXT NOT NULL DEFAULT '',
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (scope, venture_id)
      );

      -- EVERY PREVIOUS VERSION, KEPT. A goal is a paragraph the owner typed at
      -- a moment; overwriting it with no trail would mean an agent can be told
      -- to rewrite one (it is a skill action away) and the words it replaced
      -- would be gone. The history is append-only and nothing prunes it: at a
      -- version per edit this is a table measured in kilobytes for the life of
      -- the box, and the alternative — trusting that nobody will ever want the
      -- old wording back — has already been wrong once for everybody.
      CREATE TABLE IF NOT EXISTS chief_goal_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        scope       TEXT NOT NULL,
        venture_id  TEXT NOT NULL DEFAULT '',
        -- The text as it was BEFORE the edit that made this row, and who made
        -- that edit: 'owner' from the page, 'agent' through the skill.
        text        TEXT NOT NULL,
        by          TEXT NOT NULL DEFAULT 'owner',
        written_at  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS chief_goal_history_key
        ON chief_goal_history (scope, venture_id, id);
    `,
  },
  {
    name: "141_chief_memory",
    sql: `
      -- WHAT THE CHIEF OF STAFF KNOWS, as opposed to what it can look up.
      --
      -- The skills surface answers questions about MEASUREMENTS. Nothing on
      -- this box held the other half of an assistant's usefulness: the durable
      -- facts nobody measures. "The owner will not do paid ads." "Example Support's
      -- churn is mostly trials that never activated." "He works Tuesdays and
      -- Thursdays." Those are learned, they are stated once, and without
      -- somewhere to put them the agent relearns them every conversation or,
      -- worse, contradicts them.
      --
      -- A NOTE IS A DATED BELIEF AND NOT A FACT, and the columns are shaped so
      -- that a reader cannot forget it. \`source\` says who wrote it —
      -- 'agent' means the assistant inferred it, 'owner' means it was typed —
      -- and \`created_at\`/\`last_confirmed_at\` say when it was formed and
      -- when it was last stood behind. A note from March that nothing has
      -- confirmed since is still true on its face and is exactly the kind of
      -- thing that should be quoted with its date attached.
      --
      -- THIS IS NOT HERMES' MEMORY. The managed agent has its own MEMORY.md
      -- and USER.md and keeps them in its own directory; those belong to that
      -- backend and vanish with it. This table is the DASHBOARD's memory: it is
      -- injected into the system turns of every backend — managed agent,
      -- remote agent, raw provider — so the answer to "what do you know about
      -- me" does not change when the owner switches which model is answering.
      CREATE TABLE IF NOT EXISTS chief_memory (
        id                TEXT PRIMARY KEY,
        text              TEXT NOT NULL,
        -- 'global' or 'venture'. A venture-scoped note is only injected into a
        -- conversation about that venture; a global one is always there.
        scope             TEXT NOT NULL DEFAULT 'global',
        venture_id        TEXT NOT NULL DEFAULT '',
        -- 'agent' | 'owner'. Not cosmetic: the consolidation pass is allowed
        -- to merge and drop agent notes and is NOT allowed to touch an owner's
        -- — see chief/memory.ts.
        source            TEXT NOT NULL DEFAULT 'agent',
        created_at        TEXT NOT NULL,
        -- When the belief was last stood behind. Set to created_at on insert,
        -- moved forward by an edit or by a re-remember of the same fact. It is
        -- the field the injection orders by, so the freshest belief is the one
        -- that survives a cap.
        last_confirmed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS chief_memory_scope
        ON chief_memory (scope, venture_id, last_confirmed_at);

      -- THE WHOLE SET, BEFORE A PASS TOUCHED IT. The consolidation pass asks a
      -- model to merge duplicates and drop stale notes, and a model asked to
      -- delete things will sometimes delete the wrong thing. So the pass is
      -- reversible by construction: the entire note table is serialised into
      -- one row here first, and UNDO is "put that row back". Storing a diff
      -- instead would be smaller and would require this file to be right about
      -- what a merge is; storing the set requires it to be right about
      -- nothing.
      CREATE TABLE IF NOT EXISTS chief_memory_versions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        taken_at    TEXT NOT NULL,
        -- 'consolidate' | 'undo'. An undo saves the post-pass set on its way
        -- out, so undoing an undo is possible and nothing is ever destroyed by
        -- a button.
        reason      TEXT NOT NULL,
        -- The ISO week the pass ran for, or NULL where the version was not
        -- made by a weekly pass.
        week        TEXT,
        -- JSON: the full rows of chief_memory as they were.
        notes       TEXT NOT NULL,
        -- Set when this version has been restored, so UNDO always means "the
        -- newest set nobody has already put back" rather than an ever-growing
        -- undo stack with no cursor.
        restored_at TEXT
      );

      -- ONE PASS PER ISO WEEK, ASKED OF A TABLE RATHER THAN A VARIABLE. The
      -- timer wakes every hour and a process that restarts twice an hour under
      -- --watch would otherwise consolidate twice an hour. The week key is the
      -- primary key, so a second pass in the same week cannot be recorded and
      -- therefore is not run.
      CREATE TABLE IF NOT EXISTS chief_memory_passes (
        week      TEXT PRIMARY KEY,
        ran_at    TEXT NOT NULL,
        -- 'before'/'after' would be SQLite keywords standing where a column
        -- name goes; spelling them out avoids a quoting rule nobody should
        -- have to remember when they add the next column.
        notes_before INTEGER NOT NULL DEFAULT 0,
        notes_after  INTEGER NOT NULL DEFAULT 0,
        merged    INTEGER NOT NULL DEFAULT 0,
        dropped   INTEGER NOT NULL DEFAULT 0,
        -- Which model was asked, and what went wrong if anything did. A pass
        -- that failed is RECORDED as having run: a failing model would
        -- otherwise be retried every hour for a week.
        model     TEXT,
        error     TEXT
      );
    `,
  },
  {
    name: "142_chief_rounds",
    sql: `
      -- THE SCHEDULED WALK OVER THE ESTATE.
      --
      -- Nineteen ventures and six workers each is a hundred and fourteen jobs
      -- that could be done, one run slot to do them in, and an owner who has
      -- to remember to ask. A round is the answer: once a day, at an hour the
      -- owner sets, walk the ventures and give the configured roles a job on
      -- the ones that are due.
      --
      -- IT IS A LEDGER OF A DECISION, NOT OF WORK. The work is in
      -- \`agent_runs\` where all work on this box lives — a round dispatches
      -- exactly the run the app or a hand dispatch would, through the same
      -- queue, into the same single slot. What is recorded here is what the
      -- round CONSIDERED and what it decided, because "why did nothing happen
      -- last night" is a question the runs table cannot answer: it has no row
      -- for a venture that was skipped.
      CREATE TABLE IF NOT EXISTS chief_rounds (
        id           TEXT PRIMARY KEY,
        started_at   TEXT NOT NULL,
        -- NULL while it is walking. A round takes seconds — it queues work, it
        -- does not wait for it — so a row that stays open is a crash, and it
        -- is visible as one.
        finished_at  TEXT,
        -- 'schedule' | 'manual'. The owner pressing the button and the timer
        -- firing produce the same walk and are told apart here, because "it
        -- ran twice yesterday" has two very different explanations.
        trigger      TEXT NOT NULL DEFAULT 'schedule',
        ventures     INTEGER NOT NULL DEFAULT 0,
        dispatched   INTEGER NOT NULL DEFAULT 0,
        skipped      INTEGER NOT NULL DEFAULT 0,
        -- JSON: one line per venture considered, with the reason it was or was
        -- not given work. This is the document the page draws and the sentence
        -- the chat session gets.
        notes        TEXT NOT NULL DEFAULT '[]'
      );

      -- EVERY SCHEDULED JOB, ONE ROW, WHATEVER HAPPENED TO IT. Dispatched,
      -- skipped, refused by a switched-off worker, or failed to queue at all.
      -- A ledger that only recorded successes would make a round that
      -- dispatched nothing indistinguishable from a round that never ran.
      CREATE TABLE IF NOT EXISTS chief_joblog (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id    TEXT,
        ts          TEXT NOT NULL,
        venture_id  TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT '',
        -- The run this became, or NULL where it became nothing.
        run_id      TEXT,
        -- 'dispatched' | 'skipped' | 'refused' | 'failed'
        outcome     TEXT NOT NULL,
        reason      TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS chief_joblog_round ON chief_joblog (round_id, id);
      CREATE INDEX IF NOT EXISTS chief_joblog_venture ON chief_joblog (venture_id, ts);
    `,
  },
  {
    name: "143_chief_outcomes",
    sql: `
      -- DID THE THING HE DID ACTUALLY DO ANYTHING?
      --
      -- This box is full of work — cards moved to Done, runs that produced
      -- reports, decisions taken in a chat — and full of measurements, and
      -- there was nothing joining the two. So an outcome is a LINK: one action,
      -- one metric, a baseline captured when the link was made, and readings
      -- taken at fixed offsets afterwards.
      --
      -- THE METRIC IS AN ADDRESS, NOT A NUMBER. \`skill\` + \`view\` +
      -- \`params\` + \`path\` is exactly how anything on this box addresses a
      -- figure: the skills proxy already turns those four into one document,
      -- and the path picks the field out of it. Storing a number-fetching
      -- function per outcome would mean nineteen bespoke readers; storing an
      -- address means a metric added by another area next month is trackable
      -- the day it ships, with no edit here.
      --
      -- WHAT THIS CANNOT DO, said in the table rather than only in the UI: it
      -- cannot establish CAUSE. Two figures either side of a date are two
      -- figures either side of a date. Everything this feature produces is
      -- correlation with a window stated, and the routes say so on every
      -- reading rather than leaving it to be inferred from a sparkline.
      CREATE TABLE IF NOT EXISTS chief_outcomes (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        venture_id   TEXT NOT NULL DEFAULT '',
        -- 'card' | 'run' | 'note'. What sort of action this is a claim about.
        action_kind  TEXT NOT NULL,
        -- The board card id or the run id, '' for a free-text note. No foreign
        -- key: a card can be deleted and the claim that it was done on a date
        -- survives it, which is the honest outcome — the action happened
        -- whether or not its row is still there.
        action_ref   TEXT NOT NULL DEFAULT '',
        action_text  TEXT NOT NULL,
        -- WHEN THE ACTION HAPPENED, which is not when the link was made. A
        -- card moved to Done last Tuesday and linked today has a baseline
        -- captured today and an action date of last Tuesday; the readings are
        -- offset from the ACTION, and the gap between the two is a fact the
        -- route reports rather than hides.
        action_at    TEXT NOT NULL,
        skill        TEXT NOT NULL,
        view         TEXT NOT NULL DEFAULT 'default',
        -- JSON object of the view's parameters, exactly as the skills proxy
        -- takes them.
        params       TEXT NOT NULL DEFAULT '{}',
        -- Dotted path into the answer, with [n] for array indices.
        path         TEXT NOT NULL,
        -- What the figure is counted in, in the owner's words. Optional, and
        -- null rather than guessed: a unit invented here would be a caption on
        -- somebody else's number.
        unit         TEXT,
        created_at   TEXT NOT NULL,
        -- Set when the owner stops tracking it. Nothing is deleted by the
        -- schedule.
        closed_at    TEXT
      );

      CREATE INDEX IF NOT EXISTS chief_outcomes_venture ON chief_outcomes (venture_id);

      -- EVERY READING, INCLUDING THE ONES THAT FAILED.
      --
      -- \`value\` IS NULLABLE AND THAT IS THE POINT. A metric that could not be
      -- read — the plugin was disconnected, the path moved, the route was down
      -- — records a row with a null value and the reason beside it. Writing a
      -- zero would put a cliff in the sparkline that the owner would read as a
      -- collapse in the business.
      CREATE TABLE IF NOT EXISTS chief_outcome_readings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        outcome_id  TEXT NOT NULL,
        ts          TEXT NOT NULL,
        -- 'baseline' | 'reading'. The baseline is the one taken at link time
        -- and there is exactly one; the rest are the scheduled ones.
        kind        TEXT NOT NULL DEFAULT 'reading',
        -- Which scheduled offset this is: 7, 14 or 30 days after the action.
        -- NULL on the baseline and on a manual reading, which are not on the
        -- schedule and must not fill one of its slots.
        day_offset  INTEGER,
        value       REAL,
        error       TEXT,
        -- What the address actually returned at that point, truncated. Kept
        -- because "the number changed" and "the document changed shape" look
        -- identical from the value column alone.
        raw         TEXT
      );

      CREATE INDEX IF NOT EXISTS chief_outcome_readings_outcome
        ON chief_outcome_readings (outcome_id, ts);
    `,
  },
];
