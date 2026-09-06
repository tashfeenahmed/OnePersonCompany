/**
 * THE `jobs` SKILL — what the agent's own scheduler is set to do, and what it
 * did.
 *
 * IT HAS NO ACTIONS, AND THAT IS THE POINT OF THE ENTRY RATHER THAN AN
 * OVERSIGHT. Scheduling belongs to the runtime that fires it: Hermes creates a
 * job with `hermes cron create`, OpenClaw with its own cron store, and this
 * dashboard has a run queue and a nightly pipeline besides. A `create_job`
 * action here would be a third clock, and the first question about any missed
 * job would become "which of the three was it in". So the skill reads, and its
 * rules say plainly whose the scheduling is and where to go to change one —
 * which is what an agent asked "remind me at nine" actually needs to know.
 *
 * THE RULES ARE ABOUT THE DIFFERENCE BETWEEN TWO RECORDS. Every job carries
 * what the RUNTIME says about its last run (from the runtime's own store) and
 * what THIS BOX read (from the output the runtime wrote). They can disagree,
 * and the disagreement is information: a run that died before writing its
 * output leaves a status in one and nothing in the other. An agent that
 * reported either as "the" answer would be hiding the case worth noticing.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "jobs",
    title: "Agent scheduled jobs",
    /* No credential: reading the runtime's own store needs none, and a box
       with neither runtime installed gets an honest "not readable" with the
       path it looked in rather than a missing skill. */
    plugins: [],
    about:
      "The scheduled jobs held by the agent runtimes this dashboard manages (Hermes, " +
      "OpenClaw), read straight out of each runtime's own store, plus the results this " +
      "box has seen and whether the owner was told about them. Jobs are the RUNTIME'S: " +
      "this reads them and relays their output, and creates, edits and fires nothing.",
    rules: [
      "Scheduling is the runtime's, not this dashboard's. To add, change or remove a scheduled job, tell the owner to ask the agent itself (Hermes: `hermes cron`) — there is no action here that can do it, and saying you have scheduled something would be false.",
      "Two records per job and they are not the same record. `lastStatus`/`lastRunAt` are what the RUNTIME'S store says; `lastSeen` is the run whose OUTPUT this box actually read. A job with a runtime status and no lastSeen ran and produced no readable output — say that, rather than reporting either half as the whole.",
      "`readable: false` on a runtime means its store could not be read, and `note` says exactly what was looked for and where. That is not 'no jobs' — never report an unreadable store as an empty schedule.",
      "A result marked `suppressedBy: \"silent\"` is a job that ran correctly and deliberately produced nothing worth a person's attention — that is the watchdog pattern working, not a failure.",
      "`suppressedBy: \"first pass\"` means the result was already on disk when this relay first ran and was never announced on purpose. It is real history and was correctly not pushed.",
      "`deliveredAt: null` with a `deliveryError` means the owner was NOT told. Say so when it matters; a relay that failed quietly is worse than one that did not run.",
      "Times are ISO 8601 UTC. For Hermes a result's `at` is when its output file was written, because the runtime's own filename stamp is local time with no zone on it — do not present it as the runtime's own printed timestamp.",
      "OpenClaw stores no output text for a scheduled run, so its results say what happened rather than what was said. Do not report that as an empty answer from the job.",
    ],
    views: [
      {
        key: "jobs",
        path: "/api/runtime/jobs",
        about:
          "Every scheduled job in each managed runtime, with its schedule in the runtime's own " +
          "words, whether it is enabled, what the runtime says about its last run, and what this " +
          "box last read and delivered.",
        params: [],
      },
      {
        key: "results",
        path: "/api/runtime/results",
        about:
          "The scheduled results this box has seen, newest first, with their delivery state.",
        params: [
          {
            name: "runtime",
            type: "string",
            required: false,
            about: 'Only this runtime — "hermes" or "openclaw". Absent means both.',
          },
          {
            name: "job",
            type: "string",
            required: false,
            about: "Only this job id, as it appears in the jobs view.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 40,
            about: "How many results, newest first. Clamped to 200.",
          },
        ],
      },
    ],
    asks: [
      "What is my agent scheduled to do?",
      "Did last night's scheduled job run, and what did it say?",
      "Was I told about the reminder that failed?",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  jobs: { name: "agent-jobs", category: "infrastructure" },
};
