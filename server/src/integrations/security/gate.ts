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
import { keyScope, presentedKey, SERVICE_HEADER, SERVICE_KEY_FILE } from "../../auth.ts";
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
 * THE OWNER SURFACE — the routes reachable only from the owner's own browser
 * or with the owner's own key, whatever else a caller presents.
 *
 * WHY THIS LIST EXISTS. Everything here changes what the box IS rather than
 * what it has measured: which credentials it holds, which archive its database
 * came from, what its password is, which agent process is running, and where
 * the model traffic goes. An agent that could reach any of them could rewrite
 * the door it came in through — restore a month-old backup, re-point the model
 * gateway, or hand itself a credential — and every one of those is a change
 * the owner would find later rather than be asked about.
 *
 * IT IS A DENY LIST AND NOT AN ALLOW LIST, deliberately, and the reason is
 * that the allow list already exists somewhere better: skills/registry.ts,
 * which names every path an agent may reach and refuses to compose a URL for
 * anything else. This is the second lock for the case that registry cannot
 * cover — the agent has a shell, and a shell can curl WITHOUT sending the key
 * it was handed. So the check below does not ask what key arrived; it asks
 * whether the caller can show it is the owner, and refuses otherwise. A route
 * added to this app tomorrow is reachable by an agent exactly as it was
 * yesterday, which is the price of a deny list and is paid knowingly.
 *
 * READS ARE LEFT ALONE. A GET of the plugin list or the agent panel tells an
 * agent what is connected, which is the same thing the skills catalogue
 * already tells it, and no secret is on any of those documents by
 * construction. Only the methods that change something are refused — plus
 * `/api/backups`, where GET lists archive filenames and POST /restore replaces
 * the database, so the whole family is refused rather than half of it.
 */
const OWNER_SURFACE: { prefix: string; methods: "write" | "all"; why: string }[] = [
  { prefix: "/api/plugins", methods: "write", why: "connecting, disconnecting and configuring accounts is the owner's" },
  { prefix: "/api/backups", methods: "all", why: "an archive can be restored over the live database" },
  { prefix: "/api/security", methods: "write", why: "the password and the sessions are the lock itself" },
  { prefix: "/api/agents", methods: "write", why: "an agent must not install, reconfigure or restart an agent" },
  { prefix: "/api/models", methods: "write", why: "which provider completes, and at whose expense, is the owner's" },
  { prefix: "/api/freellmapi", methods: "write", why: "the model gateway is a process on this machine" },
  { prefix: "/api/searxng", methods: "write", why: "the search node is a process on this machine" },
  { prefix: "/api/workspace", methods: "write", why: "the workspace layout is what the owner sees" },
  { prefix: "/api/setup", methods: "write", why: "setup writes the box's own configuration" },
  { prefix: "/api/runtime", methods: "write", why: "one of these spends a completion and the other puts a message on the owner's phone" },
];

/** Which rule, if any, covers this method and path. */
function ownerSurfaceRule(method: string, path: string) {
  const write = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  for (const rule of OWNER_SURFACE) {
    if (path !== rule.prefix && !path.startsWith(`${rule.prefix}/`)) continue;
    if (rule.methods === "write" && !write) continue;
    return rule;
  }
  return null;
}

/** Is this method and path on the owner surface at all? Exported for the
 *  deployment page and the doctor, which report the boundary rather than
 *  asking anybody to take it on trust. */
export function agentRefusal(method: string, path: string): string | null {
  const rule = ownerSurfaceRule(method, path);
  return rule
    ? `${method} ${path} is an owner control — ${rule.why}. It is reachable from the dashboard in your own ` +
      `browser, or with the owner key at server/data/service-key. It is not reachable with the agent key, ` +
      `through the skills proxy, or from a bare request with no credential at all.`
    : null;
}

/**
 * DOES THIS REQUEST LOOK LIKE IT CAME FROM THE OWNER'S BROWSER?
 *
 * IT IS A HEURISTIC AND THIS COMMENT IS WHERE THAT IS ADMITTED. Any process
 * that can open a socket to this port can set these headers, so this is not a
 * cryptographic boundary and must never be described as one. What it does is
 * raise the bar from "no header at all" to "you must deliberately impersonate
 * a browser" — and the thing on the other side of the bar, at the
 * `separate-user` and container levels, is a process that cannot read the
 * owner key and would have to be written to lie.
 *
 * TWO SIGNALS, BECAUSE A BROWSER GET SENDS NO `Origin`. A same-origin `fetch`
 * sends `Origin` only for methods that are not GET/HEAD, so an Origin-only
 * test would 403 the dashboard's own read of `/api/backups`. `Sec-Fetch-Site`
 * is sent by every current browser on every fetch and by no shell tool, which
 * is exactly the distinction wanted here.
 *
 * A REQUEST CARRYING `x-opc-via: skills` IS NEVER THE BROWSER whatever else it
 * carries. The skills proxy re-issues an agent's call over loopback with the
 * OWNER key — it has to, because most skill routes are not on this surface —
 * and without this line a skill entry pointed at an owner-surface path would
 * launder an agent's request into an owner one. This is that seam closed at
 * the door rather than in the proxy.
 */
function browserShaped(c: Context): boolean {
  if (c.req.header("x-opc-via") === "skills") return false;

  const site = (c.req.header("sec-fetch-site") ?? "").toLowerCase();
  if (site === "same-origin") return true;

  const origin = c.req.header("origin");
  if (!origin) return false;
  try {
    const url = new URL(origin);
    const ports = new Set([String(PORT), process.env.OPC_UI_PORT || "5180", "5173"]);
    return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && ports.has(url.port || "80");
  } catch {
    return false;
  }
}

/**
 * THE OWNER-SURFACE CHECK, and it binds EVERY caller rather than only one that
 * volunteered a key.
 *
 * The first version of this refused a request that presented the AGENT key and
 * nothing else — which meant that on a passwordless box, the shipped state,
 * sending no header at all walked straight through. That is precisely the case
 * the boundary exists for: an agent with a shell does not have to send the key
 * it was given.
 *
 * So the question is inverted. A request on the owner surface is refused
 * unless it proves it is the owner, and there are three proofs:
 *
 *   THE OWNER KEY. Anything that can read `server/data/service-key` already
 *   has this box — it sits beside the vault key — so presenting it is not a
 *   privilege this check can meaningfully withhold.
 *   A LIVE SESSION COOKIE. A person who typed the password.
 *   A BROWSER-SHAPED REQUEST. The heuristic above, which is what makes the
 *   dashboard work on a box with no password — the shipped state.
 *
 * `x-opc-via: skills` fails all three by construction.
 */
export function ownerSurfaceRefusal(c: Context): string | null {
  const refusal = agentRefusal(c.req.method, c.req.path);
  if (!refusal) return null;

  if (c.req.header("x-opc-via") !== "skills" && keyScope(presentedKey(c.req.raw.headers)) === "owner") return null;
  if (browserShaped(c)) return null;
  try {
    if (liveSession(cookieValue(c.req.header("cookie")))) return null;
  } catch {
    /* An unreadable session table must not turn this into a 500. The other two
       proofs still stand and a refusal is the safe direction. */
  }
  return refusal;
}

/** Is this request an AGENT's, however it arrived? True for the agent key and
 *  for anything the skills proxy re-issued. Read by routes that offer an
 *  override a person may use and an agent may not. */
export function isAgentCall(c: Context): boolean {
  if (c.req.header("x-opc-via") === "skills") return true;
  return keyScope(presentedKey(c.req.raw.headers)) === "agent";
}

/** Is this request authenticated at all — a live session or either key? Read
 *  by /api/health, which is open with no credential and therefore must not
 *  describe the machine to an unauthenticated caller. */
export function authenticatedRequest(c: Context): boolean {
  if (keyScope(presentedKey(c.req.raw.headers))) return true;
  try {
    /* `Boolean(...)`, NOT `!== null`. `liveSession` answers `undefined` for a
       request with no cookie — it is a `.get()` on a prepared statement — so
       `!== null` was true for every anonymous request, which handed the full
       health document to exactly the caller it was meant to withhold it from.
       Caught by curling a locked box rather than by the type, which is happy
       either way. */
    return Boolean(liveSession(cookieValue(c.req.header("cookie"))));
  } catch {
    return false;
  }
}

/** The prefixes, for the page. */
export const OWNER_SURFACE_PREFIXES = OWNER_SURFACE.map((r) => ({ prefix: r.prefix, methods: r.methods, why: r.why }));

/**
 * The one thing index.ts imports. Never throws: a middleware that threw would
 * take out every route behind it, and the failure would look like the whole
 * API being down rather than like a lock being stuck.
 */
export async function ownerGate(c: Context, next: Next) {
  /*
    THE OWNER SURFACE IS CHECKED BEFORE THE PASSWORD, AND THAT ORDER IS THE
    WHOLE POINT.

    Everything below this block is about the OWNER's lock and does nothing
    until a password exists. This is not that lock: it is the answer to "the
    thing making this call is a child process I started, and it may not restore
    a backup", which is true on a box with no password at all — the shipped
    state, and the state most boxes stay in. A boundary that only appeared once
    somebody typed a password would be a boundary almost nobody has.

    It refuses a request that cannot show it is the owner's, rather than one
    that volunteered the agent key — see `ownerSurfaceRefusal`, which says what
    each of the three proofs is worth.
  */
  const surfaceRefusal = ownerSurfaceRefusal(c);
  if (surfaceRefusal) return c.json({ error: surfaceRefusal }, 403);
  const presentedScope = keyScope(presentedKey(c.req.raw.headers));

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

  /* Either key opens the lock; what the AGENT one may then reach was already
     decided at the top of this function. */
  if (presentedScope) return next();

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
