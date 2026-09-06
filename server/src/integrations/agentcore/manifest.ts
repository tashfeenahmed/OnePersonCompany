/**
 * AGENTCORE — the runtime the chat agent runs in, as an area.
 *
 * It owns no credential and collects nothing. What it owns are the two facts
 * that make an agent on this box dependable rather than merely present:
 *
 *   A CHAT TURN IS THE SERVER'S WORK. `chat/runs.ts` holds the run, buffers
 *   its events with sequence numbers, and lets a page that reloaded reattach
 *   from where it left off. The table is `chat_runs` (migrations.ts) and the
 *   routes are on /api/chat, because that is where a chat's doors already are.
 *
 *   A TOOL ANSWER HAS A CEILING. `bound.ts` shapes any skill response that
 *   would not fit — summary fields kept, rows shortened with a marker saying
 *   how many exist, never a document cut through the middle. The MCP server
 *   and the `opc` CLI both use it, and both read the ceiling from
 *   /api/agentcore/limits.
 *
 * ONE CONFIG-ONLY PSEUDO-PLUGIN, on the pattern `briefing` and `backups`
 * already keep: no secret, no account, a row in `plugins` created at start-up
 * so `plugin_config`'s foreign key has something to point at, and settings that
 * appear on the Integrations page beside the plugins they sit with.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { upsertPlugin } from "../../db.ts";
import { agentcoreRoutes } from "./routes.ts";
import { AGENTCORE_PLUGIN, DEFAULT_RESPONSE_BYTES, failInterruptedChatRuns } from "./store.ts";

export const manifest: IntegrationManifest = {
  id: "agentcore",

  config: {
    [AGENTCORE_PLUGIN]: {
      keys: {
        response_bytes: {
          label: "Tool response budget (bytes)",
          hint:
            `How much of one skill answer the agent is allowed to read, in bytes. ` +
            `Default ${DEFAULT_RESPONSE_BYTES} (24 KB). A document over the budget is ` +
            `SHAPED rather than cut: every scalar and summary field survives, the ` +
            `longest lists lose rows, and each shortened list ends with ` +
            `{"truncated":true,"shown":…,"total":…} so the agent knows what it did not ` +
            `see and how to ask for the rest. Raise it for a model with a large ` +
            `window; lower it for a local 8k one, where a single big document is the ` +
            `difference between an answer and a silence. Minimum 1024 — below that ` +
            `the default stands, because a budget of nothing would empty every tool ` +
            `answer on the box.`,
          ph: String(DEFAULT_RESPONSE_BYTES),
          check(value) {
            const raw = value.trim();
            if (!raw) return null;
            const n = Number(raw);
            if (!Number.isFinite(n)) return `“${raw}” is not a number of bytes.`;
            if (n < 1024) return "A budget under 1024 bytes would leave no room for an answer.";
            if (n > 4 * 1024 * 1024)
              return "Over 4 MB is not a budget — it is the whole document, and the point of this setting is that some documents are too big to read.";
            return null;
          },
        },
      },
      /* The row is created on demand for the reason routes/pluginConfig.ts's
         own writers create theirs: `plugin_config` has a foreign key onto
         `plugins`, so a setting cannot be stored until the plugin exists. */
      after() {
        upsertPlugin(AGENTCORE_PLUGIN, true, null);
      },
    },
  },

  routes: [{ path: "/api/agentcore", app: agentcoreRoutes }],

  /**
   * Two things, neither of which may throw.
   *
   * THE ROW BEFORE THE SETTINGS, as above and for the same reason.
   *
   * AND THE RUNS THIS PROCESS DOES NOT HAVE. A row still marked `running` after
   * a restart is a claim nothing can make good on — the events were in memory
   * and the agent call died with the process — and a page that believed it
   * would wait forever for a stream that will never open. Cleared here, before
   * anything can read the table.
   */
  onStart() {
    upsertPlugin(AGENTCORE_PLUGIN, true, null);
    const stale = failInterruptedChatRuns();
    if (stale) console.log(`[agentcore] ${stale} chat run(s) did not survive the restart`);
  },
};
