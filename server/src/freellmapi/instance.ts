/**
 * THE MANAGED FREELLMAPI INSTANCE: cloned by this process, built by this
 * process, run by this process, and connected to without anybody pasting
 * anything.
 *
 * WHY THIS EXISTS WHEN THE PLUGIN ALREADY WORKED. The hosted account points at
 * an instance on the owner's Hetzner box, which is a second machine, a public
 * hostname carrying that box's IP, and a service that can be down. None of
 * those is FreeLLMAPI — the gateway itself is a Node server with a SQLite file
 * beside it, and there is nothing about routing to free providers that needs
 * to happen somewhere else. Run here, the box can be rebooted mid-conversation
 * and the words keep coming.
 *
 * WHY A CHILD PROCESS AND NOT DOCKER. The project ships a one-line Docker
 * install (`curl -fsSL https://freellmapi.co/install.sh | bash`) and it is the
 * documented happy path — but there is no Docker on this machine, so the
 * choice was source-into-a-checkout or nothing. That is the better shape here
 * anyway: what gets installed is a git checkout at a COMMIT THIS FILE RECORDS,
 * and "which FreeLLMAPI is running" is answerable by reading `installed.json`
 * rather than by trusting a tag that moves.
 *
 * WHY IT LIVES IN THE API PROCESS — the argument searxng/instance.ts and
 * telegram/poller.ts both make, landing in the same place: a second service
 * would need the database, the plugin config and the vault to do its job,
 * which is to say it would be this process under another name. The difference
 * from the poller is that this manages a CHILD PROCESS, and a child process is
 * a thing that can be orphaned — so the lower half of this file is about
 * making sure it is not. Every exit path sends SIGTERM and then SIGKILL, the
 * pid is written down before the child is adopted, and boot reaps a pid left
 * behind by a `kill -9` that never got to run any of that.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *
 * THE KEY IS MINTED HEADLESSLY, AND FINDING THAT OUT WAS THE WHOLE QUESTION.
 *
 * The documented route to a `freellmapi-…` key is "open the dashboard, go to
 * Keys, copy it", which no process can do. It turns out not to be where the
 * key comes from. Reading the repo at commit 1edb8d5: the unified key is
 * INSERTED BY THE BASELINE MIGRATION the first time the database is created —
 * `freellmapi-` plus 24 random bytes as hex — into `settings.unified_api_key`,
 * in plaintext, before any account exists. The dashboard's Keys page reads
 * that row; it does not create it.
 *
 * So the install runs the migration itself (`npm run db:migration:up -w
 * server`, pointed at a database inside DATA_DIR by `FREEAPI_DB_PATH`) and
 * then reads one row out of the resulting file with `node:sqlite`, which this
 * runtime already has for its own database. No account, no browser, no log
 * scraping, and nothing on port 5173 at any point.
 *
 * TWO ROUTES WERE REJECTED AND THE REASONS ARE WORTH KEEPING:
 *
 *   THE HTTP ROUTE WORKS AND IS WORSE. `POST /api/auth/setup` is open without
 *   a setup code from a LOOPBACK socket, so this process could claim the
 *   dashboard with an invented email and password and then read the key from
 *   `GET /api/settings/api-key`. It also permanently claims the owner's
 *   dashboard with a password only this process knows — locking them out of
 *   the page where provider keys are added, to obtain a value that was
 *   already sitting in a file. The owner claims it themselves, from a browser
 *   on this machine, with no code needed; the panel says so.
 *
 *   SCRAPING THE BOOT LOG WORKS AND IS WORSE. The migration writes the key
 *   straight to stdout, deliberately bypassing the gateway's own log
 *   redaction. Parsing that would make the key's arrival depend on a log
 *   format. Worse, it is a reason the key ends up in a log at all — see
 *   `scrub()` below, which exists precisely because that line goes past this
 *   process on its way to the tail the panel draws.
 *
 * WHAT THIS WILL NEVER DO. It does not run as root, it writes nothing outside
 * `DATA_DIR/freellmapi/`, it binds the instance to 127.0.0.1 and no flag here
 * can change that, and it never logs, returns or passes as an argument the key
 * it mints — that value goes from a SQLite row into the vault and nowhere
 * else.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import * as accounts from "../accounts.ts";
import { configValue, getPlugin, setConfig, upsertPlugin } from "../db.ts";
import {
  FIELDS,
  LOCAL_LABEL,
  LOCAL_PORT,
  LOCAL_URL,
  PLUGIN,
  SECRET_STEM,
  setLocalHealth,
} from "../providers/freellmapi.ts";

/* ------------------------------------------------------------------ layout */

/** Everything this manages, and the one directory it is allowed to write in. */
export const ROOT = join(DATA_DIR, "freellmapi");
const SRC = join(ROOT, "src");
/**
 * The gateway's own state, kept under our root rather than in its checkout.
 *
 * `FREEAPI_DB_PATH` names a FILE and not a directory — the repo resolves it
 * with `path.resolve` and creates the parent — and the encryption key it
 * generates on first run is written as `.encryption-key` NEXT TO the database
 * rather than inside it. So pointing the database here puts both under a
 * directory this file owns, and a reinstall of the checkout does not throw
 * away the provider keys the owner added to it.
 */
const DATA = join(ROOT, "data");
const DB_FILE = join(DATA, "freeapi.db");
const LOGS = join(ROOT, "logs");
const INSTALL_LOG = join(LOGS, "install.log");
const RUN_LOG = join(LOGS, "freellmapi.log");
/** The marker that says an install FINISHED. Its presence is the difference
 *  between `installed` and a half-cloned directory, which is why it is written
 *  last and deleted first. */
const MARKER = join(ROOT, "installed.json");
/** Written the moment a child is spawned, removed when it exits cleanly. It
 *  exists for exactly one case: `kill -9` on the API, which runs none of the
 *  shutdown code below. See `reapOrphan()`. */
const PIDFILE = join(ROOT, "freellmapi.pid");

const REPO = "https://github.com/tashfeenahmed/freellmapi";

/** The gateway's own `engines` field, checked before a clone rather than after
 *  a four-minute build. `>=20.18.0 <25.0.0` at commit 1edb8d5 — Node 25 is
 *  refused BY THE PACKAGE, so finding out at `npm ci` would be a wasted
 *  clone and a confusing error about a dependency. */
const NODE_MIN = [20, 18, 0];
const NODE_MAX_EXCLUSIVE = 25;

/* ------------------------------------------------------------------- state */

export type InstanceState =
  | "absent"
  | "installing"
  | "installed"
  | "starting"
  | "running"
  | "stopped"
  | "failed";

type Installed = {
  /** The exact commit that was cloned. A tag or a branch would answer "which
   *  FreeLLMAPI is this" with a name that means something different next week. */
  commit: string;
  installedAt: string;
  nodePath: string;
  nodeVersion: string;
  /** Whether the dashboard bundle was built. The API does not need it; a
   *  person who wants to add provider keys does, so its absence is a fact the
   *  panel states rather than a failure. */
  dashboard: boolean;
  /** How long the whole install took, in seconds. The honest answer to "how
   *  long does this take" is a measurement and not a promise. */
  seconds: number;
  /** Whether the two anonymous providers have been switched on. Written once,
   *  after the first healthy start — see SEED below for why once and not
   *  every boot. Absent on a marker written before this existed, which reads
   *  as false and seeds on the next start. */
  seeded?: boolean;
};

/**
 * THE ONE THING A FRESH GATEWAY CANNOT DO, AND THE SMALLEST HONEST FIX.
 *
 * A gateway installed and started with nothing in it routes to nothing. Its
 * catalog is real — 247 models on this machine's first boot — but every
 * candidate answers `no enabled+healthy key for platform`, because a model is
 * only reachable through a provider the owner has given a key for, and a fresh
 * database has none. So "install here" would end with a running process, a
 * connected account, and a completion that fails in a paragraph. That is worse
 * than not offering the button.
 *
 * TWO OF THE PROVIDERS NEED NO KEY. Kilo's gateway serves its `:free` routes
 * anonymously (rate-limited by IP), and OVH's AI Endpoints have an anonymous
 * tier; the repo registers both `keyless: true`, which means the adapter sends
 * no Authorization header at all and the "key" is a sentinel row saying the
 * provider is switched on. Turning those two on costs nothing, exposes
 * nothing, and is the difference between an install that can answer and one
 * that cannot.
 *
 * IT IS APPLIED ON THE FIRST START AND NEVER AGAIN, and that is the whole
 * reason it is not simply an environment variable left in place. The gateway
 * applies `FREEAPI_CONFIG_JSON` idempotently on EVERY boot and its own
 * upsert reads a missing `enabled` as ENABLED — so a config left in the
 * environment would silently switch these two back on every time the owner
 * turned them off. Seeding once and recording it on the marker means the
 * dashboard's own switches are the last word from then on.
 *
 * NOTHING ELSE IS SEEDED. No routing strategy, no model list, no fallback
 * order: those are opinions about somebody else's gateway, and the two rows
 * here are the minimum that makes the button honest.
 */
const SEED = JSON.stringify({ keys: [{ platform: "kilo" }, { platform: "ovh" }] });

/** The last N lines of whatever the install or the instance said. In memory,
 *  because it is a progress indicator rather than a record — the files under
 *  `logs/` are the record. */
const TAIL_MAX = 160;

let state: InstanceState = "absent";
let since = new Date().toISOString();
let step: string | null = null;
let lastError: string | null = null;
let installed: Installed | null = null;
let child: ChildProcess | null = null;
let healthyAt: string | null = null;
let restarts = 0;
/** Consecutive spawn attempts that never reached health. The restart loop is
 *  infinite for an instance that HAS worked and capped for one that never did:
 *  a broken install restarted forever is a fork bomb with a progress bar. */
let failedStarts = 0;
/** What the owner asked for, as opposed to what is happening. Every restart
 *  decision reads this, and `stop()` clearing it is what makes a deliberate
 *  stop different from a crash. */
let wanted = false;
let tail: string[] = [];
/** Single-flight guards. An install and a start are both idempotent by refusal
 *  rather than by queueing — two clones into one directory is not a race worth
 *  winning. */
let installing: Promise<void> | null = null;
let starting = false;

function setState(next: InstanceState, why?: string | null) {
  if (state !== next) {
    state = next;
    since = new Date().toISOString();
  }
  if (why !== undefined) lastError = why;
}

/**
 * Take any key out of a line before it is written down.
 *
 * NOT DEFENSIVE PROGRAMMING — A KNOWN, DELIBERATE DISCLOSURE. The gateway's
 * baseline migration prints `Your unified API key: freellmapi-…` to stdout the
 * first time its database is created, on purpose and past its own redaction,
 * because for a person installing it by hand that line IS the delivery
 * mechanism. Here it arrives on the install's stdout pipe on its way to a log
 * file and a panel, which is exactly the place this codebase says a credential
 * never goes. The pattern is the gateway's own (`lib/log-redaction.ts`), plus
 * the `sk-cp-` per-client keys it can also mint.
 *
 * The whole line is replaced rather than the value alone, because "Your
 * unified API key: [redacted]" in a panel invites somebody to go looking for
 * it in the file underneath.
 */
export function scrub(line: string): string {
  if (/freellmapi-[0-9a-f]{8,}|sk-cp-[0-9a-f]{8,}/i.test(line))
    return "  [a key was printed here and has been redacted — it went straight to the vault]";
  return line;
}

function log(line: string, file = RUN_LOG) {
  const stamped = `${new Date().toISOString()} ${scrub(line)}`;
  tail.push(stamped);
  if (tail.length > TAIL_MAX) tail = tail.slice(-TAIL_MAX);
  try {
    mkdirSync(LOGS, { recursive: true });
    appendFileSync(file, `${stamped}\n`);
  } catch {
    /* A log that cannot be written must not take the instance down with it. */
  }
}

/* -------------------------------------------------------------- the toolbox */

/**
 * The Node that runs the gateway, which is deliberately the one running this.
 *
 * `process.execPath` rather than "whatever node is on the PATH". This process
 * is started by a terminal, a launcher or a service manager, and only one of
 * those reliably has the same PATH the owner has — a version manager makes
 * "node" mean different things in different shells. The interpreter running
 * this file is a version we can name in the marker and check against the
 * gateway's `engines` before anything is cloned.
 */
const NODE = process.execPath;

/** npm lives beside node in every layout this has to work in — a version
 *  manager's versioned directory, Homebrew's bin, a system install. The PATH
 *  is the fallback rather than the first answer, for the reason above. */
function findNpm(): string | null {
  const candidates = [
    process.env.OPC_NPM,
    join(dirname(NODE), "npm"),
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "npm")),
  ];
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

function findGit(): string | null {
  for (const candidate of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"])
    if (existsSync(candidate)) return candidate;
  return null;
}

/** Is the interpreter above inside the range the gateway's package.json
 *  declares? Returns null when it is, or the sentence when it is not. */
function nodeOutOfRange(): string | null {
  const parts = process.versions.node.split(".").map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;
  if (major >= NODE_MAX_EXCLUSIVE)
    return (
      `FreeLLMAPI declares engines ">=20.18.0 <25.0.0" and this API is running on ` +
      `Node ${process.versions.node}. The install would be refused by npm, so it is ` +
      `refused here instead — run the dashboard on Node 24 or older.`
    );
  const [minMajor, minMinor, minPatch] = NODE_MIN as [number, number, number];
  const older =
    major < minMajor ||
    (major === minMajor && minor < minMinor) ||
    (major === minMajor && minor === minMinor && patch < minPatch);
  if (older)
    return (
      `FreeLLMAPI needs Node 20.18 or newer and this API is running on ` +
      `Node ${process.versions.node}.`
    );
  return null;
}

/**
 * The environment a child gets, which is deliberately not this process's.
 *
 * A build and a server need a PATH, a HOME (npm keeps its cache under it) and
 * a UTF-8 locale. Everything else is named explicitly below. Nothing else is
 * passed through: the API process holds environment variables that are none of
 * a model gateway's business — and one of them, `PORT`, would otherwise make
 * the gateway try to bind 8787.
 */
function childEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
    HOME: process.env.HOME ?? homedir(),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

/**
 * The settings the gateway is run and built under, in one place.
 *
 * `HOST` IS THE LOAD-BEARING ONE. The gateway binds `::` by default — every
 * interface, dual stack — which for a service guarded by a single bearer token
 * on a laptop that joins café wifi is not a default anybody chose. `127.0.0.1`
 * makes the bind the auth, the way it is for this API itself, and it is set
 * here rather than in a file so that nothing the owner edits can widen it by
 * accident.
 *
 * `NODE_ENV` IS DELIBERATELY UNSET. With it at `production` the gateway
 * refuses to start without an `ENCRYPTION_KEY`; with it at `development` it
 * refuses to run its own migrations and tells a human to run them. Unset is
 * the one value that self-migrates and generates its own encryption key into
 * `.encryption-key` beside the database, which is what an install nobody is
 * watching needs.
 */
function gatewayEnv(): Record<string, string> {
  return {
    ...childEnv(),
    PORT: String(LOCAL_PORT),
    HOST: "127.0.0.1",
    FREEAPI_DB_PATH: DB_FILE,
    CLIENT_DIST: join(SRC, "client", "dist"),
  };
}

/**
 * Run one command to completion, with everything it says going to the tail.
 *
 * Streamed rather than buffered because these steps take minutes and a
 * progress bar with no progress in it is the whole reason the install is a
 * background job. Nothing here interpolates a secret into a command line — but
 * output is scrubbed on the way out, because one of these commands PRINTS one.
 */
function run(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    log(`$ ${command} ${args.join(" ")}`, INSTALL_LOG);
    const proc = spawn(command, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...childEnv(), ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const take = (buf: Buffer) => {
      const text = buf.toString();
      out += text;
      for (const line of text.split("\n")) if (line.trim()) log(line.trimEnd(), INSTALL_LOG);
    };
    proc.stdout?.on("data", take);
    proc.stderr?.on("data", take);
    proc.on("error", (err) => {
      log(`! ${err.message}`, INSTALL_LOG);
      resolve({ code: -1, out: `${out}\n${err.message}` });
    });
    proc.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

/* ------------------------------------------------------------------- install */

/** What is on disk, or null. Read at import and after every install. */
function readMarker(): Installed | null {
  try {
    const doc = JSON.parse(readFileSync(MARKER, "utf8")) as Installed;
    return doc.commit ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Install FreeLLMAPI into `DATA_DIR/freellmapi/`.
 *
 * LONG-RUNNING AND THEREFORE NOT A REQUEST. A clone plus an 800-package
 * install plus two TypeScript builds plus a Vite build is minutes, and a route
 * that waits for it is a route that times out in a proxy somewhere and leaves
 * the owner with no idea whether it worked. So this returns immediately and
 * the state — with the STEP and the last lines of output — is polled from
 * `GET /api/freellmapi`.
 *
 * IT REFUSES RATHER THAN REPAIRS. Already installed, already installing, or
 * running as root are refusals with a sentence; there is no "clean up and try
 * again" path, because the thing it would clean up might be a working install
 * somebody asked for twice.
 */
export function install(): { ok: boolean; error?: string } {
  if (installing) return { ok: false, error: "An install is already running." };
  if (installed)
    return {
      ok: false,
      error:
        `FreeLLMAPI is already installed here (commit ${installed.commit.slice(0, 12)}). ` +
        `Remove ${ROOT} by hand to install it again — this never deletes a directory it did not just create.`,
    };
  if (process.getuid?.() === 0)
    return {
      ok: false,
      error:
        "Refusing to install as root. This clones a repository and runs its build; " +
        "nothing about that needs the machine's own privileges.",
    };
  const bad = nodeOutOfRange();
  if (bad) return { ok: false, error: bad };
  const npm = findNpm();
  if (!npm)
    return {
      ok: false,
      error:
        "npm is not where this can see it. It ships with Node, so this usually means " +
        "the API is running under a Node that was installed without it.",
    };
  const git = findGit();
  if (!git)
    return { ok: false, error: "git is not installed, so there is nothing to clone with." };

  installing = doInstall(npm, git).finally(() => {
    installing = null;
  });
  return { ok: true };
}

async function doInstall(npm: string, git: string) {
  const started = Date.now();
  setState("installing", null);
  tail = [];
  mkdirSync(LOGS, { recursive: true });
  mkdirSync(DATA, { recursive: true });
  log(`installing FreeLLMAPI into ${ROOT}`, INSTALL_LOG);

  const fail = (why: string) => {
    log(`! ${why}`, INSTALL_LOG);
    step = null;
    setState("failed", why);
  };

  try {
    /* ---- the checkout. Shallow, because the history of a gateway is not
       something this box has any use for — and then immediately asked which
       commit that shallow clone landed on, because "the tip of main on the day
       you clicked" is only a version if it is written down. */
    step = "cloning freellmapi";
    if (!existsSync(join(SRC, ".git"))) {
      rmSync(SRC, { recursive: true, force: true });
      const clone = await run(git, ["clone", "--depth", "1", REPO, SRC]);
      if (clone.code !== 0) return fail("git clone failed — see the log below.");
    }
    const rev = await run(git, ["-C", SRC, "rev-parse", "HEAD"]);
    const commit = rev.out.trim().split("\n").pop()?.trim() ?? "";
    if (!/^[0-9a-f]{40}$/.test(commit))
      return fail("The clone produced no commit id, so there is nothing to pin to.");
    log(`pinned to ${commit}`, INSTALL_LOG);

    /* ---- the dependencies. `npm ci` and not `npm install`, because a lock
       file is the other half of pinning a commit: the same checkout resolved
       against today's registry is not the same program. It is run at the repo
       ROOT rather than per package — this is an npm workspace, and installing
       inside `server/` produces a tree that cannot see `@freellmapi/shared`. */
    step = "installing dependencies (npm ci)";
    const deps = await run(npm, ["ci", "--no-audit", "--no-fund"], { cwd: SRC });
    if (deps.code !== 0)
      return fail(
        "npm ci failed. better-sqlite3 is the one compiled dependency — if its " +
          "prebuilt binary could not be fetched, the log names what it wanted to " +
          "build with instead.",
      );

    /*
      better-sqlite3 arrives as a PREBUILT binary and is an OPTIONAL dependency,
      which is a bad combination to find out about at runtime: npm reports
      success, the gateway starts, and the first database call fails. Checked
      here, where the sentence can name the fix, rather than in a health probe
      that would say only that the instance keeps exiting.
    */
    const nativeSqlite = join(
      SRC,
      "node_modules",
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    if (!existsSync(nativeSqlite))
      return fail(
        "npm ci finished but better-sqlite3 has no compiled binary. It is an optional " +
          "dependency whose install script fetches a prebuilt one; if npm is configured " +
          "to block install scripts, allow them for this package and install again.",
      );

    /* ---- the server build. `tsc`, into `server/dist/`, which is what the
       production run executes. `npm run dev` was the alternative and is the
       wrong thing for a service: it runs the TypeScript through a watcher that
       holds a compiler in memory for edits nobody is making, and it is one
       more process between this file and the thing holding the port. */
    step = "building the gateway";
    const buildServer = await run(npm, ["run", "build", "-w", "server"], { cwd: SRC });
    if (buildServer.code !== 0) return fail("Building the gateway failed — see the log below.");

    /*
      ---- the dashboard, and its failure is NOT the install's failure.

      The API does not need it: `/v1` and `/api` are served by the same process
      whether or not `client/dist` exists, and an absent directory is an
      express.static that matches nothing. What needs it is a person — the
      Keys page is where provider keys are added, and without those the
      gateway's catalog is only the handful of providers that work anonymously.
      So it is built, and if the Vite build fails the install still succeeds
      with `dashboard: false` on the marker and a sentence on the panel. A
      broken web bundle must not cost a working model provider.
    */
    step = "building the dashboard";
    const buildClient = await run(npm, ["run", "build", "-w", "client"], { cwd: SRC });
    const dashboard = buildClient.code === 0;
    if (!dashboard)
      log("! the dashboard bundle failed to build — the API is unaffected", INSTALL_LOG);

    /*
      ---- the database, created HERE rather than on first boot.

      This is what mints the key. The baseline migration inserts
      `settings.unified_api_key` the first time the schema is created, so
      running the migration is the whole of "provision a credential" — and
      doing it now, in the install, means the account can be connected before
      the instance has ever been started. It is idempotent: a database that
      already exists is migrated forward and keeps the key it has.
    */
    step = "creating the database";
    const migrate = await run(npm, ["run", "db:migration:up", "-w", "server"], {
      cwd: SRC,
      env: gatewayEnv(),
    });
    if (migrate.code !== 0)
      return fail("Creating the gateway's database failed — see the log below.");
    if (!existsSync(DB_FILE))
      return fail(
        `The migration reported success and there is no database at ${DB_FILE}. ` +
          `Nothing can be read out of it, so the install is not finished.`,
      );

    const marker: Installed = {
      commit,
      installedAt: new Date().toISOString(),
      nodePath: NODE,
      nodeVersion: process.versions.node,
      dashboard,
      seconds: Math.round((Date.now() - started) / 1000),
      seeded: false,
    };
    writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);
    installed = marker;
    step = null;
    setState("installed", null);
    log(
      `installed in ${marker.seconds}s · commit ${commit} · node ${marker.nodeVersion}` +
        `${dashboard ? "" : " · dashboard NOT built"}`,
      INSTALL_LOG,
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/* --------------------------------------------------------------- the key */

/**
 * The unified key this install minted, read out of its own database.
 *
 * ONE ROW, READ-ONLY, WITH `node:sqlite` — the reader this runtime already
 * ships for its own database, so there is no second SQLite dependency and no
 * compiled binary in this process. The gateway stores this value in plaintext
 * (its own README says so; the per-client `sk-cp-` keys beside it are hashed),
 * which is what makes reading it possible at all.
 *
 * IT IS RETURNED TO ONE CALLER AND NEVER LOGGED. `autoConnect` takes it
 * straight into `accounts.writeCredentials`, which seals it. It is not in the
 * report, not in the tail, and not in a route's response.
 */
function readUnifiedKey(): { ok: true; key: string } | { ok: false; error: string } {
  if (!existsSync(DB_FILE))
    return {
      ok: false,
      error: `There is no gateway database at ${DB_FILE} yet, so no key has been minted.`,
    };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(DB_FILE, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'unified_api_key'")
      .get() as { value?: unknown } | undefined;
    const key = typeof row?.value === "string" ? row.value.trim() : "";
    if (!key)
      return {
        ok: false,
        error:
          "The gateway's database has no unified key in it. That row is written by its " +
          "baseline migration, so this is a database created by something else.",
      };
    return { ok: true, key };
  } catch (err) {
    return {
      ok: false,
      error: `Could not read the gateway's database: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  } finally {
    db?.close();
  }
}

/** Is there a key to be had? Answered without returning it, for the panel. */
export function hasKey(): boolean {
  return readUnifiedKey().ok;
}

/* ------------------------------------------------------------------ the port */

/**
 * Is something already listening on the instance's port?
 *
 * A CONNECT RATHER THAN A BIND. Trying to bind would tell us the same thing
 * and would, for the length of the check, be the thing holding the port.
 */
function portBusy(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: LOCAL_PORT });
    const done = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Is it up?
 *
 * `/livez` AND NOT `/v1/models`, and the difference is authentication.
 * `/v1/models` is the right probe for a CREDENTIAL — it is what `verify` uses,
 * and a 401 there is the whole reason a wrong key is caught at the form. It is
 * the wrong probe for LIVENESS: this question is asked every second of a
 * start, before a key has necessarily been read, and answering it would mean
 * decrypting a secret on a timer. `/livez` needs no key, is documented as the
 * readiness endpoint, and answers before the catalog has synced — which is
 * exactly what "is it up yet" means during a start.
 */
async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/livez`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- the process */

/**
 * Start the instance.
 *
 * The singleton guard is `child`, and every path that could spawn one goes
 * through here — the route, the crash restarter and the boot resumer. Two
 * gateways would not both start: the second loses the bind and dies, and the
 * owner would be left reading a log about a port from a button that said
 * "start".
 */
export async function start(): Promise<{ ok: boolean; error?: string }> {
  if (!installed) return { ok: false, error: "FreeLLMAPI is not installed here yet." };
  if (child) return { ok: true };
  if (starting) return { ok: true };

  starting = true;
  try {
    /*
      SOMEBODY ELSE ON THE PORT IS ITS OWN SENTENCE. It is the ordinary way
      this fails — a second copy of the dashboard, a gateway started by hand, an
      unrelated service on 3001 — and "the child exited immediately" is a
      terrible way to learn it. The one case that is ours is an orphan from a
      `kill -9`, and that is reaped rather than reported.
    */
    if (await portBusy()) {
      if (!reapOrphan()) {
        const why =
          `Something is already listening on 127.0.0.1:${LOCAL_PORT}. That is either another ` +
          `copy of this instance or an unrelated service — this will not take a port it did not open.`;
        setState("failed", why);
        log(`! ${why}`);
        return { ok: false, error: why };
      }
      /* The orphan was ours and has been killed; give the port a moment to
         come back before spawning into it. */
      await new Promise((r) => setTimeout(r, 500));
    }

    wanted = true;
    setConfig(PLUGIN, "instance", "running");
    spawnChild();
    return { ok: true };
  } finally {
    starting = false;
  }
}

function spawnChild() {
  setState("starting", null);
  const entry = join(SRC, "server", "dist", "index.js");
  log(`starting: node ${entry}`);

  /*
    NODE DIRECTLY, NOT `npm start`. `npm run start -w server` would work and
    would put an npm process between this file and the thing holding the port:
    SIGTERM would land on npm, which is not what closes the listener, and the
    grandchild would be the orphan this whole file exists to prevent. Spawning
    the interpreter means the process we signal is the process that is
    listening.
  */
  /* The seed rides along on the FIRST start only. See SEED above: leaving it
     in the environment would re-enable two providers every boot, including the
     boot after the owner deliberately turned them off. */
  const seeding = installed !== null && installed.seeded !== true;
  if (seeding) log("first start — switching on the two providers that need no key");

  const proc = spawn(NODE, [entry], {
    cwd: SRC,
    env: { ...gatewayEnv(), ...(seeding ? { FREEAPI_CONFIG_JSON: SEED } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  try {
    writeFileSync(PIDFILE, String(proc.pid ?? ""));
  } catch {
    /* Not fatal: the pid file is a belt for the `kill -9` case, and the
       braces — SIGTERM on every ordinary exit path — are elsewhere. */
  }

  const take = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) log(line.trimEnd());
  };
  proc.stdout?.on("data", take);
  proc.stderr?.on("data", take);

  proc.on("error", (err) => {
    log(`! ${err.message}`);
    setState("failed", err.message);
  });

  proc.on("exit", (code, signal) => {
    if (child !== proc) return; // already replaced; this is an old one exiting
    child = null;
    healthyAt = null;
    try {
      unlinkSync(PIDFILE);
    } catch {
      /* already gone */
    }
    const how = signal ? `signal ${signal}` : `code ${code}`;
    log(`exited (${how})`);

    if (!wanted) {
      setState("stopped", null);
      return;
    }

    /*
      A CRASH IS RESTARTED; A BROKEN INSTALL IS NOT RESTARTED FOREVER. An
      instance that has been healthy and then died is a thing to bring back —
      that is what a supervisor is for. One that has never come up is failing
      for a reason that will not change on the fifth attempt.
    */
    failedStarts += 1;
    if (failedStarts >= 5) {
      wanted = false;
      const why =
        `FreeLLMAPI exited ${failedStarts} times without ever answering /livez (${how}). ` +
        `The log below is the last thing it said.`;
      setState("failed", why);
      log(`! ${why}`);
      return;
    }
    const wait = Math.min(1000 * 2 ** (failedStarts - 1), 60_000);
    setState("starting", `Exited with ${how}; restarting in ${Math.round(wait / 1000)}s.`);
    restarts += 1;
    const timer = setTimeout(() => {
      if (wanted && !child) spawnChild();
    }, wait);
    timer.unref();
  });

  void waitForHealth(proc);
}

/**
 * Poll until it answers, and connect the account the first time it does.
 *
 * Tied to the process it was spawned for, so a health check outstanding when a
 * crash restarts the instance cannot mark the NEW process healthy on the
 * strength of the old one's port.
 */
async function waitForHealth(proc: ChildProcess) {
  const deadline = Date.now() + 120_000;
  while (child === proc && Date.now() < deadline) {
    if (await healthy()) {
      healthyAt = new Date().toISOString();
      failedStarts = 0;
      setState("running", null);
      log(`healthy on ${LOCAL_URL}`);
      /* Recorded only now, and only on a start that actually came up: a seed
         applied by a process that then died is a seed nothing can vouch for,
         and the next start should try it again. */
      if (installed && installed.seeded !== true) {
        installed = { ...installed, seeded: true };
        try {
          writeFileSync(MARKER, `${JSON.stringify(installed, null, 2)}\n`);
        } catch {
          /* The instance is up and connected; a marker that could not be
             rewritten costs one redundant seed on the next start. */
        }
      }
      autoConnect();
      return;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  if (child === proc && state === "starting")
    /* Still alive and still not answering. Not killed: a first boot that syncs
       a model catalog is a real thing, and the state says what is true rather
       than deciding for the owner. */
    setState("starting", "Started, but /livez has not answered yet.");
}

/**
 * Stop it, and mean it.
 *
 * SIGTERM first, because the gateway closes its listener on it and a killed
 * process leaves the port in a state the next start has to wait out. SIGKILL
 * after the grace, because a shutdown that can be refused is not a shutdown —
 * and the one thing this file must never do is leave a child holding 3001
 * after the API that owns it has gone.
 */
export async function stop(reason = "asked to stop"): Promise<void> {
  wanted = false;
  setConfig(PLUGIN, "instance", "stopped");
  await kill(reason);
  setState("stopped", null);
}

const GRACE_MS = 5000;

function kill(reason: string): Promise<void> {
  const proc = child;
  if (!proc) return Promise.resolve();
  log(`stopping — ${reason}`);
  child = null;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(hard);
      try {
        unlinkSync(PIDFILE);
      } catch {
        /* already gone */
      }
      resolve();
    };
    const hard = setTimeout(() => {
      log("! did not exit on SIGTERM — killing");
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      finish();
    }, GRACE_MS);
    hard.unref();
    proc.once("exit", finish);
    try {
      proc.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

/**
 * Kill a child this process lost track of.
 *
 * The only way one exists is `kill -9` on the API — every other exit runs the
 * handlers at the bottom of this file. The pid file is what makes the orphan
 * identifiable: an arbitrary process on 3001 is somebody else's and is left
 * alone, and one whose pid we wrote down is ours to clean up. The pid is
 * checked with signal 0 and the command line is not inspected, because a pid
 * recycled into somebody else's process is a real if unlikely thing — so the
 * file is removed either way and the caller re-checks the port.
 */
function reapOrphan(): boolean {
  let pid = 0;
  try {
    pid = Number(readFileSync(PIDFILE, "utf8").trim());
  } catch {
    return false;
  }
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    try {
      unlinkSync(PIDFILE);
    } catch {
      /* already gone */
    }
    return false;
  }
  log(`reaping an orphaned instance (pid ${pid}) left by a hard kill of the API`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* it went away between the two calls */
  }
  try {
    unlinkSync(PIDFILE);
  } catch {
    /* already gone */
  }
  return true;
}

/* -------------------------------------------------------------- auto-connect */

/**
 * The instance is up, so connect it — without anybody pasting anything.
 *
 * THIS IS THE POINT OF THE FEATURE. "Install here" has to end with a connected
 * provider, not with a running process and a form still asking for a key that
 * exists in a file two directories away. The key is read from the gateway's own
 * database, sealed into the vault under an account labelled "Local instance",
 * and never passes through a log, a route or a shell argument on the way.
 *
 * IT REUSES THE LOCAL ACCOUNT AND NEVER TOUCHES THE HOSTED ONE. The hosted
 * account's key stays sealed exactly where it was, and is used again the moment
 * the owner points the provider back at it — which is what makes switching a
 * click rather than a re-paste.
 *
 * IT DOES NOT CHOOSE ON THE OWNER'S BEHALF. Connecting the account is not the
 * same as making it answer: with no explicit choice stored, the running local
 * instance wins (see `chosen()` in providers/freellmapi.ts), and an owner who
 * has deliberately picked the hosted account keeps it. Starting the local
 * instance is a legitimate thing to do without wanting to be routed through it,
 * and the panel says which one is actually answering.
 */
function autoConnect() {
  const read = readUnifiedKey();
  if (!read.ok) {
    log(`! could not connect the local account — ${read.error}`);
    return;
  }
  if (!getPlugin(PLUGIN)) upsertPlugin(PLUGIN, false, null);

  const existing = accounts.list(PLUGIN);
  const local = existing.find((a) => a.label === LOCAL_LABEL) ?? null;
  const account = local ?? accounts.create(PLUGIN, LOCAL_LABEL);

  /*
    Written on every healthy start rather than once. It is cheap — two AES
    seals — and it is the only thing that repairs the state after the key has
    been rotated on the gateway's own Keys page, which is a button a person
    can press without this process hearing about it. Re-sealing the same value
    is a no-op the owner never sees.
  */
  accounts.writeCredentials(account, SECRET_STEM, [...FIELDS], {
    "base-url": LOCAL_URL,
    key: read.key,
  });
  accounts.markOk(account.id);
  log(`connected "${account.label}" — ${LOCAL_URL}, key read from the gateway's own database`);
}

/**
 * Re-read the key and re-seal it, on request.
 *
 * The one button for "I rotated the key on the gateway's Keys page". It is the
 * same function the first healthy start runs, exposed because the alternative
 * is telling somebody to restart a service to pick up a value already on disk.
 */
export function reconnect(): { ok: boolean; error?: string } {
  const read = readUnifiedKey();
  if (!read.ok) return { ok: false, error: read.error };
  autoConnect();
  return { ok: true };
}

/* -------------------------------------------------------------------- report */

export type InstanceReport = {
  state: InstanceState;
  since: string;
  /** Which install step is running, while installing. Null otherwise. */
  step: string | null;
  /** The last thing that went wrong, or the reason for the current wait. */
  lastError: string | null;
  /** Where the instance answers when it is up. Loopback, always. */
  url: string;
  /** The gateway's own web dashboard, where provider keys are added. */
  dashboardUrl: string;
  port: number;
  /** The commit this checkout is pinned to. Null before an install. */
  commit: string | null;
  installedAt: string | null;
  installSeconds: number | null;
  node: { path: string; version: string } | null;
  /** Whether the dashboard bundle was built. False means the API works and
   *  http://127.0.0.1:3001 will not render. */
  dashboard: boolean;
  pid: number | null;
  healthyAt: string | null;
  /** How many times the instance has been restarted after an exit it did not
   *  ask for. Zero is the ordinary answer. */
  restarts: number;
  /** Whether a unified key has been minted. Never the key. */
  hasKey: boolean;
  /** Whether the two anonymous providers have been switched on. False before
   *  the first start; after that the gateway's own dashboard owns the
   *  switches and this is never re-applied. */
  seeded: boolean;
  /** What the owner last asked for, which survives a restart of the API. */
  autostart: boolean;
  /** The install's or the instance's own last words, with any key removed. */
  log: string[];
  dir: string;
};

export function report(): InstanceReport {
  return {
    state,
    since,
    step,
    lastError,
    url: LOCAL_URL,
    dashboardUrl: `http://127.0.0.1:${LOCAL_PORT}`,
    port: LOCAL_PORT,
    commit: installed?.commit ?? null,
    installedAt: installed?.installedAt ?? null,
    installSeconds: installed?.seconds ?? null,
    node: installed ? { path: installed.nodePath, version: installed.nodeVersion } : null,
    dashboard: installed?.dashboard ?? false,
    pid: child?.pid ?? null,
    healthyAt,
    restarts,
    hasKey: hasKey(),
    seeded: installed?.seeded === true,
    autostart: configValue(PLUGIN, "instance") === "running",
    log: tail.slice(-80),
    dir: ROOT,
  };
}

/** Is the managed instance answering right now? Read by the provider to decide
 *  which account wins when the owner has not chosen one. */
export function isRunning(): boolean {
  return state === "running" && child !== null;
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Called once from index.ts, at boot.
 *
 * THREE JOBS, AND THE MIDDLE ONE MATTERS MOST. It works out what is on disk —
 * so the panel says `installed` rather than `absent` after a restart — it puts
 * the shutdown handlers in place BEFORE anything can be spawned (registering
 * them after a start would leave a window in which a child exists and nothing
 * is arranged to kill it), and it hands the provider a way to ask whether the
 * local instance is live.
 *
 * Then, if the instance was running when the API last stopped, it starts again.
 * That flag is the owner's own last instruction, written to `plugin_config` by
 * start() and stop() — not a heuristic about what was running, which is a thing
 * a crashed process cannot report anyway.
 */
export function boot() {
  setLocalHealth(isRunning);

  installed = readMarker();
  if (installed) setState("installed", null);
  else setState("absent", null);

  arrangeShutdown();

  if (installed && configValue(PLUGIN, "instance") === "running") {
    log("was running when the API last stopped — starting again");
    void start();
  }
}

let arranged = false;

/**
 * NO ORPHANS. Every way this process can end, spelled out.
 *
 * SIGINT and SIGTERM are the ordinary ones (Ctrl-C, a service manager, a
 * `kill`), and both are given the grace period before the process exits. The
 * `exit` handler is the last resort and can only do synchronous work, so it
 * sends SIGKILL rather than SIGTERM: by then there is no event loop left to
 * wait for a polite exit in. A crashed API with a live gateway behind it is
 * exactly the state that makes the next start fail on a port it cannot
 * explain.
 */
function arrangeShutdown() {
  if (arranged) return;
  arranged = true;

  const bye = (signal: NodeJS.Signals) => {
    void (async () => {
      await kill(`the API received ${signal}`);
      process.exit(0);
    })();
  };
  process.once("SIGINT", () => bye("SIGINT"));
  process.once("SIGTERM", () => bye("SIGTERM"));
  process.on("exit", () => {
    const proc = child;
    child = null;
    if (!proc) return;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      unlinkSync(PIDFILE);
    } catch {
      /* already gone */
    }
  });
}
