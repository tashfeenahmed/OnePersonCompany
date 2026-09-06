/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "280_nurture_send_identities",
    sql: `
      -- WHO A MESSAGE CLAIMS TO BE FROM, and which transport is entitled to
      -- make that claim.
      --
      -- Until now the outbox had exactly one answer: the Gmail mailbox, whose
      -- address Google itself reported to the collector. That is honest and it
      -- is also the wrong return address for a product email — a note about
      -- Example App 4 arriving from a personal gmail.com address is a note that
      -- looks like a stranger wrote it, and the recipient's client has no way
      -- to tell it apart from one.
      --
      -- So an identity is a row, and the row says which transport owns it:
      --
      --   kind = 'gmail'   -> account_id is a GMAIL plugin account, and the
      --                      address must be that mailbox's OWN address.
      --                      Gmail refuses any other From, later and less
      --                      clearly than this table does.
      --   kind = 'resend'  -> account_id is a RESEND plugin account, one key
      --                      per sending domain, and the address's domain must
      --                      be a domain that key can see.
      --
      -- verified/verified_at/verify_note ARE A READING OF RESEND'S OWN ANSWER
      -- and never a judgement made here. 'verified' holds Resend's word —
      -- "verified", "pending", "failed", "temporary_failure" — because
      -- "pending" is not "failed" and a boolean would lose the difference.
      -- NULL means nobody has asked yet, which is not "unverified".
      --
      -- A gmail identity has no Resend status and never will; its verified
      -- column stays NULL and the routes say "Gmail's own mailbox" instead of
      -- inventing a status to fill a column.
      CREATE TABLE IF NOT EXISTS nurture_send_identities (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        -- The venture this identity belongs to, or NULL for one that belongs
        -- to no particular business. A venture may have several; exactly one
        -- of them may be its default.
        venture      TEXT,
        kind         TEXT    NOT NULL,
        -- The display name on the From line — "Example App 4". Empty for none, in
        -- which case the address stands alone.
        from_name    TEXT    NOT NULL DEFAULT '',
        -- Lower-cased. UNIQUE because two rows claiming one address is two
        -- answers to "which transport sends as this", and the wrong one lands
        -- in spam.
        from_address TEXT    NOT NULL,
        reply_to     TEXT,
        -- The plugin account: gmail's or resend's, per 'kind'.
        account_id   INTEGER NOT NULL,
        -- The venture default. Enforced in code rather than by a partial index
        -- so that clearing one and setting another is one transaction with a
        -- readable failure.
        is_default   INTEGER NOT NULL DEFAULT 0,
        verified     TEXT,
        verified_at  TEXT,
        verify_note  TEXT,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS nurture_identities_address
        ON nurture_send_identities(from_address);
      CREATE INDEX IF NOT EXISTS nurture_identities_venture
        ON nurture_send_identities(venture, is_default);
    `,
  },

  {
    name: "281_nurture_sequences",
    sql: `
      -- A SEQUENCE IS A PLAN FOR WRITING, NEVER A PLAN FOR SENDING.
      --
      -- Every step this table describes becomes a DRAFT in mailflow_outbox and
      -- stops there. The engine that reads this table (integrations/nurture/
      -- sequences.ts) has no import of the send and no path to one; the outbox
      -- keeps its own guarantee that only the owner's approve route writes
      -- 'approved'. "Automated nurture" here means the writing is automated
      -- and the sending never is.
      --
      -- 'enabled' DEFAULTS TO 0. A sequence that started enrolling people the
      -- moment it was typed would draft its first step before anybody had read
      -- the steps.
      --
      -- steps IS JSON: [{ "dayOffset": 0, "purpose": "...", "hint": "..." }]
      --   dayOffset — days after ENROLMENT, not after the previous step, so a
      --               step inserted in the middle does not shift the rest.
      --   purpose   — one sentence, given to the wording model as the brief.
      --   hint      — optional wording hint. Neither may carry a fact: the
      --               facts come from the fact packet and are validated.
      --
      -- enrol_kind IS ONE OF signup | trial | churned | manual, and the first
      -- three are answerable ONLY where the product publishes its users
      -- document (the 'users' plugin). With no such document those three
      -- sequences enrol nobody and say so — they do not fall back to guessing
      -- from mail headers, because "this address wrote to me" is not "this
      -- person signed up".
      --
      -- enrol_filter IS JSON and every key is optional:
      --   { "withinDays": 30, "product": "<users account label>",
      --     "plan": "trial", "domain": "example.com", "quietDays": 60 }
      --
      -- stop_on IS JSON, a subset of ["replied","purchased","dismissed",
      -- "unsubscribed"]. A sequence with an empty list still stops at its last
      -- step; there is no sequence that runs forever.
      CREATE TABLE IF NOT EXISTS nurture_sequences (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        venture      TEXT,
        name         TEXT    NOT NULL,
        enabled      INTEGER NOT NULL DEFAULT 0,
        steps        TEXT    NOT NULL DEFAULT '[]',
        enrol_kind   TEXT    NOT NULL DEFAULT 'manual',
        enrol_filter TEXT    NOT NULL DEFAULT '{}',
        stop_on      TEXT    NOT NULL DEFAULT '["replied","purchased","dismissed","unsubscribed"]',
        -- How many drafts this ONE sequence may put in the queue in a day. It
        -- is a reading-load limit, not a sending limit: the outbox's own daily
        -- cap is what governs how much mail can actually leave, and it is
        -- unchanged by anything in this area.
        daily_cap    INTEGER NOT NULL DEFAULT 5,
        -- The identity every draft of this sequence is written from. NULL
        -- means "the venture's default identity at drafting time".
        identity_id  INTEGER,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS nurture_sequences_enabled
        ON nurture_sequences(enabled, venture);
    `,
  },

  {
    name: "282_nurture_enrollments",
    sql: `
      -- ONE PERSON'S PROGRESS THROUGH ONE SEQUENCE.
      --
      -- The row is never deleted. A stopped enrolment is the record of a
      -- decision — they replied, they bought, the owner dismissed a draft, they
      -- asked to be left alone — and deleting it would lose both the decision
      -- and the reason, which is the one thing anybody asks this table later.
      --
      -- status: active | stopped | done.
      --   done    — every step was drafted. Not a judgement about whether any
      --             of them was ever sent; that lives in mailflow_outbox.
      --   stopped — stop_reason says which condition fired, in words.
      --
      -- next_due IS DERIVED AND STORED so the daily pass can select without
      -- re-deriving every sequence's step list, and it is RECOMPUTED from
      -- enrolled_at + the step's dayOffset on every pass — a step edited after
      -- somebody was enrolled must move their date, not be ignored.
      --
      -- history IS JSON: an append-only list of
      --   { "at": ISO, "what": "...", "outboxId": n|null }
      -- capped in code. It is what the page shows when the owner asks why a
      -- person is where they are.
      CREATE TABLE IF NOT EXISTS nurture_enrollments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence_id   INTEGER NOT NULL,
        -- Lower-cased. The address is real and stored, unlike activity_users'
        -- hashes, because you cannot write to a hash. It is the same class of
        -- data people_contacts already holds.
        address       TEXT    NOT NULL,
        -- The display name as people_contacts last saw it, or ''. A label
        -- somebody typed about themselves, never derived from the address.
        name          TEXT    NOT NULL DEFAULT '',
        venture       TEXT,
        -- How many steps have been DRAFTED. 0 = nothing written yet.
        step          INTEGER NOT NULL DEFAULT 0,
        next_due      TEXT,
        status        TEXT    NOT NULL DEFAULT 'active',
        stop_reason   TEXT,
        -- Why the pass could not answer a stop condition this time — "Gmail
        -- refused the reply check". A blocked enrolment DRAFTS NOTHING: it
        -- holds where it is and says so, because writing a fourth note to
        -- somebody who may have replied is the failure this table exists to
        -- avoid.
        blocked       TEXT,
        enrolled_at   TEXT    NOT NULL,
        stopped_at    TEXT,
        last_draft_at TEXT,
        history       TEXT    NOT NULL DEFAULT '[]'
      );

      CREATE UNIQUE INDEX IF NOT EXISTS nurture_enrollments_one
        ON nurture_enrollments(sequence_id, address);
      CREATE INDEX IF NOT EXISTS nurture_enrollments_due
        ON nurture_enrollments(status, next_due);

      -- ADDRESSES THAT ARE NEVER WRITTEN TO AGAIN, by any sequence, ever.
      --
      -- Separate from the enrolments because it outlives them: a person who
      -- asked to be left alone must still be left alone by a sequence written
      -- next year, and a per-enrolment flag could not say that. It is checked
      -- before enrolment and again before every draft.
      CREATE TABLE IF NOT EXISTS nurture_optouts (
        address TEXT PRIMARY KEY,
        reason  TEXT,
        at      TEXT NOT NULL
      ) WITHOUT ROWID;

      -- ONE ROW PER DAY THE PASS RAN. The primary key is the local calendar
      -- day, which is the whole of the "once a day" guarantee: a second call
      -- on the same day replaces the row rather than drafting a second round.
      CREATE TABLE IF NOT EXISTS nurture_passes (
        day       TEXT NOT NULL PRIMARY KEY,
        ran_at    TEXT NOT NULL,
        ok        INTEGER NOT NULL,
        enrolled  INTEGER NOT NULL DEFAULT 0,
        drafted   INTEGER NOT NULL DEFAULT 0,
        stopped   INTEGER NOT NULL DEFAULT 0,
        -- JSON: [{ "address": "...", "why": "..." }]. Why a due step did NOT
        -- become a draft, which is the question the page is actually asked.
        skipped   TEXT NOT NULL DEFAULT '[]',
        trigger   TEXT NOT NULL DEFAULT 'timer',
        error     TEXT
      ) WITHOUT ROWID;
    `,
  },

  {
    name: "283_nurture_style",
    sql: `
      -- WHAT THE OWNER'S EDITS TEACH, AND THE FENCE AROUND IT.
      --
      -- The only real evidence about how somebody writes is what they do to a
      -- draft before approving it: every deletion is a sentence they would not
      -- have sent and every rewrite is the sentence they would. This table
      -- keeps those pairs; the rules table below keeps what was read out of
      -- them.
      --
      -- OPT-IN. Nothing is written here unless the 'style-learning' setting is
      -- switched on, and "forget" empties both tables. The pairs quote whole
      -- email bodies — the machine's and the owner's — so they are never
      -- published by a route; the rules and the COUNT of pairs are.
      --
      -- A DISMISSED DRAFT TEACHES NOTHING, on purpose. A dismissal is "not this
      -- person, not now" — a judgement about whether to write at all — and
      -- reading it as a verdict on the prose would learn the wrong lesson from
      -- the one signal here that is definitely not about wording.
      CREATE TABLE IF NOT EXISTS nurture_edits (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        -- One pair per outbox row, ever. Approving a failed send again retries
        -- the transport; it does not teach the same lesson twice.
        outbox_id  INTEGER NOT NULL UNIQUE,
        venture    TEXT,
        before     TEXT    NOT NULL,
        after      TEXT    NOT NULL,
        at         TEXT    NOT NULL
      );

      -- THE RULES, WHICH ARE STYLE AND ONLY STYLE.
      --
      -- Each is one short imperative line about wording — the greeting, the
      -- sign-off, sentence length, punctuation, what gets cut. A rule carrying
      -- a digit, an address, a link, a domain or a person's name is REFUSED
      -- rather than stripped, because a sanitised rule is a rule nobody wrote.
      --
      -- AND EVEN A RULE THAT GOT THROUGH COULD NOT PUT A FACT IN AN EMAIL: the
      -- validator still reads every finished body against the fact packet
      -- afterwards, exactly as it does when there are no rules at all. The
      -- rules move words; the facts remain the only things that can be said.
      CREATE TABLE IF NOT EXISTS nurture_style_rules (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        rule       TEXT    NOT NULL,
        -- JSON list of nurture_edits ids this rule was read out of. The
        -- evidence, so a rule the owner disagrees with can be traced to the
        -- edits that produced it.
        evidence   TEXT    NOT NULL DEFAULT '[]',
        -- Whether the owner typed it himself. An owner's rule survives a
        -- re-derivation; a derived one is replaced by it.
        by_owner   INTEGER NOT NULL DEFAULT 0,
        model      TEXT,
        derived_at TEXT    NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1
      );

      -- Refusals are KEPT and shown, because a gate nobody can see working is
      -- a gate nobody can tell is broken.
      CREATE TABLE IF NOT EXISTS nurture_style_refusals (
        id   INTEGER PRIMARY KEY AUTOINCREMENT,
        rule TEXT NOT NULL,
        why  TEXT NOT NULL,
        at   TEXT NOT NULL
      );
    `,
  },

  {
    name: "284_outbox_plan_facts_identity",
    sql: `
      -- THE OUTBOX ROW GROWS THE DOCUMENTS THAT JUSTIFY IT.
      --
      -- A draft used to be a subject and a body. Those two are what the owner
      -- reads, and they are exactly what he cannot check: a figure in an email
      -- is a promise made in his name, and a body alone gives him nothing to
      -- check it against. So the row now carries the PLAN (who, why now, which
      -- venture, which identity — decided by plain code, never by a model), the
      -- FACT PACKET (every fact the wording was allowed to use, each with its
      -- source and when it was observed) and the VALIDATION (whether the
      -- model's wording passed the fact check, and the sentence saying what it
      -- invented if it did not).
      --
      -- generated_body IS WHAT THE MACHINE WROTE, before any editing. It is the
      -- "before" of a style pair and nothing else reads it; NULL on a draft the
      -- owner typed himself, which is why an owner-written draft teaches the
      -- style learner nothing.
      ALTER TABLE mailflow_outbox ADD COLUMN plan TEXT;
      ALTER TABLE mailflow_outbox ADD COLUMN facts TEXT;
      ALTER TABLE mailflow_outbox ADD COLUMN validation TEXT;
      ALTER TABLE mailflow_outbox ADD COLUMN generated_body TEXT;
      -- The identity this is sent AS. NULL keeps the original behaviour
      -- exactly: the Gmail account named by account_id, from the address Gmail
      -- itself reported. Every row that existed before this migration is NULL,
      -- so nothing about an old draft changed.
      ALTER TABLE mailflow_outbox ADD COLUMN identity_id INTEGER;
      -- gmail | resend. Written at SEND time from the identity that was
      -- actually used, so a row says which door its copy left by rather than
      -- which door it would leave by if it were sent now.
      ALTER TABLE mailflow_outbox ADD COLUMN sent_via TEXT;
      -- Resend's own last_event for the sent copy — "delivered", "bounced",
      -- "complained" — read back after the send. NULL means not read (or a
      -- Gmail send, which has no such reading); it never means "not
      -- delivered".
      ALTER TABLE mailflow_outbox ADD COLUMN delivery_event TEXT;
      ALTER TABLE mailflow_outbox ADD COLUMN delivery_read_at TEXT;
      -- Which sequence step wrote this, for the stop cascade: stopping a
      -- sequence must also take its outstanding drafts out of the queue, and
      -- without this column there is no way to find them.
      ALTER TABLE mailflow_outbox ADD COLUMN sequence_id INTEGER;
      ALTER TABLE mailflow_outbox ADD COLUMN sequence_step INTEGER;

      -- The approval snapshot's shape changed (it now names the identity and
      -- the transport), so an approval made against the old shape can no
      -- longer be compared with the new one. Rather than let that surface as
      -- "the message or signature changed" at send time, every approved row
      -- goes back to draft here — towards the state where a person presses the
      -- button. 122_outbox_delivery did the same thing for the same reason.
      UPDATE mailflow_outbox SET status = 'draft', approved_at = NULL, approved_content = NULL
        WHERE status = 'approved';

      CREATE INDEX IF NOT EXISTS mailflow_outbox_sequence
        ON mailflow_outbox(sequence_id, sequence_step);
    `,
  },
];
