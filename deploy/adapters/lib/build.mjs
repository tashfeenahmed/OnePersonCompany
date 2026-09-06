/**
 * A MAPPING FILE, RUN: rows out of the product's own database, a contract
 * document in.
 *
 * WHY IT SHELLS OUT TO THE DATABASE'S OWN CLIENT rather than using a driver.
 * The rule for this whole directory is no dependencies — see lib/config.mjs —
 * and the machine that has a Postgres database on it has `psql` on it. A
 * template that needed `npm install pg` first would be a template that is not
 * installed on the box it was written for. The cost is that every query comes
 * back as JSON text, which every one of these clients can produce natively.
 *
 * WHY THE QUERY IS THE OWNER'S AND NOT GENERATED. Two forms are offered — a
 * table plus a column map, and a raw `query:` — and the raw one is the one most
 * real products need, because "who is a customer" in a real schema is a join
 * against a subscriptions table and not a column. Generating SQL from a
 * declarative filter language would produce a language less expressive than
 * SQL, learnt by one person, to avoid writing SQL.
 *
 * WHAT THIS REFUSES TO DO. It never writes to the database: `--check` runs the
 * query with a row limit and the normal run runs it whole, and both are the
 * owner's own SELECT. It never invents a population — an unmapped value falls
 * to the configured default and IS COUNTED AND REPORTED, so a role nobody
 * mapped shows up as a number rather than as silently-more-customers. And it
 * never sets `contactPermitted` true without a `contact_mapping` block, which
 * is the whole reason that block is separate from the column map: consent has
 * to be something somebody typed on purpose.
 */
import { spawnSync } from "node:child_process";
import { POPULATIONS } from "./contract.mjs";
import { expandEnv } from "./config.mjs";

/* --------------------------------------------------------------- running */

function run(cmd, args, input, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  if (r.error && r.error.code === "ENOENT")
    throw new Error(`\`${cmd}\` is not on this machine's PATH. The adapter runs where the database's own client lives; install it or set driver: command.`);
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw new Error(`${cmd} exited ${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(0, 6).join(" ")}`);
  return r.stdout;
}

/**
 * `ssh -o BatchMode=yes …` in front of a command, when the mapping asks for it.
 * BatchMode because an adapter on a cron that waits at a password prompt is an
 * adapter that has silently stopped.
 *
 * THE PASSWORD CROSSES AS AN ENVIRONMENT ASSIGNMENT AND NOT AS AN ARGUMENT.
 * `ssh host 'PGPASSWORD=x psql …'` puts the assignment in the remote shell's
 * command, where it is part of `argv` for the SHELL and then inherited by psql
 * — so `ps` on the remote box shows the psql process without it. That is
 * strictly better than a password inside the DSN argument, which every `ps`
 * on both machines can read for the length of the query, and it is still not
 * as good as a ~/.pgpass on the remote box, which is what the README
 * recommends and what this cannot do on the owner's behalf.
 */
function overSsh(source, cmd, args, extraEnv = {}) {
  const host = expandEnv(source.ssh);
  const key = source.ssh_key ? expandEnv(source.ssh_key) : null;
  const q = (a) => `'${String(a).replaceAll("'", `'\\''`)}'`;
  const assignments = Object.entries(extraEnv).map(([k, v]) => `${k}=${q(v)}`);
  const quoted = [...assignments, ...[cmd, ...args].map(q)].join(" ");
  return [
    "ssh",
    [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      ...(key ? ["-i", key, "-o", "IdentitiesOnly=yes"] : []),
      host,
      quoted,
    ],
  ];
}

/**
 * The query, as a JSON array of row objects.
 *
 * Every driver produces THE SAME SHAPE — an array of objects keyed by the
 * query's own column aliases — because the mapping below has to be written
 * once and not once per engine.
 */
export function fetchRows(source, sql, limit = null) {
  const driver = (source.driver ?? "").trim();
  const bounded = limit ? `SELECT * FROM (${stripTrailingSemicolon(sql)}) AS opc_sample LIMIT ${Number(limit)}` : stripTrailingSemicolon(sql);

  let cmd;
  let args;
  let post = (out) => JSON.parse(out.trim() || "[]");

  /* THE PASSWORD NEVER BECOMES AN ARGV ELEMENT. psql and mysql both take their
     connection string as an argument, so a password inside `dsn:` is readable
     in `ps` by any other user on the box for the length of the query — and over
     ssh, on the remote box too. `password:` goes through the child's
     environment instead. See the README beside the mode-600 advice. */
  let env = {};

  if (driver === "postgres" || driver === "postgresql") {
    const dsn = expandEnv(source.dsn ?? "");
    if (!dsn) throw new Error("source.dsn is required for the postgres driver — a libpq connection string, usually ${SOMETHING_DSN} out of the environment.");
    if (source.password) env = { PGPASSWORD: expandEnv(source.password) };
    cmd = "psql";
    args = ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", dsn, "-c",
      `SELECT COALESCE(json_agg(opc_t), '[]'::json)::text FROM (${bounded}) AS opc_t`];
  } else if (driver === "sqlite" || driver === "sqlite3") {
    const file = expandEnv(source.dsn ?? source.file ?? "");
    if (!file) throw new Error("source.dsn is required for the sqlite driver — the path to the .db file on the machine the query runs on.");
    cmd = "sqlite3";
    /* -readonly is not universal; the file: URI form is, and it is worth the
       ugliness: an adapter must not be able to write to the product's own
       database even by accident. */
    args = ["-json", `file:${file}?mode=ro`, bounded];
    post = (out) => JSON.parse(out.trim() || "[]");
  } else if (driver === "mysql" || driver === "mariadb") {
    const dsn = expandEnv(source.dsn ?? "");
    const fields = source.json_columns ?? Object.keys(source.columns ?? {});
    if (!fields.length)
      throw new Error(
        "The mysql driver needs the result columns named, because MySQL cannot turn an arbitrary row into JSON without them. " +
          "Either use the `columns:` form, or list the query's aliases under `source.json_columns`.",
      );
    const object = fields.map((f) => `'${f}', opc_t.\`${f}\``).join(", ");
    if (source.password) env = { MYSQL_PWD: expandEnv(source.password) };
    cmd = "mysql";
    args = ["--batch", "--raw", "--skip-column-names", ...(dsn ? [dsn] : []), "-e",
      `SELECT IFNULL(JSON_ARRAYAGG(JSON_OBJECT(${object})), '[]') FROM (${bounded}) AS opc_t`];
  } else if (driver === "command") {
    /* THE ESCAPE HATCH, and it is here rather than left out because the honest
       shape of this tool is "something prints a JSON array of rows". A product
       whose users live in Mongo, or behind an ORM, writes six lines of its own
       and everything below still applies. */
    const line = expandEnv(source.command ?? "");
    if (!line) throw new Error("source.command is required for the command driver — a shell command printing a JSON array of row objects on stdout.");
    cmd = "/bin/sh";
    args = ["-c", line];
  } else {
    throw new Error(`source.driver is “${driver || "missing"}”. It is one of: postgres, mysql, sqlite, command.`);
  }

  if (source.ssh) {
    [cmd, args] = overSsh(source, cmd, args, env);
    /* The assignment travels inside the remote command line, so it must not
       also be set locally — `ssh` would not forward it and it would only be
       one more place the value lives. */
    env = {};
  }

  let out;
  try {
    out = run(cmd, args, undefined, env);
  } catch (err) {
    throw new Error(`The query did not run. ${err.message}`);
  }
  let rows;
  try {
    rows = post(out);
  } catch {
    throw new Error(`The client answered, but not with JSON — it starts “${out.slice(0, 120).replace(/\s+/g, " ")}”.`);
  }
  if (!Array.isArray(rows)) throw new Error("The query produced something that is not an array of rows.");
  return rows;
}

function stripTrailingSemicolon(sql) {
  return String(sql).trim().replace(/;\s*$/, "");
}

/** The SQL a mapping means: its own `query`, or a SELECT built from `table`
 *  plus `columns`. */
export function queryFor(config) {
  const source = config.source ?? {};
  /* The command driver has no SQL at all — it is a shell line that prints rows
     — so asking it for a query would be asking the wrong question. Returning
     an empty string rather than throwing keeps the two callers identical. */
  if (source.driver === "command") return "";
  if (source.query) return String(source.query);
  const table = source.table;
  if (!table) throw new Error("The mapping needs either source.query or source.table.");
  const columns = config.columns ?? {};
  const extra = [];
  if (config.population?.column) extra.push(config.population.column);
  if (config.contact_mapping?.column) extra.push(config.contact_mapping.column);
  const selected = [
    ...Object.entries(columns).map(([field, column]) => `${column} AS "${field}"`),
    ...extra.map((c) => `${c} AS "${c}"`),
  ];
  if (!selected.length) throw new Error("The mapping has source.table and no columns:. Name at least id and createdAt.");
  const where = source.where ? ` WHERE ${source.where}` : "";
  return `SELECT ${selected.join(", ")} FROM ${table}${where}`;
}

/* --------------------------------------------------------------- mapping */

const ISO = /^\d{4}-\d{2}-\d{2}([T ]|$)/;

/** A database timestamp, as the contract's ISO 8601. Numbers are treated as
 *  epoch seconds or milliseconds — SQLite stores both and the difference is
 *  four decades, so it is decided by magnitude and said in the note. */
function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    const ms = value > 1e11 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const s = String(value).trim();
  if (ISO.test(s)) {
    const d = new Date(s.includes("T") || s.includes("+") || s.endsWith("Z") ? s : s.replace(" ", "T") + (s.length > 10 ? "Z" : ""));
    return Number.isFinite(d.getTime()) ? d.toISOString() : s.slice(0, 10);
  }
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function toBool(value, trueValues) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const set = (trueValues ?? [true, 1, "1", "t", "true", "yes", "y"]).map((v) => String(v).toLowerCase());
  return set.includes(String(value).toLowerCase());
}

/**
 * Rows to a users document.
 *
 * `notes` comes back beside the document and is not cosmetic: it carries the
 * population values that matched no rule, which is the one mistake in a mapping
 * that produces a document the validator will happily accept and that is
 * nevertheless wrong.
 */
export function buildUsers(config, rows) {
  const pop = config.population ?? {};
  const def = pop.default ?? "customer";
  if (!POPULATIONS.includes(def))
    throw new Error(`population.default is “${def}”. It is one of ${POPULATIONS.join(", ")}.`);
  const map = pop.map ?? {};
  for (const [from, to] of Object.entries(map))
    if (!POPULATIONS.includes(to))
      throw new Error(`population.map maps “${from}” to “${to}”, which is not one of ${POPULATIONS.join(", ")}.`);

  const consent = config.contact_mapping ?? null;
  if (consent && !consent.column && !consent.field)
    throw new Error("contact_mapping is present with no column: — say WHICH column in the result set records consent, or remove the block entirely and every row is contactPermitted: false.");
  if (consent && !consent.consent_note)
    throw new Error(
      "contact_mapping needs a consent_note: one sentence saying where in the product a person agreed to be written to. " +
        "It is written into the document and shown beside the count. An adapter that claims consent without being able to say where it came from is the thing this field exists to prevent.",
    );

  const unmapped = new Map();
  const users = [];
  const seen = new Set();
  let duplicates = 0;

  for (const row of rows) {
    const id = row.id ?? row.ID ?? null;
    const createdAt = toIso(row.createdAt ?? row.created_at ?? null);
    if (id === null || id === undefined || createdAt === null) continue;
    const key = String(id);
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);

    let population = def;
    if (pop.column) {
      const raw = row[pop.column];
      const found = raw === null || raw === undefined ? undefined : map[String(raw)];
      if (found) population = found;
      else if (raw !== null && raw !== undefined)
        unmapped.set(String(raw), (unmapped.get(String(raw)) ?? 0) + 1);
    }

    const permitted = consent ? toBool(row[consent.column ?? consent.field], consent.true_values) === true : false;

    const u = { id: key, createdAt, population };
    if (row.email) u.email = String(row.email);
    if (row.plan !== undefined && row.plan !== null && row.plan !== "") u.plan = String(row.plan);
    if (row.paid !== undefined && row.paid !== null) u.paid = toBool(row.paid, config.paid_true_values);
    const last = toIso(row.lastSeenAt ?? row.last_seen_at ?? null);
    if (last) u.lastSeenAt = last;
    if (row.country) u.country = String(row.country);
    if (permitted) u.contactPermitted = true;
    users.push(u);
  }

  const doc = { users, generatedAt: new Date().toISOString() };
  if (typeof config.total === "number") doc.total = config.total;

  const notes = [];
  if (duplicates)
    notes.push(`${duplicates} row(s) shared an id with an earlier row and were dropped. The contract needs one row per id — check the query for a join that fans out.`);
  for (const [value, n] of unmapped)
    notes.push(`population.map has no entry for “${value}” (${n} row(s)); they were counted as ${def}. Map it or confirm the default is right.`);
  if (consent) notes.push(`contactPermitted comes from ${consent.column ?? consent.field}: ${consent.consent_note}`);
  else notes.push("No contact_mapping is configured, so every row is contactPermitted: false. That is the default and it is deliberate.");

  return { doc, notes };
}

/** Rows to a counts-only document, for a product that cannot list its users.
 *  The query returns ONE row with `total` and optionally `new`. */
export function buildCounts(config, rows) {
  const row = rows[0] ?? {};
  const total = Number(row.total ?? row.count ?? NaN);
  if (!Number.isFinite(total))
    throw new Error(
      "A counts-only mapping's query must return one row with a `total` column. " +
        `It returned ${rows.length} row(s) with: ${Object.keys(row).join(", ") || "nothing"}.`,
    );
  const doc = { counts: { total: Math.round(total) }, generatedAt: new Date().toISOString() };
  const days = Number(config.new_days ?? config.output?.new_days ?? NaN);
  const fresh = Number(row.new ?? row.fresh ?? NaN);
  if (Number.isFinite(days) && Number.isFinite(fresh)) doc.counts.new = { days: Math.round(days), n: Math.round(fresh) };
  return {
    doc,
    notes: [
      "This is the counts-only form: the product publishes a total and names nobody. " +
        "That is a different fact from an empty users array, and the dashboard reports it as such.",
    ],
  };
}
