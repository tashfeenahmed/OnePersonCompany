/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "350_style_guides",
    sql: `
      -- WHAT THE OWNER SAYS THIS BUSINESS SOUNDS LIKE.
      --
      -- Everything else a generator knows about a venture is either MEASURED
      -- or TYPED SOMEWHERE ELSE FOR ANOTHER PURPOSE. \`ventures.brand\` is a
      -- reading of the site — hexes counted off rendered pixels, fonts lifted
      -- out of the CSS — and \`ventures.description\` is one sentence written
      -- to identify a row in a list. Neither is guidance. A palette cannot say
      -- "never call them users, they are teachers", and a one-line description
      -- cannot say "the second person, never the imperative".
      --
      -- SO THIS IS THE ONE TABLE ON THIS BOX WHOSE CONTENTS ARE PURE OPINION,
      -- and that is why it is separate from the brand blob rather than another
      -- key inside it. The brand blob is owned by ventures/enrich.ts and is
      -- REWRITTEN wholesale every time a site is re-read; a paragraph the
      -- owner typed sitting inside it would be destroyed by the next
      -- successful enrichment, silently, on a schedule. A measurement and a
      -- judgement must not share a writer.
      --
      -- ONE ROW PER VENTURE, KEYED ON THE VENTURE, so there is exactly one
      -- answer to "how does this business talk". A history table was
      -- considered and rejected: a style guide is not an event stream, and
      -- nobody has ever wanted to know what their tone of voice was in March.
      --
      -- EVERY COLUMN IS NULLABLE AND NULL MEANS UNWRITTEN. It is not an empty
      -- instruction. The prompt builders skip a null field entirely rather
      -- than telling a model that the audience is "" — an empty line in a
      -- prompt is noise a model will try to satisfy.
      --
      -- \`colours\` AND \`fonts\` ARE PROSE, NOT LISTS. They sit beside the
      -- measured palette rather than replacing it, and they exist for the case
      -- the measurement gets wrong: "the green on the site is the old logo,
      -- use the navy" is a sentence, and there is no column shape that holds
      -- it. Anything that must be machine-read is still read off
      -- \`ventures.brand\`.
      CREATE TABLE IF NOT EXISTS style_guides (
        venture_id TEXT PRIMARY KEY,
        summary    TEXT,
        tone       TEXT,
        audience   TEXT,
        dos        TEXT,
        donts      TEXT,
        colours    TEXT,
        fonts      TEXT,
        language   TEXT,
        notes      TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
];
