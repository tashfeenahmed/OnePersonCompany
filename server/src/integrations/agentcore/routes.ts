/**
 * WHAT THE AGENT'S OWN PROCESSES HAVE TO ASK THIS ONE.
 *
 * The MCP server (skills/mcp.ts) and the `opc` CLI (cli/opc.ts) are separate
 * processes with no database handle — deliberately, because a second writer
 * near a SQLite file whose whole design says there is one writer is a bug
 * waiting for a busy timeout. So the one setting they need, the response
 * budget, is read over loopback from here rather than out of `plugin_config`.
 *
 * IT IS A ROUTE RATHER THAN AN ENVIRONMENT VARIABLE, and that is the whole
 * decision in this file. The environment is fixed when the process is spawned;
 * an agent's MCP server is spawned by the agent and can live for days. An owner
 * who lowers the budget because their local model has an 8k window would then
 * have to restart something they did not start, and would get no sign that they
 * needed to. A route is read fresh (the callers cache it for a minute, see
 * `budgetClient.ts`), so the setting takes effect on the next tool call.
 */
import { Hono } from "hono";
import { responseBudget, runningChatRuns } from "./store.ts";
import { PAGING_PARAMS } from "./bound.ts";

export const agentcoreRoutes = new Hono();

/**
 * The response budget, and the three parameters every proxied read honours.
 *
 * Answered to anybody, because it is not a secret and because the two callers
 * that need it are this machine talking to itself. `source` says whether the
 * number is the owner's or the default — the difference between "you set this"
 * and "nobody has thought about it", which is what a settings page has to be
 * able to draw.
 */
agentcoreRoutes.get("/limits", (c) => {
  const b = responseBudget();
  return c.json({
    responseBytes: b.bytes,
    source: b.source,
    params: PAGING_PARAMS,
    measured: "bytes of UTF-8, of the document as it is printed",
  });
});

/**
 * Which chat turns are open, AS THE TABLE HAS IT.
 *
 * THE TABLE AND NOT THE MEMORY, and that is a deliberate limitation of this
 * route rather than an oversight. The live list is `GET /api/chat/runs`, which
 * is where the run engine already answers it; importing that engine here would
 * put `integrations/index.ts` in an import cycle with the chat routes, and a
 * cycle at module scope on this server is a start-up crash rather than a
 * warning (routes/pluginConfig.ts reads the manifest list while it is being
 * built). What this answers is the durable half — the rows — which is what a
 * person debugging a run that vanished actually wants to see.
 *
 * A row marked running that no run holds is the residue of a restart, and
 * start-up corrects those (see `failInterruptedChatRuns`).
 */
agentcoreRoutes.get("/runs", (c) => {
  const rows = runningChatRuns();
  return c.json({
    rows: rows.map((r) => ({
      runId: r.id,
      sessionId: r.session_id,
      status: r.status,
      startedAt: r.started_at,
      channel: r.channel,
      backend: r.backend,
    })),
    count: rows.length,
  });
});
