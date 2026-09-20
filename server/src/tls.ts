/**
 * A CERTIFICATE THIS BOX MAKES FOR ITSELF, so the HTTPS door (config.ts,
 * `OPC_HTTPS_PORT`) has something to present.
 *
 * SELF-SIGNED, AND SAID SO. A box on a home network has no public name for a
 * certificate authority to vouch for, so the browser will show its "not
 * private" page the first time and the owner proceeds once. That is the honest
 * cost of a microphone on a LAN address: after it the page is a secure context
 * and Chrome, Edge, Safari and Firefox all hand over the mic. A reverse proxy
 * or Tailscale certificate in front of the plain port is the no-warning route,
 * and nothing here gets in its way.
 *
 * openssl, because Node can sign with a certificate and cannot make one. The
 * names are every address this machine answers on TODAY; a box that changes
 * address gets a new certificate on the next start.
 */
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

const DIR = join(DATA_DIR, "tls");
const KEY = join(DIR, "key.pem"), CERT = join(DIR, "cert.pem");
const DAYS = 397;
const RENEW_BEFORE_MS = 30 * 86_400_000;

export function certificateNames(): string[] {
  const host = hostname().toLowerCase().replace(/[^a-z0-9.-]/g, "");
  const ips = Object.values(networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => `IP:${a!.address}`);
  return [...new Set(["DNS:localhost", ...(host ? [`DNS:${host}`, ...(host.includes(".") ? [] : [`DNS:${host}.local`])] : []), "IP:127.0.0.1", ...ips])].sort();
}

function current(names: string[]): boolean {
  if (!existsSync(KEY) || !existsSync(CERT)) return false;
  try {
    const cert = new X509Certificate(readFileSync(CERT));
    if (Date.parse(cert.validTo) - Date.now() < RENEW_BEFORE_MS) return false;
    const have = (cert.subjectAltName ?? "").split(",").map(n => n.trim().replace(/^IP Address:/, "IP:")).sort();
    return names.every(n => have.includes(n));
  } catch { return false; }
}

/** The key and certificate, made if missing, stale or for the wrong addresses.
 *  Null when openssl is not on the box — the plain door still opens. */
export function certificate(): { key: Buffer; cert: Buffer } | null {
  const names = certificateNames();
  if (!current(names)) {
    try {
      mkdirSync(DIR, { recursive: true, mode: 0o700 });
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", String(DAYS),
        "-keyout", KEY, "-out", CERT, "-subj", "/CN=One Person Company", "-addext", `subjectAltName=${names.join(",")}`,
        "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth"], { stdio: "pipe" });
      chmodSync(KEY, 0o600);
      console.log(`[tls] made a self-signed certificate for ${names.map(n => n.replace(/^(DNS|IP):/, "")).join(", ")}`);
    } catch (err) {
      console.warn(`[tls] could not make a certificate, so the HTTPS door stays shut: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      return null;
    }
  }
  return { key: readFileSync(KEY), cert: readFileSync(CERT) };
}
