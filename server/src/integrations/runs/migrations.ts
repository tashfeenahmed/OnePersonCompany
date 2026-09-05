/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "070_agent_runs",
    sql: `
      -- A RUN IS A LEDGER ROW, NOT A JOB QUEUE ENTRY, and that is the whole
      -- reason it is a table rather than a Map in memory.
      --
      -- The work here takes minutes: a deep research pass, a competitor sweep,
      -- a paper. The tab that started it will be closed before it finishes and
      -- the browser is entitled to be. So the state of the work lives here,
      -- the page polls it, and a run that was started is a run that can be
      -- found again — including one this process was killed in the middle of,
      -- which becomes \`failed\` at boot with the reason on it. A row that said
      -- \`running\` after a restart would be a ledger claiming work is in
      -- progress that nothing is doing.
      --
      -- \`output\` IS PARTIAL WHILE IT IS RUNNING and that is deliberate. The
      -- chat route takes the opposite view — nothing assistant-shaped is
      -- written until the stream ends, because a half-written message in a
      -- TRANSCRIPT is briefly a lie readable by the other door. A run is not a
      -- transcript: nobody is being answered, the row is the work itself, and
      -- the page exists to watch it being written. \`status\` says which it is,
      -- so a reader can never mistake a growing report for a finished one.
      --
      -- \`steps\` IS JSON RATHER THAN A TABLE because a step has exactly one
      -- reader — the progress list on the page — is written only as part of
      -- writing this row, and is never queried across runs. A second table
      -- would buy a join and an ordering question for nothing.
      --
      -- NO FOREIGN KEY ON \`venture_id\`, on routes/board.ts's argument: a
      -- deleted business does not un-do the work that was done about it. The
      -- run keeps the id, it resolves to nothing, and the page draws it
      -- unfiled.
      --
      -- \`backend\` IS WIDER THAN THE TWO AGENT IDS, exactly as chat_messages'
      -- is: \`hermes\`, \`openclaw\`, or \`provider:<id>\` when no agent was live
      -- and the raw model answered. An owner reading this six weeks later is
      -- entitled to know which, because a report written by a model with no
      -- tools is a different document than one written by an agent that went
      -- and looked.
      CREATE TABLE agent_runs (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL,
        venture_id       TEXT,
        title            TEXT NOT NULL,
        input            TEXT NOT NULL DEFAULT '{}',
        status           TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
        queued_at        TEXT NOT NULL,
        started_at       TEXT,
        finished_at      TEXT,
        backend          TEXT,
        model            TEXT,
        steps            TEXT NOT NULL DEFAULT '[]',
        output           TEXT NOT NULL DEFAULT '',
        output_chars     INTEGER NOT NULL DEFAULT 0,
        error            TEXT,
        ms               INTEGER,
        usage_prompt     INTEGER,
        usage_completion INTEGER
      );
      CREATE INDEX agent_runs_queue ON agent_runs(status, queued_at);
      CREATE INDEX agent_runs_kind ON agent_runs(kind, queued_at DESC);
      CREATE INDEX agent_runs_venture ON agent_runs(venture_id, queued_at DESC);
    `,
  },

  {
    name: "071_competitor_profiles",
    sql: `
      -- THE ONE THING ON THIS BOX THAT ACCUMULATES ACROSS RUNS.
      --
      -- Every other run kind writes a report and stops. A competitor sweep is
      -- worth more the second time it is run: the rivals found in March are
      -- still rivals in September, and what changed about them — a price, a
      -- position — is the interesting half. So the profiles are a table keyed
      -- by (venture, name) and each sweep UPSERTS: it verifies what is here,
      -- deepens it, and adds what it found that was not.
      --
      -- \`last_verified\` MOVES ONLY WHEN A RUN NAMED THE PROFILE. A rival the
      -- newest sweep did not mention keeps its old date, because silence is
      -- not verification — the model may simply not have looked. That is what
      -- makes a stale row visible as stale instead of quietly re-dated by a
      -- run that never checked it.
      --
      -- \`first_seen\` never moves, so "we have known about this one since
      -- March" is answerable, and \`run_id\` names the sweep that last touched
      -- it so a claim can be traced back to the report that made it.
      --
      -- THE OWNER CAN EDIT THESE (PATCH /api/competitors/:venture/:name) and
      -- that edit is not marked differently from the model's, deliberately: a
      -- profile is a working note, the owner is the authority on it, and a
      -- provenance flag that the next sweep would immediately overwrite would
      -- be a field that lies within the hour.
      CREATE TABLE competitor_profiles (
        venture_id    TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        url           TEXT,
        positioning   TEXT,
        pricing       TEXT,
        strengths     TEXT NOT NULL DEFAULT '[]',
        weaknesses    TEXT NOT NULL DEFAULT '[]',
        last_verified TEXT NOT NULL,
        first_seen    TEXT NOT NULL,
        run_id        TEXT,
        PRIMARY KEY (venture_id, name)
      );
    `,
  },

  {
    name: "072_geo_answers",
    sql: `
      -- WHAT A MODEL SAYS ABOUT THE OWNER'S BUSINESS WHEN NOBODY LETS IT LOOK.
      --
      -- This is the only measurement on this box whose instrument is a language
      -- model, and it is stored rather than scored-and-discarded because the
      -- ANSWER is the evidence. A row saying "mentioned: 0" and nothing else
      -- would be a number nobody could argue with; the paragraph the model
      -- actually wrote is what shows whether it had never heard of the product
      -- or had it confused with something else.
      --
      -- \`mentioned\` IS MEASURED AND \`accurate\`/\`recommended\` ARE JUDGED, which
      -- is why they are three columns and not one score. Mention is string
      -- presence of the name or the host in the answer — mechanical, cheap and
      -- checkable. The other two need a reader, so they are a second, cheap
      -- completion, and they are NULL when that judge was not run or did not
      -- answer usably. Null means asked and not told; it does not mean no.
      --
      -- The provider and the model are on every row because the answer is about
      -- them as much as about the business: "GPT does not know you exist" and
      -- "the local 8B does not know you exist" are different findings.
      CREATE TABLE geo_answers (
        run_id      TEXT NOT NULL,
        venture_id  TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        provider    TEXT NOT NULL,
        model       TEXT,
        question    TEXT NOT NULL,
        answer      TEXT NOT NULL,
        mentioned   INTEGER NOT NULL,
        accurate    INTEGER,
        recommended INTEGER,
        ts          TEXT NOT NULL
      );
      CREATE INDEX geo_answers_venture ON geo_answers(venture_id, ts DESC);
      CREATE INDEX geo_answers_run ON geo_answers(run_id);
    `,
  },

  {
    name: "073_paper_library",
    sql: `
      -- THE PAPERS THAT EXIST, kept so the papers WE write can only cite them.
      --
      -- A model asked for references invents them. That is not a failure mode
      -- to mitigate with a stern instruction, it is the default behaviour, and
      -- the only reliable fix is to make the citation list a CLOSED SET the
      -- model is handed rather than an open one it is asked to remember. So
      -- every paper run scouts OpenAlex and arXiv first, writes what it found
      -- here, puts the list in the brief, and the write turn is told to cite
      -- [n] from that list and nothing else.
      --
      -- KEYED ON (source, ext_id) rather than on DOI, because arXiv preprints
      -- routinely have no DOI and a primary key that is null half the time is
      -- not one. The DOI is stored when there is one and the de-duplication
      -- across the two sources happens on the way in — same DOI, same arXiv id,
      -- or the same title once punctuation and case are taken out.
      --
      -- The library is SHARED across ventures and topics. A paper found while
      -- scouting one topic is still a real paper when the next topic overlaps
      -- it, and \`topic\` records which search first turned it up rather than
      -- fencing it off.
      CREATE TABLE paper_library (
        source     TEXT NOT NULL,
        ext_id     TEXT NOT NULL,
        venture_id TEXT,
        topic      TEXT NOT NULL,
        doi        TEXT,
        title      TEXT NOT NULL,
        authors    TEXT NOT NULL DEFAULT '[]',
        year       INTEGER,
        url        TEXT,
        abstract   TEXT,
        seen_at    TEXT NOT NULL,
        PRIMARY KEY (source, ext_id)
      );
      CREATE INDEX paper_library_topic ON paper_library(topic, seen_at DESC);
    `,
  },

  {
    name: "074_papers",
    sql: `
      -- WHAT WAS WRITTEN, so the next one can be told not to write it again.
      --
      -- \`run_id\` IS THE PRIMARY KEY because a paper is exactly one run's
      -- output — there is no version two of a paper here, there is a second
      -- run — and keying it on the run means the row, the markdown on disk and
      -- the PDF beside it all carry one name.
      --
      -- \`thesis\` AND \`contributions\` ARE STORED SEPARATELY FROM THE MARKDOWN
      -- for one purpose: the plan turn of the NEXT run is shown them and told
      -- to be net-new against them. A model handed six whole papers would be
      -- handed six thousand tokens to say what six sentences say.
      --
      -- \`md_path\` AND \`pdf_path\` ARE FILES, on venture_shots' and
      -- studio_posts' argument: a rendered PDF is a megabyte in a database
      -- otherwise measured in kilobytes, and DATA_DIR is what the backup
      -- copies. \`pdf_path\` is NULL when no browser was found — a paper with no
      -- PDF is still a paper, and a null here is the honest record of a
      -- machine with no Chrome on it.
      CREATE TABLE papers (
        run_id        TEXT PRIMARY KEY,
        venture_id    TEXT,
        topic         TEXT NOT NULL,
        title         TEXT NOT NULL,
        thesis        TEXT NOT NULL DEFAULT '',
        contributions TEXT NOT NULL DEFAULT '[]',
        md_path       TEXT,
        pdf_path      TEXT,
        cited         TEXT NOT NULL DEFAULT '[]',
        ts            TEXT NOT NULL
      );
      CREATE INDEX papers_venture ON papers(venture_id, ts DESC);
    `,
  },

  {
    name: "075_papers_typeset",
    sql: `
      -- WHICH MACHINE SET THE PAPER, and what it produced.
      --
      -- \`typeset\` IS THE HONEST RECORD OF A BOX'S TOOLING and is the reason
      -- this migration exists rather than the columns being back-filled with a
      -- default. \`typst\` means the PDF was compiled from the source in
      -- \`typ_path\` — two columns, numbered headings, an IEEE bibliography.
      -- \`chrome\` means there was no typesetter installed when this paper was
      -- written, so it is markdown printed by a browser, which is a readable
      -- document and is not a typeset paper. NULL is every paper written before
      -- the distinction existed, and every one that produced no PDF at all —
      -- and a page must draw that as "not recorded", never as either engine.
      --
      -- \`columns\` IS THE PLAN'S OWN CHOICE, kept because it is the one
      -- decision about the LOOK of the document that the model makes and this
      -- server honours; a reader comparing two papers is entitled to know
      -- which was asked for rather than inferring it from the PDF.
      --
      -- \`pages\` IS READ OFF THE FINISHED FILE and is NULL when it could not
      -- be read. It is the only number on this row that says how much paper
      -- there is, and a guess would be believed.
      --
      -- \`typ_path\` IS THE SOURCE AND IT IS THE ARTEFACT. The PDF is a
      -- rendering of it; the .typ is what was written, what the repair pass
      -- fixed, and the only thing that explains a compile that failed. A paper
      -- with a source and no PDF is a real state and is kept as one.
      ALTER TABLE papers ADD COLUMN typeset  TEXT;
      ALTER TABLE papers ADD COLUMN columns  INTEGER;
      ALTER TABLE papers ADD COLUMN pages    INTEGER;
      ALTER TABLE papers ADD COLUMN typ_path TEXT;
    `,
  },
];
