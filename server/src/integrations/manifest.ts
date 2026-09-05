/**
 * THE INTEGRATION MANIFEST — how a new integration joins this server without
 * editing five shared files.
 *
 * Every integration used to be wired by hand in five places: a migration in
 * db.ts, a credential entry in routes/plugins.ts, a settings entry in
 * routes/pluginConfig.ts, a collector in collector.ts and a mount in index.ts
 * — plus a skill in skills/registry.ts and a pack name in skills/hermes.ts.
 * That was fine at twenty-seven integrations added one at a time. It is not
 * fine when four areas land at once: five files with five authors editing
 * the same object literals is a merge, and a merge inside a working tree has
 * no tool to do it.
 *
 * So an integration is now a DIRECTORY that exports one of these, and the
 * five shared files each read the list in `integrations/index.ts` and spread
 * what they need. The contracts are the ones those files already had — an
 * entry here is exactly what an inline entry there would have been — so
 * nothing about how a plugin verifies, collects or answers has changed;
 * only where it is written down.
 *
 * MIGRATIONS ARE NOT ON THE MANIFEST, deliberately. db.ts runs them at
 * import, before any manifest module could be loaded without a cycle (a
 * manifest imports db; db must not import a manifest). Each area keeps its
 * SQL in its own `migrations.ts` with NO imports, and `integrations/
 * migrations.ts` concatenates those — which db.ts can import safely because
 * pure SQL depends on nothing.
 */
import type { Hono } from "hono";
import type { Skill } from "../skills/registry.ts";

/** One entry of routes/plugins.ts's credential registry. See that file's
 *  header for what each field means; this is the same shape, exported. */
export type PluginRegistryEntry = {
  secret: string;
  fields: string[];
  optional?: string[];
  stems?: Record<string, string>;
  verify?: (values: Record<string, string>) => Promise<string | null>;
};

/** One non-secret setting of routes/pluginConfig.ts's registry. */
export type ConfigKey = {
  label: string;
  hint: string;
  ph?: string;
  check?: (value: string) => string | null;
};

/** One entry of routes/pluginConfig.ts's settings registry. */
export type ConfigRegistryEntry = {
  keys: Record<string, ConfigKey>;
  /** Called after every save with the new values — where "connected" is
   *  derived for a plugin that has a list rather than a credential. */
  after?: (values: Record<string, string>) => void;
  alsoCollect?: string[];
};

/** What every collector returns: whether it worked, and why not. Areas may
 *  return more (counts, notes) and the scheduler ignores the rest. */
export type CollectResult = { ok: boolean; error?: string | null; note?: string | null };

export type IntegrationManifest = {
  /** The area, for logs: "analytics", "ops", "signals", "ventures". */
  id: string;
  /** Credential registry entries, keyed by plugin id. */
  plugins?: Record<string, PluginRegistryEntry>;
  /** Settings registry entries, keyed by plugin id. */
  config?: Record<string, ConfigRegistryEntry>;
  /** Collectors, keyed by plugin id. Run on the scheduler for connected
   *  plugins and by the plugin page's Collect button. */
  collectors?: Record<string, () => Promise<CollectResult>>;
  /** Skill registry entries. */
  skills?: Skill[];
  /** Hermes pack placement for those skills, keyed by skill id. */
  packs?: Record<string, { name: string; category: string }>;
  /** Routers to mount, each at its path ("/api/umami"). */
  routes?: { path: string; app: Hono }[];
  /** Work to start after the server is listening — background passes,
   *  timers. Must not throw. */
  onStart?: () => void;
};
