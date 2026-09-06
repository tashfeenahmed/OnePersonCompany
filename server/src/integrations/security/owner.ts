/**
 * THE DOOR LOCK — one password, one owner, and sessions in a cookie.
 *
 * READ THIS BEFORE READING ANYTHING ELSE IN THIS DIRECTORY: this is not a
 * multi-user system and must never be mistaken for one. There is one password,
 * there are no accounts, no roles, no per-venture permissions and no audit of
 * who did what — because there is one owner, and every route on this box was
 * written for that owner. What this adds is a LOCK ON A DOOR: the dashboard
 * binds to 127.0.0.1, and the moment somebody puts it behind a tunnel, a
 * reverse proxy or a `--host` flag, "no auth at all" stops being a reasonable
 * default. It is the difference between a front door with a latch and a
 * building with a security desk. This is the latch.
 *
 * IT IS OFF UNTIL A PASSWORD EXISTS, and that is the single most important
 * property here. `security_owner` empty means the gate passes every request
 * through untouched — no cookie, no header, no branch that can go wrong — so a
 * box that never opens the Security tab behaves in every respect exactly as it
 * did before this file existed.
 *
 * scrypt RATHER THAN A HASH THIS FILE INVENTS. node:crypto ships it, so it
 * costs no dependency, and the parameters below are the Node defaults with a
 * deliberately raised cost. The hash lives in a database file that the nightly
 * backup copies to whatever the owner pointed it at — which is the real threat
 * model for a password on a personal box, and the reason a fast hash would be
 * wrong here even though nothing on a LAN is going to run a GPU at it.
 *
 * THE COOKIE IS THE SESSION ID AND NOTHING ELSE. HttpOnly so no script on the
 * page can read it, SameSite=Strict so nothing another site initiates carries
 * it, Path=/ so it reaches the API and the app alike. It is NOT `Secure`: the
 * dashboard is served over plain http on loopback, and a Secure cookie on http
 * is a cookie the browser silently drops — a login that appears to succeed and
 * then does nothing. If this is ever put behind TLS, that flag is the one line
 * to add.
 *
 * THERE IS NO EXPIRY ON THE SERVER SIDE. A session lives until it is revoked
 * or the password changes, which is what a person actually wants from the
 * machine on their own desk; the cookie carries a Max-Age so a browser drops it
 * eventually, but the row is the authority and the row is only ended on
 * purpose. An idle timeout would be this app deciding, on no evidence, that
 * somebody had walked away.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, now } from "../../db.ts";
import { registerRetention } from "../../shared/retention.ts";

/* ------------------------------------------------------------- the password */

/** Bytes of derived key. 64 is Node's own example and is plenty for a
 *  comparison nobody transmits. */
const KEY_LEN = 64;
/**
 * scrypt's cost. 2^15 rather than the library default of 2^14, which puts one
 * verification at roughly a tenth of a second on this class of machine — slow
 * enough to matter to somebody with the database file, fast enough that a login
 * form feels instant. It also needs `maxmem` raised, because Node's default
 * ceiling is 32 MB and N=32768 wants more than that.
 */
const COST = 32_768;
const MAXMEM = 128 * 1024 * 1024;

function derive(password: string, salt: string): string {
  return scryptSync(password, salt, KEY_LEN, { N: COST, maxmem: MAXMEM }).toString("hex");
}

export type OwnerRow = {
  id: number;
  hash: string;
  salt: string;
  created_at: string;
  updated_at: string;
};

export function ownerRow(): OwnerRow | undefined {
  return db.prepare("SELECT * FROM security_owner WHERE id = 1").get() as OwnerRow | undefined;
}

/** Is the door locked at all? The one question the gate asks on every request,
 *  and it is one indexed read of a one-row table. */
export function passwordSet(): boolean {
  return ownerRow() !== undefined;
}

/**
 * What is wrong with this password, said where it was typed.
 *
 * TEN CHARACTERS AND NOTHING ELSE. No character-class rule: a rule that forces
 * a digit and a symbol is how a personal box ends up protected by "Password1!"
 * written on a sticky note, and length is the only requirement that has ever
 * survived contact with evidence.
 */
export function checkPassword(password: string): string | null {
  const p = password ?? "";
  if (p.length < 10)
    return "Ten characters at least. There is no rule about digits or symbols — length is the only thing that has ever helped.";
  if (p.length > 512) return "That is longer than 512 characters, which is longer than anything can type twice.";
  return null;
}

/** Constant time, and length-safe — `timingSafeEqual` throws on a mismatch. */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** Does this password open the door? False when no password is set at all —
 *  "verify" of a lock that does not exist is not a pass. */
export function verifyPassword(password: string): boolean {
  if (typeof password !== "string" || password.length > 512) return false;
  const row = ownerRow();
  if (!row) return false;
  return sameHash(derive(password, row.salt), row.hash);
}

/**
 * Set or replace the password.
 *
 * EVERY SESSION IS REVOKED BY A CHANGE, and that is not a convenience — it is
 * the only thing that makes changing a password mean anything. A password
 * changed because somebody else may have seen it, with the browser they saw it
 * on still holding a live cookie, is a password that was not changed.
 */
export function setPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = derive(password, salt);
  const ts = now();
  const existing = ownerRow();
  if (existing) {
    db.prepare("UPDATE security_owner SET hash = ?, salt = ?, updated_at = ? WHERE id = 1").run(hash, salt, ts);
  } else {
    db.prepare(
      "INSERT INTO security_owner (id, hash, salt, created_at, updated_at) VALUES (1, ?, ?, ?, ?)",
    ).run(hash, salt, ts, ts);
  }
  revokeAll();
}

/**
 * Take the lock off.
 *
 * The sessions go with it. A row left behind would be a cookie that starts
 * working again the day somebody sets a password back — which is a stranger
 * thing to discover than having to log in once.
 */
export function clearPassword() {
  db.prepare("DELETE FROM security_owner WHERE id = 1").run();
  db.prepare("DELETE FROM security_sessions").run();
}

/* -------------------------------------------------------------- sessions */

export type SessionRow = {
  id: string;
  created_at: string;
  last_seen_at: string;
  user_agent: string | null;
  revoked_at: string | null;
};

export const SESSION_MAX_AGE_MS = 30 * 24 * 3600_000;
export const SESSION_IDLE_MS = 7 * 24 * 3600_000;

/**
 * SESSIONS ARE KEPT FOR NINETY DAYS AFTER THEY WERE OPENED, AND NOTHING KEPT
 * THEM BEFORE — one row per sign-in, for the life of the box.
 *
 * A row past `SESSION_MAX_AGE_MS` cannot log anybody in whatever it says: the
 * lookup above compares `created_at` against that thirty days and finds
 * nothing older. So everything this window deletes is already dead as a
 * credential, and what it is keeping is the ANSWER TO "WHO SIGNED IN, FROM
 * WHAT, AND WHEN" — the revoke list's whole reason to show closed sessions.
 * Ninety days is three times the longest a session can live, which is enough
 * to notice a sign-in nobody remembers and short enough that the table is a
 * page rather than a history.
 */
export const SESSION_RETAIN_DAYS = 90;
registerRetention({
  table: "security_sessions",
  column: "created_at",
  days: SESSION_RETAIN_DAYS,
  source: "area",
  note:
    "One row per sign-in. Anything past SESSION_MAX_AGE_MS (30 days) can no longer authenticate, so this window " +
    "only decides how long the sign-in HISTORY is readable on the sessions list.",
});
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Only the login response receives the token. Lists and the database hold its digest. */
export function createSession(userAgent: string | null): SessionRow & { token: string } {
  const id = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const ts = now();
  const agent = (userAgent ?? "").slice(0, 300) || null;
  db.prepare(
    "INSERT INTO security_sessions (id, token_hash, created_at, last_seen_at, user_agent, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(id, tokenHash(token), ts, ts, agent);
  return { id, token, created_at: ts, last_seen_at: ts, user_agent: agent, revoked_at: null };
}

export function liveSession(token: string | null | undefined): SessionRow | undefined {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  return db.prepare(
    "SELECT id, created_at, last_seen_at, user_agent, revoked_at FROM security_sessions WHERE token_hash = ? AND revoked_at IS NULL AND created_at > ? AND last_seen_at > ?",
  ).get(tokenHash(token), new Date(Date.now() - SESSION_MAX_AGE_MS).toISOString(),
    new Date(Date.now() - SESSION_IDLE_MS).toISOString()) as SessionRow | undefined;
}

/** How stale `last_seen_at` may get before a request bothers to write it. One
 *  minute: the column exists so the revoke list can say "this one was used
 *  three days ago", and a write per API call to sharpen that to the second
 *  would be hundreds of writes an hour for nothing. */
const TOUCH_MS = 60_000;

export function touchSession(row: SessionRow) {
  const last = Date.parse(row.last_seen_at);
  if (Number.isFinite(last) && Date.now() - last < TOUCH_MS) return;
  db.prepare("UPDATE security_sessions SET last_seen_at = ? WHERE id = ?").run(now(), row.id);
}

/** Every session, newest first — revoked ones included, because "signed out at
 *  14:02" is the half of the list that answers a question. */
export function sessionRows(): SessionRow[] {
  return db
    .prepare("SELECT * FROM security_sessions ORDER BY last_seen_at DESC")
    .all() as SessionRow[];
}

export function revokeSession(id: string): boolean {
  const res = db
    .prepare("UPDATE security_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now(), id);
  return Number(res.changes) > 0;
}

export function revokeAll(): number {
  const res = db
    .prepare("UPDATE security_sessions SET revoked_at = ? WHERE revoked_at IS NULL")
    .run(now());
  return Number(res.changes);
}

/* --------------------------------------------------------------- the cookie */

export const COOKIE = "opc_session";

/** Thirty days. The ROW is the authority — see the header — so this only
 *  decides how long a browser keeps offering an id the server may already have
 *  revoked. */
const COOKIE_MAX_AGE = 30 * 24 * 3600;

/**
 * The Set-Cookie value.
 *
 * No `Secure`: this is served over http on loopback and a Secure cookie there
 * is silently dropped, which presents as a login that succeeds and changes
 * nothing. No `Domain`: an omitted domain binds the cookie to exactly the host
 * that set it, which is what a dev proxy on localhost:5180 and the API on
 * 127.0.0.1:8787 both want.
 */
export function setCookie(id: string): string {
  return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** The session id out of a Cookie header, without a cookie library. */
export function cookieValue(header: string | null | undefined, name = COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(at + 1).trim()) || null; } catch { return null; }
  }
  return null;
}
