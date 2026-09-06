import { Hono } from "hono";
import { accessSync, constants, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DATA_DIR, PORT, COLLECT_MINUTES } from "../config.ts";
import { db } from "../db.ts";
import { passwordSet } from "../integrations/security/owner.ts";
import { activeProvider } from "../models/provider.ts";
import { activeBackend } from "../chat/backend.ts";
export function setupReport() {
  let writable = true; try { accessSync(DATA_DIR, constants.W_OK); } catch { writable = false; }
  const tools = ["tar", "rsync", "ffmpeg", "ffprobe", "typst"].map(name => ({ name, available: spawnSync("which", [name], { timeout: 1500 }).status === 0 }));
  const provider = activeProvider(), agent = activeBackend();
  const backup = db.prepare("SELECT ts FROM backup_runs WHERE ok = 1 ORDER BY ts DESC LIMIT 1").get() as { ts: string } | undefined;
  return { node: process.version, port: PORT, dataDirectory: DATA_DIR, writable, database: "ready", collectionMinutes: COLLECT_MINUTES,
    ownerPassword: passwordSet(), model: provider?.label ?? null, agent: agent?.id ?? null, tools,
    productionBuild: existsSync(fileURLToPath(new URL("../../../client/dist/index.html", import.meta.url))), lastBackup: backup?.ts ?? null };
}
export const setupRoutes = new Hono().get("/", c => c.json(setupReport()));
