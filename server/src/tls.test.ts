import { test } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { certificate, certificateNames } from "./tls.ts";
import { allowedBrowserOrigin } from "./config.ts";

test("the box makes itself a certificate for the addresses it answers on, and keeps it", { skip: process.platform === "win32" }, () => {
  const made = certificate();
  if (!made) return; /* no openssl on this machine: the plain door still opens */
  const cert = new X509Certificate(made.cert);
  assert.match(cert.subject, /One Person Company/);
  for (const name of certificateNames()) assert.ok((cert.subjectAltName ?? "").replaceAll("IP Address:", "IP:").includes(name), name);
  assert.ok(Date.parse(cert.validTo) - Date.now() > 300 * 86_400_000);
  assert.deepEqual(certificate()?.cert, made.cert, "a current certificate is reused, not remade on every start");
});

test("with no HTTPS port asked for, an https origin is nobody's dashboard", () => {
  assert.equal(allowedBrowserOrigin("https://127.0.0.1:8788"), false);
  assert.equal(allowedBrowserOrigin("http://127.0.0.1:8787"), true);
});
