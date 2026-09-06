/**
 * A BOUNDED TOOL LOOP FOR A DIRECT MODEL PROVIDER.
 *
 * THE GAP THIS CLOSES, in the words the gap analysis used: "OPC's direct
 * model-provider fallback is explicitly text-only; business tools require a
 * connected agent such as Hermes or OpenClaw. Connecting a model key alone
 * therefore does not make chat capable of checking live business data."
 *
 * routes/chat.ts was right to refuse the skills preamble to a raw model: "a
 * model asked to fetch something it cannot fetch does not say so, it writes
 * down what the answer would probably have been." That is an argument about a
 * model with no way to call anything. Given one that CAN call a function, the
 * skills registry is already a list of typed, documented, rule-carrying calls,
 * and this file is the loop that runs them.
 *
 * IT IS NOT A SECOND AGENT. What Hermes has that this does not is memory
 * across turns, a terminal, a filesystem, its own scheduler and its own
 * judgement about when to stop. What this has is exactly the skills the owner
 * has connected, a hard ceiling on how many times it may reach for them, and
 * nothing else. That is the honest middle: a model-only installation that can
 * answer "what did Stripe collect last week" from the collected data rather
 * than from its own head.
 *
 * FIVE BOUNDS, AND EVERY ONE OF THEM IS A SETTING RATHER THAN A CONSTANT.
 *
 *   CALLS      at most N tool calls in one turn (default 12). Past the
 *              ceiling the tools are taken away and the model is asked to
 *              answer with what it has and say what it could not check. The
 *              loop never simply stops mid-investigation and returns nothing.
 *   WALL TIME  a turn's whole budget in seconds (default 180). Not the same as
 *              the per-call timeout, which the provider's policy owns: twelve
 *              calls each taking their full timeout is twenty-four minutes of
 *              a page spinning.
 *   DOLLARS    a per-turn ceiling read back out of `budget_usage`. Every round
 *              reserves against ONE run id (see the context below), so the
 *              existing per-run limits in runtime/budgets.ts bound this loop
 *              for free, and this area's own `turn_usd` is a second, tighter
 *              one for the owner who wants chat capped separately from runs.
 *   BYTES      every tool result goes through agentcore's response budget —
 *              scalars kept, rows shortened with a marker carrying the REAL
 *              total, nothing ever cut mid-value.
 *   WRITES     off by default. With writes on, a DESTRUCTIVE action is still
 *              refused — see `refuseDestructive` below.
 *
 * ONE RUN CONTEXT FOR THE WHOLE TURN, and it is the reason the dollar bound
 * works. `completeTooled` reserves against `runContext`'s id; without a shared
 * one, each round would open its own `direct:<uuid>` context and a "per-run"
 * ceiling would mean "per round". The context object is created once here and
 * handed to `runContext.run` around each model call rather than wrapped around
 * the generator — AsyncLocalStorage does not survive a generator's suspension,
 * so wrapping the loop body would silently lose the store on the second round.
 *
 * IT PLUGS INTO THE RUN ENGINE RATHER THAN AROUND IT. This is an
 * `AsyncGenerator<ChatStreamEvent>` — the same contract `ChatBackend.stream`
 * has — so routes/chat.ts hands it to `startChatRun` as the turn's `open()`.
 * Reattach after a reload, the stop button, the partial row, the tool lines in
 * the transcript with their offsets: all of that is chat/runs.ts's and none of
 * it is reimplemented here.
 *
 * NO STREAMING WITHIN A ROUND, AND THAT IS A STATED LIMITATION RATHER THAN AN
 * OVERSIGHT. `models/provider.ts` owns the limiter and has no streaming path;
 * each round is one whole completion. The owner does not watch the words
 * appear, but they DO watch the tool lines appear — one `tool` event per call,
 * running then completed — which is the part that says the answer is being
 * built out of their own data rather than out of the model's memory.
 */
import type { ChatStreamEvent, ChatTurn } from "../../chat/backend.ts";
import { serviceHeaders } from "../../auth.ts";
import { runContext, spentOnRun } from "../../runtime/budgets.ts";
import { activeModel, activeProvider, completeTooled, type ProviderId, type ToolWireTurn } from "../../models/provider.ts";
import { apiBase, entry, isLive, skills, UNIVERSAL_RULES } from "../../skills/registry.ts";
import { PRESENT_BRIEF } from "../../skills/present.ts";
import { boundResponse } from "../agentcore/bound.ts";
import { responseBudget } from "../agentcore/store.ts";
import { knownMode, verdictFor } from "./probe.ts";
import { settings, writeCapability } from "./store.ts";
import {
  actionGate,
  allowedActions,
  assistantCallTurn,
  catalogBytes,
  indexTools,
  messageText,
  parseToolCalls,
  renderTools,
  resultRules,
  resultTurn,
  routeName,
  skillEntryDoc,
  skillIndexDoc,
  toolsFor,
  type ToolCall,
  type ToolDef,
} from "./tools.ts";

/* ---------------------------------------------------------------- preamble */

/**
 * WHAT THE MODEL IS TOLD BEFORE IT SEES A TOOL, and why it is not `preamble()`.
 *
 * `skills/registry.ts`'s preamble is written for an agent that must compose
 * HTTP requests — "GET http://127.0.0.1:8787/api/skills/<id>" — and handing
 * that to a model that has the same documents as TOOLS is the failure the
 * `withSkills` header describes in the other direction: two sets of
 * instructions about one subject, and a model choosing between them. A model
 * with a tool named `opc_stripe` must not be told to curl anything.
 *
 * So this says the four things that are true of the tools and nothing that is
 * true only of the URLs: the universal honesty rules, the shape of a
 * truncation marker, the ceiling on how many calls it has, and what a refusal
 * means. It ends with the presentation brief, because a model that can read a
 * document should also be able to draw it.
 */
export function toolPreamble(opts: { calls: number; actions: boolean; surface: "per-skill" | "index" }): string {
  const lines = [
    `You can read this dashboard's own live, measured data by calling the tools below. ` +
      `Every one of them reads a document a collector on this machine already wrote — ` +
      `there is no guessing and no browsing. If a question is about the owner's business, ` +
      `CALL A TOOL rather than answering from memory; if no tool covers it, say so plainly.`,
    ``,
    `You may make at most ${opts.calls} tool call${opts.calls === 1 ? "" : "s"} in this turn. ` +
      `After that the tools are taken away and you must answer with what you have, naming ` +
      `the part you could not check.`,
    ``,
    opts.actions
      ? `Some tools CHANGE the owner's data. Call one only when the owner has asked for that ` +
        `exact change in this conversation. Irreversible actions are refused here and the ` +
        `refusal says where the owner can do it themselves — pass that on rather than retrying.`
      : `Every tool here only READS. Nothing you can call changes the owner's data. If the ` +
        `owner asks you to change something, say that writing is switched off for a direct ` +
        `model connection and where to switch it on (Integrations → Agent tools & jobs).`,
    ``,
    opts.surface === "index"
      ? `This box has more integrations than fit in one tool list, so they are behind three ` +
        `tools rather than one each: opc_skills lists them (and, given one id, gives that ` +
        `one's views, parameters and rules in full), opc_read fetches its figures, and its ` +
        `\`skill\` parameter already names every one that exists. Read an integration's entry ` +
        `before sending parameters you are not sure of.`
      : `Each integration is one tool named opc_<id>. Its parameters are on the tool itself; ` +
        `the rules for reporting its figures come back WITH its answer and are not optional.`,
    ``,
    `A LARGE ANSWER IS SHORTENED, NOT CUT. A list that did not fit ends with`,
    `{"truncated":true,"shown":N,"total":T} — T is the real total: report T, never N. An "_omitted"`,
    `count on an object means fields were dropped from the end of it as well.`,
    `To see more: pass limit/offset where the tool lists them, narrow the window (fewer days,`,
    `one venture), or pass fields=<comma-separated top-level keys>. "_bounded".next at the root of`,
    `the document names which of those applies to that call.`,
    `Nothing is ever cut mid-value, so a document that parses is complete as far as it goes.`,
    ``,
    `Always:`,
    ...UNIVERSAL_RULES.map((r) => `- ${r}`),
    ``,
    PRESENT_BRIEF,
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------- tool calling */

/**
 * WHAT ONE CALL MEANS, whichever surface it came from.
 *
 * The loop has two possible tool surfaces — one tool per skill, or the
 * three-tool index when that would not fit (see `indexTools`) — and they
 * differ only in how a call NAMES the thing it wants. Resolving that here,
 * once, is what keeps the executor below identical for both: past this
 * function there is a skill id, an optional view or action, and a bag of
 * parameters, and nothing downstream knows which surface produced them.
 *
 * `params` MAY ARRIVE AS AN OBJECT OR AS A STRING OF JSON, because models do
 * both — a nested object parameter is the shape most of them emit and a
 * stringified one is what several small ones emit instead. Refusing the second
 * would be refusing a call the model meant correctly.
 */
type Resolved =
  | { kind: "index"; skill: string | null }
  | { kind: "read"; id: string; view: string | null; params: Record<string, unknown>; fields: string[] }
  | { kind: "act"; id: string; action: string; params: Record<string, unknown> }
  | { kind: "unknown"; why: string };

function bag(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      /* Not JSON. Treated as no parameters rather than as a failure: the proxy
         will answer with what the view actually takes, which is more use to
         the model than a complaint about quoting. */
    }
  }
  return {};
}

const fieldList = (v: unknown) =>
  String(v ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

function resolve(call: ToolCall, defs: ToolDef[]): Resolved {
  if (call.name === "opc_skills")
    return { kind: "index", skill: typeof call.args.skill === "string" ? call.args.skill : null };

  if (call.name === "opc_read") {
    const id = String(call.args.skill ?? "").trim();
    if (!id) return { kind: "unknown", why: "opc_read needs a `skill`." };
    return {
      kind: "read",
      id,
      view: typeof call.args.view === "string" && call.args.view.trim() ? call.args.view.trim() : null,
      params: bag(call.args.params),
      fields: fieldList(call.args.fields),
    };
  }

  if (call.name === "opc_act") {
    const id = String(call.args.skill ?? "").trim();
    const action = String(call.args.action ?? "").trim();
    if (!id || !action) return { kind: "unknown", why: "opc_act needs a `skill` and an `action`." };
    return { kind: "act", id, action, params: bag(call.args.params) };
  }

  const def = defs.find((d) => d.name === call.name);
  if (!def) {
    /*
      A NAME THAT WAS NOT PUBLISHED MAY STILL BE A REAL ACTION, and answering
      "there is no tool called that" about one would be false and useless. The
      allow-list removes a spend-or-send action from the tool list, so a model
      that read the registry some other way — or guessed from the naming
      pattern, which is regular — reaches for a name that exists. Routing it to
      the gate produces the sentence that helps: what it is, why this door will
      not press it, and who can.
    */
    const guess = routeName(call.name);
    const s = entry(guess.id);
    if (guess.action && s && (s.actions ?? []).some((a) => a.key === guess.action)) {
      const params: Record<string, unknown> = { ...call.args };
      delete params.view;
      delete params.fields;
      return { kind: "act", id: guess.id, action: guess.action, params };
    }
    return { kind: "unknown", why: `There is no tool called "${call.name}".` };
  }
  /* The per-skill surface puts the view and the parameters side by side in one
     flat object, which is what a derived schema can express; `view` and
     `fields` are this layer's and are lifted out of the rest before the rest
     is forwarded. */
  const params: Record<string, unknown> = { ...call.args };
  const view = params.view;
  const fields = params.fields;
  delete params.view;
  delete params.fields;
  return def.action
    ? { kind: "act", id: def.skillId, action: def.action, params }
    : {
        kind: "read",
        id: def.skillId,
        view: typeof view === "string" && view.trim() ? view.trim() : null,
        params,
        fields: fieldList(fields),
      };
}

/**
 * WHY A REFUSED ACTION IS REFUSED RATHER THAN CONFIRMED, TODAY.
 *
 * The right shape is a `confirm` event: the loop pauses, the page asks the
 * owner, and the answer resumes the run. Two of those three pieces do not
 * exist — chat/runs.ts has no pause/resume (a run is one forward pass with a
 * cancel), and the chat page has no affordance to answer with. Building a
 * confirmation the client cannot render would be a run that hangs until its
 * wall clock kills it, with the owner watching a spinner and no way to say
 * yes.
 *
 * So everything off `actionGate`'s allow-list is refused, and the refusal is
 * written for the MODEL to pass on rather than to retry: it names the action,
 * says in one clause WHY this door will not press it, and says where the owner
 * does it themselves. The gate's own header has the argument for why an
 * allow-list; this function is only the sentence.
 */
function refuseAction(id: string, action: string, why: string): string {
  return JSON.stringify({
    error:
      `Refused: ${why}, and a direct model connection has no way to ask the owner first — ` +
      `this chat has no confirmation step. Tell the owner what you would have done and that ` +
      `they can do it themselves from the ${id} page, or with \`opc ${id} ${action} …\`.`,
    refused: `${id}.${action}`,
    reason: "not on the allow-list for a direct model connection, and no owner confirmation is available here",
  });
}

/**
 * ONE TOOL, THROUGH THE SKILLS PROXY AND NOT AROUND IT.
 *
 * A LOOPBACK FETCH RATHER THAN AN INTERNAL DISPATCH, on routes/skills.ts's own
 * argument: the proxy is what knows which parameters a view accepts, which
 * value belongs in a path segment, that an unknown id answers 404 with the
 * list and a disconnected one answers 409 with the credential that is missing.
 * Reimplementing any of that here would be a second opinion about what exists,
 * and the failure mode of a second opinion is the day one of them is relaxed
 * and the other is not.
 *
 * THE RULES COME BACK WITH THE ANSWER. See `resultRules` in tools.ts for why
 * they are here rather than in the tool description — the short version is
 * that this loop owns the result, so the rules can be the last thing the model
 * reads before writing the sentence they govern, and are paid for once per
 * call instead of once per turn per skill.
 *
 * A NON-200 IS RETURNED AS THE TOOL'S CONTENT, unbounded. These routes explain
 * themselves — a 409 names the missing credential, a 400 lists the parameters
 * — and shortening a refusal could only take something away from a short
 * document whose whole value is that it is complete.
 */
async function runTool(
  call: ToolCall,
  defs: ToolDef[],
  allowActions: boolean,
  signal: AbortSignal,
): Promise<string> {
  if (call.badJson !== null)
    /* A small model emits malformed JSON regularly and usually recovers on
       being told. Saying so in the tool result is cheaper than a failed turn. */
    return JSON.stringify({ error: "arguments were not valid JSON", received: call.badJson });

  const r = resolve(call, defs);
  if (r.kind === "unknown")
    return JSON.stringify({ error: r.why, tools: defs.map((d) => d.name) });

  if (r.kind === "index") {
    const live = skills();
    if (!r.skill) return bounded(JSON.stringify(skillIndexDoc(live, { actions: allowActions })));
    const s = entry(r.skill);
    if (!s || !isLive(s))
      return JSON.stringify({
        error: `There is no connected integration called "${r.skill}".`,
        skills: live.map((x) => x.id),
      });
    return bounded(JSON.stringify(skillEntryDoc(s, { actions: allowActions })));
  }

  const s = entry(r.id);
  if (!s || !isLive(s))
    return JSON.stringify({
      error: `There is no connected integration called "${r.id}".`,
      skills: skills().map((x) => x.id),
    });

  if (r.kind === "act") {
    if (!allowActions)
      return JSON.stringify({
        error:
          "Writing is switched off for a direct model connection. Tell the owner what you " +
          "would have changed; they can turn writes on under Integrations → Agent tools & jobs, " +
          "or make the change themselves.",
      });
    const a = (s.actions ?? []).find((x) => x.key === r.action);
    if (!a)
      return JSON.stringify({
        error: `${r.id} has no action called "${r.action}".`,
        actions: allowedActions(s).map((x) => x.key),
      });
    /* THE GATE IS RE-CHECKED HERE AND NOT ONLY AT PUBLICATION TIME. The index
       surface's `opc_act` takes an action NAME rather than choosing from a
       list, so a model that has read the registry some other way — or simply
       guessed — can name one that was never published. This is the check that
       actually holds. */
    const verdict = actionGate(s, a);
    if (!verdict.ok) return refuseAction(r.id, r.action, verdict.why);

    const res = await fetch(
      `${apiBase()}/api/skills/${encodeURIComponent(r.id)}/${encodeURIComponent(r.action)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...serviceHeaders() },
        /* THE ARGUMENTS VERBATIM, NULLS INCLUDED. A null is how a field is
           CLEARED — routes/board.ts on absent versus null — so dropping them
           would turn "remove the due date" into a call that changes nothing
           and reports success. */
        body: JSON.stringify(r.params),
        signal,
      },
    );
    /* AN ACTION'S ANSWER IS THE THING THAT WAS JUST CHANGED, and the id of
       what was created is in it and nowhere else — so it is bounded rather
       than trimmed, and in the ordinary case (a small document) `bounded`
       returns it byte for byte. What this catches is the route that answers a
       write with a list, or a 500 with a stack in it. */
    return bounded(await res.text(), "the write happened; ask for the record it made");
  }

  const qs = new URLSearchParams();
  if (r.view) qs.set("view", r.view);
  for (const [k, v] of Object.entries(r.params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  const res = await fetch(
    `${apiBase()}/api/skills/${encodeURIComponent(r.id)}${qs.size ? `?${qs}` : ""}`,
    { method: "GET", headers: serviceHeaders(), signal },
  );
  const body = await res.text();
  /* A REFUSAL EXPLAINS ITSELF and is short, so the budget takes nothing from
     it — but "short" is a property of the answers these routes mean to send
     and not of the ones they can, and a stack trace is neither short nor
     useful whole. */
  if (!res.ok) return bounded(body, `ask ${r.id} again with what the message above asks for`);

  const bound = boundResponse(body, {
    budget: responseBudget().bytes,
    fields: r.fields,
    how:
      `ask ${r.id} again with a narrower window, or with limit/offset where its parameters ` +
      `list them, or with fields=<top-level keys> to keep only part of it`,
  });
  const rules = resultRules(s);
  return [bound.text, bound.note ? `NOTE: ${bound.note}` : "", rules].filter(Boolean).join("\n\n");
}

/**
 * EVERY TOOL ANSWER GOES THROUGH THE BUDGET, WITH NO EXCEPTIONS LEFT.
 *
 * Three of them used to be exempt and each had an argument: an ACTION's reply
 * is the thing that was just changed and is small; a REFUSAL explains itself
 * and shortening it could only take something away; the catalog is this file's
 * own document and was assumed to fit. The first two are true of the answers
 * those routes MEAN to send and not of the ones they can send — a 500 with a
 * stack trace is a refusal, and a route that grows a list in its create
 * response is an action reply that is no longer small. The third was measured
 * and wrong: the live catalog is 61 KB, two and a half times the budget, and
 * the whole reason the index surface exists is that 60 KB will not fit.
 *
 * So the budget is unconditional and the README's table means what it says.
 * Nothing is lost in the ordinary case: `boundResponse` returns a document
 * already inside the budget byte for byte, so a short refusal is untouched.
 */
function bounded(body: string, how?: string): string {
  const b = boundResponse(body, {
    budget: responseBudget().bytes,
    how: how ?? "ask for a narrower part of it",
  });
  return b.note ? `${b.text}\n\nNOTE: ${b.note}` : b.text;
}

/* ----------------------------------------------------------------- the loop */

export type DirectTurnOptions = {
  signal: AbortSignal;
  /** Which venture the conversation is about, for the budget ledger. Null is a
   *  legitimate answer and is stored as such. */
  ventureId?: string | null;
  /** A stable id for the WHOLE turn, so every round reserves against one run.
   *  The caller passes its own where it has one. */
  runId?: string;
  /** Told which provider and endpoint answered, so the Integrations page can
   *  draw a green line on the credential that worked. Passed in rather than
   *  imported: `routes/models.ts` reaches `routes/pluginConfig.ts`, and an
   *  integration that imports that at module scope stops the server booting. */
  onOutcome?: (provider: ProviderId, endpoint: string) => void;
};

/**
 * ONE TURN AGAINST A DIRECT PROVIDER — with tools where the model has them,
 * and exactly as before where it has not.
 *
 * The text-only path is deliberately the SAME function rather than a caller's
 * branch: "which mode did this turn get" is then one decision in one place,
 * made from the measured capability and the owner's setting, and the caller
 * cannot get it wrong by asking a different question.
 */
export async function* directTurn(
  turns: ChatTurn[],
  opts: DirectTurnOptions,
): AsyncGenerator<ChatStreamEvent> {
  const s = settings();
  const started = Date.now();
  const runId = opts.runId ?? `chat:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  /* ONE OBJECT, REUSED. `budgeted` increments `sequence` on it, and a fresh
     object per round would restart the checkpoint keys at zero. */
  const ctx = {
    id: runId,
    venture: opts.ventureId ?? null,
    automation: false,
    signal: opts.signal,
    sequence: 0,
    resume: false,
  };
  const ask = (turnsIn: ToolWireTurn[], tools: unknown[] | undefined) =>
    runContext.run(ctx, () =>
      completeTooled(turnsIn, { tools, toolChoice: tools?.length ? "auto" : undefined, signal: opts.signal }),
    );

  /* WHICH MODE. The capability is READ, never probed here — a turn that
     measured the model before answering would pay for a second completion in
     front of somebody waiting. A cache miss means text, which is the behaviour
     this app has always had. */
  let defs: ToolDef[] = [];
  /* Which surface the model got, said in the preamble so it is not left to
     infer it from the shape of its own tool list. */
  let surface: "per-skill" | "index" = "per-skill";
  if (s.tools) {
    const target = await activeModel().catch(() => null);
    /* AMBIGUOUS MEANS UNMEASURED. A provider with several endpoints serving
       different models has no single "which model", so any cached row is a
       claim about a model half the turns never reach — and acting on it is how
       a turn 400s mid-answer. Text is the honest fallback and is what this app
       did before. See `activeModel`. */
    const known = target && !target.ambiguous ? knownMode(target.provider, target.model) : null;
    if (known?.mode === "tools") {
      const live = skills();
      defs = toolsFor(live, { actions: s.actions });
      /*
        TWO SURFACES, CHOSEN BY MEASUREMENT RATHER THAN BY A FLAG. One tool per
        skill is strictly better where it fits — the parameters are typed, so
        fewer calls come back malformed — and strictly unusable where it does
        not: eighty-nine live skills is around sixty kilobytes of tool array on
        every round, which is fifteen thousand tokens spent before the question
        and no turn at all on a local model with an eight-thousand-token
        window. So the catalog is measured against the owner's budget and the
        three-tool index takes over when it is too big. See `indexTools`.
      */
      if (catalogBytes(defs) > s.catalogBytes) {
        defs = indexTools(live, { actions: s.actions });
        surface = "index";
      }
    }
  }

  if (!defs.length) {
    /* TEXT-ONLY, AND IT IS THE OLD BEHAVIOUR UNCHANGED: one completion, the
       answer as a single delta, then done. No skills preamble — see
       routes/chat.ts's `withSkills` for the long argument about why telling a
       model with no tools about a URL is worse than telling it nothing. */
    const reply = await ask(turns, undefined);
    opts.onOutcome?.(reply.provider, reply.endpoint);
    /* THE SAME REFUSAL `complete()` MAKES, kept rather than softened. A
       completion that comes back with no text is indistinguishable from a
       model that had nothing to say, and an empty bubble in a transcript is
       indistinguishable from a bug — so it is a failure the interface reports
       rather than a message stored. */
    if (!reply.text)
      throw new Error(`${activeProvider()?.label ?? reply.provider} answered with no text.`);
    yield { type: "delta", text: reply.text };
    yield {
      type: "done",
      text: reply.text,
      model: reply.model,
      usage: reply.usage,
      ms: reply.ms,
      queuedMs: reply.queuedMs,
    };
    return;
  }

  const rendered = renderTools(defs, "openai");
  const byName = new Map(defs.map((d) => [d.name, d]));
  const wire: ToolWireTurn[] = [
    { role: "system", content: toolPreamble({ calls: s.maxToolCalls, actions: s.actions, surface }) },
    ...turns,
  ];

  let calls = 0;
  let answer = "";
  let model: string | null = null;
  /*
    ACCUMULATED ACROSS ROUNDS, NOT OVERWRITTEN. A twelve-round turn is twelve
    completions and the transcript row is one row; assigning the last round's
    usage would put one round's tokens on it while `budget_usage` — which
    reserves per round — recorded twelve. Two records of the same turn that
    disagree is worse than no record, because one of them is quoted on a cost
    page. Null stays null until some round reports numbers: a provider that
    reports no usage has told us nothing, and a confident 0 would be a lie.
  */
  let usage: { prompt: number; completion: number } | null = null;
  const addUsage = (u: { prompt: number; completion: number } | null) => {
    if (!u) return;
    usage = usage
      ? { prompt: usage.prompt + u.prompt, completion: usage.completion + u.completion }
      : { ...u };
  };
  let queuedMs: number | null = null;
  /*
    THE MODEL WAS MEASURED AS TOOL-CAPABLE AND THE GATEWAY MAY STILL REFUSE.
    Three of the four providers here route: the capability is cached against
    the key the owner set (`auto`, on this box), not against the model the
    router picks this minute. The day it picks one whose server 400s on
    `tools`, an unguarded call fails the whole turn — where before this area
    existed the same question was answered as text. So the FIRST tooled round
    is guarded: a 4xx that `verdictFor` reads as a verdict about the field
    re-writes the capability to `text` and the turn continues without tools,
    which is exactly the behaviour the owner had before. Anything else — a 401,
    a 502, a timeout — is the ordinary failure and is left to throw, because
    silently answering from memory after a network error is the one outcome
    this whole area exists to prevent.
  */
  let toolsRefused = false;
  /* Why the tools were taken away, said to the model in its own turn and to
     the owner in the answer. Null while the loop is still free to call. */
  let stopped: string | null = null;

  for (;;) {
    const overCalls = calls >= s.maxToolCalls;
    const overTime = Date.now() - started > s.toolSeconds * 1000;
    /*
      AN UNMEASURABLE CEILING STOPS THE LOOP RATHER THAN WAVING IT THROUGH.

      `spentOnRun` answers null where this box prices no tokens, and the copy
      this replaced returned 0 there — so a turn on an unpriced box read as
      having spent nothing however many calls it made, and the dollar ceiling
      the owner had set silently never tripped. Null is not zero. An owner who
      asked for a per-turn dollar limit has said they want one, and the honest
      answer to "I cannot tell you what this has cost" is to stop calling
      tools and say why, not to keep going because the number is missing.
      `saveBudgets` refuses dollar budgets without a price for the same reason;
      this is that rule reaching the one ceiling that is set elsewhere.
    */
    /* Zero is NO CEILING, not a ceiling of nothing, so the ledger is not even
       asked. A `spent >= 0` comparison would stop every turn on its first
       round on the overwhelming majority of boxes, which have no dollar
       ceiling set at all. */
    const spent = s.turnUsd > 0 ? spentOnRun(runId) : null;
    if (!stopped) {
      if (overCalls) stopped = `the ${s.maxToolCalls}-call ceiling for one turn`;
      else if (overTime) stopped = `the ${s.toolSeconds}-second budget for one turn`;
      else if (s.turnUsd > 0 && spent === null)
        stopped =
          `the $${s.turnUsd} budget for one turn, which cannot be measured — no model ` +
          `price per million tokens is configured, so nothing here knows what this cost`;
      else if (spent !== null && spent >= s.turnUsd)
        stopped = `the $${s.turnUsd} budget for one turn`;
    }

    /*
      THE FINAL ROUND SENDS NO TOOLS AT ALL rather than sending them and hoping.
      Leaving the array in while asking for an answer is an invitation to
      another call, and the round that exists to guarantee an answer is the one
      round that must not be able to fail that way.

      THE NUDGE IS A USER TURN AND NOT A SYSTEM ONE. Several chat templates
      (Qwen's among them) raise "System message must be at the beginning" and
      the server answers 400 for the whole request — so the branch meant to
      guarantee an answer would be the one thing that could not work. The
      system this replaces hit the same wall for the same reason.
    */
    const last = stopped !== null;
    const sent: ToolWireTurn[] = last
      ? [
          ...wire,
          {
            role: "user",
            content:
              `Stop calling tools — you have reached ${stopped}. Answer now with what you ` +
              `already have, and say plainly which part you could not check.`,
          },
        ]
      : wire;

    const withTools = !last && !toolsRefused;
    let reply: Awaited<ReturnType<typeof ask>>;
    try {
      reply = await ask(sent, withTools ? rendered : undefined);
    } catch (err) {
      const verdict = verdictFor(err);
      if (!withTools || verdict.mode !== "text") throw err;
      /* Recorded, so the next turn does not pay for the same 400 — and so the
         settings page stops claiming this connection gives tools. */
      const target = await activeModel().catch(() => null);
      if (target) writeCapability(target.provider, target.model, "text", verdict.detail);
      toolsRefused = true;
      console.warn(`[runtime] the provider refused the tools field — ${verdict.detail}`);
      /* The same round again, without them. Whatever tool results are already
         in `wire` stay: they are facts the model read, and dropping them would
         throw away the work this turn had already paid for. */
      reply = await ask(sent, undefined);
    }
    opts.onOutcome?.(reply.provider, reply.endpoint);
    model = reply.model;
    addUsage(reply.usage);
    if (queuedMs === null) queuedMs = reply.queuedMs;

    const { calls: wanted } = parseToolCalls(reply.message);
    const said = messageText(reply.message);

    if (last || !wanted.length) {
      /* THE ANSWER. `reply.text` and not `said`, because that is the reader
         every other caller uses and it falls back to the model's working when
         the content came back empty — a whole answer that arrived as no
         content at all, which reasoning models do. It is emitted as a delta
         here rather than after the loop, so what the page draws and what the
         transcript stores are assembled in one place and in one order. */
      /* Leading whitespace is dropped only when nothing has been written yet —
         mid-answer it is real spacing between paragraphs. */
      const tail = answer ? reply.text : reply.text.replace(/^\s+/, "");
      if (tail) {
        answer += tail;
        yield { type: "delta", text: tail };
      }
      break;
    }

    /* Anything the model said BEFORE reaching for a tool is part of the
       answer and is emitted where it happened, so the tool line lands between
       the paragraph before it and the paragraph after. */
    /*
      TRIMMED, BECAUSE A ROUND THAT ONLY CALLED A TOOL OFTEN STILL SENDS
      WHITESPACE. Several servers put a newline or two in `content` beside a
      tool_calls array, and accumulating those puts a stack of blank lines at
      the top of the stored answer — visible in the transcript, and the tool
      lines' offsets end up measured against them. Nothing readable is lost:
      only a round with actual prose contributes.
    */
    if (said.trim()) {
      answer += said;
      yield { type: "delta", text: said };
    }

    wire.push(assistantCallTurn(said, wanted, "openai"));

    for (const call of wanted) {
      /*
        THE STOP BUTTON IS CHECKED HERE, BEFORE THE CALL RATHER THAN AFTER IT.
        chat/runs.ts aborts the run's controller and keeps iterating this
        generator; the in-flight fetch rejects with an AbortError, the catch
        below turns it into "that tool could not be read", and without this the
        loop would then walk the REST of `wanted` emitting a completed event
        for every call that never ran — a transcript claiming work that did not
        happen, on the one path where the owner already knows they stopped it.
        Throwing here ends the generator, and chat/runs.ts writes whatever was
        said as the partial row it always writes.
      */
      opts.signal.throwIfAborted();
      calls += 1;
      const at = new Date().toISOString();
      /* THE LINE THE OWNER SEES BESIDE THE SPINNER. The integration's own id
         where the call names one — on the index surface that is a parameter
         rather than the tool name, and "opc_read" on every line would tell the
         owner nothing about what the agent is actually looking at. */
      const def = byName.get(call.name) ?? null;
      const named = typeof call.args.skill === "string" ? call.args.skill.trim() : "";
      const label =
        def && def.skillId
          ? def.action
            ? `${def.skillId} · ${def.action.replace(/_/g, " ")}`
            : def.skillId
          : (named || call.name.replace(/^opc_/, ""));

      yield { type: "tool", toolCallId: call.id, tool: call.name, label, emoji: null, status: "running", at };

      let content: string;
      try {
        content = await runTool(call, defs, s.actions, opts.signal);
      } catch (err) {
        /* A CANCEL IS NOT A TOOL FAILURE. An aborted fetch surfaces here as an
           AbortError (and, from undici, sometimes as a plain TypeError once
           the request underneath has gone away — so the signal is asked rather
           than the error's name, which chat/wire.ts learned the same way).
           Reporting it to the model as "that tool could not be read" would
           have it try something else with the owner's stop already pressed. */
        if (opts.signal.aborted) throw err;
        /* ONE TOOL THAT FAILED COSTS ONE TOOL, NEVER THE TURN. The model is
           told what happened and can try something else or say so — and the
           pair is still complete, because every announced call gets a
           completed event below and the page is never left holding an open
           chip. */
        content = JSON.stringify({
          error: `That tool could not be read: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      wire.push(resultTurn(call, content, "openai"));
      yield {
        type: "tool",
        toolCallId: call.id,
        tool: call.name,
        label,
        emoji: null,
        status: "completed",
        at: new Date().toISOString(),
      };

      if (calls >= s.maxToolCalls) break;
    }
  }

  /* NOTHING AT ALL, AFTER ALL THAT. A turn that called tools and then wrote
     no answer has spent the owner's money and produced an empty bubble, and
     the honest report is a failure with the reason rather than a stored
     message that says nothing. Anything the model DID write on the way — the
     prose before a tool call — counts, and is kept. */
  if (!answer.trim())
    throw new Error(
      `The model called ${calls} tool${calls === 1 ? "" : "s"} and then answered with nothing. ` +
        `That usually means the turn grew too large for its context window — ask a narrower ` +
        `question, or lower the tool-call ceiling under Integrations → Agent tools & jobs.`,
    );

  yield {
    type: "done",
    text: answer,
    model,
    usage,
    ms: Date.now() - started,
    queuedMs,
  };
}

/**
 * THE SAME TURN, DRAINED, for the caller with nowhere to put a half-answer.
 *
 * `POST /api/chat` fetches a whole turn and returns a document, because its
 * second caller is the Telegram bridge: no growing bubble to render into, one
 * message when the answer is done. That route must get tools too — a question
 * asked from a phone is the same question — and the honest way to give it them
 * is to run the same generator and keep only what it ended with, rather than
 * writing a second loop that could drift from this one.
 *
 * The tool events are DROPPED here rather than summarised, and that is the one
 * real loss on this path: the non-streaming contract has nowhere to put them,
 * and inventing a "(ran 3 tools)" line would be this function deciding how a
 * transcript reads. The row that path writes carries no `tools` array either —
 * see db.ts on why "used no tools" and "could not have reported them" are
 * deliberately indistinguishable there.
 */
export async function directReply(
  turns: ChatTurn[],
  opts: DirectTurnOptions,
): Promise<{
  text: string;
  model: string | null;
  usage: { prompt: number; completion: number } | null;
  ms: number;
}> {
  let text = "";
  let model: string | null = null;
  let usage: { prompt: number; completion: number } | null = null;
  let ms = 0;
  for await (const event of directTurn(turns, opts)) {
    if (event.type === "done") {
      text = event.text;
      model = event.model;
      usage = event.usage;
      ms = event.ms;
    }
  }
  return { text, model, usage, ms };
}
