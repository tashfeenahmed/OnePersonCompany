/**
 * THE MANAGED SEARXNG INSTANCE: installed by this process, run by this
 * process, and connected to without anybody pasting anything.
 *
 * WHY THIS EXISTS WHEN THE PLUGIN ALREADY WORKED. The remote node is on the
 * owner's own Hetzner box behind a proxy that demands an `x-api-key`, so
 * connecting it means having a second machine, a reverse proxy, a key and a
 * hostname that carries an IP address. Every one of those is a thing that can
 * be down or moved, and none of them is SearXNG. Locally none of it is needed:
 * SearXNG itself has no key auth and never has — the upstream image ships one
 * setting for who may reach it, `bind_address`, and A LOOPBACK BIND IS THE
 * AUTH. Nothing off this machine can open 127.0.0.1:8888, so a key in front of
 * it would be a password on a door that is already in a locked room.
 *
 * WHY A CHILD PROCESS AND NOT A CONTAINER. There is no Docker on this machine
 * and the official image is the only container SearXNG publishes, so the
 * choice was source-into-a-virtualenv or nothing. That turns out to be the
 * better shape here anyway: the thing that gets installed is a git checkout at
 * a COMMIT THIS FILE RECORDS, and "which SearXNG is running" is answerable by
 * reading `installed.json` rather than by trusting a moving tag.
 *
 * WHY IT LIVES IN THE API PROCESS, which is the same argument telegram/poller.ts
 * makes and lands in the same place: a second service would need the database,
 * the plugin config and the vault to do its job, which is to say it would be
 * this process under another name. The difference is that this one manages a
 * CHILD PROCESS rather than a loop, and a child process is a thing that can be
 * orphaned — so the whole lower half of this file is about making sure it is
 * not. Every exit path of the API sends SIGTERM and then SIGKILL, the pid is
 * written down before the child is adopted, and boot reaps a pid left behind by
 * a `kill -9` that never got to run any of that.
 *
 * WHAT IT WILL NEVER DO. It does not run as root, it writes nothing outside
 * `DATA_DIR/searxng/`, it binds the instance to loopback and no flag here can
 * change that, and it never logs or returns the secret key — that value is
 * generated once, written to `etc/settings.yml` at mode 0600, and read only by
 * SearXNG itself.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { configValue, getPlugin, setConfig, upsertPlugin } from "../db.ts";
import * as accounts from "../accounts.ts";
import {
  LOCAL_PORT,
  LOCAL_URL,
  PLUGIN,
  endpoint,
  isLoopback,
  mode as searxngMode,
} from "../providers/searxng.ts";
/* The plugin's own collector, called on the first healthy run. Imported for
   that one line: the collector map is the only thing in this file that knows
   how to turn a connected node into the rows the cards draw. */
import { COLLECTORS } from "../collector.ts";

/* ------------------------------------------------------------------ layout */

/** Everything this manages, and the one directory it is allowed to write in. */
export const ROOT = join(DATA_DIR, "searxng");
const SRC = join(ROOT, "src");
const VENV = join(ROOT, ".venv");
const PYTHON = join(VENV, "bin", "python");
/** SEARXNG_SETTINGS_PATH POINTS AT A FOLDER, not at a file — SearXNG appends
 *  `settings.yml` itself, and pointing it at the file is the mistake that
 *  makes an instance silently come up on the defaults. */
const ETC = join(ROOT, "etc");
const SETTINGS = join(ETC, "settings.yml");
const LOGS = join(ROOT, "logs");
const INSTALL_LOG = join(LOGS, "install.log");
const RUN_LOG = join(LOGS, "searxng.log");
/** The marker that says an install FINISHED. Its presence is the difference
 *  between `installed` and a half-cloned directory, which is why it is written
 *  last and deleted first. */
const MARKER = join(ROOT, "installed.json");
/** Written the moment a child is spawned and removed when it exits cleanly.
 *  It exists for exactly one case: `kill -9` on the API, which runs none of
 *  the shutdown code below and would otherwise leave SearXNG holding 8888
 *  forever. See `reapOrphan()`. */
const PIDFILE = join(ROOT, "searxng.pid");

/** The repository, and the Python the docs pin the dependencies against. 3.14
 *  was tried and is too new for the compiled ones; 3.12 is what uv already has
 *  on this machine and what upstream CI builds wheels for. */
const REPO = "https://github.com/searxng/searxng";
const PYTHON_SERIES = "3.12";

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
   *  SearXNG is this" with a name that means something different next week. */
  commit: string;
  installedAt: string;
  pythonPath: string;
  pythonVersion: string;
  /** How long the whole install took, in seconds. Kept because the honest
   *  answer to "how long does this take" is a measurement and not a promise. */
  seconds: number;
};

/** The last N lines of whatever the install or the instance said. In memory,
 *  because it is a progress indicator rather than a record — the files under
 *  `logs/` are the record. */
const TAIL_MAX = 120;

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
/** The single-flight guards. An install and a start are both idempotent by
 *  refusal rather than by queueing — two clones into one directory is not a
 *  race worth winning. */
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
 * Remember what the owner last asked for, so a restart of the API can honour
 * it.
 *
 * The plugins row is created on demand for the same reason `mirrorTerms` in
 * routes/pluginConfig.ts creates one: `plugin_config` has a foreign key onto
 * `plugins`, and the first thing that ever happens to a fresh install of this
 * box may well be somebody clicking "Install here" on a plugin that has never
 * held a credential.
 */
function remember(instanceState: "running" | "stopped") {
  if (!getPlugin(PLUGIN)) upsertPlugin(PLUGIN, false, null);
  setConfig(PLUGIN, "instance", instanceState);
}

function log(line: string, file = RUN_LOG) {
  const stamped = `${new Date().toISOString()} ${line}`;
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
 * Where `uv` is, or null.
 *
 * NOT ASSUMED TO BE ON THE PATH. This process is started by a launcher, a
 * terminal or a service manager, and only one of those three reliably has
 * `~/.local/bin` in it — which is where uv's own installer puts it. The
 * candidates below are looked at in order and the first that exists wins;
 * null is an ordinary answer and the install refuses with a sentence naming
 * the thing to install rather than failing at a spawn.
 */
export function findUv(): string | null {
  const candidates = [
    process.env.OPC_UV,
    join(homedir(), ".local", "bin", "uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "uv")),
  ];
  for (const candidate of candidates)
    if (candidate && existsSync(candidate)) return candidate;
  return null;
}

function findGit(): string | null {
  for (const candidate of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"])
    if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * Run one command to completion, with everything it says going to the tail.
 *
 * Output is streamed rather than buffered because these steps take minutes and
 * a progress bar with no progress in it is the whole reason the install is a
 * background job in the first place. Nothing here interpolates a secret into a
 * command line: there is no secret in an install.
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
      for (const line of text.split("\n"))
        if (line.trim()) log(line.trimEnd(), INSTALL_LOG);
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

/**
 * The environment a child gets, which is deliberately not this process's.
 *
 * A build and a web server need a PATH, a HOME (uv, pip and Python all keep
 * caches under it) and a UTF-8 locale — SearXNG writes non-ASCII to its log on
 * the first request and a C locale turns that into a crash. Nothing else is
 * passed through: the API process holds environment variables that are none of
 * a search engine's business.
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

/* ------------------------------------------------------------------ settings */

/**
 * The settings file, written once and never regenerated over a live secret.
 *
 * `use_default_settings: true` and then only the overrides, which is what the
 * docs ask for and is the only version that survives an upgrade: a copied full
 * settings.yml is a fork of upstream's defaults that stops gaining engines the
 * day it is written.
 *
 * WHY `limiter: false`. The limiter is SearXNG's own rate limiter and it needs
 * a Valkey/Redis SERVER — the `valkey` pip package is a client and connecting
 * to nothing is how a fresh instance answers 429 to its owner. There is
 * nothing to limit here anyway: the only thing that can reach this port is
 * this machine.
 *
 * WHY `image_proxy: false`. The proxy exists so a results page does not leak a
 * viewer's address to an image host. Nothing renders these results as a page —
 * they are JSON handed to an agent — so it would be a hop that costs latency
 * and protects nobody.
 *
 * THE SECRET KEY IS GENERATED HERE AND SEEN NOWHERE ELSE. Flask signs its
 * session cookie with it; this instance issues no cookie anybody keeps, but a
 * shared or empty value is still the one thing upstream refuses to start
 * without. It is 32 random bytes as hex, written at mode 0600, never logged,
 * never returned by a route, and never regenerated once it exists — a
 * reinstall keeps it, because rotating a value nothing depends on would only
 * mean a file that changes for no reason.
 */
function writeSettings() {
  mkdirSync(ETC, { recursive: true });
  const secret = existingSecret() ?? randomBytes(32).toString("hex");
  const yaml = [
    "# Written by the dashboard. Overrides only — the defaults come from the",
    "# checkout, so an upgrade brings upstream's engine list with it.",
    "use_default_settings: true",
    "server:",
    `  bind_address: "127.0.0.1"`,
    `  port: ${LOCAL_PORT}`,
    `  secret_key: "${secret}"`,
    "  limiter: false",
    "  image_proxy: false",
    "search:",
    "  formats: [html, json]",
    "",
  ].join("\n");
  writeFileSync(SETTINGS, yaml, { mode: 0o600 });
  chmodSync(SETTINGS, 0o600);
}

/** The secret already in the file, if there is one. Read to be KEPT, never to
 *  be shown: it is returned to `writeSettings` and to nothing else. */
function existingSecret(): string | null {
  try {
    const match = readFileSync(SETTINGS, "utf8").match(/secret_key:\s*"([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
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
 * Install SearXNG into `DATA_DIR/searxng/`.
 *
 * LONG-RUNNING AND THEREFORE NOT A REQUEST. A clone plus a virtualenv plus a
 * compiled dependency tree is minutes, and a route that waits for it is a
 * route that times out in a proxy somewhere and leaves the owner with no idea
 * whether it worked. So this returns immediately and the state — with the STEP
 * and the last lines of output — is polled from `GET /api/searxng/instance`.
 *
 * IT REFUSES RATHER THAN REPAIRS. Already installed, already installing, or
 * running as root are all refusals with a sentence; there is no "clean up and
 * try again" path here, because the thing it would clean up is a directory
 * that might be a half-finished install or might be a working one somebody
 * asked for twice.
 */
export function install(): { ok: boolean; error?: string } {
  if (installing) return { ok: false, error: "An install is already running." };
  if (installed)
    return {
      ok: false,
      error:
        `SearXNG is already installed here (commit ${installed.commit.slice(0, 12)}). ` +
        `Remove ${ROOT} by hand to install it again — this never deletes a directory it did not just create.`,
    };
  if (process.getuid?.() === 0)
    return {
      ok: false,
      error:
        "Refusing to install as root. This clones a repository and runs its build; " +
        "nothing about that needs to happen with the machine's own privileges.",
    };
  const uv = findUv();
  if (!uv)
    return {
      ok: false,
      error:
        "uv is not installed, or not where this can see it. It is what builds the " +
        "virtualenv and installs the dependencies: `curl -LsSf https://astral.sh/uv/install.sh | sh`, " +
        "then restart the API so the new PATH is seen.",
    };
  const git = findGit();
  if (!git)
    return { ok: false, error: "git is not installed, so there is nothing to clone with." };

  installing = doInstall(uv, git).finally(() => {
    installing = null;
  });
  return { ok: true };
}

async function doInstall(uv: string, git: string) {
  const started = Date.now();
  setState("installing", null);
  tail = [];
  mkdirSync(LOGS, { recursive: true });
  log(`installing SearXNG into ${ROOT}`, INSTALL_LOG);

  const fail = (why: string) => {
    log(`! ${why}`, INSTALL_LOG);
    step = null;
    setState("failed", why);
  };

  try {
    /* ---- the checkout. Shallow, because the history of a search engine is
       not something this box has any use for — and then immediately asked
       which commit that shallow clone actually landed on, because "the tip of
       master on the day you clicked" is only a version if it is written down. */
    step = "cloning searxng";
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

    /* ---- the virtualenv. `--python 3.12` and not "whatever python3 is": 3.14
       is on this machine and is too new for the compiled dependencies below,
       and a venv built on it fails four minutes later inside a wheel build
       with an error about a header file. uv downloads the interpreter if it
       has to, which is what makes this work on a box with no Python at all. */
    step = `creating the virtualenv (python ${PYTHON_SERIES})`;
    const venv = await run(uv, ["venv", "--python", PYTHON_SERIES, VENV]);
    if (venv.code !== 0)
      return fail(`uv could not build a Python ${PYTHON_SERIES} virtualenv here.`);

    /* ---- the build dependencies, ahead of the package itself. SearXNG's
       build needs pyyaml, msgspec, typing-extensions and pybind11 PRESENT
       before its own metadata is generated, which is why the install below
       runs with build isolation off — an isolated build would go and fetch
       its own copies and, for the compiled ones, try to build them from
       source. This is the docs' own order. */
    step = "installing build dependencies";
    const deps = await run(uv, [
      "pip",
      "install",
      "--python",
      PYTHON,
      "-U",
      "pip",
      "setuptools",
      "wheel",
      "pyyaml",
      "msgspec",
      "typing-extensions",
      "pybind11",
    ]);
    if (deps.code !== 0) return fail("Installing the build dependencies failed.");

    /* ---- SearXNG itself, editable, so the checkout IS the installation and
       the commit recorded above is the code that runs. */
    step = "installing searxng";
    const main = await run(uv, [
      "pip",
      "install",
      "--python",
      PYTHON,
      "--no-build-isolation",
      "-e",
      SRC,
    ]);
    if (main.code !== 0)
      return fail(
        "Installing SearXNG failed. lxml, msgspec and curl_cffi are the compiled " +
          "dependencies — the log says which one and why.",
      );

    step = "writing settings";
    writeSettings();

    const version = await run(PYTHON, ["-c", "import sys; print(sys.version.split()[0])"]);
    const marker: Installed = {
      commit,
      installedAt: new Date().toISOString(),
      pythonPath: PYTHON,
      pythonVersion: version.out.trim().split("\n").pop()?.trim() ?? "unknown",
      seconds: Math.round((Date.now() - started) / 1000),
    };
    writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);
    installed = marker;
    step = null;
    setState("installed", null);
    log(
      `installed in ${marker.seconds}s · commit ${commit} · python ${marker.pythonVersion}`,
      INSTALL_LOG,
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------------------------------------------ the port */

/**
 * Is something already listening on the instance's port?
 *
 * A CONNECT RATHER THAN A BIND. Trying to bind would tell us the same thing
 * and would, for the length of the check, be the thing holding the port. This
 * opens a socket, learns whether anybody answers, and closes it.
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

/** Two bytes of "OK" from SearXNG's own liveness path. It is the one endpoint
 *  that answers before the engines are loaded, which is exactly what "is it up
 *  yet" means during a start. */
async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${LOCAL_PORT}/healthz`, {
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
 * SearXNGs would not even both start: the second loses the bind and dies, and
 * the owner would be left reading a log about a port from a button that said
 * "start".
 */
export async function start(): Promise<{ ok: boolean; error?: string }> {
  if (!installed)
    return { ok: false, error: "SearXNG is not installed here yet." };
  if (child) return { ok: true };
  if (starting) return { ok: true };

  starting = true;
  try {
    /*
      SOMEBODY ELSE ON THE PORT IS ITS OWN SENTENCE. It is the ordinary way
      this fails — a second copy of the dashboard, a SearXNG started by hand,
      an unrelated service on 8888 — and "the child exited immediately" is a
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
    remember("running");
    spawnChild();
    return { ok: true };
  } finally {
    starting = false;
  }
}

function spawnChild() {
  setState("starting", null);
  log(`starting: ${PYTHON} -m searx.webapp`);

  const proc = spawn(PYTHON, ["-m", "searx.webapp"], {
    cwd: ROOT,
    env: { ...childEnv(), SEARXNG_SETTINGS_PATH: ETC },
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
      for a reason that will not change on the fifth attempt, and restarting it
      in a loop would spend the machine to keep saying so.
    */
    failedStarts += 1;
    if (failedStarts >= 5) {
      wanted = false;
      const why =
        `SearXNG exited ${failedStarts} times without ever answering /healthz (${how}). ` +
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
 * Poll /healthz until it answers, and connect the plugin the first time it
 * does.
 *
 * Tied to the process it was spawned for, so a health check outstanding when a
 * crash restarts the instance cannot mark the NEW process healthy on the
 * strength of the old one's port.
 */
async function waitForHealth(proc: ChildProcess) {
  const deadline = Date.now() + 90_000;
  while (child === proc && Date.now() < deadline) {
    if (await healthy()) {
      healthyAt = new Date().toISOString();
      failedStarts = 0;
      setState("running", null);
      log(`healthy on http://127.0.0.1:${LOCAL_PORT}`);
      autoConnect();
      return;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  if (child === proc && state === "starting")
    /* Still alive and still not answering. Not killed: a slow first boot on a
       cold machine is a real thing, and the state says what is true rather
       than deciding for the owner. */
    setState("starting", "Started, but /healthz has not answered yet.");
}

/**
 * Stop it, and mean it.
 *
 * SIGTERM first, because SearXNG closes its listener on it and a killed
 * process leaves the port in a state the next start has to wait out. SIGKILL
 * after the grace, because a shutdown that can be refused is not a shutdown —
 * and the one thing this file must never do is leave a child holding 8888
 * after the API that owns it has gone.
 */
export async function stop(reason = "asked to stop"): Promise<void> {
  wanted = false;
  remember("stopped");
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
 * identifiable: an arbitrary process on 8888 is somebody else's and is left
 * alone, and one whose pid we wrote down is ours to clean up. The pid is
 * checked with signal 0 (does this process exist) and the command line is not
 * inspected, because a pid that has been recycled into somebody else's process
 * is a real if unlikely thing — so the file is removed either way and the
 * caller re-checks the port.
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
 * The instance is up, so point the plugin at it — without a key.
 *
 * THIS IS THE WHOLE POINT OF THE FEATURE. "Install here" has to end with a
 * connected integration, not with a running process and a form still asking
 * for a URL and an API key that do not exist. So the first healthy run writes
 * the URL, records the mode, and connects the plugin.
 *
 * WITHOUT A KEY, AND THE REASON IS NOT LAZINESS. SearXNG has no key auth. The
 * remote node's key belongs to the reverse proxy in front of it, which is what
 * makes a public instance possible at all; a loopback instance has no proxy
 * and needs no key, and inventing one here would be a password this file
 * checks against itself.
 *
 * IT DOES NOT TOUCH THE VAULT. The remote key stays sealed exactly where it
 * was, under its own entry, and is used again the moment the endpoint setting
 * points back at the remote node. That is what makes switching a one-field
 * change rather than a re-paste.
 *
 * AND IT DOES NOT OVERRULE A DELIBERATE CHOICE. An owner who has set the
 * endpoint back to the remote node has said which instance they want; starting
 * the local one after that is a legitimate thing to do — the panel offers it —
 * and it must not silently repoint the searches. `mode: "remote"` written by
 * hand or by the settings form is therefore respected, and the panel says the
 * instance is running but not in use.
 */
function autoConnect() {
  if (configValue(PLUGIN, "mode") === "remote") {
    log("running, but the search endpoint points at the remote node — left as it is");
    return;
  }
  if (!getPlugin(PLUGIN)) upsertPlugin(PLUGIN, false, null);
  setConfig(PLUGIN, "url", LOCAL_URL);
  setConfig(PLUGIN, "mode", "managed");

  /*
    AN ACCOUNT IS STILL THE THING THAT CARRIES STATE. Every probe writes
    `searxng_state` and `searxng_engines` against an account id, and the
    interface draws accounts — so managed mode reuses the account that is
    already there rather than inventing a second one beside it, and creates one
    only when the plugin has never been connected at all. What that account
    holds is unchanged: a remote key if there was one, and nothing if there was
    not. `writeCredentials` with no values writes no ciphertext and marks the
    account connected, which is exactly the state a keyless instance is in.
  */
  const existing = accounts.list(PLUGIN);
  const account = existing[0] ?? accounts.create(PLUGIN, "Local instance");
  if (!account.connected || !existing.length)
    accounts.writeCredentials(account, "searxng-key", ["key"], {});
  log(`connected — ${LOCAL_URL}, no key (loopback is the auth)`);

  /*
    AND PROBED IMMEDIATELY, for the reason every credential route collects the
    moment it stores something: the point of connecting is to SEE it. Without
    this, the health card and the engine list would go on describing the node
    the box has just stopped searching until the six-hour clock came round —
    and the collector's own clock knows to ignore itself when the endpoint has
    changed, which is what makes this a real probe rather than a skipped run.
  */
  const collector = COLLECTORS[PLUGIN];
  if (collector)
    void collector()
      .then((r) => log(`probed the new instance — ${r.ok ? "ok" : "failed"}`))
      .catch((err: unknown) =>
        log(`probing the new instance failed — ${err instanceof Error ? err.message : err}`),
      );
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
  port: number;
  /** The commit this checkout is pinned to. Null before an install. */
  commit: string | null;
  installedAt: string | null;
  installSeconds: number | null;
  python: { path: string; version: string } | null;
  pid: number | null;
  healthyAt: string | null;
  /** How many times the instance has been restarted after an exit it did not
   *  ask for. Zero is the ordinary answer. */
  restarts: number;
  /** Whether the plugin is actually SEARCHING through this instance. Running
   *  and in use are two different facts. */
  inUse: boolean;
  /** What the owner last asked for, which survives a restart of the API. */
  autostart: boolean;
  /** The install's or the instance's own last words. Never a secret: the only
   *  one here is in a file this never reads out. */
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
    port: LOCAL_PORT,
    commit: installed?.commit ?? null,
    installedAt: installed?.installedAt ?? null,
    installSeconds: installed?.seconds ?? null,
    python: installed
      ? { path: installed.pythonPath, version: installed.pythonVersion }
      : null,
    pid: child?.pid ?? null,
    healthyAt,
    restarts,
    /* THE SAME TEST THE PROVIDER MAKES, and not a second opinion about it:
       mode AND a loopback endpoint. A panel that read the mode row alone could
       say "in use" about an instance the searches had stopped going through. */
    inUse: searxngMode() === "managed" && isLoopback(endpoint()),
    autostart: configValue(PLUGIN, "instance") === "running",
    log: tail.slice(-60),
    dir: ROOT,
  };
}

/** Is the managed instance the thing that would answer a search right now?
 *  Read by the tool route, so it can say which instance served a query. */
export function isRunning(): boolean {
  return state === "running" && child !== null;
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Called once from index.ts, at boot.
 *
 * TWO JOBS, AND THE SECOND IS THE ONE THAT MATTERS. It works out what is on
 * disk — so the panel says `installed` rather than `absent` after a restart —
 * and it puts the shutdown handlers in place BEFORE anything can be spawned.
 * Registering them after a start would leave a window in which a child exists
 * and nothing is arranged to kill it.
 *
 * Then, if the instance was running when the API last stopped, it starts
 * again. That flag is the owner's own last instruction, written to
 * `plugin_config` by start() and stop() — not a heuristic about what was
 * running, which is a thing a crashed process cannot report anyway.
 */
export function boot() {
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
 * wait for a polite exit in. An uncaught exception goes the same way as a
 * signal, because a crashed API with a live SearXNG behind it is exactly the
 * state that makes the next start fail on a port it cannot explain.
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
