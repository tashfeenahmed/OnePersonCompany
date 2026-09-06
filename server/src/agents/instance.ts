/**
 * THE MANAGED AGENTS: Hermes and OpenClaw, installed by this process, run by
 * this process, pointed at this app's own model provider, and connected
 * without anybody pasting a URL or a key.
 *
 * WHY THIS EXISTS WHEN BOTH PLUGINS ALREADY WORKED. `providers/hermes.ts` and
 * `providers/openclaw.ts` connect an agent that is ALREADY RUNNING somewhere:
 * the owner pastes a base URL and a bearer, the adapter verifies it, and chat
 * works. That is the remote case and it is unchanged by this file. The gap it
 * leaves is the ordinary one — there IS no agent running anywhere, and the
 * form asks for the address of a thing that does not exist. So this is the
 * other door: install it here, configure it here, run it here, and end with a
 * connected integration rather than with a process and an empty form.
 *
 * ONE FILE FOR TWO AGENTS, because the lifecycle is identical and the
 * differences are four values and two config writers. Install, configure, run,
 * probe, connect, restart, reap — all of it is written once and parameterised
 * by the `Spec` records at the top. Two files would be two copies of the
 * shutdown handling, which is the part that must not drift.
 *
 * WHAT THE AGENT IS POINTED AT. `models/provider.ts` owns the default model
 * provider — FreeLLMAPI, a local model, OpenAI, OpenRouter — and this writes
 * the ACTIVE one into the agent's own config file. That is the whole point of
 * the two-layer split: "which model" is decided once, in one place, and an
 * agent spawned here inherits it rather than growing a second, divergent
 * answer. With no provider connected there is nothing to point at, and both
 * spawners REFUSE with that sentence rather than starting an agent that will
 * fail on its first message.
 *
 * ============================ WHAT WAS PROBED ============================
 *
 * Both were installed and run for real on this Mac (arm64, macOS 25.5) on
 * 2026-09-05, and two of the things everybody "knows" about them turned out
 * to be wrong. Written down here because the next person will otherwise spend
 * the same hour:
 *
 * HERMES' OpenAI DOOR IS THE API SERVER ON 8642 — NOT `hermes proxy` ON 8645.
 * `hermes proxy start` reads as the obvious candidate and is not one:
 * `hermes_cli/proxy/cli.py` takes `--provider nous|xai`, calls
 * `adapter.is_authenticated()`, and exits 2 with "Not logged into Nous Portal"
 * when it is not. It is a CREDENTIAL-ATTACHING proxy to an OAuth provider —
 * there is no code path in it that reaches a custom endpoint, so no amount of
 * provider configuration makes it start, and if it did start it would forward
 * to a model rather than run the agent. The real door is documented at
 * `website/docs/user-guide/features/api-server.md`: set `API_SERVER_ENABLED`
 * and `API_SERVER_KEY` in `$HERMES_HOME/.env`, run `hermes gateway run`, and
 * an OpenAI-compatible server appears on 127.0.0.1:8642 whose `/v1/models`
 * lists one model — `hermes-agent` — and whose `/v1/chat/completions` runs the
 * AGENT, tools and all. It needs no Nous login of any kind.
 *
 * OPENCLAW'S PROVIDER LIVES UNDER TOP-LEVEL `models.providers`, not under the
 * agent. `openclaw config schema` is the authority: a provider is
 * `models.providers.<id>` with `baseUrl`, `apiKey`, `api` and its own `models`
 * list, and the agent selects it by `agents.defaults.model.primary` spelled
 * `<provider>/<model>`. The 500 an earlier attempt got from a bare gateway was
 * the harness, not the wire — `agentRuntime.id: "openclaw"` pins the built-in
 * one so the gateway cannot go looking for `codex`.
 *
 * =========================================================================
 *
 * ONLY ONE IS LIVE, and that rule is not enforced here twice. `chat.backend`
 * already names the single agent that answers — see chat/backend.ts — so
 * `make-live` below writes that setting and nothing else. What this file adds
 * is the cheaper half of the same rule: it REFUSES TO START the second managed
 * agent while the first is running. Two agents thinking on one laptop is a fan
 * and a bill, and the second one is not even reachable, because only one of
 * them can be the chat backend.
 *
 * WHAT IT WILL NEVER DO. It does not run as root. It writes nothing outside
 * `DATA_DIR/<agent>/` — both installers want a home directory, and both are
 * given one INSIDE that directory rather than the owner's, which is what keeps
 * `~/.hermes`, `~/.openclaw` and `~/.local/bin` untouched on this machine. It
 * binds both agents to loopback and no route here can change that. And it
 * never logs, returns or passes as an argument either of the two secrets it
 * handles — the provider's key and the door key it generates — both of which
 * are written to config files at mode 0600 and read only by the agent.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, userInfo } from "node:os";
/* WHERE THE AGENT IS ALLOWED TO STAND, and under which account — the deploy
   area owns both, and reports what is actually true on Settings → Deployment. */
import { agentUser, agentWorkDir } from "../integrations/deploy/isolation.ts";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { configValue, getPlugin, setConfig, upsertPlugin } from "../db.ts";
import * as accounts from "../accounts.ts";
import { getJson, readModelIds } from "../chat/wire.ts";
import { activeProvider, type Endpoint, type ModelProvider } from "../models/provider.ts";
import * as hermesAdapter from "../providers/hermes.ts";
import * as openclawAdapter from "../providers/openclaw.ts";
/*
  THE SKILL PACKS AND THE MCP SERVER — the two doors an agent has onto this
  app's own data, wired in here because this is the file that already owns
  "write the agent's config from what is true right now". A skill set is
  exactly that kind of fact: it follows what is connected, and it has to be on
  disk before a child is spawned.
*/
import { liveFingerprint, syncHermesSkills } from "../skills/hermes.ts";
import { openClawSkillServers, syncOpenClawSkills } from "../skills/openclaw.ts";
import { installCli } from "../skills/cli.ts";

/* ------------------------------------------------------------------- ids */

export type AgentId = "hermes" | "openclaw";
export const AGENT_IDS: AgentId[] = ["hermes", "openclaw"];

export type InstanceState =
  | "absent"
  | "installing"
  | "installed"
  | "starting"
  | "running"
  | "stopped"
  | "failed";

/**
 * THE CONFIG KEYS THIS FILE OWNS, on the two plugins' own rows.
 *
 * `mode` decides which credential answers a chat turn — the managed instance
 * or a pasted remote one — and is read by the adapters themselves.
 * `managedAccount` names the account this file created, so "the managed one"
 * survives a restart and cannot be confused with an account the owner added.
 * `instance` is the owner's last instruction about the process, which is what
 * makes boot able to bring back what was running.
 */
export const MODE_KEY = "mode";
export const MANAGED_ACCOUNT_KEY = "managedAccount";
export const INSTANCE_KEY = "instance";

/* ---------------------------------------------------------------- the specs */

/**
 * What differs between the two agents. Everything else in this file is shared.
 *
 * `port` is the OpenAI-compatible door, and for Hermes it is 8642 rather than
 * the 8645 the catalog used to name — see the header. `probe` is what "is it
 * up yet" means for each: OpenClaw publishes an unauthenticated `/health`,
 * Hermes publishes nothing that does not want the bearer, so its probe is
 * `/v1/models` with the door key.
 */
type Spec = {
  id: AgentId;
  label: string;
  /** Everything this agent owns on disk. Nothing is written outside it. */
  root: string;
  /** The HOME the child and the installer see. Containment is mostly this:
   *  both installers put their state under `$HOME/...`, so a home inside
   *  DATA_DIR is a home that cannot reach the owner's dotfiles. */
  home: string;
  port: number;
  /** What the plugin's base-url / gateway-url field is set to on connect. */
  url: string;
  /** The model name the agent answers as on its own endpoint. Reported, never
   *  guessed: Hermes advertises `hermes-agent`, OpenClaw `openclaw/default`. */
  advertises: string;
  install: (spec: Spec, log: Log) => Promise<Installed>;
  /** Write the agent's own config from the active provider. Handles both
   *  secrets; returns what may safely be shown. */
  configure: (spec: Spec, plan: Plan) => void;
  /** The command that runs it in the foreground. */
  command: (spec: Spec) => { file: string; args: string[]; env: Record<string, string> };
  probe: (spec: Spec, key: string) => Promise<boolean>;
  /** Verify the managed endpoint through the REMOTE adapter's own verify, then
   *  hand back the credential set to store. Reusing verify is the point: a
   *  managed connect and a pasted one go through the same check. */
  connect: (spec: Spec, key: string) => Promise<{ ok: true; values: Record<string, string> } | { ok: false; error: string }>;
};

const HERMES_ROOT = join(DATA_DIR, "hermes");
const OPENCLAW_ROOT = join(DATA_DIR, "openclaw");

/** Pinned. `latest` is a version that means something different next week, and
 *  "which OpenClaw is running" has to be answerable from `installed.json`. */
const OPENCLAW_VERSION = "2026.9.1";

/** Hermes' installer clones a branch rather than serving a version, so the
 *  pin is recorded AFTER the fact: the commit that landed is read out of the
 *  checkout and written down. A tag would be a moving target and the installer
 *  offers none. */
const HERMES_BRANCH = "main";
const HERMES_INSTALLER = "https://hermes-agent.nousresearch.com/install.sh";

const SPECS: Record<AgentId, Spec> = {
  hermes: {
    id: "hermes",
    label: "Hermes",
    root: HERMES_ROOT,
    home: join(HERMES_ROOT, "home"),
    port: 8642,
    url: "http://127.0.0.1:8642/v1",
    advertises: "hermes-agent",
    install: installHermes,
    configure: configureHermes,
    command: (spec) => ({
      /* The installer writes a two-line bash wrapper that execs the venv's own
         python with absolute paths, so this needs no PATH of its own to find
         the interpreter — but the agent shells out for its tools, so it gets
         one anyway, and it STARTS with this app's own bin: that is where `opc`
         lives (skills/cli.ts), and the terminal tool inherits the gateway's
         PATH, so this line is what makes `opc` a word the agent can type. */
      file: join(spec.home, ".local", "bin", "hermes"),
      args: ["gateway", "run"],
      env: {
        HERMES_HOME: hermesHome(spec),
        PATH: `${cliBinDir(spec)}:${process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"}`,
      },
    }),
    probe: async (spec, key) => {
      try {
        const res = await fetch(`http://127.0.0.1:${spec.port}/v1/models`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(2500),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    connect: async (spec, key) => {
      const res = await hermesAdapter.verify({ baseUrl: spec.url, key });
      return res.ok
        ? { ok: true, values: { "base-url": spec.url, key } }
        : { ok: false, error: res.error };
    },
  },

  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    root: OPENCLAW_ROOT,
    home: join(OPENCLAW_ROOT, "home"),
    port: 18789,
    url: "http://127.0.0.1:18789",
    advertises: "openclaw/default",
    install: installOpenClaw,
    configure: configureOpenClaw,
    command: (spec) => ({
      file: join(spec.root, "node_modules", ".bin", "openclaw"),
      args: ["gateway", "run"],
      /* OPENCLAW_HOME is a HOME replacement rather than a config path: the
         config lands at `$OPENCLAW_HOME/.openclaw/openclaw.json`, which is
         what `openclaw config file` prints when it is set. */
      env: { OPENCLAW_HOME: spec.home },
    }),
    probe: async (spec) => {
      try {
        const res = await fetch(`http://127.0.0.1:${spec.port}/health`, {
          signal: AbortSignal.timeout(2500),
        });
        if (!res.ok) return false;
        const doc = (await res.json()) as { ok?: boolean; status?: string };
        return doc?.ok === true && (doc.status === "live" || doc.status === "started");
      } catch {
        return false;
      }
    },
    connect: async (spec, token) => {
      const res = await openclawAdapter.verify({ gatewayUrl: spec.url, token });
      return res.ok
        ? { ok: true, values: { "gateway-url": spec.url, token } }
        : { ok: false, error: res.error };
    },
  },
};

/** `$HERMES_HOME` — the data directory, which the installer derives from HOME
 *  and which every later command has to be handed explicitly. */
function hermesHome(spec: Spec) {
  return join(spec.home, ".hermes");
}

/** Where this app puts the commands it gives an agent — `opc`, today. Under
 *  the agent's root rather than its home, because the home is the installer's
 *  and this directory is ours. */
function cliBinDir(spec: Spec) {
  return join(spec.root, "bin");
}

export function spec(id: AgentId): Spec {
  return SPECS[id];
}

/* ------------------------------------------------------------------- state */

type Installed = {
  /** The version string the agent reports about itself. */
  version: string;
  /** For Hermes, the commit the checkout landed on — the only real version it
   *  has. Null for OpenClaw, whose npm version IS the pin. */
  commit: string | null;
  installedAt: string;
  /** How long it took, in seconds. A measurement, never a promise. */
  seconds: number;
  /** Where the code ended up, so "what is installed" is answerable from the
   *  marker rather than by guessing at a layout. */
  dir: string;
};

/** What the agent was configured to talk to, with NO key in it. This object is
 *  returned by the route, so it holds nothing that could not be printed. */
export type Pointed = {
  provider: string;
  providerLabel: string;
  endpoint: string;
  endpointUrl: string;
  model: string;
  at: string;
};

/** Everything a configure needs, resolved once so the two writers below are
 *  pure. `key` is the provider's bearer and never leaves this file. */
type Plan = {
  baseUrl: string;
  key: string | null;
  model: string;
  /** The door key — the bearer the DASHBOARD uses to talk to the agent. */
  door: string;
  pointed: Pointed;
};

type Runtime = {
  state: InstanceState;
  since: string;
  step: string | null;
  lastError: string | null;
  installed: Installed | null;
  pointed: Pointed | null;
  child: ChildProcess | null;
  healthyAt: string | null;
  restarts: number;
  failedStarts: number;
  wanted: boolean;
  tail: string[];
  installing: Promise<void> | null;
  starting: boolean;
  /** The provider fingerprint the running child was configured from. The
   *  watcher below compares against it; see `watchProvider`. */
  fingerprint: string | null;
};

const TAIL_MAX = 160;

const RUNTIME: Record<AgentId, Runtime> = {
  hermes: fresh(),
  openclaw: fresh(),
};

function fresh(): Runtime {
  return {
    state: "absent",
    since: new Date().toISOString(),
    step: null,
    lastError: null,
    installed: null,
    pointed: null,
    child: null,
    healthyAt: null,
    restarts: 0,
    failedStarts: 0,
    wanted: false,
    tail: [],
    installing: null,
    starting: false,
    fingerprint: null,
  };
}

function setState(id: AgentId, next: InstanceState, why?: string | null) {
  const r = RUNTIME[id];
  if (r.state !== next) {
    r.state = next;
    r.since = new Date().toISOString();
  }
  if (why !== undefined) r.lastError = why;
}

/* -------------------------------------------------------------------- logs */

type Log = (line: string, file?: "install" | "run") => void;

function logsDir(spec: Spec) {
  return join(spec.root, "logs");
}

function logger(spec: Spec): Log {
  return (line, file = "run") => {
    const r = RUNTIME[spec.id];
    const stamped = `${new Date().toISOString()} ${line}`;
    r.tail.push(stamped);
    if (r.tail.length > TAIL_MAX) r.tail = r.tail.slice(-TAIL_MAX);
    try {
      mkdirSync(logsDir(spec), { recursive: true });
      appendFileSync(join(logsDir(spec), `${file}.log`), `${stamped}\n`);
    } catch {
      /* A log that cannot be written must not take the agent down with it. */
    }
  };
}

/* ---------------------------------------------------------------- the door */

/**
 * The bearer the dashboard uses to talk to the agent, generated once per
 * install and kept in a file at mode 0600.
 *
 * WHY A REAL SECRET AND NOT A PLACEHOLDER. Both doors check it. Hermes'
 * API server refuses to start without `API_SERVER_KEY` and rejects a weak one;
 * OpenClaw's gateway bearer is operator access to the whole gateway, which its
 * own adapter's header argues about at length. Loopback is the outer wall, but
 * a token that anything on this machine could guess is not a token.
 *
 * WHY A FILE AND NOT THE VAULT AS THE SOURCE. The vault is where it ends up —
 * `autoConnect` stores it as the plugin's key, exactly as a pasted one would
 * be — but the agent's own config file has to hold it too, and the two have to
 * agree across a reinstall, a reconfigure and a restart. One generated value,
 * written once, read by both, is the version with no way to drift.
 */
function doorKey(spec: Spec): string {
  const path = join(spec.root, "door.key");
  try {
    const held = readFileSync(path, "utf8").trim();
    if (held.length >= 32) return held;
  } catch {
    /* not generated yet */
  }
  const key = randomBytes(24).toString("hex");
  mkdirSync(spec.root, { recursive: true });
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

/* ------------------------------------------------------------------ toolbox */

/**
 * The environment a child gets, which is deliberately not this process's.
 *
 * A PATH, a HOME INSIDE `DATA_DIR`, and a UTF-8 locale. Nothing else: the API
 * process holds environment variables — and a vault key path — that are none
 * of an agent's business, and an agent that inherited them would be an agent
 * that could read them out on request.
 */
function childEnv(spec: Spec, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    HOME: spec.home,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...extra,
  };
}

/**
 * Run one command to completion, streaming what it says into the tail.
 *
 * Streamed rather than buffered because an install is minutes long and a
 * progress indicator with no progress in it is the reason the install is a
 * background job at all. NOTHING HERE INTERPOLATES A SECRET INTO AN ARGUMENT
 * LIST: there is no secret in an install, and the two that exist afterwards go
 * into files rather than onto a command line, where `ps` would show them.
 */
function run(
  spec: Spec,
  log: Log,
  file: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    log(`$ ${file} ${args.join(" ")}`, "install");
    const proc = spawn(file, args, {
      cwd: opts.cwd ?? spec.root,
      env: childEnv(spec, opts.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const take = (buf: Buffer) => {
      const text = buf.toString();
      out += text;
      for (const line of text.split("\n")) if (line.trim()) log(line.trimEnd(), "install");
    };
    proc.stdout?.on("data", take);
    proc.stderr?.on("data", take);
    proc.on("error", (err) => {
      log(`! ${err.message}`, "install");
      resolve({ code: -1, out: `${out}\n${err.message}` });
    });
    proc.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

/**
 * Where a tool is, or null.
 *
 * NOT ASSUMED TO BE ON THE PATH, for the reason searxng/instance.ts gives
 * about `uv`: this process is started by a terminal, a launcher or a service
 * manager and only one of those reliably carries a useful PATH. Null is an
 * ordinary answer and the install refuses with a sentence naming what to
 * install rather than failing inside a spawn.
 */
function find(name: string, extra: string[] = []): string | null {
  const candidates = [
    ...extra,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    join(homedir(), ".local", "bin", name),
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, name)),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/* ----------------------------------------------------------------- markers */

function markerPath(spec: Spec) {
  return join(spec.root, "installed.json");
}

function readMarker(spec: Spec): Installed | null {
  try {
    const doc = JSON.parse(readFileSync(markerPath(spec), "utf8")) as Installed;
    return doc.version ? doc : null;
  } catch {
    return null;
  }
}

function writeMarker(spec: Spec, marker: Installed) {
  writeFileSync(markerPath(spec), `${JSON.stringify(marker, null, 2)}\n`);
}

/* ------------------------------------------------------------------ install */

/**
 * Install an agent into `DATA_DIR/<agent>/`.
 *
 * LONG-RUNNING AND THEREFORE NOT A REQUEST. Hermes is a git clone, a Python
 * 3.11 virtualenv and a compiled dependency tree — minutes, and hundreds of
 * megabytes. A route that waited for it would time out somewhere and leave the
 * owner with no idea whether it worked, so this returns immediately and the
 * state, with the step and the last lines of output, is polled from
 * `GET /api/agents`.
 *
 * IT REFUSES RATHER THAN REPAIRS, exactly as the SearXNG instance does.
 * Already installed, already installing, or running as root are refusals with
 * a sentence; there is no clean-up path, because the thing it would clean up
 * might be a half-finished install or might be a working one somebody asked
 * for twice.
 */
export function install(id: AgentId): { ok: boolean; error?: string } {
  const s = SPECS[id];
  const r = RUNTIME[id];
  if (r.installing) return { ok: false, error: `An install of ${s.label} is already running.` };
  if (r.installed)
    return {
      ok: false,
      error:
        `${s.label} is already installed here (${r.installed.version}). Remove ` +
        `${s.root} by hand to install it again — this never deletes a directory ` +
        `it did not just create.`,
    };
  if (process.getuid?.() === 0)
    return {
      ok: false,
      error:
        "Refusing to install as root. This downloads and runs an installer; nothing " +
        "about that needs to happen with the machine's own privileges.",
    };

  const log = logger(s);
  r.installing = (async () => {
    const started = Date.now();
    setState(id, "installing", null);
    r.tail = [];
    r.step = null;
    mkdirSync(logsDir(s), { recursive: true });
    log(`installing ${s.label} into ${s.root}`, "install");
    try {
      const marker = await s.install(s, log);
      marker.seconds = Math.round((Date.now() - started) / 1000);
      writeMarker(s, marker);
      r.installed = marker;
      r.step = null;
      setState(id, "installed", null);
      log(`installed in ${marker.seconds}s · ${marker.version}`, "install");
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      log(`! ${why}`, "install");
      r.step = null;
      setState(id, "failed", why);
    }
  })().finally(() => {
    r.installing = null;
  });
  return { ok: true };
}

/**
 * HERMES. The upstream installer, run with a home of its own.
 *
 * `HOME` IS THE CONTAINMENT AND IT IS NOT OPTIONAL. The script resolves
 * `HERMES_HOME` to `$HOME/.hermes`, puts the checkout under it, and links the
 * `hermes` command into `$HOME/.local/bin` — a directory it will also fill
 * with node/npm symlinks if it decides the system Node is unsuitable. Given
 * the owner's real HOME that is three surprises on a machine that asked for
 * one agent. Given a HOME inside `DATA_DIR` it is exactly one directory, and
 * `~/.hermes` and `~/.local/bin` are never touched. `HERMES_HOME` is passed as
 * well, explicitly, because every later `hermes` invocation has to be handed
 * it and a value derived twice is a value that eventually differs.
 *
 * THE FLAGS ARE ALL SUBTRACTIONS. `--skip-setup` because the wizard is
 * interactive and there is no terminal here; `--skip-browser` and
 * `--skip-computer-use` because Playwright's Chromium and the Computer Use
 * driver are hundreds of megabytes for tools an agent behind a chat box will
 * not reach; `--non-interactive` because anything that stops to ask a question
 * would hang a background job forever.
 */
async function installHermes(s: Spec, log: Log): Promise<Installed> {
  const r = RUNTIME.hermes;
  const bash = find("bash", ["/bin/bash"]);
  if (!bash) throw new Error("bash is not on this machine, so the installer cannot be run.");
  const git = find("git");
  if (!git) throw new Error("git is not installed, so the Hermes installer has nothing to clone with.");

  mkdirSync(s.home, { recursive: true });

  /* ---- the installer itself, fetched rather than piped into a shell. The
     documented one-liner is `curl … | bash`, which is the same code with two
     differences that matter here: nothing is written down, so "which installer
     ran" is unanswerable afterwards, and a truncated download becomes a
     half-executed script instead of a failed fetch. */
  r.step = "downloading the Hermes installer";
  const script = join(s.root, "install.sh");
  const res = await fetch(HERMES_INSTALLER, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`The Hermes installer answered HTTP ${res.status}.`);
  const text = await res.text();
  if (!text.startsWith("#!")) throw new Error("What came back from the installer URL is not a shell script.");
  writeFileSync(script, text);
  log(`installer: ${text.length} bytes from ${HERMES_INSTALLER}`, "install");

  /* ---- and the install. Minutes. The step name is what the panel shows. */
  r.step = "running the Hermes installer (clone, virtualenv, dependencies)";
  const out = await run(s, log, bash, [
    script,
    "--skip-setup",
    "--skip-browser",
    "--skip-computer-use",
    "--non-interactive",
    "--branch",
    HERMES_BRANCH,
  ], {
    env: {
      HERMES_HOME: hermesHome(s),
      /* The installer's own guard against a Python-driven parent leaking a
         PYTHONPATH into the venv. Passed empty rather than trusted. */
      UV_NO_CONFIG: "1",
    },
  });
  if (out.code !== 0) throw new Error("The Hermes installer failed — the log below is what it said.");

  const bin = join(s.home, ".local", "bin", "hermes");
  if (!existsSync(bin))
    throw new Error(`The installer finished but wrote no hermes command at ${bin}.`);

  /* ---- what actually landed. The version string and the commit, because the
     installer tracks a BRANCH: "main on the day you clicked" is only a version
     if it is written down. */
  r.step = "recording the version";
  const checkout = join(hermesHome(s), "hermes-agent");
  const version = await run(s, log, bin, ["--version"], { env: { HERMES_HOME: hermesHome(s) } });
  const rev = await run(s, log, git, ["-C", checkout, "rev-parse", "HEAD"]);
  const commit = rev.out.trim().split("\n").pop()?.trim() ?? "";

  /* THE FIRST LINE, not the last. `hermes --version` prints a six-line report —
     the version, the install directory, the method, the Python, the SDK, and
     an update check whose last word is "Up to date". Taking the tail of that
     writes "Up to date" into the marker as if it were a version number. */
  const versionLine =
    version.out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^Hermes/i.test(l)) ?? version.out.trim().split("\n")[0]?.trim();

  return {
    version: versionLine || "unknown",
    commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null,
    installedAt: new Date().toISOString(),
    seconds: 0,
    dir: checkout,
  };
}

/**
 * OPENCLAW. One npm install into a prefix of its own.
 *
 * `--prefix` RATHER THAN `-g`, so the package lands in `DATA_DIR/openclaw/`
 * and the command is run from that tree's own `node_modules/.bin`. A global
 * install would put a second `openclaw` on the owner's PATH, which is a thing
 * this app has no business deciding for them, and would be shared with — and
 * upgraded out from under — anything else on the machine that uses it.
 *
 * THE VERSION IS PINNED IN SOURCE. `openclaw@latest` on a box that reinstalls
 * is a gateway whose config schema changes without anybody choosing it.
 */
async function installOpenClaw(s: Spec, log: Log): Promise<Installed> {
  const r = RUNTIME.openclaw;
  const npm = find("npm", [join(dirname(process.execPath), "npm")]);
  if (!npm) throw new Error("npm is not on this machine, so OpenClaw cannot be installed.");

  mkdirSync(s.root, { recursive: true });
  mkdirSync(s.home, { recursive: true });
  /* A prefix with no package.json makes npm walk UP looking for one and
     install into whatever it finds — which here would be the server's own
     tree. One empty manifest stops that dead. */
  const manifest = join(s.root, "package.json");
  if (!existsSync(manifest))
    writeFileSync(
      manifest,
      `${JSON.stringify({ name: "opc-openclaw-host", private: true, version: "0.0.0" }, null, 2)}\n`,
    );

  r.step = `installing openclaw@${OPENCLAW_VERSION}`;
  const out = await run(s, log, npm, [
    "install",
    "--prefix",
    s.root,
    "--no-audit",
    "--no-fund",
    "--loglevel",
    "error",
    `openclaw@${OPENCLAW_VERSION}`,
  ]);
  if (out.code !== 0) throw new Error("npm could not install OpenClaw — the log below is what it said.");

  const bin = join(s.root, "node_modules", ".bin", "openclaw");
  if (!existsSync(bin)) throw new Error(`npm finished but wrote no openclaw command at ${bin}.`);

  let version = OPENCLAW_VERSION;
  try {
    const pkg = JSON.parse(
      readFileSync(join(s.root, "node_modules", "openclaw", "package.json"), "utf8"),
    ) as { version?: string };
    version = pkg.version ?? OPENCLAW_VERSION;
  } catch {
    /* The pin is the answer if the manifest cannot be read. */
  }

  return {
    version,
    commit: null,
    installedAt: new Date().toISOString(),
    seconds: 0,
    dir: join(s.root, "node_modules", "openclaw"),
  };
}

/* ---------------------------------------------------------------- configure */

/**
 * Which model the agent will be told to ask for.
 *
 * The provider's own default, then — for a provider that names none, which
 * FreeLLMAPI and a local router both legitimately do — the first id its
 * `/models` lists. The same rule `models/provider.ts` follows for a direct
 * completion, and for the same reason: an OpenAI-shaped server refuses a
 * request with no model, so "let the endpoint pick" still has to send
 * SOMETHING, and the honest something is the first thing it said it serves.
 */
async function modelFor(p: ModelProvider, e: Endpoint, agent: string): Promise<string> {
  if (p.defaultModel) return p.defaultModel;
  const doc = await getJson<unknown>(
    `${e.baseUrl}/models`,
    e.key ? { Authorization: `Bearer ${e.key}` } : {},
    p.label,
  );
  const first = readModelIds(doc)[0];
  if (!first)
    throw new Error(
      `${p.label} at ${e.label} lists no models and names no default, so there ` +
        `is nothing to point ${agent} at.`,
    );
  return first;
}

export class NoProviderForAgentError extends Error {
  constructor(label: string) {
    super(
      `There is no default model provider, so ${label} would have nothing to think ` +
        `with. Connect FreeLLMAPI, a local model, OpenAI or OpenRouter under ` +
        `Integrations and make one the default first.`,
    );
    this.name = "NoProviderForAgentError";
  }
}

/**
 * Resolve everything a config write needs, once.
 *
 * THE PROVIDER IS READ HERE AND NOWHERE ELSE, so "which endpoint is this agent
 * pointed at" has exactly one answer and it is the one on the wire. The key is
 * carried in the returned object and never in the one the routes return —
 * `Pointed` is the printable half and has no field that could hold it.
 */
async function plan(s: Spec): Promise<Plan> {
  const p = activeProvider();
  if (!p) throw new NoProviderForAgentError(s.label);
  const endpoint = p.endpoints[0];
  if (!endpoint) throw new Error(`${p.label} has no endpoint configured.`);
  const model = await modelFor(p, endpoint, s.label);
  return {
    baseUrl: endpoint.baseUrl,
    key: endpoint.key,
    model,
    door: doorKey(s),
    pointed: {
      provider: p.id,
      providerLabel: p.label,
      endpoint: endpoint.label,
      endpointUrl: endpoint.baseUrl,
      model,
      at: new Date().toISOString(),
    },
  };
}

/**
 * A fingerprint of what the running child was configured from.
 *
 * The KEY is in it, hashed rather than held: a rotated key is a change the
 * agent has to be told about, and comparing the values themselves would mean
 * keeping a copy of a secret in memory to compare against. Any change here
 * means the config on disk is stale and the child is talking to the wrong
 * place.
 */
function fingerprint(pl: Plan): string {
  const keyPart = pl.key ? digest(pl.key) : "none";
  return `${pl.baseUrl}|${pl.model}|${keyPart}`;
}

/** A short, stable, non-reversible digest. Not a password hash and does not
 *  need to be: it exists so two secrets can be compared without either being
 *  kept. */
function digest(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * HERMES' CONFIG. Two files, both at mode 0600, both written whole.
 *
 * `config.yaml` names the model provider. Hermes' own template ships as a
 * 1,600-line commented example and is REPLACED rather than edited: every key
 * in it has a default in code, so a short file that says only what this app
 * has decided is both complete and readable — and a surgical edit of a YAML
 * document this app does not own is a merge conflict waiting for the next
 * upstream release.
 *
 * `.env` switches on the API server — the OpenAI-compatible door on 8642 —
 * and carries the bearer it checks. It is deliberately the only place either
 * secret appears, and neither is ever passed as an argument: `ps` is readable
 * by every process on this machine.
 */
function configureHermes(s: Spec, pl: Plan) {
  const dir = hermesHome(s);
  mkdirSync(dir, { recursive: true });

  /*
    ONE DOOR, AND IT IS THE TERMINAL.

    This used to register one MCP server per integration here as well, on the
    argument that a model with no terminal needs a typed tool. Hermes has a
    terminal, always, and the tools it was given turned out to be the worse of
    the two doors: a subprocess per integration to keep alive, a tool list the
    gateway caches for the life of the process, and a second vocabulary
    (`opc_stripe`) beside the one in the packs (`stripe`). So the packs now say
    `opc stripe --days 30` and nothing else, the wrapper below is what makes
    that a command, and `mcp_servers` is not written. The MCP server itself
    still exists — OpenClaw has no terminal and is configured with it — but
    for Hermes the terminal is the tool.
  */
  const yaml = [
    "# Written by the dashboard, whole, on every configure. Hermes' own",
    "# cli-config.yaml.example is the reference for everything not named here;",
    "# every key it lists has a default in code, so this file says only what",
    "# this app has actually decided.",
    "model:",
    '  provider: "custom"',
    `  base_url: ${JSON.stringify(pl.baseUrl)}`,
    ...(pl.key ? [`  api_key: ${JSON.stringify(pl.key)}`] : []),
    `  default: ${JSON.stringify(pl.model)}`,
    "",
    "# This dashboard's own data reaches the agent through the `opc` command on",
    "# the terminal's PATH and the skill packs under skills/ that teach it. No",
    "# mcp_servers block, on purpose: the terminal is the tool.",
    "",
  ].join("\n");
  const config = join(dir, "config.yaml");
  writeFileSync(config, yaml, { mode: 0o600 });
  chmodSync(config, 0o600);

  const env = [
    "# Written by the dashboard. The API server is Hermes' OpenAI-compatible",
    "# door — see website/docs/user-guide/features/api-server.md in the",
    "# checkout. It is NOT `hermes proxy`, which forwards to Nous/xAI OAuth.",
    "API_SERVER_ENABLED=true",
    `API_SERVER_KEY=${pl.door}`,
    "API_SERVER_HOST=127.0.0.1",
    `API_SERVER_PORT=${s.port}`,
    "",
  ].join("\n");
  const envFile = join(dir, ".env");
  writeFileSync(envFile, env, { mode: 0o600 });
  chmodSync(envFile, 0o600);

  /*
    THE SKILL PACKS, WRITTEN HERE RATHER THAN ON A TIMER OF THEIR OWN.

    Configure runs before every spawn and on every reconfigure, which are
    exactly the two moments a fresh set has to be on disk before the child
    reads it. `syncHermesSkills` writes one pack per CONNECTED integration and
    deletes the packs of integrations that have gone — the delete being the
    half that matters, because a stale App Store pack on a box with no App
    Store credential invites the agent to report a revenue of zero for an
    integration nobody set up, which looks exactly like an answer.

    It writes only where content differs, so a configure that changed nothing
    leaves every mtime alone — see the watcher at the bottom of this file for
    why that matters.
  */
  const cli = installCli(cliBinDir(s));
  if (cli.changed) logger(s)(`cli: wrote ${cli.path}`);

  const sync = syncHermesSkills(join(dir, "skills"), { cli: cli.path });
  if (sync.changed)
    logger(s)(
      `skills: ${sync.written.length} written, ${sync.removed.length} removed` +
        (sync.removed.length ? ` (${sync.removed.join(", ")})` : ""),
    );
}

/**
 * OPENCLAW'S CONFIG. One JSON document, written whole, at mode 0600.
 *
 * THE PROVIDER IS TOP-LEVEL AND THE AGENT ONLY NAMES IT. `models.providers.opc`
 * carries the endpoint, the key and the model list; `agents.defaults.model.
 * primary` selects it as `opc/<model>`. `agentRuntime.id: "openclaw"` pins the
 * built-in harness — without it the gateway can decide the provider wants
 * `codex` and answer 500 "Agent harness runtime is unavailable", which is
 * exactly the failure a bare gateway produced before this file existed.
 *
 * `chatCompletions.enabled` is the one line that makes the chat surface exist
 * at all: OFF by default, and with it off both `/v1/models` and
 * `/v1/chat/completions` answer a bare `Not Found` that is indistinguishable
 * from a wrong port.
 *
 * mDNS IS TURNED OFF. Left alone, the gateway advertises itself on the local
 * network over Bonjour — observed doing exactly that during the trial run.
 * This agent is bound to loopback because nothing off this machine should
 * reach it, and announcing its existence to the LAN is the same decision made
 * backwards.
 */
function configureOpenClaw(s: Spec, pl: Plan) {
  const dir = join(s.home, ".openclaw");
  mkdirSync(dir, { recursive: true });

  /*
    NO COMMENT KEY. The obvious thing — a `_comment` field saying who wrote
    this file — is REFUSED: the gateway validates its config against a closed
    schema and exits 78 with `<root>: Unrecognized key: "_comment"`, then
    trips its own restart-loop breaker after three tries. JSON5 comments would
    survive a read and not a `openclaw config set`, which rewrites the file.
    So the explanation lives in this function and the file holds only settings.
  */
  const doc = {
    models: {
      mode: "merge",
      providers: {
        opc: {
          baseUrl: pl.baseUrl,
          ...(pl.key ? { apiKey: pl.key } : {}),
          api: "openai-completions",
          agentRuntime: { id: "openclaw" },
          models: [{ id: pl.model, name: `${pl.pointed.providerLabel} · ${pl.model}` }],
        },
      },
    },
    agents: { defaults: { model: { primary: `opc/${pl.model}` } } },
    gateway: {
      port: s.port,
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: pl.door },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    /*
      THIS APP'S OWN DATA, AS THE ONLY DOOR OPENCLAW HAS FOR IT.

      Probed against `openclaw config schema`: there is no key for a skills
      directory and no raw-HTTP tool to hand a URL to. Custom capability
      arrives through `mcp.servers.<id>` and nowhere else, so where Hermes gets
      nineteen Markdown packs AND these tools, OpenClaw gets the tools or it
      gets nothing.

      `tools.sandbox.tools.alsoAllow` is what actually lets the agent CALL
      them. The sandbox's default tool set does not include MCP bundles, and a
      server registered without this is a server that connects, lists its
      tools, and is never invoked — a failure with no error in it. It is
      `alsoAllow` rather than `allow` because the two cannot both be set in one
      scope, and `allow` would replace the built-in tool set rather than extend
      it: the agent would gain this dashboard and lose its shell.
    */
    // One server per integration here too — the tool list is what the owner
    // sees, and eighteen named entries beat one called "opc".
    mcp: { servers: openClawSkillServers() },
    tools: { sandbox: { tools: { alsoAllow: ["bundle-mcp"] } } },
    discovery: { mdns: { mode: "off" } },
    logging: { level: "info", file: join(logsDir(s), "gateway.log") },
  };

  const file = join(dir, "openclaw.json");
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Rewrite the agent's provider config from whatever is the default right now.
 *
 * A RUNNING AGENT IS RESTARTED, because neither of them re-reads its config
 * file. Silently leaving a live agent pointed at the old endpoint after the
 * owner switched providers would be the worst of the three options: the page
 * would say one thing and the answers would come from another.
 */
export async function reconfigure(id: AgentId): Promise<{ ok: boolean; error?: string }> {
  const s = SPECS[id];
  const r = RUNTIME[id];
  if (!r.installed) return { ok: false, error: `${s.label} is not installed here yet.` };
  const log = logger(s);
  try {
    const pl = await plan(s);
    s.configure(s, pl);
    r.pointed = pl.pointed;
    const next = fingerprint(pl);
    const changed = r.fingerprint !== null && r.fingerprint !== next;
    r.fingerprint = next;
    log(`configured for ${pl.pointed.providerLabel} · ${pl.model} at ${pl.baseUrl}`);
    if (r.child && changed) {
      log("the default model provider changed — restarting so the new config takes effect");
      await kill(id, "the model provider changed");
      spawnChild(id);
    }
    return { ok: true };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`! ${why}`);
    return { ok: false, error: why };
  }
}

/* ------------------------------------------------------------------ the port */

/**
 * Is something already listening on this agent's door?
 *
 * A CONNECT RATHER THAN A BIND, for the reason the SearXNG instance gives:
 * binding would tell us the same thing and would, for the length of the check,
 * be the thing holding the port.
 */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
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

function pidPath(s: Spec) {
  return join(s.root, `${s.id}.pid`);
}

/**
 * Kill a child this process lost track of.
 *
 * The only way one exists is `kill -9` on the API — every other exit runs the
 * handlers at the bottom of this file. The pid file is what makes an orphan
 * IDENTIFIABLE: an arbitrary process on 8642 is somebody else's and is left
 * alone; one whose pid we wrote down is ours to clean up. Signal 0 asks
 * whether it exists at all, and the file is removed either way because a
 * recycled pid is a real if unlikely thing.
 */
function reapOrphan(s: Spec, log: Log): boolean {
  let pid = 0;
  try {
    pid = Number(readFileSync(pidPath(s), "utf8").trim());
  } catch {
    return false;
  }
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    try {
      unlinkSync(pidPath(s));
    } catch {
      /* already gone */
    }
    return false;
  }
  log(`reaping an orphaned ${s.label} (pid ${pid}) left by a hard kill of the API`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* it went away between the two calls */
  }
  try {
    unlinkSync(pidPath(s));
  } catch {
    /* already gone */
  }
  return true;
}

/* --------------------------------------------------------------- the process */

/**
 * Which managed agent is running, if any.
 *
 * The whole of the "only one" rule on the process side. It is a question about
 * CHILDREN rather than about the chat setting, because two agents can both be
 * running with only one of them chosen — and it is the running that costs the
 * fan and the tokens.
 */
export function runningAgent(): AgentId | null {
  for (const id of AGENT_IDS) if (RUNTIME[id].child) return id;
  return null;
}

/**
 * Start one.
 *
 * The singleton guard is `child`, and every path that could spawn one comes
 * through here — the route, the crash restarter and the boot resumer.
 *
 * THE SECOND AGENT IS REFUSED WHILE THE FIRST RUNS, and this is the one place
 * that rule can be enforced cheaply. Two agents on one laptop is two model
 * bills and two copies of a several-hundred-megabyte runtime for a chat box
 * that will only ever ask one of them — `chat.backend` names a single
 * answerer, so the other is not even reachable. The refusal names the running
 * one and what to do about it, rather than starting it anyway and letting the
 * owner discover the cost on a graph.
 */
export async function start(id: AgentId): Promise<{ ok: boolean; error?: string }> {
  const s = SPECS[id];
  const r = RUNTIME[id];
  const log = logger(s);

  if (!r.installed) return { ok: false, error: `${s.label} is not installed here yet.` };
  if (r.child) return { ok: true };
  if (r.starting) return { ok: true };

  const other = runningAgent();
  if (other && other !== id)
    return {
      ok: false,
      error:
        `${SPECS[other].label} is running, and only one managed agent runs at a ` +
        `time. Stop it first — two agents thinking on one laptop is two model ` +
        `bills, and only one of them can be the chat backend anyway.`,
    };

  r.starting = true;
  try {
    /* ---- the config, BEFORE the spawn, and a refusal if there is nothing to
       point it at. An agent started against no provider comes up perfectly and
       fails on its first message with an error from inside its own harness,
       which is a long way from the thing that needs fixing. */
    try {
      const pl = await plan(s);
      s.configure(s, pl);
      r.pointed = pl.pointed;
      r.fingerprint = fingerprint(pl);
      log(`configured for ${pl.pointed.providerLabel} · ${pl.model} at ${pl.baseUrl}`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setState(id, r.installed ? "installed" : "absent", why);
      return { ok: false, error: why };
    }

    /*
      SOMEBODY ELSE ON THE PORT IS ITS OWN SENTENCE. It is the ordinary way
      this fails — a second copy of the dashboard, an agent started by hand —
      and "the child exited immediately" is a terrible way to learn it. The one
      case that is ours is an orphan from a `kill -9`, and that is reaped
      rather than reported.
    */
    if (await portBusy(s.port)) {
      if (!reapOrphan(s, log)) {
        const why =
          `Something is already listening on 127.0.0.1:${s.port}. That is either ` +
          `another copy of this instance or an unrelated service — this will not ` +
          `take a port it did not open.`;
        setState(id, "failed", why);
        log(`! ${why}`);
        return { ok: false, error: why };
      }
      await new Promise((r2) => setTimeout(r2, 500));
    }

    r.wanted = true;
    r.failedStarts = 0;
    setConfig(id, INSTANCE_KEY, "running");
    spawnChild(id);
    return { ok: true };
  } finally {
    r.starting = false;
  }
}

/**
 * HOW THE GATEWAY IS ACTUALLY LAUNCHED, which is the whole of this app's
 * OS-level containment and is therefore worth being explicit about.
 *
 * THREE THINGS, IN ORDER OF HOW MUCH THEY BUY:
 *
 *   THE ENVIRONMENT IS BUILT, NOT INHERITED. `childEnv` gives a PATH, a HOME
 *   inside DATA_DIR and a locale, and nothing else. That has been true since
 *   this file was written and the header above says why.
 *
 *   THE WORKING DIRECTORY IS AN EMPTY DIRECTORY OF ITS OWN, under
 *   `data/agent-home/<id>`, rather than the agent's install root. Nothing the
 *   gateway runs needs a particular cwd — every path in `cmd` is absolute —
 *   and a tool the agent shells out to that writes a relative file writes it
 *   somewhere disposable instead of into the installation.
 *
 *   AND, IF THE OWNER HAS ASKED FOR IT, ANOTHER OS ACCOUNT. `sudo -n -u
 *   <user>` with the environment passed through `env`, because sudo discards
 *   the parent's. `-n` rather than a prompt: this process has no terminal, and
 *   a sudo that blocked on a password would present as an agent that starts
 *   and never answers. The failure is sudo's own message in the agent log,
 *   which is the right place for it.
 *
 * IT IS OFF BY DEFAULT AND THE DEFAULT IS UNCHANGED. With no `OPC_AGENT_USER`
 * setting and no environment variable, this returns exactly the spawn this
 * file always did, one directory to the left.
 */
function launchPlan(s: Spec, cmd: { file: string; args: string[]; env: Record<string, string> }) {
  const cwd = agentWorkDir(s.id);
  const env = childEnv(s, cmd.env);
  const user = agentUser();
  if (!user || user === userInfo().username) return { file: cmd.file, args: cmd.args, cwd, env, as: null as string | null };
  /* `env` takes KEY=VALUE pairs; nothing here can hold a secret — the gateway
     reads its key out of a file in its own home — so nothing lands in `ps`
     that was not already in the environment of a process that user owns. */
  const pairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return {
    file: "sudo",
    args: ["-n", "-u", user, "-H", "env", ...pairs, cmd.file, ...cmd.args],
    cwd,
    env,
    as: user,
  };
}

function spawnChild(id: AgentId) {
  const s = SPECS[id];
  const r = RUNTIME[id];
  const log = logger(s);
  const cmd = s.command(s);
  const launch = launchPlan(s, cmd);

  setState(id, "starting", null);
  log(
    `starting: ${cmd.file} ${cmd.args.join(" ")}` +
      (launch.as ? ` — as ${launch.as} through sudo, cwd ${launch.cwd}` : ` — cwd ${launch.cwd}`),
  );

  const proc = spawn(launch.file, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  r.child = proc;
  try {
    writeFileSync(pidPath(s), String(proc.pid ?? ""));
  } catch {
    /* Not fatal: the pid file is the belt for the `kill -9` case, and the
       braces — SIGTERM on every ordinary exit path — are at the bottom. */
  }

  const take = (buf: Buffer) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) log(line.trimEnd());
  };
  proc.stdout?.on("data", take);
  proc.stderr?.on("data", take);

  proc.on("error", (err) => {
    log(`! ${err.message}`);
    setState(id, "failed", err.message);
  });

  proc.on("exit", (code, signal) => {
    if (r.child !== proc) return; // already replaced; an old one exiting
    r.child = null;
    r.healthyAt = null;
    try {
      unlinkSync(pidPath(s));
    } catch {
      /* already gone */
    }
    const how = signal ? `signal ${signal}` : `code ${code}`;
    log(`exited (${how})`);

    if (!r.wanted) {
      setState(id, "stopped", null);
      return;
    }

    /*
      A CRASH IS RESTARTED; A BROKEN INSTALL IS NOT RESTARTED FOREVER. An agent
      that has been healthy and then died is a thing to bring back — that is
      what a supervisor is for. One that has never come up is failing for a
      reason that will not change on the fifth attempt, and restarting it in a
      loop would spend the machine to keep saying so.
    */
    r.failedStarts += 1;
    if (r.failedStarts >= 5) {
      r.wanted = false;
      const why =
        `${s.label} exited ${r.failedStarts} times without ever answering on ` +
        `127.0.0.1:${s.port} (${how}). The log below is the last thing it said.`;
      setState(id, "failed", why);
      log(`! ${why}`);
      return;
    }
    const wait = Math.min(1000 * 2 ** (r.failedStarts - 1), 60_000);
    setState(id, "starting", `Exited with ${how}; restarting in ${Math.round(wait / 1000)}s.`);
    r.restarts += 1;
    const timer = setTimeout(() => {
      if (r.wanted && !r.child) spawnChild(id);
    }, wait);
    timer.unref();
  });

  void waitForHealth(id, proc);
}

/**
 * Poll the agent's own door until it answers, and connect the plugin the first
 * time it does.
 *
 * Tied to the process it was spawned for, so a health check still outstanding
 * when a crash restarts the agent cannot mark the NEW process healthy on the
 * strength of the old one's port.
 *
 * NINETY SECONDS IS NOT GENEROUS FOR HERMES. Its gateway loads a tool registry,
 * a skills index and a model catalogue before it listens; measured cold on this
 * machine that is around twenty seconds, and a cold page cache makes it worse.
 */
async function waitForHealth(id: AgentId, proc: ChildProcess) {
  const s = SPECS[id];
  const r = RUNTIME[id];
  const log = logger(s);
  const key = doorKey(s);
  const deadline = Date.now() + 120_000;
  while (r.child === proc && Date.now() < deadline) {
    if (await s.probe(s, key)) {
      r.healthyAt = new Date().toISOString();
      r.failedStarts = 0;
      setState(id, "running", null);
      log(`healthy on ${s.url}`);
      await autoConnect(id);
      return;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (r.child === proc && r.state === "starting")
    /* Still alive and still not answering. Not killed: a slow first boot on a
       cold machine is a real thing, and the state says what is true rather
       than deciding for the owner. */
    setState(id, "starting", `Started, but nothing has answered on 127.0.0.1:${s.port} yet.`);
}

/**
 * Stop it, and mean it.
 *
 * SIGTERM first, because both agents close their listener on it and a killed
 * process leaves the port in a state the next start has to wait out. SIGKILL
 * after the grace, because a shutdown that can be refused is not a shutdown —
 * and the one thing this file must never do is leave a child holding 8642 or
 * 18789 after the API that owns it has gone.
 */
export async function stop(id: AgentId, reason = "asked to stop"): Promise<void> {
  const r = RUNTIME[id];
  r.wanted = false;
  setConfig(id, INSTANCE_KEY, "stopped");
  await kill(id, reason);
  setState(id, "stopped", null);
}

const GRACE_MS = 8000;

function kill(id: AgentId, reason: string): Promise<void> {
  const s = SPECS[id];
  const r = RUNTIME[id];
  const proc = r.child;
  if (!proc) return Promise.resolve();
  logger(s)(`stopping — ${reason}`);
  r.child = null;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(hard);
      try {
        unlinkSync(pidPath(s));
      } catch {
        /* already gone */
      }
      resolve();
    };
    const hard = setTimeout(() => {
      logger(s)("! did not exit on SIGTERM — killing");
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

/* -------------------------------------------------------------- auto-connect */

/**
 * The agent is up, so connect the plugin to it — without anybody pasting
 * anything.
 *
 * THIS IS THE WHOLE POINT OF THE FEATURE. "Spawn here" has to end with a
 * connected integration, not with a running process and a form still asking
 * for a URL and a key that the owner would have to go and find in a config
 * file this app wrote.
 *
 * IT GOES THROUGH THE REMOTE ADAPTER'S OWN `verify()`, which is the thing that
 * makes this trustworthy rather than optimistic. A managed connect proves
 * exactly what a pasted one proves — the address is a server, it speaks this
 * API, it accepts this bearer, and it lists something to ask — and it proves
 * it with the same code, so the two paths cannot drift into disagreeing about
 * what "connected" means.
 *
 * IT GETS ITS OWN ACCOUNT AND NEVER OVERWRITES A PASTED ONE. An owner with a
 * remote Hermes already connected has a credential in the vault that this must
 * not touch; the managed instance is a second account, its id is written to
 * `managedAccount`, and `mode` decides which of the two answers a chat turn.
 * The adapters read both — see the note in each `answering()`.
 */
async function autoConnect(id: AgentId) {
  const s = SPECS[id];
  const log = logger(s);
  const key = doorKey(s);

  const checked = await s.connect(s, key);
  if (!checked.ok) {
    log(`! running, but the plugin would not connect: ${checked.error}`);
    setState(id, "running", checked.error);
    return;
  }

  if (!getPlugin(id)) upsertPlugin(id, false, null);

  const existingId = Number(configValue(id, MANAGED_ACCOUNT_KEY) ?? 0);
  const existing = existingId ? accounts.get(existingId) : undefined;
  const account =
    existing && existing.pluginId === id
      ? existing
      : accounts.create(id, `Managed instance (${s.label} here)`);

  const fields = id === "hermes" ? [...hermesAdapter.FIELDS] : [...openclawAdapter.FIELDS];
  accounts.writeCredentials(account, id, fields, checked.values);

  setConfig(id, MANAGED_ACCOUNT_KEY, String(account.id));
  setConfig(id, MODE_KEY, "managed");
  log(`connected — ${s.url}, answering as ${s.advertises}`);
}

/* ---------------------------------------------------------------- the mode */

/**
 * Which credential answers: the managed instance, or a pasted remote one.
 *
 * A SETTING RATHER THAN AN INFERENCE. "Whichever is connected" breaks the
 * moment both are, and "whichever is newest" makes the answer change when
 * somebody re-pastes a key. The adapters read this and prefer the account
 * named in `managedAccount` when it says `managed`; anything else is the old
 * first-connected-account rule, unchanged.
 */
export function readMode(id: AgentId): "managed" | "remote" {
  return configValue(id, MODE_KEY) === "managed" ? "managed" : "remote";
}

export function writeMode(id: AgentId, mode: "managed" | "remote") {
  if (!getPlugin(id)) upsertPlugin(id, false, null);
  setConfig(id, MODE_KEY, mode);
}

/* -------------------------------------------------------------------- report */

export type AgentReport = {
  id: AgentId;
  label: string;
  state: InstanceState;
  since: string;
  step: string | null;
  lastError: string | null;
  /** Where it answers when it is up. Loopback, always. */
  url: string;
  port: number;
  /** The name it advertises on its own `/v1/models`. */
  advertises: string;
  version: string | null;
  commit: string | null;
  installedAt: string | null;
  installSeconds: number | null;
  dir: string;
  pid: number | null;
  healthyAt: string | null;
  restarts: number;
  /** What the owner last asked for, which survives a restart of the API. */
  autostart: boolean;
  /** Managed or remote — which credential a chat turn actually uses. */
  mode: "managed" | "remote";
  /** The account this file created, if it has. */
  managedAccount: number | null;
  /** What the agent was last configured to talk to. NEVER the key: there is no
   *  field on this type that could hold one. */
  pointed: Pointed | null;
  /** Whether this one is the live chat backend right now. */
  live: boolean;
  log: string[];
};

export function report(id: AgentId, live: AgentId | null): AgentReport {
  const s = SPECS[id];
  const r = RUNTIME[id];
  return {
    id,
    label: s.label,
    state: r.state,
    since: r.since,
    step: r.step,
    lastError: r.lastError,
    url: s.url,
    port: s.port,
    advertises: s.advertises,
    version: r.installed?.version ?? null,
    commit: r.installed?.commit ?? null,
    installedAt: r.installed?.installedAt ?? null,
    installSeconds: r.installed?.seconds ?? null,
    dir: s.root,
    pid: r.child?.pid ?? null,
    healthyAt: r.healthyAt,
    restarts: r.restarts,
    autostart: configValue(id, INSTANCE_KEY) === "running",
    mode: readMode(id),
    managedAccount: Number(configValue(id, MANAGED_ACCOUNT_KEY) ?? 0) || null,
    pointed: r.pointed,
    live: live === id,
    log: r.tail.slice(-80),
  };
}

/** Is this agent's managed instance the thing that would answer right now?
 *  Read by the route so it can say "running, but not in use". */
export function isRunning(id: AgentId): boolean {
  return RUNTIME[id].state === "running" && RUNTIME[id].child !== null;
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
 * Then, if an agent was running when the API last stopped, it starts again.
 * That flag is the owner's own last instruction, written to `plugin_config` by
 * start() and stop() — not a heuristic about what was running, which is a
 * thing a crashed process cannot report anyway. Only ONE is resumed, for the
 * same reason only one can be started.
 */
export function boot() {
  for (const id of AGENT_IDS) {
    const s = SPECS[id];
    const r = RUNTIME[id];
    r.installed = readMarker(s);
    setState(id, r.installed ? "installed" : "absent", null);
  }

  arrangeShutdown();

  for (const id of AGENT_IDS) {
    if (!RUNTIME[id].installed) continue;
    if (configValue(id, INSTANCE_KEY) !== "running") continue;
    if (runningAgent()) break; // only one, even at boot
    logger(SPECS[id])("was running when the API last stopped — starting again");
    void start(id);
  }

  watchProvider();
  watchSkills();
}

/**
 * Keep a running agent pointed at the CURRENT default provider.
 *
 * `PUT /api/models/provider` is a route in another file and this one has no
 * business hooking it, so the seam is a poll rather than a callback: every
 * fifteen seconds a running agent's provider is resolved again and compared
 * with the fingerprint its config was written from. A change means the config
 * on disk is stale, and `reconfigure` rewrites it and restarts the child.
 *
 * FIFTEEN SECONDS IS CHEAP because `activeProvider()` is a config read and a
 * factory call — no HTTP, no vault read — for as long as the provider names
 * its own default model. It costs one `/models` request only for a provider
 * that names none, which is the same request a completion would make.
 *
 * The timer is `unref`'d, so it cannot hold the process open.
 */
function watchProvider() {
  /*
    THE CHANGE HAS TO HOLD STILL FIRST, and this is not a nicety — it was
    observed. Restarting the instant `activeProvider()` differs means an owner
    trying three providers in a minute restarts the agent three times, and a
    restart that lands mid-turn ends that turn: the reply that came back said
    "Operation interrupted: waiting for model response (8.2s elapsed)", which
    is a true sentence about a thing this file did to itself.

    So a new fingerprint is REMEMBERED rather than acted on, and acted on only
    once it has survived the settle window. A flip-flop back to the running
    config cancels the pending change entirely, which is the common case: the
    agent never notices.
  */
  const SETTLE_MS = 60_000;
  const pending: Partial<Record<AgentId, { print: string; since: number }>> = {};

  const timer = setInterval(() => {
    void (async () => {
      for (const id of AGENT_IDS) {
        const r = RUNTIME[id];
        if (!r.child || r.state !== "running" || !r.fingerprint) {
          delete pending[id];
          continue;
        }
        let print: string;
        try {
          print = fingerprint(await plan(SPECS[id]));
        } catch {
          /* The provider has gone away entirely. That is not a reason to
             restart an agent that is currently answering — it is a reason for
             the next message to fail with the provider's own error, which is
             the one that names what to fix. */
          delete pending[id];
          continue;
        }
        if (print === r.fingerprint) {
          delete pending[id];
          continue;
        }
        const seen = pending[id];
        if (!seen || seen.print !== print) {
          pending[id] = { print, since: Date.now() };
          continue;
        }
        if (Date.now() - seen.since < SETTLE_MS) continue;
        delete pending[id];
        await reconfigure(id);
      }
    })();
  }, 15_000);
  timer.unref();
}

/**
 * Keep the installed SKILL PACKS in step with what is connected.
 *
 * A POLL RATHER THAN A CALLBACK ON `upsertPlugin`, and that is not laziness —
 * a callback would be WRONG for three of these plugins. npm, Reddit and Hacker
 * News have no credential at all: "connected" for them means "there is a list
 * in `plugin_config`", written by a route that never touches the plugins
 * table. Hooking the credential door would therefore keep the packs in step for
 * twenty-four integrations and silently miss the three whose connection is a
 * setting — and a skills mechanism that is right most of the time is one nobody
 * can trust to be right about the case in front of them. The registry's own
 * `skills()` already answers the question exactly; this asks it on a timer.
 *
 * IT USES THE SAME SETTLE WINDOW AS `watchProvider` ABOVE, for the same reason
 * and with the same evidence behind it: an owner connecting three integrations
 * in a minute would otherwise restart the agent three times, and a restart that
 * lands mid-turn ends that turn.
 *
 * AND A RESTART IS UNAVOIDABLE WHEN THE SET CHANGES — this was measured rather
 * than assumed. Hermes builds the "## Skills" block of its system prompt once
 * and caches it in `_SKILLS_PROMPT_CACHE`, keyed on the skills DIRECTORY, the
 * tool list and the platform (agent/prompt_builder.py). The disk snapshot
 * beside it is invalidated correctly by a file manifest, and the `skills_list`
 * TOOL re-scans every thirty seconds — but the in-process prompt cache has no
 * key that a new file changes, so a running gateway goes on advertising the
 * set it started with for the life of the process. The agent would still find
 * a new pack if it thought to call `skills_list`; it has no reason to, because
 * nothing in its prompt says the pack exists. So: sync, and if the set actually
 * moved and a child is up, bounce it. Nothing is restarted for a sync that
 * wrote nothing, which is the ordinary case.
 *
 * OpenClaw also needs its per-skill MCP server configuration updated. A new
 * plugin has no server in the old configuration, so re-listing existing MCP
 * servers cannot discover it. Sync the managed entries and restart when changed.
 */
function watchSkills() {
  const SETTLE_MS = 60_000;
  let acted = liveFingerprint();
  let pending: { print: string; since: number } | null = null;
  let syncing = false;

  const timer = setInterval(() => {
    if (syncing) return;
    void (async () => {
      const print = liveFingerprint();
      if (print === acted) {
        pending = null;
        return;
      }
      if (!pending || pending.print !== print) {
        pending = { print, since: Date.now() };
        return;
      }
      if (Date.now() - pending.since < SETTLE_MS) return;
      syncing = true;
      try {
        for (const id of AGENT_IDS) {
          const s = SPECS[id];
          const r = RUNTIME[id];
          if (!r.installed) continue;
          const changed = id === "hermes"
            ? syncHermesSkills(join(hermesHome(s), "skills"), { cli: join(cliBinDir(s), "opc") }).changed
            : syncOpenClawSkills(join(s.home, ".openclaw", "openclaw.json"));
          if (!changed) continue;
          logger(s)("skills: updated the connected integrations");
          if (!r.child) continue;
          logger(s)("restarting so the connected skill set reaches the agent");
          await kill(id, "the connected skill set changed");
          spawnChild(id);
        }
        acted = print;
        pending = null;
      } catch (err) {
        console.error("Could not sync agent skills:", err instanceof Error ? err.message : String(err));
      } finally {
        syncing = false;
      }
    })();
  }, 15_000);
  timer.unref();
}

let arranged = false;

/**
 * NO ORPHANS. Every way this process can end, spelled out.
 *
 * SIGINT and SIGTERM are the ordinary ones (Ctrl-C, a service manager, a
 * `kill`), and both are given the grace period before the process exits. The
 * `exit` handler is the last resort and can only do synchronous work, so it
 * sends SIGKILL rather than SIGTERM: by then there is no event loop left to
 * wait for a polite exit in. A managed agent left holding 8642 after the API
 * has gone is the exact state that makes the next start fail on a port it
 * cannot explain — and, unlike a search node, it is also several hundred
 * megabytes of Python sitting there thinking nobody asked for.
 */
function arrangeShutdown() {
  if (arranged) return;
  arranged = true;

  const bye = (signal: NodeJS.Signals) => {
    void (async () => {
      await Promise.all(AGENT_IDS.map((id) => kill(id, `the API received ${signal}`)));
      process.exit(0);
    })();
  };
  process.once("SIGINT", () => bye("SIGINT"));
  process.once("SIGTERM", () => bye("SIGTERM"));
  process.on("exit", () => {
    for (const id of AGENT_IDS) {
      const r = RUNTIME[id];
      const proc = r.child;
      r.child = null;
      if (!proc) continue;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        unlinkSync(pidPath(SPECS[id]));
      } catch {
        /* already gone */
      }
    }
  });
}
