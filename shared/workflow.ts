/** Persisted workflow vocabulary, shared by the editor and execution adapters. */
export const BLOCK_KINDS = ["collect", "alerts", "agent", "triage", "synthesis", "board", "seo-ops", "relationships", "memory", "briefing"] as const;
export type BlockKind = typeof BLOCK_KINDS[number];
export type WorkflowBlock = {
  id: string;
  kind: BlockKind;
  title: string;
  enabled: boolean;
  cadence: "daily" | "weekly" | "monthly";
  maxMinutes: number;
  dependsOn: string[];
  /** Dependencies order work; this additionally requires their success. */
  requireSuccess: boolean;
  agent?: {
    role: string;
    instructions: string;
    ventureIds: string[];
    stages: string[];
    businessTypes: string[];
    limit: number;
    daysBetween: number;
  };
};
export type WorkflowDefinition = { name: string; blocks: WorkflowBlock[] };
export type WorkflowDocument = { revision: number; saved: boolean; updatedAt: string | null; definition: WorkflowDefinition };
export const BLOCK_LABELS: Record<BlockKind, string> = {
  collect: "Refresh connected data", alerts: "Check alerts", agent: "Sub-agent analysis",
  triage: "Review incoming mail", synthesis: "Find the next actions", board: "File actionable board cards",
  "seo-ops": "SEO follow-ups and visual checks", relationships: "Relationship review", memory: "Consolidate memory", briefing: "Morning brief",
};
export const BLOCK_DESCRIPTIONS: Record<BlockKind, string> = {
  collect: "Refresh connected sources before analysis. Sources refreshed recently are reused.",
  alerts: "Evaluate alert rules against the collected data.",
  agent: "Give a specialist a brief and wait for its reports. Ventures rotate fairly between runs.",
  triage: "Review connected inboxes and identify mail that needs attention.",
  synthesis: "Combine evidence and completed reports into ranked, checked board proposals.",
  board: "File pending work and actionable issues, keeping existing cards and decisions intact.",
  "seo-ops": "Read due search follow-ups and run opted-in visual checks.",
  relationships: "Review the week's correspondence and relationship changes.",
  memory: "Merge duplicate notes and retire stale memory.",
  briefing: "Summarise current figures, findings and outstanding work in the app.",
};

export function newBlock(kind: BlockKind, id: string): WorkflowBlock {
  return { id, kind, title: BLOCK_LABELS[kind], enabled: true,
    cadence: kind === "relationships" || kind === "memory" ? "weekly" : "daily",
    maxMinutes: kind === "agent" ? 25 : kind === "collect" ? 15 : 10,
    dependsOn: [], requireSuccess: false,
    ...(kind === "agent" ? { agent: { role: "demand", instructions: "Review what changed, cite the evidence and recommend concrete next steps. Say when nothing needs attention.", ventureIds: [], stages: ["pre-launch", "launched"], businessTypes: [], limit: 2, daysBetween: 7 } } : {}),
  };
}
export function nightlyTemplate(): WorkflowDefinition {
  const block = (kind: BlockKind, id: string) => newBlock(kind, id);
  const agents = [
    ["seo", "SEO analyst"], ["demand", "Demand analyst"], ["competitors", "Competitor analyst"],
    ["visibility", "AI visibility analyst"], ["researcher", "Researcher"], ["aso", "App store analyst"],
  ].map(([role, title]) => {
    const b = block("agent", `wf-${role}`); b.title = title!; b.agent!.role = role!;
    b.dependsOn = ["wf-collect"];
    if (role === "aso") b.agent!.businessTypes = ["mobile"];
    if (role === "seo" || role === "visibility" || role === "aso") b.agent!.stages = ["launched"];
    return b;
  });
  const collect = block("collect", "wf-collect");
  const alerts = block("alerts", "wf-alerts"); alerts.dependsOn = [collect.id];
  const triage = block("triage", "wf-triage"); triage.dependsOn = [collect.id];
  const synthesis = block("synthesis", "wf-synthesis"); synthesis.maxMinutes = 20;
  synthesis.dependsOn = agents.map(b => b.id);
  const board = block("board", "wf-board"); board.dependsOn = [synthesis.id, alerts.id, triage.id];
  const seo = block("seo-ops", "wf-seo-ops"); seo.dependsOn = [synthesis.id];
  const relationships = block("relationships", "wf-relationships"); relationships.dependsOn = [triage.id];
  const memory = block("memory", "wf-memory");
  const briefing = block("briefing", "wf-briefing");
  const blocks = [collect, alerts, triage, ...agents, synthesis, board, seo, relationships, memory, briefing];
  briefing.dependsOn = blocks.slice(0, -1).map(b => b.id);
  return { name: "Nightly business review", blocks };
}
