/**
 * `npm run restore -- <archive>` — the half of a restore that a route must not
 * do.
 *
 * WHY IT IS A CLI AND NOT A BUTTON. Restoring means replacing the file this
 * server has open, plus the vault key that decrypts everything in it. A route
 * that did that would be overwriting a live SQLite database under its own
 * connection, from the LAN, with no way to be sure nothing else was mid-write.
 * So `/api/backups/restore` unpacks and explains, and the swap happens here,
 * with a shell on the machine, with the server stopped.
 *
 * WHY IT IMPORTS ALMOST NOTHING. It deliberately does NOT import db.ts.
 * Importing it would open the database and RUN THE MIGRATIONS — on the very
 * file about to be replaced, which is the one thing a restore tool must never
 * do, and it would also mean a restore tool that cannot start when the
 * database is the thing that is broken. Only config.ts comes in, for the three
 * paths, and it imports nothing but node's own modules.
 *
 * THE THREE REFUSALS, in the order they are cheapest to check:
 *
 *   1. The API answers on its port. Something is serving this data directory.
 *   2. The database refuses an immediate write lock. Something has it open —
 *      another CLI, a `sqlite3` session, a server on a different port.
 *   3. tar cannot read the archive, or it has no opc.db in it. Refusing here
 *      costs nothing; discovering it after the swap costs everything.
 *
 * A HOT WAL IS NOT A REFUSAL, it is a CHECKPOINT. `opc.db-wal` with bytes in
 * it after a clean shutdown means the last stop was not clean — which is
 * exactly the situation somebody restoring is likely to be in. If the lock
 * probe succeeded then nothing else holds the file, so the committed pages in
 * that WAL are folded into the database before it is moved aside, and the file
 * put in the attic is the complete one. Refusing instead would leave the owner
 * with a tool that will not run on the morning it is needed.
 *
 * NOTHING IS DELETED. Everything replaced is renamed with a
 * `.replaced-<timestamp>` suffix beside itself. The whole point of this
 * program is to be run by somebody having a bad day, and a bad day must not be
 * made permanent by a typo in an argument.
 */
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  cpSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { DATA_DIR, DB_FILE, PORT } from "../config.ts";

const ARCHIVE = /^opc-\d{8}-\d{6}\.tar\.gz$/;

/**
 * What comes back out of an archive, and where each piece goes.
 *
 * WRITTEN OUT AGAIN RATHER THAN IMPORTED from integrations/ops/backups.ts, on
 * purpose and for the reason accounts.ts gives about its own data migration: a
 * restore is a statement about an archive that was written at some point in
 * the past, and it must not change meaning because the thing that writes new
 * archives grew a member last week. An archive containing something not on
 * this list is left in the unpacked directory and named, rather than silently
 * ignored or silently copied over something.
 */
import { RESTORE_MEMBERS as RESTORES } from "../backup-manifest.ts";

function die(message: string, hint?: string): never {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h") {
  console.log(`
  npm run restore -- <archive>

  Replaces this data directory's database, vault and service keys, SSH keys,
  screenshots, images, videos, papers and agent configuration with an archive
  written by /api/backups.

  <archive> is either a bare name (opc-20260905-040000.tar.gz), looked for in
  the backup directory, or an absolute path.

  The server must be stopped. Nothing is deleted: whatever is replaced is
  renamed .replaced-<timestamp> beside itself.

  Data directory: ${DATA_DIR}
`);
  process.exit(arg ? 0 : 1);
}

/* --------------------------------------------------- 0. find the archive */

/**
 * Where the backups live.
 *
 * Read from the database when it can be opened read-only, because that is
 * where the setting is — and defaulted when it cannot, because "the database
 * is unreadable" is precisely the case this program exists for. An absolute
 * path on the command line skips the question entirely.
 */
function backupDir(): string {
  const fallback = join(DATA_DIR, "backups");
  if (!existsSync(DB_FILE)) return fallback;
  try {
    const ro = new DatabaseSync(DB_FILE, { readOnly: true });
    const row = ro
      .prepare("SELECT value FROM plugin_config WHERE plugin_id = 'backups' AND key = 'dir'")
      .get() as { value: string } | undefined;
    ro.close();
    return row?.value?.trim() || fallback;
  } catch {
    return fallback;
  }
}

const file = isAbsolute(arg) ? arg : join(backupDir(), basename(arg));
if (!existsSync(file))
  die(
    `There is no ${basename(file)} to restore from.`,
    `Looked in ${isAbsolute(arg) ? arg : backupDir()}. GET /api/backups lists what there is.`,
  );
if (!ARCHIVE.test(basename(file)))
  die(
    `“${basename(file)}” is not one of this app's archives.`,
    "They are named opc-YYYYMMDD-HHMMSS.tar.gz. Unpack anything else by hand.",
  );

console.log(`\n  Restoring from ${file} (${statSync(file).size} bytes)\n`);

/* ------------------------------------------------- 1. is the server up? */

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
    signal: AbortSignal.timeout(1500),
  });
  if (res.ok)
    die(
      `The server is answering on port ${PORT}.`,
      "Stop it first — a restore replaces the database file it currently has open.",
    );
} catch {
  /* Connection refused is the good case: nothing is listening. */
}

/* ------------------------------------------- 2. does anything hold a lock? */

if (existsSync(DB_FILE)) {
  try {
    const probe = new DatabaseSync(DB_FILE);
    try {
      probe.exec("BEGIN IMMEDIATE");
      probe.exec("ROLLBACK");
    } catch (err) {
      probe.close();
      die(
        "Something else has the database open — it would not give up a write lock.",
        `SQLite said: ${err instanceof Error ? err.message : String(err)}. Close any sqlite3 session, and check no second copy of the server is running.`,
      );
    }

    /*
      The WAL, folded in. See this file's header: with the lock held by nobody
      else, a non-empty WAL is an unclean shutdown rather than a live writer,
      and its committed pages belong in the file that is about to be put in the
      attic.
    */
    const wal = `${DB_FILE}-wal`;
    if (existsSync(wal) && statSync(wal).size > 0) {
      console.log(`  Folding ${statSync(wal).size} bytes of write-ahead log into the database first.`);
      probe.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    probe.close();
  } catch (err) {
    if (err instanceof Error && /process\.exit/.test(err.message)) throw err;
    die(
      `The current database could not be opened: ${err instanceof Error ? err.message : String(err)}`,
      "If it is damaged beyond opening, move opc.db* aside by hand and run this again.",
    );
  }
}

/* --------------------------------------------------------- 3. unpack it */

const at = stamp();
const staging = join(DATA_DIR, `restore-${at}`);
mkdirSync(staging, { recursive: true });

const untar = spawnSync("tar", ["-xzf", file, "-C", staging], { encoding: "utf8" });
if (untar.status !== 0) {
  rmSync(staging, { recursive: true, force: true });
  die(
    "tar could not unpack that archive.",
    (untar.stderr || "").trim() || "It is damaged or truncated. Nothing has been changed.",
  );
}

if (!existsSync(join(staging, "opc.db"))) {
  const found = readdirSync(staging).join(", ") || "nothing";
  rmSync(staging, { recursive: true, force: true });
  die(
    "That archive has no opc.db in it, so there is nothing to restore.",
    `It contains: ${found}. Nothing has been changed.`,
  );
}

/* ------------------------------------------------------------ 4. the swap */

const replaced: string[] = [];
const restored: string[] = [];
const skipped: string[] = [];

for (const member of RESTORES) {
  const from = join(staging, member);
  if (!existsSync(from)) {
    skipped.push(member);
    continue;
  }
  const to = join(DATA_DIR, member);
  if (existsSync(to)) {
    const attic = `${to}.replaced-${at}`;
    renameSync(to, attic);
    replaced.push(`${member} → ${basename(attic)}`);
  }
  mkdirSync(join(to, ".."), { recursive: true });
  cpSync(from, to, { recursive: true });
  restored.push(member);
}

/*
  The WAL and SHM of the database being replaced go to the attic with it. A
  fresh opc.db beside the OLD database's write-ahead log is a database that
  opens and is wrong — SQLite would replay pages belonging to a different file
  — and it is the single most likely way a restore silently fails.
*/
for (const side of ["-wal", "-shm"]) {
  const path = `${DB_FILE}${side}`;
  if (!existsSync(path)) continue;
  renameSync(path, `${path}.replaced-${at}`);
  replaced.push(`opc.db${side} → opc.db${side}.replaced-${at}`);
}

// Rewrite only artifact path columns when restoring to another data directory.
const metadata = join(staging, "backup-manifest.json");
if (existsSync(metadata)) {
  const oldDir = JSON.parse(readFileSync(metadata, "utf8")).dataDir as string;
  if (typeof oldDir === "string" && oldDir !== DATA_DIR) {
    const restoredDb = new DatabaseSync(DB_FILE);
    const tables = restoredDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
    try {
      restoredDb.exec("BEGIN IMMEDIATE");
      for (const { name } of tables) {
        const columns = restoredDb.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string; type: string }[];
        for (const col of columns.filter(c => /^(path|file|.*_path)$/.test(c.name) && c.type === "TEXT")) {
          restoredDb.prepare(`UPDATE ${quote(name)} SET ${quote(col.name)} = ? || substr(${quote(col.name)}, ?) WHERE substr(${quote(col.name)}, 1, ?) = ?`)
            .run(DATA_DIR, oldDir.length + 1, oldDir.length + 1, oldDir + "/");
        }
      }
      restoredDb.exec("COMMIT");
    } catch (error) { restoredDb.exec("ROLLBACK"); throw error; }
    finally { restoredDb.close(); }
  }
}
const extra = readdirSync(staging).filter(
  (n) => !RESTORES.some((m) => m === n || m.startsWith(`${n}/`)),
);

console.log(`  Restored: ${restored.join(", ")}`);
if (skipped.length) console.log(`  Not in the archive: ${skipped.join(", ")}`);
if (replaced.length) console.log(`  Moved aside: ${replaced.join(", ")}`);
if (extra.length)
  console.log(`  Left unpacked at ${staging} (not part of a restore): ${extra.join(", ")}`);
console.log(`
  Done. Start the server and check http://127.0.0.1:${PORT}/api/health, then the
  Integrations page — a restored vault.key is what makes the stored credentials
  readable again.

  Nothing was deleted. When you are satisfied, remove the .replaced-${at} files
  and ${staging} by hand.
`);
process.exit(0);
