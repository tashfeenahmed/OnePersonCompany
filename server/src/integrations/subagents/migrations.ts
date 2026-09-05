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
];
