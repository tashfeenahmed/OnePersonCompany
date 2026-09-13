import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../db.ts";
import { observeInfrastructure } from "./infrastructure.ts";
import { recordFleetResources } from "../ops/infrastructure.ts";
import { recordWorkstationObservation } from "../security/infrastructure.ts";

test("infrastructure records transitions once, preserves first-sample baselines, and ignores unknown readings", () => {
  const sample = { key: "test:server", source: "fleet", label: "API host", ts: "2026-09-01T10:00:00Z", value: true as boolean | null, describe: (_a: unknown, b: unknown) => b ? "recovered" : "unreachable" };
  assert.equal(observeInfrastructure(sample), false);
  assert.equal(observeInfrastructure({ ...sample, ts: "2026-09-01T11:00:00Z", value: false }), true);
  assert.equal(observeInfrastructure({ ...sample, ts: "2026-09-01T11:00:00Z", value: false }), false);
  assert.equal(observeInfrastructure({ ...sample, ts: "2026-09-01T11:30:00Z", value: null }), false);
  assert.equal(observeInfrastructure({ ...sample, ts: "2026-09-01T12:00:00Z", value: true }), true);
  const events = db.prepare("SELECT title FROM activity_events WHERE key LIKE 'infrastructure:test:server:%' ORDER BY ts").all() as { title: string }[];
  assert.deepEqual(events.map(e => e.title), ["API host: unreachable", "API host: recovered"]);
});
test("threshold changes establish a new baseline rather than invent a disk transition", () => {
  const sample = { key: "test:disk", source: "fleet", label: "Disk", ts: "2026-09-01T10:00:00Z", value: false, basis: "85", describe: () => "threshold crossed" };
  observeInfrastructure(sample);
  assert.equal(observeInfrastructure({ ...sample, ts: "2026-09-01T11:00:00Z", basis: "70", value: true }), false);
});
test("container changes are detected even when the total number stays the same", () => {
  recordFleetResources(90001, "2026-09-01T10:00:00Z", { docker: 1, disks: [], containers: [{ name: "api" }] });
  recordFleetResources(90001, "2026-09-01T10:30:00Z", { docker: 1, disks: [], containers: [{ name: "worker" }] });
  const row = db.prepare("SELECT title FROM activity_events WHERE key LIKE 'infrastructure:fleet:90001:containers:%'").get() as { title: string };
  assert.match(row.title, /started: worker/); assert.match(row.title, /stopped or removed: api/);
});
test("disk and GPU adapters record threshold crossings without interpreting unknown GPU data as idle", () => {
  for (const [index, used] of [80, 90, 75].entries()) recordFleetResources(90002, `2026-09-02T1${index}:00:00Z`, { docker: null, disks: [{ mount: "/", used, avail: 100 - used }], containers: [] });
  const disks = db.prepare("SELECT title FROM activity_events WHERE key LIKE 'infrastructure:fleet:90002:disk:%' ORDER BY ts").all() as { title: string }[];
  assert.equal(disks.length, 2); assert.match(disks[0]!.title, /crossed 85%/); assert.match(disks[1]!.title, /returned below 85%/);
  for (const [index, utilisationPercent] of [0, 80, null, 0].entries()) recordWorkstationObservation({ id: 90003, label: "Compute", reachable: true, gpus: [{ name: "GPU", utilisationPercent }] }, `2026-09-02T1${index}:00:00Z`);
  const gpus = db.prepare("SELECT title FROM activity_events WHERE key LIKE 'infrastructure:workstation:90003:gpu:%' ORDER BY ts").all() as { title: string }[];
  assert.equal(gpus.length, 2); assert.match(gpus[0]!.title, /became busy/); assert.match(gpus[1]!.title, /became idle/);
});
