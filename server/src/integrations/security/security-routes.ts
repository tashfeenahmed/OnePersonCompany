/**
 * /api/security — the lock, from the outside.
 *
 * FIVE ROUTES AND NOT ONE MORE. Set or change the password, take it off, log
 * in, log out, and say what the state is. There is no "list users", no
 * "register", no password reset by email — every one of those would be the
 * first line of a multi-user system this app does not have and cannot enforce
 * (owner.ts's header says why). The recovery path for a forgotten password is
 * the service key file on the disk of the machine you are sitting at, and it is
 * named in the 401 the gate returns and in the README.
 *
 * NOTHING HERE EVER RETURNS A HASH, A SALT OR A SESSION ID. `status` returns
 * session ids because they ARE the thing being revoked — and it returns them
 * only to a request that already proved it is the owner, which means the only
 * id it hands back to a browser is one that browser could already read off its
 * own cookie plus the ids of the other browsers, which it is being shown so it
 * can end them.
 *
 * THE LOGIN DELAY IS THE WHOLE RATE LIMIT. A quarter of a second added to every
 * failed attempt, in memory, per process — which caps a brute force at about
 * four guesses a second per connection and costs a person who mistyped their
 * password nothing they will notice. A lockout was declined: locking the owner
 * out of their own dashboard because somebody on the LAN guessed wrong ten
 * times is a denial of service with a friendly name.
 */
import { Hono } from "hono";
import { isServiceKey, presentedKey, SERVICE_KEY_FILE } from "../../auth.ts";
import {
  checkPassword,
  clearCookie,
  clearPassword,
  cookieValue,
  createSession,
  liveSession,
  ownerRow,
  passwordSet,
  revokeSession,
  sessionRows,
  setCookie,
  setPassword,
  verifyPassword,
} from "./owner.ts";
import { requireBrowser, requireOwner, type AuthHow } from "./gate.ts";

export const securityRoutes = new Hono();
securityRoutes.use("/password", requireBrowser);
securityRoutes.use("/login", requireBrowser);
securityRoutes.use("/sessions/:id", requireOwner);

/** How this request proved itself. Recomputed here rather than passed down
 *  from the gate, because with no password set the gate never ran. */
function how(c: { req: { raw: Request; header(name: string): string | undefined } }): AuthHow {
  if (isServiceKey(presentedKey(c.req.raw.headers))) return "service-key";
  return liveSession(cookieValue(c.req.header("cookie"))) ? "cookie" : null;
}

async function body(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  const doc = await c.req.json().catch(() => null);
  return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/* ------------------------------------------------------------------ status */

/**
 * The state of the lock.
 *
 * OPEN WITHOUT A CREDENTIAL, on purpose (see gate.ts): the login page has to be
 * able to ask "is there even a password on this box" before it can decide
 * whether to draw a form. What it says to an anonymous caller is exactly two
 * booleans; the sessions, the dates and the key file's path appear only once
 * the caller has proved it is the owner.
 */
securityRoutes.get("/status", (c) => {
  const enabled = passwordSet();
  const authed = how(c);
  const row = ownerRow();

  if (!authed && enabled)
    return c.json({
      enabled: true,
      authenticated: false,
      how: null,
      note: "There is a password on this dashboard and this request did not carry one.",
    });

  const mine = liveSession(cookieValue(c.req.header("cookie")))?.id ?? null;
  return c.json({
    enabled,
    authenticated: enabled ? authed !== null : true,
    /* With no password set nothing had to prove anything, and saying "cookie"
       would be claiming a session that does not exist. */
    how: enabled ? authed : null,
    passwordSetAt: row?.created_at ?? null,
    passwordChangedAt: row?.updated_at ?? null,
    serviceKeyFile: SERVICE_KEY_FILE,
    sessions: sessionRows().map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      userAgent: s.user_agent,
      revokedAt: s.revoked_at,
      /* Which row is the browser asking. It is the only one whose revocation
         signs the asker out, and a list that did not say so is a list with a
         trap in it. */
      current: mine !== null && s.id === mine,
    })),
    note:
      "One password, one owner. This is a lock on a door, not a user system — see the README. " +
      "Service credentials cannot approve or send mail. Browser sessions expire after 30 days or seven idle days.",
  });
});

/* ---------------------------------------------------------------- password */

/**
 * Set the first password, or change an existing one.
 *
 * WHEN ONE EXISTS THE OLD ONE IS REQUIRED, and the request is behind the gate
 * as well — so changing a password takes a live session (or the service key)
 * AND the current password. Two facts, because a browser left open on a desk
 * is one of them.
 */
securityRoutes.post("/password", async (c) => {
  const b = await body(c);
  const next = str(b.password);
  const current = str(b.current);

  const problem = checkPassword(next);
  if (problem) return c.json({ error: problem }, 400);

  const existing = passwordSet();
  if (existing) {
    if (!current) return c.json({ error: "The current password is required to change it." }, 400);
    if (!verifyPassword(current)) return c.json({ error: "That is not the current password." }, 403);
  }

  setPassword(next);

  /*
    THE CALLER IS LOGGED STRAIGHT BACK IN, and this is not a convenience — it
    is what makes `setPassword` able to revoke every session. Without it, an
    owner who changed their password from the Settings page would be signed out
    by the act of changing it, on the page they were standing on.
  */
  const session = createSession(c.req.header("user-agent") ?? null);
  c.header("set-cookie", setCookie(session.token));
  return c.json({
    ok: true,
    enabled: true,
    changed: existing,
    revokedOtherSessions: true,
    note: existing
      ? "Password changed. Every other browser that was signed in has been signed out."
      : "Password set. The API now needs this password or the service key — the agent has the key already.",
  });
});

/**
 * Take the lock off.
 *
 * BEHIND THE GATE AND STILL ASKS FOR THE PASSWORD, for the reason changing it
 * does: removing the lock is the most consequential thing on this route and a
 * session cookie alone should not be able to do it.
 */
securityRoutes.delete("/password", async (c) => {
  if (!passwordSet()) return c.json({ error: "There is no password on this dashboard." }, 400);
  const b = await body(c);
  const current = str(b.current);
  if (!current) return c.json({ error: "The current password is required to remove it." }, 400);
  if (!verifyPassword(current)) return c.json({ error: "That is not the current password." }, 403);

  clearPassword();
  c.header("set-cookie", clearCookie());
  return c.json({
    ok: true,
    enabled: false,
    note: "The password is gone and every session with it. /api is open again, exactly as it was before.",
  });
});

/* ------------------------------------------------------------------- login */

/** Added to every failed attempt. See the file header for why this rather than
 *  a lockout. */
const FAIL_DELAY_MS = 250;

securityRoutes.post("/login", async (c) => {
  if (!passwordSet())
    return c.json({ error: "There is no password on this dashboard, so there is nothing to log in to." }, 400);

  const b = await body(c);
  if (!verifyPassword(str(b.password))) {
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return c.json({ error: "That password does not open this dashboard." }, 401);
  }

  const session = createSession(c.req.header("user-agent") ?? null);
  c.header("set-cookie", setCookie(session.token));
  /* THE SESSION ID IS NOT IN THE ANSWER. It is in an HttpOnly cookie, and
     handing the same value back in a JSON body would put it where a script on
     the page can read it — which is the one thing HttpOnly buys. `status`
     does return ids, because a revoke button has to name a row; that is a
     considered trade and it is the reason this one is not. */
  return c.json({ ok: true, createdAt: session.created_at });
});

securityRoutes.post("/logout", (c) => {
  const id = liveSession(cookieValue(c.req.header("cookie")))?.id;
  const ended = id ? revokeSession(id) : false;
  c.header("set-cookie", clearCookie());
  /* Never an error. A logout with no session is the state logout is FOR. */
  return c.json({ ok: true, ended });
});

/* ---------------------------------------------------------------- sessions */

securityRoutes.delete("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const mine = liveSession(cookieValue(c.req.header("cookie")))?.id ?? null;
  if (!revokeSession(id)) return c.json({ error: "No live session with that id." }, 404);
  /* Revoking your own is a logout and is allowed — the list marks which row is
     yours so it is never a surprise. */
  if (mine && mine === id) c.header("set-cookie", clearCookie());
  return c.json({ ok: true, revoked: id, wasCurrent: mine === id });
});
