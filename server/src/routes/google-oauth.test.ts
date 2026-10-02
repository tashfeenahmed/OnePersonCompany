/**
 * Connect with Google, end to end against a stubbed Google: the client is
 * checked against the loopback redirect, a pasted-back address lands as an
 * account named by its email, and a second sign-in with the same address
 * updates it.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import * as accounts from "../accounts.ts";
import { googleOAuthRoutes, REDIRECT, verifyClient } from "./google-oauth.ts";
import { plugins } from "./plugins.ts";

const realFetch = globalThis.fetch;
let tokenBodies: URLSearchParams[] = [];
let refresh = "rt-1";

beforeEach(() => {
  tokenBodies = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init?.body));
      tokenBodies.push(body);
      if (body.get("code") === "opc-verify") return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (body.get("grant_type") === "authorization_code") {
        const idToken = `x.${Buffer.from(JSON.stringify({ email: "owner@example.com" })).toString("base64url")}.y`;
        return Response.json({
          access_token: "a",
          refresh_token: refresh,
          id_token: idToken,
          scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar",
        });
      }
      return Response.json({ access_token: "a", scope: "https://www.googleapis.com/auth/calendar" });
    }
    if (url.includes("/calendarList"))
      return Response.json({ items: [{ id: "owner@example.com", summary: "Me", primary: true, accessRole: "owner" }] });
    if (url.includes("/events")) return Response.json({ items: [] });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the client is checked against the loopback redirect", async () => {
  assert.equal(await verifyClient({ "client-id": "1.apps.googleusercontent.com", "client-secret": "s" }), null);
  assert.equal(tokenBodies[0]!.get("redirect_uri"), REDIRECT);
  assert.match((await verifyClient({ "client-id": "nope", "client-secret": "s" }))!, /Web application/);
});

test("start refuses until some Google client is known", async () => {
  for (const id of ["google", "gmail", "calendar", "adsense"]) for (const a of accounts.list(id)) accounts.remove(a);
  const res = await googleOAuthRoutes.request("/start", {
    method: "POST",
    body: JSON.stringify({ plugin: "calendar" }),
  });
  assert.equal(res.status, 409);
});

const finish = (url: string) =>
  googleOAuthRoutes.request("/finish", { method: "POST", body: JSON.stringify({ url }) });

async function signIn(): Promise<Response> {
  const start = await googleOAuthRoutes.request("/start", {
    method: "POST",
    body: JSON.stringify({ plugin: "calendar" }),
  });
  assert.equal(start.status, 200);
  const auth = new URL(((await start.json()) as { url: string }).url);
  assert.equal(auth.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(auth.searchParams.get("prompt"), "consent");
  assert.match(auth.searchParams.get("scope")!, /auth\/calendar$/);
  const state = auth.searchParams.get("state")!;
  return finish(`${REDIRECT}?state=${state}&code=c&scope=x`);
}

test("a sign-in lands as an account named by its email, and again updates it", async () => {
  const set = await plugins.request("/google/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "Google sign-in",
      fields: { "client-id": "1.apps.googleusercontent.com", "client-secret": "s" },
    }),
  });
  assert.ok(set.status < 300, await set.text());

  const first = await signIn();
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(((await first.json()) as { account: string }).account, "owner@example.com");
  const exchange = tokenBodies.find((b) => b.get("grant_type") === "authorization_code" && b.get("code") === "c")!;
  assert.ok(exchange.get("code_verifier"));
  assert.deepEqual(accounts.list("calendar").map((a) => a.label), ["owner@example.com"]);

  refresh = "rt-2";
  await signIn();
  assert.equal(accounts.list("calendar").length, 1);

  const replay = await finish(`${REDIRECT}?state=nope&code=c`);
  assert.equal(replay.status, 410);
  assert.equal((await finish("not a url")).status, 400);
});
