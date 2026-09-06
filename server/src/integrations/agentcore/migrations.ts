/**
 * AGENTCORE'S TABLES — one, and it is the record that a chat turn is the
 * SERVER'S work rather than the browser's.
 *
 * `chat_runs` is deliberately not a copy of the answer. The words live where
 * they always did, in `chat_messages`; what is kept here is the fact that a
 * turn was started, by which conversation, when, and how it ended — which is
 * exactly the set of facts a page that was closed mid-answer needs in order to
 * decide whether to reattach, and the set a restarted process needs in order
 * to stop claiming that a run it no longer has is still running.
 *
 * THE EVENTS ARE NOT IN HERE, and that is a decision rather than an omission.
 * A reasoning model emits thousands of deltas per turn; writing each one to
 * SQLite would put a synchronous disk write in the path of every token for the
 * sake of a replay window measured in minutes. The buffer is in memory, the
 * row is on disk, and the two answer different questions: "what is still
 * arriving" and "did this turn ever finish".
 *
 * No imports — see integrations/manifest.ts. Idempotent, because a migration
 * that has run must be safe to read again on a box restored from a backup.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "200_chat_jobs",
    sql: `
      CREATE TABLE IF NOT EXISTS chat_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        channel TEXT NOT NULL,
        venture_id TEXT,
        backend TEXT,
        user_message_id INTEGER,
        assistant_message_id INTEGER,
        error TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS chat_runs_session ON chat_runs(session_id, started_at);
      CREATE INDEX IF NOT EXISTS chat_runs_status ON chat_runs(status);
    `,
  },
];
