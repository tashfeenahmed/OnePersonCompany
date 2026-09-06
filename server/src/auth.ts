/**
 * THE SERVICE KEY — the one thing that keeps the agent working after the
 * owner puts a password on the door.
 *
 * WHY A SECOND CREDENTIAL EXISTS AT ALL. Owner authentication (see
 * integrations/security/) is a browser session in an HttpOnly cookie. Nothing
 * on this box that reads its own API has a browser: `opc` is a shell wrapper
 * the agent types, the MCP server is a subprocess speaking JSON-RPC on a pipe,
 * the skills proxy is this process calling itself over loopback, and a run's
 * brief is assembled by fetching six of its own routes. Every one of those is
 * a request with no cookie jar, and every one of them would 401 the moment a
 * password existed. A dashboard whose agent goes blind when you lock the front
 * door is a dashboard nobody locks.
 *
 * SO THE KEY IS A FILE, NOT A SETTING. `DATA_DIR/service-key`, 0600, thirty-two
 * random bytes as hex, created on first use and never rotated automatically.
 * It is a file rather than a row for one reason: the `opc` wrapper is two lines
 * of `sh` written by skills/cli.ts, and `$(cat …)` is the whole of what it
 * takes to read a file — where reading a database from a shell would mean a
 * second program. It is read at every invocation rather than baked into the
 * wrapper, so replacing the file is all it takes to rotate: nothing has to be
 * rewritten and no agent has to be restarted.
 *
 * WHAT THE KEY IS WORTH, said plainly. Anything that can read
 * `server/data/service-key` has the whole API — the same statement that is
 * already true of `server/data/vault.key`, which sits beside it and decrypts
 * every credential on the box. This is a door lock for a machine on a LAN, not
 * a permission system: there are no scopes, no expiry and no audit of which
 * caller used it. Adding scopes would be inventing a security model this app
 * does not have and cannot enforce, and a scope nobody checks is worse than no
 * scope at all.
 *
 * IT IS ALWAYS SENT, EVEN WITH NO PASSWORD SET. Every loopback call site here
 * adds the header unconditionally, because a header the gate is not looking at
 * costs nothing and a header added only "when auth is on" is a header whose
 * absence is discovered at the worst moment — the first request after the
 * owner typed a password.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./config.ts";

/** Where the key lives. Inside DATA_DIR, which is gitignored and which the
 *  nightly backup archives — see the README's warning about what that archive
 *  is worth to whoever holds it. */
export const SERVICE_KEY_FILE = resolve(DATA_DIR, "service-key");

/** The header a caller sends it in. `Authorization: Bearer <key>` is accepted
 *  as well, because half the things that call an HTTP API only know how to
 *  spell that one. */
export const SERVICE_HEADER = "x-opc-key";

let cached: string | null = null;

/**
 * The key, read from disk — minted on the first call if the file is not there.
 *
 * Memoised for the life of the process, which is a deliberate trade: replacing
 * the file rotates the key for every CHILD (they read it per invocation) and
 * for this process only at the next restart. Every edit under src restarts this
 * server anyway, and a key re-read on every request would be a file open per
 * loopback call.
 */
export function serviceKey(): string {
  if (cached) return cached;
  try {
    if (existsSync(SERVICE_KEY_FILE)) {
      const raw = readFileSync(SERVICE_KEY_FILE, "utf8").trim();
      if (raw) {
        chmodSync(SERVICE_KEY_FILE, 0o600);
        cached = raw;
        return raw;
      }
    }
  } catch {
    /* An unreadable key file is treated as an absent one and rewritten. The
       alternative — throwing — would take the whole API down over a file that
       only matters once a password exists. */
  }
  const minted = randomBytes(32).toString("hex");
  writeFileSync(SERVICE_KEY_FILE, `${minted}\n`, { mode: 0o600 });
  chmodSync(SERVICE_KEY_FILE, 0o600);
  cached = minted;
  return minted;
}

/**
 * The headers every in-process loopback call adds.
 *
 * One function rather than a constant, because the key is minted lazily and a
 * constant evaluated at import would create the file before `DATA_DIR` was
 * necessarily the one the owner meant.
 */
export function serviceHeaders(extra?: Record<string, string>): Record<string, string> {
  return { [SERVICE_HEADER]: serviceKey(), ...(extra ?? {}) };
}

/** Constant time, and length-safe: `timingSafeEqual` THROWS on a length
 *  mismatch, which would turn a wrong-length key into a 500 rather than a 401
 *  and leak the right length in the process. */
export function isServiceKey(presented: string | null | undefined): boolean {
  /* EITHER OF THE TWO KEYS. This is the "may you through the door at all"
     question and both answer it yes; which one it was decides what may be
     reached afterwards, and that is `keyScope` below. Widening this rather
     than adding a second call site keeps every existing caller — the gate, the
     security status route, the tests — reading one predicate. */
  return keyScope(presented) !== null;
}

/** The key off a request's headers, from either spelling. */
export function presentedKey(headers: {
  get(name: string): string | null | undefined;
}): string | null {
  const direct = headers.get(SERVICE_HEADER);
  if (direct) return direct.trim();
  const auth = headers.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return null;
}

/* ---------------------------------------------------- the agent's own key */

/**
 * THE SCOPED AGENT KEY — a second file, worth strictly less than the first.
 *
 * WHY THE HEADER ABOVE IS NOW ONLY HALF TRUE. It says there are no scopes and
 * that a scope nobody checks is worse than no scope at all. The second half of
 * that sentence is still the rule; what changed is that there is now something
 * that checks. The gap this closes is the one the README states plainly: an
 * agent running under the owner's own account can read `service-key`, and with
 * it POST `/api/backups/restore` or rewrite a credential — bypassing every
 * owner control the API enforces. `requireOwner` already refuses a service key
 * for the mail and password routes; nothing refused it for the rest.
 *
 * SO THERE ARE TWO KEYS AND THEY ARE NOT EQUIVALENT.
 *
 *   THE OWNER KEY (`service-key`) is this process talking to itself — the
 *   skills proxy, a run assembling its brief, the MCP layer's own loopback
 *   calls. It opens everything, exactly as before. Nothing about it changed.
 *
 *   THE AGENT KEY (`agent-home/service-key.agent`) is what is handed OUT: the
 *   `opc` wrapper the agent types and the MCP subprocess's environment. It
 *   opens every read and every write the skills surface publishes, and it is
 *   refused on the owner surface — credentials, backups and restore, the
 *   password, the agent processes themselves, the workspace and the model
 *   gateways. See integrations/security/gate.ts for the list and for why a
 *   deny list rather than an allow list.
 *
 * IT LIVES UNDER `agent-home/` FOR A REASON THAT IS NOT TIDINESS. When the
 * owner runs the gateway as a SEPARATE OS USER (deploy/agent-user.sh), that
 * user is given exactly one directory: the agent home. A key the agent has to
 * read has to be inside it, and the owner key — which sits beside vault.key —
 * must stay somewhere that user cannot reach. Two files in two directories is
 * what makes the separate-user story possible at all.
 *
 * WHAT IT IS STILL WORTH. Everything the skills surface can do, which includes
 * moving board cards, dismissing commitments, sleeping a machine and reading
 * the mailbox. It is a narrower key, not a safe one.
 */
export const AGENT_HOME = resolve(DATA_DIR, "agent-home");
export const AGENT_KEY_FILE = resolve(AGENT_HOME, "service-key.agent");

let cachedAgent: string | null = null;
let agentKeyProblem: string | null = null;

/**
 * THE MODE, AND WHY IT IS 0640 RATHER THAN 0600.
 *
 * The owner key is 0600 because exactly one process reads it. This one has TWO
 * readers by design, and at the `separate-user` level they are two different
 * uids: this API writes it, and the agent's `opc` wrapper `cat`s it. 0600
 * owned by the owner would lock the agent out; 0600 owned by the AGENT — which
 * is what the first version of `deploy/agent-user.sh` did — locks the API out
 * of its own key file, and the API is the half that has to be able to rewrite
 * it. So the file stays OWNED BY THE OWNER and is made readable to a group the
 * agent account is in. `agent-user.sh` creates that group and says so.
 */
const AGENT_KEY_MODE = 0o640;

/**
 * The agent's key, minted on first use.
 *
 * IT NEVER THROWS, and that is not tidiness — it is the difference between a
 * misconfigured key file and a dead API. `keyScope()` calls this on EVERY
 * request that carries any credential at all, including this process's own
 * loopback calls, and `ownerGate` calls `keyScope` unguarded. A `writeFileSync`
 * that raised EACCES here would turn one wrong `chown` into every keyed request
 * answering 500.
 *
 * SO A FILE THAT CANNOT BE READ OR WRITTEN FALLS BACK TO A PROCESS-LOCAL
 * SECRET, and the consequence is stated rather than hidden: nothing else holds
 * that value, so the agent's own key stops matching and the agent is refused
 * at the gate — locked out, which is the safe direction — while the owner key,
 * the browser and everything in-process keep working. The reason is logged once
 * and published on the isolation report, so the Deployment page can say what
 * happened instead of the owner discovering it as "the agent went blind".
 */
export function agentKey(): string {
  if (cachedAgent) return cachedAgent;
  try {
    if (existsSync(AGENT_KEY_FILE)) {
      const raw = readFileSync(AGENT_KEY_FILE, "utf8").trim();
      if (raw) {
        cachedAgent = raw;
        return raw;
      }
    }
  } catch (err) {
    agentKeyProblem =
      `${AGENT_KEY_FILE} exists but this process cannot read it (${err instanceof Error ? err.message : String(err)}). ` +
      `It must stay owned by the account running this API and be group-readable by the agent account — see deploy/agent-user.sh.`;
  }
  const minted = randomBytes(32).toString("hex");
  try {
    mkdirSync(AGENT_HOME, { recursive: true, mode: 0o750 });
    writeFileSync(AGENT_KEY_FILE, `${minted}\n`, { mode: AGENT_KEY_MODE });
    chmodSync(AGENT_KEY_FILE, AGENT_KEY_MODE);
    agentKeyProblem = null;
  } catch (err) {
    agentKeyProblem ??=
      `${AGENT_KEY_FILE} could not be written (${err instanceof Error ? err.message : String(err)}).`;
    agentKeyProblem +=
      " Until that is fixed the agent's key is a value held only in this process's memory, so any agent holding" +
      " the old file will be refused at the gate. The owner key, the dashboard and every in-process call are" +
      " unaffected.";
    console.error(`[auth] ${agentKeyProblem}`);
  }
  cachedAgent = minted;
  return minted;
}

/** What went wrong with the agent key file, or null. Read by the isolation
 *  report so the Deployment page can say it out loud. */
export function agentKeyProblemNote(): string | null {
  /* Minting is lazy, so ask for the key before reporting on it — otherwise a
     page that loads before anything else has needed it reports "fine". */
  agentKey();
  return agentKeyProblem;
}

/** What a presented key is allowed to be. `null` means it is not one of ours. */
export type KeyScope = "owner" | "agent";

function sameKey(presented: string, key: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(key, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Which of the two was presented, in constant time against both.
 *
 * BOTH ARE ALWAYS COMPARED even after the first matches, so the time this
 * takes does not say which file the caller holds. That costs one extra 32-byte
 * compare per request.
 */
export function keyScope(presented: string | null | undefined): KeyScope | null {
  const value = (presented ?? "").trim();
  if (!value) return null;
  const isOwner = sameKey(value, serviceKey());
  const isAgent = sameKey(value, agentKey());
  return isOwner ? "owner" : isAgent ? "agent" : null;
}

/** The headers a child process is given. Never used in-process: everything on
 *  this side of the wire uses `serviceHeaders`. */
export function agentHeaders(extra?: Record<string, string>): Record<string, string> {
  return { [SERVICE_HEADER]: agentKey(), ...(extra ?? {}) };
}
