/**
 * THE ORG AREA — who works for the owner, and how the chat agent gives them
 * work.
 *
 * WHAT THIS ADDS THAT THE RUNS AREA DID NOT. The runs area gave this box six
 * APPS: six kinds of long work, each started from a page by a person who chose
 * a venture off a dropdown. That is a tool rack. It is not an org: nothing had
 * a name, nothing was anybody's job, and the only way to get work done was to
 * go and do it. This area names the workers — one per venture per role, six
 * roles, provisioned automatically — and gives the chat agent a way to send one
 * of them off, which is the difference between a dashboard with tools on it and
 * a business with staff.
 *
 * THERE IS NO NEW ENGINE UNDER IT, and that is the point rather than a
 * shortcut. A dispatched worker executes exactly the run the app would have
 * started: same kind, same inputs, same queue, same single slot, same report at
 * the same URL. A second execution path for "agent-started" work would be a
 * second place for a run to get stuck, and a ledger with two kinds of run in it
 * that had to be read two ways.
 *
 * NO `plugins` AND NO `collectors`, for the runs area's reason: nothing here
 * holds a credential — it borrows whichever agent or provider the Chief of
 * Staff is — and nothing here goes stale on a cadence. THERE IS ONE `config`
 * ENTRY and it is a pseudo-plugin, as `chat`, `models`, `capture`, `studio` and
 * `papers` are: the owner's own name, which is the top of the org chart and is
 * a decision rather than a secret.
 *
 * ONE SKILL AND NOT SEVEN. The roles are DATA on `/api/subagents` — each with
 * its kind, its app and the sentence the kind publishes about itself — so an
 * agent that reads the org can address any of them through one action, and a
 * seventh role added later needs no edit here. That is the same argument the
 * runs manifest makes about kinds, applied one layer up.
 *
 * `configure` IS NOT DESTRUCTIVE: every field it writes is a field it can write
 * back. `dispatch` IS — it spends the one run slot and real tokens — see the
 * action.
 */
import type { IntegrationManifest } from "../manifest.ts";
import type { Skill } from "../../skills/registry.ts";
import { ROLES } from "./store.ts";
import { DEFAULT_OWNER, WORKSPACE_PLUGIN, subagentRoutes } from "./routes.ts";

const ROLE_LIST = ROLES.map((r) => r.role).join(", ");

const skills: Skill[] = [
  {
    id: "subagents",
    title: "Sub-agents — the six workers on each venture, and how to dispatch one",
    /* No credential. The roster is derived from the ventures table and is there
       whether or not anything is connected; whether a dispatched worker will
       be ANSWERED depends on an agent or a provider being live, which the run's
       own error says at the point it matters. */
    plugins: [],
    about:
      "The whole organisation, top to bottom: the owner, the Chief of Staff " +
      "(that is you — the live chat backend), every venture, and the six " +
      "sub-agents on each of them. A sub-agent is a named worker with one job " +
      "and one kind of run: a Researcher, a Competitor Analyst, an SEO Analyst, " +
      "a Demand Analyst, an AI Visibility Analyst and a Paper Writer per " +
      "venture. Each carries what it is running, what it has queued, its last " +
      "run and its record. You can send one off with `dispatch`, and read what " +
      "it wrote later through the `runs` skill.",
    rules: [
      "THE PAPER WRITER'S BRIEF IS A SEARCH SUBJECT, NOT A TASK. It goes to " +
        "OpenAlex and arXiv as typed, so it is three to ten words naming the " +
        "field — `AI coding agents with persistent project memory` — and never " +
        "'conduct research on…, scout…, prepare a write-up…'. Instructions " +
        "return no papers, and no papers is a failed run one second later. " +
        "Check the run's status after dispatching a paper: a failure is " +
        "immediate and the reply's `running` is only the first second.",
      "A DISPATCH IS QUEUED WORK, NOT AN ANSWER. It returns a run that is queued " +
        "or running and no report at all — the work takes minutes. Tell the " +
        "owner it has been dispatched and use its returned report link, " +
        "then read the result later with the `runs` skill. Never " +
        "summarise a dispatch as though the worker had answered.",
      "PASS `parentSessionId` SO THE WORK IS FILED UNDER THIS CHAT. The " +
        "conversation's id is in your system turn. Without it the run is still " +
        "started, but it appears nowhere near the conversation that asked for " +
        "it and the owner has to go and find it.",
      "NEVER DISPATCH THE SAME ROLE FOR THE SAME VENTURE TWICE WHILE ONE IS " +
        "RUNNING. `running` and `queued` on each worker say so before you call. " +
        "There is ONE run slot on this box: a second copy of the same job does " +
        "not arrive sooner, it delays everything behind it and bills twice for " +
        "the same report.",
      "A SUB-AGENT WITH `enabled: false` IS SWITCHED OFF BY THE OWNER and a " +
        "dispatch to it is refused. That is a decision, not a fault — do not " +
        "switch one on to get around it unless you were asked to.",
      "A WORKER'S RUNS ARE EVERY RUN OF ITS KIND FOR ITS VENTURE, however they " +
        "were started. An SEO review the owner started from the app page is the " +
        "SEO Analyst's work too; `counts` and `lastRun` include it.",
      "THE ROSTER IS DERIVED AND CANNOT BE ADDED TO. Six roles per venture, " +
        "provisioned automatically. There is no way to create a seventh worker " +
        "or delete one, and a request for either is a request to change the " +
        "shape of this dashboard.",
    ],
    views: [
      {
        key: "default",
        path: "/api/subagents",
        about:
          "The org: the owner's name, the Chief of Staff and what is answering " +
          "as it, the six roles with what each one does and which app it runs " +
          "in, and every venture with its six workers — each carrying its " +
          "standing instructions, whether it is on, what it is running, what it " +
          "has queued, its last run and its done/failed record.",
        params: [],
      },
      {
        key: "one",
        path: "/api/subagents/:id",
        about:
          "One worker in full, with its venture and every run it has ever done, " +
          "newest first. The reports themselves are not here — read one by its " +
          "id through the `runs` skill.",
        params: [
          {
            name: "id",
            type: "string",
            required: true,
            in: "path",
            about: "The sub-agent id, which is sa-<venture id>-<role>, like sa-v-acme-seo.",
          },
        ],
      },
    ],
    actions: [
      {
        key: "dispatch",
        method: "POST",
        path: "/api/subagents/dispatch",
        /* DESTRUCTIVE on the registry's MONEY limb: it spends the single run
           slot and tokens on the owner's account, and cancelling the run does
           not get either back. The row being deletable is not the question the
           field answers. */
        destructive: true,
        about:
          "Give one worker a job. It queues a run of that worker's kind for that " +
          "worker's venture and answers immediately with the queued run — there " +
          "is no report in the answer and there will not be one for minutes. " +
          "This spends the single run slot and real tokens on the owner's " +
          "account. Refused if the worker is switched off.",
        params: [
          {
            name: "venture",
            type: "string",
            required: true,
            about: "The venture's id or slug — v-acme or acme.",
          },
          {
            name: "role",
            type: "string",
            required: true,
            about: `Which of the six: ${ROLE_LIST}. The default view says what each one does.`,
          },
          {
            name: "brief",
            type: "string",
            required: true,
            about:
              "What to look into, in a line or two — this is handed to the " +
              "worker as its brief, in front of everything this box already " +
              "measured about the venture. The owner's standing instructions " +
              "for that worker are prepended to it automatically. FOR THE PAPER " +
              "WRITER IT IS THE SUBJECT OF THE LITERATURE SEARCH — a topic of " +
              "three to ten words, `LLM-based code generation with persistent " +
              "project memory`, never instructions: it is sent to OpenAlex and " +
              "arXiv as typed, and a paragraph returns nothing and fails the run.",
          },
          {
            name: "parentSessionId",
            type: "string",
            required: false,
            exampled: true,
            about:
              "This conversation's id, which is in your system turn. Pass it so " +
              "the run is filed under this chat in the owner's rail. Left out " +
              "while a conversation is being answered, the run is filed under " +
              "that conversation; the reply says `parentSessionInferred: true` " +
              "when that happened.",
          },
        ],
      },
      {
        key: "configure",
        method: "PATCH",
        path: "/api/subagents/:id",
        about:
          "Change what the owner owns about a worker: its standing instructions, " +
          "and whether it is switched on. Standing instructions go in front of " +
          "every brief that worker is ever given, so they are orders rather than " +
          "a request — write them as the owner would.",
        params: [
          { name: "id", type: "string", required: true, in: "path", about: "The sub-agent id." },
          {
            name: "instructions",
            type: "string",
            required: false,
            about:
              "The standing instructions, replacing whatever is there. Empty " +
              "clears them.",
          },
          {
            name: "enabled",
            type: "string",
            required: false,
            about:
              "\"true\" or \"false\". A switched-off worker refuses every dispatch " +
              "until it is switched back on.",
          },
        ],
      },
    ],
    asks: [
      "Who works on Acme, and is any of them busy?",
      "Ask Acme's SEO Analyst to look at why the pricing page is not ranking.",
    ],
  },
];

export const manifest: IntegrationManifest = {
  id: "subagents",

  routes: [{ path: "/api/subagents", app: subagentRoutes }],

  config: {
    /*
      THE OWNER'S OWN NAME, which is the one thing on the org chart that is not
      derived from anything. It is a setting rather than a constant because
      "You" is a placeholder and a chart of a business with the owner's name at
      the top is a different document to look at; it is not a credential, so it
      lives here rather than in the vault, and it has to be readable back to be
      corrected — a write-only name you can never check is a name that
      eventually holds a typo for ever.
    */
    [WORKSPACE_PLUGIN]: {
      keys: {
        owner: {
          label: "Your name",
          hint:
            `What goes at the top of the org chart. Left empty it says "${DEFAULT_OWNER}", ` +
            `which is true and impersonal.`,
          ph: DEFAULT_OWNER,
          check(value) {
            return value.length > 80
              ? "That is longer than a name. The chart draws it on one line."
              : null;
          },
        },
      },
    },
  },

  skills,

  packs: {
    /* Filed where a person would look: an org chart with a queue of dispatched
       work behind it is productivity, beside the runs it starts. */
    subagents: { name: "sub-agents", category: "productivity" },
  },
};
