/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "170_security_owner",
    sql: `
      -- ONE OWNER, ONE PASSWORD, OR NO ROW AT ALL.
      --
      -- The absence of a row is the OFF switch and it is the whole design of
      -- this feature: with no row here the gate in front of /api does nothing
      -- whatsoever, which is what the box has always done and what it keeps
      -- doing for anybody who never opens the Security tab. A boolean column
      -- called "enabled" was the alternative and it is worse: it would be a
      -- second place the answer lives, and the two can disagree.
      --
      -- \`id\` IS PINNED TO 1. This is not a users table and must never quietly
      -- become one. A dashboard with two logins would need per-user scoping on
      -- every route on this box, and there is none — so the CHECK makes the
      -- second INSERT fail loudly rather than let a half-built multi-user
      -- system exist.
      --
      -- scrypt, from node:crypto, with a per-owner random salt. Not because a
      -- LAN dashboard is a high-value target, but because the hash sits in a
      -- database file that the nightly backup copies to wherever the owner
      -- pointed it, and a fast hash there is a password recovered from a NAS.
      CREATE TABLE IF NOT EXISTS security_owner (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        -- scrypt(password, salt, 64), hex. The parameters are in code, not
        -- here: a stored cost that no longer matches the code is how a hash
        -- becomes unverifiable.
        hash        TEXT NOT NULL,
        salt        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        -- When the password last CHANGED. Distinct from created_at so "set in
        -- March, changed last night" is answerable.
        updated_at  TEXT NOT NULL
      );
    `,
  },

  {
    name: "171_security_sessions",
    sql: `
      -- A BROWSER THAT LOGGED IN, until it is revoked.
      --
      -- The id IS the cookie value — thirty-two random bytes as hex — rather
      -- than a serial with a signed token over it. There is no second secret
      -- to keep in step that way, revoking is a row update, and an id nobody
      -- can guess is exactly as unguessable as a signature nobody can forge.
      --
      -- \`revoked_at\` RATHER THAN A DELETE. "This laptop was signed out at
      -- 14:02" is a fact the owner may want to see once; a deleted row is a
      -- session that simply never existed. Rows are small and there are as many
      -- of them as there are browsers.
      --
      -- \`user_agent\` IS THE ONLY THING RECORDED ABOUT THE CLIENT. No IP: every
      -- request here arrives from 127.0.0.1 or from the LAN address of a
      -- machine the owner is holding, so an address column would be a column
      -- of noise. The user agent is what makes "the phone" tell itself apart
      -- from "the laptop" in the revoke list.
      CREATE TABLE IF NOT EXISTS security_sessions (
        id           TEXT PRIMARY KEY,
        created_at   TEXT NOT NULL,
        -- Touched at most once a minute — see owner.ts. A column written on
        -- every request would be a write per API call for a figure whose whole
        -- purpose is to say "this session is still in use".
        last_seen_at TEXT NOT NULL,
        user_agent   TEXT,
        revoked_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS security_sessions_live
        ON security_sessions(revoked_at, last_seen_at DESC);
    `,
  },

  {
    name: "172_security_snapshots",
    sql: `
      -- WHAT A BOX WAS DOING AT THE MOMENT IT MATTERED.
      --
      -- This is the opposite table from fleet_samples next door. That one is a
      -- TREND: a dozen numbers per box every half hour, kept for a month, read
      -- as a line. This is an INSTANT: everything a shell can say about a
      -- machine at one moment, taken when something went wrong, kept as the
      -- document it was. A snapshot answers "what was eating the CPU at 03:12"
      -- and it is the only thing here that can, because no schedule samples
      -- process lists — sixty processes per box per half hour is a million rows
      -- a month to answer a question asked twice a year.
      --
      -- SO THE PAYLOAD IS ONE JSON COLUMN. Processes, listening ports, an
      -- established-connection count, filesystems, the tail of the journal and
      -- docker ps have six different shapes and are never queried apart from
      -- each other: a snapshot is read whole, by a person looking at one
      -- moment. Six tables would buy joins nobody makes.
      --
      -- \`host\` IS THE FLEET ACCOUNT'S LABEL, and \`account_id\` beside it is the
      -- key that survives a rename. Both, because the label is what a person
      -- asks for ("snapshot the Pi") and the id is what is true.
      --
      -- \`reason\` IS FREE TEXT AND ALWAYS SAYS WHO ASKED. "asked for from the
      -- page" and "uptime: acme.ie answered 502 at 03:11" are the two that
      -- exist today; a snapshot with no reason would be a document nobody can
      -- date to an event.
      CREATE TABLE IF NOT EXISTS security_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id  INTEGER NOT NULL,
        host        TEXT NOT NULL,
        ts          TEXT NOT NULL,
        reason      TEXT NOT NULL,
        -- The whole capture as JSON. NULL is impossible: a capture that failed
        -- stores a document whose sections are null with the ssh error on it,
        -- because "the box would not answer at 03:12" is itself the answer.
        doc         TEXT NOT NULL,
        -- Bytes of that JSON, so a list can say how big a snapshot is without
        -- reading one.
        size        INTEGER NOT NULL,
        ok          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS security_snapshots_host
        ON security_snapshots(account_id, ts DESC);
      CREATE INDEX IF NOT EXISTS security_snapshots_ts
        ON security_snapshots(ts DESC);
    `,
  },

  {
    name: "173_security_shotsqa",
    sql: `
      -- ONE VENTURE'S SCREENSHOT, JUDGED — one row per venture per QA run.
      --
      -- The checks are heuristic and the row says so per check rather than in
      -- one verdict: \`blank\` can be true, false, or NULL meaning the picture
      -- could not be decoded far enough to tell. A schema with a single
      -- "passed" column would have to turn "not checked" into "passed", which
      -- is the exact lie this app is built to refuse.
      --
      -- \`checks\` IS THE JSON OF EVERY CHECK WITH ITS OWN VERDICT AND REASON.
      -- The columns beside it are only the two things a list wants without
      -- opening a document: how many checks failed, and how many could not be
      -- run at all.
      CREATE TABLE IF NOT EXISTS security_shotsqa (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id      TEXT NOT NULL,
        ts          TEXT NOT NULL,
        venture_id  TEXT NOT NULL,
        venture     TEXT NOT NULL,
        -- The capture this judged, and when it was taken. NULL shot_ts means
        -- there has never been a capture — which is a finding, not a failure.
        shot_ts     TEXT,
        shot_path   TEXT,
        age_days    REAL,
        width       INTEGER,
        height      INTEGER,
        bytes       INTEGER,
        failed      INTEGER NOT NULL,
        unchecked   INTEGER NOT NULL,
        checks      TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS security_shotsqa_run
        ON security_shotsqa(run_id);
      CREATE INDEX IF NOT EXISTS security_shotsqa_venture
        ON security_shotsqa(venture_id, ts DESC);
    `,
  },

  {
    name: "174_workstation_state",
    sql: `
      -- WHETHER THE DESK MACHINE WAS THERE, once per collection.
      --
      -- One account is one machine, exactly as fleet's is, and this table is
      -- deliberately thinner than fleet_samples: the question a workstation is
      -- asked is "is it awake", not "how loaded is it". A row per cycle with a
      -- reachability flag is what makes "it has been asleep since Friday"
      -- answerable, and it is the only history this plugin keeps.
      --
      -- \`gpu\` IS JSON OR NULL, AND NULL IS NEVER "no GPU". It is "nvidia-smi
      -- did not answer" — because the machine was asleep, because it has no
      -- NVIDIA card, or because the tool is not installed — and the reason is
      -- in \`gpu_note\`. A dashboard that drew 0 GPUs for a sleeping box would
      -- be reporting a fact about ssh as a fact about hardware.
      CREATE TABLE IF NOT EXISTS workstation_state (
        account_id  INTEGER NOT NULL,
        ts          TEXT NOT NULL,
        reachable   INTEGER NOT NULL,
        uptime_s    INTEGER,
        gpu         TEXT,
        gpu_note    TEXT,
        error       TEXT,
        PRIMARY KEY (account_id, ts)
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS workstation_state_ts
        ON workstation_state(ts DESC);
    `,
  },
  {
    name: "175_session_tokens",
    sql: `ALTER TABLE security_sessions ADD COLUMN token_hash TEXT;
          UPDATE security_sessions SET revoked_at = COALESCE(revoked_at, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
          CREATE UNIQUE INDEX security_session_tokens ON security_sessions(token_hash);`,
  },
];
