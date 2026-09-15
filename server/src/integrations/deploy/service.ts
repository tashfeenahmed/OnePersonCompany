/**
 * THE SERVICE — how this app runs when nobody is sitting in front of it.
 *
 * WHAT WAS MISSING. `npm run dev` is two child processes in somebody's
 * terminal. Close the lid, log out, or let the machine reboot at three in the
 * morning for an update, and the collectors stop, the agent stops, the nightly
 * briefing does not happen, and nothing says so. The predecessor solved this
 * with a systemd unit per collector on a Raspberry Pi. This is one process
 * rather than nine scripts, and it has to run on whatever the owner actually
 * uses — so this file generates the supervision the CURRENT platform speaks
 * and installs it into the CURRENT user's own account.
 *
 * A USER SERVICE, NEVER A SYSTEM ONE. `~/Library/LaunchAgents` on macOS,
 * `~/.config/systemd/user` on Linux. Nothing here writes to /Library, /etc or
 * anything else needing root, and nothing here asks for a password. The
 * reasons are not convenience: this process opens a vault key and a database
 * in the owner's own home directory, and a root-owned unit running as the
 * owner is a file the owner cannot fix without sudo on the day it is wrong.
 * A LaunchAgent also only runs while somebody is logged in, which is stated in
 * the README rather than worked around — a Mac that should serve a dashboard
 * across a reboot with nobody logged in wants a LaunchDaemon and a
 * conversation about what that means for the keychain.
 *
 * THE ENVIRONMENT IS A FILE AND NOT A PLIST FULL OF KEYS. `deploy/opc.env` is
 * written once and thereafter belongs to the owner; the unit points
 * `OPC_ENV_FILE` at it and `config.ts` loads it exactly as it already loads
 * `server/.env`. That means changing the port or the data directory of an
 * installed service is editing one file a person can read, rather than
 * regenerating XML. The installer NEVER overwrites an existing env file — it
 * is settings, and settings written by a person are not something a tool gets
 * to replace.
 *
 * IT WRITES BEFORE IT INSTALLS. Every generator here is a pure function from
 * the plan to a string, and the CLI's default is to write those strings into
 * `deploy/out/` and stop. Installing is `--install` — an explicit second
 * decision — because a tool whose first run puts a supervised process in
 * somebody's login session is a tool people run once and then hunt for.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BIND_HOST, COLLECT_MINUTES, DATA_DIR, EXTRA_BROWSER_ORIGINS, LOAD_RETAIN_DAYS, PORT, RETAIN_DAYS } from "../../config.ts";

const run = promisify(execFile);

/** The repository root — four directories up from this file. Derived rather
 *  than configured, because a service that pointed at a copy of the app that
 *  is not the one generating the unit is the failure this whole file is
 *  supposed to prevent. */
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
export const DEPLOY_DIR = join(REPO_ROOT, "deploy");
export const OUT_DIR = join(DEPLOY_DIR, "out");
export const ENV_FILE = join(DEPLOY_DIR, "opc.env");
export const LOG_DIR = join(DATA_DIR, "logs");
export const OUT_LOG = join(LOG_DIR, "opc.out.log");
export const ERR_LOG = join(LOG_DIR, "opc.err.log");

/** The reverse-DNS label launchd wants and the name systemd gets. One string,
 *  because it is a filename, a launchctl argument and the thing a person greps
 *  for in `launchctl list`. */
export const LABEL = "com.opc.server";
export const SYSTEMD_UNIT = "opc.service";

export type Platform = "darwin" | "linux" | "unsupported";

export function platform(): Platform {
  return process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "unsupported";
}

export type Plan = {
  platform: Platform;
  label: string;
  /** Where the unit belongs on this platform, in this user's account. */
  unitPath: string;
  unitFile: string;
  unitText: string;
  envPath: string;
  envText: string;
  /** The interpreter the unit will exec. This process's own, resolved, so an
   *  nvm-managed Node still works when the login session has no PATH. */
  node: string;
  entry: string;
  root: string;
  outLog: string;
  errLog: string;
  user: string;
};

/** Where `config.ts` looks when nothing sets `OPC_ENV_FILE` — the file an
 *  interactive `npm run dev` has been reading all along. */
export const DEV_ENV_FILE = resolve(fileURLToPath(new URL("../../../", import.meta.url)), ".env");

/** `KEY=value` lines out of an env file, comments and blanks dropped. Not a
 *  full dotenv parser and does not need to be: it exists to find out which
 *  names the owner has already set, so the generated file does not silently
 *  drop them. Values are copied through verbatim. */
export function readEnvFile(path: string): { order: string[]; values: Record<string, string> } {
  const order: string[] = [];
  const values: Record<string, string> = {};
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const at = line.indexOf("=");
      if (at < 1) continue;
      const key = line.slice(0, at).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (!(key in values)) order.push(key);
      values[key] = line.slice(at + 1);
    }
  } catch {
    /* No file is the ordinary case. */
  }
  return { order, values };
}

/**
 * THE ENV FILE, GENERATED FROM WHAT THIS PROCESS ACTUALLY BELIEVES — including
 * everything it was told by the `server/.env` it is running under.
 *
 * THE BUG THIS SHAPE EXISTS TO PREVENT. `config.ts` reads
 * `OPC_ENV_FILE ?? server/.env` — one file, not both. The unit sets
 * `OPC_ENV_FILE=deploy/opc.env`, so installing the service SILENTLY STOPS
 * `server/.env` being read at all. The first version of this function then
 * wrote three of the five values as constants, so a box collecting every ten
 * minutes with a year of retention installed itself back to thirty and four
 * hundred, and the comment above it claimed to be generated from live config.
 *
 * So: every name in the existing `server/.env` is carried across with its own
 * value, the five this app defines are written from the LIVE config values, and
 * an existing name always wins over the generated default — the file is the
 * owner's statement about their box and this function is not entitled to
 * disagree with it. The header says, in the generated file, that it replaces
 * `server/.env`, because somebody will edit the wrong one otherwise.
 */
export function envText(from = DEV_ENV_FILE): string {
  const existing = readEnvFile(from);

  /* The five this app defines, from `config.ts` — which has already applied
     the environment, `server/.env` and the defaults in that order, so these
     are what the running process is actually using. */
  const derived: [key: string, value: string, why: string][] = [
    ["PORT", String(PORT), "The API and production website port."],
    ["OPC_BIND_HOST", BIND_HOST, "Listening interface. Loopback by default; use a LAN firewall when enabling network access."],
    ["OPC_ALLOWED_ORIGINS", [...EXTRA_BROWSER_ORIGINS].join(","), "Additional browser origins, comma-separated; for example http://dashboard.local:8787."],
    ["OPC_DATA_DIR", DATA_DIR, "Database, keys and artifacts. Absolute here on purpose: a service has no reliable working directory."],
    ["OPC_COLLECT_MINUTES", String(COLLECT_MINUTES), "The DEFAULT collection cadence. Per-source cadence is a setting on each plugin's page; 0 turns the scheduler off."],
    ["OPC_RETAIN_DAYS", String(RETAIN_DAYS), "Reading retention."],
    ["OPC_LOAD_RETAIN_DAYS", String(LOAD_RETAIN_DAYS), "Server-load reading retention."],
  ];

  const lines = [
    "# OnePersonCompany service environment.",
    "#",
    "# THIS FILE REPLACES server/.env FOR THE INSTALLED SERVICE. The unit sets",
    "# OPC_ENV_FILE to this path, and server/src/config.ts reads OPC_ENV_FILE *or*",
    "# server/.env — never both. Anything you add to server/.env after installing",
    "# the service will not be seen by it. Edit this file instead.",
    "#",
    `# Generated once by \`npm run install-service\` from the values this process was`,
    `# running with${existing.order.length ? `, merged with ${from}` : ""}. It is yours thereafter — the installer`,
    "# will never overwrite it.",
    "#",
    "# NO CREDENTIALS BELONG HERE. Every secret is in the vault at",
    "# server/data/vault.key and its database; this file is paths and numbers.",
    "",
  ];

  for (const [key, value, why] of derived) {
    const kept = existing.values[key];
    lines.push(`# ${why}`);
    lines.push(`${key}=${kept ?? value}`);
  }

  const carried = existing.order.filter((k) => !derived.some(([d]) => d === k));
  if (carried.length) {
    lines.push("");
    lines.push(`# Carried across from ${from} verbatim. This app does not define these;`);
    lines.push("# something else on this box reads them, and dropping them would be a");
    lines.push("# change the installer made without saying so.");
    for (const key of carried) lines.push(`${key}=${existing.values[key]}`);
  }

  lines.push("");
  return lines.join("\n");
}

/** XML text, escaped. A data directory with an `&` in it is a plist that will
 *  not parse and a service that never starts, and the error launchd gives says
 *  nothing about ampersands. */
function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The half of the plan a unit generator needs: where Node is, what it runs,
 *  where it stands and where it logs. Named rather than spelled as an `Omit`
 *  in three places, because the two generators and the test all take it and
 *  three copies of one exclusion list is three chances to forget a field. */
export type UnitFacts = Pick<Plan, "node" | "entry" | "root" | "outLog" | "errLog" | "user">;

/**
 * The launchd agent.
 *
 * `KeepAlive` IS A DICTIONARY AND NOT `true`, and the difference is the whole
 * restart policy. `true` restarts the process whatever happened, including a
 * clean `npm run uninstall-service` stop and including a config error that
 * exits immediately — which launchd then retries forever. `SuccessfulExit:
 * false` restarts it only when it died badly, which is what "restart on
 * failure" means everywhere else on this page.
 *
 * `ThrottleInterval` IS THE SPACING AND IT IS NOT OPTIONAL. launchd's default
 * is ten seconds; a process that fails to bind its port comes back every ten
 * seconds forever and fills the log. Thirty is long enough that a broken
 * install is visibly broken rather than noisy.
 */
export function launchdPlist(p: UnitFacts): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  OnePersonCompany, as a launchd user agent.

  Generated by \`npm run install-service\`. Edit the environment in
  ${xml(ENV_FILE)} rather than here: regenerating this file
  will overwrite anything typed into it.

  IT RUNS ONLY WHILE THIS USER IS LOGGED IN. That is what a LaunchAgent is. A
  dashboard that must survive a reboot with nobody at the machine wants a
  LaunchDaemon in /Library/LaunchDaemons, which runs as root before login and
  is a different security conversation — see the README.
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.node)}</string>
    <string>--experimental-strip-types</string>
    <string>${xml(p.entry)}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${xml(p.root)}</string>

  <key>RunAtLoad</key>
  <true/>

  <!-- Restart when it dies badly; do not fight a deliberate stop. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>ProcessType</key>
  <string>Background</string>

  <key>StandardOutPath</key>
  <string>${xml(p.outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(p.errLog)}</string>

  <!--
    A LOGIN SESSION HAS ALMOST NO PATH, and this process shells out to ssh,
    ffmpeg, git and the agent's own launcher. The PATH below is the one this
    process had when the unit was generated, which is the PATH the owner's
    terminal has, which is the one the tools were verified against.
  -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPC_ENV_FILE</key>
    <string>${xml(ENV_FILE)}</string>
    <key>PATH</key>
    <string>${xml(process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin")}</string>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * A VALUE FOR A systemd UNIT, QUOTED.
 *
 * systemd splits `ExecStart` on whitespace and reads `Environment=` as
 * whitespace-separated assignments, so a path or a PATH containing a space
 * silently becomes two arguments — and the failure is a service that will not
 * start with an error naming a path that does not exist. The launchd half has
 * `xml()`; this is its counterpart. Double quotes with C-style escaping is
 * what systemd.syntax documents, and `$` is escaped as `$$` because systemd
 * performs `${VAR}` expansion in `ExecStart`.
 */
function sd(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`;
}

/**
 * The systemd user unit.
 *
 * THE START-RATE LIMIT IS THE PREDECESSOR'S LESSON, KEPT. Its units learned
 * the hard way that `StartLimitBurst` counts every start and not only the
 * retries, and that a too-small burst leaves a unit sitting failed. There is
 * one long-lived unit here rather than nine oneshots, so the numbers are
 * simpler: three restarts in ten minutes, then it stays failed until somebody
 * looks — which is the correct end state for a service whose configuration is
 * wrong, and not one this file should paper over by retrying forever.
 */
export function systemdUnit(p: UnitFacts): string {
  return `# OnePersonCompany, as a systemd user service.
#
# Generated by \`npm run install-service\`. Edit the environment in
# ${ENV_FILE} rather than here: regenerating this file overwrites it.
#
# A USER SERVICE. It runs as ${p.user} and needs no root. It stops when the
# user's session ends unless lingering is on:
#   sudo loginctl enable-linger ${p.user}
# That is the one command here that needs a privilege, it is not run for you,
# and without it an unattended box stops serving at logout.

[Unit]
Description=OnePersonCompany dashboard and collectors
After=network-online.target
Wants=network-online.target
# Every start counts, restarts included. Three failures in ten minutes and it
# stays failed rather than looping — a service that will not start is not a
# service a retry loop can fix.
StartLimitIntervalSec=600
StartLimitBurst=4

[Service]
Type=simple
# WorkingDirectory takes one literal path; unlike ExecStart, quotes become
# part of the path and make systemd reject even an ordinary absolute path.
WorkingDirectory=${p.root}
Environment="OPC_ENV_FILE=${ENV_FILE.replace(/"/g, '\\"')}"
Environment="LANG=en_US.UTF-8"
Environment="PATH=${(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").replace(/"/g, '\\"')}"
ExecStart=${sd(p.node)} --experimental-strip-types ${sd(p.entry)}
Restart=on-failure
RestartSec=30
# The logs go to files as well as to the journal, so the Deployment page can
# tail them without shelling out to journalctl — and so a box with a volatile
# journal still has yesterday's failure.
StandardOutput=append:${p.outLog}
StandardError=append:${p.errLog}
# The log paths are NOT quoted: systemd reads everything after append: as the
# path, spaces included, and a quote there would become part of the filename.
# The smallest hardening that changes nothing about how this app works. It
# writes only to its own data directory and reads only its own tree.
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

/** What would be written, where, without writing it. */
export function plan(): Plan {
  const os = platform();
  const base = {
    node: process.execPath,
    entry: join(REPO_ROOT, "server", "src", "index.ts"),
    root: REPO_ROOT,
    outLog: OUT_LOG,
    errLog: ERR_LOG,
    user: userInfo().username,
  };
  const unitFile = os === "darwin" ? `${LABEL}.plist` : SYSTEMD_UNIT;
  const unitPath =
    os === "darwin"
      ? join(homedir(), "Library", "LaunchAgents", unitFile)
      : join(homedir(), ".config", "systemd", "user", unitFile);
  const unitText = os === "darwin" ? launchdPlist(base) : os === "linux" ? systemdUnit(base) : "";
  return { platform: os, label: LABEL, unitPath, unitFile, unitText, envPath: ENV_FILE, envText: envText(), ...base };
}

/* ------------------------------------------------------------------ writing */

/** The env file, created if absent and NEVER overwritten. Returns what it
 *  did, because "already there" is the answer the installer prints. */
export function writeEnvFile(path = ENV_FILE): { path: string; created: boolean } {
  mkdirSync(join(path, ".."), { recursive: true });
  if (existsSync(path)) return { path, created: false };
  writeFileSync(path, envText(), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, created: true };
}

/** The dry run: the unit and a copy of the env template into `deploy/out/`,
 *  and nothing else touched. */
export function writeDryRun(dir = OUT_DIR): { unit: string; env: string } {
  const p = plan();
  mkdirSync(dir, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const unit = join(dir, p.unitFile);
  const env = join(dir, "opc.env");
  writeFileSync(unit, p.unitText);
  writeFileSync(env, p.envText, { mode: 0o600 });
  return { unit, env };
}

/* --------------------------------------------------------------- installing */

export type ActionResult = { ok: boolean; steps: string[]; error: string | null };

async function tryRun(steps: string[], file: string, args: string[]): Promise<boolean> {
  try {
    const { stdout, stderr } = await run(file, args, { timeout: 20_000 });
    const said = `${stdout ?? ""}${stderr ?? ""}`.trim();
    steps.push(`$ ${file} ${args.join(" ")}${said ? ` — ${said.split("\n")[0]}` : ""}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    steps.push(`$ ${file} ${args.join(" ")} — failed: ${message}`);
    return false;
  }
}

/**
 * Install the unit and start it.
 *
 * macOS: `bootstrap` is the modern verb and it REFUSES a label that is already
 * loaded, so an existing one is booted out first and the failure of that is
 * expected and ignored. Linux: `daemon-reload` then `enable --now`.
 */
export async function install(): Promise<ActionResult> {
  const p = plan();
  const steps: string[] = [];
  if (p.platform === "unsupported")
    return { ok: false, steps, error: `There is no service format here for ${process.platform}. Run \`npm start\` under whatever supervisor this system uses.` };

  mkdirSync(join(p.unitPath, ".."), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const env = writeEnvFile();
  steps.push(env.created ? `wrote ${env.path}` : `kept the existing ${env.path}`);
  writeFileSync(p.unitPath, p.unitText);
  steps.push(`wrote ${p.unitPath}`);

  if (p.platform === "darwin") {
    /* THE DOMAIN IS THIS USER'S, READ FROM THE PROCESS. The old fallback of
       501 was a guess at "the first Mac account" — on a machine where it
       fired, it would have addressed somebody else's launchd. `userInfo().uid`
       is defined on every platform this branch runs on. */
    const target = `gui/${userInfo().uid}`;
    await tryRun(steps, "/bin/launchctl", ["bootout", `${target}/${LABEL}`]);
    const ok = await tryRun(steps, "/bin/launchctl", ["bootstrap", target, p.unitPath]);
    if (!ok) return { ok: false, steps, error: "launchctl would not load the agent. The step above says why." };
    await tryRun(steps, "/bin/launchctl", ["kickstart", `${target}/${LABEL}`]);
    return { ok: true, steps, error: null };
  }

  await tryRun(steps, "systemctl", ["--user", "daemon-reload"]);
  const ok = await tryRun(steps, "systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  if (!ok) return { ok: false, steps, error: "systemctl would not enable the unit. The step above says why." };
  return { ok: true, steps, error: null };
}

/** Stop it and take the unit away. The env file and the logs stay: one is
 *  settings and the other is the record of what happened. */
export async function uninstall(): Promise<ActionResult> {
  const p = plan();
  const steps: string[] = [];
  if (p.platform === "unsupported") return { ok: false, steps, error: `Nothing to uninstall on ${process.platform}.` };

  if (p.platform === "darwin") {
    await tryRun(steps, "/bin/launchctl", ["bootout", `gui/${userInfo().uid}/${LABEL}`]);
  } else {
    await tryRun(steps, "systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
  }
  if (existsSync(p.unitPath)) {
    rmSync(p.unitPath, { force: true });
    steps.push(`removed ${p.unitPath}`);
  } else {
    steps.push(`${p.unitPath} was not there.`);
  }
  if (p.platform === "linux") await tryRun(steps, "systemctl", ["--user", "daemon-reload"]);
  steps.push(`left ${ENV_FILE} and the logs in ${LOG_DIR} alone.`);
  return { ok: true, steps, error: null };
}

/* ------------------------------------------------------------------- status */

export type ServiceStatus = {
  platform: Platform;
  label: string;
  unitPath: string;
  /** Is the unit file on disk where the supervisor looks? */
  installed: boolean;
  /** What the supervisor says, verbatim and trimmed. Null when it could not be
   *  asked — which is a different thing from "not running". */
  supervisor: string | null;
  /** True only when the supervisor reported a pid. Null when unknown. */
  running: boolean | null;
  pid: number | null;
  envPath: string;
  envPresent: boolean;
  logs: { out: string; err: string; outBytes: number | null; errBytes: number | null };
  /** Is THIS process the one the service would have started? A dev server and
   *  an installed service both answering on one port is the confusion this
   *  field exists to end. */
  thisProcessPid: number;
  note: string;
};

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export async function status(): Promise<ServiceStatus> {
  const p = plan();
  let supervisor: string | null = null;
  let pid: number | null = null;
  let running: boolean | null = null;

  try {
    if (p.platform === "darwin") {
      const { stdout } = await run("/bin/launchctl", ["print", `gui/${userInfo().uid}/${LABEL}`], { timeout: 10_000 });
      supervisor = stdout.trim().slice(0, 4000);
      const m = /^\s*pid = (\d+)/m.exec(stdout);
      pid = m ? Number(m[1]) : null;
      running = pid !== null;
    } else if (p.platform === "linux") {
      const { stdout } = await run("systemctl", ["--user", "show", SYSTEMD_UNIT, "--no-pager"], { timeout: 10_000 });
      supervisor = stdout.trim().slice(0, 4000);
      const m = /^MainPID=(\d+)$/m.exec(stdout);
      pid = m && Number(m[1]) > 0 ? Number(m[1]) : null;
      running = /^ActiveState=active$/m.test(stdout);
    }
  } catch (err) {
    /* launchctl prints to stderr and exits non-zero for a label that is not
       loaded, which is an ANSWER and not a failure. */
    const message = err instanceof Error ? err.message : String(err);
    supervisor = message.slice(0, 800);
    running = /not (loaded|found)|could not find|No such file/i.test(message) ? false : null;
  }

  return {
    platform: p.platform,
    label: LABEL,
    unitPath: p.unitPath,
    installed: existsSync(p.unitPath),
    supervisor,
    running,
    pid,
    envPath: ENV_FILE,
    envPresent: existsSync(ENV_FILE),
    logs: { out: OUT_LOG, err: ERR_LOG, outBytes: sizeOf(OUT_LOG), errBytes: sizeOf(ERR_LOG) },
    thisProcessPid: process.pid,
    note:
      "`installed` is the unit file on disk; `running` is what the supervisor says. They disagree while a service " +
      "is installed and stopped, which is a real state. `pid` is the supervised process — if it differs from " +
      "`thisProcessPid`, the answer you are reading came from a different copy of this app on the same port.",
  };
}

/** The last lines of a log, for the page. Reads the tail of the file rather
 *  than the whole thing: an err log can be megabytes after a crash loop. */
export function logTail(which: "out" | "err", lines = 60): { path: string; lines: string[]; bytes: number | null; note: string } {
  const path = which === "err" ? ERR_LOG : OUT_LOG;
  const bytes = sizeOf(path);
  if (bytes === null) return { path, lines: [], bytes: null, note: "There is no log file at that path yet. A service that has never started writes none." };
  try {
    const n = Math.max(1, Math.min(500, Math.round(lines)));
    const want = 200 * n;
    const from = Math.max(0, bytes - want);
    const buf = readFileSync(path);
    const text = buf.subarray(from).toString("utf8");
    const all = text.split("\n");
    /* A partial first line, when the read started mid-line. */
    if (from > 0 && all.length) all.shift();
    return {
      path,
      lines: all.filter((l) => l.length).slice(-n),
      bytes,
      note: from > 0 ? `The last ${want} bytes of a ${bytes}-byte file.` : "The whole file.",
    };
  } catch (err) {
    return { path, lines: [], bytes, note: `The log could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}
