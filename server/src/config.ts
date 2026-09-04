import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Everything the process needs to know, read once, with honest defaults. */
function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(env(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

export const DATA_DIR = resolve(env("OPC_DATA_DIR", "./data"));
export const DB_FILE = resolve(DATA_DIR, "opc.db");
export const VAULT_KEY_FILE = resolve(DATA_DIR, "vault.key");

export const PORT = num("PORT", 8787);
export const COLLECT_MINUTES = num("OPC_COLLECT_MINUTES", 30);
export const RETAIN_DAYS = num("OPC_RETAIN_DAYS", 400);
/** Per-server load samples age out far sooner — a few thousand rows a day,
 *  answering questions only ever asked of recent history. See prune(). */
export const LOAD_RETAIN_DAYS = num("OPC_LOAD_RETAIN_DAYS", 30);

mkdirSync(DATA_DIR, { recursive: true });
