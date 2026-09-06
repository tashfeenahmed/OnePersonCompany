import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { skills } from "./registry.ts";
import { mcpCommandFor } from "./spawn.ts";

export function openClawSkillServers() {
  return Object.fromEntries(skills().map(skill => [`opc-${skill.id}`, mcpCommandFor(skill.id)]));
}

/** Update managed MCP entries after connecting/disconnecting a plugin. Preserve other settings. */
export function syncOpenClawSkills(file: string): boolean {
  if (!existsSync(file)) return false;
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const previous = doc.mcp?.servers ?? {};
  const servers = {
    ...Object.fromEntries(Object.entries(previous).filter(([id]) => !id.startsWith("opc-"))),
    ...openClawSkillServers(),
  };
  if (JSON.stringify(previous) === JSON.stringify(servers)) return false;
  doc.mcp = { ...doc.mcp, servers };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return true;
}
