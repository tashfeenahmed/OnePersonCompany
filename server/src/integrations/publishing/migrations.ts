/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "270_publish_destinations",
    sql: `
      -- WHERE A POST CAN ACTUALLY GO, one row per account on one network.
      --
      -- A DESTINATION IS NOT A CREDENTIAL. The credential lives in the vault
      -- under its plugin (meta, linkedin, tiktok) and is read by the provider
      -- at the moment of a call; this row is the ADDRESS on the far side of it
      -- — which Facebook Page, which Instagram business account, which
      -- LinkedIn organisation, which TikTok open id — plus the venture whose
      -- posts go there. One token can administer five Pages, and four of them
      -- may belong to businesses this box has never heard of, so the mapping
      -- from venture to page is the owner's and is stored rather than guessed.
      --
      -- \`capabilities\` IS THE PROBE'S ANSWER AND NOT A CONFIGURATION. It is
      -- written by POST /api/publishing/destinations/probe and holds what that
      -- probe could establish: whether text, a photo and a video can be posted
      -- at all, which permission was missing when one of them cannot, and the
      -- sentence that says so. It is JSON because the three networks disagree
      -- about what a capability even is — TikTok's answer includes the privacy
      -- levels an unaudited client is restricted to, which has no column here.
      --
      -- THE PROBE IS DATED AND ITS FAILURE IS KEPT. \`probe_ts\` null means
      -- nobody has ever asked; \`probe_ok = 0\` with an error means somebody
      -- asked and was refused, which is a different thing from a destination
      -- that has never been checked and must never render alike. Nothing here
      -- is re-probed on a read: the answer changes when a permission is
      -- granted, not when a page is drawn.
      CREATE TABLE IF NOT EXISTS publish_destinations (
        id            TEXT PRIMARY KEY,
        venture_id    TEXT NOT NULL,
        plugin_id     TEXT NOT NULL,
        -- The account row the credential hangs off, or NULL for a plugin whose
        -- accounts this could not attribute. It is not a foreign key: an
        -- account deleted must not silently delete the owner's mapping.
        account_id    INTEGER,
        account_label TEXT,
        -- page | ig | linkedin | tiktok. The kind decides which publisher runs
        -- and which limits apply, and it is a column rather than derived from
        -- the plugin because one plugin (meta) serves two of them.
        kind          TEXT NOT NULL,
        -- The id on the far side: a Page id, an IG user id, an organisation
        -- URN, a TikTok open id.
        external_id   TEXT NOT NULL,
        handle        TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        capabilities  TEXT NOT NULL DEFAULT '{}',
        probe_ts      TEXT,
        probe_ok      INTEGER,
        probe_error   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      -- One destination per (venture, network, account on that network). A
      -- second probe UPDATES the row rather than adding a duplicate, which is
      -- what keeps the owner's enable switch and their venture mapping across
      -- a re-probe.
      CREATE UNIQUE INDEX IF NOT EXISTS publish_destinations_key
        ON publish_destinations (venture_id, plugin_id, kind, external_id);
      CREATE INDEX IF NOT EXISTS publish_destinations_venture
        ON publish_destinations (venture_id);
    `,
  },

  {
    name: "271_publish_items",
    sql: `
      -- ONE THING GOING TO ONE PLACE, AND EVERY STATE IT WAS IN ON THE WAY.
      --
      -- THE STATUS IS THE OWNER'S CONSENT MADE DURABLE. \`draft\` is what
      -- anything that generates content may create; \`approved\` can only be
      -- set by the owner, through the UI or through a skill action marked
      -- destructive; \`scheduled\` carries a date; \`publishing\` is the
      -- moment the call is in flight; \`published\` carries an external id.
      -- Nothing in this server has a path from draft to published that does
      -- not pass through approved, which is a property of the code in
      -- publishing/items.ts and not a promise in a comment.
      --
      -- \`idempotency_key\` IS UNIQUE AND THAT IS THE WHOLE ANTI-DOUBLE-POST
      -- RULE. It is composed of the venture, the source artefact and the
      -- destination, so asking twice for "this Studio post, on that Page"
      -- returns the row that already exists rather than making a second one.
      -- The second half of the rule is \`external_id\`: an item that carries
      -- one is never submitted again, whatever its status says, because a
      -- double press must not become two posts in somebody's feed.
      --
      -- \`attempts\` AND \`next_attempt_at\` ARE THE RETRY, AND THEY SURVIVE A
      -- RESTART. The scheduler holds nothing in memory: a due item is chosen
      -- by a query, moved to \`publishing\` before the call, and moved back to
      -- \`scheduled\` with a later \`next_attempt_at\` when the call failed. A
      -- process killed mid-call leaves a row in \`publishing\`, which the
      -- next start reclaims — see publishing/scheduler.ts, which explains why
      -- reclaiming is safe only because \`external_id\` is checked first.
      --
      -- THE MEDIA IS A PATH ON THIS DISK AND NOT A COPY. A Studio post's PNG
      -- and a video job's mp4 belong to the areas that made them; this row
      -- points at the file and says what kind it is. A file that has been
      -- deleted is a publish that refuses with that sentence, never a publish
      -- of nothing.
      CREATE TABLE IF NOT EXISTS publish_items (
        id              TEXT PRIMARY KEY,
        venture_id      TEXT NOT NULL,
        destination_id  TEXT,
        -- studio_post | video_job | manual
        source_kind     TEXT NOT NULL,
        source_id       TEXT,
        caption         TEXT,
        -- image | video | none
        media_kind      TEXT NOT NULL DEFAULT 'none',
        media_path      TEXT,
        status          TEXT NOT NULL DEFAULT 'draft',
        scheduled_for   TEXT,
        approved_at     TEXT,
        approved_by     TEXT,
        idempotency_key TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        external_id     TEXT,
        permalink       TEXT,
        error           TEXT,
        note            TEXT,
        campaign_id     TEXT,
        published_at    TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS publish_items_idem
        ON publish_items (idempotency_key);
      CREATE INDEX IF NOT EXISTS publish_items_due
        ON publish_items (status, scheduled_for);
      CREATE INDEX IF NOT EXISTS publish_items_venture
        ON publish_items (venture_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS publish_items_campaign
        ON publish_items (campaign_id);
    `,
  },

  {
    name: "272_publish_attempts",
    sql: `
      -- EVERY SUBMISSION THIS BOX MADE OR WOULD HAVE MADE, kept apart from the
      -- item so a retry does not overwrite the reason the last one failed.
      --
      -- The item carries the LATEST error because that is what a queue needs
      -- to draw; this carries all of them because "it has failed three times
      -- with three different errors" and "it has failed three times with the
      -- same permission error" are different problems with different fixes.
      --
      -- \`dry\` MARKS A REHEARSAL. A dry run makes no network call at all: the
      -- request that WOULD have gone out is composed, recorded here, and
      -- answered by a mock. It is written to the same table on purpose — a
      -- rehearsal and a real submission are the same code path, and keeping
      -- them in one table is what makes that checkable afterwards rather than
      -- merely asserted.
      CREATE TABLE IF NOT EXISTS publish_attempts (
        id          INTEGER PRIMARY KEY,
        item_id     TEXT NOT NULL,
        ts          TEXT NOT NULL,
        dry         INTEGER NOT NULL DEFAULT 0,
        ok          INTEGER NOT NULL,
        -- What was actually called, with no credential in it — see
        -- publishing/publish.ts, which strips the token before recording.
        calls       TEXT NOT NULL DEFAULT '[]',
        external_id TEXT,
        permalink   TEXT,
        error       TEXT,
        ms          INTEGER
      );
      CREATE INDEX IF NOT EXISTS publish_attempts_item
        ON publish_attempts (item_id, id DESC);
    `,
  },

  {
    name: "273_campaigns",
    sql: `
      -- ONE ARGUMENT, MADE IN SEVERAL ROOMS.
      --
      -- A campaign is a goal, an audience and a set of channels, and its
      -- OUTPUT is a fan-out: concepts from the model, then one Studio draft
      -- per concept per channel. It is a row rather than a folder because the
      -- progress counters have to survive the run being cancelled half way —
      -- a campaign that produced four of nine variants is a real state, and
      -- the page has to be able to say so rather than showing nine or none.
      --
      -- \`run_id\` IS THE EXECUTION AND THIS IS THE PLAN. The work is a RUN
      -- kind, so it is queued behind everything else, cancellable, and it
      -- writes a report; this row is what the run was for, and it outlives
      -- the run's own retention.
      CREATE TABLE IF NOT EXISTS campaigns (
        id          TEXT PRIMARY KEY,
        venture_id  TEXT NOT NULL,
        run_id      TEXT,
        goal        TEXT NOT NULL,
        brief       TEXT NOT NULL DEFAULT '[]',
        audience    TEXT,
        -- A JSON array of destination kinds or platform names the variants are
        -- written for. Text because a campaign may name a platform this box
        -- cannot publish to, and refusing to plan for it would be the wrong
        -- half of the feature to withhold.
        channels    TEXT NOT NULL DEFAULT '[]',
        starts_on   TEXT,
        ends_on     TEXT,
        -- planning | producing | done | failed | cancelled
        status      TEXT NOT NULL DEFAULT 'planning',
        planned     INTEGER NOT NULL DEFAULT 0,
        produced    INTEGER NOT NULL DEFAULT 0,
        failed      INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS campaigns_venture
        ON campaigns (venture_id, created_at DESC);

      -- The concepts the model named. One row each, because a concept is what
      -- the variants below are grouped by and a JSON blob on the campaign
      -- could not be joined against them.
      CREATE TABLE IF NOT EXISTS campaign_concepts (
        id           TEXT PRIMARY KEY,
        campaign_id  TEXT NOT NULL,
        idx          INTEGER NOT NULL,
        theme        TEXT NOT NULL,
        description  TEXT,
        image_note   TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS campaign_concepts_campaign
        ON campaign_concepts (campaign_id, idx);

      -- One concept written for one channel. \`post_id\` points at the Studio
      -- post that was actually produced; \`item_id\` at the publish item, when
      -- one was made. Both nullable, because a variant that FAILED is still a
      -- row — the whole point of the counters above is that a campaign can be
      -- partly produced and say so.
      CREATE TABLE IF NOT EXISTS campaign_variants (
        id           TEXT PRIMARY KEY,
        campaign_id  TEXT NOT NULL,
        concept_id   TEXT NOT NULL,
        channel      TEXT NOT NULL,
        post_id      TEXT,
        item_id      TEXT,
        error        TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS campaign_variants_campaign
        ON campaign_variants (campaign_id, created_at);
    `,
  },

  {
    name: "274_venture_assets",
    sql: `
      -- THE BRAND'S OWN PICTURES: logos, references, screenshots.
      --
      -- WHY A LIBRARY RATHER THAN A PROMPT. The Studio can name a venture's
      -- measured hexes in an image prompt, and that is where brand consistency
      -- stops: a diffusion model given "#44AA44" produces a green picture, not
      -- this business's mark. A file the owner uploaded is the only thing that
      -- carries a logo, and it is stored here so it outlives the post it was
      -- used in — a reference is reused, and a post is not.
      --
      -- THE BYTES ARE ON DISK AND THE ROW POINTS AT THEM, for the reason
      -- studio_posts stores a path: an image in a TEXT column is an image
      -- every SELECT reads. \`sha256\` is here so the same file uploaded twice
      -- is visible as the same file; nothing de-duplicates automatically,
      -- because two ventures legitimately share a mark and deleting one's copy
      -- must not blank the other's.
      --
      -- \`source\` IS PROVENANCE AND IT IS NOT DECORATION. upload is the owner
      -- handing over a file; url is this box fetching one, which can be
      -- somebody else's copyright; extracted is a picture this box made
      -- itself. A page that could not tell them apart would eventually put a
      -- stranger's image into a published post.
      CREATE TABLE IF NOT EXISTS venture_assets (
        id          TEXT PRIMARY KEY,
        venture_id  TEXT NOT NULL,
        -- logo | reference | screenshot | other
        kind        TEXT NOT NULL,
        name        TEXT,
        path        TEXT NOT NULL,
        mime        TEXT NOT NULL,
        bytes       INTEGER,
        width       INTEGER,
        height      INTEGER,
        -- upload | url | extracted
        source      TEXT NOT NULL,
        source_url  TEXT,
        -- The open instruction forwarded to the image model when this asset is
        -- selected — "keep the palette cold", "crop wide". Not a description of
        -- the picture: the model can see the picture.
        prompt      TEXT,
        notes       TEXT,
        sha256      TEXT,
        used_count  INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS venture_assets_venture
        ON venture_assets (venture_id, created_at DESC);
    `,
  },

  {
    name: "403_publish_items_approved_content",
    sql: `
      -- WHAT WAS APPROVED, FROZEN AT THE MOMENT IT WAS APPROVED.
      --
      -- \`approved_at\` and \`approved_by\` say that somebody approved this row.
      -- They do not say WHAT they approved, and the row goes on changing: the
      -- caption is editable, the media path is rewritten by the job that
      -- renders it, and the source document behind it can be edited in the
      -- area that owns it. \`patchItem\` holds the honest half of that rule —
      -- an edit through it withdraws the approval — but it is a rule enforced
      -- by one function rather than a fact recorded on the row, and two other
      -- areas already write to this table around it.
      --
      -- SO THE APPROVAL CARRIES ITS OWN SNAPSHOT: the caption, the media kind
      -- and the media path as they stood when the press happened, as JSON.
      -- "Is what is about to be sent still what was approved" becomes a
      -- comparison rather than a belief, and an item that published something
      -- else has the evidence of it afterwards.
      --
      -- NULL IS THE HONEST VALUE FOR EVERY EXISTING ROW, including the ones
      -- already approved: nobody wrote a snapshot at the time and this
      -- migration cannot invent one from the row as it is now — that would be
      -- a snapshot of today dressed as a record of the press. Null means "no
      -- frozen copy", which is exactly true, and the next approval writes one.
      ALTER TABLE publish_items ADD COLUMN approved_content TEXT;
    `,
  },
];
