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

  {
    name: "076_competitor_memory",
    sql: `
      -- WHAT A SWEEP REMEMBERS BETWEEN SWEEPS, beyond the four fields it has
      -- always kept.
      --
      -- The competitors run became a two-turn run here: an investigation that
      -- returns JSON, and a tools-off turn that writes the landscape as one
      -- HTML document. The second turn can only say WHAT CHANGED if something
      -- wrote down what things used to be, and it can only report on what the
      -- last run asked for if the asking was stored. These three columns and
      -- the table below are that memory.
      --
      -- \`domain\` IS THE MERGE KEY AND \`name\` IS STILL THE PRIMARY KEY, and
      -- that is not a contradiction — it is the two questions being different.
      -- "Is this the same company as the one on file" is answered by the host,
      -- because a company renames its product far more often than it moves
      -- house, and matching on the name files "Uptime Kuma" and "Kuma" as two
      -- rivals with half a history each. "Which row do I write, and which one
      -- does the delete button address" is answered by the name, which is what
      -- the table, the routes and the owner's edits have always used. So the
      -- merge decides by domain and then writes the row it decided about,
      -- renaming it where the rival renamed itself. See runs/competitorsMerge.ts.
      --
      -- IT IS NULLABLE AND IT IS NOT BACK-FILLED HERE. SQLite has no URL
      -- parser and a hand-rolled one in SQL would be a second, worse copy of
      -- \`hostOf\` — so every existing row keeps a NULL and the code derives
      -- the host from \`url\` wherever it needs one. The first sweep after this
      -- migration writes the real value. A NULL therefore means "recorded
      -- before this column existed", which is exactly what it is.
      --
      -- \`changes\` IS AN ARRAY OF {at, field, from, to, note} AND IT IS
      -- CAPPED AT TWELVE. The note is the sentence a badge prints — "price
      -- moved, $9 → $12" — written when the row is merged rather than when it
      -- is read, because the reader cannot see the old value. The cap is there
      -- because the row is rewritten whole on every sweep and an unbounded
      -- array grows for as long as the business does.
      --
      -- A CHANGE IS RECORDED ONLY WHEN THE CLAIM MOVED, never when the wording
      -- did. Positioning and pricing are free prose a model rewrites from
      -- scratch every time, so comparing the strings compares its word choice:
      -- measured over a week of real sweeps, three fifths of the "changes" a
      -- string comparison found had an identical set of numbers on both sides.
      -- competitorsMerge.ts compares the money for pricing and the content
      -- words for positioning, which is what makes a badge worth reading.
      --
      -- \`sources\` IS THE EVIDENCE, and it is what the honesty rule rests on:
      -- a rival the investigation turn cannot put ONE https URL against is a
      -- rival it did not read a page about, and it never reaches this table.
      ALTER TABLE competitor_profiles ADD COLUMN domain  TEXT;
      ALTER TABLE competitor_profiles ADD COLUMN changes TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE competitor_profiles ADD COLUMN sources TEXT NOT NULL DEFAULT '[]';

      CREATE INDEX competitor_profiles_domain ON competitor_profiles(venture_id, domain);

      -- WHAT THE LAST RUN SAID TO LOOK AT NEXT TIME, AND WHAT BECAME OF IT.
      --
      -- This is the half of the memory that makes a sweep a series rather than
      -- a set of unrelated afternoons. Each run ends by naming a few things it
      -- could not settle; the next run is handed that list in its brief, is
      -- required to say what it found for each item, and writes the answers
      -- back here as \`done_at\` and \`done_note\`. The report then opens with
      -- what got done and what did not, which is the one thing a standing
      -- research task can say that a fresh one cannot.
      --
      -- \`done_at\` NULL IS OPEN AND IT IS THE HONEST DEFAULT. An item the next
      -- run did not mention stays open — the same rule \`last_verified\`
      -- follows on the profiles, for the same reason: silence is not an
      -- answer. An item that WAS looked at and could not be established is
      -- CLOSED with a note saying so, because "we tried and could not find out"
      -- is a finding and leaving it open would ask the next three runs to try
      -- again.
      --
      -- \`run_id\` IS THE RUN THAT RAISED THE ITEM, not the one that closed it.
      -- The report needs "what the LAST run said to focus on", which is a
      -- question about who asked; who answered is already in \`done_at\`.
      --
      -- NO FOREIGN KEY ON \`run_id\`, on agent_runs' own argument: a deleted
      -- run does not un-ask the question it raised.
      CREATE TABLE competitor_focus (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
        run_id     TEXT NOT NULL,
        title      TEXT NOT NULL,
        detail     TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        done_at    TEXT,
        done_note  TEXT
      );
      CREATE INDEX competitor_focus_venture ON competitor_focus(venture_id, created_at DESC);
    `,
  },

  {
    name: "077_geo_answer_reading",
    sql: `
      -- WHAT THE ANSWER MEANT, BESIDE WHETHER IT MENTIONED US.
      --
      -- 072 stored the measurement: the question, the answer, and three
      -- columns saying whether the name appeared and whether a judge thought
      -- the answer accurate and the product recommended. That was enough to
      -- count and not enough to ACT ON. "recommended: no" is a fact nobody can
      -- do anything with; "it named Intercom, Drift and Zendesk instead, so a
      -- buyer reading this never learns you exist" plus "get listed on the two
      -- comparison pages that rank for this category" is the same fact with a
      -- next step on it. The judge was already reading every answer to fill in
      -- the two booleans, so it is now asked for the reading as well and these
      -- four columns are where it lands.
      --
      -- \`kind\` IS THE AXIS THE WHOLE REPORT IS READ ALONG: \`direct\` names
      -- the product ("What is X?"), \`generic\` is what a stranger who has
      -- never heard of it would ask ("what's the best tool for …"), \`extra\`
      -- is a question the owner typed. They answer different questions and
      -- averaging them answers neither — "mentioned in 4 of 5" is worthless
      -- when four of the five put the name in the question. The generic ones
      -- are GENERATED per run from the venture record, so this is not a
      -- property of the question text that could be derived later; it has to
      -- be written down when the question is asked.
      --
      -- EVERY ONE OF THEM IS NULLABLE AND NONE IS BACK-FILLED. A row written
      -- before this migration was asked without any of this and there is no
      -- honest way to invent it afterwards: a NULL \`kind\` means "asked before
      -- the run knew the difference", and the client draws it as "not
      -- recorded" rather than guessing a kind from the wording. Same rule the
      -- judged columns in 072 already follow — null is asked-and-not-told.
      --
      -- \`rivals\` IS A JSON ARRAY AND ITS EMPTY CASE IS NOT ITS NULL CASE.
      -- \`[]\` is "the judge read the answer and it named nobody else"; NULL is
      -- "the judge did not answer for this row". Those are different findings
      -- and a single column that spelled them the same way would quietly turn
      -- a failed judge into a clean sheet.
      ALTER TABLE geo_answers ADD COLUMN kind        TEXT;
      ALTER TABLE geo_answers ADD COLUMN rivals      TEXT;
      ALTER TABLE geo_answers ADD COLUMN explanation TEXT;
      ALTER TABLE geo_answers ADD COLUMN action      TEXT;
    `,
  },
  {
    name: "078_geo_answer_searches",
    sql: `
      -- WHAT THE MODEL LOOKED AT BEFORE IT ANSWERED.
      --
      -- Until now every answer in this table was a model speaking from its
      -- own weights: no tools, no web. That measured one thing — recall — and
      -- the owner's point was that it is not the thing a stranger gets any
      -- more. An assistant asked "what's the best tool for X" searches first
      -- and answers from what it found, so the run now hands the model a
      -- web_search tool and records, per answer, the queries it ran and the
      -- top results each returned.
      --
      -- NULL IS "ASKED WITHOUT TOOLS", \`[]\` IS "HAD THE TOOL AND DID NOT
      -- USE IT". They are different facts about the answer, the same
      -- convention \`rivals\` keeps, and every row written before this
      -- migration is NULL because that is exactly what it was.
      ALTER TABLE geo_answers ADD COLUMN searches TEXT;
    `,
  },
  {
    name: "079_run_card_verdicts",
    sql: `
      -- WHY A SUGGESTED CARD DID OR DID NOT REACH THE BOARD.
      --
      -- The gate on run cards is a model's judgment (runs/card-gate.ts), and the
      -- objection to making it one was that a model's rule is unobservable
      -- except by running a night. This table is the answer: one row per
      -- suggestion, holding what the judge said, why, and which model said it.
      -- "Where did that card go" is a query.
      --
      -- FILED CARDS ARE RECORDED TOO, not only refusals. A gate you can only
      -- see the refusals of cannot be shown to be working, and the ratio is the
      -- thing worth watching over a fortnight.
      --
      -- \`idx\` IS THE CARD'S POSITION IN THE REPORT'S FENCE, which is also what
      -- its board origin carries (\`run:<id>:<n>\`), so a verdict joins back to
      -- the card it judged even when the ones before it were dropped.
      --
      -- \`verdict\` IS 'change', 'homework' OR 'unjudged'. The third is not a
      -- refusal: it is the gate failing open because the model could not be
      -- reached or did not answer, and those cards were filed.
      CREATE TABLE IF NOT EXISTS run_card_verdicts (
        run_id  TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        idx     INTEGER NOT NULL,
        title   TEXT NOT NULL,
        verdict TEXT NOT NULL,
        why     TEXT,
        model   TEXT,
        at      TEXT NOT NULL,
        PRIMARY KEY (run_id, idx)
      );
    `,
  },

];
