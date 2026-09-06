/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    /*
      THE FACT STORE — what each product actually IS, with the evidence beside
      every sentence.

      Everything else on this box measures a NUMBER or distils MARKETING COPY.
      The venture record holds what the owner typed once; `ventures/enrich.ts`
      reads the palette and the title off the live site; `chief_memory` holds
      dated beliefs about the owner. None of them can answer "does this product
      support webhooks", and a chat agent asked that either says it does not
      know or — the failure this table exists to stop — reasons from the
      marketing page and states a capability the code does not have.

      FOUR TIERS, AND THE ORDER BETWEEN THEM IS THE WHOLE FEATURE:

        owner    — the owner typed it. Nothing overrides it about what the
                   product IS, because it is the one source that is not a
                   reading of something else.
        repo     — read out of the product's own source, with a file and a line
                   number in `source_ref`. A route exists because there is a
                   file at that path.
        measured — derived by code from a connected plugin: three live Stripe
                   prices, an app on Play with N installs. Best evidence there
                   is for a FIGURE and weaker than the repo for a capability,
                   because a configuration is not an implementation.
        proposed — an agent suggested it and nobody has confirmed it. It is NOT
                   knowledge, it is a question, and every surface that renders
                   one must say so.

      `status` RATHER THAN A DELETE. A fact the owner corrected is not gone —
      "the repository said X and the owner says Y" is itself worth keeping, and
      `corrected_by` points at the sentence that replaced it, so the pair can
      be drawn as the disagreement it is. `retired` is a fact that stopped
      being true (a capability removed from the repo, a plugin disconnected).

      `confidence` IS A NUMBER IN A DOCUMENT ABOUT EVIDENCE, so it is derived
      from the tier and the gate that passed rather than guessed: the routes
      never let a caller invent one. See store.ts's CONFIDENCE.

      `refresh_after` IS AN EXPIRY, NOT A DELETION. A repo fact is re-read when
      the repository's HEAD moves or when this date passes, whichever is first;
      a measured fact is rewritten in place on every derive pass. An owner fact
      has NULL here and never expires: the owner does not go stale.

      `fingerprint` IS HOW A RE-READ IS NOT A DUPLICATE. It is the identity of
      the fact rather than its wording — for a measured fact the deriver's key
      ("stripe:products"), for a repo fact a normalisation of the statement —
      so re-running an extraction updates the row's date and commit instead of
      filing the same sentence forty times.
    */
    name: "230_knowledge_facts",
    sql: `
      CREATE TABLE IF NOT EXISTS knowledge_facts (
        id            TEXT PRIMARY KEY,
        venture_id    TEXT NOT NULL,
        kind          TEXT NOT NULL,
        statement     TEXT NOT NULL,
        tier          TEXT NOT NULL,
        source_type   TEXT NOT NULL,
        source_ref    TEXT NOT NULL,
        source_commit TEXT,
        observed_at   TEXT NOT NULL,
        confidence    REAL NOT NULL,
        status        TEXT NOT NULL DEFAULT 'active',
        corrected_by  TEXT,
        created_by    TEXT NOT NULL,
        refresh_after TEXT,
        fingerprint   TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_facts_venture
        ON knowledge_facts(venture_id, status, tier);
      CREATE INDEX IF NOT EXISTS knowledge_facts_kind
        ON knowledge_facts(venture_id, kind, status);
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_facts_identity
        ON knowledge_facts(venture_id, tier, fingerprint)
        WHERE status = 'active';
    `,
  },
  {
    /*
      WHICH REPOSITORY IS THIS VENTURE'S — the per-venture setting the gap
      analysis asked for by name ("map ventures to repositories").

      IT IS A TABLE AND NOT A `plugin_config` KEY because plugin settings are
      one value for the whole box and this is one value per venture. It is also
      not derived from the github link table alone: `venture_links` already
      carries `github → owner/name` where a hostname matched, and that is used
      as the DEFAULT — but a link is a guess the owner accepted about which
      repo serves a domain, and several ventures here have four of them. The
      owner naming one, or naming a path on this machine, has to beat it.

      `kind` IS 'github' OR 'local'. A local path is how somebody with no
      GitHub token, or with the code only on this machine, still gets repo-tier
      facts — and it is how this feature is tested against a real repository
      without spending anybody's rate limit.

      `head` IS THE COMMIT THE STORED FACTS WERE READ AT. It is the refresh
      trigger: a HEAD that has not moved means the repository has not changed
      and there is nothing to re-read, whatever the timer thinks.
    */
    name: "231_knowledge_repos",
    sql: `
      CREATE TABLE IF NOT EXISTS knowledge_repos (
        venture_id   TEXT PRIMARY KEY,
        repo         TEXT NOT NULL,
        kind         TEXT NOT NULL,
        head         TEXT,
        extracted_at TEXT,
        note         TEXT,
        error        TEXT,
        updated_at   TEXT NOT NULL
      );
    `,
  },
  {
    /*
      WHERE THE MAPPING CAME FROM, which 231 could not say.

      The row is written the first time a repository is read, whether the owner
      named one or the link table supplied it — and without this column the
      page reported "the owner's setting" for a repository the owner had never
      chosen. That is a small lie in exactly the place this area is supposed
      not to tell one: the whole feature is about knowing where a statement
      came from, and the statement "this is the venture's repository" is no
      exception. 'owner' is the default because a row written before this
      migration existed can only have come from a read the owner triggered.
    */
    name: "232_knowledge_repo_source",
    sql: `ALTER TABLE knowledge_repos ADD COLUMN source TEXT NOT NULL DEFAULT 'owner';`,
  },
  {
    /*
      AND THE ROWS THAT WERE ALREADY THERE WHEN 232 RAN.

      232's `DEFAULT 'owner'` had to say SOMETHING about rows written before the
      column existed, and it said the wrong thing: every repository this box had
      taken off the `venture_links` table was labelled as the owner's own
      choice. That is a small lie in the one place this area may not tell one —
      the whole feature is about knowing where a statement came from, and "this
      is the venture's repository" is a statement like any other.

      THIS RUNS IN THE SAME STARTUP AS 232, IMMEDIATELY AFTER IT, which is what
      makes it correct rather than a guess: at this instant every row in the
      table predates the column, so a row whose repo is exactly a `github` link
      the owner accepted for that venture is a row this code filled in, not one
      he typed. From the next row onwards `setRepo` records the truth directly
      and nothing has to be inferred again.

      On a fresh install 230-233 all run against an empty table and this is a
      no-op. `venture_links` is created by migration 060, well before this one:
      migrations run in array order and the ventures area is registered ahead of
      this one in `integrations/migrations.ts`.
    */
    name: "233_knowledge_repo_source_backfill",
    sql: `
      UPDATE knowledge_repos SET source = 'link'
       WHERE kind = 'github'
         AND source = 'owner'
         AND EXISTS (
           SELECT 1 FROM venture_links vl
            WHERE vl.venture_id = knowledge_repos.venture_id
              AND vl.plugin = 'github'
              AND vl.entity = knowledge_repos.repo
         );
    `,
  },
];
