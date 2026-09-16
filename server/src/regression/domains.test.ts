/**
 * ONE NAME IS ONE DOMAIN, however many collectors read it.
 *
 * `domains` used to have a twin, `cloudflare_registrar`, holding identical
 * columns for names registered at Cloudflare — and nothing asking "what do I
 * own and when does it lapse" read the twin. Migration `400_domains_cloudflare`
 * merged them, which fixed the missing names and created the opposite hazard:
 * a name BOTH a registrar plugin and Cloudflare report is now two rows in one
 * table, and counting the portfolio off the raw rows bills it twice.
 *
 * This pins the dedupe and, just as importantly, WHICH ROW SURVIVES. Cloudflare
 * reports no registration date, no privacy flag and no nameservers, so its row
 * is a strict subset; letting it win would blank three fields the other
 * collector actually read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { registeredDomains } from "../providers/domains.ts";

test("a name held by two collectors is counted once, and the registrar's row wins", () => {
  db.exec("DELETE FROM domains");
  /* `plugin_accounts.plugin_id` is a foreign key onto `plugins`, and `domains`
     hangs off the account — so both have to exist before a domain row can. */
  const account = (plugin: string) => {
    db.prepare("INSERT OR IGNORE INTO plugins (id, connected, updated_at) VALUES (?, 1, ?)")
      .run(plugin, "2026-09-06T00:00:00Z");
    db.prepare(
      `INSERT INTO plugin_accounts (plugin_id, label, connected, created_at, updated_at)
       VALUES (?, ?, 1, '2026-09-06T00:00:00Z', '2026-09-06T00:00:00Z')`,
    ).run(plugin, `${plugin} login`);
    return Number(
      (db.prepare("SELECT id FROM plugin_accounts WHERE plugin_id = ?").get(plugin) as { id: number })
        .id,
    );
  };
  const dynadot = account("dynadot");
  const cloudflare = account("cloudflare");
  const spaceship = account("spaceship");

  const row = (name: string, source: string, id: number, registrar: string, registered: string | null) =>
    db
      .prepare(
        `INSERT INTO domains
           (name, source, account_id, account_label, registrar, expires_at, registered_on,
            auto_renew, locked, status, privacy, nameservers, seen_at)
         VALUES (?, ?, ?, 'test', ?, '2027-01-01', ?, 1, 1, 'ok', NULL, NULL, '2026-09-06T00:00:00Z')`,
      )
      .run(name, source, id, registrar, registered);

  /* The same name read by two collectors — the shape migration 400 created. */
  row("shared.example", "dynadot", dynadot, "Dynadot", "2020-05-01");
  row("Shared.Example", "cloudflare", cloudflare, "Cloudflare Registrar", null);
  row("only-cf.example", "cloudflare", cloudflare, "Cloudflare Registrar", null);
  row("only-registrar.example", "spaceship", spaceship, "Spaceship", "2021-02-02");

  const found = registeredDomains({ now: new Date("2026-09-06T00:00:00Z") });
  assert.equal(found.length, 3, "the overlapping name is one domain, not two");

  const shared = found.find((d) => d.name.toLowerCase() === "shared.example");
  assert.equal(shared?.source, "dynadot", "the registrar plugin's row wins the tie");
  assert.equal(shared?.registered_on, "2020-05-01", "and it keeps the field Cloudflare cannot report");

  /* Neither collector's exclusive names are lost — the bug the merge fixed. */
  assert.ok(found.some((d) => d.name === "only-cf.example"));
  assert.ok(found.some((d) => d.name === "only-registrar.example"));

  db.exec("DELETE FROM domains");
  db.prepare("DELETE FROM plugin_accounts WHERE id IN (?, ?, ?)").run(dynadot, cloudflare, spaceship);
});
