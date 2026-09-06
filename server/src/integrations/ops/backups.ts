/**
 * BACKUPS — the one thing here that is not a measurement.
 *
 * Everything else in this server is a window onto what a provider said. This
 * is about the data directory itself: a SQLite database, the vault key that
 * makes its ciphertext readable, the ssh keys the fleet probe uses, the
 * screenshots, the Studio images, and the agent's own configuration and
 * skills. Lose the directory and the dashboards can all be rebuilt from the
 * providers in a day; lose the vault key and every credential in it is gone,
 * because it is the only copy.
 *
 * WHY VACUUM INTO AND NOT A FILE COPY. `cp opc.db backups/` while this process
 * is running copies a database mid-transaction with its WAL somewhere else
 * entirely, and the result opens — sometimes. `VACUUM INTO` asks SQLite for a
 * consistent snapshot of the whole database as of one moment, written to a new
 * file with no WAL beside it. It is the only supported way to take a copy of a
 * live database, and it is why the archive can be made while the server is
 * serving.
 *
 * WHAT IS DELIBERATELY NOT IN THE ARCHIVE. The managed SearXNG, freellmapi and
 * agent installs are hundreds of megabytes of node_modules, virtualenvs and
 * git checkouts that reinstall themselves from a URL. Backing them up would
 * turn a four-megabyte nightly into a gigabyte one to preserve something the
 * install button rebuilds. `hermes/home/.hermes/config.yaml` and its `skills`
 * directory ARE included, because those are configuration a person wrote.
 *
 * THE ARCHIVE CONTAINS THE VAULT KEY, IN PLAINTEXT. It has to: a backup of the
 * ciphertext without the key restores nothing. So the archive is exactly as
 * sensitive as the data directory, and anywhere it is copied to is somewhere
 * every credential on this box effectively lives. That is stated here, on the
 * settings page, and in what `/api/backups` returns, because an owner who
 * rsyncs this to a shared NAS should be making that decision knowingly.
 *
 * THE NIGHTLY RUN IS OFF UNTIL IT IS SWITCHED ON. A timer that starts writing
 * tarballs at four in the morning because a default said so is a surprise, and
 * this one writes a file containing every credential the owner has. `nightly`
 * is a setting with no default; everything else has one.
 */
import { spawn } from "node:child_process";
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve as resolvePath, basename } from "node:path";
import { DATA_DIR, RETAIN_DAYS } from "../../config.ts";
import { configValue, db, now, upsertPlugin } from "../../db.ts";
import { registerRetention } from "../../shared/retention.ts";
import { keyPath } from "./fleet.ts";

export const PLUGIN = "backups";

/**
 * THE BACKUP LEDGER AGES ON THE BOX'S OWN HISTORY SETTING, and it had no
 * window at all until now.
 *
 * The other two tables that were missing a prune are MEASUREMENTS, and this
 * area chose a number for them. This one is different in kind: it is the
 * record of the box doing its own job, and the question it answers — "has the
 * nightly backup been failing since March, and when did it last actually
 * work" — is exactly the question a long history exists for. So it follows
 * `OPC_RETAIN_DAYS`, the setting the owner can change, rather than a number
 * invented here; a handful of rows a day makes that free.
 *
 * A THUNK RATHER THAN THE NUMBER, so nothing can report a window the prune has
 * stopped using.
 */
registerRetention({
  table: "backup_runs",
  column: "ts",
  days: () => RETAIN_DAYS,
  source: "setting",
  setting: "OPC_RETAIN_DAYS",
  note:
    "Every backup attempt, successful or not. “When did this last work” is only answerable by something that " +
    "also recorded the times it did not, so it ages with the box's own history setting rather than a shorter one.",
});

/** What an archive is called. Sorted lexically it is sorted by age, which is
 *  what makes pruning a slice rather than a stat of every file. */
const PREFIX = "opc-";
const SUFFIX = ".tar.gz";
export const ARCHIVE = /^opc-\d{8}-\d{6}\.tar\.gz$/;

export const DEFAULT_KEEP = 14;
export const DEFAULT_HOUR = 4;

/**
 * What goes in, relative to the data directory.
 *
 * The database is not on this list: it is the VACUUM copy, which lives in a
 * staging directory and is added under its own -C. Everything here is copied
 * as it lies, and anything absent is skipped and named in the run note — a
 * fresh install has no `shots` and that is not a failure.
 */
export { BACKUP_MEMBERS as MEMBERS } from "../../backup-manifest.ts";
import { BACKUP_MEMBERS as MEMBERS } from "../../backup-manifest.ts";

/* ------------------------------------------------------------------ settings */

export type Settings = {
  dir: string;
  remote: string | null;
  /** The fleet account whose key rsync should use, by label. */
  remoteKey: string | null;
  keep: number;
  hour: number;
  nightly: boolean;
};

export function settings(): Settings {
  const dir = (configValue(PLUGIN, "dir") ?? "").trim();
  const rawRemote = (configValue(PLUGIN, "remote") ?? "").trim();
  /* Number("") is 0, which for `hour` is a perfectly valid hour — midnight —
     and would silently make "never set" mean "run at 00:00". So the raw string
     is checked for being there before it is read as a number. */
  const rawKeep = (configValue(PLUGIN, "keep") ?? "").trim();
  const rawHour = (configValue(PLUGIN, "hour") ?? "").trim();
  const keep = rawKeep ? Number(rawKeep) : NaN;
  const hour = rawHour ? Number(rawHour) : NaN;

  /* `user@host:/path key=Label` — the key clause is optional and comes last,
     so the remote itself never has to be escaped. */
  const keyed = /\s+key=(.+)$/.exec(rawRemote);
  return {
    dir: dir ? resolvePath(dir) : join(DATA_DIR, "backups"),
    remote: rawRemote ? (keyed ? rawRemote.slice(0, keyed.index).trim() : rawRemote) : null,
    remoteKey: keyed ? keyed[1]!.trim() : null,
    keep: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DEFAULT_KEEP,
    hour: Number.isFinite(hour) && hour >= 0 && hour <= 23 ? Math.floor(hour) : DEFAULT_HOUR,
    nightly: (configValue(PLUGIN, "nightly") ?? "").trim().toLowerCase() === "on",
  };
}

/* --------------------------------------------------------------- the runs table */

export type RunRow = {
  ts: string;
  file: string | null;
  bytes: number | null;
  ok: number;
  remote_ok: number | null;
  members: string | null;
  ms: number | null;
  kind: string;
  error: string | null;
};

export function runs(limit = 20): RunRow[] {
  return db
    .prepare("SELECT * FROM backup_runs ORDER BY ts DESC LIMIT ?")
    .all(limit) as unknown as RunRow[];
}

function writeRun(row: Omit<RunRow, "ok" | "remote_ok"> & { ok: boolean; remote_ok: boolean | null }) {
  db.prepare(
    `INSERT INTO backup_runs (ts, file, bytes, ok, remote_ok, members, ms, kind, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ts) DO UPDATE SET
       file = excluded.file, bytes = excluded.bytes, ok = excluded.ok,
       remote_ok = excluded.remote_ok, members = excluded.members,
       ms = excluded.ms, kind = excluded.kind, error = excluded.error`,
  ).run(
    row.ts,
    row.file,
    row.bytes,
    row.ok ? 1 : 0,
    row.remote_ok === null ? null : row.remote_ok ? 1 : 0,
    row.members,
    row.ms,
    row.kind,
    row.error,
  );
}

/* ------------------------------------------------------------------ processes */

export type Ran = { code: number | null; stdout: string; stderr: string };

/** Run a binary with arguments — never a shell string, so nothing the owner
 *  typed can become a command. */
export function run(cmd: string, args: string[], timeoutMs = 300_000): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      done({ code, stdout, stderr: stderr.trim() });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`;
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

/* ---------------------------------------------------------------- the archive */

/** `opc-20260905-113000.tar.gz` — local time, because it is a name a person
 *  reads next to a clock on the same wall. */
function stamp(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

export type Archive = { file: string; name: string; bytes: number; at: string };

export function list(): Archive[] {
  const dir = settings().dir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => ARCHIVE.test(n))
    .sort()
    .reverse()
    .map((name) => {
      const file = join(dir, name);
      const st = statSync(file);
      return { file, name, bytes: st.size, at: st.mtime.toISOString() };
    });
}

/**
 * A name the caller asked for, turned into a path inside the backup directory
 * — or refused.
 *
 * THE ONE PLACE A CALLER-SUPPLIED PATH IS ACCEPTED, so it is the one place
 * that can be traversed out of. Only a bare file name matching the archive
 * pattern is allowed: no separators, no `..`, no absolute path. A caller that
 * hands over `../../vault.key` gets a refusal rather than a listing of it.
 */
export function archivePath(name: string): { file: string } | { error: string } {
  const bare = basename(name.trim());
  if (!bare || bare !== name.trim())
    return { error: "Name the archive by its file name alone — no directories." };
  if (!ARCHIVE.test(bare))
    return { error: `“${bare}” is not one of this app's archives. They are named ${PREFIX}YYYYMMDD-HHMMSS${SUFFIX}.` };
  const file = join(settings().dir, bare);
  if (!existsSync(file)) return { error: `There is no ${bare} in ${settings().dir}.` };
  return { file };
}

export type BackupResult = {
  ok: boolean;
  file: string | null;
  name: string | null;
  bytes: number | null;
  ms: number;
  remote: { attempted: boolean; ok: boolean | null; target: string | null; error: string | null };
  members: string[];
  skipped: string[];
  pruned: string[];
  error: string | null;
  /** Said on every successful run, because it is the fact that decides where
   *  the archive may be copied to. */
  warning: string;
};

/**
 * One backup, start to finish.
 *
 * THE ORDER IS THE POINT. The snapshot is taken first, into a staging
 * directory; then the archive is built; then — and only then — the copy is
 * sent to the remote, and only then is anything pruned. A prune that ran
 * before the new archive existed could leave a machine with no backups at all
 * on the night the tar failed.
 */
export async function runBackup(kind: "manual" | "nightly" = "manual"): Promise<BackupResult> {
  const started = Date.now();
  const at = new Date();
  const ts = at.toISOString();
  const s = settings();
  const name = `${PREFIX}${stamp(at)}${SUFFIX}`;
  const warning =
    "This archive contains vault.key in plaintext. Anywhere it is copied to is somewhere every credential on this box effectively lives.";

  const fail = (error: string, extra: Partial<BackupResult> = {}): BackupResult => {
    const ms = Date.now() - started;
    writeRun({ ts, file: null, bytes: null, ok: false, remote_ok: null, members: null, ms, kind, error });
    return {
      ok: false, file: null, name: null, bytes: null, ms,
      remote: { attempted: false, ok: null, target: s.remote, error: null },
      members: [], skipped: [], pruned: [], error, warning, ...extra,
    };
  };

  mkdirSync(s.dir, { recursive: true });
  const staging = join(DATA_DIR, `.backup-staging-${stamp(at)}`);
  mkdirSync(staging, { recursive: true });
  const snapshot = join(staging, "opc.db");

  try {
    /* Single quotes doubled, which is SQL's own escape — VACUUM INTO takes a
       string literal and not a bound parameter. */
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    return fail(
      `The database snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  writeFileSync(join(staging, "backup-manifest.json"), JSON.stringify({ version: 1, dataDir: DATA_DIR, createdAt: ts }));
  const present = MEMBERS.filter((m) => existsSync(join(DATA_DIR, m)));
  const skipped = MEMBERS.filter((m) => !present.includes(m));
  const file = join(s.dir, name);

  const tar = await run("tar", [
    "-czf", file,
    "-C", staging, "opc.db", "backup-manifest.json",
    ...(present.length ? ["-C", DATA_DIR, ...present] : []),
  ]);
  rmSync(staging, { recursive: true, force: true });

  if (tar.code !== 0 || !existsSync(file)) {
    rmSync(file, { force: true });
    return fail(`tar failed: ${tar.stderr || `exit ${tar.code}`}`, { skipped });
  }

  const bytes = statSync(file).size;
  const members = ["opc.db", ...present];

  /* The copy off this machine. A failure here does NOT fail the run: there is
     a good archive on this disk, which is a real backup, and calling the whole
     thing failed would hide it. `remote_ok` is the third state. */
  let remoteOk: boolean | null = null;
  let remoteError: string | null = null;
  if (s.remote) {
    const keyFile = s.remoteKey ? fleetKeyFor(s.remoteKey) : null;
    if (s.remoteKey && !keyFile) {
      remoteOk = false;
      remoteError = `No fleet account is labelled “${s.remoteKey}”, or it has no key of its own. rsync was not attempted rather than run with whatever key this machine happens to offer.`;
    } else {
      const ssh = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        ...(keyFile ? ["-i", keyFile, "-o", "IdentitiesOnly=yes"] : []),
      ].join(" ");
      const rsync = await run("rsync", ["-az", "--timeout=120", "-e", ssh, file, s.remote]);
      remoteOk = rsync.code === 0;
      if (!remoteOk) remoteError = rsync.stderr || `rsync exited ${rsync.code}`;
    }
  }

  /* Pruned only now, and only among this app's own archives — a directory the
     owner also keeps other things in loses nothing. */
  const pruned: string[] = [];
  for (const old of list().slice(s.keep)) {
    rmSync(old.file, { force: true });
    pruned.push(old.name);
  }

  const ms = Date.now() - started;
  writeRun({
    ts, file, bytes, ok: true, remote_ok: remoteOk,
    members: members.join(","), ms, kind,
    error: remoteError,
  });

  return {
    ok: true, file, name, bytes, ms,
    remote: { attempted: s.remote !== null, ok: remoteOk, target: s.remote, error: remoteError },
    members, skipped, pruned, error: null, warning,
  };
}

/**
 * The key file of a fleet account, by label.
 *
 * THE PATH IS ASKED FOR RATHER THAN REBUILT. It used to be spelled out here a
 * second time, which made this the one reader of that file that would silently
 * stop finding it the moment the naming changed — and it did change, because
 * the old name was shared with a plugin whose accounts are not fleet accounts
 * and whose keys were therefore deleted every half hour. This is the only
 * caller that reads the path WITHOUT writing the file first, so it is the only
 * one that would ever have noticed.
 *
 * The coupling is deliberate and stays visible: backups and fleet are two
 * integrations in one area, and this is the only thing they share — an owner
 * who already pasted a key for a box should not have to paste it again to
 * rsync to that same box.
 */
function fleetKeyFor(label: string): string | null {
  const row = db
    .prepare(
      "SELECT id FROM plugin_accounts WHERE plugin_id = 'fleet' AND lower(label) = lower(?)",
    )
    .get(label) as { id: number } | undefined;
  if (!row) return null;
  const path = keyPath("fleet", row.id);
  return existsSync(path) ? path : null;
}

/* ------------------------------------------------------------------- verify */

export type Member = { name: string; bytes: number | null; raw: string };

/**
 * What is actually inside an archive.
 *
 * `tar -tzv`, whose output differs between GNU tar and the bsdtar macOS ships,
 * so both layouts are matched and anything neither one fits is reported as its
 * raw line with a null size. Guessing a column position would be a size that
 * is silently wrong, which on a page whose whole job is "is my backup real" is
 * the worst possible answer.
 */
export async function verifyArchive(file: string): Promise<{
  ok: boolean;
  members: Member[];
  bytes: number;
  hasDatabase: boolean;
  hasVaultKey: boolean;
  error: string | null;
}> {
  const listing = await run("tar", ["-tzvf", file], 120_000);
  if (listing.code !== 0)
    return {
      ok: false, members: [], bytes: statSync(file).size,
      hasDatabase: false, hasVaultKey: false,
      error: `tar could not read it: ${listing.stderr || `exit ${listing.code}`}. The archive is damaged or truncated.`,
    };

  const gnu = /^(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.*)$/;
  const bsd = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3})\s+(\d+)\s+(\S+)\s+(.*)$/;
  const members: Member[] = [];
  for (const line of listing.stdout.split("\n")) {
    const raw = line.trimEnd();
    if (!raw) continue;
    const g = gnu.exec(raw);
    if (g) {
      members.push({ name: g[6]!, bytes: Number(g[3]), raw });
      continue;
    }
    const b = bsd.exec(raw);
    if (b) {
      members.push({ name: b[9]!, bytes: Number(b[5]), raw });
      continue;
    }
    members.push({ name: raw.split(/\s+/).at(-1) ?? raw, bytes: null, raw });
  }

  return {
    ok: true,
    members,
    bytes: statSync(file).size,
    /** The two that decide whether this archive can restore anything. */
    hasDatabase: members.some((m) => m.name === "opc.db" || m.name.endsWith("/opc.db")),
    hasVaultKey: members.some((m) => m.name === "vault.key" || m.name.endsWith("/vault.key")),
    error: null,
  };
}

/* ------------------------------------------------------------------ restore */

export type Extracted = {
  dir: string;
  members: Member[];
  hasDatabase: boolean;
  hasVaultKey: boolean;
  steps: string[];
};

/**
 * Extract an archive somewhere safe, and say what to do next.
 *
 * IT DOES NOT SWAP ANYTHING, and that is the whole design. This process is
 * holding the database file it would be replacing; overwriting it under a live
 * connection is how a restore turns one bad day into two. So the route
 * extracts, and hands back the exact commands to run with the server stopped —
 * or, better, the one command that does it: `npm run restore -- <file>`, which
 * refuses to run while this process is up.
 */
export async function extract(file: string): Promise<Extracted | { error: string }> {
  const check = await verifyArchive(file);
  if (!check.ok) return { error: check.error ?? "The archive could not be read." };

  const dir = join(DATA_DIR, `restore-${stamp()}`);
  mkdirSync(dir, { recursive: true });
  const out = await run("tar", ["-xzf", file, "-C", dir], 300_000);
  if (out.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { error: `tar could not extract it: ${out.stderr || `exit ${out.code}`}` };
  }

  return {
    dir,
    members: check.members,
    hasDatabase: check.hasDatabase,
    hasVaultKey: check.hasVaultKey,
    steps: [
      "Stop the server (Ctrl-C in the terminal running `npm run dev`, or stop the service).",
      `From the server directory: npm run restore -- ${basename(file)}`,
      "That moves the current opc.db, vault.key, keys/, shots/ and studio/ aside with a .replaced-<timestamp> suffix and puts the archive's copies in their place. Nothing is deleted.",
      "Start the server again and check /api/health, then the Integrations page — a restored vault.key is what makes the stored credentials readable again.",
      `If you would rather do it by hand, the archive is already unpacked at ${dir} — copy what you want out of it while the server is stopped, and delete that directory afterwards.`,
    ],
  };
}

/* ------------------------------------------------------------------ nightly */

/** The next moment the nightly run is due, or null when it is switched off. */
export function nextRunAt(s = settings()): string | null {
  if (!s.nightly) return null;
  const next = new Date();
  next.setMinutes(0, 0, 0);
  next.setHours(s.hour);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** Local calendar day, which is the unit "one backup a night" is counted in.
 *  An ISO instant would roll over at midnight UTC and give the owner two
 *  backups on one evening and none the next. */
function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The nightly timer.
 *
 * A ten-minute interval rather than a timeout computed to the exact hour, for
 * the reason the collector's scheduler gives: this is a laptop, it sleeps, and
 * a timer that was due at 04:00 while the lid was shut should fire at 09:10
 * rather than not at all. "Has one run today" is what stops it firing six
 * times in the hour, and it is asked of the table rather than of a variable so
 * that a restart does not forget.
 */
export function startNightly() {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      try {
        const s = settings();
        if (!s.nightly) return;
        if (new Date().getHours() !== s.hour) return;
        const today = localDay(now());
        const already = runs(10).some((r) => r.kind === "nightly" && localDay(r.ts) === today);
        if (already) return;
        const result = await runBackup("nightly");
        console.log(
          `[backups] nightly ${result.ok ? `wrote ${result.name} (${result.bytes} bytes)` : `failed — ${result.error}`}` +
            (result.remote.attempted ? `, remote ${result.remote.ok ? "ok" : `failed: ${result.remote.error}`}` : ""),
        );
      } catch (err) {
        /* Must not throw: this runs on a timer with nobody to catch it, and a
           backup failure taking the API down would be the cure killing the
           patient. */
        console.error("[backups] nightly pass failed", err);
      }
    })();
  }, 10 * 60_000);
  timer.unref?.();
}

/**
 * Called from the config registry's `after`. The plugin row is what makes the
 * settings page show it as configured; there is no credential to connect.
 *
 * IT ALSO ARMS THE TIMER, which is belt and braces rather than duplication.
 * `manifest.onStart` is the right home for it and is where it also lives — but
 * arming on save means switching the setting on at nine o'clock takes effect
 * tonight rather than after the next restart, and `startNightly` is idempotent
 * so the two callers cannot produce two timers.
 */
export function afterConfig() {
  upsertPlugin(PLUGIN, settings().nightly, null);
  startNightly();
}
