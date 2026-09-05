/**
 * THE RUNS AREA — the long work, and the three things it accumulates.
 *
 * Every other area on this seam either measures a third party (analytics, ops,
 * signals) or holds what the owner typed about a business (ventures). This one
 * holds neither. It holds WORK: a piece of thinking that takes minutes, is
 * started from a page, executes on this server, survives the tab closing, and
 * leaves a document behind. The dashboard already had a place to have a
 * conversation with an agent; it had nowhere to give one a job.
 *
 * SO THERE ARE NO `plugins` AND NO `collectors`, for the ventures area's
 * reason: nothing here holds a credential of its own — it borrows whichever
 * agent or model provider is live — and nothing here runs on the half-hourly
 * scheduler, because a run is something the owner asks for rather than a
 * measurement that goes stale on a cadence. The one background thing is the
 * queue, which is `onStart`'s.
 *
 * TWO SKILLS AND NOT SIX. An agent does not need one entry per kind of run: the
 * kinds are DATA on `/api/runs` (`kinds[]`, with each one's inputs and its
 * counts), so an agent that reads the list can start any of them through one
 * action, and a seventh kind added later needs no edit here. The second entry,
 * `competitors`, is separate because the profiles outlive the runs that wrote
 * them and are a thing to read on their own — which is the test for whether
 * something is its own skill.
 *
 * THE `start` ACTION IS NOT MARKED DESTRUCTIVE and that is a considered claim
 * rather than an oversight. Starting a run cannot be undone — but nothing it
 * touches can be un-made either: it writes a row, and the row can be deleted.
 * What it DOES cost is real and is said in the action's own text: minutes of
 * the single run slot, and tokens on the owner's account. `destructive` means
 * "the change cannot be undone from here", and marking a reversible action
 * destructive to be safe would train a client to ignore the field.
 */
import type { IntegrationManifest } from "../manifest.ts";
import type { Skill } from "../../skills/registry.ts";
import { startQueue } from "./executor.ts";
import { KINDS } from "./kinds.ts";
import { competitorRoutes, geoRoutes, paperRoutes, runRoutes } from "./routes.ts";
import { failInterrupted } from "./store.ts";

/* ------------------------------------------------------------------ skills */

const skills: Skill[] = [
  {
    id: "runs",
    title: "Runs — the long work this box has been asked to do",
    /* No credential of its own. Whether anything will ANSWER a run depends on
       an agent or a provider being live, which the run's own error says at the
       point it matters; a skill that claimed to be dead because a plugin list
       was empty would hide the ledger of everything already written. */
    plugins: [],
    about:
      "One run is one piece of long agent work: deep research on a venture, a " +
      "competitor sweep, an SEO review, a demand read, an AI-visibility check, or " +
      "a written paper. Runs execute ONE AT A TIME on this server — the rest " +
      "queue — and each leaves a markdown report with Findings, Evidence, " +
      "Recommendations and a block of suggested board cards. The list carries " +
      "every kind with its inputs and its counts; one run carries its report, its " +
      "progress steps, and which backend wrote it.",
    rules: [
      "`backend` SAYS WHO WROTE IT AND IT MATTERS. `hermes` or `openclaw` is an " +
        "agent that could use tools and go and look; `provider:<id>` is a raw " +
        "model with no tools, no web and nothing but the brief it was handed. A " +
        "report from the second is reasoning over this box's own data and must " +
        "never be quoted as though something was checked.",
      "A RUN WITH `status: \"running\"` HAS A PARTIAL REPORT. `output` is however " +
        "much has been written so far and `partial` says so. Do not summarise it " +
        "as a conclusion — the paragraph that reverses it may not be written yet.",
      "THE `cards` BLOCK IS A SUGGESTION AND NOTHING FILED IT. No run writes to " +
        "the board. If the owner wants one of them, it is created through the " +
        "board's own action, by them.",
      "STARTING A RUN COSTS THE SLOT AND COSTS TOKENS. There is one slot; a run " +
        "started now delays every run started after it, and each one is minutes " +
        "of a real model on the owner's account. Start one when asked for that " +
        "work, not to see what it would say.",
      "`ms` IS WALL CLOCK AND `usage` IS WHAT THE BACKEND REPORTED. Absent usage " +
        "is a backend that counts no tokens, not a run that used none.",
      "A `failed` RUN WITH \"interrupted by a restart\" WAS NOT A BAD RUN. The " +
        "process stopped while it was working; whatever is in `output` is what " +
        "had been written by then.",
    ],
    views: [
      {
        key: "default",
        path: "/api/runs",
        about:
          "Every run newest first, with the one currently working, how many are " +
          "queued, and the six kinds — what each does, what it needs, its inputs " +
          "and its counts. Reports are NOT in this list; read one by its id.",
        params: [
          {
            name: "kind",
            type: "string",
            required: false,
            about: `One of ${KINDS.map((k) => k.kind).join(", ")}. Absent is every kind.`,
          },
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture's id or slug. Absent is the whole portfolio; a key that names nothing returns no runs.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 50,
            about: "How many runs to return, newest first. Clamped to 500.",
          },
        ],
      },
      {
        key: "one",
        path: "/api/runs/:id",
        about:
          "One run in full: the report as markdown (partial while it is running), " +
          "the progress steps with their timings, the input it was given, and the " +
          "parsed card suggestions.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The run id, like r-a1b2c3." },
        ],
      },
    ],
    actions: [
      {
        key: "start",
        method: "POST",
        path: "/api/runs",
        about:
          "Queue one run. It starts immediately if the slot is free and queues " +
          "behind whatever is working if not — the answer says which. This spends " +
          "minutes of the single run slot and real tokens on the owner's account. " +
          "Read the report later at /api/skills/runs?view=one.",
        params: [
          {
            name: "kind",
            type: "string",
            required: true,
            about: `Which kind: ${KINDS.map((k) => k.kind).join(", ")}. The default view describes each one and says which need a venture.`,
          },
          {
            name: "ventureId",
            type: "string",
            required: false,
            about:
              "The venture's id or slug. Required for every kind except papers, " +
              "where it is optional if a topic is given instead.",
          },
          {
            name: "focus",
            type: "string",
            required: false,
            about:
              "For research, competitors, seo and demand: one or two lines saying " +
              "what to weight. Absent asks the broad question.",
          },
          {
            name: "topic",
            type: "string",
            required: false,
            about:
              "For papers: what the paper is about, in the words a literature " +
              "search would use. With a venture chosen this may be left out.",
          },
          {
            name: "category",
            type: "string",
            required: false,
            about:
              "For geo: the category to ask for a recommendation in, in the words " +
              "a stranger would use. Absent takes them from the venture's description.",
          },
          {
            name: "questions",
            type: "string",
            required: false,
            about: "For geo: extra questions, one per line, asked as well as the three standard ones.",
          },
        ],
      },
      {
        key: "cancel",
        method: "POST",
        path: "/api/runs/:id/cancel",
        about:
          "Stop a run. A queued one is cancelled outright; a working one is " +
          "aborted, which stops it costing tokens at once. The record of it stays " +
          "— cancelling is not deleting — with whatever it had written.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The run id." },
        ],
      },
    ],
    asks: [
      "What has the box been working on, and is anything running now?",
      "Read me the SEO review it wrote for Example App 1.",
    ],
    /* A run reaches the internet on almost every kind — an agent's web search,
       OpenAlex and arXiv for a paper — and `openWorldHint` is a claim a client
       is entitled to trust when it decides whether to ask a person first. */
    openWorld: true,
  },

  {
    id: "competitors",
    title: "Competitors — the rivals on file, and when each was last checked",
    plugins: [],
    about:
      "One row per rival per venture: positioning, pricing, strengths, weaknesses, " +
      "when it was first seen and when a sweep last verified it. Built up by " +
      "competitor runs — each sweep verifies what is here, deepens it and adds " +
      "what it found — and editable by the owner.",
    rules: [
      "`lastVerified` MOVES ONLY WHEN A SWEEP NAMED THE PROFILE. A rival the newest " +
        "sweep did not mention keeps its old date, because silence is not " +
        "verification. A stale date means nobody has looked, not that nothing changed.",
      "AN OWNER'S EDIT DOES NOT VERIFY ANYTHING and does not move that date. The " +
        "date is about a sweep having checked, not about the row having been written to.",
      "PRICING IS WHAT A SWEEP READ OR THE OWNER TYPED, on a date. It is not a live " +
        "price and nothing here re-checks it; quote it with `lastVerified` every time.",
      "THESE CAME FROM A LANGUAGE MODEL READING THE WEB. A profile is a working " +
        "note, not a measurement this box made — where it matters, say which run " +
        "wrote it (`runId`) and when.",
      "A PROFILE THAT IS NOT HERE IS A RIVAL NOBODY HAS SWEPT FOR. An empty list " +
        "for a venture means no sweep has been run, not that it has no competition.",
    ],
    views: [
      {
        key: "default",
        path: "/api/competitors",
        about:
          "The profiles, newest verified first, with how many sweeps have been run " +
          "and when the last one finished.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture's id or slug. Absent is every venture's profiles.",
          },
        ],
      },
    ],
    asks: [
      "Who are Example Support's competitors and what do they charge?",
      "Which competitor profiles have not been verified in months?",
    ],
  },
];

/* ---------------------------------------------------------------- manifest */

export const manifest: IntegrationManifest = {
  id: "runs",

  routes: [
    /* The ledger, and the two file downloads that hang off a run. */
    { path: "/api/runs", app: runRoutes },
    /* What the sweeps accumulated. Mounted separately because the profiles are
       read constantly and the runs that wrote them hardly ever. */
    { path: "/api/competitors", app: competitorRoutes },
    /* The library and the written papers. */
    { path: "/api/papers", app: paperRoutes },
    /* What models say about the ventures unaided. */
    { path: "/api/geo", app: geoRoutes },
  ],

  skills,

  packs: {
    /* Filed where a person would look, which is what skills/hermes.ts asks of a
       placement: a queue of work the box is doing is productivity, and knowing
       who you are up against is marketing. */
    runs: { name: "agent-runs", category: "productivity" },
    competitors: { name: "competitor-profiles", category: "marketing" },
  },

  onStart() {
    /*
      THE REPAIR COMES FIRST, and the order matters. Any row still saying
      `running` belongs to a process that no longer exists — this one has just
      started — so it is failed with the reason before the queue is allowed to
      look for work. Doing it the other way round would let the tick see a
      `running` row, decide the slot is taken, and sit idle for ever.
    */
    const interrupted = failInterrupted();
    if (interrupted)
      console.log(
        `[runs] ${interrupted} run${interrupted === 1 ? " was" : "s were"} still marked running from before this restart — failed with "interrupted by a restart".`,
      );
    startQueue();
  },
};
