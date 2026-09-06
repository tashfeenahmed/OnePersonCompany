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
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
  const value = (presented ?? "").trim();
  if (!value) return false;
  const key = serviceKey();
  const a = Buffer.from(value, "utf8");
  const b = Buffer.from(key, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
