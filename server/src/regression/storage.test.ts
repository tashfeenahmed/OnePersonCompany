import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import { db } from "../db.ts";
import { runBackup } from "../integrations/ops/backups.ts";
import { serviceHeaders } from "../auth.ts";
const server = fileURLToPath(new URL("../../", import.meta.url));
test("backup and restore include artifacts, service identity, and relocated file paths", async () => {
  serviceHeaders();
  for (const dir of ["video", "papers"]) { mkdirSync(join(DATA_DIR, dir), { recursive: true }); writeFileSync(join(DATA_DIR, dir, "sentinel.txt"), `${dir} content`); }
  db.exec("CREATE TABLE artifact_fixture (path TEXT)"); db.prepare("INSERT INTO artifact_fixture VALUES (?)").run(join(DATA_DIR, "papers/sentinel.txt"));
  const backup = await runBackup(); assert.equal(backup.ok, true, backup.error ?? "");
  for (const name of ["video", "papers", "service-key"]) assert.ok(backup.members.includes(name));
  const target = join(DATA_DIR, "restored");
  const restored = spawnSync(process.execPath, ["--experimental-strip-types", join(server, "src/cli/restore.ts"), backup.file!], { encoding: "utf8", env: { ...process.env, OPC_DATA_DIR: target, PORT: "28997" } });
  assert.equal(restored.status, 0, restored.stderr + restored.stdout);
  assert.equal(readFileSync(join(target, "papers/sentinel.txt"), "utf8"), "papers content");
  assert.equal(readFileSync(join(target, "video/sentinel.txt"), "utf8"), "video content");
  assert.equal(readFileSync(join(target, "service-key"), "utf8"), readFileSync(join(DATA_DIR, "service-key"), "utf8"));
  const restoredDb = new DatabaseSync(join(target, "opc.db"));
  assert.equal((restoredDb.prepare("SELECT path FROM artifact_fixture").get() as {path: string}).path, join(target, "papers/sentinel.txt")); restoredDb.close();
});
test("four simultaneous processes can initialize one database", async () => {
  const target = join(DATA_DIR, "shared-migrations");
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `await import(${JSON.stringify(new URL("../db.ts", import.meta.url).href)})`], { env: { ...process.env, OPC_DATA_DIR: target }, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", chunk => { error += String(chunk); }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run(), run(), run(), run()]);
});
test("env files load and explicit process configuration wins", () => {
  const folder = mkdtempSync(join(tmpdir(), "opc-env-test-")), env = join(folder, ".env");
  writeFileSync(env, "PORT=19876\nOPC_COLLECT_MINUTES=0\n");
  const code = `const c = await import(${JSON.stringify(new URL("../config.ts", import.meta.url).href)}); process.stdout.write(JSON.stringify([c.PORT,c.COLLECT_MINUTES]));`;
  const output = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, OPC_ENV_FILE: env, PORT: "19877", OPC_COLLECT_MINUTES: "0" } });
  assert.equal(output.status, 0, output.stderr); assert.deepEqual(JSON.parse(output.stdout), [19877,0]);
});
