/**
 * WHERE THE REQUESTS CAME FROM, AND WHICH SITE EACH DAY'S BAR BELONGS TO.
 *
 * The route sums the stored countryMap over the window and hands each day its
 * per-zone split. Pinned here: a window with even one day collected before
 * countries were asked for reports `countries: null` — a smaller world is not
 * a partial one — and a fully-collected window sums both columns.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, replaceCloudflareZones, writeCloudflareTraffic } from "../db.ts";
import { cloudflareRoutes } from "../routes/cloudflare.ts";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function zone(id: string, name: string) {
  return {
    id,
    name,
    status: "active",
    paused: false,
    plan: "Free Website",
    type: "full",
    createdOn: "2026-01-01",
    nameServers: null,
    records: 4,
    proxied: 2,
    onPages: false,
    email: null,
    recordsNote: null,
    trafficNote: null,
    cfAccountId: null,
    cfAccountName: null,
  };
}

function traffic(zoneId: string, d: string, requests: number, countries: Record<string, [number, number]> | null) {
  return {
    zoneId,
    day: d,
    requests,
    cached: 0,
    bytes: 100,
    threats: 1,
    pageViews: 5,
    uniques: 3,
    s2xx: requests,
    s3xx: 0,
    s4xx: 0,
    s5xx: 0,
    fields: countries ? "geo" : "full",
    countries,
  };
}

test("countries sum over the window and each day carries its sites", async () => {
  db.prepare("INSERT OR IGNORE INTO plugins (id, connected, updated_at) VALUES ('cloudflare', 1, ?)").run(day(0));
  db.prepare(
    `INSERT INTO plugin_accounts (plugin_id, label, connected, created_at, updated_at)
     VALUES ('cloudflare', 'cf', 1, ?, ?)`,
  ).run(day(0), day(0));
  const accountId = Number(
    (db.prepare("SELECT id FROM plugin_accounts WHERE plugin_id = 'cloudflare'").get() as { id: number }).id,
  );
  replaceCloudflareZones(accountId, "cf", [zone("z1", "one.example"), zone("z2", "two.example")]);
  writeCloudflareTraffic([
    traffic("z1", day(-2), 10, { US: [6, 1], DE: [4, 0] }),
    traffic("z1", day(-1), 20, { US: [5, 0], IE: [15, 2] }),
    traffic("z2", day(-1), 7, { DE: [7, 0] }),
  ]);

  const doc = (await (await cloudflareRoutes.request("/?days=7")).json()) as {
    summary: { countries: { code: string; requests: number; threats: number }[] | null };
    zones: { name: string; traffic: { countries: { code: string; requests: number }[] | null } | null }[];
    daily: { day: string; sites: { name: string; requests: number }[] }[];
  };
  assert.deepEqual(doc.summary.countries, [
    { code: "IE", requests: 15, threats: 2 },
    { code: "US", requests: 11, threats: 1 },
    { code: "DE", requests: 11, threats: 0 },
  ]);
  const one = doc.zones.find((z) => z.name === "one.example")!;
  assert.equal(one.traffic!.countries![0]!.code, "IE");
  const yesterday = doc.daily.find((d) => d.day === day(-1))!;
  assert.deepEqual(
    yesterday.sites.map((s) => [s.name, s.requests]).sort(),
    [["one.example", 20], ["two.example", 7]],
  );

  /* One day from before countries were collected blanks the whole split. */
  writeCloudflareTraffic([traffic("z2", day(-3), 3, null)]);
  const after = (await (await cloudflareRoutes.request("/?days=7")).json()) as typeof doc;
  assert.equal(after.summary.countries, null);
  assert.equal(after.zones.find((z) => z.name === "two.example")!.traffic!.countries, null);
  assert.ok(after.zones.find((z) => z.name === "one.example")!.traffic!.countries);
});
