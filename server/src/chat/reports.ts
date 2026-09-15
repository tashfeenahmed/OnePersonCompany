import { db, type ChatMessageRow } from "../db.ts";
import { ROLES, PORTFOLIO_ROLES, runThreadPage } from "../integrations/subagents/store.ts";
import { runPage } from "../../../shared/runRoutes.ts";
import type { ChatReport } from "../../../shared/chatReport.ts";

type ReportRow = {
  id: string;
  kind: string;
  title: string;
  status: ChatReport["status"];
  error: string | null;
  agent_name: string | null;
  agent_role: string | null;
  venture_id: string | null;
  venture_slug: string | null;
};

const selectReport = `SELECT r.id, r.kind, r.title, r.status, r.error,
  s.name AS agent_name, s.role AS agent_role, r.venture_id, v.slug AS venture_slug
  FROM agent_runs r LEFT JOIN subagents s ON s.id = r.subagent_id
  LEFT JOIN ventures v ON v.id = r.venture_id
  WHERE r.parent_session_id = ?`;

/** Only engine-authored notifications may become cards. Old notifications
 * predate report_run_id, so resolve their first-line link against real runs
 * belonging to this conversation. Ordinary assistant links stay markdown. */
export function chatReport(message: ChatMessageRow): ChatReport | null {
  if (message.channel !== "run" || message.role !== "assistant" || message.partial) return null;
  let row: ReportRow | undefined;
  if (message.report_run_id) {
    row = db.prepare(`${selectReport} AND r.id = ?`)
      .get(message.session_id, message.report_run_id) as ReportRow | undefined;
  } else {
    const link = message.content.split("\n", 1)[0]?.match(/\[open the run\]\((\/[^\s)]+)\)/)?.[1];
    if (!link) return null;
    const rows = db.prepare(selectReport).all(message.session_id) as ReportRow[];
    row = rows.find(run => runPage(run.kind, run.id) === link || runThreadPage(run) === link);
  }
  if (!row) return null;
  const role = [...ROLES, ...PORTFOLIO_ROLES].find(def => def.kind === row.kind);
  return {
    runId: row.id,
    title: row.title,
    agentName: row.agent_name || role?.title || "Sub-agent",
    role: row.agent_role || role?.role || row.kind,
    status: row.status,
    to: runThreadPage(row),
    error: row.status === "failed" ? row.error : null,
  };
}
