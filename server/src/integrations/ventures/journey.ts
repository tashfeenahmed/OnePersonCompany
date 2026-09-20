import { parseBusinessTypes, storedBusinessTypes } from "../../../../shared/businessTypes.ts";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { db, ventureRow, type VentureRow } from "../../db.ts";
import { validDay } from "../../../../shared/workJournal.ts";
import { emptyJourney, isBusinessType, isJourneyStage, journeyTasks, journeyReadiness, PROFILE_FIELDS, type JourneyDocument, type JourneyState, type JourneyStage, type JourneyCommand } from "../../../../shared/ventureJourney.ts";
import { JOURNEY_TEMPLATES } from "../../../../shared/ventureJourneyTemplates.ts";

export function readJourney(venture: VentureRow): JourneyDocument {
  const row = db.prepare("SELECT revision, updated_at, state FROM venture_journeys WHERE venture_id = ?").get(venture.id) as { revision: number; updated_at: string; state: string } | undefined;
  return { ventureId: venture.id, stage: venture.stage as JourneyStage, businessType: venture.business_type ?? null, businessTypes: storedBusinessTypes(venture),
    revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null, state: row ? JSON.parse(row.state) as JourneyState : emptyJourney(),
    history: db.prepare("SELECT id, from_stage AS fromStage, to_stage AS toStage, note, ts AS at FROM venture_stage_history WHERE venture_id = ? ORDER BY id DESC LIMIT 100").all(venture.id) as JourneyDocument["history"],
    reviews: (db.prepare("SELECT id, ts AS at, business_type AS businessType, done, total, json_extract(snapshot, '$.businessTypes') AS types FROM venture_reviews WHERE venture_id = ? ORDER BY id DESC LIMIT 50").all(venture.id) as { id: number; at: string; businessType: JourneyDocument["businessType"]; done: number; total: number; types: string | null }[]).map(({ types, ...review }) => ({ ...review, businessTypes: parseBusinessTypes(types ? JSON.parse(types) : undefined, review.businessType) })) };
}
export function recordStageChange(id: string, from: string, to: string, note: string, at: string) {
  if (from !== to) db.prepare("INSERT INTO venture_stage_history (venture_id,from_stage,to_stage,note,ts) VALUES (?,?,?,?,?)").run(id, from, to, note, at);
}
/**
 * A COMMAND FROM THIS SIDE OF THE WIRE — the idea call writing what was settled.
 * The route below takes a revision because two browser windows can hold two
 * copies of the plan; a caller in this process holds none, reads the current
 * document inside the transaction, and cannot be stale. Returns the refusal in
 * the route's own words, or null when it was written.
 */
export function writeJourneyCommand(venture: VentureRow, command: JourneyCommand): string | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    const doc = readJourney(venture), at = new Date().toISOString();
    const problem = applyJourneyCommand(doc.state, command, at);
    if (problem) { db.exec("ROLLBACK"); return problem; }
    db.prepare(`INSERT INTO venture_journeys (venture_id,revision,state,updated_at) VALUES (?,?,?,?) ON CONFLICT(venture_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at`).run(venture.id, doc.revision + 1, JSON.stringify(doc.state), at);
    db.exec("COMMIT"); return null;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const line = (v: unknown, max: number, required = false): v is string => typeof v === "string" && v.length <= max && (!required || !!v.trim());
/** Commands change only named fields. A revision guards all paths, including custom API clients. */
export function applyJourneyCommand(state: JourneyState, raw: unknown, at: string): string | null {
  if (!plain(raw)) return "Expected a journey command.";
  const command = raw as JourneyCommand;
  switch (command.kind) {
    case "profile": {
      if (!plain(command.values) || !Object.keys(command.values).length) return "Supply profile fields to change.";
      for (const [key, value] of Object.entries(command.values)) {
        if (!Object.hasOwn(PROFILE_FIELDS, key) || !line(value, 4000)) return "Unknown profile field or text longer than 4,000 characters.";
        if ((key === "launchDate" || key === "reviewDate") && value && !validDay(value)) return "Use a real calendar date (YYYY-MM-DD).";
      }
      Object.assign(state.profile, command.values); return null;
    }
    case "task": {
      if (!line(command.key, 240) || ![...JOURNEY_TEMPLATES, ...state.custom].some(t => t.key === command.key)) return "This checklist step does not exist.";
      if (!["todo", "done", "skipped"].includes(command.status) || !line(command.evidence, 8000)) return "Choose a valid status and evidence up to 8,000 characters.";
      if (command.status === "skipped" && !command.evidence.trim()) return "Explain why this step does not apply before skipping it.";
      state.tasks[command.key] = { status: command.status, evidence: command.evidence, updatedAt: at }; return null;
    }
    case "add-task": {
      if (!isJourneyStage(command.stage) || !(command.businessType === null || isBusinessType(command.businessType)) || !line(command.title, 200, true) || !line(command.detail, 4000) || typeof command.required !== "boolean") return "Supply a stage, business type, title, details and required flag.";
      if (state.custom.length >= 200) return "This venture already has 200 custom steps.";
      state.custom.push({ key: `custom:${randomUUID()}`, stage: command.stage, businessType: command.businessType, title: command.title.trim(), detail: command.detail, required: command.required, custom: true, evidenceHint: "Record the outcome, evidence and next action.", tool: "Your team", group: "Your own steps" }); return null;
    }
    case "delete-task": {
      if (!state.custom.some(t => t.key === command.key)) return "Only an existing custom step can be removed.";
      state.custom = state.custom.filter(t => t.key !== command.key); delete state.tasks[command.key]; return null;
    }
    case "name": {
      if (!line(command.name, 100, true) || !line(command.domain, 253) || !line(command.evidence, 4000) || !["unchecked", "shortlisted", "ruled-out", "chosen"].includes(command.status)) return "Supply a name, domain, decision and evidence within the text limits.";
      const domain = command.domain.trim().toLowerCase();
      if (domain && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return "Use a domain such as example.com, without a URL path.";
      if (command.id !== undefined && !state.names.some(n => n.id === command.id)) return "This name candidate no longer exists.";
      if (!command.id && state.names.length >= 50) return "This venture already has 50 name candidates.";
      if (command.status === "chosen" && !command.evidence.trim()) return "Record your domain and brand checks before choosing this name.";
      if (command.status === "chosen") for (const n of state.names) if (n.status === "chosen") n.status = "shortlisted";
      const id = command.id ?? randomUUID();
      const value = { id, name: command.name.trim(), domain, status: command.status, evidence: command.evidence, updatedAt: at };
      state.names = [...state.names.filter(n => n.id !== id), value]; return null;
    }
    case "delete-name": {
      if (!state.names.some(n => n.id === command.id)) return "This name candidate no longer exists.";
      state.names = state.names.filter(n => n.id !== command.id); return null;
    }
    case "start-review":
      try { parseBusinessTypes(command.businessTypes, command.businessType); }
      catch { return "Choose valid business types."; }
      return null; // Archiving and reset are performed in the same transaction below.
    default: return "Unknown journey command.";
  }
}
export const journeyRoutes = new Hono();
journeyRoutes.get("/:key", c => {
  const venture = ventureRow(c.req.param("key"));
  return venture ? c.json(readJourney(venture)) : c.json({ error: "Venture not found." }, 404);
});
journeyRoutes.patch("/:key", async c => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!plain(body) || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0) return c.json({ error: "Supply the revision from the latest journey document." }, 400);
  const venture = ventureRow(c.req.param("key"));
  if (!venture) return c.json({ error: "Venture not found." }, 404);
  // No await inside the transaction: a competing connection cannot pass the same revision.
  db.exec("BEGIN IMMEDIATE");
  try {
    const doc = readJourney(venture);
    if (doc.revision !== body.revision) { db.exec("ROLLBACK"); return c.json({ error: "This plan changed in another window. Reload the saved plan, then retry your edit." }, 409); }
    const at = new Date().toISOString(), problem = applyJourneyCommand(doc.state, body.command, at);
    if (problem) { db.exec("ROLLBACK"); return c.json({ error: problem }, 400); }
    const command = body.command as JourneyCommand;
    if (command.kind === "start-review") {
      const types = parseBusinessTypes(command.businessTypes, command.businessType), currentTypes = storedBusinessTypes(venture);
      if (venture.stage !== "launched" || types.length !== currentTypes.length || types.some(type => !currentTypes.includes(type))) { db.exec("ROLLBACK"); return c.json({ error: "Reload the current launched business type before starting its next review." }, 409); }
      const tasks = journeyTasks(doc.state, "launched", types), progress = journeyReadiness(tasks, doc.state.tasks);
      if (!progress.done && !progress.skipped) { db.exec("ROLLBACK"); return c.json({ error: "Complete or skip a step before starting the next review." }, 400); }
      db.prepare("INSERT INTO venture_reviews (venture_id,ts,business_type,done,total,snapshot) VALUES (?,?,?,?,?,?)").run(venture.id, at, types[0] ?? null, progress.done, progress.total, JSON.stringify({ tasks, businessTypes: types, progress: doc.state.tasks }));
      for (const task of tasks) delete doc.state.tasks[task.key];
    }
    db.prepare(`INSERT INTO venture_journeys (venture_id,revision,state,updated_at) VALUES (?,?,?,?) ON CONFLICT(venture_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at`).run(venture.id, doc.revision + 1, JSON.stringify(doc.state), at);
    db.exec("COMMIT"); return c.json(readJourney(venture));
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});
journeyRoutes.get("/:key/reviews/:id", c => {
  const venture = ventureRow(c.req.param("key"));
  if (!venture) return c.json({ error: "Venture not found." }, 404);
  const row = db.prepare("SELECT snapshot FROM venture_reviews WHERE venture_id = ? AND id = ?").get(venture.id, c.req.param("id")) as { snapshot: string } | undefined;
  return row ? c.json(JSON.parse(row.snapshot)) : c.json({ error: "Review not found." }, 404);
});

journeyRoutes.get("/:key/signals", async c => {
  const venture = ventureRow(c.req.param("key"));
  if (!venture) return c.json({ error: "Venture not found." }, 404);
  const [{ readInsightSources }, { projectPace, detectAnomaly }, { insightSettings }] = await Promise.all([
    import("../insights/data.ts"), import("../../../../shared/insights.ts"), import("../insights/settings.ts"),
  ]);
  const { series, notes } = await readInsightSources(), asOf = new Date().toISOString(), today = asOf.slice(0, 10);
  const settings = insightSettings();
  return c.json({ asOf, notes, series: series.filter(s => s.ventureId === venture.id).map(original => {
    const { points: _points, ...source } = original;
    return { source, pace: projectPace(original, today), anomaly: detectAnomaly(original, settings, today) };
  }), links: db.prepare("SELECT plugin,label,entity FROM venture_links WHERE venture_id = ? ORDER BY plugin,label").all(venture.id) });
});
