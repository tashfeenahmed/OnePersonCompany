import { setTimeout as delay } from "node:timers/promises";
import { db, now, ventureRows } from "../../db.ts";
import { ensureTeam, subagentId, subagentRow, roleDef } from "../subagents/store.ts";
import { dispatch } from "../subagents/routes.ts";
import { runRow } from "../runs/store.ts";
import { cancelRun } from "../runs/executor.ts";
import { queuePaused } from "../../runtime/budgets.ts";
import type { WorkflowBlock } from "../../../../shared/workflow.ts";
import type { StageContext, StageResult } from "./registry.ts";

export function agentCandidates(block: WorkflowBlock) {
  const a = block.agent!;
  const history = db.prepare(`SELECT j.venture_id,MAX(j.created_at) AS attempted,
    MAX(CASE WHEN r.status='done' THEN r.finished_at END) AS completed
    FROM pipeline_block_jobs j LEFT JOIN agent_runs r ON r.id=j.agent_run_id WHERE j.block_id=? GROUP BY j.venture_id`)
    .all(block.id) as { venture_id: string; attempted: string; completed: string | null }[];
  const byVenture = new Map(history.map(h => [h.venture_id, h]));
  return ventureRows().filter(v => {
    if (a.ventureIds.length && !a.ventureIds.includes(v.id)) return false;
    if (!a.stages.includes(v.stage)) return false;
    const types = JSON.parse(v.business_types ?? "[]") as string[];
    if (a.businessTypes.length && !a.businessTypes.some(t => types.includes(t) || v.business_type === t)) return false;
    if (["seo", "serp", "visibility"].includes(a.role) && !v.host) return false;
    const last = byVenture.get(v.id)?.completed;
    return !last || Date.parse(last) <= Date.now() - a.daysBetween * 86_400_000;
  }).sort((a,b) => (byVenture.get(a.id)?.attempted ?? "").localeCompare(byVenture.get(b.id)?.attempted ?? "") || a.id.localeCompare(b.id)).slice(0, a.limit);
}

/** The same dispatch/queue as manual sub-agents. Injected functions let tests
 * exercise waiting, failure and cancellation without starting a real model. */
export async function runAgentBlock(block: WorkflowBlock, ctx: StageContext, io: {
  dispatch: (...args: Parameters<typeof dispatch>) => { status: number; json: unknown };
  read: typeof runRow; cancel: typeof cancelRun; delayMs: number;
} = { dispatch, read: runRow, cancel: cancelRun, delayMs: 1000 }): Promise<StageResult> {
  const candidates = agentCandidates(block);
  if (ctx.dry) return { outcome: "completed", note: `Would ask ${block.agent!.role} to review ${candidates.length} due ventures, then wait for each report.`, counts: { eligible: candidates.length } };
  if (!candidates.length) return { outcome: "skipped", reason: "No matching ventures are due for this specialist." };
  if (queuePaused()) return { outcome: "failed", error: "The sub-agent queue is paused. Resume it before running this block." };
  const counts = { completed: 0, failed: 0, skipped: 0, dispatched: 0 };
  for (const v of candidates) {
    ctx.signal.throwIfAborted();
    const held = db.prepare("SELECT agent_run_id FROM pipeline_block_jobs WHERE run_id=? AND block_id=? AND venture_id=?").get(ctx.runId,block.id,v.id) as { agent_run_id: string } | undefined;
    let id = held?.agent_run_id;
    if (!id) {
      const kind = roleDef(block.agent!.role)!.kind;
      if (db.prepare("SELECT id FROM agent_runs WHERE venture_id=? AND kind=? AND status IN ('queued','running')").get(v.id,kind)) { counts.skipped++; continue; }
      ensureTeam(v.id);
      const agent = subagentRow(subagentId(v.id, block.agent!.role));
      if (!agent || !agent.enabled) { counts.skipped++; continue; }
      const result = io.dispatch(agent, { parentSessionId: "pipeline", brief: `Scheduled workflow: ${block.title}. Venture stage: ${v.stage}.\n\n${block.agent!.instructions}\n\nUse the connected data available to this venture. Distinguish measured facts from missing data, cite sources, and report concrete findings. Do not send messages or publish changes.` });
      if (result.status !== 201) { counts.failed++; continue; }
      id = (result.json as { run: { id: string } }).run.id;
      db.prepare("INSERT INTO pipeline_block_jobs(run_id,block_id,venture_id,agent_run_id,created_at) VALUES(?,?,?,?,?)").run(ctx.runId,block.id,v.id,id,now());
      counts.dispatched++;
    }
    try {
      // Never treat "queued" as a completed analysis, even when another job
      // occupies the worker. Cancellation only stops jobs this block owns.
      for (;;) {
        ctx.signal.throwIfAborted();
        const r = io.read(id);
        if (!r) { counts.failed++; break; }
        if (r.status === "done") { counts.completed++; break; }
        if (r.status === "failed" || r.status === "cancelled") { counts.failed++; break; }
        await delay(io.delayMs, undefined, { signal: ctx.signal });
      }
    } catch (e) {
      io.cancel(id);
      if (ctx.signal.aborted) return { outcome: "failed", error: "Block stopped before all reports finished. Its unfinished job was cancelled.", counts };
      throw e;
    }
  }
  return { outcome: counts.failed ? "failed" : counts.completed ? "completed" : "skipped",
    ...(counts.failed ? { error: `${counts.failed} analysis jobs failed. Open their reports for details.` } : {}),
    ...(counts.completed || counts.failed ? {} : { reason: "Matching specialists are already busy or switched off." }),
    note: `${counts.completed} reports completed; ${counts.failed} failed; ${counts.skipped} busy or disabled specialists skipped.`, counts };
}
