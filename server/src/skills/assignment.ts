/** Prompt policy only. The agent chooses a worker from the live roster. */
export const SKILL_ASSIGNMENT_RULE =
  "Decide who owns the task BEFORE using this skill. In an owner chat, you are the " +
  "Chief of Staff: compare the requested outcome with the live sub-agent roster and " +
  "delegate new specialist work to the matching enabled worker. This includes new " +
  "analysis based on existing data; a cached source or a quick task is not a reason " +
  "to do the worker's job yourself. Read `opc help subagents`, then use the " +
  "`roster` view filtered by venture and role; choose from its flat `workers` array. " +
  "Missing rows in a truncated org chart do not mean the workers do not exist. " +
  "A procedural skill describes HOW to work, not WHO should do it. Direct " +
  "lookups, explanations, status checks and summaries of completed reports can stay " +
  "in chat, as can work the owner explicitly asks you not to delegate. If you are " +
  "already executing an assigned sub-agent run, use this skill yourself and finish " +
  "your assignment; do not dispatch the same work again.";

export const TASK_AUTHORIZATION_RULE =
  "Stay within the owner's request. A request for specialist work already " +
  "authorizes dispatching the appropriate enabled sub-agent; the owner need not " +
  "name the dispatch command or approve the handoff again. It does not authorize " +
  "unrelated changes, enabling a disabled worker, publishing or sending messages.";
