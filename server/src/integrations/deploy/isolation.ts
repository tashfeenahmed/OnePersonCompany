/**
 * HOW WELL THE AGENT IS BOXED IN, MEASURED RATHER THAN CLAIMED.
 *
 * THE SENTENCE THIS FILE EXISTS TO REPLACE. The README said, correctly: "This
 * is an API permission boundary: an unrestricted agent under the same OS
 * account can still modify the database or read credential files. OS-level
 * isolation is not implemented." That was honest and it was the whole of the
 * gap. What it is NOT is a single switch — there are separable things an agent
 * can be prevented from doing, they cost different amounts of the owner's
 * time, and pretending they are one setting would produce a page that says
 * "secure" on a box where nothing changed.
 *
 * SO THERE ARE TWO LEVELS THIS FILE CAN MEASURE, AND THE PAGE NAMES THE ONE
 * YOU ARE ON:
 *
 *   `same-user`   — the default and what every existing install has. The
 *                   gateway runs as the owner, with a minimal environment and
 *                   a working directory of its own under `agent-home/`. It
 *                   cannot see this process's environment; it CAN read
 *                   `vault.key` and the database, because the filesystem says
 *                   it may. The API boundary is real — the owner surface is
 *                   refused to anything that cannot show it is the owner — and
 *                   the filesystem one is not.
 *   `separate-user` — the gateway runs as another OS account which owns only
 *                   the agent home. `vault.key`, the database and the owner
 *                   key are unreadable to it because they are 0600 and owned
 *                   by somebody else. This is the level the gap list asks for
 *                   and it costs one `sudo` script, once.
 *
 * THE SCOPED KEY IS A PROPERTY RATHER THAN A LEVEL. It is true at both — the
 * agent holds a key that is refused on the owner surface — and on a same-user
 * box it is not a boundary of its own, because a process that can read
 * `service-key` can present it.
 *
 * A CONTAINER IS NOT A LEVEL HERE, and the honesty is the point. It is a
 * genuinely stronger arrangement and `deploy/agent.Dockerfile` describes it,
 * but nothing in this app builds it, starts it, or looks to see whether the
 * gateway is a child of this process — so there is no measurement to report,
 * and a level nothing can produce is a claim the page would be making on the
 * strength of a type. It is reported as `containerPath`, which says exactly
 * that.
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
import { AGENT_HOME, AGENT_KEY_FILE, SERVICE_KEY_FILE, agentKeyProblemNote } from "../../auth.ts";
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
  /** Open wider than this file is meant to be. For everything but the agent
   *  key that means any group or world bit; for the agent key, which is
   *  group-readable on purpose, it means a world bit. */
  readableByOthers: boolean | null;
  intended: string;
};

/**
 * THE AGENT KEY IS THE ONE FILE THAT IS SUPPOSED TO BE GROUP-READABLE.
 *
 * Everything else here is read by exactly one process and is 0600. The agent
 * key has two readers at the `separate-user` level — this API writes it, the
 * agent's `opc` wrapper reads it — so 0640 with a shared group is the design
 * rather than a slip, and a check that flagged it would train the owner to
 * ignore this list. World-readable is still wrong for it, and is flagged.
 */
function tooOpen(path: string, mode: number): boolean {
  /* THE DATA DIRECTORY IS NOT A SECRET AND IS NOT JUDGED AS ONE. It is on this
     list because its path is worth showing, not because 0755 on it is wrong —
     what matters is the mode of the files inside, which are the rows above it.
     It was already excluded from the `secretsLocked` verdict; drawing it in
     orange anyway was the page contradicting its own summary. */
  if (path === DATA_DIR) return false;
  return path === AGENT_KEY_FILE ? (mode & 0o007) !== 0 : (mode & 0o077) !== 0;
}

/** What each file is supposed to be, said on the row so a reader can see why
 *  0640 is right on one line and wrong on the next. */
function intendedMode(path: string): string {
  if (path === AGENT_KEY_FILE) return "0640 — owner writes, agent group reads";
  if (path === DATA_DIR) return "a directory; the files inside are what matter";
  return "0600 — this process only";
}

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
      readableByOthers: tooOpen(path, mode),
      /** What this file is supposed to be, so the page can say why 0640 is
       *  fine on one row and not on the next. */
      intended: intendedMode(path),
    };
  } catch {
    return {
      path,
      present: existsSync(path),
      mode: null,
      uid: null,
      ownedByThisUser: null,
      readableByOthers: null,
      intended: intendedMode(path),
    };
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

/**
 * THE LEVELS THIS FILE CAN ACTUALLY MEASURE, WHICH IS TWO.
 *
 * There was a third, `container`, and it was removed rather than left
 * unreachable. Nothing here inspects whether the gateway is a child of this
 * process, so `container` could never have been returned — and a level in a
 * union that no code path produces is a claim the page makes on the strength
 * of a type. The container path still exists as documentation
 * (`deploy/agent.Dockerfile`), and `containerPath` below says plainly that it
 * is a thing the owner does by hand and this app does not observe.
 */
export type Level = "same-user" | "separate-user";

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
  /** True when every credential file is no wider than it is meant to be —
   *  0600 for the three this process alone reads, no world bits on the agent
   *  key, which is group-readable by design. */
  secretsLocked: boolean;
  /** The API-level half, which is true at every level. */
  scopedKey: { file: string; refusedPrefixes: typeof OWNER_SURFACE_PREFIXES };
  /** Set when the agent key file cannot be read or written by this process —
   *  a wrong `chown`, most likely. The agent is then locked out at the gate
   *  and the page has to say so rather than let it be discovered. */
  agentKeyProblem: string | null;
  /**
   * THE CONTAINER PATH IS DOCUMENTATION, NOT A MEASUREMENT, and this field is
   * shaped to say that. `runtime` is only "there is a docker or podman binary
   * on this machine"; `observed` is always false because nothing here inspects
   * whether the gateway is a child of this process, and a level that cannot be
   * observed is not offered as one.
   */
  containerPath: { runtime: string | null; observed: false; note: string };
  /** What would actually change if the owner moved up a level. */
  nextStep: string;
  note: string;
};

/**
 * The level, as a pure function of the two names.
 *
 * Split out of `isolation()` so a test can assert it without depending on
 * whether the machine running the suite happens to have `OPC_AGENT_USER` set —
 * which the first version of that test did, and which would have failed on
 * exactly the box the feature is for.
 */
export function levelFor(configured: string | null, running: string): { level: Level; problem: string | null } {
  if (configured && configured !== running)
    return {
      level: "separate-user",
      problem:
        process.platform !== "darwin" && process.platform !== "linux"
          ? `A separate agent user is configured (${configured}) but ${process.platform} has no sudo path this app knows how to use, so the gateway will still run as ${running}.`
          : null,
    };
  if (configured && configured === running)
    return {
      level: "same-user",
      problem: `The agent user setting names this same account (${running}), which is not isolation. Leave it empty, or create a separate user with deploy/agent-user.sh.`,
    };
  return { level: "same-user", problem: null };
}

export function isolation(): Isolation {
  const running = userInfo().username;
  const configured = agentUser();
  const files = [facts(VAULT_KEY_FILE), facts(SERVICE_KEY_FILE), facts(AGENT_KEY_FILE), facts(DB_FILE), facts(DATA_DIR)];
  const secrets = files.filter((f) => f.path !== DATA_DIR && f.present);
  const secretsLocked = secrets.length > 0 && secrets.every((f) => f.readableByOthers === false);

  const { level, problem } = levelFor(configured, running);

  const summary =
    level === "separate-user"
      ? `The managed gateway is spawned as ${configured} through sudo. That account owns the agent home and nothing else here, so vault.key, the database and the owner service key are unreadable to it.`
      : `The managed gateway runs as ${running}, the same account as this API. It gets a minimal environment and its own working directory, and it holds only the scoped agent key — but the FILESYSTEM does not stop it reading vault.key or the database. This is the shipped configuration and it is honest about what it is.`;

  const nextStep =
    level === "separate-user"
      ? "This is the strongest level this app can observe. Stronger still is running the gateway in a container (deploy/agent.Dockerfile) — nothing mounted, the API over the network — but that is a manual path this app does not drive and will not report, and it takes the agent's shell on your machine away with it."
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
    agentKeyProblem: agentKeyProblemNote(),
    containerPath: {
      runtime: containerRuntime(),
      observed: false,
      note:
        "Running the gateway in a container is a documented manual path (deploy/agent.Dockerfile) and this app " +
        "does not drive it, does not detect it, and will never report it as a level. `runtime` is only whether a " +
        "docker or podman binary exists here. It also needs the API reachable from the container, which it is " +
        "not by default — this server binds 127.0.0.1; the compose file says what to do about that.",
    },
    nextStep,
    note:
      "Every field here is READ from this machine — file modes come from stat, the level from comparing the " +
      "configured user with the running one. Nothing is a claim about what was intended, and there is no level " +
      "here that nothing can produce. `same-user` is not a misconfiguration: it is the default, it is what a " +
      "personal box on loopback wants, and the API boundary holds at both levels.",
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
      if (!tooOpen(path, mode)) continue;
      /* THE AGENT KEY KEEPS ITS GROUP BIT. Clearing only the world bits there,
         rather than forcing 0600, is what stops this boot pass from undoing
         the `separate-user` setup on every restart — the agent account reads
         that file through its group. */
      const next = path === AGENT_KEY_FILE ? mode & 0o770 : 0o600;
      chmodSync(path, next);
      changed.push({ path, from: mode.toString(8).padStart(4, "0"), to: next.toString(8).padStart(4, "0") });
    } catch {
      /* A file that is not there yet, or that this user does not own, is not
         something to take the boot down over. */
    }
  }
  return changed;
}
