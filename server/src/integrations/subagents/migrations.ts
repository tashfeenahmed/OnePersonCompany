/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "080_subagents",
    sql: `
      -- A SUB-AGENT IS A ROLE ON A VENTURE, NOT A THING THE OWNER CREATES.
      --
      -- Every venture has the same six jobs to be done about it — somebody has
      -- to research it, watch its rivals, read its SEO, read its demand, check
      -- what models say about it, and write it up — and those six are exactly
      -- the six kinds of run this box can execute. So the roster is DERIVED
      -- from the ventures table by \`ensureTeam\`, not typed in: there is no
      -- create route, no delete route, and no way to end up with a venture
      -- that has five workers because somebody forgot one.
      --
      -- THEN WHY A TABLE AT ALL, if the rows can be computed? Because three
      -- columns cannot be: the name the owner renamed it to, the standing
      -- instructions they wrote for it, and whether they switched it off. Those
      -- are the owner's words about a worker, they have to survive a restart,
      -- and they are the whole reason this is storage rather than a constant.
      -- Everything else on the wire shape — what it is running, what it has
      -- queued, what it last did — is read out of \`agent_runs\` at request
      -- time and is deliberately NOT duplicated here, because a count kept in
      -- two places is a count that will eventually disagree with itself.
      --
      -- THE ID IS DERIVED AND NOT MINTED: \`sa-<ventureId>-<role>\`. A random
      -- id would mean \`ensureTeam\` had to remember which row it made for which
      -- pair; a derived one means the pair IS the address, a second insert for
      -- the same pair is impossible by construction (the UNIQUE says so twice),
      -- and a client holding a venture and a role can build the URL without a
      -- lookup. It is readable out loud, which every id on this box is.
      --
      -- NO FOREIGN KEY ON \`venture_id\`, and here the reason is different from
      -- the one agent_runs gives. It is not that the work outlives the business
      -- — a worker for a deleted venture is meaningless and is deleted. It is
      -- that \`ventures\` belongs to another area of this seam, and a foreign
      -- key would make this area's migration fail on any box where that area's
      -- table is not there yet, ordering two independent directories against
      -- each other for a constraint that is enforced better in code: every read
      -- of the org prunes rows whose venture is gone, so the roster is correct
      -- one request after a deletion rather than one statement after it.
      CREATE TABLE subagents (
        id            TEXT PRIMARY KEY,
        venture_id    TEXT NOT NULL,
        role          TEXT NOT NULL,
        name          TEXT NOT NULL,
        title         TEXT NOT NULL,
        -- '' rather than NULL, because "no standing instructions" is a real
        -- and ordinary state rather than a question nobody asked, and a reader
        -- that had to tell the two apart would be telling them apart for
        -- nothing.
        instructions  TEXT NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (venture_id, role)
      );

      CREATE INDEX subagents_venture ON subagents(venture_id);
    `,
  },
  {
    name: "081_agent_runs_dispatch",
    sql: `
      -- WHO ASKED FOR THIS RUN, AND ON WHOSE BEHALF.
      --
      -- Both columns are written by the dispatch route and by nothing else,
      -- and both are NULL on every run started from an app page. That asymmetry
      -- is the point rather than a gap to be backfilled:
      --
      --   \`parent_session_id\` is the conversation the work was asked for in.
      --   It exists so the rail can nest the run under the chat that started it
      --   — which is the shape the rail was already drawn for — and a run
      --   started by a person clicking a button on /apps/seo genuinely has no
      --   parent conversation. Filling it in with something would be inventing
      --   a chat that never happened.
      --
      --   \`subagent_id\` is the worker the Chief of Staff addressed. It is NOT
      --   how a run is attributed to a worker: a run's kind plus its venture
      --   already say whose work it is, and that derivation covers every run
      --   ever recorded, including the thousands started before this table
      --   existed. This column says something narrower and unrecoverable —
      --   that a named worker was dispatched, rather than that the owner
      --   started the same kind of work themselves.
      --
      -- NO FOREIGN KEY ON EITHER, for two different reasons that happen to
      -- agree. There is no \`chat_sessions\` table to point at — see
      -- db.ts's \`chatSessionSummaries\` on why sessions are the client's idea —
      -- and a sub-agent row that is pruned when its venture is deleted must not
      -- take the record of the work it did with it.
      ALTER TABLE agent_runs ADD COLUMN parent_session_id TEXT;
      ALTER TABLE agent_runs ADD COLUMN subagent_id TEXT;

      CREATE INDEX agent_runs_parent_session ON agent_runs(parent_session_id);
    `,
  },
  {
    name: "082_agent_runs_brief",
    sql: `
      -- THE BRIEF AS IT WAS TYPED, before anything was put in front of it.
      --
      -- A dispatch hands the executor ONE field — goals, then the owner's
      -- standing instructions, then the brief, joined into the kind's
      -- free-text input — because the worker reads one document and must see
      -- all three. But the worker's own page draws a conversation: the owner's
      -- words on the right, the report on the left. Drawing the joined field
      -- there would put the owner's standing instructions into every message
      -- they ever sent, and stripping the preface back off at read time would
      -- be guessing, because the instructions may have changed since.
      --
      -- NULL on every run that was not dispatched: a run started from an app
      -- page had a form, not a brief, and the page draws the form's own field
      -- for those and says so.
      ALTER TABLE agent_runs ADD COLUMN brief TEXT;
    `,
  },
  {
    name: "486_subagents_retire_producer_campaigns",
    sql: `
      -- THE VIDEO PRODUCER AND THE CAMPAIGN PLANNER ARE NO LONGER ROLES.
      --
      -- \`ensureTeam\` provisions what is in \`ROLES\` and prunes rows whose
      -- VENTURE is gone; it has never pruned rows whose ROLE is gone, and it
      -- should not — see \`shapeSubagent\`, which shapes such a row rather than
      -- hiding it precisely so a hand-edited database does not lose the
      -- owner's words without anybody being told. That leniency is right for
      -- an accident and wrong for a decision. A role retired in a release
      -- leaves one row per venture behind, and on this box that was
      -- forty-eight workers the org chart still drew, the roster still paged
      -- through and a dispatch by id still reached — a staff nobody could
      -- explain and every agent reading the org had to read past.
      --
      -- SO THE DELETION IS A MIGRATION AND NOT A RULE. It names the two roles
      -- and runs once, which is the difference between retiring a role and
      -- teaching the roster to forget any role it does not recognise. The
      -- second would quietly bin the owner's standing instructions on the day
      -- somebody made a typo in \`ROLES\`.
      --
      -- THE RUNS STAY, all of them. \`agent_runs\` has no foreign key here for
      -- exactly this case (see 081): the work these workers did is attributed
      -- by kind and venture, so every video and every campaign still has its
      -- report, its page and its place in the ledger. \`subagent_id\` on the
      -- runs they were dispatched for now points at a row that is gone, which
      -- is what that column has always meant when a worker is pruned.
      DELETE FROM subagents WHERE role IN ('producer', 'campaigns');
    `,
  },
  {
    name: "487_subagents_default_names",
    sql: `
      -- TWO CORRECTIONS TO NAMES THE OWNER NEVER TYPED.
      --
      -- A worker's name is "<Venture> <Suffix>" at provisioning, and the org
      -- chart takes the venture's name off the front WHEN IT MATCHES so a card
      -- headed "ScallopBot" does not say ScallopBot eight more times. Both
      -- statements below touch only rows still carrying a DEFAULT name; a name
      -- the owner changed is theirs and is not matched.
      --
      -- 1. THE VENTURE WAS RENAMED AFTER ITS TEAM WAS MADE. ScallopBot's rows
      --    were provisioned as "Scallopbot Researcher" and the venture is now
      --    spelled "ScallopBot", so the strip missed and that one card drew
      --    the venture's name on every row while the other twenty-three did
      --    not. The prefix is re-cased to the venture's current spelling
      --    wherever it matches ignoring case. (The client strips
      --    case-insensitively now too, so this cannot recur on the chart; the
      --    row is fixed as well so the roster and the chat say the same name.)
      --
      -- 2. THE PAPER WRITER IS THE DISCOVERY SCIENTIST. Rows still named
      --    "<Venture> Paper Writer" with the default title take the new
      --    default; the role id is unchanged and so is every worker's id.
      UPDATE subagents
         SET name = (SELECT v.name FROM ventures v WHERE v.id = subagents.venture_id)
                 || substr(name, length((SELECT v.name FROM ventures v WHERE v.id = subagents.venture_id)) + 1)
       WHERE venture_id <> ''
         AND EXISTS (SELECT 1 FROM ventures v WHERE v.id = subagents.venture_id)
         AND lower(substr(name, 1, length((SELECT v.name FROM ventures v WHERE v.id = subagents.venture_id)) + 1))
             = lower((SELECT v.name FROM ventures v WHERE v.id = subagents.venture_id) || ' ')
         AND substr(name, 1, length((SELECT v.name FROM ventures v WHERE v.id = subagents.venture_id)))
             <> (SELECT v.name FROM ventures v WHERE v.id = subagents.venture_id);

      UPDATE subagents
         SET name = substr(name, 1, length(name) - length('Paper Writer')) || 'Discovery Scientist'
       WHERE role = 'writer' AND name LIKE '% Paper Writer';

      UPDATE subagents
         SET title = 'Discovery scientist'
       WHERE role = 'writer' AND title = 'Academic paper writer';
    `,
  },
];
