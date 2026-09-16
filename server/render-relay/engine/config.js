import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../src/config.ts";

export const ROOT = resolve(DATA_DIR, "render-relay");
const settings = JSON.parse(readFileSync(resolve(ROOT, "settings.json"), "utf8"));
function required(name) {
  const value = settings[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Render relay needs ${name} in settings.json`);
  return value.trim();
}
export const DELL_IP = required("host");
export const DELL_MAC = required("mac");
export const DELL_USER = required("user");
export const POWER_KEY = required("powerKey");
export const LLM_BASE = required("llmUrl");
export const LLM_PORT = Number(new URL(LLM_BASE).port || 80);
export const REEL_WORKER = required("workerUrl").replace(/\/+$/, "");
export const CHROMIUM_BIN = settings.chromium || "/usr/bin/chromium";
export const JOBLOG_STATE = resolve(ROOT, "joblog.json");
export const REEL_STATE = resolve(ROOT, "reel.json");
export const REEL_DIR = resolve(ROOT, "videos");
export const REEL_CAPTURE_DIR = resolve(ROOT, "captures");
for (const directory of [ROOT, REEL_DIR, REEL_CAPTURE_DIR]) mkdirSync(directory, { recursive: true, mode: 0o700 });
export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 2_000_000;
export const FETCH_MAX_CHARS = 6000;
export const REEL_CAPTURE_HEIGHT = 800;
export const REEL_CAPTURE_MAX_HEIGHT = 4800;
export const REEL_CAPTURE_WIDTH = 1280;
export const REEL_CAPTURE_TIMEOUT_MS = 45_000;
export const REEL_KEEP = 20;
export const REEL_MAX_URLS = 8;
export const REEL_TIMEOUT_MS = 600_000;
