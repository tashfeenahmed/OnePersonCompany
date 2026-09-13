import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { fleetRegion, fleetRegions } from "./fleet-regions.ts";

test("local region mapping requires both address and hostname", () => {
  const rows = [{ address: "192.0.2.10", hostname: "example-server", location: "Example region", country: "US" }];
  assert.deepEqual(fleetRegion(rows, "owner@192.0.2.10:22", "example-server"), { location: "Example region", country: "US" });
  assert.equal(fleetRegion(rows, "owner@192.0.2.11", "example-server"), null);
  assert.equal(fleetRegion(rows, "owner@192.0.2.10", "different-server"), null);
  assert.equal(fleetRegion(rows, null, null), null);
});
test("missing local inventory is empty and malformed inventory fails without exposing its contents", () => {
  const file = join(DATA_DIR, "fleet-regions.json");
  assert.deepEqual(fleetRegions(), []);
  try {
    writeFileSync(file, JSON.stringify([{ address: "192.0.2.10", hostname: "example-server", location: "Example", country: "GB" }]));
    assert.equal(fleetRegions()[0]?.country, "GB");
    writeFileSync(file, JSON.stringify([{ country: "invalid-private-value" }]));
    assert.throws(() => fleetRegions(), /^Error: Invalid entries in local configuration fleet-regions.json\.$/);
    writeFileSync(file, "invalid-private-json");
    assert.throws(() => fleetRegions(), /^Error: Invalid JSON in local configuration fleet-regions.json\.$/);
  } finally { rmSync(file, { force: true }); }
});
