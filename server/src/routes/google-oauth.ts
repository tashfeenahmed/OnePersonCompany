/**
 * CONNECT WITH GOOGLE — one button for every plugin that holds a Google
 * refresh token (Gmail, Calendar, AdSense), instead of minting a token in a
 * terminal and pasting three fields.
 *
 * PASTE-BACK, AND NOTHING LEAVES THE NETWORK. Google only sends a browser back
 * to an address the OAuth client has on file, and it refuses this box's
 * private address. So the client is a "Desktop app" client and the redirect
 * is the loopback address (`REDIRECT`), which Google accepts for any desktop
 * client. After Allow, the consent tab lands on a "can't be reached" page at
 * 127.0.0.1; its address carries the one-time code, and the owner pastes that
 * address into the page, which POSTs it to /finish here. No public page, no
 * relay: the code goes Google → the owner's browser → this box. It is useless
 * without the client secret and the PKCE verifier, both of which stay here.
 *
 * WHICH CLIENT. The `google` integration ("Google sign-in") when it is set
 * up; otherwise the client id and secret already stored on any connected
 * Gmail, Calendar or AdSense account, so a box that has ever had one Google
 * account connected needs no setup at all. Each account stores the client
 * that minted its token beside it, because a refresh token works only with
 * that client.
 *
 * THE ACCOUNT IS NAMED BY ITS EMAIL. `openid email` is asked for alongside
 * the plugin's scope so the account can be labelled with the address Google
 * signed in, and connecting the same address again UPDATES that account
 * (a reconnect for a wider scope) rather than adding a second one.
 */
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";

import * as accounts from "../accounts.ts";

/** Where Google sends the consent tab. Nothing listens there — the owner
 *  copies the address it lands on. Any Desktop app client accepts it. */
export const REDIRECT = "http://127.0.0.1:53682/";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 30_000;

/** What each plugin asks Google for. The plugin's own `verify` then checks
 *  the grant exactly as it checks a pasted one. */
export const GOOGLE_SCOPES: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  calendar: ["https://www.googleapis.com/auth/calendar"],
  adsense: ["https://www.googleapis.com/auth/adsense.readonly"],
};

/* ------------------------------------------------------------ the client */

/**
 * The `google` plugin's check: a real client id and secret of a Desktop app
 * client. Google is asked to redeem a code that does not exist — a good pair
 * answers `invalid_grant` (wrong code), a bad one `invalid_client`, and a web
 * client that does not accept the loopback address `redirect_uri_mismatch`.
 */
export async function verifyClient(values: Record<string, string>): Promise<string | null> {
  const clientId = (values["client-id"] ?? "").trim();
  const clientSecret = (values["client-secret"] ?? "").trim();
  if (!clientId.endsWith(".apps.googleusercontent.com"))
    return "Paste the client ID of a “Web application” OAuth client — it ends in .apps.googleusercontent.com.";
  if (!clientSecret) return "The client secret is shown beside the client ID in Google Cloud.";
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: "opc-verify",
        grant_type: "authorization_code",
        redirect_uri: REDIRECT,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const doc = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string };
    if (doc.error === "invalid_grant") return null;
    if (doc.error === "invalid_client" || doc.error === "unauthorized_client")
      return "Google does not recognise that client ID and secret together.";
    if (doc.error === "redirect_uri_mismatch")
      return "That client does not accept the loopback address — create one of type \u201cDesktop app\u201d instead of \u201cWeb application\u201d.";
    return `Google answered ${doc.error ?? res.status}: ${doc.error_description ?? "unexpected"}`;
  } catch (err) {
    return err instanceof Error && err.name === "TimeoutError"
      ? "Google did not answer within 30 seconds."
      : "Could not reach Google.";
  }
}

function client(): { clientId: string; clientSecret: string } | null {
  for (const plugin of ["google", ...Object.keys(GOOGLE_SCOPES)]) {
    const ready = accounts.credentialed(plugin, ["client-id", "client-secret"], "google_oauth").ready[0];
    if (ready) return { clientId: ready.values["client-id"]!, clientSecret: ready.values["client-secret"]! };
  }
  return null;
}

/* -------------------------------------------------------------- pending */

type Pending = {
  plugin: string;
  accountId: number | null;
  verifier: string;
  clientId: string;
  clientSecret: string;
  at: number;
};

/** Sign-ins in flight, by nonce. In memory on purpose: one is minutes long,
 *  a restart in the middle costs one more click, and nothing here outlives
 *  its fifteen minutes. */
const pending = new Map<string, Pending>();
const TTL_MS = 15 * 60_000;

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
}

/* --------------------------------------------------------------- routes */

export const googleOAuthRoutes = new Hono();

googleOAuthRoutes.get("/status", (c) =>
  c.json({
    ready: client() !== null,
    redirectUri: REDIRECT,
    plugins: Object.keys(GOOGLE_SCOPES),
  }),
);

googleOAuthRoutes.post("/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    plugin?: unknown;
    accountId?: unknown;
  };
  const plugin = typeof body.plugin === "string" ? body.plugin : "";
  const scopes = GOOGLE_SCOPES[plugin];
  if (!scopes) return c.json({ error: `${plugin || "That"} is not a Google sign-in plugin.` }, 400);
  const app = client();
  if (!app)
    return c.json(
      { error: "Set up Google sign-in first: Integrations → Google sign-in.", setup: true },
      409,
    );

  sweep();
  const nonce = randomBytes(18).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  pending.set(nonce, {
    plugin,
    accountId: typeof body.accountId === "number" ? body.accountId : null,
    verifier,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    at: Date.now(),
  });

  const url = new URL(AUTH_URL);
  for (const [k, v] of Object.entries({
    client_id: app.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: ["openid", "email", ...scopes].join(" "),
    access_type: "offline",
    /* `consent` every time, because Google only returns a refresh token on a
       consent it showed — a second click on an already-granted app would
       otherwise come back with an access token and nothing to keep. */
    prompt: "consent",
    include_granted_scopes: "false",
    state: nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }))
    url.searchParams.set(k, v);
  return c.json({ url: url.toString(), redirect: REDIRECT });
});

/** The email Google signed in, from the id_token it just handed us over TLS. */
function emailOf(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      email?: string;
    };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

/**
 * The address the consent tab landed on, pasted by the owner. Its `state` names
 * the sign-in it belongs to; its `code` is redeemed here with the verifier
 * and the secret that never left this box.
 */
googleOAuthRoutes.post("/finish", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
  let landed: URL;
  try {
    landed = new URL(String(body.url ?? "").trim());
  } catch {
    return c.json({ error: "Paste the whole address from the tab Google sent you to — it starts with http://127.0.0.1." }, 400);
  }
  const nonce = landed.searchParams.get("state") ?? "";
  const job = pending.get(nonce);
  if (!job || Date.now() - job.at > TTL_MS)
    return c.json({ error: "That address belongs to a sign-in that expired or was already used. Click Connect with Google again." }, 410);

  const denied = landed.searchParams.get("error");
  if (denied) {
    pending.delete(nonce);
    return c.json({ error: denied === "access_denied" ? "Google sign-in was cancelled." : `Google said: ${denied}` }, 400);
  }
  const code = landed.searchParams.get("code");
  if (!code) return c.json({ error: "That address has no code in it — copy it after clicking Allow." }, 400);
  pending.delete(nonce);

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: job.clientId,
        client_secret: job.clientSecret,
        code,
        code_verifier: job.verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const doc = (await res.json().catch(() => ({}))) as {
      refresh_token?: string;
      id_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !doc.refresh_token)
      return c.json(
        {
          error: doc.error
            ? `Google refused the sign-in: ${doc.error_description ?? doc.error}`
            : "Google returned no refresh token. Try again and tick every box on the consent screen.",
        },
        400,
      );

    const granted = (doc.scope ?? "").split(/\s+/);
    const missing = GOOGLE_SCOPES[job.plugin]!.filter((s) => !granted.includes(s));
    if (granted.length > 1 && missing.length)
      return c.json(
        { error: `Google did not grant ${missing.map((s) => s.split("/").pop()).join(", ")} — tick every box on the consent screen.` },
        400,
      );

    const label = emailOf(doc.id_token) ?? "Google account";
    /* Imported here, not at the top: routes/plugins.ts imports this file for
       the `google` registry entry, and a cycle at load time would hand one of
       them an undefined. */
    const { connectSetupAccount } = await import("./plugins.ts");
    const result = await connectSetupAccount(
      job.plugin,
      label,
      {
        "client-id": job.clientId,
        "client-secret": job.clientSecret,
        "refresh-token": doc.refresh_token,
      },
      job.accountId,
    );
    return c.json({ ok: true, account: label, accountId: result.accountId, warning: result.error });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
