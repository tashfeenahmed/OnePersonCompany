/**
 * PER-SOURCE COLLECTION CADENCE — one setting per collectable plugin, instead
 * of one interval for the whole box.
 *
 * WHAT WAS WRONG WITH ONE TIMER. `OPC_COLLECT_MINUTES` is a single number and
 * every connected plugin was collected on it. That is right for a laptop with
 * four integrations and wrong for an unattended install with twenty: Stripe's
 * ledger is worth re-reading every half hour, Search Console publishes once a
 * day and answers the same figures forty-seven times in between, and a fleet
 * probe wants a tighter loop than either. The predecessor solved this with a
 * systemd timer per collector — a different cadence per unit, written down in
 * the unit file. This box has one process, so the cadence is a SETTING per
 * plugin instead, and the scheduler reads it.
 *
 * IT IS A SETTING AND NOT A TABLE IN CODE. The brief this repo is built to is
 * explicit that a per-project need gets a documented setting rather than a
 * constant, and how often somebody's Umami is worth re-reading depends on how
 * much traffic they have. So every plugin with a collector gets one key,
 * `collect_interval_minutes`, on its own settings page, with the global
 * default named in the hint.
 *
 * EMPTY MEANS THE DEFAULT, AND THE DEFAULT IS `OPC_COLLECT_MINUTES`. There is
 * no second default hidden in here: a box that never touches these settings
 * behaves exactly as it did before this file existed, which is the property
 * that makes adding it safe.
 *
 * `0` MEANS NEVER, and it is a real answer rather than a mistake. A plugin
 * whose data is expensive to fetch, or whose account is rate-limited, can be
 * collected by hand from its page and left off the schedule. The scheduler
 * says so in the log line rather than silently skipping.
 */
import { configValue } from "../../db.ts";
import type { ConfigKey, ConfigRegistryEntry } from "../manifest.ts";

export const CADENCE_KEY = "collect_interval_minutes";

/** The ceiling. A week is longer than any retention window this box keeps for
 *  a live figure; beyond it "scheduled" stops meaning anything. */
export const MAX_MINUTES = 10_080;

function cadenceKey(defaultMinutes: number): ConfigKey {
  return {
    label: "Collect every (minutes)",
    hint:
      `How often the scheduler collects this source. EMPTY MEANS THE BOX DEFAULT, which is ` +
      `${defaultMinutes} minute${defaultMinutes === 1 ? "" : "s"} (OPC_COLLECT_MINUTES). ` +
      `0 means this source is never collected on a schedule — the Collect button on this page still works. ` +
      `The scheduler checks once a minute, so a value under a minute is not available and a cadence is honoured ` +
      `to within a minute. This is a floor, not a promise: a collection that is still running when the next one ` +
      `is due does not start twice.`,
    ph: String(defaultMinutes),
    check(value) {
      const v = value.trim();
      if (!v) return null;
      if (!/^\d+$/.test(v)) return "A whole number of minutes, or empty for the box default.";
      const n = Number(v);
      if (n > MAX_MINUTES) return `That is longer than a week (${MAX_MINUTES} minutes), which is not a schedule.`;
      return null;
    },
  };
}

/**
 * Add the cadence key to every plugin that has a collector.
 *
 * CALLED FROM routes/pluginConfig.ts ON ONE LINE, wrapping the registry it
 * already builds. Done there rather than by each area adding the key to its
 * own manifest, because "every collector gets a cadence" is a property of the
 * SCHEDULER and twenty copies of one key is twenty chances for the hint to
 * drift.
 *
 * A PLUGIN THAT HAD NO SETTINGS PAGE NOW HAS ONE, with this single key on it.
 * That is a visible change and it is the point: a source you can schedule is a
 * source whose schedule you can see.
 */
export function withCollectCadence(
  registry: Record<string, ConfigRegistryEntry>,
  collectorIds: string[],
  defaultMinutes: number,
): Record<string, ConfigRegistryEntry> {
  const out: Record<string, ConfigRegistryEntry> = { ...registry };
  for (const id of collectorIds) {
    const existing = out[id];
    out[id] = existing
      ? { ...existing, keys: { ...existing.keys, [CADENCE_KEY]: cadenceKey(defaultMinutes) } }
      : { keys: { [CADENCE_KEY]: cadenceKey(defaultMinutes) } };
  }
  return out;
}

/**
 * The cadence for one plugin in minutes, or null for "never".
 *
 * Reads the setting on every call rather than caching it, so a change on the
 * plugin page takes effect at the next tick without a restart — the same
 * property `readChatBackend` keeps for the same reason.
 */
export function intervalMinutes(pluginId: string, defaultMinutes: number): number | null {
  const raw = (configValue(pluginId, CADENCE_KEY) ?? "").trim();
  if (!raw) return defaultMinutes > 0 ? defaultMinutes : null;
  if (!/^\d+$/.test(raw)) return defaultMinutes > 0 ? defaultMinutes : null;
  const n = Number(raw);
  if (n <= 0) return null;
  return Math.min(MAX_MINUTES, n);
}

/** Was this cadence typed by the owner, or is it the box default? The page and
 *  the skill both draw the distinction, because "every 30 minutes" is a
 *  different fact when nobody chose it. */
export function isCustom(pluginId: string): boolean {
  const raw = (configValue(pluginId, CADENCE_KEY) ?? "").trim();
  return raw !== "" && /^\d+$/.test(raw);
}
