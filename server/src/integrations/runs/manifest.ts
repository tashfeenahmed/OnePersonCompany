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
 * THERE IS ONE `config` ENTRY, AND IT IS A PSEUDO-PLUGIN, exactly as `capture`
 * and `studio` are on the ventures manifest and for the same reason: a paper
 * needs three things that are decisions rather than credentials — where the
 * typesetter is, how many columns a paper defaults to, and whose name goes on
 * the author line. None of them is a secret, all three have to be readable
 * back to be corrected, and a write-only field you can never check is a field
 * that eventually holds a typo for ever. `typst` empty means "go and find one",
 * which is what the box does on its own; it is filled in only to point at a
 * binary the search cannot find.
 *
 * TWO SKILLS AND NOT SIX. An agent does not need one entry per kind of run: the
 * kinds are DATA on `/api/runs` (`kinds[]`, with each one's inputs and its
 * counts), so an agent that reads the list can start any of them through one
 * action, and a seventh kind added later needs no edit here. The second entry,
 * `competitors`, is separate because the profiles outlive the runs that wrote
 * them and are a thing to read on their own — which is the test for whether
 * something is its own skill.
 *
 * `start` IS DESTRUCTIVE, AND THIS PARAGRAPH USED TO ARGUE THAT IT WAS NOT.
 * The old argument was that starting a run cannot be un-made but nothing it
 * touches can be un-made either — it writes a row, and the row deletes. That is
 * true and it is beside the point, and worse, it stated a narrower definition
 * of `destructive` than the one the type itself carries. Two contradicting
 * documents is a worse defect than either of them being wrong.
 *
 * THE ONE DEFINITION IS IN `skills/registry.ts`, on `SkillAction`, and it has
 * four limbs: the RECORD it cannot take back, the MONEY it spends, the MESSAGE
 * it sends, the MACHINE it reaches. Any one is enough. Starting a run is the
 * second limb and always has been — its own text says so in the next screenful:
 * minutes of the single run slot and tokens on the owner's account. The tokens
 * are not refunded when the row is deleted.
 *
 * IT MATTERS BECAUSE OF WHAT THE FLAG IS WIRED TO rather than what it reads
 * like. The `opc` CLI prints it before an action, the client asks for a
 * confirmation, and the direct-provider tool loop uses it as its write gate.
 * All three are asking one question — should a person look at this first — and
 * an action that quietly spends somebody's model budget on every call needs
 * that look as much as one that deletes a row.
 *
 * `cancel` IS STILL NOT DESTRUCTIVE. It stops a run and therefore spends less,
 * not more, and the record of it stays. Marking a genuinely reversible action
 * to be safe would train a client to click through the flag, which is the
 * failure the whole convention exists to prevent.
 */
import type { IntegrationManifest } from "../manifest.ts";
import type { Skill } from "../../skills/registry.ts";
import { startQueue } from "./executor.ts";
import { KINDS } from "./kinds.ts";
import { competitorRoutes, geoRoutes, paperRoutes, runRoutes } from "./routes.ts";
import { failInterrupted } from "./store.ts";
import { DEFAULT_AUTHOR, PAPERS_PLUGIN } from "./typst.ts";

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
      "A PAPER RUN'S `output` IS A NOTE ABOUT THE PAPER AND IS NOT THE PAPER. " +
        "The paper is the PDF at /api/runs/:id/pdf and the Typst source it was " +
        "set from at /api/runs/:id/typ; `paper.typeset` says which machine made " +
        "it — `typst` is a typeset document, `chrome` is markdown printed by a " +
        "browser, and null is a run that produced no PDF at all. Never describe " +
        "a `chrome` paper as typeset, and never report `pages` when it is null.",
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
          "the progress steps with their timings, the input it was given, the " +
          "parsed card suggestions, and — on a paper run — a `paper` object with " +
          "the title, thesis, contributions, which typesetter made it, how many " +
          "columns, how many pages, and the urls of the PDF and the Typst source.",
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
        /* SPENDS MONEY, therefore destructive — see the header. Not because a
           run cannot be un-made (the row deletes), but because the tokens it
           burns are not returned with it. */
        destructive: true,
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

  config: {
    [PAPERS_PLUGIN]: {
      keys: {
        typst: {
          label: "Typesetter",
          hint:
            "The full path to the `typst` binary, which is what turns a planned " +
            "paper into a typeset PDF — two columns, numbered headings and " +
            "figures, a real bibliography. Leave it EMPTY and this looks for one " +
            "itself: /opt/homebrew/bin/typst, /usr/local/bin/typst, then typst on " +
            "PATH. Fill it in only to point at one the search cannot find. With " +
            "no typesetter anywhere a paper is still written — as markdown " +
            "printed by the same Chrome the screenshots use — and the paper says " +
            "which of the two made it.",
          ph: "/opt/homebrew/bin/typst",
          check(value) {
            if (!value) return null; // cleared means "find one yourself"
            if (value.includes("\n")) return "One path, on one line.";
            if (!value.startsWith("/"))
              return "An absolute path, please — this is executed, and a relative one would depend on where the server happened to be started.";
            return null;
          },
        },
        columns: {
          label: "Default columns",
          hint:
            "1 or 2, and it is only the FLOOR: each paper's plan chooses its own " +
            "column count — two for a conventional systems paper, one for a short " +
            "argumentative one — and that choice is honoured. This is what a plan " +
            "that came back without a number falls through to. Empty means 2.",
          ph: "2",
          check(value) {
            if (!value) return null;
            if (value !== "1" && value !== "2")
              return "A paper here is one column or two. Anything else is a layout nothing in this file knows how to set.";
            return null;
          },
        },
        author: {
          label: "Author line",
          hint:
            "The name printed under the title of every paper this box writes. " +
            `Empty means “${DEFAULT_AUTHOR}” — this server has no owner's name in ` +
            "it and will not invent one, so the default is the box rather than a " +
            "person it would be guessing at. Put your own name here if the papers " +
            "are yours.",
          ph: DEFAULT_AUTHOR,
          check(value) {
            if (!value) return null;
            if (value.includes("\n")) return "One line — this is printed under the title.";
            if (value.length > 120)
              return "That is longer than an author line. It is set at ten points under the title, and it has to fit.";
            return null;
          },
        },
      },
    },
  },

  routes: [
    /* The ledger, and the three files that hang off a run: the report as
       markdown, the paper as a PDF, and the Typst source it was set from. */
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
