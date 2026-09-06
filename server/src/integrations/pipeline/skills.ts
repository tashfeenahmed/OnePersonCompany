/**
 * The two skills this area publishes, and the rules that come with them.
 *
 * `pipeline` IS THE SCHEDULE AND THE LEDGER. The one thing an agent must not do
 * with it is read a self-scheduled stage's last-run reading as though it were a
 * log of that stage's timer — it is the newest row that stage's area WROTE, so
 * a pass that ran and found nothing to do looks older than it is. That
 * distinction is the first rule below because it is the one an agent will
 * otherwise get wrong every single time.
 *
 * `synthesis` IS THE PROPOSALS AND THE REFUSALS. Its rules are about the
 * difference between a proposal and a decision: a filed card is a suggestion
 * with an evidence line attached, nothing has been done, and the stored packet
 * is a snapshot rather than today's figures.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "pipeline",
    title: "The nightly pipeline — one schedule for everything that runs on its own",
    plugins: [],
    about:
      "Every recurring piece of work on this box, in dependency order, with whether it is on, " +
      "how often it is due, what it may spend, and when it last ran. Plus the ledger of nights: " +
      "what each stage did, why it was skipped, what it cost, and the overnight result in prose. " +
      "Two kinds of stage live here and the difference matters — one kind the pipeline STARTS, " +
      "the other keeps its own timer in its own area and is only listed.",
    rules: [
      "`scheduledBy` is the field to read first. 'pipeline' means the nightly walk starts it and " +
        "nothing else does. 'self' means that area's own timer starts it and the pipeline never " +
        "does — so switching a self-scheduled stage off on this schedule does NOT stop it; its own " +
        "settings do. Say so rather than implying the switch works.",
      "`lastRun` means two different things and `lastRunMeans` on each row says which. For a " +
        "pipeline-scheduled stage it is the last time it COMPLETED in a real night. For a " +
        "self-scheduled stage it is the newest row that area writes — so a pass that ran and had " +
        "nothing to do reads as older than it is. Never report the second as 'it has not run since'.",
      "Four outcomes, and they are not interchangeable. completed = it ran. skipped = a DECISION " +
        "(switched off, not due, inside a blackout, a dependency did not complete, or " +
        "self-scheduled). failed = a fault, with the error. over-budget = the night's clock or " +
        "dollars ran out before its turn. Never describe a skip as a failure.",
      "`usd` is null when this box prices no tokens — that is 'unknown', never zero. A night's cost " +
        "counts only the model calls its stages made THEMSELVES; a stage that queued a sub-agent " +
        "run has that run's cost billed to the run, not to the night. Never sum the two.",
      "A run with `dry: true` was PLANNED and nothing happened. It never counts as a stage's last " +
        "successful pass and must never be reported as work done.",
      "`run` with dry false spends real money: it dispatches sub-agent runs into the single slot and " +
        "sends model calls billed to the owner. Say what it will cost before calling it, and prefer " +
        "dry when the question is 'what would happen'.",
    ],
    views: [
      {
        key: "schedule",
        path: "/api/pipeline",
        about:
          "The whole thing: settings, the stage graph in dependency order with each stage's " +
          "enablement, cadence, budget and last run, and the twenty most recent nights.",
        params: [],
      },
      {
        key: "stages",
        path: "/api/pipeline/stages",
        about: "Just the stage graph, with depth for indenting and any unknown or cyclic dependencies.",
        params: [],
      },
      {
        key: "runs",
        path: "/api/pipeline/runs",
        about: "The fifty most recent nights, newest first, planned ones included and marked.",
        params: [],
      },
      {
        key: "run",
        path: "/api/pipeline/runs/:id",
        about: "One night: its totals, its prose summary, and every stage result with reason, error, duration and cost.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The run id, from the runs view." },
        ],
      },
      {
        key: "plan",
        path: "/api/pipeline/plan",
        about:
          "What tonight would do against the clock right now, writing nothing and spending nothing. " +
          "Dependencies and the night's budget are decided during a walk and are not applied here.",
        params: [],
      },
    ],
    actions: [
      {
        key: "run_stage",
        method: "POST",
        path: "/api/pipeline/run",
        about:
          "Run the night now, or one stage of it. With `dry` true nothing is executed — each stage " +
          "reports what it WOULD do and the plan is filed beside the real nights. With `dry` false " +
          "this spends real money: sub-agent runs into the single slot and model calls on the " +
          "owner's account.",
        params: [
          {
            name: "stage",
            type: "string",
            required: false,
            about:
              "One stage id to run on its own. Omitted, the whole night walks. A single stage " +
              "ignores the night's minute budget and its dependency check — it is the owner asking " +
              "for that stage now.",
            exampled: true,
          },
          {
            name: "dry",
            type: "string",
            required: false,
            fallback: "false",
            about: "true to plan without executing. Use this unless the owner asked for the work to happen.",
            exampled: true,
          },
        ],
      },
      {
        key: "skip_tonight",
        method: "POST",
        path: "/api/pipeline/skip-tonight",
        about:
          "Do not run the scheduled night for today (the owner's own calendar day). It is a note to " +
          "the timer, not a lock: starting a night by hand still works. `cancel` true un-skips.",
        params: [
          { name: "cancel", type: "string", required: false, fallback: "false", about: "true to un-skip tonight." },
          { name: "reason", type: "string", required: false, about: "Why, for the record. At most 200 characters." },
        ],
      },
      {
        key: "set_stage",
        method: "PATCH",
        path: "/api/pipeline/stages/:id",
        about:
          "Switch a stage on or off, change how often it is due, or cap what it may spend. `null` on " +
          "any field restores that stage's own default. Switching off a SELF-SCHEDULED stage does " +
          "not stop it — its own area's settings do — and the answer says so.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The stage id." },
          { name: "enabled", type: "string", required: false, about: "true, false, or null for the default." },
          { name: "cadence", type: "string", required: false, about: "daily, weekly, monthly, or null for the default." },
          { name: "maxUsd", type: "number", required: false, about: "Dollar cap for one pass, or null for the default." },
          { name: "maxMinutes", type: "number", required: false, about: "Minute cap for one pass, or null for the default." },
        ],
      },
    ],
    asks: [
      "What ran last night, and what didn't?",
      "What would tonight do if I left it alone?",
      "Why hasn't the synthesis pass run this week?",
    ],
    openWorld: false,
  },

  {
    id: "synthesis",
    title: "Proposed actions — what the evidence says to do next, per venture",
    plugins: [],
    about:
      "The cross-source pass: for one venture it reads revenue, traffic, alerts, the board, the " +
      "goals, the assistant's memory and last week's runs, asks for at most three ranked actions, " +
      "and puts each through a deterministic gate before anything reaches the board. Both halves " +
      "are readable — what was filed, and what was refused and why.",
    rules: [
      "A filed proposal is a SUGGESTION on the board, not work done and not a decision the owner " +
        "made. Never report a proposal as an action taken.",
      "Every proposal names the evidence key it rests on and quotes the line. A proposal whose " +
        "evidence is not measured for that venture is refused by the gate and appears as dropped — " +
        "that is the feature working, not a fault.",
      "`packet` on a proposal is the evidence AS IT WAS at the time. It is a snapshot. Never quote " +
        "a figure from it as the current number; read the live document for that.",
      "In the evidence packet, a section that says NOT MEASURED carries the reason and usually the " +
        "link that would fix it. Null is never zero: 'no Umami website is linked' is not 'traffic " +
        "is zero', and reporting it as zero is the worst thing this skill can do.",
      "Coverage rotates: a venture with no recent proposals has probably not had its turn yet. " +
        "Check `coverage` before concluding that nothing was worth proposing for it.",
      "Running the pass costs one model call over the whole packet. It is not free and it is not " +
        "instant; do not run it for every venture to answer one question.",
    ],
    views: [
      {
        key: "proposals",
        path: "/api/synthesis",
        about:
          "The most recent proposals with their evidence, both filed and dropped, plus the rotation " +
          "and each venture's coverage.",
        params: [
          { name: "ventureId", type: "string", required: false, about: "A venture id or slug, to see only its proposals." },
          {
            name: "verdict",
            type: "string",
            required: false,
            about: "'filed' or 'dropped'. Use 'dropped' to see what the gate refused and why.",
          },
          { name: "limit", type: "number", required: false, fallback: 50, about: "Rows, clamped to 200." },
        ],
      },
      {
        key: "evidence",
        path: "/api/synthesis/evidence/:key",
        about:
          "The evidence packet for one venture with nothing asked of a model: seven sections, each " +
          "a measured figure with its window or null with the reason. Free to read.",
        params: [
          { name: "key", type: "string", required: true, in: "path", about: "The venture's id or slug." },
        ],
      },
    ],
    actions: [
      {
        key: "run_for_venture",
        method: "POST",
        path: "/api/synthesis/run",
        about:
          "Run the pass for one venture now. One model call over the whole evidence packet; " +
          "survivors of the gate become board cards in Backlog. `dry` true builds the packet and " +
          "asks nothing.",
        params: [
          { name: "ventureId", type: "string", required: true, about: "The venture's id or slug." },
          {
            name: "dry",
            type: "string",
            required: false,
            fallback: "false",
            about: "true to build the evidence packet and ask the model nothing.",
          },
        ],
      },
      {
        key: "set_proposals",
        method: "PATCH",
        path: "/api/synthesis/ventures/:key",
        about: "Switch proposals on or off for one venture. Off, the rotation skips it entirely.",
        params: [
          { name: "key", type: "string", required: true, in: "path", about: "The venture's id or slug." },
          { name: "proposals", type: "string", required: true, about: "true or false." },
        ],
      },
    ],
    asks: [
      "What should I do next for Example App 1?",
      "Why was that proposal dropped?",
      "Which ventures have not had a synthesis pass yet?",
    ],
    openWorld: false,
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  pipeline: { name: "pipeline", category: "productivity" },
  synthesis: { name: "synthesis", category: "productivity" },
};
