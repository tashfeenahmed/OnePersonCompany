/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    /*
      THE JOURNAL — the work that happened off this box.

      EVERY OTHER TABLE HERE IS A READING OF A MACHINE. Stripe days, Search
      Console rows, board cards, agent runs, GitHub pushes: all of them exist
      because a collector could see them. The half of a one-person company that
      nothing on this box can see is the half a person did with their hands —
      a call taken, a landing page rewritten in a text editor, a post put on a
      forum that has no API, a decision made in the shower and acted on. None
      of it leaves a row anywhere, so three months later the operating history
      says the business did nothing that week, which is false.

      SO THIS TABLE IS TYPED IN, AND THAT IS ITS ENTIRE PROVENANCE. `source`
      says which door the sentence came in by — the Journal page, a Telegram
      `/did`, or the agent filing something the owner told it — and none of
      those three is a measurement. Nothing in here may ever be presented as
      evidence of an effect; it is evidence that an ACTION was taken, on a day,
      by a person. What happened afterwards is the outcomes table's question,
      which is why `outcome_id` is a column and not a duplicate of the readings.

      `at` IS A DATE AND NOT AN INSTANT, deliberately. "I shipped the new
      pricing page" is a fact about a day; asking somebody to pick a minute
      would make them either lie or not log it. `created_at` keeps the instant
      the row was written, so a back-dated entry is visibly back-dated and the
      streak below cannot be gamed without it showing.

      `venture_id` IS NULLABLE because plenty of a founder's work belongs to no
      venture — an accountant, a tax return, a conference. A NOT NULL column
      would have forced those into whichever venture was nearest, which is a
      worse record than no venture at all.

      `result` IS THE OWNER'S OWN SENTENCE ABOUT WHAT CAME OF IT and it is
      never computed. It is written later, usually days later, and a row with
      `result` null means nobody has said — not that nothing happened.
    */
    name: "350_journal_entries",
    sql: `
      CREATE TABLE IF NOT EXISTS journal_entries (
        id          TEXT PRIMARY KEY,
        venture_id  TEXT,
        kind        TEXT NOT NULL,
        text        TEXT NOT NULL,
        url         TEXT,
        at          TEXT NOT NULL,
        result      TEXT,
        outcome_id  TEXT,
        source      TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS journal_entries_at ON journal_entries(at DESC);
      CREATE INDEX IF NOT EXISTS journal_entries_venture ON journal_entries(venture_id, at DESC);
      CREATE INDEX IF NOT EXISTS journal_entries_kind ON journal_entries(kind, at DESC);
    `,
  },
];
