import {
  businessTypesOf,
  storedBusinessTypes,
} from "../../../shared/businessTypes.ts";
import { db, now, ventureRows, setConfig } from "../db.ts";
import { passwordSet } from "../integrations/security/owner.ts";
import {
  emptySetup,
  parseSetupDraft,
  type SetupDraft,
  type ConnectionResult,
} from "../../../shared/onboarding.ts";
import {
  planDashboards,
  SERVICE_CAPABILITIES,
  type PlanVenture,
  type PlanLink,
} from "../../../shared/onboardingPlan.ts";
import * as accounts from "../accounts.ts";
import { normaliseWebsite } from "../ventures/enrich.ts";

export type SetupRow = {
  revision: number;
  draft: string;
  created_at: string;
  completed_at: string | null;
};
export function setupRow() {
  return db.prepare("SELECT * FROM onboarding_state WHERE id=1").get() as
    SetupRow | undefined;
}
export function establishedWorkspace() {
  return (
    passwordSet() ||
    !!db.prepare("SELECT 1 FROM workspace_preferences LIMIT 1").get() ||
    !!db.prepare("SELECT 1 FROM ventures LIMIT 1").get() ||
    !!db.prepare("SELECT 1 FROM plugin_accounts LIMIT 1").get() ||
    // Background briefings can arrive before the owner ever opens setup.
    // Only a person's message is evidence of an existing chat workspace.
    !!db.prepare("SELECT 1 FROM chat_messages WHERE role='user' LIMIT 1").get()
  );
}
export function needsOnboarding() {
  const row = setupRow();
  return row ? !row.completed_at : !establishedWorkspace();
}
export function setupDraft() {
  const r = setupRow();
  return r ? parseSetupDraft(JSON.parse(r.draft)) : emptySetup();
}
export function setupResults(): ConnectionResult[] {
  const records = db
    .prepare("SELECT result,account_id FROM onboarding_connections")
    .all() as { result: string; account_id: number | null }[];
  const selected = new Map(setupDraft().accounts.map((a) => [a.key, a]));
  return records.flatMap((r) => {
    const result = JSON.parse(r.result) as ConnectionResult;
    const chosen = selected.get(result.key);
    if (!chosen) return [];
    const a = r.account_id ? accounts.get(r.account_id) : undefined;
    if (result.status === "connected" || result.status === "limited") {
      if (!a?.connected)
        return [
          {
            ...result,
            label: chosen.label,
            status: "failed" as const,
            capabilities: [],
            error: "This account is no longer connected.",
          },
        ];
      if (a.lastError)
        return [
          {
            ...result,
            label: chosen.label,
            status: "limited" as const,
            capabilities: result.capabilities.filter((c) => c === "chat"),
            error: "The latest sync needs attention. Review this connection.",
          },
        ];
    }
    return [{ ...result, label: chosen.label }];
  });
}
export function saveSetupResult(result: ConnectionResult) {
  db.prepare(
    "INSERT INTO onboarding_connections(setup_key,plugin,account_id,result) VALUES(?,?,?,?) ON CONFLICT(setup_key) DO UPDATE SET plugin=excluded.plugin,account_id=excluded.account_id,result=excluded.result",
  ).run(result.key, result.plugin, result.accountId, JSON.stringify(result));
}
export function setupVentures(): PlanVenture[] {
  return ventureRows().map((v) => ({
    id: v.id,
    slug: v.slug,
    name: v.name,
    host: v.host,
    businessType: v.business_type ?? null,
    businessTypes: storedBusinessTypes(v),
    stage:
      v.stage === "pre-launch"
        ? "pre-launch"
        : v.stage === "launched"
          ? "launched"
          : "idea",
  }));
}
export function setupLinks(): PlanLink[] {
  return (
    db.prepare("SELECT venture_id,plugin,entity FROM venture_links").all() as {
      venture_id: string;
      plugin: string;
      entity: string;
    }[]
  ).map((l) => ({
    ventureId: l.venture_id,
    plugin: l.plugin,
    entity: l.entity,
  }));
}
/** Accounts added later in Integrations participate in the same resource planning. */
export function workspaceConnections(): ConnectionResult[] {
  return Object.entries(SERVICE_CAPABILITIES).flatMap(
    ([plugin, capabilities]) =>
      accounts
        .list(plugin)
        .filter((a) => a.connected && a.lastOkAt && !a.lastError)
        .map((a) => {
          const fields = new Set(accounts.entries(a.id).map((e) => e.field));
          const allowed = ["openai", "openrouter"].includes(plugin)
            ? capabilities.filter((c) =>
                fields.has(c === "chat" ? "chat-key" : "key"),
              )
            : capabilities;
          return {
            key: `account-${a.id}`,
            plugin,
            label: a.label,
            accountId: a.id,
            status: "connected" as const,
            error: null,
            capabilities: allowed,
            checkedAt: a.lastOkAt,
          };
        }),
  );
}
export function setupPlan() {
  const d = setupDraft();
  return planDashboards(
    setupRow()?.completed_at ? workspaceConnections() : setupResults(),
    setupVentures(),
    setupLinks(),
    d.excludedDashboards,
  );
}
export function initialiseSetup(draft: SetupDraft) {
  db.prepare(
    "INSERT INTO onboarding_state(id,revision,draft,created_at) VALUES(1,1,?,?)",
  ).run(JSON.stringify(draft), now());
}
export function saveSetup(draft: SetupDraft, revision: number) {
  const r = db
    .prepare(
      "UPDATE onboarding_state SET draft=?,revision=revision+1 WHERE id=1 AND revision=? AND completed_at IS NULL",
    )
    .run(JSON.stringify(draft), revision);
  return !!r.changes;
}
/** Completion is one transaction. A retry cannot duplicate ventures or replace an existing layout. */
export function completeSetup() {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = setupRow();
    if (!row) throw new Error("Start workspace setup first.");
    if (row.completed_at) {
      db.exec("COMMIT");
      return { alreadyComplete: true, boards: setupPlan() };
    }
    if (db.prepare("SELECT 1 FROM workspace_preferences LIMIT 1").get())
      throw new Error(
        "A workspace layout already exists. Setup will not replace it.",
      );
    const draft = setupDraft();
    const ts = now();
    let position = ventureRows().length;
    for (const v of draft.ventures) {
      const id = `v-setup-${v.key}`;
      const site = v.website ? normaliseWebsite(v.website) : null;
      if (v.website && !site)
        throw new Error(
          `${v.name}: use a public website address, or leave it empty for now.`,
        );
      const base =
        v.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "venture";
      let slug = base;
      let index = 2;
      while (
        ["new", "map", "org"].includes(slug) ||
        db.prepare("SELECT 1 FROM ventures WHERE slug=?").get(slug)
      )
        slug = `${base}-${index++}`;
      db.prepare(
        `INSERT INTO ventures(id,slug,name,description,website,host,stage,color,color_source,position,brand,created_at,updated_at,business_type,business_types) VALUES(?,?,?,'',?,?,?,'#635bff','default',?,'{}',?,?,?,?)`,
      ).run(
        id,
        slug,
        v.name,
        site?.website ?? null,
        site?.host ?? null,
        v.stage,
        position++,
        ts,
        ts,
        v.businessType,
        JSON.stringify(businessTypesOf(v)),
      );
    }
    db.prepare(
      "INSERT OR IGNORE INTO plugins(id,connected,updated_at) VALUES('briefing',0,?)",
    ).run(ts);
    setConfig("briefing", "timezone", draft.timezone);
    const boards = setupPlan();
    const preferences = {
      seedVersion: 27,
      workspace: {
        name: draft.workspace,
        owner: draft.owner,
        defaultVentureId: null,
        timezone: draft.timezone,
        currency: draft.currency,
      },
      sessions: [],
      dashboards: boards,
      appOrder: [],
      navOrder: [],
      favoritePaths: [],
      pinnedItems: [],
    };
    db.prepare(
      "INSERT INTO workspace_preferences(id,revision,data,updated_at) VALUES(1,1,?,?)",
    ).run(JSON.stringify(preferences), ts);
    for (const board of boards)
      db.prepare(
        "INSERT OR IGNORE INTO onboarding_provisioned_boards(id) VALUES(?)",
      ).run(board.id);
    db.prepare(
      "UPDATE onboarding_state SET completed_at=?,revision=revision+1 WHERE id=1",
    ).run(ts);
    db.exec("COMMIT");
    return { alreadyComplete: false, boards };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
