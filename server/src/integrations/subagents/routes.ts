/**
 * THE ORG, AND THE ONE THING YOU CAN DO TO IT.
 *
 * FOUR ROUTES AND NO CREATE. The roster is derived from the ventures table —
 * see store.ts — so there is nothing here that makes a worker and nothing that
 * destroys one. What is left is: read the org, read one worker, change the
 * three things about it that are the owner's (its name, its standing
 * instructions, whether it is on), and give it a job.
 *
 * DISPATCH IS QUEUED WORK AND NOT AN ANSWER, and the shape of this file says
 * so. It returns 201 with a run that is `queued` or `running`, never with a
 * report; whatever the worker produces is read later through the runs area,
 * which owns every word of it. A route here that waited for the report would
 * hold a socket open for four minutes and hand the caller a second, worse copy
 * of a document `/api/runs/:id` already serves properly.
 *
 * IT INSERTS THROUGH THE RUNS AREA'S OWN STORE and then stamps two columns.
 * Not through a loopback POST to /api/runs, which would work, and not with an
 * INSERT of its own, which would not: `insertRun` is where the shape of a
 * queued row is decided, and a second author for that shape is a second thing
 * to remember when a column is added. The two columns stamped afterwards are
 * the ones only a dispatch knows — which conversation asked, and which worker
 * was addressed — and they are written in a separate statement rather than
 * pushed into `insertRun`'s signature, because the runs area is not this
 * feature's and must not grow parameters for it.
 *
 * A DISABLED WORKER REFUSES WITH 409 RATHER THAN QUEUEING QUIETLY. Switching
 * one off is the owner saying "do not spend the slot or the tokens on this",
 * and a dispatch that accepted the job and then did it anyway — or accepted it
 * and silently dropped it — would be the two ways of getting that wrong.
 */
import { Hono } from "hono";
import * as inflight from "../../chat/inflight.ts";
import { configValue, db, now } from "../../db.ts";
import { activeBackend } from "../../chat/backend.ts";
import { activeProvider } from "../../models/provider.ts";
import { dossierTitle, kindDef } from "../runs/kinds.ts";
import { pump } from "../runs/executor.ts";
import { goalBriefLine } from "../chief/goals.ts";
import { workspaceOwnerName } from "../../routes/workspace.ts";
import { fencedJson } from "../runs/kinds.ts";
import { insertRun, mintRunId, queuePosition, readInput, runRow, shapeRun, type RunRow } from "../runs/store.ts";
import {
  PORTFOLIO_ROLES,
  PORTFOLIO_VENTURE,
  ROLES,
  ensureTeam,
  isPortfolioRole,
  orgChart,
  roleDef,
  briefField,
  roleInfos,
  runChild,
  shapeSubagent,
  shapeVentureCard,
  subagentId,
  subagentRow,
  subagentRuns,
  venture,
  workerRoster,
  type SubagentRow,
} from "./store.ts";

export const subagentRoutes = new Hono();

/** The pseudo-plugin the owner's own name hangs off. `chat`, `models`,
 *  `capture` and `studio` do the same thing elsewhere, and for the same
 *  foreign-key reason: plugin_config points at plugins, so a setting has to
 *  hang off something and there is no `workspace` integration. */
export const WORKSPACE_PLUGIN = "workspace";

/** What the top of the org chart is called when nobody has said. "You" rather
 *  than "Owner", because the chart is drawn for one person and it is them. */
export const DEFAULT_OWNER = "You";

/** The runs area's own limit, kept the same on purpose: a brief that this
 *  route accepted and `/api/runs` would have refused is a brief that fails
 *  later, in an executor, with nobody watching. */
const MAX_INPUT = 8_000;
const MAX_NAME = 120;
const MAX_TITLE = 80;
/** A session id is minted by the browser and is a short opaque string. The cap
 *  is here so a client that sent a whole transcript by mistake is told, rather
 *  than having it written into a column and indexed. */
const MAX_SESSION_ID = 200;

/* ------------------------------------------------------------------ shapes */

/**
 * HOW MANY SKILLS THE CHIEF OF STAFF CAN ACTUALLY READ.
 *
 * IMPORTED LAZILY, AND THAT IS A CYCLE AND NOT A STYLE. `skills/registry.ts`
 * builds its entry list at module scope out of `integrations/index.ts`, which
 * imports this area's manifest, which imports this file. A static import here
 * closes that loop, and the loop does not merely warn — it crashes the server
 * at boot with `Cannot access 'MANIFESTS' before initialization`, because the
 * registry's top-level `ENTRIES` runs while the integration list is still half
 * built. Every other area avoids it by importing only the `Skill` TYPE, which
 * erases; this is the one place that wants a VALUE out of the registry, so it
 * asks for it after everything is loaded rather than while it is loading.
 */
async function liveSkillCount(): Promise<number> {
  const { skills } = await import("../../skills/registry.ts");
  return skills().length;
}

/**
 * The Chief of Staff, as the chart draws it.
 *
 * `backend` IS WIDER THAN THE TWO AGENT IDS for chat/backend.ts's reason: when
 * no agent is live a raw provider answers the chat, and an org chart that drew
 * a connected agent there would be promising tools and memory that are not
 * present. `connected` says only that SOMETHING will answer.
 */
async function chiefOfStaff() {
  const live = activeBackend();
  const provider = live ? null : activeProvider();
  return {
    backend: live ? live.id : provider ? (`provider:${provider.id}` as const) : null,
    label: live ? live.label : (provider?.label ?? null),
    connected: live !== null || provider !== null,
    /* How many skills it can actually read, not how many exist. A count that
       included the unconnected ones would say the Chief of Staff can see a
       business it cannot. */
    skills: await liveSkillCount(),
  };
}

/** One worker in full: what the roster shows, plus the business it works on
 *  and everything it has ever been asked to do. */
function subagentDoc(row: SubagentRow) {
  const shaped = shapeSubagent(row);
  /* A PORTFOLIO WORKER IS NOT ASKED FOR ITS VENTURE AT ALL, rather than asked
     and answered null. `venture('')` would be a lookup that can only miss, and
     a null arrived at by a failed lookup is indistinguishable in the answer
     from a null that means "this worker never had one" — which is precisely
     the distinction `portfolio` on the shaped worker exists to keep. */
  const v = shaped.portfolio ? undefined : venture(row.venture_id);
  const runs = subagentRuns(row.venture_id, shaped.kind);
  return {
    ...shaped,
    /* Null for a portfolio worker, and — for a venture one — null only for the
       instant between a venture's deletion and the prune on the next read of
       the org, see store.ts's `ensureTeam`. */
    venture: v ? shapeVentureCard(v) : null,
    runs: runs.map(shapeRun),
    transcript: transcript(row, runs),
  };
}

/** How many exchanges the worker's page draws with their reports in full.
 *  Everything older is still in `runs`, as a row without its text. */
const TRANSCRIPT = 20;

/** The stored `brief` column, which `RunRow` does not declare because the
 *  column is this area's and the type is the runs area's — see the header on
 *  why the dispatch stamps its columns in a separate statement. */
type BriefedRow = RunRow & { brief?: string | null; subagent_id?: string | null; parent_session_id?: string | null };

/**
 * THE WORKER'S PAGE IS A CONVERSATION, and this is what it is made of.
 *
 * ONE EXCHANGE PER RUN: what was asked, on the right, and what came back, on
 * the left. It is drawn in the chat's shape because that is what it is — the
 * owner said something to a named worker and the worker answered — but it is
 * NOT a chat and the shape must not promise one. The composer on that page is
 * shut while a run is in flight, and every reply is a whole report rather than
 * a turn, which is why this carries the report and not a message.
 *
 * WHAT WAS ASKED IS THE `brief` COLUMN WHEN THERE IS ONE, and the kind's own
 * free-text field when there is not. A dispatched run stores the owner's words
 * before the preface was put in front of them; a run started from an app page
 * has no brief, only a form, and the form's field is what the owner typed
 * there. `asked` says which, so the page can label the second kind rather than
 * draw a form field as if somebody had said it.
 *
 * OLDEST FIRST, because a conversation reads down. `subagentRuns` answers
 * newest first for the history list, so the newest twenty are taken and then
 * turned round.
 */
function transcript(row: SubagentRow, runs: RunRow[]) {
  const def = kindDef(roleDef(row.role)?.kind ?? "");
  const field = def ? briefField(def) : null;
  return runs
    .slice(0, TRANSCRIPT)
    .reverse()
    .map((raw) => {
      const r = raw as BriefedRow;
      const input = readInput(r.input);
      const typed = typeof r.brief === "string" && r.brief.trim() ? r.brief : null;
      const cards = fencedJson(r.output, "cards");
      return {
        run: shapeRun(r),
        brief: typed ?? (field ? (input[field.key] ?? "") : ""),
        /* `dispatched` is the narrow fact the column records — a named worker
           was addressed — and `parentSessionId` is which conversation did it,
           or null for a brief typed on the worker's own page. See the 081
           migration on why neither is how a run is attributed. */
        asked: typed ? ("brief" as const) : ("form" as const),
        dispatched: !!r.subagent_id,
        parentSessionId: r.parent_session_id ?? null,
        output: r.output,
        partial: r.status === "running",
        queuePosition: r.status === "queued" ? queuePosition(r.id) : null,
        cards: Array.isArray(cards) ? cards.length : 0,
      };
    });
}

/* ------------------------------------------------------------- the reads */

subagentRoutes.get("/", async (c) => {
  const { ventures, portfolio } = orgChart();
  /* THE SUMMARY COUNTS BOTH, because it answers "how many of my team are
     busy" and a worker with no venture is still the owner's team. A summary
     that counted only the venture workers would say nothing is running while
     the one run slot was being spent on a dossier. */
  const all = [...ventures.flatMap((v) => v.subagents), ...portfolio];
  return c.json({
    /* The org's own setting first, then the name the rail already shows —
       the workspace's owner field — and "You" only when neither is set. The
       person at the top of the chart is the person whose name is on the
       workspace; asking for it twice was the bug. */
    owner: { name: configValue(WORKSPACE_PLUGIN, "owner")?.trim() || workspaceOwnerName() || DEFAULT_OWNER },
    chiefOfStaff: await chiefOfStaff(),
    roles: roleInfos(),
    ventures,
    /* THE WORKERS THAT BELONG TO NO VENTURE, top level rather than under a
       pretend venture. There is no eighth business called "Portfolio" and
       inventing one on the wire would have every reader of this document
       carrying a fake row it has to remember to exclude. */
    portfolio,
    summary: {
      subagents: all.length,
      enabled: all.filter((s) => s.enabled).length,
      /* Workers, not runs. There is one run slot on this box, so this is 0 or
         1 today — and it is counted rather than assumed, because the number
         that matters to a reader is how many of their team are busy. */
      running: all.filter((s) => s.running).length,
      queued: all.reduce((n, s) => n + s.queued, 0),
    },
  });
});

subagentRoutes.get("/roster", (c) => {
  const key = c.req.query("venture")?.trim();
  const role = c.req.query("role")?.trim();
  if (role && !roleDef(role)) return c.json({ error: "Unknown sub-agent role.", roles: roleInfos() }, 400);
  const v = key ? venture(key) : undefined;
  if (key && !v) return c.json({ error: "No venture by that id or slug." }, 404);
  if (key && role && isPortfolioRole(role)) return c.json({ error: "Portfolio roles take no venture." }, 400);
  const limit = Number(c.req.query("limit") ?? 20), offset = Number(c.req.query("offset") ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0)
    return c.json({ error: "limit must be 1–50 and offset a non-negative integer." }, 400);
  return c.json(workerRoster({ ventureId: v?.id, role, limit, offset }));
});

subagentRoutes.get("/:id", (c) => {
  const row = subagentRow(c.req.param("id"));
  if (!row) return c.json({ error: "No sub-agent by that id." }, 404);
  return c.json(subagentDoc(row));
});

/* ------------------------------------------------------------- the write */

/**
 * The three things about a worker that are the owner's.
 *
 * NOT THE ROLE AND NOT THE KIND. Those are what the worker IS — a PATCH that
 * could move the SEO Analyst onto papers would leave a row whose history
 * belongs to somebody else, because attribution is by kind and venture. A
 * worker that should be doing different work is a different worker, and there
 * are exactly six.
 */
subagentRoutes.patch("/:id", async (c) => {
  const row = subagentRow(c.req.param("id"));
  if (!row) return c.json({ error: "No sub-agent by that id." }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return c.json({ error: "Expected { name?, title?, instructions?, enabled? }." }, 400);

  const sets: string[] = [];
  const args: (string | number)[] = [];

  const text = (key: string, max: number, allowEmpty: boolean): string | { error: string } | null => {
    if (!(key in body)) return null;
    const v = body[key];
    if (typeof v !== "string") return { error: `${key} is text.` };
    const t = v.trim();
    if (!t && !allowEmpty) return { error: `${key} cannot be empty — leave it out to keep the one it has.` };
    if (t.length > max) return { error: `${key} is ${t.length} characters; the limit is ${max}.` };
    return t;
  };

  for (const [key, max, allowEmpty] of [
    ["name", MAX_NAME, false],
    ["title", MAX_TITLE, false],
    ["instructions", MAX_INPUT, true],
  ] as const) {
    const v = text(key, max, allowEmpty);
    if (v === null) continue;
    if (typeof v === "object") return c.json(v, 400);
    sets.push(`${key} = ?`);
    args.push(v);
  }

  if ("enabled" in body) {
    /* A string is accepted beside a boolean because a SKILL parameter is a
       scalar of type string or number and nothing else — see
       skills/registry.ts — so an agent calling `configure` cannot send a
       boolean at all. Anything that is neither is refused rather than coerced,
       because `enabled: "no"` read as truthy would switch a worker ON. */
    const raw = body.enabled;
    const value =
      typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : null;
    if (value === null)
      return c.json({ error: "enabled is true or false." }, 400);
    sets.push("enabled = ?");
    args.push(value ? 1 : 0);
  }

  if (!sets.length)
    return c.json({ error: "Nothing to change. Send name, title, instructions or enabled." }, 400);

  sets.push("updated_at = ?");
  args.push(now(), row.id);
  db.prepare(`UPDATE subagents SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return c.json(subagentDoc(subagentRow(row.id)!));
});

/* ---------------------------------------------------------- the dispatch */

export type DispatchBody = {
  brief?: unknown;
  parentSessionId?: unknown;
  input?: unknown;
};

/**
 * The one place a dispatch is turned into a run, shared by both doors onto
 * it — by id, and by venture plus role. Two doors, one set of rules.
 *
 * EXPORTED FOR THE SCHEDULED ROUNDS, which are a third door and must not be a
 * second set of rules. `integrations/chief/rounds.ts` calls this directly
 * rather than POSTing to itself: a loopback request from inside a timer would
 * work and would put an HTTP hop where a function call belongs, and an INSERT
 * of its own would skip the switched-off check, the standing instructions and
 * the session filing that live here.
 */
export function dispatch(row: SubagentRow, body: DispatchBody) {
  if (row.enabled !== 1)
    return {
      status: 409 as const,
      json: {
        error:
          `${row.name} is switched off, so it will not be given work. Switch it ` +
          `back on first — PATCH /api/subagents/${row.id} with { "enabled": true }.`,
      },
    };

  const def = kindDef(roleDef(row.role)?.kind ?? "");
  if (!def)
    return {
      status: 500 as const,
      json: { error: `${row.name} has role "${row.role}", which runs no kind of work this box knows.` },
    };

  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  /* AN EMPTY BRIEF IS A RUN WITH NOTHING SINGLED OUT, and it is allowed when
     the kind's brief field is optional — a competitor sweep or an SEO review
     with no focus covers what matters most, which is what the app page's
     empty box has always meant. A kind whose brief IS the subject (a dossier
     is about a person) still refuses: there is nothing to run about. */
  const field0 = briefField(def);
  if (!brief && (!field0 || field0.required))
    return {
      status: 400 as const,
      json: { error: `A dispatch is a brief: say what ${row.name} is to look into.` },
    };
  if (brief.length > MAX_INPUT)
    return {
      status: 413 as const,
      json: {
        error:
          `The brief is ${brief.length.toLocaleString()} characters. The limit is ` +
          `${MAX_INPUT.toLocaleString()} — anything longer is a document rather than a brief.`,
      },
    };

  const field = briefField(def);
  if (!field)
    return { status: 500 as const, json: { error: `${def.name} runs take no input, so there is nowhere to put a brief.` } };

  /* A STRING IS ACCEPTED AND PARSED, because the skill door and the `opc` CLI
     carry only strings and numbers: `--input '{"format":"motion"}'` is the only
     way an agent can say which format it was asked for. */
  let extra = (body.input ?? {}) as Record<string, unknown> | string;
  if (typeof extra === "string") {
    try { extra = (extra.trim() ? JSON.parse(extra) : {}) as Record<string, unknown>; }
    catch { return { status: 400 as const, json: { error: "`input` could not be read as JSON. Send an object such as {\"format\":\"motion\"}." } }; }
  }
  if (typeof extra !== "object" || extra === null || Array.isArray(extra))
    return { status: 400 as const, json: { error: "`input` is an object of the kind's other fields, or absent." } };

  const input: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
    const spec = def.inputs.find((i) => i.key === key);
    if (!spec)
      return {
        status: 400 as const,
        json: {
          error: `${def.name} runs have no input called "${key}".`,
          inputs: def.inputs.map((i) => ({ key: i.key, label: i.label, hint: i.hint })),
        },
      };
    /* REFUSED RATHER THAN OVERWRITTEN. The brief IS this field — see
       `briefField` — so a caller that also sent it meant one of the two to
       win, and quietly picking would be picking on their behalf. */
    if (spec.key === field.key)
      return {
        status: 400 as const,
        json: { error: `"${field.key}" is where the brief goes for a ${def.name} run — send it as \`brief\`.` },
      };
    if (typeof value !== "string") return { status: 400 as const, json: { error: `${spec.label} is text.` } };
    const t = value.trim();
    if (t.length > MAX_INPUT)
      return { status: 413 as const, json: { error: `${spec.label} is longer than ${MAX_INPUT.toLocaleString()} characters.` } };
    if (t) input[spec.key] = t;
  }

  /* THE FORM'S DEFAULTS, FOR A CALLER THAT IS NOT THE FORM. The run page
     prefills every input with its `default`, so a run started there always
     carries `channels: "page"`; a dispatch carries only what the dispatcher
     thought to send, and a campaign asked for in chat died in nine
     milliseconds with "A campaign needs at least one channel" (r-optkfj). The
     kind already says what an unset field means, so that is what is sent — and
     a required field with no default is refused HERE, with its hint, where the
     dispatcher can still correct it, rather than as a failed run nobody reads. */
  for (const spec of def.inputs) {
    if (spec.key === field.key || input[spec.key]) continue;
    if (spec.default.trim()) input[spec.key] = spec.default.trim();
    else if (spec.required)
      return {
        status: 400 as const,
        json: { error: `${spec.label} is required for a ${def.name} run. ${spec.hint} Send it in \`input\` as "${spec.key}".` },
      };
  }

  /*
    THE STANDING INSTRUCTIONS GO IN FRONT OF THE BRIEF, in the same field,
    labelled as the owner's. They are prepended rather than appended because
    the brief is the request and the last thing read should be what was asked;
    they are labelled because a worker reading one paragraph of orders and one
    paragraph of request must be able to tell which is which — an instruction
    that reads as part of the brief gets answered instead of followed.
  */
  const standing = row.instructions.trim();
  /*
    AND THE VENTURE'S GOALS GO IN FRONT OF BOTH, for the same reason and one
    more. The reason: a worker that does not know what the owner is trying to
    achieve writes a competent report about the wrong thing. The extra one:
    unlike the standing instructions, the goals are not orders to this worker —
    they are the owner's statement of what "good" means for this business — so
    they are labelled as goals and placed first, where they read as context
    rather than as the task. Null when nothing has been written, and then
    nothing is prepended: a heading with no body under it is worse than
    silence. See integrations/chief/goals.ts.
  */
  /* NO GOALS FOR A PORTFOLIO WORKER, and the reason is the argument above read
     backwards: goals are the owner's statement of what "good" means FOR THIS
     BUSINESS, and `goalBriefLine` takes a venture because there is no such
     statement without one. Prefacing a dossier on a stranger with Acme's
     revenue targets would not be context, it would be a steer towards reading
     one person's public record as an opportunity for one of the owner's
     companies. The standing instructions still apply: those are orders to this
     worker, and this worker exists. */
  const portfolio = row.venture_id === PORTFOLIO_VENTURE;
  const goals = portfolio ? null : goalBriefLine(row.venture_id);
  const preface = [
    goals ? `Context — ${goals}` : null,
    standing ? `Standing instructions from the owner: ${standing}` : null,
  ].filter(Boolean);
  /* With no brief the field carries the preface and the sentence the app
     page's empty box has always stood for, so a worker given only standing
     instructions still knows the task is the whole job and not the orders. */
  const asked =
    brief || `Nothing in particular has been singled out for this ${def.name.toLowerCase()} — cover what matters most.`;
  /* A LITERAL FIELD TAKES THE BRIEF AND NOTHING ELSE — see `literal` in
     runs/kinds.ts. The goals and the standing orders are prose for a model to
     read; in a field that is asked, searched or matched as typed they are not
     context, they are the query. Those workers lose the preface rather than
     have it corrupt the run (r-4ddfp6 asked a model the brief as a question). */
  input[field.key] = field.literal ? brief : preface.length ? `${preface.join("\n\n")}\n\n${asked}` : brief ? brief : "";
  if (!input[field.key]) delete input[field.key];

  const v = portfolio ? null : venture(row.venture_id);
  if (!portfolio && !v)
    return {
      status: 404 as const,
      json: { error: `${row.name}'s venture no longer exists, so there is nothing for it to work on.` },
    };

  /* The runs area's own title, byte for byte, so a dispatched run and one the
     owner started from the app page are indistinguishable in the ledger —
     which is correct, because they are the same worker's work.

     A DOSSIER IS TITLED AFTER THE PERSON, from `brief` rather than from the
     joined field: the joined field may have the owner's standing instructions
     in front of it, and a title reading "Dossier — Always check LinkedIn
     first" would be a title no second dossier on that person ever matches.
     Matching is not cosmetic here — the previous dossier is found BY TITLE,
     and it is the whole of "What changed". */
  const title =
    def.kind === "papers"
      ? `Paper — ${input.topic ?? v?.name ?? "untitled"}`
      : def.kind === "dossier"
        ? dossierTitle(brief)
        : `${def.name} — ${v!.name}`;

  const id = mintRunId();
  insertRun({ id, kind: def.kind, ventureId: v?.id ?? null, title, input });

  const stated =
    typeof body.parentSessionId === "string" && body.parentSessionId.trim()
      ? body.parentSessionId.trim().slice(0, MAX_SESSION_ID)
      : null;
  /* No parent named, one conversation being answered: it is that one. See
     chat/inflight.ts for why the server keeps this fact rather than trusting
     the agent to pass it. Several in flight is ambiguous and stays unfiled. */
  const inferred = stated ? null : inflight.only();
  const parentSessionId = stated ?? inferred;
  /* The three columns only a dispatch knows. Written here rather than through
     `insertRun`, whose signature belongs to another area — see the header. */
  db.prepare("UPDATE agent_runs SET parent_session_id = ?, subagent_id = ?, brief = ? WHERE id = ?").run(
    parentSessionId,
    row.id,
    /* The owner's words alone — see the 082 migration. The joined field the
       executor reads is in `input` and stays there. */
    brief,
    id,
  );

  /* Started now rather than at the next tick, so a box with a free slot
     answers "running" instead of "queued a moment ago". A no-op when something
     else holds the slot. */
  pump();
  /* The chat it was filed under learns at once, if it is being streamed. */
  if (parentSessionId) {
    const r = runRow(id)!;
    inflight.notify(parentSessionId, runChild(r));
  }
  return {
    status: 201 as const,
    json: {
      run: shapeRun(runRow(id)!),
      subagent: subagentDoc(subagentRow(row.id)!),
      /* Which it was: a parent the caller stated, one the server deduced
         from the conversation in flight, or none. */
      parentSessionId,
      parentSessionInferred: inferred !== null,
    },
  };
}

/**
 * ADDRESS A WORKER BY VENTURE AND ROLE.
 *
 * This door exists FOR THE SKILL. An agent that has just been told "Acme's
 * SEO Analyst" holds a venture and a role, not an id, and making it read the
 * org first to turn those into `sa-v-acme-seo` is a lookup that can fail
 * and a step that can be skipped. The ids are derivable — see store.ts — so
 * the derivation is done here once instead of by every caller.
 *
 * Declared BEFORE `/:id/dispatch` so "dispatch" is never read as an id. It
 * could not be — a POST to `/dispatch` has one segment and that route has two
 * — but the order is the thing a reader checks, so it is the order written.
 */
subagentRoutes.post("/dispatch", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | (DispatchBody & { ventureId?: unknown; ventureKey?: unknown; venture?: unknown; role?: unknown })
    | null;
  if (!body) return c.json({ error: "Expected { ventureId, role, brief }." }, 400);

  /* THREE SPELLINGS OF ONE THING, and all three are accepted rather than one
     being blessed. `ventureId` is what the runs area's own start route calls
     it, `ventureKey` is what a caller holding a slug would reach for, and
     `venture` is what the skill parameter is called because that is the word
     the agent was told. A key is a key; refusing two of the three would be a
     404 that is really a vocabulary. */
  const key =
    (typeof body.ventureId === "string" && body.ventureId.trim()) ||
    (typeof body.ventureKey === "string" && body.ventureKey.trim()) ||
    (typeof body.venture === "string" && body.venture.trim()) ||
    "";

  /*
    THE ROLE IS READ BEFORE THE VENTURE NOW, and the order is the rule rather
    than a tidy-up. Whether a venture is required is a property OF THE ROLE:
    every venture role needs one and the portfolio roles must not be given one.
    Asking "which venture?" first would refuse `role: "people"` with a question
    that has no correct answer, and would do it before anything had looked at
    what was actually asked for.
  */
  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (!roleDef(role))
    return c.json(
      {
        error:
          `"${role || "(nothing)"}" is not a role. The venture roles are ` +
          `${ROLES.map((r) => r.role).join(", ")}; the roles that belong to no venture are ` +
          `${PORTFOLIO_ROLES.map((r) => r.role).join(", ")}.`,
        roles: roleInfos(),
      },
      400,
    );

  if (isPortfolioRole(role)) {
    /* A VENTURE SENT ANYWAY IS REFUSED RATHER THAN IGNORED. A caller that named
       one believed this worker would work on it, and quietly dropping the word
       would answer a question nobody asked with a dossier filed nowhere near
       where they expected it. */
    if (key)
      return c.json(
        {
          error:
            `The ${roleDef(role)!.title} belongs to no venture, so "${key}" has nowhere to go. ` +
            `Dispatch it with role and brief alone.`,
        },
        400,
      );
    ensureTeam();
    const row = subagentRow(subagentId(PORTFOLIO_VENTURE, role));
    if (!row) return c.json({ error: `There is no ${role} on this box.` }, 404);
    const out = dispatch(row, body);
    return c.json(out.json, out.status);
  }

  if (!key) return c.json({ error: "Which venture? Send its id or slug as ventureId." }, 400);
  const v = venture(key);
  if (!v) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);

  /* Provisioning is part of the read: a venture created a second ago has a
     team by the time anything asks it to do something. */
  ensureTeam(v.id);
  const row = subagentRow(subagentId(v.id, role));
  if (!row) return c.json({ error: `${v.name} has no ${role}.` }, 404);

  const out = dispatch(row, body);
  return c.json(out.json, out.status);
});

subagentRoutes.post("/:id/dispatch", async (c) => {
  const row = subagentRow(c.req.param("id"));
  if (!row) return c.json({ error: "No sub-agent by that id." }, 404);
  const body = (await c.req.json().catch(() => null)) as DispatchBody | null;
  const out = dispatch(row, body ?? {});
  return c.json(out.json, out.status);
});
