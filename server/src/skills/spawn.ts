/**
 * HOW TO LAUNCH THE MCP SERVER — one description, read by OpenClaw's config
 * writer (Hermes gets the `opc` command instead — see cli.ts).
 *
 * It is its own module rather than an export of `mcp.ts` because importing that
 * file RUNS it: it attaches a stdin handler and starts speaking JSON-RPC on
 * stdout the moment it is loaded. An `import { mcpCommand } from "./mcp.ts"` in
 * the API process would therefore hand the API's own stdout to a protocol
 * nobody is listening to, and the failure would look like a server that had
 * stopped logging.
 *
 * `process.execPath` rather than the string "node", for the reason
 * agents/instance.ts refuses to assume `uv` is on the PATH: this process was
 * started by a terminal, a launcher or a service manager, and only one of those
 * reliably carries a PATH the child would find an interpreter on. The
 * interpreter running this file is by definition the right one.
 */
import { fileURLToPath } from "node:url";
import { apiBase } from "./registry.ts";
import { agentKey } from "../auth.ts";

export type McpCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/**
 * The stdio MCP server, as an agent has to spell it.
 *
 * `--experimental-strip-types` is passed even though Node 24 strips types
 * without it, because it is what every other entry point in this repo is run
 * with and a divergence here would be a thing that works until somebody runs
 * the box on an older Node and gets a syntax error inside a subprocess an agent
 * spawned — which is about the least discoverable failure available.
 *
 * `OPC_API` is passed explicitly rather than inherited: Hermes documents that
 * an stdio MCP server receives "only these + safe defaults", so an env this
 * function did not name is an env the child does not have.
 *
 * `OPC_KEY` IS THERE FOR THE SAME REASON AND IS WHAT KEEPS THIS WORKING once
 * the owner puts a password on the dashboard: an MCP subprocess has no cookie
 * jar and would be refused at the gate on its first `tools/list`. It is read
 * from the key file at the moment the command is DESCRIBED rather than baked in
 * at import, so a config rewritten after a rotation carries the new one. See
 * server/src/auth.ts on exactly what the key is worth.
 */
export function mcpCommand(): McpCommand {
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", fileURLToPath(new URL("mcp.ts", import.meta.url))],
    env: { OPC_API: apiBase(), OPC_KEY: agentKey() },
  };
}

/** The same command, pinned to one integration. `OPC_SKILL` is what makes the
 *  child answer for that skill alone and name itself after it — see mcp.ts. */
export function mcpCommandFor(skillId: string): McpCommand {
  const base = mcpCommand();
  return { ...base, env: { ...base.env, OPC_SKILL: skillId } };
}
