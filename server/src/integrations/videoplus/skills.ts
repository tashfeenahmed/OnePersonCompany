/**
 * The videoplus area's one skill entry.
 *
 * Types only from skills/registry.ts: a value-level import would cycle.
 *
 * ONE SKILL AND NOT THREE. The reel and the smarter shorts are FORMATS of a
 * run kind that already has a door — `runs start --kind video --format reel` —
 * and their output is already published by the `video` skill, which reads the
 * same table. A second skill describing the same rows would be a second set of
 * honesty rules to keep in step with the first. What has no door anywhere else
 * is the scene spec: a small structured document that is written, previewed,
 * edited and rendered, and none of those four verbs exists on any other skill.
 *
 * THREE OF THE FIVE ACTIONS ARE `destructive`, ON THE MONEY LIMB. See
 * `skills/registry.ts` for the one definition and `runs/manifest.ts` for why it
 * is not only about what can be undone: `draft` calls the model provider,
 * `render` queues browser launches and minutes of the single run slot, and
 * `delete` removes a row. `save` and every view are not — writing a scene list
 * to this disk costs nothing and can be edited back.
 *
 * `plugins: []` — ALWAYS LIVE. A scene spec can be written, edited and read
 * with nothing connected at all; drafting one needs a model provider and
 * rendering one needs a browser, and both of those are reported per capability
 * by `GET /api/motion` rather than by the skill going dark.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "motion",
    title: "Motion — scene specs for motion-graphics videos",
    plugins: [],
    about:
      "A motion video here is a SCENE SPEC: four to eight cards of typography — " +
      "a title, a number, a before/after, a list, a call to action — each with " +
      "its own length, rendered in the venture's own measured colours and " +
      "typeface. This skill holds the specs: what they contain, what a render " +
      "will cost in browser launches and seconds, a preview of the first frame " +
      "of every scene, and the action that queues the render. Rendering is a " +
      "`video` run with `format=motion`; the file lands on the run's page.",
    rules: [
      "A SPEC IS NOT A VIDEO. `seconds` on a spec is what its scene list adds " +
        "up to — a plan. The length of a finished render is read off the file " +
        "with ffprobe and lives on the video run. Never quote the first as if " +
        "it were the second.",
      "NOTHING HERE IS PUBLISHED ANYWHERE. A render is a file on a run page. " +
        "There is no credential for any video platform in this vault and no " +
        "route on this server that would upload one, so never say a video has " +
        "been posted, scheduled or sent.",
      "A `stat` SCENE IS A CLAIM IN 200-POINT TYPE. This box knows a venture's " +
        "name, the sentence its owner wrote, its stage and its address. It does " +
        "NOT know its revenue, its customers, its funding or its results. Never " +
        "put a number on a stat card that you were not given, and when you draft " +
        "a spec from a brief with no numbers in it, write no stat scene at all.",
      "THE VALIDATOR CLAMPS AND REPORTS. Every save comes back with a " +
        "`problems` list: those are the things that were CHANGED — a heading " +
        "cut to length, a nine-item list cut to six, a scene shortened to the " +
        "ceiling — not warnings that were ignored. Read them back to the owner " +
        "rather than reporting the save as clean.",
      "A SCENE OF AN UNKNOWN KIND IS DROPPED, NOT RENDERED. The kinds are " +
        "title, stat, compare, list and cta and there is a template for each. " +
        "Anything else is refused, because rendering it as a different kind " +
        "would be making a different video from the one that was asked for.",
      "THE COLOURS ARE MEASURED OR THEY ARE DERIVED, AND THE RUN SAYS WHICH. " +
        "A venture whose site has been read gets its own palette; one whose " +
        "site has never been read gets its record colour darkened into a " +
        "background. Both make a video; only the first makes one that looks " +
        "like that business.",
      "A RENDER COSTS THIS LAPTOP'S CPU. Every eight frames is one headless " +
        "browser launch of about two and a half seconds, and the count is on " +
        "the spec's own view before anything is pressed. Say the number before " +
        "you queue a render on somebody's behalf.",
      "There is no view count, no watch time and no engagement here, and there " +
        "never will be: nothing on this box publishes a video, so nothing on " +
        "this box can measure how one performed.",
    ],
    views: [
      {
        key: "default",
        path: "/api/motion",
        about:
          "Every saved scene spec, newest first, with what each one adds up to — plus a readiness block saying whether this box has a browser to draw with, an ffmpeg that can cut a sheet apart, and a model that could draft one.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug. Absent lists every venture's specs." },
          { name: "limit", type: "number", required: false, fallback: 50, about: "How many to return. Clamped to 1–200." },
        ],
      },
      {
        key: "templates",
        path: "/api/motion/templates",
        about:
          "The five scene kinds, every field each one takes, and the limits a spec is clamped to. Read this before writing a spec — a field that is not here is not rendered.",
        params: [],
      },
      {
        key: "one",
        path: "/api/motion/:id",
        about: "One spec in full, with the number of frames and browser launches a render of it would take.",
        params: [{ name: "id", type: "string", required: true, in: "path", about: "The spec's id." }],
      },
      {
        key: "preview",
        path: "/api/motion/:id/preview",
        about:
          "Draws the first frame of every scene in one browser launch and answers with an image URL per scene. It is the same renderer the video uses at a third of the size, not a thumbnail. Takes a few seconds. Use the URLs it gives you verbatim — each call has its own address and only the last three sets of frames are kept.",
        params: [{ name: "id", type: "string", required: true, in: "path", about: "The spec's id." }],
      },
    ],
    actions: [
      {
        key: "draft",
        method: "POST",
        path: "/api/motion/draft",
        /* SPENDS MONEY — a `complete()` call on every invocation — which is
           the second limb of `destructive` in skills/registry.ts. The row it
           writes deletes; the tokens do not come back with it. */
        destructive: true,
        about:
          "Ask the model provider for a scene list from a brief and a venture, validate it, and save it as a spec marked `model`. It writes no stat scene when the brief gives it no number. Answers with the spec and everything the validator changed.",
        params: [
          { name: "venture", type: "string", required: false, about: "A venture's id or slug. Its record and colours are what the spec is written from." },
          { name: "brief", type: "string", required: false, about: "One or two lines about what this video is for. Empty makes the general case for the venture." },
          { name: "name", type: "string", required: false, about: "What to call the saved spec." },
          { name: "aspect", type: "string", required: false, fallback: "9:16", about: "9:16, 1:1 or 16:9." },
        ],
      },
      {
        key: "save",
        method: "POST",
        path: "/api/motion",
        about:
          "Save a scene list written by hand. `spec` is the JSON object — `{ title, scenes: [...] }` — as an object or as a string containing one. Answers 400 with a list of problems when it cannot be rendered.",
        params: [
          { name: "spec", type: "string", required: true, about: "The scene list as JSON. See the `templates` view for the fields each kind takes." },
          { name: "name", type: "string", required: false, about: "What to call it." },
          { name: "venture", type: "string", required: false, about: "A venture's id or slug — whose colours and typeface it renders in." },
        ],
      },
      {
        key: "render",
        method: "POST",
        path: "/api/motion/:id/render",
        /* SPENDS MONEY AND SPENDS THE MACHINE: a browser launch every eight
           frames, minutes of the single run slot, and a model call as well
           when it is started with no saved spec. Same limb as `draft`. */
        destructive: true,
        about:
          "Queue a render of a saved spec. It is a `video` run and it answers with the run — the frames are drawn on the queue, not in this request. The file lands on the run's page and is published nowhere.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The spec's id." },
          {
            name: "voiceover",
            type: "string",
            required: false,
            fallback: "false",
            about:
              "`true` speaks each scene's `say` line through the voice plugin. Anything else is silent, which is the ordinary case — speech is off by default.",
          },
        ],
      },
      {
        key: "delete",
        method: "POST",
        path: "/api/motion/:id/delete",
        destructive: true,
        about: "Delete a saved spec. A video already rendered from it keeps its own copy of the scene list and is not affected.",
        params: [{ name: "id", type: "string", required: true, in: "path", about: "The spec's id." }],
      },
    ],
    asks: [
      "Draft a motion video for this venture about what it does, and show me the scenes.",
      "What would rendering that spec cost, and what does the first frame of each scene look like?",
    ],
    /* `draft` AND `render` BOTH LEAVE THIS MACHINE: a `complete()` call to
       whichever model provider is configured, and for a spoken render the
       voice endpoint as well. The brief and the venture record go with them. */
    openWorld: true,
  },
];

/** Where this lands in Hermes' skill directory. Media, beside the video
 *  producer and the studio autopilot. */
export const PACKS: Record<string, { name: string; category: string }> = {
  motion: { name: "motion-graphics", category: "media" },
};
