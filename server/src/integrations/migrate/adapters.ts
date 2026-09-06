/**
 * ADAPTER VALIDATION — the loop that would otherwise take a night to close.
 *
 * An adapter (see deploy/adapters/) runs on the PRODUCT's host, on the
 * product's cron, and publishes a document this box only reads at collection
 * time — every thirty minutes at best. So the feedback on a mapping somebody
 * just edited is: wait, then look at a page, then guess. That is how a renamed
 * column becomes a chart with nothing on it for two days.
 *
 * This closes it. `POST /api/migrate/adapters/validate` takes a sample payload
 * and answers with the SAME SENTENCES the collector would produce, because it
 * calls the SAME FUNCTION — `validate()` out of activity/users.ts, not a copy.
 * That is the whole design: a validator that reimplemented the rules would
 * drift, and a validator that drifts is worse than none, because somebody would
 * trust it.
 *
 * WHAT IT ADDS ON TOP OF `validate()`. The population breakdown and the
 * contactable count, which the collector does not report because it is storing
 * rather than explaining. Those two numbers are the ones a mapping gets wrong
 * silently: a `population.map` missing an entry produces a document that is
 * perfectly valid and quietly counts four thousand participants as customers.
 *
 * NOTHING IS STORED FROM THE PAYLOAD EXCEPT COUNTS AND PROBLEMS. Not the rows,
 * not the addresses, not the document. The sample is somebody's real user list;
 * it is validated in memory and the only thing that outlives the request is
 * "endpoint X was checked at time T, 4,873 rows, 12 admins, 0 contactable, and
 * here are the three sentences that were wrong with it".
 */
import { db, now } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { POPULATIONS, type Population, validate } from "../activity/users.ts";
import { PLUGIN as PRODUCT_STATS, metricsFor, parseMetrics, resolve } from "../ops/products.ts";
import { configValue } from "../../db.ts";

export type Populations = Record<Population | "unstated", number>;

export type ValidationResult = {
  ok: boolean;
  contract: "users";
  shape: "users" | "counts" | null;
  rows: number | null;
  total: number | null;
  populations: Populations | null;
  contactable: number | null;
  problems: string[];
  note: string;
};

/** One sample document against the live contract. */
export function validateSample(doc: unknown): ValidationResult {
  const check = validate(doc);
  if (!check.ok)
    return {
      ok: false, contract: "users", shape: null, rows: null, total: null,
      populations: null, contactable: null, problems: check.problems,
      note: "REFUSED. A document in this state changes nothing: the collector keeps whatever the endpoint last published, dated, beside the reason — so a page would go on showing yesterday's figures rather than emptying.",
    };

  const p = check.parsed;
  if (p.shape === "counts")
    return {
      ok: true, contract: "users", shape: "counts", rows: null, total: p.total,
      populations: null, contactable: null, problems: check.problems,
      note:
        "The counts-only form: a product saying it has users and cannot name them. That is a different fact from an empty list, and nothing here will report it as zero. " +
        "Populations cannot be broken down in this form — if the product can count its admins separately, it can publish the users form instead.",
    };

  const populations = { customer: 0, participant: 0, admin: 0, trial: 0, internal: 0, unstated: 0 } as Populations;
  let contactable = 0;
  for (const u of p.users) {
    populations[u.population] += 1;
    if (u.contactPermitted) contactable += 1;
  }

  const notes: string[] = [];
  if (populations.customer === p.users.length && p.users.length > 1)
    notes.push(
      "Every row is a customer. That is correct for a product whose users all signed up for themselves, and it is the DEFAULT for a document that never mentions population — so check that the adapter is actually classifying rather than staying silent.",
    );
  if (contactable === 0 && p.users.length)
    notes.push("No row claims consent, which is the default and is deliberate: contactPermitted is only ever true where the adapter was given an explicit consent mapping.");
  if (contactable === p.users.length && p.users.length > 1)
    notes.push(
      "EVERY row claims consent. That is possible and it is rare. Check the mapping's true_values — a column of NULLs read leniently produces exactly this.",
    );

  return {
    ok: true,
    contract: "users",
    shape: "users",
    rows: p.users.length,
    total: p.total,
    populations,
    contactable,
    problems: check.problems,
    note:
      (check.problems.length
        ? `Accepted with ${check.problems.length} row problem(s): those rows are skipped and the rest kept. `
        : "Accepted. ") + notes.join(" "),
  };
}

/** Written down per endpoint so the page can say which adapters have been
 *  checked and which never have. Replaced, not appended — see 295's header. */
export function recordValidation(endpoint: string, contract: string, r: ValidationResult, bytes: number): void {
  db.prepare(
    `INSERT INTO migrate_validations (endpoint, ts, contract, ok, shape, rows, total, problems, populations, contactable, bytes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET
       ts = excluded.ts, contract = excluded.contract, ok = excluded.ok, shape = excluded.shape,
       rows = excluded.rows, total = excluded.total, problems = excluded.problems,
       populations = excluded.populations, contactable = excluded.contactable, bytes = excluded.bytes`,
  ).run(
    endpoint, now(), contract, r.ok ? 1 : 0, r.shape, r.rows, r.total,
    JSON.stringify(r.problems), JSON.stringify(r.populations ?? {}), r.contactable, bytes,
  );
}

export type ValidationRow = {
  endpoint: string;
  ts: string;
  contract: string;
  ok: number;
  shape: string | null;
  rows: number | null;
  total: number | null;
  problems: string;
  populations: string;
  contactable: number | null;
  bytes: number | null;
};

export function validations(): ValidationRow[] {
  return db
    .prepare("SELECT * FROM migrate_validations ORDER BY ts DESC")
    .all() as unknown as ValidationRow[];
}

/* --------------------------------------------------------- the endpoints */

export type Endpoint = {
  /** The account's label — the product's name. */
  label: string;
  /** 'users' or 'product-stats'. */
  plugin: string;
  accountId: number;
  connected: boolean;
  /** When the collector last read it, and what it said. */
  lastRead: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  /** The last VALIDATION of a sample, which is a different thing from the last
   *  read: an adapter can be validated before it is connected and after it has
   *  gone quiet, and both are worth knowing. */
  validated: {
    ts: string;
    ok: boolean;
    shape: string | null;
    rows: number | null;
    populations: Record<string, number>;
    contactable: number | null;
    problems: string[];
  } | null;
  /** For a product-stats endpoint: which mapped paths currently resolve in the
   *  document it last answered with, and which do not. A path that matches
   *  nothing is a MAPPING ERROR and never a zero. */
  metrics: { label: string; path: string; value: number | null; why: string | null }[] | null;
};

/**
 * Every configured product endpoint, on both plugins, with its last read and
 * its last validation.
 *
 * BOTH PLUGINS IN ONE LIST because they are one question to the person setting
 * an adapter up: `users` and `product-stats` are two contracts published by the
 * same box, usually by the same cron job, and a page that made the owner look
 * in two places to find out whether their adapter works would be a page that
 * describes this application's internals rather than their product.
 */
export function endpoints(): Endpoint[] {
  const checks = new Map(validations().map((v) => [v.endpoint.toLowerCase(), v] as const));
  const out: Endpoint[] = [];

  const docsFor = (table: string) =>
    new Map(
      (db.prepare(`SELECT account_id, ts, ok, error, doc FROM ${table}`).all() as unknown as {
        account_id: number; ts: string; ok: number; error: string | null; doc: string | null;
      }[]).map((r) => [r.account_id, r] as const),
    );
  const userDocs = docsFor("activity_user_docs");
  const statDocs = docsFor("product_docs");
  const metrics = parseMetrics(configValue(PRODUCT_STATS, "metrics"));

  for (const plugin of ["users", PRODUCT_STATS]) {
    for (const account of accounts.list(plugin)) {
      const doc = (plugin === "users" ? userDocs : statDocs).get(account.id);
      const v = checks.get(account.label.trim().toLowerCase()) ?? null;

      let resolved: Endpoint["metrics"] = null;
      if (plugin === PRODUCT_STATS) {
        let parsedDoc: unknown = null;
        try {
          parsedDoc = doc?.doc ? JSON.parse(doc.doc) : null;
        } catch {
          parsedDoc = null;
        }
        resolved = metricsFor(metrics, account.label).map((m) => {
          if (parsedDoc === null) return { label: m.label, path: m.path, value: null, why: "the endpoint has not answered with a document yet." };
          const r = resolve(parsedDoc, m);
          return r.ok
            ? { label: m.label, path: m.path, value: r.value, why: null }
            : { label: m.label, path: m.path, value: null, why: r.why };
        });
      }

      out.push({
        label: account.label,
        plugin,
        accountId: account.id,
        connected: !!account.connected,
        lastRead: doc?.ts ?? null,
        lastOk: doc ? doc.ok === 1 : null,
        lastError: doc?.error ?? null,
        validated: v
          ? {
              ts: v.ts,
              ok: v.ok === 1,
              shape: v.shape,
              rows: v.rows,
              populations: JSON.parse(v.populations || "{}") as Record<string, number>,
              contactable: v.contactable,
              problems: JSON.parse(v.problems || "[]") as string[],
            }
          : null,
        metrics: resolved,
      });
      checks.delete(account.label.trim().toLowerCase());
    }
  }

  /* A VALIDATION WITH NO ACCOUNT IS STILL A FACT, and it is the normal state
     halfway through setting an adapter up: the mapping is written, the sample
     has been checked, and nobody has pasted the URL in yet. Dropping these
     would make the recommended order of work — validate, then connect —
     invisible on the page that recommends it. `plugin: "unconnected"` says
     what they are; they carry no collection because there is nothing
     collecting them. */
  for (const v of checks.values())
    out.push({
      label: v.endpoint,
      plugin: "unconnected",
      accountId: 0,
      connected: false,
      lastRead: null,
      lastOk: null,
      lastError: null,
      validated: {
        ts: v.ts,
        ok: v.ok === 1,
        shape: v.shape,
        rows: v.rows,
        populations: JSON.parse(v.populations || "{}") as Record<string, number>,
        contactable: v.contactable,
        problems: JSON.parse(v.problems || "[]") as string[],
      },
      metrics: null,
    });

  return out;
}

/** What the populations column actually holds, per product, right now. The
 *  proof that the contract extension is live rather than merely accepted. */
export function populationCounts(): { product: string; accountId: number; populations: Record<string, number>; contactable: number }[] {
  const rows = db
    .prepare(
      `SELECT account_id, product, COALESCE(population, 'customer') AS population,
              COUNT(*) AS n, SUM(contact_permitted) AS permitted
         FROM activity_users GROUP BY account_id, population`,
    )
    .all() as unknown as { account_id: number; product: string; population: string; n: number; permitted: number }[];
  const by = new Map<number, { product: string; accountId: number; populations: Record<string, number>; contactable: number }>();
  for (const r of rows) {
    const entry = by.get(r.account_id) ?? { product: r.product, accountId: r.account_id, populations: {}, contactable: 0 };
    entry.populations[r.population] = r.n;
    entry.contactable += Number(r.permitted ?? 0);
    by.set(r.account_id, entry);
  }
  return [...by.values()];
}

export { POPULATIONS };
