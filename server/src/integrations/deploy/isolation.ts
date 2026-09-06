/**
 * HOW WELL THE AGENT IS BOXED IN, MEASURED RATHER THAN CLAIMED.
 *
 * THE SENTENCE THIS FILE EXISTS TO REPLACE. The README said, correctly: "This
 * is an API permission boundary: an unrestricted agent under the same OS
 * account can still modify the database or read credential files. OS-level
 * isolation is not implemented." That was honest and it was the whole of the
 * gap. What it is NOT is a single switch — there are three separable things
 * an agent can be prevented from doing, they cost different amounts of the
 * owner's time, and pretending they are one setting would produce a page that
 * says "secure" on a box where nothing changed.
 *
 * SO THERE ARE FOUR LEVELS AND THE PAGE NAMES THE ONE YOU ARE ON:
 *
 *   `same-user`   — the default and what every existing install has. The
 *                   gateway runs as the owner, with a minimal environment and
 *                   a working directory of its own under `agent-home/`. It
 *                   cannot see this process's environment; it CAN read
 *                   `vault.key` and the database, because the filesystem says
 *                   it may. The API boundary is real — the agent key is
 *                   refused on the owner surface — and the filesystem is not.
 *   `scoped-key`  — the above, plus the agent holding only the scoped key. It
 *                   is not a level of its own on a same-user box (a process
 *                   that can read `service-key` can present it), which is why
 *                   this is reported as a PROPERTY rather than as a level.
 *   `separate-user` — the gateway runs as another OS account which owns only
 *                   the agent home. `vault.key`, the database and the owner
 *                   key are unreadable to it because they are 0600 and owned
 *                   by somebody else. This is the level the gap list asks for
 *                   and it costs one `sudo` script, once.
 *   `container`   — the gateway runs in Docker or Podman with nothing mounted
 *                   and the API reachable only over the network. Strongest,
 *                   and the one that changes what the agent can do for you:
 *                   no shell on your machine means no `git`, no `ffmpeg` and
 *                   no reading a file you asked it about.
 *
 * NOTHING HERE ENFORCES ANYTHING BY ITSELF. It reports what is true — file
 * modes read from the filesystem, the configured user compared with the
 * running one, whether a container runtime exists — and `agents/instance.ts`
 * is what actually spawns under another user. A page that reported an
 * intention rather than a measurement would be the most dangerous page in this
 * app.
 */
import { accessSync, chmodSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { AGENT_HOME, AGENT_KEY_FILE, SERVICE_KEY_FILE } from "../../auth.ts";
import { DATA_DIR, DB_FILE, VAULT_KEY_FILE } from "../../config.ts";
import { configValue } from "../../db.ts";
import { OWNER_SURFACE_PREFIXES } from "../security/gate.ts";

/** The pseudo-plugin the deployment settings hang off — `chat`'s trick, and
 *  named once here because the string is a foreign key value. */
export const PLUGIN = "deploy";
export const AGENT_USER_KEY = "agent_user";

/**
 * The OS account the gateway should run as, or null for "this one".
 *
 * THE ENVIRONMENT WINS OVER THE SETTING, which is the rule config.ts already
 * keeps for everything else on this box: a service unit that pins the agent
 * user is a fact about the deployment, and a row in a database somebody can
 * edit from a web page must not be able to quietly widen it.
 */
export function agentUser(): string | null {
  const fromEnv = (process.env.OPC_AGENT_USER ?? "").trim();
  if (fromEnv) return fromEnv;
  const fromConfig = (configValue(PLUGIN, AGENT_USER_KEY) ?? "").trim();
  return fromConfig || null;
}

/** Where a spawned agent's working directory lives. One per agent id, empty,
 *  and never the repository root: a tool the agent shells out to that writes a
 *  relative file writes it here. */
export function agentWorkDir(id: string): string {
  const dir = join(AGENT_HOME, id);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* A directory that cannot be made is reported by the spawn that follows,
       with the error the OS gave. */
  }
  return dir;
}

export type FileFacts = {
  path: string;
  present: boolean;
  /** The permission bits as four octal digits, or null if it could not be
   *  stat'd. Reported raw so a reader can disagree with the verdict. */
  mode: string | null;
  /** The numeric owner, and whether it is this process's user. */
  uid: number | null;
  ownedByThisUser: boolean | null;
  /** Group or world readable — the only bit that matters for a secret. */
  readableByOthers: boolean | null;
};

function facts(path: string): FileFacts {
  try {
    const s = statSync(path);
    const mode = s.mode & 0o7777;
    return {
      path,
      present: true,
      mode: mode.toString(8).padStart(4, "0"),
      uid: s.uid,
      ownedByThisUser: s.uid === (process.getuid?.() ?? -1),
      readableByOthers: (mode & 0o077) !== 0,
    };
  } catch {
    return { path, present: existsSync(path), mode: null, uid: null, ownedByThisUser: null, readableByOthers: null };
  }
}

/** Is a container runtime on this machine at all? The Docker path is offered
 *  only when something could run it. */
function containerRuntime(): string | null {
  for (const candidate of ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker", "/usr/bin/podman", "/opt/homebrew/bin/podman", "/usr/local/bin/podman"]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

export type Level = "same-user" | "separate-user" | "container";

export type Isolation = {
  level: Level;
  /** One sentence, in the words the README uses. */
  summary: string;
  /** The account this process runs as, and the one the agent is configured to
   *  run as. Equal on a default box. */
  runningAs: string;
  configuredAgentUser: string | null;
  /** Set when a separate user is configured but this platform or this process
   *  cannot honour it — the page must not claim isolation it does not have. */
  problem: string | null;
  agentHome: string;
  /** The four files whose modes decide what a same-user agent can read. */
  files: FileFacts[];
  /** True when every secret is 0600 and owned by this user. */
  secretsLocked: boolean;
  /** The API-level half, which is true at every level. */
  scopedKey: { file: string; refusedPrefixes: typeof OWNER_SURFACE_PREFIXES };
  containerRuntime: string | null;
  /** What would actually change if the owner moved up a level. */
  nextStep: string;
  note: string;
};

export function isolation(): Isolation {
  const running = userInfo().username;
  const configured = agentUser();
  const files = [facts(VAULT_KEY_FILE), facts(SERVICE_KEY_FILE), facts(AGENT_KEY_FILE), facts(DB_FILE), facts(DATA_DIR)];
  const secrets = files.filter((f) => f.path !== DATA_DIR && f.present);
  const secretsLocked = secrets.length > 0 && secrets.every((f) => f.readableByOthers === false);

  let level: Level = "same-user";
  let problem: string | null = null;
  if (configured && configured !== running) {
    level = "separate-user";
    if (process.platform !== "darwin" && process.platform !== "linux")
      problem = `A separate agent user is configured (${configured}) but ${process.platform} has no sudo path this app knows how to use, so the gateway will still run as ${running}.`;
  } else if (configured && configured === running) {
    problem = `The agent user setting names this same account (${running}), which is not isolation. Leave it empty, or create a separate user with deploy/agent-user.sh.`;
  }

  const summary =
    level === "separate-user"
      ? `The managed gateway is spawned as ${configured} through sudo. That account owns the agent home and nothing else here, so vault.key, the database and the owner service key are unreadable to it.`
      : `The managed gateway runs as ${running}, the same account as this API. It gets a minimal environment and its own working directory, and it holds only the scoped agent key — but the FILESYSTEM does not stop it reading vault.key or the database. This is the shipped configuration and it is honest about what it is.`;

  const nextStep =
    level === "separate-user"
      ? "Stronger than this is the container path: deploy/agent.Dockerfile runs the gateway with nothing mounted and the API reachable over the network only. It also takes the agent's shell away, which is a capability you may want."
      : `Run \`deploy/agent-user.sh\` once to create a dedicated account, then put its name in Settings → Deployment (or OPC_AGENT_USER in deploy/opc.env). Nothing else changes: the agent reaches this API over loopback with the same scoped key it already has.`;

  return {
    level,
    summary,
    runningAs: running,
    configuredAgentUser: configured,
    problem,
    agentHome: AGENT_HOME,
    files,
    secretsLocked,
    scopedKey: { file: AGENT_KEY_FILE, refusedPrefixes: OWNER_SURFACE_PREFIXES },
    containerRuntime: containerRuntime(),
    nextStep,
    note:
      "Every field here is READ from this machine — file modes come from stat, the level from comparing the " +
      "configured user with the running one. Nothing is a claim about what was intended. `same-user` is not a " +
      "misconfiguration: it is the default, it is what a personal box on loopback wants, and the API boundary " +
      "(the scoped agent key) holds at every level.",
  };
}

/**
 * Tighten the modes on the four files a same-user agent should not be reading
 * casually.
 *
 * IT IS NOT A SECURITY CONTROL ON A SAME-USER BOX and the isolation report
 * says so: a process running as the owner can chmod them back. It matters at
 * the `separate-user` level, where 0600 owned by the owner is exactly what
 * keeps the agent account out — and it costs four stat calls at boot to make
 * sure a file created before this rule existed is not 0644.
 */
export function hardenSecrets(): { path: string; from: string; to: string }[] {
  const changed: { path: string; from: string; to: string }[] = [];
  for (const path of [VAULT_KEY_FILE, SERVICE_KEY_FILE, AGENT_KEY_FILE, DB_FILE]) {
    try {
      const s = statSync(path);
      const mode = s.mode & 0o7777;
      if ((mode & 0o077) === 0) continue;
      chmodSync(path, 0o600);
      changed.push({ path, from: mode.toString(8).padStart(4, "0"), to: "0600" });
    } catch {
      /* A file that is not there yet, or that this user does not own, is not
         something to take the boot down over. */
    }
  }
  return changed;
}
