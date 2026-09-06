/**
 * Credentials at rest.
 *
 * The shape is deliberately the same as the previous system's own secrets
 * store: AES-256-GCM, a 12-byte IV, a 16-byte tag, and THE ENTRY NAME AS ASSOCIATED
 * DATA — so a ciphertext moved into another row fails to open rather than
 * opening as the wrong secret. The key is 32 random bytes in a file beside the
 * database, mode 0600, generated on first use.
 *
 * WHAT THIS DOES AND DOES NOT BUY. It means a copy of opc.db — a backup, a
 * synced folder, a stray scp — carries ciphertext rather than a live Hetzner
 * token. It does not defend against someone who already has the data directory,
 * because the key is in it; defending against that needs a key the machine does
 * not hold, which is a different product. The threat this actually addresses is
 * the ordinary one: database files travel, and they should not travel readable.
 *
 * THE DOOR IS ONE-WAY FROM OUTSIDE. `read` exists for collectors inside this
 * process. No route returns a secret, and none should: this API is reachable
 * from the LAN and "the settings page can show you the key" is how an open
 * dashboard becomes an open Hetzner account.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { VAULT_KEY_FILE } from "./config.ts";
import { db, now } from "./db.ts";

const IV_BYTES = 12;
const KEY_BYTES = 32;

function loadKey(): Buffer {
  if (existsSync(VAULT_KEY_FILE)) {
    const key = Buffer.from(readFileSync(VAULT_KEY_FILE, "utf8").trim(), "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `vault key at ${VAULT_KEY_FILE} is ${key.length} bytes, expected ${KEY_BYTES}`,
      );
    }
    return key;
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(VAULT_KEY_FILE, key.toString("base64"), { mode: 0o600 });
  chmodSync(VAULT_KEY_FILE, 0o600);
  console.log(`[vault] generated a new key at ${VAULT_KEY_FILE}`);
  return key;
}

let cached: Buffer | null = null;
const key = () => (cached ??= loadKey());

/**
 * Store (or replace) one credential. The plugin and account rows must exist.
 *
 * The name is the entry's identity for the life of the row, because it is the
 * associated data the ciphertext is sealed with — a re-seal is the only way to
 * change it, so callers pass the name a row already has rather than deriving
 * one afresh. `field` says which half of a credential set this is ("key",
 * "secret", "token"), which is what lets a provider ask for its credentials by
 * meaning instead of by reconstructing a name.
 */
export function write(
  name: string,
  pluginId: string,
  accountId: number,
  field: string,
  value: string,
) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  db.prepare(
    `INSERT INTO secrets (name, plugin_id, account_id, field, iv, tag, ct, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       plugin_id = excluded.plugin_id,
       account_id = excluded.account_id,
       field = excluded.field,
       iv = excluded.iv, tag = excluded.tag, ct = excluded.ct,
       updated_at = excluded.updated_at`,
  ).run(name, pluginId, accountId, field, iv, tag, ct, now());
}

/**
 * The plaintext, or null when the entry is absent or will not open.
 *
 * A mis-keyed vault degrades to "not configured" rather than throwing, because
 * every caller already handles the absent case honestly and none of them should
 * turn a key problem into a crash in a collector that was fine yesterday.
 */
export function read(name: string, reader: string): string | null {
  const row = db.prepare("SELECT iv, tag, ct FROM secrets WHERE name = ?").get(name) as
    | { iv: Uint8Array; tag: Uint8Array; ct: Uint8Array }
    | undefined;
  if (!row) return null;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(row.iv));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(Buffer.from(row.tag));
    const out = Buffer.concat([
      decipher.update(Buffer.from(row.ct)),
      decipher.final(),
    ]).toString("utf8");

    db.prepare("INSERT INTO secret_access (ts, name, reader) VALUES (?, ?, ?)").run(
      now(),
      name,
      reader,
    );
    return out;
  } catch {
    console.error(`[vault] ${name} did not open — wrong key, or a damaged row`);
    return null;
  }
}

export function remove(name: string) {
  db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
}

/* ------------------------------------------------------------- per account */

export type EntryInfo = { name: string; field: string; updatedAt: string };

/** Which entries this account owns, by field. Names and dates, never values. */
export function entries(accountId: number): EntryInfo[] {
  return (
    db
      .prepare(
        "SELECT name, field, updated_at FROM secrets WHERE account_id = ? ORDER BY field",
      )
      .all(accountId) as unknown as {
      name: string;
      field: string;
      updated_at: string;
    }[]
  ).map((r) => ({ name: r.name, field: r.field, updatedAt: r.updated_at }));
}

/** Is this entry name already spoken for? Names are unique across the vault
 *  because each one is the associated data of exactly one ciphertext. */
export function taken(name: string): boolean {
  return !!db.prepare("SELECT 1 FROM secrets WHERE name = ?").get(name);
}

/**
 * One account's whole credential set, keyed by field.
 *
 * A field whose row will not open is left OUT rather than mapped to an empty
 * string: a provider that gets `{key: "…", secret: ""}` will build a signature
 * out of nothing and be told its perfectly good key is wrong, which sends the
 * owner to the registrar to fix a problem that is in the vault. An absent key
 * is a caller checking `if (!values.secret)` and saying so.
 */
export function readSet(accountId: number, reader: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries(accountId)) {
    const value = read(e.name, reader);
    if (value !== null) out[e.field] = value;
  }
  return out;
}

/** Which entries exist and when they changed. Never their values. */
export function status(pluginId: string): { name: string; updatedAt: string }[] {
  return (
    db
      .prepare("SELECT name, updated_at FROM secrets WHERE plugin_id = ? ORDER BY name")
      .all(pluginId) as unknown as { name: string; updated_at: string }[]
  ).map((r) => ({ name: r.name, updatedAt: r.updated_at }));
}
