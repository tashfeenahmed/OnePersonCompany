import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { db, now } from "../db.ts";
import { RUNTIME_KEYS, readFlag, readJson, writeFlag, writeJson } from "./settings.ts";
export const DEFAULT_BUDGETS = { runSeconds: 900, runCalls: 100, dailyCalls: 1000, automationDailyCalls: 100,
  runTokens: 0, dailyTokens: 0, ventureDailyTokens: 0, runUsd: 0, dailyUsd: 0, ventureDailyUsd: 0,
  usdPerMillion: 0, maxOutputTokens: 4096 };
export type Budgets = typeof DEFAULT_BUDGETS;
export function budgets(): Budgets {
  return { ...DEFAULT_BUDGETS, ...readJson<Partial<Budgets>>(RUNTIME_KEYS.budgets, {}) };
}
export function saveBudgets(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Expected budget settings.";
  const p = value as Budgets;
  for (const key of Object.keys(DEFAULT_BUDGETS) as (keyof Budgets)[]) {
    if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < 0 || p[key] > 1e9) return `Invalid ${key}.`;
    if (!key.toLowerCase().includes("usd") && !Number.isInteger(p[key])) return `${key} must be a whole number.`;
  }
  if (p.runSeconds < 1 || p.maxOutputTokens < 1 || p.maxOutputTokens > 65536) return "Choose a positive runtime and an output limit of 1–65,536 tokens.";
  if ((p.runUsd || p.dailyUsd || p.ventureDailyUsd) && !p.usdPerMillion) return "Set a conservative model price per million tokens before enabling dollar budgets.";
  writeJson(RUNTIME_KEYS.budgets, p);
  return null;
}
export function queuePaused() { return readFlag(RUNTIME_KEYS.queuePaused); }
export function setQueuePaused(paused: boolean) { writeFlag(RUNTIME_KEYS.queuePaused, paused); }
type Context = { id: string; venture: string | null; automation: boolean; signal: AbortSignal; sequence: number; resume: boolean };
export const runContext = new AsyncLocalStorage<Context>();
export function hasMeteredLimits(p = budgets()) { return !!(p.runTokens || p.dailyTokens || p.ventureDailyTokens || p.runUsd || p.dailyUsd || p.ventureDailyUsd); }
export function assertMeterable(kind: string) {
  if (hasMeteredLimits() && ["video", "shotsqa"].includes(kind)) throw new Error("This job can use tools whose costs are not metered. It is blocked while token or dollar budgets are enabled.");
}
function reserve(turns: unknown, agent: boolean) {
  const ctx = runContext.getStore(); if (!ctx) return null;
  ctx.signal.throwIfAborted();
  const p = budgets();
  if (agent && hasMeteredLimits(p)) throw new Error("This agent cannot guarantee usage limits across its tools. Select a direct model provider or disable token and dollar budgets for this work.");
  // UTF-8 bytes plus output allowance conservatively reserve a text request.
  const tokens = Buffer.byteLength(JSON.stringify(turns), "utf8") + p.maxOutputTokens + 1024;
  const usd = tokens * p.usdPerMillion / 1_000_000;
  const start = now().slice(0, 10) + "T00:00:00.000Z";
  db.exec("BEGIN IMMEDIATE");
  try {
    const totals = (where: string, args: (string | null)[]) => db.prepare(`SELECT count(*) AS calls, coalesce(sum(tokens),0) AS tokens, coalesce(sum(usd),0) AS usd FROM budget_usage WHERE ${where}`).get(...args) as { calls: number; tokens: number; usd: number };
    const run = totals("run_id = ?", [ctx.id]), daily = totals("at >= ?", [start]), venture = totals("at >= ? AND venture_id IS ?", [start, ctx.venture]);
    const auto = db.prepare("SELECT count(*) AS n FROM budget_usage WHERE at >= ? AND automation = 1").get(start) as { n: number };
    if (run.calls >= p.runCalls || daily.calls >= p.dailyCalls || (ctx.automation && auto.n >= p.automationDailyCalls)) throw new Error("The configured model-call budget has been reached.");
    for (const [limit, used, increment, label] of [
      [p.runTokens, run.tokens, tokens, "job token"], [p.dailyTokens, daily.tokens, tokens, "daily token"], [p.ventureDailyTokens, venture.tokens, tokens, "venture token"],
      [p.runUsd, run.usd, usd, "job dollar"], [p.dailyUsd, daily.usd, usd, "daily dollar"], [p.ventureDailyUsd, venture.usd, usd, "venture dollar"],
    ] as [number, number, number, string][]) if (limit > 0 && used + increment > limit) throw new Error(`This request would exceed the ${label} budget, including in-flight reservations.`);
    const result = db.prepare("INSERT INTO budget_usage (run_id, venture_id, automation, at, tokens, usd, status) VALUES (?,?,?,?,?,?,?)").run(ctx.id, ctx.venture, Number(ctx.automation), now(), tokens, usd, agent ? "unmetered-agent" : "reserved");
    db.exec("COMMIT"); return { id: Number(result.lastInsertRowid), tokens, usd, price: p.usdPerMillion, output: p.maxOutputTokens };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
export async function budgeted<T extends { usage?: { prompt: number; completion: number } | null }>(turns: unknown, work: (maxOutputTokens?: number) => Promise<T>, agent = false): Promise<T> {
  const ctx = runContext.getStore();
  const key = ctx ? `${ctx.sequence++}:${createHash("sha256").update(JSON.stringify(turns)).digest("hex")}` : null;
  // Only AI visibility has a fully replayable, direct-model pipeline.
  if (ctx?.resume && !agent && key) {
    const cached = db.prepare("SELECT reply FROM run_checkpoints WHERE run_id=? AND step_key=?").get(ctx.id, key) as {reply: string} | undefined;
    if (cached) return JSON.parse(cached.reply) as T;
  }
  const reservation = reserve(turns, agent);
  try {
    const result = await work(reservation?.output);
    if (reservation) {
      const known = result.usage && Number.isFinite(result.usage.prompt) && Number.isFinite(result.usage.completion);
      const used = known ? Math.max(0, result.usage!.prompt + result.usage!.completion) : reservation.tokens;
      db.prepare("UPDATE budget_usage SET tokens=?, usd=?, status=? WHERE id=?").run(used, used * reservation.price / 1e6, known ? "reported" : agent ? "unmetered-agent" : "estimated", reservation.id);
    }
    if (ctx && !agent && key) db.prepare("INSERT OR REPLACE INTO run_checkpoints (run_id,step_key,reply) VALUES (?,?,?)").run(ctx.id, key, JSON.stringify(result));
    return result;
  } catch (error) {
    // A timeout does not prove the provider incurred no usage; keep the reservation.
    if (reservation) db.prepare("UPDATE budget_usage SET status='uncertain' WHERE id=?").run(reservation.id);
    throw error;
  }
}
/**
 * WHAT ONE RUN HAS SPENT, or null when this box prices nothing.
 *
 * NULL AND ZERO ARE DIFFERENT ANSWERS, and reading one as the other was a live
 * bug. Two copies of this query existed: one returned null on an unpriced box
 * and the stage it fed showed "unknown"; the other returned 0, and the tool
 * loop it fed read "no price is configured" as "this turn has spent nothing"
 * — so a per-turn dollar ceiling on a box with no `usdPerMillion` could never
 * trip, however long the turn ran. A ceiling that cannot be reached is worse
 * than no ceiling, because the owner believes they have one.
 *
 * Every `usd` in `budget_usage` is derived from `usdPerMillion`; with no price
 * set they are all zero, and zero is not a measurement. So the price is what is
 * checked, and the caller is made to decide what to do about not knowing.
 */
export function spentOnRun(runId: string): number | null {
  if (!budgets().usdPerMillion) return null;
  try {
    const row = db
      .prepare("SELECT coalesce(sum(usd), 0) AS usd FROM budget_usage WHERE run_id = ?")
      .get(runId) as { usd: number } | undefined;
    return Number(row?.usd ?? 0);
  } catch {
    /* The ledger could not be read, which is not the same as nothing spent. */
    return null;
  }
}

export function usageReport() {
  return db.prepare("SELECT run_id AS runId, venture_id AS ventureId, count(*) AS calls, sum(tokens) AS tokens, sum(usd) AS usd, sum(status <> 'reported') AS estimatedCalls FROM budget_usage WHERE at >= ? GROUP BY run_id ORDER BY max(at) DESC").all(now().slice(0,10) + "T00:00:00.000Z");
}
