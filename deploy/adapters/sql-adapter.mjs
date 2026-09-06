#!/usr/bin/env node
/**
 * THE SQL ADAPTER — one product's database, published as a contract document.
 *
 *   node sql-adapter.mjs <mapping.yaml|json> [--out FILE] [--check] [--check SAMPLE.json]
 *                        [--limit N] [--pretty] [--quiet]
 *
 * WHAT IT IS FOR. The dashboard's users contract asks a product for a JSON
 * document at a URL. Plenty of products have no such URL and no appetite for a
 * deploy to grow one — the database is right there, and the honest shortest
 * path is a cron job that runs a SELECT and writes a file the web server
 * already serves. That is this program.
 *
 * THE THREE MODES.
 *   normal      run the query, build the document, write it (or print it).
 *   --check     run the query with a LIMIT, build the document, validate it,
 *               print every problem and every note, write NOTHING, exit 1 if
 *               the document would be refused.
 *   --check F   validate the sample file F against the contract and exit. No
 *               database is touched, which is what makes this runnable on a
 *               laptop against a payload somebody pasted from production. F has
 *               to end in .json — so `--check mapping.yaml` is read as "check
 *               this mapping", which is what somebody typing it meant.
 *
 * WHY --check WRITES NOTHING. The file this produces is read by a collector
 * every half hour, and a half-written or half-mapped document is worse than a
 * stale one — the dashboard keeps the last good document on a refusal, and a
 * check that clobbered the good file would have destroyed the thing it was
 * protecting. So a check is read-only in both directions.
 *
 * WHY THE EXIT CODE MATTERS. Put this on a cron with the check first:
 *   node sql-adapter.mjs mapping.yaml --check --quiet && node sql-adapter.mjs mapping.yaml
 * and a mapping broken by a schema change stops updating the file rather than
 * replacing four thousand users with an error message.
 *
 * WHAT IT NEVER DOES. It never writes to the product's database. It never sets
 * contactPermitted true without a contact_mapping block carrying a consent_note
 * — see lib/build.mjs.
 *
 * WHERE THIS FILE GOES, AND IT IS NOT A DETAIL. The document this writes
 * contains EVERY CUSTOMER'S RAW EMAIL ADDRESS. The dashboard hashes them on
 * arrival; this file, on the product's own disk, does not. So:
 *
 *   - it is written 0640, owned by the user that runs the cron, group-readable
 *     by whatever serves it and readable by nobody else;
 *   - it does NOT go in a directory a web server publishes unauthenticated. A
 *     static file cannot check the bearer token the dashboard is perfectly
 *     willing to send, so "it is under a long random path" is the WEAKEST
 *     acceptable answer and "it is behind the same auth as the admin API" is
 *     the right one;
 *   - if neither is convenient, that is exactly what http-adapter.mjs is for:
 *     it requires a token, on every request, by construction.
 *
 * With no --out the document goes to STDOUT, which under a cron becomes a mail
 * containing those addresses. Pass --out, or --quiet with a redirect you chose.
 */
import { chmodSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./lib/config.mjs";
import { validateUsers } from "./lib/contract.mjs";
import { buildCounts, buildUsers, fetchRows, queryFor } from "./lib/build.mjs";

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
  console.log(readFileSync(new URL(import.meta.url).pathname, "utf8").split("*/")[0].replace(/^\/\*\*?/, "").replace(/^ \* ?/gm, ""));
  process.exit(argv.length ? 0 : 1);
}

/**
 * The command line, parsed once.
 *
 * `--check` is the one flag with an OPTIONAL value, which is why this is a
 * hand-rolled loop rather than a lookup: `--check` alone means "run the query
 * and check what it produces", and `--check sample.json` means "check that file
 * and never touch a database". Those are different enough to be worth the
 * twelve lines.
 */
/* A MAPPING FILE IS NOT A SAMPLE FILE, and `--check mapping.yaml` is the
   command everybody types. Without this, `--check` swallows the mapping as its
   optional sample value and the program dies with "could not be read as JSON",
   which is true and is the wrong sentence entirely. A value for --check has to
   look like a JSON payload; anything else is the positional argument. */
const looksLikeSample = (a) => /\.json$/i.test(a);
const VALUE_LOOKS_WRONG = (flag, value) => flag === "--check" && !looksLikeSample(value);

const VALUED = new Set(["--out", "--limit", "--check"]);
const flags = new Map();
const bare = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) { bare.push(a); continue; }
  const next = argv[i + 1];
  if (VALUED.has(a) && next && !next.startsWith("--") && !VALUE_LOOKS_WRONG(a, next)) {
    flags.set(a, argv[++i]);
    continue;
  }
  flags.set(a, "");
}
const flag = (name) => (flags.has(name) ? flags.get(name) : null);
const has = (name) => flags.has(name);

const quiet = has("--quiet");
const say = (...a) => { if (!quiet) console.error(...a); };
const die = (message, hint) => {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error("");
  process.exit(1);
};

/* ---------------------------------------------------- --check on a sample */

const checkArg = flag("--check");
if (checkArg) {
  /* A SAMPLE FILE AND NO DATABASE. This is the mode to run against a payload
     somebody pasted out of production, on a laptop, before anything is
     deployed anywhere. */
  let doc;
  try {
    doc = JSON.parse(readFileSync(resolve(checkArg), "utf8"));
  } catch (err) {
    die(`${checkArg} could not be read as JSON.`, err.message);
  }
  const result = validateUsers(doc);
  report(result, [], `${checkArg} — checked against the contract, no database was touched`);
  process.exit(result.ok ? 0 : 1);
}

/* ------------------------------------------------------------ the mapping */

const configPath = bare[0];
if (!configPath) die("Name the mapping file.", "node sql-adapter.mjs mapping.yaml --check");

let config;
try {
  config = loadConfig(resolve(configPath));
} catch (err) {
  die(`The mapping could not be read.`, err.message);
}

const contract = (config.contract ?? "users").trim();
if (contract !== "users")
  die(
    `contract: is “${contract}”. This adapter builds the USERS contract; the product-stats contract is any JSON object your product already publishes, and the mapping for it lives in the dashboard's own settings rather than here.`,
    "See CHECKLIST.md, “Which contract am I writing”.",
  );

const shape = (config.output?.shape ?? "users").trim();
if (shape !== "users" && shape !== "counts")
  die(`output.shape is “${shape}”. It is “users” — the product can name its users — or “counts” — it can only say how many.`);

/* ------------------------------------------------------------- the query */

let sql;
try {
  sql = queryFor(config);
} catch (err) {
  die("The mapping does not describe a query.", err.message);
}

const checking = has("--check");
const limit = checking ? Number(flag("--limit") || 200) : flag("--limit") ? Number(flag("--limit")) : null;
if (limit !== null && !Number.isInteger(limit)) die(`--limit ${flag("--limit")} is not a whole number of rows.`);

let rows;
try {
  rows = fetchRows(config.source ?? {}, sql, limit);
} catch (err) {
  die("The product's database was not read.", err.message);
}

let built;
try {
  built = shape === "counts" ? buildCounts(config, rows) : buildUsers(config, rows);
} catch (err) {
  die("The rows could not be mapped onto the contract.", err.message);
}

const check = validateUsers(built.doc);

/* ------------------------------------------------------------- reporting */

function report(result, notes, what) {
  const line = (s) => console.error(`  ${s}`);
  console.error("");
  line(`${what}`);
  if (result.ok) {
    if (result.shape === "counts") line(`  accepted · counts form · total ${result.total}`);
    else {
      line(`  accepted · ${result.users.length} user row(s)${result.total !== null && result.total !== undefined ? ` of a stated ${result.total}` : ""}`);
      const p = result.populations ?? {};
      line(`  populations · ${Object.entries(p).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "none counted"}`);
      line(`  contactPermitted · ${result.contactable ?? 0} of ${result.users.length}`);
    }
  } else {
    line("  REFUSED — the dashboard would store nothing from this document and keep what it last had.");
  }
  for (const p of result.problems ?? []) line(`  ! ${p}`);
  for (const n of notes) line(`  · ${n}`);
  console.error("");
}

if (checking) {
  report(check, built.notes, `${configPath} — checked against ${rows.length} sampled row(s), nothing written`);
  process.exit(check.ok ? 0 : 1);
}

if (!check.ok) {
  report(check, built.notes, `${configPath} — NOT WRITTEN`);
  die(
    "The document this mapping produces would be refused, so it was not written.",
    "The file that is already there is left exactly as it was. Fix the mapping and run with --check.",
  );
}

/* --------------------------------------------------------------- writing */

const out = flag("--out") || config.output?.path || "";
const text = JSON.stringify(built.doc, null, has("--pretty") ? 2 : 0);

if (!out) {
  process.stdout.write(`${text}\n`);
} else {
  /* WRITTEN BESIDE AND RENAMED. rename(2) is atomic within a filesystem, so a
     collector that fetches the file mid-write gets the old one whole rather
     than the new one truncated — which is the same "half a document is worse
     than a stale one" rule the dashboard applies at the other end. */
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  /* 0640 AND NOT 0644, and `chmodSync` after the write because `writeFileSync`
     applies `mode` only on CREATE and only through the process umask. This file
     is every customer's raw address; it is not world-readable, and where it is
     served at all it is served behind the same authentication as the admin API
     it replaced. See the WHERE THIS FILE GOES block at the top. */
  writeFileSync(tmp, text, { mode: 0o640 });
  chmodSync(tmp, 0o640);
  renameSync(tmp, target);
  say(`  wrote ${target} · ${check.shape === "counts" ? `total ${check.total}` : `${check.users.length} row(s)`} · ${text.length} bytes`);
}
if (!quiet && check.problems.length) report(check, built.notes, `${configPath} — written with reservations`);
