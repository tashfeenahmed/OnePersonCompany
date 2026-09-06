/** Pure SQL, no imports — see integrations/manifest.ts for why. */
export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "330_motion_specs",
    sql: `
      -- A SCENE LIST, SAVED, BECAUSE IT IS THE THING THAT GETS EDITED.
      --
      -- A motion-graphics video is not written the way a faceless one is. A
      -- faceless script is a paragraph the model wrote and nobody touches
      -- again; a scene spec is a small structured document — four numbers and
      -- eight sentences — that the owner will fix, re-render, fix again and
      -- re-render. If it lived only inside the run that used it, "render that
      -- one again with the second number corrected" would mean typing the
      -- whole thing a second time.
      --
      -- \`spec\` IS JSON AND IS VALIDATED ON THE WAY IN, NOT ON THE WAY OUT.
      -- integrations/videoplus/scenespec.ts is the only thing that writes this
      -- column and it clamps rather than argues: a scene longer than the limit
      -- becomes the limit, a list of nine items becomes six, and a scene of a
      -- kind no template exists for is the ONE hard refusal — a scene the
      -- renderer has no template for would come out as a different scene, and
      -- silently rendering the wrong thing is the failure this whole area is
      -- built to avoid.
      --
      -- NO COLOURS ARE STORED HERE. The palette and the typeface come from the
      -- venture's own measured brand at the moment of the render, so a spec
      -- written before the site was read renders in the venture's colours once
      -- it has been. A copy taken at write time would be a second, staler
      -- source for something this box already measures.
      --
      -- THERE IS NO RENDER COLUMN AND NO STATUS. A render is a RUN — it takes
      -- minutes, it is queued, it can be cancelled, and video_jobs already
      -- holds the artefact. A status here would be a second copy of the run
      -- ledger, and the two would disagree the first time a run was cancelled.
      CREATE TABLE IF NOT EXISTS motion_specs (
        id          TEXT PRIMARY KEY,
        venture_id  TEXT,
        name        TEXT NOT NULL,
        spec        TEXT NOT NULL,
        aspect      TEXT NOT NULL DEFAULT '9:16',
        scenes      INTEGER NOT NULL DEFAULT 0,
        seconds     REAL,
        source      TEXT NOT NULL DEFAULT 'owner',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS motion_specs_venture ON motion_specs (venture_id, updated_at DESC);
    `,
  },
  {
    name: "331_videoplus_clip_framing",
    sql: `
      -- HOW ONE CLIP WAS FRAMED, AND WHETHER ANYTHING WAS ACTUALLY FOLLOWED.
      --
      -- A landscape video cut to 9:16 loses two thirds of its width, and the
      -- whole question is which two thirds. There are two answers on this box
      -- and they are not the same product:
      --
      --   fixed    The centre of the frame, always. Cheap, and WRONG whenever
      --            the person talking is not in the middle — which on an
      --            interview, a screen share or anything shot wide is most of
      --            the time. This is the fallback and it must always be
      --            visible as one.
      --   tracked  A crop window that moves: the source is sampled at a few
      --            frames a second, the horizontal centre of MOTION is
      --            measured on each pair, the path is smoothed, and ffmpeg is
      --            given a crop whose x is a function of t.
      --
      -- \`mode\` IS THE HONESTY COLUMN, the way video_clips.chosen_by is for the
      -- windows. A page that drew a fixed centre crop and a tracked one the
      -- same way would be claiming this box followed a subject it never
      -- looked for.
      --
      -- \`detector\` NAMES WHAT MEASURED THE BOX — \`motion\` for the frame-diff
      -- centroid, \`cropdetect\` for the borders ffmpeg found, \`none\` when
      -- nothing did. THERE IS NO FACE DETECTION HERE and the column must never
      -- say there is: nothing on this box has a face model, and a motion
      -- centroid is not one. A speaker who sits still while a slide changes
      -- behind them is exactly the case this gets wrong, and \`note\` says so.
      --
      -- \`samples\` IS HOW MANY MEASUREMENTS THE PATH IS MADE OF, so a path
      -- built from four samples over forty seconds is not read as tracking.
      CREATE TABLE IF NOT EXISTS videoplus_clip_framing (
        run_id    TEXT NOT NULL,
        idx       INTEGER NOT NULL,
        mode      TEXT NOT NULL,
        detector  TEXT NOT NULL,
        samples   INTEGER,
        drift_px  REAL,
        note      TEXT,
        PRIMARY KEY (run_id, idx)
      );
    `,
  },
];
