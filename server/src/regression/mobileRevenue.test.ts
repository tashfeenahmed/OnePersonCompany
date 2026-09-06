import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import {
  db, insertAccount, markAccount, setAccountConnected, upsertPlugin,
  writeAppStorePayouts, writeAppStoreReport, writePlayEarnings, writePlayFile, writePlaySales,
} from "../db.ts";
import { mobile } from "../routes/mobile.ts";
import type { MobileRevenueStore } from "../routes/mobileRevenue.ts";
import { skillRoutes } from "../routes/skills.ts";
import { syncHermesSkills } from "../skills/hermes.ts";
import { syncOpenClawSkills } from "../skills/openclaw.ts";

type Report = { combined: null; stores: MobileRevenueStore[] };
type Catalog = { skills: { id: string; connectedPlugins: string[]; actions: unknown[]; views: { key: string; route: string }[] }[] };

beforeEach(() => {
  db.prepare("DELETE FROM plugin_accounts WHERE plugin_id IN ('appstore','playstore')").run();
  upsertPlugin("appstore", false, null);
  upsertPlugin("playstore", false, null);
});
function connect(store: string, label = store) {
  upsertPlugin(store, true, null);
  const id = insertAccount(store, label);
  setAccountConnected(id, true);
  markAccount(id, true);
  return id;
}
function apple(id: number, month: string, amount = 100, currency = "USD") {
  writeAppStorePayouts(id, month, [{ appId: "123", currency, amount }]);
  writeAppStoreReport(id, "finance", month, "reported");
}
function google(id: number, month: string, net = 70, currency = "EUR") {
  writePlayEarnings(id, month, [{ package: "com.example.app", currency, charged: 100, refunds: -10, fees: -20, net, transactions: 3 }]);
  writePlayFile(id, "earnings", month, `earnings/earnings_${month}.zip`, null);
}
async function read(query = "") {
  const res = await mobile.request(`/revenue${query}`);
  assert.equal(res.status, 200);
  return res.json() as Promise<Report>;
}

test("revenue tool is unavailable until either store is connected, then exposes its monthly view", async () => {
  const missing = await skillRoutes.request("/mobile?view=revenue");
  assert.equal(missing.status, 409);
  assert.deepEqual((await missing.json() as { needs: string[] }).needs, ["appstore", "playstore"]);
  for (const store of ["appstore", "playstore"]) {
    upsertPlugin(store, true, null);
    const catalog = await (await skillRoutes.request("/")).json() as Catalog;
    const skill = catalog.skills.find(s => s.id === "mobile")!;
    assert.deepEqual(skill.connectedPlugins, [store]);
    assert.deepEqual(skill.actions, []);
    assert.equal(skill.views.find(v => v.key === "revenue")!.route, "/api/mobile/revenue");
    upsertPlugin(store, false, null);
  }
});

test("report months, currencies and stores stay separate; estimates are not revenue", async () => {
  const ios = connect("appstore"), android = connect("playstore");
  apple(ios, "2026-08");
  apple(ios, "2026-07", 9000);
  google(android, "202608");
  google(android, "202607", 8000);
  writePlayEarnings(android, "202608", [
    { package: "com.example.app", currency: "EUR", charged: 100, refunds: -10, fees: -20, net: 70, transactions: 3 },
    { package: "com.example.other", currency: "USD", charged: 50, refunds: 0, fees: -15, net: 35, transactions: 1 },
  ]);
  writePlaySales(android, "202608", [{ package: "com.example.app", currency: "EUR", charged: 9999, taxes: 999, orders: 10, refunds: 0 }]);
  const report = await read("?month=2026-08");
  assert.equal(report.combined, null);
  assert.deepEqual(report.stores.map((s: { revenue: unknown }) => s.revenue), [
    [{ currency: "USD", amount: 100 }], [{ currency: "EUR", amount: 70 }, { currency: "USD", amount: 35 }],
  ]);
  assert.equal(report.stores[0]!.periodBasis, "Apple fiscal month");
  assert.ok(report.stores.every(s => s.status === "reported" && s.amountsCollectedAt));
  assert.deepEqual(report.stores[1]!.accounts[0]!.apps[0]!.revenue, [{ currency: "EUR", amount: 70 }]);
  assert.equal((await read("?store=playstore&month=2026-08")).stores.length, 1);
});

test("latest reports may have different months; an explicitly missing month never falls back", async () => {
  apple(connect("appstore"), "2026-07");
  google(connect("playstore"), "202608");
  assert.deepEqual((await read()).stores.map(s => s.month), ["2026-07", "2026-08"]);
  const missing = (await read("?month=2026-09")).stores;
  assert.ok(missing.every((s: { revenue: unknown; status: string }) => s.revenue === null && s.status === "not_reported"));
});

test("unconnected, missing, partial, stale, and measured zero remain distinguishable", async () => {
  const ios = connect("appstore");
  apple(ios, "2026-08", 0);
  const other = connect("appstore", "Second account");
  markAccount(other, false, "Report permission denied");
  writeAppStoreReport(other, "finance", "2026-08", "none");
  upsertPlugin("appstore", true, "One financial report could not be downloaded");
  const partial = (await read("?month=2026-08")).stores[0]!;
  assert.equal(partial.status, "partial");
  assert.equal(partial.collectionError, "One financial report could not be downloaded");
  assert.deepEqual(partial.revenue, [{ currency: "USD", amount: 0 }]);
  assert.equal(partial.accounts[1]!.revenue, null);
  assert.equal(partial.accounts[1]!.collectionError, "Report permission denied");
  assert.ok(partial.accounts[1]!.lastSuccessfulCollection);
  upsertPlugin("appstore", false, null);
  const disconnected = (await read("?month=2026-08")).stores[0]!;
  assert.equal(disconnected.status, "not_connected");
  assert.equal(disconnected.revenue, null);
  assert.deepEqual(disconnected.availableMonths, []);
});

test("rows without a completed report marker are not published as financial revenue", async () => {
  const android = connect("playstore");
  writePlayEarnings(android, "202608", [{ package: "app", currency: "EUR", charged: 1, refunds: 0, fees: 0, net: 1, transactions: 1 }]);
  assert.equal((await read("?store=playstore&month=2026-08")).stores[0]!.revenue, null);
  writePlayEarnings(android, "202608", []);
  writePlayFile(android, "earnings", "202608", "earnings/empty.zip", null);
  const empty = (await read("?store=playstore&month=2026-08")).stores[0]!;
  assert.equal(empty.status, "reported");
  assert.equal(empty.accounts[0]!.reportAvailable, true);
  assert.equal(empty.revenue, null); // No currency was reported; do not invent one.
});

test("an inactive account cannot supply the latest month or inflate a connected store's revenue", async () => {
  const active = connect("playstore"), inactive = connect("playstore", "Inactive");
  google(active, "202608");
  google(inactive, "202609", 9000);
  google(inactive, "202608", 8000);
  setAccountConnected(inactive, false);
  const report = (await read("?store=playstore")).stores[0]!;
  assert.equal(report.month, "2026-08");
  assert.deepEqual(report.revenue, [{ currency: "EUR", amount: 70 }]);
  assert.equal(report.accounts[1]!.reportAvailable, false);
  assert.equal(report.status, "partial");
});

test("invalid month, store, and daily-window parameters cannot silently change a revenue answer", async () => {
  for (const query of ["month=2026-13", "month=2026-8", "month=", "store=ios", "days=30"])
    assert.equal((await mobile.request(`/revenue?${query}`)).status, 400, query);
});

test("agent proxy forwards month and store to the revenue view", async t => {
  google(connect("playstore"), "202608");
  const app = new Hono().route("/api/mobile", mobile);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", (input: string, init?: RequestInit) => {
    calls.push(input);
    return app.request(input, init);
  });
  const response = await skillRoutes.request("/mobile?view=revenue&store=playstore&month=2026-08");
  assert.equal(response.status, 200);
  assert.match(calls[0]!, /\/api\/mobile\/revenue\?store=playstore&month=2026-08$/);
  assert.deepEqual((await response.json() as Report).stores[0]!.revenue, [{ currency: "EUR", amount: 70 }]);
});

test("Hermes packs and OpenClaw servers update when store plugins connect and disconnect", t => {
  const dir = mkdtempSync(join(tmpdir(), "opc-revenue-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify({ models: { keep: true }, mcp: { servers: { custom: { command: "keep" } } } }));
  syncOpenClawSkills(file);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).mcp.servers["opc-mobile"], undefined);
  connect("appstore");
  assert.ok(syncOpenClawSkills(file));
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(config.mcp.servers["opc-mobile"].env.OPC_SKILL, "mobile");
  assert.deepEqual(config.models, { keep: true });
  assert.deepEqual(config.mcp.servers.custom, { command: "keep" });
  assert.equal(syncOpenClawSkills(file), false);
  const packs = join(dir, "skills");
  syncHermesSkills(packs);
  const pack = readFileSync(join(packs, "finance/app-store-revenue/SKILL.md"), "utf8");
  assert.match(pack, /opc mobile revenue --store/);
  assert.match(pack, /Google Play/);
  connect("playstore");
  upsertPlugin("appstore", false, null);
  /* THE CLAIM IS ABOUT `opc-mobile`, NOT ABOUT THE WHOLE SERVER LIST. The
     other store still enables the same tool, which is what this line has
     always been for. It used to be spelled as "nothing changed at all", and
     that stopped being the same statement once other skills were keyed to one
     store or the other — `mobilehealth`'s `ios` needs App Store Connect and
     its `android` needs Play, so swapping which store is connected genuinely
     changes the list while leaving this tool exactly where it was. */
  syncOpenClawSkills(file);
  assert.equal(
    JSON.parse(readFileSync(file, "utf8")).mcp.servers["opc-mobile"].env.OPC_SKILL,
    "mobile",
  );
  assert.equal(syncHermesSkills(packs).removed.includes("finance/app-store-revenue"), false);
  upsertPlugin("playstore", false, null);
  assert.ok(syncOpenClawSkills(file));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).mcp.servers["opc-mobile"], undefined);
  assert.ok(syncHermesSkills(packs).removed.includes("finance/app-store-revenue"));
});

test("MCP advertises a read-only revenue view and returns the selected store's actual report", () => {
  google(connect("playstore"), "202608");
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types", "--import", fileURLToPath(new URL("../../test/mobile-mcp.mjs", import.meta.url)),
    fileURLToPath(new URL("../skills/mcp.ts", import.meta.url)),
  ], {
    env: { ...process.env, OPC_SKILL: "mobile" },
    encoding: "utf8", timeout: 15_000,
    input: [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "opc_mobile", arguments: { view: "revenue", store: "playstore", month: "2026-08" } } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n",
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  const tool = replies.find(r => r.id === 1).result.tools[0];
  assert.equal(tool.name, "opc_mobile");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.ok(tool.inputSchema.properties.view.enum.includes("revenue"));
  assert.equal(tool.inputSchema.properties.month.type, "string");
  const call = replies.find(r => r.id === 2).result;
  assert.notEqual(call.isError, true);
  const report = JSON.parse(call.content[0].text);
  assert.equal(report.stores[0].store, "playstore");
  assert.deepEqual(report.stores[0].revenue, [{ currency: "EUR", amount: 70 }]);
});
