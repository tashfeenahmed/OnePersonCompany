import { workflow } from "./workflow-store.ts";
import { registeredStages, setWorkflowResolver, type Stage, type StageContext, type StageResult } from "./registry.ts";
import { BLOCK_DESCRIPTIONS, type BlockKind, type WorkflowBlock } from "../../../../shared/workflow.ts";
import { runAgentBlock } from "./workflow-agents.ts";
import { refreshForWorkflow } from "../deploy/scheduler.ts";
import { evaluateAll } from "../proactive/engine.ts";
import { scanAll } from "../mailflow/triage.ts";
import { writeBrief } from "../people/brief.ts";
import { consolidate } from "../chief/memory.ts";
import { build } from "../proactive/briefing.ts";
import { syncBoardCards } from "../../board/automation.ts";

type Execute = (block: WorkflowBlock, ctx: StageContext) => Promise<StageResult>;
const executors = new Map<BlockKind, Execute>();
/** Each adapter owns its work; orchestration and the editor share its block kind. */
export function registerWorkflowExecutor(kind: BlockKind, execute: Execute) { executors.set(kind, execute); }
export function workflowStages(registered: Stage[]): Stage[] {
  const doc = workflow();
  if (!doc.saved) return registered;
  return doc.definition.blocks.map(b => ({
    id: b.id, area: b.kind === "agent" ? "subagents" : "workflow", title: b.title, about: BLOCK_DESCRIPTIONS[b.kind],
    deps: b.dependsOn, requireSuccess: b.requireSuccess, definition: b, defaultEnabled: b.enabled, defaultCadence: b.cadence,
    defaultWindow: null, budget: { maxMinutes: b.maxMinutes },
    run: async ctx => {
      if (ctx.dry && b.kind !== "agent") return { outcome: "completed", note: `Would run ${b.title}. No work or model calls were started.` };
      const execute = executors.get(b.kind);
      if (!execute) return { outcome: "failed", error: `No executor is registered for ${b.kind}.` };
      return execute(b, ctx);
    },
  }));
}
export function installWorkflowEngine() {
  registerWorkflowExecutor("agent", runAgentBlock);
  registerWorkflowExecutor("collect", async (_b, ctx) => {
    const counts = await refreshForWorkflow(ctx.signal);
    return { outcome: counts.failed ? "failed" : "completed", counts,
      note: `${counts.refreshed} sources refreshed; ${counts.reused} recent sources reused; ${counts.failed} failed.`,
      ...(counts.failed ? { error: "Some connected sources could not be refreshed; analysis will identify missing data." } : {}) };
  });
  registerWorkflowExecutor("alerts", async (_b, ctx) => { await evaluateAll(ctx.signal); return { outcome: "completed", note: "Alert rules evaluated against the collected data." }; });
  registerWorkflowExecutor("triage", async () => {
    const rows = await scanAll(), failed = rows.filter(r => !r.ok || r.unscored > 0);
    return { outcome: failed.length ? "failed" : "completed", counts: { accounts: rows.length, failed: failed.length },
      note: `Reviewed ${rows.length} connected inboxes.`,
      error: failed.length ? failed.map(r => `${r.accountLabel}: ${r.error ?? r.note ?? `${r.unscored} threads could not be scored`}`).join("; ") : null };
  });
  for (const kind of ["synthesis", "seo-ops"] as const) registerWorkflowExecutor(kind, async (_b, ctx) => {
    const s = registeredStages().find(s => s.id === kind);
    return s?.run ? s.run(ctx) : { outcome: "failed", error: `${kind} has not registered its executor.` };
  });
  registerWorkflowExecutor("board", async () => { const out = await syncBoardCards(); return { outcome: out.errors.length ? "failed" : "completed", counts: { filed: out.filed }, note: `${out.filed} new actionable cards filed.`, error: out.errors.join(" ") || null }; });
  registerWorkflowExecutor("relationships", async () => {
    const out = await writeBrief();
    return { outcome: out.row?.error ? "failed" : "completed", error: out.row?.error,
      note: out.written ? "The weekly relationship figures are saved." : out.reason ?? "The weekly review is current." };
  });
  registerWorkflowExecutor("memory", async () => {
    const out = await consolidate();
    return { outcome: out.error ? "failed" : "completed", error: out.error,
      counts: { merged: out.merged, dropped: out.dropped }, note: out.why ?? "Memory consolidation complete." };
  });
  registerWorkflowExecutor("briefing", async (_b, ctx) => {
    const out = await build({ signal: ctx.signal, force: true, inAppOnly: true });
    return { outcome: out.row.markdown.trim() ? "completed" : "failed", error: out.row.markdown.trim() ? null : out.row.note ?? "The model did not return a morning brief.",
      note: `Morning briefing data saved for ${out.day}.` };
  });
  setWorkflowResolver(workflowStages);
}
