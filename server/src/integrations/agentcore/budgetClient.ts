/**
 * HOW A CHILD PROCESS LEARNS THE RESPONSE BUDGET.
 *
 * Two processes shape tool answers and neither of them may touch the database:
 * `skills/mcp.ts`, which an agent spawns and keeps alive for days, and
 * `cli/opc.ts`, which runs for a hundred milliseconds and exits. Both need one
 * integer, and the ways of giving it to them are worse than a fetch:
 *
 *   AN ENVIRONMENT VARIABLE is fixed at spawn. An owner who lowers the budget
 *   because their local model has an 8k window would have to restart a process
 *   they did not start, with nothing telling them so. It is still honoured —
 *   `OPC_RESPONSE_BYTES` overrides everything — because a person debugging one
 *   call wants a way to say "not this time" that does not involve a settings
 *   page.
 *
 *   A DATABASE HANDLE would put a second writer near a SQLite file whose whole
 *   design says there is one. See skills/mcp.ts's header, which refuses the
 *   same thing for the same reason.
 *
 * So: one loopback GET, cached for a minute in the long-lived process and
 * effectively once in the short-lived one. A failure is not an error — the
 * default stands and the tool answer is still bounded, which is the outcome
 * that matters. A budget that could not be read must never mean "no budget".
 */
import { DEFAULT_RESPONSE_BYTES } from "./bound.ts";

const TTL_MS = 60_000;
let cached: { bytes: number; at: number } | null = null;

export async function responseBudgetOverLoopback(
  api: string,
  headers: Record<string, string>,
): Promise<number> {
  const forced = Number((process.env.OPC_RESPONSE_BYTES ?? "").trim());
  if (Number.isFinite(forced) && forced >= 1024) return Math.floor(forced);

  if (cached && Date.now() - cached.at < TTL_MS) return cached.bytes;
  try {
    const res = await fetch(`${api}/api/agentcore/limits`, {
      headers,
      /* Short, because this runs BEFORE the call the agent is waiting on. A
         settings lookup that hangs would make every tool slow to answer. */
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      const doc = (await res.json()) as { responseBytes?: unknown };
      const n = Number(doc.responseBytes);
      if (Number.isFinite(n) && n >= 1024) {
        cached = { bytes: Math.floor(n), at: Date.now() };
        return cached.bytes;
      }
    }
  } catch {
    /* The server is restarting, or this is an older build with no such route.
       The default is a real budget and is applied either way. */
  }
  cached = { bytes: DEFAULT_RESPONSE_BYTES, at: Date.now() };
  return cached.bytes;
}
