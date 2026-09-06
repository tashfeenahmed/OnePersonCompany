/**
 * HOW THE AGENT RUNS `opc` — the wrapper this app writes so the command exists.
 *
 * `src/cli/opc.ts` is a TypeScript file that wants the interpreter running this
 * process and one environment variable. A Hermes terminal has neither on hand:
 * its PATH is the gateway's, which was started by whatever started the API and
 * is not guaranteed to find a `node`, let alone the right one. So the app writes
 * a two-line shell wrapper that says both with absolute paths, into a directory
 * of its own that the gateway's PATH is then made to start with. The agent
 * types `opc`; the shell finds this; this finds the interpreter.
 *
 * `process.execPath` for spawn.ts's reason: the interpreter running this file
 * is by definition the right one. `OPC_API` is written into the wrapper rather
 * than inherited so the child cannot be pointed elsewhere by an environment it
 * did not choose.
 *
 * `OPC_KEY` IS READ FROM A FILE AT EVERY INVOCATION RATHER THAN WRITTEN IN, and
 * that asymmetry with OPC_API is the point. This is what keeps the agent
 * working once the owner puts a password on the dashboard (see auth.ts): a
 * terminal command has no cookie jar. `$(cat …)` means rotating the key is
 * replacing one file — nothing is rewritten and no agent is restarted — and it
 * means the wrapper's own text does not contain a credential that would then be
 * sitting in the agent's home directory at 0755. On a box with no password the
 * variable is a key the gate is not looking at, which costs nothing.
 *
 * Written only when the content differs, like the packs, so a reconfigure that
 * changed nothing leaves the mtime alone.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiBase } from "./registry.ts";
import { SERVICE_KEY_FILE, serviceKey } from "../auth.ts";

export const CLI_NAME = "opc";

/** The script the wrapper runs. */
export function cliScript(): string {
  return fileURLToPath(new URL("../cli/opc.ts", import.meta.url));
}

/** The wrapper's text: a shell that execs the right node on the right file. */
function wrapper(): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    "#!/bin/sh",
    "# Written by onepersoncompany. `opc` is this dashboard's own live data as a",
    "# command — `opc` alone lists what is connected; `opc help <id>` explains one.",
    `OPC_KEY=$(cat ${q(SERVICE_KEY_FILE)} 2>/dev/null) OPC_API=${q(apiBase())} exec ${q(process.execPath)} --experimental-strip-types ${q(cliScript())} "$@"`,
    "",
  ].join("\n");
}

/**
 * Put `opc` in `binDir`, executable. Returns the path, and whether the file
 * changed — the caller does not need to restart anything for it (the wrapper
 * is read on every invocation), but it logs it.
 */
export function installCli(binDir: string): { path: string; changed: boolean } {
  /* Minted here if it does not exist yet, because the wrapper about to be
     written reads it with `cat` and a shell cannot create it. */
  serviceKey();
  const path = join(binDir, CLI_NAME);
  const next = wrapper();
  let current: string | null = null;
  try {
    current = existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    current = null;
  }
  if (current === next) return { path, changed: false };
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path, next, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { path, changed: true };
}
