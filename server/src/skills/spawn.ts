/**
 * HOW TO LAUNCH THE MCP SERVER — one description, read by both agents' config
 * writers.
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
 */
export function mcpCommand(): McpCommand {
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", fileURLToPath(new URL("mcp.ts", import.meta.url))],
    env: { OPC_API: apiBase() },
  };
}

/** The same command, pinned to one integration. `OPC_SKILL` is what makes the
 *  child answer for that skill alone and name itself after it — see mcp.ts. */
export function mcpCommandFor(skillId: string): McpCommand {
  const base = mcpCommand();
  return { ...base, env: { ...base.env, OPC_SKILL: skillId } };
}
