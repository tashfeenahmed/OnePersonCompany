import { configValue, db, now, ventureRows } from "../../db.ts";
import { ROLES } from "../subagents/store.ts";
import { isBusinessType } from "../../../../shared/ventureJourney.ts";
import { BLOCK_KINDS, nightlyTemplate, type WorkflowDefinition, type WorkflowDocument } from "../../../../shared/workflow.ts";

export function workflow(): WorkflowDocument {
  const r = db.prepare("SELECT revision,definition,updated_at FROM pipeline_workflow WHERE id=1").get() as { revision: number; definition: string; updated_at: string } | undefined;
  return r ? { revision: r.revision, saved: true, updatedAt: r.updated_at, definition: JSON.parse(r.definition) } :
    { revision: 0, saved: false, updatedAt: null, definition: nightlyTemplate() };
}
/** Prevent a feature's independent timer duplicating work owned by the night. */
export function workflowOwns(kind: string): boolean {
  if (!["on","yes","true"].includes((configValue("pipeline","enabled") ?? "").trim().toLowerCase())) return false;
  const doc=workflow(); return doc.saved && doc.definition.blocks.some(b => b.kind===kind && b.enabled);
}
export class WorkflowError extends Error { status: 400 | 409 = 400; }
const reject = (message: string): never => { throw new WorkflowError(message); };
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string") && new Set(v).size === v.length;
export function validateWorkflow(raw: unknown): WorkflowDefinition {
  if (!raw || typeof raw !== "object") return reject("Expected a workflow.");
  const d = raw as WorkflowDefinition;
  if (typeof d.name !== "string" || !d.name.trim() || d.name.length > 100) return reject("Give the workflow a name of up to 100 characters.");
  if (!Array.isArray(d.blocks) || !d.blocks.length || d.blocks.length > 40) return reject("A workflow needs 1–40 blocks.");
  const ids = new Set<string>(), ventures = new Set(ventureRows().map(v => v.id));
  for (const b of d.blocks) {
    if (!b || typeof b !== "object" || !/^wf-[a-z0-9-]{1,70}$/.test(b.id) || ids.has(b.id)) return reject("Each block needs a unique workflow ID.");
    if (!BLOCK_KINDS.includes(b.kind)) return reject("Choose a supported block type.");
    if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 120) return reject("Each block needs a title of up to 120 characters.");
    if (typeof b.enabled !== "boolean" || typeof b.requireSuccess !== "boolean") return reject("Block switches must be true or false.");
    if (!["daily", "weekly", "monthly"].includes(b.cadence)) return reject("Choose a daily, weekly or monthly cadence.");
    if (!Number.isInteger(b.maxMinutes) || b.maxMinutes < 1 || b.maxMinutes > 240) return reject("Block time limits must be 1–240 minutes.");
    if (!strings(b.dependsOn) || b.dependsOn.some(id => !ids.has(id))) return reject(`${b.title}: dependencies must appear before this block. Move its prerequisites first.`);
    if (b.kind === "agent") {
      const a = b.agent;
      if (!a || !ROLES.some(r => r.role === a.role)) return reject("Choose an available venture sub-agent role.");
      if (typeof a.instructions !== "string" || !a.instructions.trim() || a.instructions.length > 4000) return reject("Agent instructions need 1–4000 characters.");
      if (!strings(a.ventureIds) || a.ventureIds.some(id => !ventures.has(id))) return reject("Choose ventures that exist in this workspace.");
      if (!strings(a.stages) || !a.stages.length || a.stages.some(s => !["idea", "pre-launch", "launched"].includes(s))) return reject("Choose at least one venture stage.");
      if (!strings(a.businessTypes) || a.businessTypes.some(s => !isBusinessType(s))) return reject("Choose supported business types.");
      if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 20 || !Number.isInteger(a.daysBetween) || a.daysBetween < 0 || a.daysBetween > 365) return reject("Choose 1–20 ventures per block and 0–365 days between reviews.");
    }
    ids.add(b.id);
  }
  // A report must follow every specialist that can contribute to it. The saved
  // order is the execution order; never silently rearrange the owner's blocks.
  const active = d.blocks.filter(b => b.enabled);
  const synthesis = active.findIndex(b => b.kind === "synthesis"), brief = active.findIndex(b => b.kind === "briefing");
  if (synthesis >= 0 && active.some((b, i) => b.kind === "agent" && i > synthesis)) return reject("Place findings after the sub-agent blocks so it can use their finished reports.");
  if (brief >= 0 && brief !== active.length - 1) return reject("Place the morning brief last so it includes the whole run.");
  if (active.filter(b => b.kind === "collect").length > 1 || active.filter(b => b.kind === "synthesis").length > 1 || active.filter(b => b.kind === "briefing").length > 1) return reject("Use one collection, findings and morning-brief block per workflow.");
  return JSON.parse(JSON.stringify(d));
}
export function saveWorkflow(revision: number, raw: unknown): WorkflowDocument {
  const definition = validateWorkflow(raw);
  if (!Number.isInteger(revision) || revision < 0) return reject("A saved revision is required.");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (workflow().revision !== revision) { const e = new WorkflowError("The workflow changed in another tab. Reload it before saving."); e.status = 409; throw e; }
    db.prepare("INSERT INTO pipeline_workflow(id,revision,definition,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,definition=excluded.definition,updated_at=excluded.updated_at")
      .run(revision + 1, JSON.stringify(definition), now());
    db.exec("COMMIT"); return workflow();
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
