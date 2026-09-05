/**
 * The list the shared files read. Adding an area is one import and one line
 * here; everything else the area needs is on its manifest.
 */
import type { IntegrationManifest, PluginRegistryEntry, ConfigRegistryEntry, CollectResult } from "./manifest.ts";
import type { Skill } from "../skills/registry.ts";
import { manifest as analytics } from "./analytics/manifest.ts";
import { manifest as ops } from "./ops/manifest.ts";
import { manifest as signals } from "./signals/manifest.ts";
import { manifest as ventures } from "./ventures/manifest.ts";
import { manifest as runs } from "./runs/manifest.ts";
import { manifest as subagents } from "./subagents/manifest.ts";

export const MANIFESTS: IntegrationManifest[] = [analytics, ops, signals, ventures, runs, subagents];

export function manifestPlugins(): Record<string, PluginRegistryEntry> {
  return Object.assign({}, ...MANIFESTS.map((m) => m.plugins ?? {}));
}
export function manifestConfig(): Record<string, ConfigRegistryEntry> {
  return Object.assign({}, ...MANIFESTS.map((m) => m.config ?? {}));
}
export function manifestCollectors(): Record<string, () => Promise<CollectResult>> {
  return Object.assign({}, ...MANIFESTS.map((m) => m.collectors ?? {}));
}
export function manifestSkills(): Skill[] {
  return MANIFESTS.flatMap((m) => m.skills ?? []);
}
export function manifestPacks(): Record<string, { name: string; category: string }> {
  return Object.assign({}, ...MANIFESTS.map((m) => m.packs ?? {}));
}
