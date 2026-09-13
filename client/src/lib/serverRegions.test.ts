import test from "node:test";
import assert from "node:assert/strict";
import { countryFlag, serverRegion } from "./serverRegions.ts";

test("provider region takes precedence over local metadata", () => {
  assert.deepEqual(serverRegion({ location: "hel1-dc2", configured: { location: "Example", country: "US" } }), { location: "Helsinki · hel1-dc2", country: "FI" });
});
test("configured regions keep flags working without hardcoded host inventory", () => {
  const region = serverRegion({ location: null, configured: { location: "Example region", country: "US" } });
  assert.equal(region.location, "Example region");
  assert.equal(countryFlag(region.country), "🇺🇸");
  assert.deepEqual(serverRegion({ location: null }), { location: null, country: null });
  assert.equal(countryFlag("invalid"), null);
});
