/** Every area's migrations, in area order. Pure — see manifest.ts. */
import { MIGRATIONS as analytics } from "./analytics/migrations.ts";
import { MIGRATIONS as ops } from "./ops/migrations.ts";
import { MIGRATIONS as signals } from "./signals/migrations.ts";
import { MIGRATIONS as ventures } from "./ventures/migrations.ts";
import { MIGRATIONS as runs } from "./runs/migrations.ts";
import { MIGRATIONS as subagents } from "./subagents/migrations.ts";

export const INTEGRATION_MIGRATIONS = [...analytics, ...ops, ...signals, ...ventures, ...runs, ...subagents];
