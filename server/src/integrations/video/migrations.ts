/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "160_video_jobs",
    sql: `
      -- ONE ROW PER FINISHED VIDEO, AND THE RUN IS ITS IDENTITY.
      --
      -- A video is made by a run — minutes of downloading, cutting and
      -- encoding — so everything about when it started, who asked, whether it
      -- worked and what it said while working already lives in agent_runs.
      -- What does NOT live there is the artefact: a path on this disk, how
      -- long it plays, how big it is, the script the model wrote and the
      -- footage that was used with the licence and the author of each piece.
      -- That is this table, and it hangs off the run by primary key rather
      -- than by a foreign one, on the same argument routes/board.ts makes: a
      -- run deleted takes its video row with it (the executor's deleteRun
      -- does that explicitly), but a venture deleted does not un-make a file.
      --
      -- \`assets\` IS THE ATTRIBUTION AND IT IS NOT DECORATION. Every clip in a
      -- faceless video came from a stock library under a licence that asks for
      -- the photographer to be named. The manifest is written at the moment
      -- the file is fetched — id, page url, author, author url, licence,
      -- dimensions, the search term that found it — because that is the only
      -- moment those facts are known, and a video whose sources cannot be
      -- named is a video nobody can publish.
      --
      -- \`captions\` AND \`narration\` RECORD WHICH MACHINE DID IT, for papers.ts's
      -- reason: a video with typeset caption cards and a video with no captions
      -- at all are different products, and a page that drew them identically
      -- would be claiming something this box did not do. The values are the
      -- renderer's own name — \`typst\`, \`drawtext\`, \`none\` — and \`none\` always
      -- comes with a sentence in the run's report saying why.
      --
      -- NOTHING HERE IS A METRIC. There is no view count, no watch time and no
      -- engagement, because nothing on this box publishes a video anywhere:
      -- the file is made, it lands on the run page, and the owner takes it.
      CREATE TABLE IF NOT EXISTS video_jobs (
        run_id      TEXT PRIMARY KEY,
        venture_id  TEXT,
        format      TEXT NOT NULL,
        ts          TEXT NOT NULL,
        aspect      TEXT NOT NULL DEFAULT '9:16',
        width       INTEGER,
        height      INTEGER,
        script      TEXT NOT NULL DEFAULT '{}',
        assets      TEXT NOT NULL DEFAULT '[]',
        duration_s  REAL,
        bytes       INTEGER,
        path        TEXT,
        captions    TEXT,
        narration   TEXT,
        transcript  TEXT,
        error       TEXT
      );
      CREATE INDEX IF NOT EXISTS video_jobs_venture ON video_jobs (venture_id, ts DESC);
    `,
  },
  {
    name: "161_video_clips",
    sql: `
      -- ONE ROW PER CLIP CUT OUT OF A LONG VIDEO.
      --
      -- A shorts job produces two to four separate files and each of them is a
      -- thing the owner will post on its own, so each gets a row: where in the
      -- source it came from, why the model chose that window, and where the
      -- file is. A JSON array on video_jobs would have been fewer tables and
      -- would have made "show me every clip cut this month" a scan of parsed
      -- blobs.
      --
      -- \`reason\` IS THE MODEL'S, QUOTED. It is not a score and it is not a
      -- prediction of how a clip will perform — nothing here measures that —
      -- it is the sentence the model gave for choosing this window, kept so
      -- the owner can disagree with it.
      --
      -- \`chosen_by\` IS THE HONESTY COLUMN. \`transcript\` means the windows were
      -- picked out of words that were actually said. \`spacing\` means there was
      -- no transcript and the source was cut at even intervals, which is not
      -- highlight selection and must never be drawn as though it were.
      CREATE TABLE IF NOT EXISTS video_clips (
        run_id     TEXT NOT NULL,
        idx        INTEGER NOT NULL,
        title      TEXT NOT NULL,
        reason     TEXT,
        chosen_by  TEXT NOT NULL,
        start_s    REAL NOT NULL,
        end_s      REAL NOT NULL,
        duration_s REAL,
        path       TEXT,
        bytes      INTEGER,
        captions   TEXT,
        PRIMARY KEY (run_id, idx)
      );
    `,
  },
  {
    name: "162_video_autopilot_log",
    sql: `
      -- WHAT THE AUTOPILOT DID, EVERY TIME IT WOKE.
      --
      -- The autopilot queues work on a clock and nobody is watching when it
      -- does. So every decision it takes is written down here, including the
      -- decisions to do NOTHING — a venture skipped for its stage, a cadence
      -- already met this week, a day's cap already spent. A log that only held
      -- the successes would answer "why is there no video for Example App 1" with
      -- silence, and silence is the one answer that sends somebody looking for
      -- a bug in a feature that is working exactly as configured.
      --
      -- \`action\` IS ONE OF queued | skipped | failed, and the three are kept
      -- apart on purpose: skipped is a rule being obeyed, failed is something
      -- breaking, and folding them together would turn a correctly quiet week
      -- into an outage.
      --
      -- \`ref\` IS WHATEVER THE ACTION PRODUCED — a run id for a video, a studio
      -- post id for a post, null for a skip. It is not a foreign key: the log
      -- is a record of what happened, and deleting a run does not un-happen the
      -- decision to start it.
      CREATE TABLE IF NOT EXISTS video_autopilot_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        pass_id    TEXT NOT NULL,
        venture_id TEXT,
        kind       TEXT NOT NULL,
        action     TEXT NOT NULL,
        ref        TEXT,
        note       TEXT
      );
      CREATE INDEX IF NOT EXISTS video_autopilot_log_ts ON video_autopilot_log (ts DESC);
      CREATE INDEX IF NOT EXISTS video_autopilot_log_week ON video_autopilot_log (venture_id, kind, action, ts);
    `,
  },
];
