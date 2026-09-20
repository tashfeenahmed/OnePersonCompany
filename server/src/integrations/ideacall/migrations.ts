/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "488_idea_call_turns",
    sql: `
      -- THE IDEA CALL'S OWN TRANSCRIPT, one continuing conversation per venture.
      --
      -- Not chat_messages: that table is the Chief of Staff's, its sessions are
      -- named after the first thing said and listed in the rail, and a call
      -- that refines one idea is neither of those things. Hanging up and
      -- calling back tomorrow has to find the same conversation, which is a
      -- key on the VENTURE and not on a session somebody has to remember.
      --
      -- research is what the assistant LOOKED UP during that turn, digested.
      -- It is never shown and never spoken; it is there so the next turn, and
      -- the next call, still know what the search said without paying for it
      -- again.
      CREATE TABLE IF NOT EXISTS idea_call_turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        ts         TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content    TEXT NOT NULL,
        research   TEXT
      );
      CREATE INDEX IF NOT EXISTS idea_call_turns_venture ON idea_call_turns(venture_id, id);
    `,
  },
];
