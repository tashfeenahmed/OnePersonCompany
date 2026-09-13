import { readLocalList } from "../../local-metadata.ts";

export type FleetRegion = { address: string; hostname: string; location: string; country: string };
const validRegion = (value: unknown): value is FleetRegion => {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return ["address", "hostname", "location"].every(key => typeof row[key] === "string" && row[key].trim().length > 0)
    && typeof row.country === "string" && /^[A-Z]{2}$/.test(row.country);
};

export const fleetRegions = (): FleetRegion[] => readLocalList("fleet-regions.json", validRegion) ?? [];

export function fleetRegion(regions: FleetRegion[], target: string | null, hostname: string | null) {
  const address = target?.split("@").at(-1)?.replace(/:\d+$/, "") ?? null;
  const row = regions.find(region => region.address === address && region.hostname === hostname);
  return row ? { location: row.location, country: row.country } : null;
}
