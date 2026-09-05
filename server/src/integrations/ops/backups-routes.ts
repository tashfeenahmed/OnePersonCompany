/**
 * /api/backups — the state of the backups, and the three buttons.
 *
 * IT IS NOT A PLUGIN AND HAS NO SKILL. Nothing here measures a business, so
 * there is nothing for an agent to quote; and an agent that could run
 * `POST /api/backups/restore` could put yesterday's database over today's on
 * its own initiative. The settings live under a pseudo-plugin id so they can
 * use the same closed, checked settings registry every other setting uses —
 * see routes/pluginConfig.ts on why that registry is closed.
 *
 * RESTORE IS DELIBERATELY TWO HALVES. This route extracts and explains; the
 * CLI swaps. A route that overwrote the database file this process has open
 * would be a route that corrupts it, and one that could do so from the LAN is
 * worse — so the destructive half needs a shell on the machine and refuses to
 * run while the server is up.
 */
import { Hono } from "hono";
import { existsSync } from "node:fs";
import {
  archivePath,
  extract,
  list,
  nextRunAt,
  runBackup,
  runs,
  settings,
  verifyArchive,
  DEFAULT_HOUR,
  DEFAULT_KEEP,
  MEMBERS,
} from "./backups.ts";

export const backupRoutes = new Hono();

/** One backup can take a while and two at once would fight over the staging
 *  directory and the prune. The second caller is told so rather than queued —
 *  a queued backup is a button that appears to do nothing. */
let running = false;

backupRoutes.get("/", (c) => {
  const s = settings();
  const archives = list();
  return c.json({
    settings: {
      dir: s.dir,
      dirExists: existsSync(s.dir),
      remote: s.remote,
      remoteKey: s.remoteKey,
      keep: s.keep,
      hour: s.hour,
      nightly: s.nightly,
      defaults: { keep: DEFAULT_KEEP, hour: DEFAULT_HOUR },
    },
    nextRunAt: nextRunAt(s),
    contents: {
      always: ["opc.db (a VACUUM INTO snapshot, consistent as of the moment it was taken)"],
      whenPresent: MEMBERS,
      never: [
        "The managed SearXNG, freellmapi and agent installs — hundreds of megabytes that reinstall themselves from a URL.",
      ],
      warning:
        "The archive contains vault.key in plaintext, because ciphertext without it restores nothing. Anywhere it is copied to is somewhere every credential on this box effectively lives.",
    },
    archives,
    totalBytes: archives.reduce((n, a) => n + a.bytes, 0),
    runs: runs(20).map((r) => ({
      ts: r.ts,
      kind: r.kind,
      ok: r.ok === 1,
      file: r.file,
      bytes: r.bytes,
      ms: r.ms,
      members: r.members ? r.members.split(",") : null,
      /** null = no remote configured, true = the copy left, false = it did
       *  not. A local archive is still a real backup. */
      remoteOk: r.remote_ok === null ? null : r.remote_ok === 1,
      error: r.error,
    })),
    summary: {
      archives: archives.length,
      newest: archives[0] ?? null,
      oldest: archives.at(-1) ?? null,
      lastRunAt: runs(1)[0]?.ts ?? null,
      lastOkAt: runs(50).find((r) => r.ok === 1)?.ts ?? null,
      /** The question this page exists to answer, said as a sentence. */
      state: archives.length
        ? runs(1)[0]?.ok === 1
          ? "The last run wrote an archive."
          : "There are archives, but the last run failed — see runs[0].error."
        : "No archive has ever been written on this machine.",
    },
  });
});

backupRoutes.post("/run", async (c) => {
  if (running) return c.json({ error: "A backup is already running." }, 409);
  running = true;
  try {
    const result = await runBackup("manual");
    return c.json(result, result.ok ? 200 : 500);
  } finally {
    running = false;
  }
});

backupRoutes.post("/verify", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { file?: string } | null;
  if (!body?.file) return c.json({ error: "Expected { file: \"opc-…tar.gz\" }." }, 400);
  const found = archivePath(body.file);
  if ("error" in found) return c.json({ error: found.error }, 400);

  const checked = await verifyArchive(found.file);
  return c.json(
    {
      file: found.file,
      ...checked,
      /** The two facts that decide whether this archive is worth anything, as
       *  a sentence rather than as two booleans a reader has to combine. */
      state: !checked.ok
        ? "Unreadable — this archive cannot restore anything."
        : checked.hasDatabase && checked.hasVaultKey
          ? "Readable, with the database and the vault key. This can restore the box."
          : checked.hasDatabase
            ? "Readable, with the database but NO vault key — every stored credential would restore as unreadable ciphertext."
            : "Readable, but it has no database in it.",
    },
    checked.ok ? 200 : 422,
  );
});

backupRoutes.post("/restore", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { file?: string } | null;
  if (!body?.file) return c.json({ error: "Expected { file: \"opc-…tar.gz\" }." }, 400);
  const found = archivePath(body.file);
  if ("error" in found) return c.json({ error: found.error }, 400);

  const out = await extract(found.file);
  if ("error" in out) return c.json(out, 422);

  return c.json({
    file: found.file,
    extractedTo: out.dir,
    members: out.members,
    hasDatabase: out.hasDatabase,
    hasVaultKey: out.hasVaultKey,
    /** Nothing has been replaced. Said first because it is what a person
     *  pressing "restore" will assume happened. */
    swapped: false,
    note:
      "Nothing has been replaced. This process is holding the database it would be overwriting, so the swap is a separate, offline step.",
    steps: out.steps,
  });
});
