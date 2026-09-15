import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { cors } from "hono/cors";

// This test worker has its own scratch database and environment.
process.env.OPC_ALLOWED_ORIGINS = "http://192.0.2.10:8787, https://dashboard.example";
const { allowedBrowserOrigin, parseBrowserOrigins } = await import("./config.ts");
const { ownerGate } = await import("./integrations/security/gate.ts");
const { setPassword, clearPassword } = await import("./integrations/security/owner.ts");

test("browser origins allow only configured addresses and the existing local UI", () => {
  for (const origin of ["http://192.0.2.10:8787", "https://dashboard.example", "http://localhost:5180", "http://127.0.0.1:8787"])
    assert.equal(allowedBrowserOrigin(origin), true, origin);
  for (const origin of ["http://192.0.2.11:8787", "http://192.0.2.10:9000", "https://evil.example", "null", "http://localhost:9999", "http://user@192.0.2.10:8787", "http://192.0.2.10:8787/path"])
    assert.equal(allowedBrowserOrigin(origin), false, origin);
  for (const value of ["*", "https://*.example", "file:///tmp/test", "https://user:password@example.com", "https://example.com/path", "https://example.com?query=yes"])
    assert.throws(() => parseBrowserOrigins(value));
});

function app() {
  const a = new Hono();
  a.use("/api/*", cors({ origin: (o) => allowedBrowserOrigin(o) ? o : null, credentials: true }));
  a.use("/api/*", ownerGate);
  // No real owner action is performed by these probe handlers.
  a.all("/api/deploy/service", (c) => c.json({ ok: true }));
  a.get("/api/backups", (c) => c.json({ ok: true }));
  return a;
}

test("HTTP LAN browser reads and writes work without secure-context Fetch Metadata", async () => {
  const a = app();
  const write = await a.request("/api/deploy/service", { method: "POST", headers: { origin: "http://192.0.2.10:8787" } });
  assert.equal(write.status, 200);
  assert.equal(write.headers.get("access-control-allow-origin"), "http://192.0.2.10:8787");
  const read = await a.request("/api/backups", { headers: { referer: "http://192.0.2.10:8787/settings" } });
  assert.equal(read.status, 200);
  for (const headers of [{}, { referer: "http://192.0.2.11:8787/settings" }, { origin: "https://evil.example", "sec-fetch-site": "same-origin" }, { origin: "http://192.0.2.10:8787", "x-opc-via": "skills" }]) {
    const r = await a.request("/api/deploy/service", { method: "POST", headers });
    assert.equal(r.status, 403);
  }
});

test("allowing a LAN origin does not bypass an existing owner password", async () => {
  setPassword("test-owner-password");
  try {
    const r = await app().request("/api/backups", { headers: { referer: "http://192.0.2.10:8787/settings" } });
    assert.equal(r.status, 401);
  } finally { clearPassword(); }
});
