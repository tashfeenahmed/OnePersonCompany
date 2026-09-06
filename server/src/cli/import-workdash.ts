/**
 * `npm run import-workdash -- <workdash-data-dir> [--dry-run] …` — the half of a
 * migration that a route must not do.
 *
 * WHY IT IS A CLI AND NOT A BUTTON, which is the same argument cli/restore.ts
 * makes and for two of the same reasons. An import READS A DIRECTORY OFF THIS
 * MACHINE'S FILESYSTEM, and the only correct answer to "which directory may
 * this application read" is "the one somebody typed into a shell on the box" —
 * a path arriving over the network and handed to readFileSync is a file-read
 * primitive with a JSON wrapper. And it takes a DATABASE BACKUP FIRST and then
 * writes to eleven tables in one transaction, which is not work to start by
 * clicking something and then closing the tab.
 *
 * WHAT THE ROUTE DOES INSTEAD: `/api/migrate/batches` lists what happened and
 * `/api/migrate/batches/:id/rollback` undoes it. Undoing is a route because it
 * takes no path and no input a caller could invent — only a batch id this
 * database already holds.
 *
 * THE ORDER OF A REAL RUN, and it is the point:
 *
 *   1. Read the directory and PLAN. Nothing is written.
 *   2. Take a full backup, by the same code the nightly backup uses.
 *      IF THE BACKUP FAILS, THE IMPORT DOES NOT HAPPEN. An import with no way
 *      back is the one version of this that must not exist.
 *   3. Open a batch, apply everything in one transaction, close the batch.
 *
 * A DRY RUN STOPS AFTER STEP 1 and records the batch anyway, because the counts
 * it printed are what a decision was made on and a decision worth making is
 * worth being able to look up.
 *
 * NO CREDENTIAL IS EVER OPENED. The reader refuses them by name — see
 * integrations/migrate/workdash.ts — and what comes back instead is a list of
 * plugins to reconnect. That is the only correct migration path for a secret:
 * through the vault, in the UI, once, deliberately. A tar of somebody's
 * `stripe-key` in a second application's data directory is a leak with a
 * changelog entry.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DATA_DIR } from "../config.ts";
import { runBackup } from "../integrations/ops/backups.ts";
import {
  type Kind,
  KINDS,
  DEFAULT_STAGE,
  apply,
  parseKinds,
  parseVentureMap,
  plan,
} from "../integrations/migrate/importer.ts";
import { readSource } from "../integrations/migrate/workdash.ts";
import {
  batchCounts, closeBatch, newBatchId, openBatch, removeCopied, rollback,
} from "../integrations/migrate/store.ts";
import { INTERRUPTED, NOW, settleOpenRows } from "../shared/settle.ts";

const argv = process.argv.slice(2);

const VALUED = new Set(["--only", "--venture-map", "--stage", "--rollback"]);
const flags = new Map<string, string>();
const bare: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (!a.startsWith("--")) { bare.push(a); continue; }
  if (VALUED.has(a) && argv[i + 1] && !argv[i + 1]!.startsWith("--")) { flags.set(a, argv[++i]!); continue; }
  flags.set(a, "");
}
const flag = (name: string) => (flags.has(name) ? flags.get(name)! : null);

function die(message: string, hint?: string): never {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
}

if (flags.has("--help") || (!bare.length && !flags.has("--rollback"))) {
  console.log(`
  npm run import-workdash -- <workdash-data-dir> [options]
  npm run import-workdash -- --rollback <batch-id>

  Brings a WorkDash install's projects, board, chats, memories, generated
  assets, workflow state and metric history into this database.

  WorkDash's data directory is FLAT: point this at the directory that holds
  kanban.json, chats.json, agent-memory.json and the rest beside each other
  (on a Pi that is /opt/workdash), not at a parent and not at the repository.

    --dry-run              read, plan, print the counts and conflicts, write
                           nothing. Run this first, always.
    --only a,b,c           only these kinds: ${KINDS.join(", ")}
    --venture-map FILE     "workdash-slug = venture-slug" per line, or
                           "workdash-slug = skip". Comments start with #.
    --stage S              the stage new ventures get: idea, pre-launch or
                           launched. Default ${DEFAULT_STAGE} — WorkDash
                           records no stage at all, so this is a choice.
    --rollback BATCH       delete exactly what one batch inserted, and the
                           files it copied. Destructive.

  NO CREDENTIAL IS EVER READ. Files that hold secrets are refused by name and
  the plugins they belong to are printed as a reconnect list.

  A real run takes a full backup first and refuses to proceed if that fails.
  That is the SAME backup the nightly job and the Backup button take, so if a
  remote is configured it is also rsynced there — and that archive contains
  vault.key in plaintext — and the usual retention prune runs, which can drop
  the oldest nightly. If neither is wanted, clear the remote under
  Settings → Server before importing.

  Data directory: ${DATA_DIR}
`);
  process.exit(0);
}

/* ------------------------------------------------------------- rollback */

/* `--rollback` WITH NO VALUE IS ITS OWN MISTAKE and gets its own sentence.
   Testing the VALUE rather than the flag's presence let an empty one fall
   through to the import path, where the missing directory argument died with a
   raw ERR_INVALID_ARG_TYPE out of node:path — the least useful possible answer
   to somebody who just asked to undo something. */
if (flags.has("--rollback")) {
  const undo = flag("--rollback")!.trim();
  if (!undo)
    die(
      "--rollback needs the batch to undo.",
      "npm run import-workdash -- --rollback b-3k9x2p01 · GET /api/migrate/batches lists them, and so does Settings → Migration.",
    );
  const result = rollback(undo, removeCopied);
  if (!result.ok) die(result.error ?? "The rollback did not happen.");
  console.log(`\n  Rolled back ${undo}.`);
  for (const [kind, n] of Object.entries(result.deleted)) console.log(`    ${kind.padEnd(14)} ${n} deleted`);
  console.log(`    ${"files".padEnd(14)} ${result.filesRemoved} removed`);
  for (const f of result.filesKept) console.log(`    ! kept ${f.path} — ${f.why}`);
  for (const p of result.problems) console.log(`    ! ${p}`);
  console.log("\n  Rows this batch only MATCHED — a venture that was already here — were not touched.\n");
  process.exit(0);
}

/* ---------------------------------------------------------------- setup */

const dirArg = bare[0]!;
const dir = isAbsolute(dirArg) ? dirArg : resolve(process.cwd(), dirArg);
if (!existsSync(dir)) die(`There is no ${dir}.`, "WorkDash's data directory is flat — on a Pi it is /opt/workdash.");

const kinds = parseKinds(flag("--only"));
if (kinds.problems.length) die(kinds.problems.join(" "));
if (!kinds.kinds.length) die("--only named no kinds this understands.", `They are: ${KINDS.join(", ")}.`);

let ventureMap = new Map<string, string>();
const mapFile = flag("--venture-map");
if (mapFile) {
  const file = isAbsolute(mapFile) ? mapFile : resolve(process.cwd(), mapFile);
  if (!existsSync(file)) die(`There is no venture map at ${file}.`);
  const parsed = parseVentureMap(readFileSync(file, "utf8"));
  if (parsed.problems.length) die(`The venture map has problems.`, parsed.problems.join(" "));
  ventureMap = parsed.map;
}

const stage = flag("--stage") ?? DEFAULT_STAGE;
const dryRun = flags.has("--dry-run");

/* ----------------------------------------------------------- read + plan */

const source = readSource(dir);
if (!source.recognised) die(source.problems.join(" ") || `${dir} does not look like a WorkDash data directory.`);

const p = plan(source, { kinds: kinds.kinds as Kind[], stage, ventureMap });

console.log(`\n  ${dir}`);
console.log(`  ${source.present.length} state file(s) present: ${source.present.join(", ") || "none"}`);
console.log(`  ${dryRun ? "DRY RUN — nothing will be written" : "REAL RUN"} · kinds: ${kinds.kinds.join(", ")}\n`);

console.log("  kind        read  imported  skipped  conflicts");
for (const kind of kinds.kinds) {
  const c = p.counts[kind];
  if (!c) continue;
  console.log(
    `  ${kind.padEnd(10)}  ${String(c.read).padStart(4)}  ${String(c.imported).padStart(8)}  ${String(c.skipped).padStart(7)}  ${String(c.conflicts).padStart(9)}`,
  );
}

if (source.secrets.length) {
  console.log(`\n  ${source.secrets.length} credential file(s) found and NOT opened:`);
  console.log(`    ${source.secrets.join(", ")}`);
}
if (source.reconnect.length) {
  console.log(`\n  RECONNECT THESE BY HAND, in Integrations — nothing here carries a secret across:`);
  for (const plugin of source.reconnect) console.log(`    · ${plugin}`);
}

if (p.problems.length) {
  console.log(`\n  ${p.problems.length} thing(s) worth reading:`);
  for (const problem of p.problems) console.log(`    · ${problem}`);
}

/* --------------------------------------------------------------- write */

/*
  CLOSE ANY BATCH A PREVIOUS RUN LEFT OPEN, BEFORE OPENING THIS ONE.

  `migrate_batches` is the fourth ledger on this box with the crash-shaped
  hole: the row is written before the first insert and closed after the last,
  and the close cannot run if the process is killed — a Ctrl-C halfway through
  a large import is the ordinary way that happens. An open row then reads as
  "still importing", for ever, on a page whose entire job is to say what was
  carried across and whether it finished.

  IT IS DONE HERE AND NOT AT SERVER BOOT, which is where the other three areas
  settle theirs. An import runs in THIS process — the API server is a different
  one, and it restarts on every source save — so a boot settle would mark a
  live import as interrupted while it was still running. The only process that
  can safely say "no import is in flight" is the one about to start one.
*/
const settled = settleOpenRows({
  table: "migrate_batches",
  openWhen: "finished_at IS NULL",
  set: { finished_at: NOW, ok: 0 },
  note: { column: "error", text: INTERRUPTED },
});
if (settled) console.log(`\n  Closed ${settled} import(s) a previous run left open — see the batch list for what they managed.`);

const batchId = newBatchId();
openBatch({ id: batchId, source: dir, dryRun, kinds: kinds.kinds });

if (dryRun) {
  closeBatch(batchId, { ok: true, counts: p.counts, problems: p.problems, backup: null });
  console.log(`\n  Nothing was written. Recorded as ${batchId} so the counts can be looked up.`);
  console.log(`  Run it again without --dry-run to import.\n`);
  process.exit(0);
}

/* THE BACKUP IS A PRECONDITION AND NOT A COURTESY. See this file's header. */
/* THE BACKUP IS A PRECONDITION AND NOT A COURTESY, and it is the SAME backup
   the button takes — which means it also honours the configured remote and the
   retention prune. That is said in --help rather than worked around: a
   private-to-this-command archive would be an archive the owner's own restore
   tooling does not list. */
console.log("\n  Taking a backup before anything is written…");
const backup = await runBackup("manual");
if (!backup.ok) {
  closeBatch(batchId, { ok: false, counts: p.counts, problems: p.problems, backup: null, error: `the backup failed: ${backup.error}` });
  die(
    `The backup failed, so nothing was imported: ${backup.error}`,
    "An import with no way back is the one version of this that must not exist. Fix the backup and run this again.",
  );
}
console.log(`  ${backup.name} · ${Math.round((backup.bytes ?? 0) / 1024)} KB`);

let applied;
try {
  applied = apply(p, batchId, source, stage);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  closeBatch(batchId, { ok: false, counts: p.counts, problems: p.problems, backup: backup.name, error: message });
  die(`The import failed and NOTHING was written: ${message}`, `Everything was in one transaction, which was rolled back. The backup is ${backup.name}.`);
}

const created = batchCounts(batchId);
closeBatch(batchId, {
  ok: true,
  counts: p.counts,
  problems: [...p.problems, ...applied.problems],
  backup: backup.name,
});

console.log(`\n  Imported as ${batchId}.`);
for (const [kind, n] of Object.entries(created)) console.log(`    ${kind.padEnd(14)} ${n}`);
for (const problem of applied.problems) console.log(`    ! ${problem}`);
console.log(`\n  Undo the whole thing with:`);
console.log(`    npm run import-workdash -- --rollback ${batchId}`);
console.log(`  or the Rollback button under Settings → Migration.\n`);
