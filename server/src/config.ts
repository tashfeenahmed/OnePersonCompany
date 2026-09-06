import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit environment variables win over the optional server/.env file.
const serverDir = fileURLToPath(new URL("../", import.meta.url));
const envFile = process.env.OPC_ENV_FILE ?? resolve(serverDir, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
function env(name: string, fallback: string): string { return process.env[name] || fallback; }
function num(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = Number(env(name, String(fallback)));
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
  return value;
}
/** The checkout's own data directory — what a developer's server uses when
 *  nothing overrides it, and what db.ts refuses to open from a test process. */
export const DEFAULT_DATA_DIR = resolve(serverDir, "./data");
export const DATA_DIR = resolve(serverDir, env("OPC_DATA_DIR", "./data"));
export const DB_FILE = resolve(DATA_DIR, "opc.db");
export const VAULT_KEY_FILE = resolve(DATA_DIR, "vault.key");
export const PORT = num("PORT", 8787, 1, 65535);
export const COLLECT_MINUTES = num("OPC_COLLECT_MINUTES", 30, 0);
export const RETAIN_DAYS = num("OPC_RETAIN_DAYS", 400, 1);
export const LOAD_RETAIN_DAYS = num("OPC_LOAD_RETAIN_DAYS", 30, 1);
/** Where the dashboard is served from while a dev server is in front of this
 *  one. In production this process serves it and the two ports are the same. */
export const UI_PORT = num("OPC_UI_PORT", 5180, 1, 65535);
/**
 * THE PORTS AN `Origin` MAY NAME AND STILL BE THE OWNER'S OWN DASHBOARD.
 *
 * One set, in config, because it was typed twice inside the gate and the two
 * copies are what let a request be a browser to one check and not to the
 * other. `5173` is Vite's default and stays on the list beside the configured
 * one, so a checkout that has never set `OPC_UI_PORT` still works.
 */
export const ALLOWED_ORIGIN_PORTS: ReadonlySet<string> = new Set([String(PORT), String(UI_PORT), "5173"]);
mkdirSync(DATA_DIR, { recursive: true });
