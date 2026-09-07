/** Every area's migrations, sorted by name. Pure — see manifest.ts. */
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
import { MIGRATIONS as videoplus } from "./videoplus/migrations.ts";
import { MIGRATIONS as growth } from "./growth/migrations.ts";
import { MIGRATIONS as publishing } from "./publishing/migrations.ts";
import { MIGRATIONS as nurture } from "./nurture/migrations.ts";
import { MIGRATIONS as mobilehealth } from "./mobilehealth/migrations.ts";
import { MIGRATIONS as agentcore } from "./agentcore/migrations.ts";
import { MIGRATIONS as knowledge } from "./knowledge/migrations.ts";
import { MIGRATIONS as deploy } from "./deploy/migrations.ts";
import { MIGRATIONS as finance } from "./finance/migrations.ts";
import { MIGRATIONS as customers } from "./customers/migrations.ts";
import { MIGRATIONS as pipeline } from "./pipeline/migrations.ts";
import { MIGRATIONS as webanalytics } from "./webanalytics/migrations.ts";
import { MIGRATIONS as migrate } from "./migrate/migrations.ts";
import { MIGRATIONS as seoops } from "./seoops/migrations.ts";
import { MIGRATIONS as socialfeed } from "./socialfeed/migrations.ts";
import { MIGRATIONS as runtime } from "./runtime/migrations.ts";

/**
 * SORTED BY NAME AT BUILD TIME, NOT RENUMBERED.
 *
 * The numeric prefix says when a step was written; concatenating the areas in
 * area order said something else, and the two disagreed in eleven places — an
 * area whose block sits early carried its 3xx migrations ahead of another
 * area's 1xx ones. Reading the list therefore told you the wrong story about
 * what runs before what, which is the only thing a prefix is for.
 *
 * SORTING IS SAFE AND RENUMBERING IS NOT. `migrations` is keyed on the NAME
 * with no checksum, so every step already applied on a running box is skipped
 * wherever it now sits; renaming one would re-run it against a schema it has
 * already changed. The order only matters for a box seeing them for the first
 * time, and there the prefix order is the one that was meant.
 *
 * The invariant — sorted, and no two steps sharing a name — is asserted in
 * migrations.test.ts, because a name is a primary key and a duplicate would
 * mean the second step silently never running.
 */
export const INTEGRATION_MIGRATIONS: { name: string; sql: string }[] = [...analytics, ...ops, ...signals, ...ventures, ...runs, ...subagents, ...chief, ...mailflow, ...activity, ...proactive, ...people, ...security, ...video, ...videoplus, ...growth, ...publishing, ...mobilehealth, ...agentcore, ...knowledge, ...deploy, ...finance, ...customers, ...pipeline, ...webanalytics, ...nurture, ...migrate, ...seoops, ...socialfeed, ...runtime, { name: "190_workspace_preferences", sql: `CREATE TABLE workspace_preferences (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);` },
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
].sort((a, b) => a.name.localeCompare(b.name));
