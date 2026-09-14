import { db, now } from "../db.ts";
import { allEntities, type Entity } from "../integrations/ventures/entities.ts";
import {
  setupRow,
  setupVentures,
  workspaceConnections,
  setupPlan,
} from "./store.ts";
import type { PlanVenture } from "../../../shared/onboardingPlan.ts";
const normalise = (value: string | null) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
/** An exact host must identify one venture; provider-derived bundle host guesses are excluded. */
export function exactAssignments(entities: Entity[], ventures: PlanVenture[]) {
  return entities.flatMap((e) => {
    if (!e.host || ["appstore", "playstore", "gmail"].includes(e.plugin))
      return [];
    const candidates = ventures.filter(
      (v) => v.host && normalise(v.host) === normalise(e.host),
    );
    return candidates.length === 1
      ? [{ ...e, ventureId: candidates[0]!.id }]
      : [];
  });
}
let running = false;
export async function reconcileOnboarding(
  discover: typeof allEntities = allEntities,
) {
  if (running || !setupRow()?.completed_at) return;
  running = true;
  try {
    const live = new Set(workspaceConnections().map((c) => c.plugin));
    const { entities } = await discover();
    const matches = exactAssignments(
      entities.filter((e) => live.has(e.plugin)),
      setupVentures(),
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      const tracked = db
        .prepare("SELECT plugin,entity,venture_id FROM onboarding_auto_links")
        .all() as { plugin: string; entity: string; venture_id: string }[];
      for (const old of tracked) {
        if (
          matches.some(
            (m) =>
              m.plugin === old.plugin &&
              m.entity === old.entity &&
              m.ventureId === old.venture_id,
          )
        )
          continue;
        // An outage or incomplete discovery is not evidence that ownership changed.
        if (
          !entities.some(
            (e) => e.plugin === old.plugin && e.entity === old.entity,
          ) ||
          !live.has(old.plugin)
        )
          continue;
        db.prepare(
          "DELETE FROM venture_links WHERE plugin=? AND entity=? AND venture_id=? AND source='auto'",
        ).run(old.plugin, old.entity, old.venture_id);
        db.prepare(
          "DELETE FROM onboarding_auto_links WHERE plugin=? AND entity=?",
        ).run(old.plugin, old.entity);
      }
      for (const m of matches) {
        // Existing owner links and deliberately removed automatic links remain the owner's decision.
        if (
          db
            .prepare("SELECT 1 FROM venture_links WHERE plugin=? AND entity=?")
            .get(m.plugin, m.entity)
        )
          continue;
        if (
          db
            .prepare(
              "SELECT 1 FROM onboarding_auto_links WHERE plugin=? AND entity=? AND venture_id=?",
            )
            .get(m.plugin, m.entity, m.ventureId)
        )
          continue;
        db.prepare(
          "INSERT INTO venture_links(venture_id,plugin,entity,label,source,created_at) VALUES(?,?,?,?,'auto',?)",
        ).run(m.ventureId, m.plugin, m.entity, m.label, now());
        db.prepare(
          "INSERT OR REPLACE INTO onboarding_auto_links(plugin,entity,venture_id) VALUES(?,?,?)",
        ).run(m.plugin, m.entity, m.ventureId);
      }
      // Add new venture dashboards once; never rewrite a board the owner has customised.
      const pref = db
        .prepare("SELECT data FROM workspace_preferences WHERE id=1")
        .get() as { data: string } | undefined;
      if (pref) {
        const data = JSON.parse(pref.data);
        const plan = setupPlan();
        const additions = plan.filter(
          (b) =>
            b.ventureId &&
            !db
              .prepare("SELECT 1 FROM onboarding_provisioned_boards WHERE id=?")
              .get(b.id) &&
            !data.dashboards.some(
              (d: { id: string; ventureId?: string }) =>
                d.id === b.id || d.ventureId === b.ventureId,
            ),
        );
        for (const board of plan)
          db.prepare(
            "INSERT OR IGNORE INTO onboarding_provisioned_boards(id) VALUES(?)",
          ).run(board.id);
        if (additions.length) {
          data.dashboards.push(...additions);
          db.prepare(
            "UPDATE workspace_preferences SET data=?,revision=revision+1,updated_at=? WHERE id=1",
          ).run(JSON.stringify(data), now());
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    running = false;
  }
}
export function startOnboardingReconciliation() {
  const run = () => {
    void reconcileOnboarding().catch(() => {});
  };
  const timer = setInterval(run, 60_000);
  timer.unref();
  run();
}
