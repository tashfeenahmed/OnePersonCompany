/**
 * The ops area's tests — the two facts that are only true because of a
 * decision, and would be silently untrue again if the decision were undone.
 *
 * NOTHING HERE OPENS AN SSH CONNECTION. The probe, the counters and the rsync
 * are verified against real boxes and written up in the README; what is tested
 * here is the bookkeeping around them, which is where the bug was.
 */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { test } from "node:test";
import * as accounts from "../../accounts.ts";
import { upsertPlugin } from "../../db.ts";
import { retentionFor } from "../../shared/retention.ts";
import { KEY_PLUGINS, keyPath, keysDir, reapKeyFiles, writeKeyFile } from "./fleet.ts";
import "./backups.ts";
import "./uptime.ts";

const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----";

/**
 * THE REGRESSION. `reapKeyFiles()` ran on every fleet collection — every half
 * hour — and deleted the WORKSTATION account's private key, because every
 * writer named its file `fleet-<accountId>.pem` while only fleet's own account
 * ids were ever checked against that name. A workstation id is never in
 * `accounts.list("fleet")`, so the file always looked orphaned.
 *
 * It was masked because workstation.ts rewrites the file immediately before
 * every use. The reader that would have found it is `backups.ts`, which only
 * checks the path exists.
 */
test("the key reaper does not delete another plugin's key", () => {
  for (const name of readdirSync(keysDir())) rmSync(`${keysDir()}/${name}`, { force: true });

  /* `plugin_accounts.plugin_id` is a foreign key, so both plugins have to
     exist before an account can hang off one. */
  upsertPlugin("fleet", true, null);
  upsertPlugin("workstation", true, null);
  const box = accounts.create("fleet", "A box");
  const machine = accounts.create("workstation", "The desk");
  const boxKey = writeKeyFile("fleet", box.id, PEM);
  const machineKey = writeKeyFile("workstation", machine.id, PEM);
  assert.notEqual(boxKey, machineKey, "two plugins must not share one file name");

  assert.deepEqual(reapKeyFiles(), [], "nothing here is an orphan");
  assert.ok(existsSync(boxKey));
  assert.ok(existsSync(machineKey), "the workstation key survives a fleet collection");

  /* And an account that really is gone still loses its key, which is the
     reason the reaper exists at all. */
  accounts.remove(machine);
  assert.deepEqual(reapKeyFiles(), [`workstation-${machine.id}.pem`]);
  assert.equal(existsSync(machineKey), false);
  assert.ok(existsSync(boxKey), "and the other plugin is untouched by that too");
});

test("keyPath is the only speller of the path, for every plugin that keeps one", () => {
  for (const plugin of KEY_PLUGINS) assert.match(keyPath(plugin, 7), new RegExp(`/${plugin}-7\\.pem$`));
});

/**
 * The three tables that had no prune ANYWHERE before the registry existed —
 * whole JSON documents one per incident, a QA table and the backup log —
 * growing for the life of the box because nothing listed what gets pruned.
 */
test("every table this area writes history into has a declared window", () => {
  for (const table of ["backup_runs", "uptime_checks", "fleet_samples", "fleet_disks", "fleet_containers"]) {
    const entry = retentionFor(table);
    assert.ok(entry, `${table} has no retention entry, so nothing prunes it`);
    assert.ok(entry.days > 0 && entry.note, `${table}'s window needs a number and a reason`);
  }
});
