/**
 * THE TOOL-CALLING ADAPTER — one skill registry, three wire dialects.
 *
 * WHAT THIS FILE IS FOR. `models/provider.ts` completes: turns in, text out.
 * Until now that was the whole of what a direct model connection could do, and
 * routes/chat.ts said so at length — a raw model gets no skills preamble
 * because "a model told to fetch something it cannot fetch does not say so, it
 * writes down what the answer would probably have been". That paragraph was
 * right about a model with no tools. This file is the other half: given a
 * model that CAN call a function, the skills registry is already a list of
 * typed, documented, bounded calls, and turning it into a tool array is
 * mechanical.
 *
 * THREE DIALECTS, AND WHY ALL THREE ARE HERE WHEN ONE WIRE IS USED.
 *
 *   openai      `tools: [{ type: "function", function: { name, description,
 *               parameters } }]`, calls come back as `message.tool_calls`,
 *               results go back as `{ role: "tool", tool_call_id, content }`.
 *   anthropic   `tools: [{ name, description, input_schema }]`, calls come
 *               back as `tool_use` blocks inside `content`, results go back as
 *               `tool_result` blocks.
 *   gemini      `tools: [{ functionDeclarations: [...] }]`, calls come back as
 *               `functionCall` parts, results go back as `functionResponse`.
 *
 * Every provider this app has — FreeLLMAPI, a local endpoint, OpenAI,
 * OpenRouter — speaks the OPENAI request shape, because that is the only wire
 * `chat/wire.ts` writes. So the request this area sends is always the OpenAI
 * one. The other two dialects are here for the READING side, and that is not
 * theoretical: FreeLLMAPI and OpenRouter both route to Anthropic and Gemini
 * models behind an OpenAI-shaped door, and a shim that forgets to translate
 * the response leaks the upstream's own shape into `message.content` as an
 * array of typed parts. A parser that only knew `tool_calls` would read that
 * as an empty answer and report the model as having said nothing. So
 * `parseToolCalls` accepts all three and says which shape it found.
 *
 * The definition side of the other two dialects is exported and unit-tested
 * rather than dead: it is what a native Anthropic or Gemini provider module
 * would need on the day one is added, and having it written beside the parser
 * that reads those shapes is what keeps the two agreeing.
 *
 * PURE. No database, no fetch, no settings — the same rule agentcore/bound.ts
 * keeps, and for the same payoff: the edge cases (a fragmented argument
 * stream, a name split across deltas, arguments that are not JSON) are covered
 * by unit tests rather than by running a model and hoping.
 */
import type { Skill, SkillAction, SkillParam, SkillView } from "../../skills/registry.ts";

export type ToolDialect = "openai" | "anthropic" | "gemini";

/** A JSON Schema object as these three dialects all spell it. */
export type ToolSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
};

/** One tool, before it is dressed in a dialect. */
export type ToolDef = {
  name: string;
  /** The skill this came from, and the action if it is a write. Carried so the
   *  loop never has to re-parse the name it just built. */
  skillId: string;
  action: string | null;
  destructive: boolean;
  description: string;
  schema: ToolSchema;
};

/** One call the model asked for. `args` is `{}` and `badJson` is the raw text
 *  when the arguments would not parse — a small model emits malformed JSON
 *  regularly and the honest move is to tell it so in the tool result rather
 *  than to throw. */
export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  badJson: string | null;
};

/* ------------------------------------------------------------------- names */

/**
 * `opc_<skill>` for a read, `opc_<skill>_<action>` for a write.
 *
 * THE SAME NAMES THE MCP SERVER PUBLISHES, deliberately. An owner who has read
 * one agent's tool list should recognise the other's, and a rule written down
 * twice under two spellings is a rule that gets fixed once. The split back is
 * at the FIRST underscore, which works because a registry id has never had one
 * — see skills/mcp.ts, which spends a paragraph on the same claim.
 */
export function toolName(skillId: string, action?: string | null): string {
  return action ? `opc_${skillId}_${action}` : `opc_${skillId}`;
}

export function routeName(name: string): { id: string; action: string | null } {
  const rest = name.replace(/^opc_/, "");
  const cut = rest.indexOf("_");
  return cut < 0 ? { id: rest, action: null } : { id: rest.slice(0, cut), action: rest.slice(cut + 1) };
}

/* ----------------------------------------------------------------- schemas */

function paramLine(p: SkillParam, view: SkillView | null, several: boolean): string {
  const scope = several && view ? ` (${p.required ? "required for view" : "view"}: ${view.key})` : "";
  const fallback = p.fallback !== undefined ? ` Default ${p.fallback}.` : "";
  return `${p.about}${scope}${fallback}`;
}

/**
 * The READ tool for one skill: a `view` selector where there is a choice, the
 * union of every view's parameters, and `fields` on top.
 *
 * PARAMETERS ARE UNIONED ACROSS VIEWS because there is one schema per tool and
 * no way to express a per-view one — and a NAME that appears in two views
 * keeps BOTH sentences rather than whichever view was rendered last. A `page`
 * that is one cursor in one view and a different cursor in another, described
 * only by the second, is a model told something untrue about the parameter it
 * is sending.
 *
 * REQUIRED ONLY WHERE IT IS REQUIRED OF EVERY VIEW. A skill that needs an id
 * to open one thing and nothing at all to list them would otherwise tell a
 * model listing things that it must send an id — and a model that must send
 * one will make one up.
 */
export function readSchema(s: Skill): ToolSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const several = s.views.length > 1;

  if (several)
    properties.view = {
      type: "string",
      enum: s.views.map((v) => v.key),
      description: s.views.map((v) => `${v.key}: ${v.about}`).join(" | "),
    };

  const said = new Map<string, string[]>();
  for (const v of s.views)
    for (const p of v.params) {
      const line = paramLine(p, v, several);
      const already = said.get(p.name);
      if (already) {
        if (!already.includes(line)) already.push(line);
      } else {
        said.set(p.name, [line]);
        properties[p.name] = { type: p.type };
      }
      const always = s.views.every((x) => x.params.some((y) => y.name === p.name && y.required));
      if (always && !required.includes(p.name)) required.push(p.name);
    }
  for (const [name, lines] of said)
    (properties[name] as { description?: string }).description = lines.join(" — or — ");

  /* `fields` IS THIS LAYER'S AND IS NEVER FORWARDED. The skills proxy refuses
     a parameter the view does not have — rightly, because a silently ignored
     `month=august` is how a 30-day window gets captioned as August — so a key
     it has never heard of is consumed before the request is composed. It is
     the cheapest way to fit a big document inside the response budget. */
  properties.fields = {
    type: "string",
    description:
      'Optional. Comma-separated TOP-LEVEL keys to keep, e.g. "totals,window". Everything ' +
      "else is left out. Use it when you know which part of the document you need; an " +
      "`error` field is always kept.",
  };

  return { type: "object", properties, required };
}

export function actionSchema(a: SkillAction): ToolSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of a.params) {
    properties[p.name] = {
      type: p.type,
      description: `${p.about}${p.fallback !== undefined ? ` Default ${p.fallback}.` : ""}`,
    };
    if (p.required) required.push(p.name);
  }
  return { type: "object", properties, required };
}

/**
 * THE HONESTY RULES GO IN THE DESCRIPTION, and that placement is the one
 * design decision here.
 *
 * A tool description is the only text that is guaranteed to be in front of the
 * model at the moment it decides what to do with a number. Rules delivered
 * alongside the RESULT arrive after that decision has been made. It costs
 * tokens on every turn that carries the tool list and it is worth them: the
 * failure it prevents is a confident wrong figure, which is the only kind of
 * wrong answer the owner cannot catch.
 */
function readDescription(s: Skill): string {
  return `${s.about}\n\nAnswers questions like: ${s.asks.join(" / ")}`;
}

/**
 * THE RULES, AS THEY TRAVEL WITH THE ANSWER.
 *
 * The MCP server puts them in the tool DESCRIPTION and gives a reason worth
 * restating: a description is the only text a client is guaranteed to put in
 * front of the model, and rules that arrive after it has decided what to do
 * with the numbers are rules that arrive late. That is right for MCP, where
 * the client owns the result and this code cannot touch it.
 *
 * HERE THE LOOP OWNS THE RESULT, and the arithmetic changes. Nineteen skills'
 * rules in nineteen descriptions is a cost paid on EVERY round of every turn,
 * whether or not the skill is called — on this box, with 89 live skills, that
 * is two hundred kilobytes of prompt before the question. Appended to the
 * ANSWER instead, each skill's rules are paid once, only when its figures are
 * actually in front of the model, and they are the last thing it reads before
 * writing the sentence they govern. That is a better placement, not a cheaper
 * one; the reason it was not available to mcp.ts is that mcp.ts does not
 * control what the client shows.
 */
export function resultRules(s: Skill): string {
  if (!s.rules.length) return "";
  return `RULES FOR REPORTING THIS — they are not optional:\n${s.rules.map((r) => `- ${r}`).join("\n")}`;
}

function actionDescription(s: Skill, a: SkillAction): string {
  const rules = s.rules.map((r) => `- ${r}`).join("\n");
  return (
    `${a.about}\n\nThis CHANGES the owner's own data — ${a.method} ${a.path}` +
    `${a.destructive ? ", and there is no undo" : ""}.\n\n` +
    `RULES FOR USING THIS — they are not optional:\n${rules}`
  );
}

/* ------------------------------------------------------ the write allow-list */

/**
 * WHICH ACTIONS A DIRECT MODEL MAY CALL, AS AN ALLOW-LIST.
 *
 * THE DENY-LIST THIS REPLACES WAS WRONG IN THE WAY DENY-LISTS ARE ALWAYS
 * WRONG. It refused `destructive: true` and let everything else through, and
 * `destructive` had — correctly, for its own purpose — meant "there is no undo
 * for this ROW". That is not the set an owner means when they switch writing
 * on to let chat file a card. A briefing that sends itself to their phone, a
 * pipeline stage that dispatches sub-agent runs, an image model billed per
 * picture and an ssh that puts a desktop to sleep are all perfectly reversible
 * as records and none of them are things a model should reach for on its own
 * reasoning. Two halves of the fix: those actions are now marked destructive
 * in their own registries (the flag's meaning is widened to "spends, sends, or
 * touches a third party", which is what a client asking "should I check with a
 * person" actually wants to know), and this gate stops trusting the absence of
 * a flag.
 *
 * THREE CONDITIONS, AND AN ACTION HAS TO PASS ALL OF THEM.
 *
 *   NOT DESTRUCTIVE     the registry's own claim, now widened as above.
 *   NOT OPEN-WORLD      `openWorld` on the SKILL says calling it reaches off
 *                       this machine. A write on such a skill is a write on
 *                       somebody else's system, whatever its own key says.
 *   NOT A DOING VERB    the names below. This is the belt to the flags'
 *                       braces: a new area adds an action and forgets the
 *                       flag, and the failure mode of that omission must not
 *                       be "a model can now start it". `run`, `start`,
 *                       `send`, `deliver`, `dispatch`, `submit`, `publish`,
 *                       `render`, `refresh`, `wake`, `sleep`, `shutdown` are
 *                       the verbs that mean "make something happen out
 *                       there"; `create`, `update`,
 *                       `set`, `add`, `move`, `archive`, `dismiss`, `snooze`
 *                       are the verbs that mean "write a row down".
 *
 * IT REFUSES BY DEFAULT IN THE DIRECTION THAT COSTS A ROUND, NOT A BILL. A
 * reversible action wrongly refused is one sentence the model passes to the
 * owner; an irreversible one wrongly allowed is money, a message somebody
 * received, or a machine that went to sleep.
 *
 * THIS GATE IS THIS DOOR'S AND NOBODY ELSE'S. A connected Hermes or OpenClaw
 * still reaches every action the registry publishes, through MCP, exactly as
 * before — that agent is a thing the owner installed and pointed at their
 * business. This is the narrower door a raw model gets.
 */
export const DOING_VERBS: RegExp[] = [
  /^send/,
  /^run/,
  /^start/,
  /^deliver/,
  /^wake$/,
  /^sleep$/,
  /^shutdown/,
  /^publish/,
  /^render/,
  /^refresh/,
  /*
    THE TWO THE FIRST LIST MISSED, found by dumping the gate's verdict over the
    whole live registry rather than by reading it. `subagents.dispatch` says of
    itself "this spends the single run slot and real tokens on the owner's
    account" — the same class as `pipeline.run_stage`, which the review named —
    and `growth.submit` posts URLs to IndexNow, which is a write on a search
    engine. Neither carried a flag, and both are caught here rather than by
    editing two more areas' files: this is exactly what the verb rule is the
    belt for.
  */
  /^dispatch/,
  /^submit/,
];

export type ActionVerdict = { ok: true } | { ok: false; why: string };

export function actionGate(s: Skill, a: SkillAction): ActionVerdict {
  if (a.destructive === true)
    return {
      ok: false,
      why:
        `${a.key} on ${s.id} is marked irreversible — it cannot be undone from here, or it ` +
        `spends money, sends a message, or reaches a machine that is not this one`,
    };
  if (s.openWorld === true)
    return {
      ok: false,
      why: `${s.id} reaches off this machine, so writing through it is writing on somebody else's system`,
    };
  if (DOING_VERBS.some((r) => r.test(a.key)))
    return {
      ok: false,
      why:
        `${a.key} is a doing verb — it makes something happen rather than writing a row down, ` +
        `and this door only writes rows`,
    };
  return { ok: true };
}

/** The actions of one skill a direct model may call. Empty for most skills,
 *  and empty is the honest answer rather than an omission. */
export function allowedActions(s: Skill): SkillAction[] {
  return (s.actions ?? []).filter((a) => actionGate(s, a).ok);
}

/**
 * Every tool a set of live skills offers, reads first.
 *
 * `actions` DECIDES WHETHER THE WRITES ARE PUBLISHED AT ALL, rather than
 * whether they are refused when called. A tool that is in the list and always
 * says no is a tool the model will keep trying; a tool that is not in the list
 * does not exist, and the model plans around what it has. With writes on, the
 * ones published are the ones `actionGate` allows and no others — see its
 * header for why an allow-list rather than a deny-list. The loop re-checks
 * every call against the same gate, because the index surface's `opc_act`
 * takes an action NAME rather than choosing from a list.
 */
export function toolsFor(skills: Skill[], opts: { actions: boolean }): ToolDef[] {
  const out: ToolDef[] = [];
  for (const s of skills) {
    out.push({
      name: toolName(s.id),
      skillId: s.id,
      action: null,
      destructive: false,
      description: readDescription(s),
      schema: readSchema(s),
    });
    if (!opts.actions) continue;
    /* ONLY THE ALLOWED ONES ARE PUBLISHED. A tool that is in the list and
       always refuses is a tool the model keeps trying; one that is not in the
       list does not exist, and the model plans around what it has. */
    for (const a of allowedActions(s))
      out.push({
        name: toolName(s.id, a.key),
        skillId: s.id,
        action: a.key,
        destructive: a.destructive === true,
        description: actionDescription(s, a),
        schema: actionSchema(a),
      });
  }
  return out;
}

/* ---------------------------------------------------------------- dialects */

/**
 * The same tools, in the shape one wire wants.
 *
 * The three differ only in where the name, the sentence and the schema go —
 * which is exactly why this is a rendering function and not three adapters.
 * Gemini is the odd one: it wants ONE tool object with a list of declarations
 * inside it rather than a list of tools.
 */
export function renderTools(defs: ToolDef[], dialect: ToolDialect): unknown[] {
  if (dialect === "openai")
    return defs.map((d) => ({
      type: "function",
      function: { name: d.name, description: d.description, parameters: d.schema },
    }));
  if (dialect === "anthropic")
    return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.schema }));
  return [
    {
      functionDeclarations: defs.map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.schema,
      })),
    },
  ];
}

/* ----------------------------------------------------------------- parsing */

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseArgs(raw: unknown): { args: Record<string, unknown>; badJson: string | null } {
  if (raw === undefined || raw === null) return { args: {}, badJson: null };
  if (typeof raw === "object") {
    const rec = asRecord(raw);
    return rec ? { args: rec, badJson: null } : { args: {}, badJson: JSON.stringify(raw).slice(0, 300) };
  }
  const text = String(raw).trim();
  if (!text) return { args: {}, badJson: null };
  try {
    const parsed: unknown = JSON.parse(text);
    const rec = asRecord(parsed);
    return rec ? { args: rec, badJson: null } : { args: {}, badJson: text.slice(0, 300) };
  } catch {
    return { args: {}, badJson: text.slice(0, 300) };
  }
}

/**
 * Every tool call in one assistant message, whichever of the three shapes it
 * arrived in — and what shape that was.
 *
 * IT LOOKS FOR ALL THREE EVERY TIME rather than being told which to expect,
 * because the thing that decides the shape is not the provider this app is
 * configured with: it is whatever model a routing gateway picked this turn.
 * Finding none is the ordinary case (a plain answer) and is not an error.
 *
 * IDS ARE FILLED IN WHERE THE WIRE OMITS ONE. Gemini's `functionCall` has no
 * id at all and some OpenAI-compatible servers send an empty one; the loop
 * needs a stable key to pair a result to a call, so a positional one is
 * synthesised. It is only ever used within the turn that made it.
 */
export function parseToolCalls(message: unknown): { calls: ToolCall[]; shape: ToolDialect | null } {
  const m = asRecord(message);
  if (!m) return { calls: [], shape: null };

  /* OPENAI. The common case, and the one every provider module here speaks. */
  const openai = Array.isArray(m.tool_calls) ? m.tool_calls : null;
  if (openai && openai.length) {
    const calls: ToolCall[] = [];
    openai.forEach((entry, i) => {
      const e = asRecord(entry);
      if (!e) return;
      const fn = asRecord(e.function) ?? {};
      const name = typeof fn.name === "string" ? fn.name : typeof e.name === "string" ? e.name : "";
      if (!name) return;
      const { args, badJson } = parseArgs(fn.arguments ?? e.arguments);
      calls.push({ id: typeof e.id === "string" && e.id ? e.id : `call_${i}`, name, args, badJson });
    });
    if (calls.length) return { calls, shape: "openai" };
  }

  /* ANTHROPIC and GEMINI both hide theirs in a content/parts array. */
  const blocks = Array.isArray(m.content)
    ? m.content
    : Array.isArray(m.parts)
      ? m.parts
      : null;
  if (blocks) {
    const calls: ToolCall[] = [];
    let shape: ToolDialect | null = null;
    blocks.forEach((entry, i) => {
      const e = asRecord(entry);
      if (!e) return;
      if (e.type === "tool_use" && typeof e.name === "string") {
        shape = "anthropic";
        const { args, badJson } = parseArgs(e.input);
        calls.push({ id: typeof e.id === "string" && e.id ? e.id : `call_${i}`, name: e.name, args, badJson });
        return;
      }
      const gem = asRecord(e.functionCall);
      if (gem && typeof gem.name === "string") {
        shape = "gemini";
        const { args, badJson } = parseArgs(gem.args);
        calls.push({ id: `call_${i}`, name: gem.name, args, badJson });
      }
    });
    if (calls.length && shape) return { calls, shape };
  }

  return { calls: [], shape: null };
}

/**
 * The text of an assistant message that may also have made tool calls.
 *
 * `chat/wire.ts`'s `readText` already does this for a plain answer and is the
 * right reader for one — but it falls back to the model's REASONING when the
 * content is empty, which is correct for a final answer and wrong here: a
 * tool-call round legitimately has no content, and putting the scratchpad in
 * the transcript as if it were prose would print the model's thinking between
 * every tool call. So this reads content only.
 */
export function messageText(message: unknown): string {
  const m = asRecord(message);
  if (!m) return "";
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((p) => {
        const e = asRecord(p);
        if (!e) return "";
        if (e.type !== undefined && e.type !== "text") return "";
        return typeof e.text === "string" ? e.text : "";
      })
      .join("");
  return "";
}

/* ------------------------------------------------- results, back on the wire */

/** The assistant turn that MADE the calls, replayed into the next request.
 *  Every dialect requires it: a `tool` message with no matching call before it
 *  breaks the chat template outright on most servers. */
export function assistantCallTurn(
  text: string,
  calls: ToolCall[],
  dialect: ToolDialect,
): Record<string, unknown> {
  if (dialect === "openai")
    return {
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    };
  if (dialect === "anthropic")
    return {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
      ],
    };
  return {
    role: "model",
    parts: [
      ...(text ? [{ text }] : []),
      ...calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
    ],
  };
}

/** One tool's answer, in the shape the same wire wants it back. */
export function resultTurn(
  call: ToolCall,
  content: string,
  dialect: ToolDialect,
): Record<string, unknown> {
  if (dialect === "openai") return { role: "tool", tool_call_id: call.id, content };
  if (dialect === "anthropic")
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: call.id, content }],
    };
  return {
    role: "user",
    parts: [{ functionResponse: { name: call.name, response: { content } } }],
  };
}

/* ------------------------------------------------- the catalog, and its size */

/**
 * HOW BIG THE TOOL LIST WOULD BE, in bytes on the wire.
 *
 * Measured rather than counted, because "how many skills" is not the question
 * a context window asks. Two installs with twenty skills each differ by a
 * factor of three depending on how many views and parameters those skills
 * have.
 */
export function catalogBytes(defs: ToolDef[]): number {
  return new TextEncoder().encode(JSON.stringify(renderTools(defs, "openai"))).length;
}

/**
 * THE SECOND SURFACE: three tools instead of ninety.
 *
 * WHY IT EXISTS. This box has eighty-nine live skills. One tool each — with
 * every view, every parameter and every parameter's sentence — is around sixty
 * kilobytes of tool array on EVERY round of EVERY turn, before the question.
 * That is fifteen thousand tokens spent to make a model choose, and on a local
 * model with an eight-thousand-token window it is not a slow turn, it is no
 * turn at all. A per-skill tool list is strictly better where it FITS, and
 * strictly unusable where it does not, so the loop measures and picks.
 *
 * WHAT REPLACES IT IS NOT A DEGRADED VERSION. The `skill` parameter is an ENUM
 * of every live id with a one-line summary beside it, so the model knows what
 * exists without spending a call — the discovery problem an index usually
 * introduces is solved in the schema. `opc_skills` then hands back one skill's
 * views, parameters and rules in full when the model needs them, and `opc_read`
 * makes the call. It is the same door `preamble()` describes to a remote agent,
 * which is the shape this app already argued for; the difference is that here
 * it is typed and validated instead of composed into a URL.
 *
 * THE PROXY IS STILL THE VALIDATOR. `params` is deliberately loose here
 * because one schema cannot express eighty-nine parameter sets — and it does
 * not need to, because `routes/skills.ts` refuses a parameter a view does not
 * have and answers with the list of the ones it does. A wrong call costs one
 * round and produces a document that says exactly how to make the right one.
 */
/** The first sentence of a skill's `about`, capped. Written once because it is
 *  used in two places that must not drift: the `skill` enum's description and
 *  the index document a bare `opc_skills` returns. */
function summarise(s: Skill): string {
  return s.about.split(/(?<=\.)\s/)[0]!.slice(0, 110);
}

export function indexTools(skills: Skill[], opts: { actions: boolean }): ToolDef[] {
  const ids = skills.map((s) => s.id);
  const lines = skills.map((s) => `${s.id}: ${summarise(s)}`).join("\n");
  /* THE SAME ALLOW-LIST THE PER-SKILL SURFACE USES. A skill whose only actions
     spend, send or reach a machine is not writable through this door, and
     naming it here would be offering something that is refused on arrival. */
  const writable = skills.filter((s) => allowedActions(s).length).map((s) => s.id);

  const skillParam = {
    type: "string",
    enum: ids,
    description: `Which integration. One of:\n${lines}`,
  };

  const paramsParam = {
    type: "object",
    description:
      "The view's own parameters, as an object — e.g. {\"days\": 30}. Call opc_skills with " +
      "this skill first if you do not know them; sending one it does not have is refused " +
      "with the list of the ones it does.",
  };

  const defs: ToolDef[] = [
    {
      name: "opc_skills",
      skillId: "",
      action: null,
      destructive: false,
      description:
        "What this dashboard can read, and how. With no argument: every connected " +
        "integration with one line each. With `skill`: that one in full — its views, its " +
        "parameters with their units and clamps, and the rules for reporting its figures. " +
        "Read this before calling opc_read with parameters you are not sure of.",
      schema: {
        type: "object",
        properties: {
          skill: { type: "string", enum: ids, description: "One integration id, for the full entry." },
        },
        required: [],
      },
    },
    {
      name: "opc_read",
      skillId: "",
      action: null,
      destructive: false,
      description:
        "Read one integration's live measured data. Everything here is a document a " +
        "collector on this machine already wrote — no guessing and no browsing. A large " +
        'answer is SHORTENED, not cut: lists lose rows and end with {"truncated":true,' +
        '"shown":N,"total":T}, where T is the real total — report T, never N; an "_omitted" ' +
        'count means fields were dropped from that object too, and "_bounded".next at the root ' +
        "says how to ask for the rest. The rules for reporting each integration's figures come " +
        "back WITH its answer and are not optional.",
      schema: {
        type: "object",
        properties: {
          skill: skillParam,
          view: {
            type: "string",
            description:
              "Which cut of it. Leave out for the default view; opc_skills lists the others.",
          },
          params: paramsParam,
          fields: {
            type: "string",
            description:
              'Optional. Comma-separated TOP-LEVEL keys to keep, e.g. "totals,window". Use it ' +
              "when a document is bigger than the part you need; an `error` field is always kept.",
          },
        },
        required: ["skill"],
      },
    },
  ];

  if (opts.actions && writable.length)
    defs.push({
      name: "opc_act",
      skillId: "",
      /* Marked as an action so the loop's write gate treats it as one. The
         DESTRUCTIVE check happens per call, against the registry, because
         whether a given action can be undone is a fact about that action and
         not about this tool. */
      action: "call",
      destructive: false,
      description:
        `WRITE A ROW in the owner's own data. Only these integrations can be written through ` +
        `this door: ${writable.join(", ")} — and only the actions opc_skills lists for them. ` +
        `Call one only when the owner asked for that exact change in this conversation. ` +
        `Anything that spends money, sends a message, starts a job or reaches a machine is ` +
        `REFUSED here whatever its name; the refusal says where the owner can do it ` +
        `themselves, and passing that on is the right move rather than retrying.`,
      schema: {
        type: "object",
        properties: {
          skill: { type: "string", enum: writable, description: "Which integration." },
          action: { type: "string", description: "Its action key, from opc_skills." },
          params: paramsParam,
        },
        required: ["skill", "action"],
      },
    });

  return defs;
}

/**
 * One skill as `opc_skills` describes it in full: the views, the parameters
 * with their units and clamps, and the rules. Built here rather than proxied
 * to `GET /api/skills`, because that document is the WHOLE catalog and the
 * question is about one entry.
 *
 * `actions` FOLLOWS THE SAME GATE THE TOOL LIST DOES. With writes off the key
 * is absent, because the preamble has told the model that nothing it can call
 * changes the owner's data and a list of writes underneath that is a
 * contradiction it will act on. With writes on, only the allowed ones are
 * listed — and the ones that exist and are REFUSED here are named, briefly,
 * with the reason. That last part is not a leak: it is what lets the model say
 * "there is a send_now on the briefing and I am not allowed to press it, you
 * are" instead of "there is no way to do that", which is false.
 */
export function skillEntryDoc(s: Skill, opts: { actions: boolean }): unknown {
  const allowed = opts.actions ? allowedActions(s) : [];
  const refused = opts.actions
    ? (s.actions ?? []).filter((a) => !actionGate(s, a).ok)
    : [];
  return {
    id: s.id,
    title: s.title,
    about: s.about,
    answers: s.asks,
    views: s.views.map((v) => ({
      view: v.key,
      about: v.about,
      params: v.params.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        default: p.fallback ?? null,
        about: p.about,
      })),
    })),
    ...(opts.actions
      ? {
          actions: allowed.map((a) => ({
            action: a.key,
            about: a.about,
            params: a.params.map((p) => ({
              name: p.name,
              type: p.type,
              required: p.required,
              about: p.about,
            })),
          })),
          ...(refused.length
            ? {
                refusedHere: refused.map((a) => ({ action: a.key, why: actionGate(s, a).ok ? "" : (actionGate(s, a) as { why: string }).why })),
                refusedHereNote:
                  "These exist and cannot be called from a direct model connection. Tell the " +
                  "owner what you would have done and that they can do it themselves.",
              }
            : {}),
        }
      : {}),
    rules: s.rules,
  };
}

/**
 * The one-line index, for a bare `opc_skills`.
 *
 * DELIBERATELY SHORT, AND THAT IS THE POINT OF IT. The whole reason this
 * surface exists is that one tool per skill did not fit; an index that
 * repeated every `about` and every `asks` in full would cost the same sixty
 * kilobytes the tool array did and be called as a TOOL RESULT, where it is
 * charged against the answer's context rather than the request's. The 110
 * characters below are the same summary `indexTools` already puts beside each
 * id in `opc_read`'s enum, so the model has seen them and this is a reminder
 * rather than a first telling; the full entry is one `opc_skills --skill <id>`
 * away and is what to read before sending parameters.
 */
export function skillIndexDoc(skills: Skill[], opts: { actions: boolean }): unknown {
  return {
    count: skills.length,
    note:
      "Every integration connected on this box, one line each. Call opc_skills with one id " +
      "for its views, parameters and reporting rules; call opc_read to get its figures.",
    skills: skills.map((s) => ({
      id: s.id,
      title: s.title,
      summary: summarise(s),
      views: s.views.map((v) => v.key),
      ...(opts.actions && allowedActions(s).length
        ? { actions: allowedActions(s).map((a) => a.key) }
        : {}),
    })),
  };
}
