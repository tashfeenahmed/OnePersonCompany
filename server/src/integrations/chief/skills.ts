/**
 * THE FOUR SKILLS OF THE CHIEF OF STAFF AREA.
 *
 * All four have `plugins: []` — no credential makes them live or dark, because
 * none of them measures anything a credential is needed for. Goals and memory
 * are what the OWNER wrote and what the AGENT learned; rounds are what this box
 * schedules on its own; outcomes address other skills, and whether the metric
 * behind one is connected is the metric's own document's answer, given at the
 * point it matters rather than as a blanket "unavailable" here.
 *
 * THE RULES ARE THE PRODUCT, as they are everywhere on this box, and here they
 * carry more weight than usual because three of these four skills WRITE. An
 * agent that can edit a goal, delete a memory and start a paid round is an
 * agent whose rules are the only thing between the owner and an assistant that
 * has tidied its own instructions.
 */
import type { Skill } from "../../skills/registry.ts";
import { OFFSETS } from "./outcomes.ts";
import { CONTEXT_NOTES, MAX_NOTE } from "./memory.ts";
import { DEFAULT_MAX } from "./rounds.ts";

export const SKILLS: Skill[] = [
  {
    id: "goals",
    title: "Goals — what the owner is actually trying to do",
    plugins: [],
    about:
      "The owner's own words about what they are trying to achieve: one text " +
      "for the whole business and one per venture, in markdown. This is the " +
      "document every other answer should be read through — a figure that is " +
      "down against a goal the owner has abandoned is not a problem, and a " +
      "figure that is flat against the one thing they said matters is. Each " +
      "venture's entry also carries `tailorTo`, composed from the stage the " +
      "owner chose, which says what kind of advice is appropriate at all.",
    rules: [
      "THESE ARE THE OWNER'S WORDS AND YOU DO NOT EDIT THEM UNASKED. Not to " +
        "tidy the wording, not to merge two goals, not to 'update' one to " +
        "match what you have just measured. A goal you have quietly rewritten " +
        "to match reality is no longer a goal, it is a description. `set` " +
        "exists for when the owner says 'change my goal for X to Y' in that " +
        "turn, and for nothing else.",
      "A BLANK GOAL IS NOT A REQUEST FOR ONE. An owner who has written nothing " +
        "for a venture has written nothing for a venture. Say so if asked; do " +
        "not draft one and do not open every answer by asking for one.",
      "`tailorTo` IS DERIVED FROM THE STAGE AND IS NOT A GOAL. It is this " +
        "box's own sentence about what advice suits an idea, a pre-launch or a " +
        "launched venture. Do not quote it back as something the owner said.",
      "READ THE GOALS BEFORE YOU JUDGE A NUMBER. 'Traffic is down 12%' is a " +
        "fact; whether it is bad depends entirely on this document, and an " +
        "answer that ranks problems without having read it is ranking them by " +
        "size instead of by importance.",
      "GOALS ARE NOT A PLAN AND CARRY NO PROGRESS. Nothing here measures how " +
        "far along one is; there is no percentage and you must not compute " +
        "one from anything else on this box.",
    ],
    views: [
      {
        key: "default",
        path: "/api/goals",
        about:
          "Everything: the workspace-level goals, every venture's goals in the " +
          "owner's own order — including the blank ones — and each venture's " +
          "`tailorTo` line. This is the whole document and it is short.",
        params: [],
      },
      {
        key: "venture",
        path: "/api/goals/:key",
        about:
          "One venture's goals, with when they were last edited and what to " +
          "tailor advice to at its stage.",
        params: [
          {
            name: "key",
            type: "string",
            required: true,
            in: "path",
            about: "The venture's id or slug — v-example-app-1 or example-app-1.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "set",
        /* PATCH and not PUT because a skill action names one of three verbs —
           see skills/registry.ts — and the route answers both with the same
           handler. The write is a whole-document replace either way. */
        method: "PATCH",
        path: "/api/goals/:key",
        about:
          "Replace one venture's goals with text the OWNER has just given you. " +
          "The previous wording is kept in the history, so this is reversible " +
          "— but it is still the owner's document and you write in it only " +
          "when asked to in that turn. Send the owner's meaning in the owner's " +
          "register; do not improve it.",
        params: [
          { name: "key", type: "string", required: true, in: "path", about: "The venture's id or slug." },
          {
            name: "text",
            type: "string",
            required: true,
            about:
              "The goals, in markdown. An empty string clears them, which is a " +
              "thing to do only when the owner says to.",
          },
          {
            name: "by",
            type: "string",
            required: false,
            fallback: "agent",
            exampled: true,
            about: "Always send \"agent\", so the history says which paragraphs you wrote.",
          },
        ],
      },
    ],
    asks: [
      "What am I trying to do with Example Support this quarter?",
      "Which of my ventures have no goals written for them?",
    ],
  },

  {
    id: "memory",
    title: "Memory — what you know about this owner, dated",
    plugins: [],
    about:
      "Your own durable notes about the owner and their businesses: what they " +
      "decided, what a thing IS, what was tried and what came of it. Each note " +
      "carries who formed it (you, or the owner), when it was written and when " +
      "it was last confirmed. The newest " +
      String(CONTEXT_NOTES) +
      " relevant notes are already in your system turn on every conversation; " +
      "this skill is how you read the rest and how you add one.",
    rules: [
      "A NOTE IS A DATED BELIEF, NOT A FACT. Quote one with its age and its " +
        "source: 'you told me in March', 'I noticed four months ago'. A belief " +
        "from the spring asserted flatly in the autumn is how an assistant " +
        "becomes confidently wrong.",
      "THE OWNER'S EDITS WIN. A note marked `owner` is their words or their " +
        "correction of yours. Do not argue with one, do not `forget` one " +
        "unless asked, and do not write a second note that contradicts it — " +
        "if they have changed their mind, replace the note they own.",
      "NEVER REMEMBER A MEASUREMENT. 'MRR is €412', 'traffic was 1,204 last " +
        "week' — every one of those is one skill call away and stale tomorrow. " +
        "The write is refused when it reads as a snapshot. What belongs here is " +
        "the durable conclusion behind the figures, without the figures.",
      "REMEMBER WHAT THE OWNER WOULD HAVE TO SAY TWICE. A preference, a " +
        "constraint, a decision, a thing that turned out not to work. Not the " +
        "contents of this conversation, and not something already on a record " +
        "this box serves — a venture's stage is in the venture, not in here.",
      "SCOPE A NOTE TO A VENTURE WHEN IT IS ABOUT ONE. Venture notes are only " +
        "shown in conversations about that venture; a global note is shown in " +
        "every one, which is why a global note about one business is noise in " +
        "eighteen others.",
      "`forget` IS IRREVERSIBLE FROM HERE. There is no undo on a single note — " +
        "the undo covers the weekly consolidation pass, not your delete.",
    ],
    views: [
      {
        key: "default",
        path: "/api/memory",
        about:
          "Every note, newest-confirmed first, with its scope, its source, its " +
          "dates and its age in days. Also the weekly consolidation ledger and " +
          "whether an undo is available.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture id to see only that venture's notes. Left out, all of them.",
          },
          {
            name: "scope",
            type: "string",
            required: false,
            about: "`global` or `venture`, to see one kind. Left out, both.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "remember",
        method: "POST",
        path: "/api/memory",
        about:
          "Write down one durable fact. A restatement of something already " +
          "here is not duplicated — it moves that note's 'last confirmed' " +
          "forward, which is what makes 'still true' expressible. A note that " +
          "reads as a metrics snapshot is refused with a reason.",
        params: [
          {
            name: "text",
            type: "string",
            required: true,
            about: `One sentence, at most ${MAX_NOTE} characters. Longer than that is a report.`,
          },
          {
            name: "venture",
            type: "string",
            required: false,
            exampled: true,
            about:
              "The venture's id or slug when the note is about one business. " +
              "Left out, the note is global and appears in every conversation.",
          },
        ],
      },
      {
        key: "forget",
        method: "DELETE",
        path: "/api/memory/:id",
        /* DESTRUCTIVE, on the registry's own test: there is no way back from
           here. The consolidation undo restores a whole pass, not a note the
           agent deleted on purpose. */
        destructive: true,
        about:
          "Delete one note, because it is wrong or the owner has said to stop " +
          "believing it. There is no undo for this.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The note's id, from the default view." },
        ],
      },
    ],
    asks: [
      "What do you know about how I like to work?",
      "Remember that I have decided not to do paid acquisition for any of these.",
    ],
  },

  {
    id: "rounds",
    title: "Rounds — the scheduled walk over every venture",
    plugins: [],
    about:
      "The estate's own schedule: at an hour the owner sets, this box walks the " +
      "ventures and gives the configured sub-agent roles a job on the ones that " +
      "are due — skipping quiet stages, respecting a per-venture cadence, and " +
      "never spending more than the round's cap of the single run slot. The " +
      "document carries the schedule, the last rounds, and a ledger of every " +
      "scheduled job including the ones that became nothing.",
    rules: [
      "A ROUND IS QUEUED WORK, NOT AN ANSWER. `start_now` returns as soon as " +
        "the runs are queued and carries no report at all. Say what was " +
        "dispatched and where it will land; read the results later through the " +
        "`runs` skill. Never summarise a round as though the work were done.",
      "IT SPENDS THE ONE SLOT AND REAL TOKENS. Up to " +
        String(DEFAULT_MAX) +
        " runs by default, each of them minutes of model time on the owner's " +
        "account, and everything the owner starts by hand queues behind them. " +
        "Do not start one to 'have a look' — ask first unless you were told to.",
      "IT NEVER RE-DISPATCHES A ROLE THAT IS ALREADY RUNNING OR QUEUED for " +
        "that venture, and neither should you. A second copy of the same job " +
        "does not arrive sooner; it delays everything behind it and bills " +
        "twice for one report.",
      "A SKIP IS A DECISION AND NOT A FAILURE. `skipped` covers a quiet stage, " +
        "a venture inside its cadence, a spent cap and a worker already busy; " +
        "`refused` is a worker the owner switched off. None of those is a " +
        "fault and reporting them as errors would send the owner looking for a " +
        "bug in their own settings.",
      "THE SCHEDULE IS SETTINGS AND YOU DO NOT CHANGE IT. The hour, the roles, " +
        "the cadence, the cap and the quiet stages are on the rounds settings " +
        "page. There is no action here that writes them, deliberately: an " +
        "assistant that could widen its own schedule is an assistant with no " +
        "schedule.",
    ],
    views: [
      {
        key: "default",
        path: "/api/rounds",
        about:
          "The schedule with its next run, the last twenty rounds with what " +
          "each considered and dispatched, and the hundred most recent " +
          "scheduled jobs with their outcomes and reasons.",
        params: [],
      },
      {
        key: "schedule",
        path: "/api/rounds/schedule",
        about:
          "Just the schedule: whether it is on, the hour and time zone, which " +
          "roles run, the cap, the per-venture cadence, the quiet stages and " +
          "the next run.",
        params: [],
      },
    ],
    actions: [
      {
        key: "start_now",
        method: "POST",
        path: "/api/rounds/now",
        about:
          "Walk the estate now, with the owner's own settings — the same walk " +
          "the timer does, not a wider one. It dispatches real runs into the " +
          "single slot and spends real tokens, and answers immediately with " +
          "what it queued and what it skipped. Refused while a round is " +
          "already walking.",
        params: [],
      },
    ],
    asks: [
      "Did anything run on its own last night, and on which ventures?",
      "Why hasn't Example App 1 been looked at by a round?",
    ],
  },

  {
    id: "outcomes",
    title: "Outcomes — whether a thing that was done changed a number",
    plugins: [],
    about:
      "Links between something the owner DID — a board card finished, a run's " +
      "report acted on, or a dated note — and a METRIC addressed the way every " +
      "figure on this box is addressed: a skill, a view, its parameters and a " +
      "path into the document. Each link has a baseline read when it was made " +
      "and readings at " +
      OFFSETS.join(", ") +
      " days after the action, and the document computes the before, the " +
      "after, the change and a coarse verdict with the window stated.",
    rules: [
      "CORRELATION, NOT CAUSATION, AND SAY IT EVERY TIME. Two figures either " +
        "side of a date are two figures either side of a date. One person " +
        "shipping one thing on one Tuesday is an anecdote with arithmetic on " +
        "top. Never say a change 'caused', 'drove' or 'led to' anything; say " +
        "what moved, over what window, and that nothing here controls for " +
        "anything else.",
      "A METRIC THAT COULD NOT BE READ IS `null`, NEVER ZERO. A reading with " +
        "an `error` beside it means the plugin was disconnected, the field " +
        "moved, or the document reported null. Report it as not measured. A " +
        "null baseline makes the verdict `unreadable`, which is not `flat`.",
      "`pending` MEANS TOO EARLY AND IS THE RIGHT ANSWER FOR DAYS. There is no " +
        "verdict until a reading has been taken after the action; `due` says " +
        "when the next one falls. Four days of an upward wobble is not an 'up'.",
      "THE BAND IS COARSE ON PURPOSE. Anything within ±" +
        "10% is `flat`, because a small site's numbers move that much between " +
        "Tuesdays for no reason at all. Do not report a 4% change as an " +
        "improvement, and do not compute a finer verdict of your own.",
      "`pct` IS NULL WHEN THE BASELINE WAS ZERO, and the delta is still there. " +
        "Zero before and fifty after is not an infinite improvement, it is " +
        "fifty from nothing — say it that way.",
      "TRACK WHAT THE METRIC ACTUALLY MEASURES. A path onto a de-duplicated " +
        "figure (unique visitors, reach) or a ranked breakdown is not a total " +
        "and the universal rules still apply to it; a figure in one currency " +
        "is not comparable with one in another.",
    ],
    views: [
      {
        key: "default",
        path: "/api/outcomes",
        about:
          "Every tracked outcome with its action, its metric address, its " +
          "baseline, every reading (including the failed ones), the before, " +
          "the after, the change, the verdict and the window in words.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture id or slug, to see only that venture's outcomes.",
          },
        ],
      },
      {
        key: "one",
        path: "/api/outcomes/:id",
        about: "One outcome in full, with all of its readings.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The outcome's id." },
        ],
      },
    ],
    actions: [
      {
        key: "track",
        method: "POST",
        path: "/api/outcomes",
        about:
          "Start tracking one action against one metric. The baseline is read " +
          "immediately, so the link is only as good as the metric being " +
          "readable now; a baseline that failed is recorded with its reason " +
          "rather than as a zero. Readings follow automatically at " +
          OFFSETS.join(", ") +
          " days after the action's own date.",
        params: [
          {
            name: "title",
            type: "string",
            required: true,
            about: "What was done, in a few words. This is what the owner will read.",
          },
          {
            name: "skill",
            type: "string",
            required: true,
            about:
              "The id of the skill that serves the metric — `umami`, `stripe`, " +
              "`gsc`. It must be a skill this box has, and it must be connected " +
              "or the baseline will fail.",
          },
          {
            name: "path",
            type: "string",
            required: true,
            about:
              "The field inside that document, dotted, with [n] for array " +
              "indices: `totals.visitors`, `sites[0].pageviews`. Read the " +
              "document first and copy the path; a guessed one records a " +
              "baseline that says the field does not exist.",
          },
          {
            name: "view",
            type: "string",
            required: false,
            fallback: "default",
            about: "Which view of that skill, when it is not the default one.",
          },
          {
            name: "params",
            type: "string",
            required: false,
            about:
              "The view's parameters as a JSON object — {\"days\":\"30\"}. They " +
              "are sent on every reading, so the window is the same one every " +
              "time.",
          },
          {
            name: "actionAt",
            type: "string",
            required: true,
            about:
              "The day the thing was DONE, YYYY-MM-DD — not today, unless it was " +
              "today. Every reading is offset from this. A future date is " +
              "refused.",
          },
          {
            name: "actionKind",
            type: "string",
            required: false,
            fallback: "note",
            about: "`card` for a board card, `run` for a run's report, `note` for anything else.",
          },
          {
            name: "actionRef",
            type: "string",
            required: false,
            about: "The card id or run id, where there is one.",
          },
          {
            name: "actionText",
            type: "string",
            required: false,
            about: "What was done, at more length than the title. Defaults to the title.",
          },
          {
            name: "venture",
            type: "string",
            required: false,
            about: "The venture this was work for, by id or slug.",
          },
          {
            name: "unit",
            type: "string",
            required: false,
            about:
              "What the figure is counted in, in the owner's words — 'visitors', " +
              "'EUR/month'. Left out it is null and nothing here will guess it.",
          },
        ],
      },
    ],
    asks: [
      "Did the pricing page rewrite do anything to signups?",
      "What have I done in the last month that actually moved a number?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  /* All four are `productivity`: they are the machinery of running the
     business rather than a measurement of it, and they sit beside `sub-agents`
     and the board where a person would look for them. `agent-memory` rather
     than `memory` because Hermes has a bundled skill by that name and two packs
     cannot share one. `rounds-and-schedule` for the same class of reason: it is
     the schedule as much as the walk, and the longer name is what somebody
     scanning a pack list would recognise. */
  goals: { name: "goals", category: "productivity" },
  memory: { name: "agent-memory", category: "productivity" },
  rounds: { name: "rounds-and-schedule", category: "productivity" },
  outcomes: { name: "outcomes", category: "productivity" },
};
