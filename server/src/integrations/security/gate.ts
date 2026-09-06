import { PORT } from "../../config.ts";
/**
 * THE GATE — one middleware in front of /api/*, and it does nothing until the
 * owner sets a password.
 *
 * IT IS REGISTERED IN index.ts AND NOWHERE ELSE, on one line after the CORS
 * middleware. After, deliberately: a preflight OPTIONS never reaches this (the
 * CORS middleware answers it itself), which is what it should do — a browser
 * asking permission to make a request is not the request, and a 401 on a
 * preflight presents in the console as a CORS failure rather than as "you are
 * logged out".
 *
 * THE TWO KEYS THAT OPEN IT, and they are not equivalent:
 *
 *   THE SESSION COOKIE is a person, in a browser, who typed the password. It
 *   is what the dashboard uses.
 *
 *   THE SERVICE KEY is this machine talking to itself — `opc`, the MCP server,
 *   the skills proxy, a run assembling its brief. See auth.ts for why it has to
 *   exist and exactly what it is worth.
 *
 * WHAT IS OPEN EVEN WITH A PASSWORD SET, and why each one is:
 *
 *   GET /api/health          — the liveness probe. It carries no data about
 *                              anything: whether the process is up, the time,
 *                              and the names of the collectors. `cli/restore.ts`
 *                              checks it to refuse to overwrite a live
 *                              database, and a restore that could not tell
 *                              whether the server was running would be the
 *                              dangerous version of that tool.
 *   POST /api/security/login — the door itself. Obviously.
 *   GET  /api/security/status — the client asks this before it knows whether it
 *                              is logged in; a 401 here would mean the login
 *                              page could not tell "wrong password" from "there
 *                              is no password". It answers with `enabled` and
 *                              `authenticated` and, when not authenticated,
 *                              nothing else — no session list, no dates.
 *   POST /api/security/logout — clearing a cookie you may no longer have a
 *                              valid session for must not be an error.
 *
 * EVERYTHING ELSE, INCLUDING THE PASSWORD ROUTES, IS BEHIND IT. Changing or
 * removing a password needs the CURRENT password as well as a session — two
 * facts rather than one — and setting the FIRST password is reachable because
 * with no password set the gate is not there at all.
 *
 * THE 401 SAYS WHICH DOOR TO USE. A browser is told to go to /login; anything
 * that sent no cookie is told about the header and the key file, because the
 * thing most likely to hit this is a script somebody wrote against this API
 * before the lock existed.
 */
import type { Context, Next } from "hono";
import { isServiceKey, presentedKey, SERVICE_HEADER, SERVICE_KEY_FILE } from "../../auth.ts";
import { cookieValue, liveSession, passwordSet, touchSession } from "./owner.ts";

/** Paths that answer with no credential at all once a password exists. Exact
 *  matches, never prefixes: a prefix rule is how `/api/security/status-and-
 *  everything-else` gets invented later. */
const OPEN = new Set([
  "GET /api/health",
  "POST /api/security/login",
  "GET /api/security/status",
  "POST /api/security/logout",
]);

/** How this request proved itself, for the routes that want to say so. */
export type AuthHow = "cookie" | "service-key" | null;

/**
 * The one thing index.ts imports. Never throws: a middleware that threw would
 * take out every route behind it, and the failure would look like the whole
 * API being down rather than like a lock being stuck.
 */
export async function ownerGate(c: Context, next: Next) {
  /* THE FIRST AND LAST QUESTION. No password, no gate — not "an empty
     allow-list", not "a check that always passes": the request goes straight
     through, exactly as it did before this file existed. */
  let locked: boolean;
  try {
    locked = passwordSet();
  } catch {
    return c.json({ error: "Sign-in is temporarily unavailable. Please try again." }, 503);
  }
  if (!locked) return next();

  if (OPEN.has(`${c.req.method} ${c.req.path}`)) return next();

  if (isServiceKey(presentedKey(c.req.raw.headers))) return next();

  const session = liveSession(cookieValue(c.req.header("cookie")));
  if (session) {
    touchSession(session);
    return next();
  }

  return c.json(
    {
      error: "This dashboard has a password on it. Log in, or send the service key.",
      login: "/login",
      header: `${SERVICE_HEADER}: <key>  (or Authorization: Bearer <key>)`,
      keyFile: SERVICE_KEY_FILE,
    },
    401,
  );
}

/** A service key is deliberately insufficient for owner decisions. */
function browserRejection(c: Context) {
  const origin = c.req.header("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      const ports = new Set([String(PORT), process.env.OPC_UI_PORT || "5180", "5173"]);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || !ports.has(url.port || "80"))
        return c.json({ error: "Open this action in your configured workspace browser." }, 403);
    } catch { return c.json({ error: "Invalid request origin." }, 403); }
  }
  if (presentedKey(c.req.raw.headers) || c.req.header("x-opc-via") === "skills")
    return c.json({ error: "This action requires the owner's signed-in browser." }, 403);
  return null;
}
export async function requireBrowser(c: Context, next: Next) {
  return browserRejection(c) ?? next();
}
export async function requireOwner(c: Context, next: Next) {
  const rejected = browserRejection(c);
  if (rejected) return rejected;
  if (!passwordSet())
    return c.json({ error: "Set a password in Settings → Security and sign in to use owner controls.", setup: "/settings?tab=security" }, 403);
  const session = liveSession(cookieValue(c.req.header("cookie")));
  if (!session) return c.json({ error: "Sign in to use owner controls." }, 401);
  touchSession(session);
  return next();
}
