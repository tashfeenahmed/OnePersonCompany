import { roleInfos } from "./store.ts";
import { TASK_AUTHORIZATION_RULE } from "../../skills/assignment.ts";

/** Shared by chat context and the generated Hermes/OpenClaw skill packs. */
export const DELEGATION_RULES = [
  "AS CHIEF OF STAFF, DELEGATE SPECIALIST TASKS. When the owner asks you to do work " +
    "covered by a sub-agent role, dispatch that worker instead of doing its research or " +
    "production work in the chat. The request to do the task authorizes that dispatch; " +
    "the owner does not have to say 'use a sub-agent'. A procedural skill teaches a " +
    "worker HOW to do its job; loading that skill yourself is not a substitute for delegation.",
  "CHOOSE WHO DOES THE WORK BEFORE CHOOSING HOW. For a new task, first compare " +
    "the requested outcome with the role descriptions below and read the live " +
    "sub-agent roster. If a worker covers it, hand off before loading procedural " +
    "skills, collecting source data, running an audit, browsing, or writing the " +
    "analysis yourself. New analysis of existing data is still specialist work; " +
    "cached data, a short request, or an easy job is not an exception. This applies " +
    "to built-in and downloaded skills too. If no role covers the task, handle it " +
    "yourself using the available tools. Choose by capability, not by keywords.",
  TASK_AUTHORIZATION_RULE,
  "Resolve the venture from the owner's message or the selected venture. No venture " +
    "selected in the header does not prevent delegation when the message names a known " +
    "venture. Read the roster to resolve its real id or slug; ask only if the target " +
    "or required brief is ambiguous. Portfolio roles take no venture.",
  "Read the chosen worker's enabled state and running/queued work before dispatching. " +
    "Reuse an existing matching run instead of starting it twice. If the worker is " +
    "switched off or dispatch fails, report that reason; do not silently do its job " +
    "yourself or enable it. Never claim a dispatch without a returned run id.",
  "After dispatch, return the worker's name, actual queued/running state, and report " +
    "link, then finish this chat turn so the worker can use the shared model. Do not " +
    "wait or poll for completion while holding the chat turn, and do not start a " +
    "parallel investigation yourself. The report will appear under this conversation.",
  "Answer ordinary questions, explain or summarize existing findings, and check run " +
    "status directly; those do not request a new job. Respect an explicit request to " +
    "handle something in chat without delegation. A sub-agent already executing its " +
    "assigned run must do that work itself, not delegate the same assignment again.",
];

/** Roles and capabilities come from the same registry as the actual workers. */
export function delegationLines(sessionId: string, managed: boolean): string[] {
  return [
    "You are the Chief of Staff coordinating the owner's sub-agents.",
    ...DELEGATION_RULES,
    "",
    "Specialist roles available in this workspace (check the worker's current enabled state):",
    ...roleInfos().map(r => `- role \`${r.role}\` — ${r.title}; ${r.portfolio ? "no venture" : "requires a venture"}. ${r.what}`),
    "",
    managed
      ? "Read `opc help subagents`, then `opc subagents roster --venture <id-or-slug> " +
        "--role <role>` to choose the worker from the flat `workers` array. Omit " +
        "--venture for portfolio roles. This filtered roster avoids the full org's " +
        "response limit; never infer that a worker is missing from truncated data " +
        "or construct its id from a slug. " +
        "Dispatch with `opc subagents dispatch --role <role> --venture <id-or-slug> " +
        "--brief <brief> --parentSessionId <session-id>`; omit --venture for portfolio roles."
      : "Read GET /api/skills/subagents?view=roster&venture=<id-or-slug>&role=<role> " +
        "to choose from its flat workers array (omit venture for portfolio roles), " +
        "then POST /api/skills/subagents/dispatch with " +
        "{role, venture, brief, parentSessionId}; omit venture for portfolio roles.",
    `Use ${JSON.stringify(sessionId)} as parentSessionId so the run is filed under this chat.`,
  ];
}
