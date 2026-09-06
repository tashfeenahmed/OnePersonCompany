/**
 * The deploy area's two skill entries.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph, and its header says why
 * that must not happen.
 *
 * TWO ENTRIES AND THEY ANSWER DIFFERENT PEOPLE'S QUESTIONS. `deploy` is the
 * one an agent reaches for when the owner says "why is nothing updating" —
 * it is about the process, its supervision and its schedule. `leases` is about
 * a shared physical machine and is the entry an agent MUST consult before it
 * offers to sleep anything.
 *
 * `deploy` HAS NO ACTIONS. Installing a service, writing a unit file and
 * uninstalling one are refused to anything holding a service key — see
 * deploy-routes.ts — so publishing them here would be publishing a tool that
 * always answers 403. `leases` has two, and both are reversible: a released
 * lease can be retaken, and a swept stale lease was not live anyway.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "deploy",
    title: "Deployment — is this box installed as a service, and is it healthy",
    /* No plugin. Like the board and the security lock, this is always live:
       "there is no service installed" is as real an answer as "there is". */
    plugins: [],
    about:
      "Whether this dashboard runs as a supervised service (launchd on macOS, a systemd user unit on Linux) or " +
      "only in somebody's terminal; what the supervisor says about it; the five health checks (database, " +
      "migrations, collector lateness, the managed agent, free disk); how often each connected source is " +
      "collected and when it is next due; and how tightly the managed agent is isolated from this process's " +
      "credentials. Also the tail of the service's own stdout and stderr logs.",
    rules: [
      "`ok: true` ON THE HEALTH DOCUMENT MEANS ONLY THAT THE PROCESS ANSWERED. It is the liveness probe the " +
        "restore tool uses and it stays true when checks fail. The verdict is `status`: `fail` is something to fix " +
        "now, `warn` is something to look at, and neither is `ok: false`. Never report a box as healthy on the " +
        "strength of `ok` alone.",
      "A CHECK'S THRESHOLD IS ON THE CHECK. Disk levels, the collector lateness multiplier and the cadences are " +
        "all in each check's `measured` object. Quote the measured figure and the threshold together — “4.1 GB " +
        "free, warns below 5 GB” — never just the verdict.",
      "`installed` AND `running` ARE DIFFERENT FACTS and they disagree legitimately: a service can be installed " +
        "and stopped. `running: null` means the supervisor could not be asked, which is not the same as stopped.",
      "IF `pid` DIFFERS FROM `thisProcessPid`, the answer came from a different copy of this app than the one the " +
        "service supervises. Say so — it is the explanation for “I changed a setting and nothing happened”.",
      "A SOURCE WITH `everyMinutes: null` IS NOT BROKEN. It has been deliberately taken off the schedule (its " +
        "setting is 0) or the whole scheduler is off (OPC_COLLECT_MINUTES=0). Its Collect button still works.",
      "THE ISOLATION LEVEL IS MEASURED, NOT INTENDED, AND THERE ARE ONLY TWO. `same-user` is the shipped " +
        "configuration and is not a vulnerability to report as one: the API boundary holds (credentials, " +
        "backups, the password and the agent processes are refused to anything that cannot show it is the " +
        "owner), and the filesystem one does not. `separate-user` is the other. A CONTAINER IS NOT A LEVEL — " +
        "`containerPath.observed` is always false and `containerPath.runtime` only says whether a docker binary " +
        "exists here. Never claim a level the document does not report, and never describe `same-user` as " +
        "isolation.",
      "`agentKeyProblem` IS NOT NULL MEANS YOUR OWN KEY FILE IS BROKEN and you are running on borrowed time: the " +
        "API could not read or rewrite it, so the next restart locks you out. Report it verbatim and say it needs " +
        "the owner at a terminal.",
      "YOU CANNOT INSTALL OR UNINSTALL THE SERVICE. Those routes refuse any caller holding a service key, so do " +
        "not offer to — it is Settings → Deployment, in a browser the owner is looking at.",
      "LOG LINES ARE WHAT THE PROCESS WROTE. Quote them; do not paraphrase a stack trace into a diagnosis, and " +
        "do not treat the absence of a log file as the absence of a problem — a service that has never started " +
        "writes none.",
    ],
    views: [
      {
        key: "default",
        path: "/api/deploy/status",
        about: "The service, the health checks, the isolation level, the per-source schedule and the live leases, in one document.",
        params: [],
      },
      {
        key: "health",
        path: "/api/deploy/health",
        about: "The five checks alone, with their measured figures and thresholds.",
        params: [],
      },
      {
        key: "schedule",
        path: "/api/deploy/schedule",
        about: "Every collectable source with its cadence in minutes, when it last started and when it is next due.",
        params: [],
      },
      {
        key: "isolation",
        path: "/api/deploy/isolation",
        about: "How the managed agent is separated from this process: the level, the file modes, and which API prefixes your own key is refused on.",
        params: [],
      },
      {
        key: "logs",
        path: "/api/deploy/logs",
        about: "The tail of the service's own log.",
        params: [
          { name: "which", type: "string", required: false, fallback: "out", about: "`out` or `err`. Anything else is read as `out`." },
          { name: "lines", type: "number", required: false, fallback: 60, about: "How many lines, clamped to 1–500." },
        ],
      },
    ],
    asks: [
      "Why has nothing been collected since yesterday?",
      "Is this dashboard installed as a service, or only running in a terminal?",
      "How much disk is left, and is the agent running?",
    ],
  },

  {
    id: "leases",
    title: "Leases — who is using a shared machine, and who woke it",
    plugins: [],
    about:
      "A lease is a claim on a shared machine — `local` for this box, `workstation:<id>` for a desk machine — " +
      "taken by a job for as long as it runs and released when it finishes. It records the kind of work (video, " +
      "inference, studio, shotsqa, manual), the venture it is for, when it was taken and when it lapses without " +
      "a heartbeat. Also who woke each machine and whether this app therefore owes it a shutdown.",
    rules: [
      "A LEASE IS NOT A LOCK AND NOT A QUEUE. Two live leases on one machine mean two jobs are sharing it, which " +
        "is ordinary. Nothing waits on a lease and nothing is refused one. The ONLY thing a live lease blocks is " +
        "putting that machine to sleep.",
      "A LAPSED LEASE IS NOT A RUNNING JOB. A lease with no heartbeat stops being live at `expiresAt` — that is " +
        "how a crashed job stops holding a machine awake. `stale` is the list of those; they are already not " +
        "live, and releasing one is bookkeeping rather than an intervention.",
      "NEVER OFFER TO SLEEP A MACHINE WITHOUT CHECKING. Read `sleep-check` for the resource first and quote its " +
        "refusal verbatim if there is one. Two reasons exist and they are fixed differently: `busy` means wait, " +
        "and `not-ours` means the machine was already awake when this app found it and is somebody else's.",
      "WE POWER OFF EXACTLY WHAT WE POWERED ON. `owns: false` on a wake record means this app did not wake that " +
        "machine, so nothing here has the right to put it back. Say that rather than offering to try.",
      "A LEASE IS EVIDENCE OF A CLAIM, NOT OF WORK DONE. It says something said it was using the machine. It is " +
        "not a measurement of GPU utilisation — that is `workstation`, which reads nvidia-smi — and the two must " +
        "never be conflated or added.",
      "RELEASING A LIVE LEASE DOES NOT STOP THE JOB. It only removes the reason not to sleep the machine. Do not " +
        "release a live lease to “free up” anything; release the stale ones, and leave live ones to their jobs. " +
        "The route enforces this rather than trusting the rule: a lease whose holder beat within the last two " +
        "minutes answers 409, and the override is the owner's own — it is not a parameter you have.",
      "A 409 ON `release` IS NOT AN ERROR TO RETRY OR WORK AROUND. It means the job is alive. Say which job, how " +
        "long it has held the machine, and that it will lapse on its own if it dies.",
    ],
    views: [
      {
        key: "default",
        path: "/api/deploy/leases",
        about: "Live leases, lapsed ones, the recent history and the wake owners.",
        params: [
          { name: "limit", type: "number", required: false, fallback: 50, about: "How many history rows, clamped to 1–500." },
        ],
      },
      {
        key: "wake",
        path: "/api/deploy/wake",
        about: "Who woke each machine, when, and whether this app owes it a shutdown.",
        params: [],
      },
      {
        key: "sleep-check",
        path: "/api/deploy/sleep-check/:resource",
        about: "May this machine be slept right now, and if not, exactly why.",
        params: [
          { name: "resource", type: "string", required: true, in: "path", about: "`local` for this box, or `workstation:<accountId>` for a desk machine." },
        ],
      },
    ],
    actions: [
      {
        key: "release",
        method: "POST",
        path: "/api/deploy/leases/:id/release",
        about:
          "Hand a LAPSED lease back. A lease whose holder is still beating — a heartbeat inside the last two " +
          "minutes — is REFUSED with 409 and cannot be forced from here: releasing it would not stop the job, it " +
          "would only remove the reason nothing will sleep the machine the job is running on. Use this on the " +
          "`stale` list, or on a lease whose job you know has gone.",
        /*
          DESTRUCTIVE, AND THE CLAIM IS EXACT RATHER THAN CAUTIOUS. The type's
          own header says the flag means "cannot be undone from here", and this
          qualifies for a reason the word "release" hides: the row can be
          replaced, but the thing at risk is not the row. Releasing the wrong
          lease permits a sleep, and a machine slept under a forty-minute
          render destroys work no action here can put back. The 409 above is
          the enforcement; this is the annotation an MCP client is entitled to
          trust when it decides whether to ask a person first.
        */
        destructive: true,
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The lease id." },
          { name: "reason", type: "string", required: false, about: "Written onto the row so the history says who released it and why." },
        ],
      },
      {
        key: "release_stale",
        method: "POST",
        path: "/api/deploy/leases/release-stale",
        about:
          "Mark every lapsed lease released. They were already not live, so nothing changes about what may be " +
          "slept; it moves them out of the stale list with a reason saying a sweep did it.",
        params: [],
      },
    ],
    asks: [
      "Is anything using the studio machine right now?",
      "Can I put the desktop to sleep?",
      "Clear out the leases from jobs that died.",
    ],
  },
];

export const PACKS: Record<string, { name: string; category: string }> = {
  deploy: { name: "service-deployment", category: "infrastructure" },
  leases: { name: "machine-leases", category: "infrastructure" },
};
