/**
 * NOTHING IN THIS REPOSITORY POINTS AT ONE PERSON'S MACHINE.
 *
 * This is single-owner software meant to be cloned. That makes any real
 * address left in the source a default somebody else inherits: the SearXNG
 * provider once fell back to a public node belonging to whoever wrote it, so
 * an install that had not filled the field in sent its owner's searches — the
 * topics, the timing — to a stranger's box, and said nothing about it.
 *
 * The patterns below are the shapes that mistake takes: a bare IPv4 literal, a
 * hostname that encodes one (sslip.io, nip.io), or a personal address. Example
 * and documentation ranges are allowed, because a placeholder has to look like
 * something. If this fails, the fix is a placeholder or a setting — never a
 * different real host.
 *
 * IT SCANS SOURCE AND NOT TESTS, deliberately. A test needs real-looking
 * literals to be worth anything — the SSRF cases want `172.15.0.1` and
 * `172.32.0.1` precisely because they sit just outside the private range, and
 * the mailbox cases want addresses that look like addresses. None of that is a
 * default anybody inherits. What this catches is a value some install will
 * silently use because its owner never filled the field in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Reserved, documentation and loopback ranges a placeholder may use. */
const ALLOWED_IP =
  /^(0\.0\.0\.0|127\.|255\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|1\.1\.1\.1|8\.8\.8\.8)/;

const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "data") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
  }
})(root);

test("no source file carries a real IP address or an IP-encoding hostname", () => {
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      const where = `${file.slice(root.length)}:${i + 1}`;
      /* A hostname that encodes an address in its own labels. */
      if (/\b\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\.(sslip|nip)\.io\b/.test(line))
        found.push(`${where}  ${line.trim()}`);
      /* Not preceded by `/`, which is a version and not an address: the
         browser User-Agent carries `Chrome/124.0.0.0`. */
      for (const m of line.matchAll(/(^|[^\w./])(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g))
        if (!ALLOWED_IP.test(m[2]!)) found.push(`${where}  ${m[2]}`);
    });
  }
  assert.deepEqual(found, [], `a real address is a default somebody else inherits:\n${found.join("\n")}`);
});

/**
 * A placeholder address is fine and a real one is not, so this has to know the
 * difference. `.local` is unroutable by definition, `example.*` and `x.io` are
 * for documentation, and an address at a reserved IP cannot reach anybody.
 * What is left is somebody's actual mailbox.
 */
const ALLOWED_ADDRESS =
  /@(example\.(com|org|net|invalid)|acme\.|x\.io|[\w-]+\.local\b|localhost|[\w.-]*\.example\b)/;

test("no source file carries a personal email address", () => {
  const found: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        /* The domain must start with a letter: `black@0.45` is a subtitle
           colour and an alpha value, not a mailbox. */
        for (const address of line.match(/[\w.+-]+@[a-zA-Z][\w-]*\.[\w.-]+/g) ?? []) {
          if (ALLOWED_ADDRESS.test(address)) continue;
          const host = address.slice(address.indexOf("@") + 1);
          if (ALLOWED_IP.test(host)) continue;
          /* `a@b.io` — a one- or two-letter domain is nobody's real mailbox,
             it is a comment showing the shape of a header. */
          if ((host.split(".")[0] ?? "").length <= 2) continue;
          found.push(`${file.slice(root.length)}:${i + 1}  ${address}`);
        }
      });
  }
  assert.deepEqual(found, [], `use an example address:\n${found.join("\n")}`);
});
