/** Every area's migrations, in area order. Pure — see manifest.ts. */
import { MIGRATIONS as analytics } from "./analytics/migrations.ts";
import { MIGRATIONS as ops } from "./ops/migrations.ts";
import { MIGRATIONS as signals } from "./signals/migrations.ts";
import { MIGRATIONS as ventures } from "./ventures/migrations.ts";
import { MIGRATIONS as runs } from "./runs/migrations.ts";
import { MIGRATIONS as subagents } from "./subagents/migrations.ts";
import { MIGRATIONS as chief } from "./chief/migrations.ts";
import { MIGRATIONS as mailflow } from "./mailflow/migrations.ts";
import { MIGRATIONS as activity } from "./activity/migrations.ts";
import { MIGRATIONS as proactive } from "./proactive/migrations.ts";
import { MIGRATIONS as people } from "./people/migrations.ts";
import { MIGRATIONS as security } from "./security/migrations.ts";
import { MIGRATIONS as video } from "./video/migrations.ts";
import { MIGRATIONS as growth } from "./growth/migrations.ts";

export const INTEGRATION_MIGRATIONS = [...analytics, ...ops, ...signals, ...ventures, ...runs, ...subagents, ...chief, ...mailflow, ...activity, ...proactive, ...people, ...security, ...video, ...growth, { name: "190_workspace_preferences", sql: `CREATE TABLE workspace_preferences (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);` },
  { name: "191_action_inbox", sql: `CREATE TABLE action_inbox_state (id TEXT PRIMARY KEY, resolved_at TEXT, snoozed_until TEXT);` },
  { name: "192_job_controls", sql: `
    ALTER TABLE agent_runs ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN resume_checkpoints INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE budget_usage (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, venture_id TEXT, automation INTEGER NOT NULL, at TEXT NOT NULL, tokens INTEGER NOT NULL, usd REAL NOT NULL, status TEXT NOT NULL);
    CREATE INDEX budget_usage_at ON budget_usage(at);
    CREATE INDEX budget_usage_run ON budget_usage(run_id);
    CREATE TABLE run_checkpoints (run_id TEXT NOT NULL, step_key TEXT NOT NULL, reply TEXT NOT NULL, PRIMARY KEY(run_id,step_key));
  ` },
];
