/**
 * THE PASS, AND WHY IT IS THIS AREA'S OWN TIMER RATHER THAN A COLLECTOR.
 *
 * `manifestCollectors()` merges every area's map OVER `collector.ts`'s
 * built-ins, keyed by PLUGIN id. An entry under `playstore` or `appstore` here
 * would silently REPLACE the collector that reads the money and the installs
 * and take /api/mobile down with it — the exact trap mailflow's manifest warns
 * about for `gmail`. So this area collects on a timer of its own and can be
 * run on demand through POST /api/mobilehealth/collect.
 *
 * ONE PASS PER STORE, AND NEITHER CAN COST THE OTHER. Android and iOS are
 * collected in sequence and each failure is caught at its own account; a Play
 * bucket that 403s leaves every App Store row standing and vice versa. Within
 * Android, the three grants fail apart again — see play.ts.
 *
 * SIX HOURS, matching MOBILE_EVERY_HOURS in collector.ts. Both stores publish
 * a day at a time at best: Play's exports are rewritten daily, Apple's
 * analytics instances arrive once per day two days late, and the reviews API
 * hands back the same seven days however often it is asked. A half-hour clock
 * would be thirty times the requests for the same answer.
 */
import { finishRun, getPlugin, startRun } from "../../db.ts";
import { collectPlayHealth } from "./play.ts";
import { collectAppStoreHealth } from "./appstore.ts";

export const PLUGIN = "mobilehealth";
const EVERY_HOURS = 6;
const TICK_MS = 15 * 60 * 1000;

export type PassResult = {
  ok: boolean;
  runId: number;
  play: Awaited<ReturnType<typeof collectPlayHealth>>;
  appstore: Awaited<ReturnType<typeof collectAppStoreHealth>>;
  note: string;
  error?: string;
};

const connected = (id: string) => getPlugin(id)?.connected === 1;

/**
 * One pass over whichever stores are connected.
 *
 * A STORE THAT IS NOT CONNECTED IS SKIPPED SILENTLY and is not an error: this
 * area is an extension of two integrations the owner may have connected
 * neither, one, or both of. The run note says which were asked.
 */
export async function runPass(): Promise<PassResult> {
  const runId = startRun(PLUGIN);
  const play: PassResult["play"] = [];
  const appstore: PassResult["appstore"] = [];
  const parts: string[] = [];
  const problems: string[] = [];

  try {
    if (connected("playstore")) {
      play.push(...(await collectPlayHealth()));
      const rows = play.reduce(
        (n, a) => n + Object.values(a.wrote).reduce((m, v) => m + v, 0),
        0,
      );
      const bad = play.filter((a) => !a.ok);
      parts.push(`play: ${play.length - bad.length}/${play.length} account(s), ${rows} rows`);
      for (const a of play) {
        if (a.error) problems.push(`play ${a.label}: ${a.error}`);
        for (const n of a.notes) problems.push(`play ${a.label}: ${n}`);
      }
    } else parts.push("play: not connected");

    if (connected("appstore")) {
      appstore.push(...(await collectAppStoreHealth()));
      const rows = appstore.reduce(
        (n, a) => n + Object.values(a.wrote).reduce((m, v) => m + v, 0),
        0,
      );
      const bad = appstore.filter((a) => !a.ok);
      parts.push(
        `appstore: ${appstore.length - bad.length}/${appstore.length} account(s), ${rows} rows`,
      );
      for (const a of appstore) if (a.error) problems.push(`appstore ${a.label}: ${a.error}`);
    } else parts.push("appstore: not connected");

    const note = parts.join(" · ");
    /*
      A PASS IS OK WHEN IT RAN, NOT WHEN EVERYTHING ANSWERED. Half of what this
      area asks for is expected to be missing on any given account — a report
      Play does not generate, an analytics instance Apple has not produced —
      and a run that goes red every six hours over a permanent, documented
      absence is a run nobody reads. The absences are in mobile_report_state
      with their reasons; the run's `error` carries only what went wrong.
      */
    finishRun(runId, true, note, problems.slice(0, 6).join("; ") || undefined);
    return { ok: true, runId, play, appstore, note };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(runId, false, parts.join(" · ") || undefined, error);
    return { ok: false, runId, play, appstore, note: parts.join(" · "), error };
  }
}

/* --------------------------------------------------------------- the timer */

let timer: ReturnType<typeof setInterval> | null = null;
let lastAt = 0;
let running = false;

/**
 * Wakes every fifteen minutes and does nothing until six hours have passed.
 *
 * A timer that slept for six hours would skip the night on a laptop that was
 * shut; a short tick that checks the clock runs the pass when the machine
 * wakes instead. `running` is the guard against a pass that outlives its own
 * interval — the App Store side can spend a minute downloading instances.
 */
export function startMobileHealthTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    void (async () => {
      if (running) return;
      if (Date.now() - lastAt < EVERY_HOURS * 3_600_000) return;
      if (!connected("playstore") && !connected("appstore")) return;
      running = true;
      lastAt = Date.now();
      try {
        await runPass();
      } catch (err) {
        // A pass that throws must not take the process with it; the run row
        // already carries anything worth reading.
        console.error(
          "[mobilehealth] pass failed:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        running = false;
      }
    })();
  }, TICK_MS);
  timer.unref?.();
}

/** Whether a pass is in flight, so the route can refuse a second one rather
 *  than have two collections write the same rows at once. */
export const passRunning = () => running;

export async function collectNow(): Promise<PassResult> {
  if (running)
    return {
      ok: false,
      runId: 0,
      play: [],
      appstore: [],
      note: "",
      error: "A collection is already running.",
    };
  running = true;
  lastAt = Date.now();
  try {
    return await runPass();
  } finally {
    running = false;
  }
}
