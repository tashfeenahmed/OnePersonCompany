import { Hono } from "hono";
import { db, now } from "../db.ts";
import { isWorkspacePreferences } from "../../../shared/workspace.ts";
export const workspaceRoutes = new Hono();
function read() {
  const r = db.prepare("SELECT revision, data FROM workspace_preferences WHERE id = 1").get() as {revision: number; data: string} | undefined;
  return { revision: r?.revision ?? 0, data: r ? JSON.parse(r.data) : null };
}
workspaceRoutes.get("/", c => c.json(read()));

/** The owner's name as the rail shows it — the `owner` field of the
 *  workspace preferences — or null when nothing has been saved yet. Read by
 *  the org chart, whose top box is the same person. */
export function workspaceOwnerName(): string | null {
  const data = read().data as { workspace?: { owner?: unknown } } | null;
  const owner = data?.workspace?.owner;
  const name = typeof owner === "string" ? owner.trim() : "";
  return name || null;
}
workspaceRoutes.put("/", async c => {
  const raw = await c.req.text();
  if (raw.length > 2_000_000) return c.json({ error: "Workspace preferences exceed 2 MB." }, 413);
  let body: { revision?: unknown; data?: unknown };
  try { body = JSON.parse(raw); } catch { return c.json({ error: "Expected JSON." }, 400); }
  if (!body || !Number.isInteger(body.revision) || Number(body.revision) < 0 || !isWorkspacePreferences(body.data))
    return c.json({ error: "Invalid workspace preferences." }, 400);
  const rev = Number(body.revision), data = JSON.stringify(body.data);
  const result = rev === 0
    ? db.prepare("INSERT OR IGNORE INTO workspace_preferences (id, revision, data, updated_at) VALUES (1, 1, ?, ?)").run(data, now())
    : db.prepare("UPDATE workspace_preferences SET data = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?").run(data, now(), rev);
  if (!result.changes) return c.json({ error: "Workspace changed in another browser. Choose which version to keep.", ...read() }, 409);
  return c.json({ revision: rev + 1 });
});
