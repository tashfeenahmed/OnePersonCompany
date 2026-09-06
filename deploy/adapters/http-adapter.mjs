#!/usr/bin/env node
/**
 * THE HTTP PROXY ADAPTER — the same mapping, served instead of written.
 *
 *   OPC_ADAPTER_TOKEN=… node http-adapter.mjs <mapping.yaml> [--port 8791]
 *                                             [--bind 127.0.0.1] [--stats FILE]
 *
 *   GET /opc/users   the users contract, built live from the mapping
 *   GET /opc/stats   the product-stats contract: whatever JSON you hand it
 *   GET /opc/health  no token, no data — is the process up
 *
 * WHY BOTH THIS AND sql-adapter.mjs. They answer different constraints and
 * neither is the better one. Writing a file is right where a web server is
 * already serving a directory and the product's user list changes slowly — it
 * costs nothing between cron ticks and it survives this process dying. Serving
 * live is right where the number has to be current at the moment it is asked
 * for, where there is no web root to write into, or where the answer must be
 * behind a token that the file's directory listing cannot enforce.
 *
 * NO EXPRESS AND NO DEPENDENCIES. node:http is a web server. The reason for
 * the rule is in lib/config.mjs; the practical version is that this file drops
 * onto a box with `scp` and runs.
 *
 * THE TOKEN IS REQUIRED AND IT IS NOT OPTIONAL-WITH-A-WARNING. This process
 * answers with every user id and address in the product, and a template that
 * started without a token would be deployed without one. It reads
 * OPC_ADAPTER_TOKEN from the environment and refuses to start without it,
 * compares with a constant-time compare, and never logs it. It is the same
 * token pasted into the dashboard's product endpoint account, which sends it
 * as `Authorization: Bearer`.
 *
 * BIND 127.0.0.1 BY DEFAULT, deliberately. Put it behind the reverse proxy
 * that already terminates TLS for the product. A bearer token over plaintext
 * on a LAN is a bearer token somebody has.
 *
 * A CACHE, BECAUSE A SELECT OVER FOUR THOUSAND USERS IS NOT A THING TO DO PER
 * REQUEST. `cache_seconds:` in the mapping (default 300) and the answer says
 * how old it is in `generatedAt`, which is the field the contract has for
 * exactly this. A failed rebuild SERVES THE LAST GOOD DOCUMENT with a 200 and
 * an `adapterError` beside it — the same rule the dashboard applies at the
 * other end, for the same reason: one bad minute must not empty a page.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./lib/config.mjs";
import { validateUsers } from "./lib/contract.mjs";
import { buildCounts, buildUsers, fetchRows, queryFor } from "./lib/build.mjs";

const argv = process.argv.slice(2);
const VALUED = new Set(["--port", "--bind", "--stats"]);
const flags = new Map();
const bare = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { bare.push(a); continue; }
  if (VALUED.has(a) && argv[i + 1] && !argv[i + 1].startsWith("--")) { flags.set(a, argv[++i]); continue; }
  flags.set(a, "");
}
const flag = (name, fallback = null) => (flags.get(name) || fallback);
const configPath = bare[0];

const die = (m, hint) => {
  console.error(`\n  ${m}`);
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
};

if (!configPath || argv[0] === "--help" || argv[0] === "-h")
  die(
    "Name the mapping file.",
    "OPC_ADAPTER_TOKEN=… node http-adapter.mjs mapping.yaml --port 8791",
  );

const TOKEN = process.env.OPC_ADAPTER_TOKEN ?? "";
if (TOKEN.length < 24)
  die(
    "OPC_ADAPTER_TOKEN is not set, or is shorter than 24 characters.",
    "This process answers with every user id in the product. Generate one with " +
      "`node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"`, " +
      "put it in the unit file's EnvironmentFile, and paste the same value into the dashboard's endpoint account.",
  );

let config;
try {
  config = loadConfig(resolve(configPath));
} catch (err) {
  die("The mapping could not be read.", err.message);
}

const PORT = Number(flag("--port", config.serve?.port ?? 8791));
const BIND = flag("--bind", config.serve?.bind ?? "127.0.0.1");
const CACHE_MS = Number(config.serve?.cache_seconds ?? 300) * 1000;
const STATS_FILE = flag("--stats", config.serve?.stats_file ?? null);
const SHAPE = (config.output?.shape ?? "users").trim();

/** Constant time, and only after the lengths match — a compare that returned
 *  early on the first byte is a compare that leaks the token one byte at a
 *  time to anybody willing to make a few thousand requests. */
function tokenOk(header) {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1] ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ----------------------------------------------------------------- cache */

let cached = null;
let cachedAt = 0;
let lastError = null;

function usersDoc() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return { doc: cached, stale: false };
  try {
    const rows = fetchRows(config.source ?? {}, queryFor(config), null);
    const built = SHAPE === "counts" ? buildCounts(config, rows) : buildUsers(config, rows);
    const check = validateUsers(built.doc);
    if (!check.ok) throw new Error(`The mapping produced a document the contract refuses: ${check.problems.join(" ")}`);
    cached = built.doc;
    cachedAt = now;
    lastError = null;
    return { doc: cached, stale: false };
  } catch (err) {
    lastError = err.message;
    /* THE LAST GOOD DOCUMENT, dated, beside the reason. See the header. */
    if (cached) return { doc: { ...cached, adapterError: lastError }, stale: true };
    return null;
  }
}

/* ----------------------------------------------------------------- server */

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  /* HEALTH TAKES NO TOKEN ON PURPOSE, so it must say nothing that a stranger
     is better off not knowing. `failing` is a BOOLEAN and not the sentence:
     lastError is the database client's own text, which names the host, the
     database user and sometimes ssh's "Permission denied" — an unauthenticated
     map of the internal topology. A supervisor needs "is it up and is it
     currently failing", which is exactly this and no more. The sentence is on
     /opc/users, behind the token, where somebody debugging can read it. */
  if (path === "/opc/health")
    return send(res, 200, {
      ok: true,
      contract: SHAPE,
      cachedAt: cachedAt ? new Date(cachedAt).toISOString() : null,
      failing: lastError !== null,
      note: "The reason a rebuild is failing is on /opc/users, which takes the token.",
    });

  if (req.method !== "GET") return send(res, 405, { error: "This adapter answers GET." });
  if (!tokenOk(req.headers.authorization))
    return send(res, 401, { error: "Send the adapter token as Authorization: Bearer <token>." });

  if (path === "/opc/users") {
    const got = usersDoc();
    if (!got) return send(res, 503, { error: `The product's database has not been read successfully yet. ${lastError ?? ""}`.trim() });
    return send(res, 200, got.doc);
  }

  if (path === "/opc/stats") {
    /* THE STATS SIDE IS NOT MAPPED HERE and that is the correct division. The
       product-stats contract is "any JSON object"; which numbers in it matter
       is a mapping the DASHBOARD holds, resolved at read time, so that editing
       it does not need a deploy on this box. So this route serves a file the
       product already writes, or the `serve.stats` block inline. */
    if (STATS_FILE) {
      try {
        return send(res, 200, JSON.parse(readFileSync(resolve(STATS_FILE), "utf8")));
      } catch (err) {
        return send(res, 503, { error: `${STATS_FILE} could not be read as JSON: ${err.message}` });
      }
    }
    if (config.serve?.stats) return send(res, 200, config.serve.stats);
    return send(res, 404, {
      error:
        "No stats source is configured. Point --stats at the JSON file your product already writes, or put the numbers under serve.stats in the mapping. " +
        "Which of them the dashboard records is a setting there, not here.",
    });
  }

  return send(res, 404, { error: "Two routes: /opc/users and /opc/stats." });
});

server.listen(PORT, BIND, () => {
  console.error(`  ${configPath} · listening on http://${BIND}:${PORT}/opc/users · cache ${CACHE_MS / 1000}s`);
  console.error("  Put it behind the reverse proxy that already terminates TLS for this product.");
});
