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
import { ALLOWED_ORIGIN_PORTS } from "../../config.ts";
import { cookieValue, liveSession, passwordSet, touchSession } from "./owner.ts";

/** Paths that answer with no credential at all once a password exists. Exact
 *  matches, never prefixes: a prefix rule is how `/api/security/status-and-
 *  everything-else` gets invented later. */
const OPEN = new Set([
  "GET /api/health",
  "POST /api/security/login",
  "GET /api/security/status",
  "GET /api/onboarding/status",
  "POST /api/security/logout",
]);

/** How this request proved itself, for the routes that want to say so. */
export type AuthHow = "cookie" | "service-key" | null;

/**
 * HOW HARD A CALLER HAS TO WORK TO BE BELIEVED. Three levels, and they nest:
 * anything that passes `session` passes `browser`, anything that passes
 * `browser` passes `proof`.
 *
 * THE NESTING IS THE POINT: three unrelated rules that can each answer the
 * same request differently leave the weakest one as the only guard on the
 * most sensitive routes — installing a service, publishing a post — the
 * moment any caller reaches for the wrong one.
 */
export type SurfaceLevel =
  /**
   * ANY PROOF THAT THIS IS THE OWNER'S SIDE OF THE MACHINE: the owner key, a
   * live session, or a browser-shaped request. This is the level for the
   * routes that change what the box HOLDS — credentials, backups, which model
   * completes — where the owner's own key is a legitimate way in because
   * anything that can read that file already has the box.
   */
  | "proof"
  /**
   * THE OWNER'S BROWSER, AND A KEY IS NOT ACCEPTED. For the writes that put a
   * process on the owner's machine or send something to the world under their
   * name: an `opc` command or a chat turn must not be able to do these, and
   * both of those carry a key.
   */
  | "browser"
  /**
   * THE OWNER'S BROWSER, WITH A PASSWORD SET AND SIGNED IN. For the writes
   * where "somebody at this keyboard" is not enough and the box has to know a
   * person typed the password: mailing a list, changing a sending identity,
   * revoking another session.
   */
  | "session";

/**
 * THE OWNER SURFACE — one table, and it is the ONLY statement of which routes
 * an agent may not perform.
 *
 * WHY THIS LIST EXISTS. Everything here changes what the box IS rather than
 * what it has measured: which credentials it holds, which archive its database
 * came from, what its password is, which agent process is running, where the
 * model traffic goes, what gets installed on this machine, and what leaves it
 * addressed to somebody else. An agent that could reach any of them could
 * rewrite the door it came in through — restore a month-old backup, re-point
 * the model gateway, hand itself a credential, or post — and every one of
 * those is a change the owner would find later rather than be asked about.
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
 * READS ARE LEFT ALONE unless a row says `all`. A GET of the plugin list or
 * the agent panel tells an agent what is connected, which is the same thing
 * the skills catalogue already tells it, and no secret is on any of those
 * documents by construction. `/api/backups` is `all` because GET lists archive
 * filenames and POST /restore replaces the database, so the whole family is
 * refused rather than half of it.
 *
 * THE STRICTER ROWS ARE ALSO ENFORCED BY `requireBrowser` / `requireOwner` ON
 * THE ROUTE ITSELF, and that is belt and braces rather than an accident. This
 * table is the DECLARATION — it is what `agentRefusal`, the isolation report
 * and `npm run doctor` read, so a family missing from it makes all three claim
 * a surface is agent-proof that the gate has never heard of. The middleware is
 * the per-route belt for a
 * router mounted somewhere this table did not predict. If a route MOVES, the
 * belt still holds and only the report goes stale, which is the failure
 * direction to prefer.
 *
 * ORDER MATTERS: the first matching row wins, so the stricter, narrower rows
 * are written above the family they sit inside.
 */
type SurfaceRule = {
  /** Covers this path and everything under it. */
  prefix?: string;
  /** Or exactly these routes. `:name` matches one whole segment, so
   *  `/api/outbox/:id/send` covers the approve-and-send pair without covering
   *  `/api/outbox/:id/dismiss` beside it. */
  paths?: string[];
  /** `write` is everything but GET/HEAD/OPTIONS; `all` includes reads. */
  methods: "write" | "all";
  level: SurfaceLevel;
  why: string;
};

const OWNER_SURFACE: SurfaceRule[] = [
  { prefix: "/api/onboarding", methods: "write", level: "browser", why: "first-run setup configures the owner, credentials, and workspace" },
  /* ---- the owner's browser, signed in ------------------------------------ */
  {
    paths: ["/api/security/sessions/:id"],
    methods: "all",
    level: "session",
    why: "revoking a session is the lock itself, and needs the person who typed the password",
  },
  {
    paths: ["/api/outbox/:id/approve", "/api/outbox/:id/send", "/api/outbox/:id/resolve"],
    methods: "write",
    level: "session",
    why: "approving and sending mail puts a message in somebody else's inbox under the owner's name",
  },
  {
    paths: ["/api/nurture/sequences", "/api/nurture/sequences/:id"],
    methods: "write",
    level: "session",
    why: "a sequence is a standing instruction to write to people automatically, for ever",
  },
  { prefix: "/api/nurture/identities", methods: "all", level: "session", why: "a sending identity is which address the owner's mail leaves from" },
  { prefix: "/api/nurture/style", methods: "all", level: "session", why: "the house style is the voice everything automatic is written in" },

  /* ---- the owner's browser, key refused ---------------------------------- */
  {
    prefix: "/api/deploy/service",
    methods: "write",
    level: "browser",
    why: "installing or removing a supervised service puts a process into the owner's own account",
  },
  {
    prefix: "/api/deploy/plan",
    methods: "write",
    level: "browser",
    why: "the service plan is written to disk in the owner's checkout",
  },
  {
    paths: ["/api/publishing/items/:id/publish", "/api/publishing/items/:id/retry"],
    methods: "write",
    level: "browser",
    why: "publishing sends a post to a third party under the owner's name and cannot be taken back",
  },
  {
    paths: ["/api/security/password", "/api/security/login"],
    methods: "write",
    level: "browser",
    why: "the password is the lock, and a process holding a key must not be able to change it",
  },

  /* ---- any owner proof --------------------------------------------------- */
  { prefix: "/api/plugins", methods: "write", level: "proof", why: "connecting, disconnecting and configuring accounts is the owner's" },
  { paths: ["/api/pipeline/workflow"], methods: "write", level: "proof", why: "recurring workflow instructions and scope are chosen by the owner" },
  { prefix: "/api/backups", methods: "all", level: "proof", why: "an archive can be restored over the live database" },
  { prefix: "/api/security", methods: "write", level: "proof", why: "the password and the sessions are the lock itself" },
  { prefix: "/api/agents", methods: "write", level: "proof", why: "an agent must not install, reconfigure or restart an agent" },
  { prefix: "/api/models", methods: "write", level: "proof", why: "which provider completes, and at whose expense, is the owner's" },
  { prefix: "/api/freellmapi", methods: "write", level: "proof", why: "the model gateway is a process on this machine" },
  { prefix: "/api/searxng", methods: "write", level: "proof", why: "the search node is a process on this machine" },
  { prefix: "/api/workspace", methods: "write", level: "proof", why: "the workspace layout is what the owner sees" },
  { prefix: "/api/setup", methods: "write", level: "proof", why: "setup writes the box's own configuration" },
  { prefix: "/api/runtime", methods: "write", level: "proof", why: "one of these spends a completion and the other puts a message on the owner's phone" },
];

/** `:name` matches exactly one segment; everything else is literal. */
function pathMatches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  if (want.length !== got.length) return false;
  return want.every((seg, i) => (seg.startsWith(":") ? (got[i] ?? "").length > 0 : seg === got[i]));
}

/** Which rule, if any, covers this method and path. First match wins. */
function surfaceRule(method: string, path: string): SurfaceRule | null {
  const write = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  for (const rule of OWNER_SURFACE) {
    if (rule.methods === "write" && !write) continue;
    const covered = rule.paths
      ? rule.paths.some((p) => pathMatches(p, path))
      : path === rule.prefix || path.startsWith(`${rule.prefix}/`);
    if (covered) return rule;
  }
  return null;
}

/** What each level will and will not accept, in one sentence, for the refusals
 *  and for every surface that reports the boundary. */
const DEMANDS: Record<SurfaceLevel, string> = {
  proof:
    "It is reachable from the dashboard in your own browser, or with the owner key at server/data/service-key. " +
    "It is not reachable with the agent key, through the skills proxy, or from a bare request with no credential at all.",
  browser:
    "It is reachable only from the dashboard in your own browser. A service key is deliberately not enough, and " +
    "neither is a request that carries no browser origin at all.",
  session:
    "It is reachable only from the dashboard in your own browser, signed in with the dashboard password. A service " +
    "key is deliberately not enough.",
};

/**
 * Is this method and path on the owner surface at all, and what does it want?
 * Exported for the deployment page and the doctor, which report the boundary
 * rather than asking anybody to take it on trust.
 */
export function agentRefusal(method: string, path: string): string | null {
  const rule = surfaceRule(method, path);
  return rule ? `${method} ${path} is an owner control — ${rule.why}. ${DEMANDS[rule.level]}` : null;
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
 * NO SIGNAL AT ALL IS NOT A BROWSER, and this is the line the second copy of
 * this function got wrong. It only refused what it could see — a foreign
 * origin, a presented key — so `curl -XPOST` with no headers whatsoever fell
 * off the end and was allowed. That was the whole of the guard on installing
 * a service, uninstalling one, and publishing a post.
 *
 * A REQUEST CARRYING `x-opc-via: skills` IS NEVER THE BROWSER whatever else it
 * carries. The skills proxy re-issues an agent's call over loopback with the
 * OWNER key — it has to, because most skill routes are not on this surface —
 * and without this line a skill entry pointed at an owner-surface path would
 * launder an agent's request into an owner one. This is that seam closed at
 * the door rather than in the proxy.
 */
export function browserShaped(c: Context): boolean {
  if (c.req.header("x-opc-via") === "skills") return false;

  const site = (c.req.header("sec-fetch-site") ?? "").toLowerCase();
  if (site === "same-origin") return true;

  return c.req.header("origin") !== undefined && !foreignOrigin(c);
}

/**
 * AN `Origin` HEADER NAMING SOMEBODY ELSE'S SITE. Absent is not foreign — see
 * `browserShaped` for why a browser GET sends none — and an origin this file
 * cannot parse is treated as foreign, because a refusal is the safe direction
 * and there is no legitimate caller sending an unparseable one.
 *
 * SEPARATE FROM `browserShaped` BECAUSE THE TWO ARE DIFFERENT QUESTIONS. "Is
 * this the owner's browser" needs a positive signal; "is this somebody else's
 * site" is a refusal that stands even when another positive signal exists.
 */
function foreignOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      ALLOWED_ORIGIN_PORTS.has(url.port || "80")
    );
  } catch {
    return true;
  }
}

/** A live session, without letting an unreadable session table turn a check
 *  into a 500. A refusal is the safe direction. */
function signedIn(c: Context): boolean {
  try {
    return Boolean(liveSession(cookieValue(c.req.header("cookie"))));
  } catch {
    return false;
  }
}

export type Refusal = { error: string; status: 401 | 403; setup?: string };

/**
 * DOES THIS REQUEST MEET THIS LEVEL? Null when it does.
 *
 * ONE FUNCTION, CALLED BOTH BY THE GATE AND BY THE PER-ROUTE MIDDLEWARE, so
 * the two cannot answer differently about one request.
 *
 * `x-opc-via: skills` fails every level by construction, because
 * `browserShaped` refuses it and `keyScope` is never consulted for the two
 * strict levels.
 */
export function levelRefusal(c: Context, level: SurfaceLevel, why?: string): Refusal | null {
  const browser = browserShaped(c);

  if (level === "proof") {
    /* THE OWNER KEY. Anything that can read `server/data/service-key` already
       has this box — it sits beside the vault key — so presenting it is not a
       privilege this check can meaningfully withhold. */
    if (c.req.header("x-opc-via") !== "skills" && keyScope(presentedKey(c.req.raw.headers)) === "owner") return null;
    if (browser) return null;
    if (signedIn(c)) return null;
    return { error: `${why ? `${why}. ` : ""}${DEMANDS.proof}`, status: 403 };
  }

  const said = why ? `${why}. ` : "";

  /* A KEY IS NOT A BROWSER AND IS REFUSED BEFORE THE SHAPE IS EVEN LOOKED AT,
     so the message says which of the two problems it is. */
  if (presentedKey(c.req.raw.headers) || c.req.header("x-opc-via") === "skills")
    return { error: `${said}This action requires the owner's signed-in browser. ${DEMANDS[level]}`, status: 403 };

  if (foreignOrigin(c))
    return { error: `${said}Open this action in your configured workspace browser.`, status: 403 };

  if (level === "browser") {
    /*
      THE HOLE THIS CLOSES. The second copy of this check only ever refused
      what it could SEE — a foreign origin, a presented key — so a request
      carrying no headers whatsoever fell off the end of it and was allowed.
      That was the whole guard on installing a service, uninstalling one,
      writing the service plan and publishing a post: `curl -XPOST` with no
      arguments walked through all four.
    */
    if (!browser)
      return {
        error:
          `${said}Open this action in the dashboard in your own browser. This request carried no browser origin, ` +
          `so it cannot be told apart from a script. ${DEMANDS[level]}`,
        status: 403,
      };
    return null;
  }

  /*
    AT THE `session` LEVEL THE COOKIE IS ITSELF THE PROOF OF THE BROWSER, so no
    separate shape test is applied — and that is an argument rather than a
    concession. The session cookie is `HttpOnly` and `SameSite=Strict` (see
    owner.ts): no script on the page can read it, nothing another site
    initiates carries it, and the only route that mints one is `/login`, which
    is itself at the `browser` level. A caller holding a live session token is
    therefore a browser the owner signed in, or a process that already has the
    database — and a process with the database is past every wall in this file.
  */

  if (!passwordSet())
    return {
      error: `${said}Set a password in Settings → Security and sign in to use owner controls.`,
      status: 403,
      setup: "/settings?tab=security",
    };
  const session = liveSession(cookieValue(c.req.header("cookie")));
  if (!session) return { error: `${said}Sign in to use owner controls.`, status: 401 };
  touchSession(session);
  return null;
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
 * unless it proves it is the owner, to whatever level the table above asks
 * for.
 */
export function surfaceRefusal(c: Context): Refusal | null {
  const rule = surfaceRule(c.req.method, c.req.path);
  if (!rule) return null;
  return levelRefusal(c, rule.level, `${c.req.method} ${c.req.path} is an owner control — ${rule.why}`);
}

/** The same answer as a sentence or nothing, for the tests and for anything
 *  that only wants to know whether this request would be refused. */
export function ownerSurfaceRefusal(c: Context): string | null {
  return surfaceRefusal(c)?.error ?? null;
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
  /* `Boolean(...)`, NOT `!== null`. `liveSession` answers `undefined` for a
     request with no cookie — it is a `.get()` on a prepared statement — so
     `!== null` was true for every anonymous request, which handed the full
     health document to exactly the caller it was meant to withhold it from.
     Caught by curling a locked box rather than by the type, which is happy
     either way. */
  return signedIn(c);
}

/** The table, for the page, the isolation report and the doctor. They report
 *  the boundary the gate actually enforces because it is this same list. */
export const OWNER_SURFACE_PREFIXES = OWNER_SURFACE.map((r) => ({
  prefix: r.prefix ?? r.paths?.[0] ?? "",
  paths: r.paths ?? null,
  methods: r.methods,
  level: r.level,
  demands: DEMANDS[r.level],
  why: r.why,
}));

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
  */
  const refusal = surfaceRefusal(c);
  if (refusal) return c.json({ error: refusal.error, ...(refusal.setup ? { setup: refusal.setup } : {}) }, refusal.status);
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

/**
 * THE TWO STRICT LEVELS AS PER-ROUTE MIDDLEWARE.
 *
 * They are the belt to the table's braces — see the table's own comment — and
 * they answer through `levelRefusal`, so a route wearing one of these and a
 * row in the table cannot disagree about the same request.
 */
export async function requireBrowser(c: Context, next: Next) {
  const refusal = levelRefusal(c, "browser");
  return refusal ? c.json({ error: refusal.error }, refusal.status) : next();
}

export async function requireOwner(c: Context, next: Next) {
  const refusal = levelRefusal(c, "session");
  if (!refusal) return next();
  return c.json({ error: refusal.error, ...(refusal.setup ? { setup: refusal.setup } : {}) }, refusal.status);
}
