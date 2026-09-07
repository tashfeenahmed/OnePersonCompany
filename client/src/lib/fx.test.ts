import test from "node:test";
import assert from "node:assert/strict";
import { rateBetween } from "./fx.ts";

const ref = { base: "EUR", asOf: "2026-09-05", fetchedAt: "2026-09-07T08:00:00Z", rates: { USD: 1.1622, GBP: 0.8654 } };

test("a typed rate wins, the ECB fills the rest, and a pair nobody can price is null", () => {
  assert.deepEqual(rateBetween("EUR", "USD", [{ from: "EUR", to: "USD", rate: 1.1, asOf: "2026-09-01" }], ref), { rate: 1.1, source: "typed", asOf: "2026-09-01" });
  const ecb = rateBetween("EUR", "USD", [], ref)!;
  assert.equal(ecb.source, "ecb");
  assert.equal(ecb.rate, 1.1622);
  assert.equal(ecb.asOf, "2026-09-05");
  const back = rateBetween("usd", "eur", [], ref)!;
  assert.ok(Math.abs(back.rate - 1 / 1.1622) < 1e-12);
  const cross = rateBetween("GBP", "USD", [], ref)!;
  assert.ok(Math.abs(cross.rate - 1.1622 / 0.8654) < 1e-12);
  assert.equal(rateBetween("JPY", "USD", [], ref), null);
  assert.equal(rateBetween("EUR", "USD", [], null), null);
  assert.equal(rateBetween("USD", "USD", [], null)!.rate, 1);
});
