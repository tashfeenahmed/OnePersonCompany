/**
 * THE USERS DOCUMENT.
 *
 * WHAT IS MEASURED AND WHAT IS COUNTED, and the difference decides every
 * figure below. `total` is the PRODUCT'S OWN count when the product published
 * one; a count of the rows this box holds is a FLOOR, because nothing here
 * deletes a row and nothing guarantees the endpoint listed everybody. Where the
 * two disagree the document's total wins and `rowsHeld` is printed beside it,
 * so "1,204 of 4,873 listed" is readable rather than being quietly reported as
 * a user base that shrank by three quarters.
 *
 * NEW COUNTS ARE PER WINDOW AND NEVER SUMMED. `new7d` is contained inside
 * `new30d`; adding them counts the first week twice. They are two answers to
 * two questions and there is no arithmetic between them.
 *
 * A PRODUCT THAT PUBLISHES ONLY COUNTS HAS NO WINDOWS AT ALL, except the one
 * it chose to publish. It has no rows, so nothing here can bucket its signups
 * by day, and `new7d`/`new30d` are null with `newWindow` carrying whatever the
 * product did say. Zero would read as "nobody signed up", which is the single
 * most misleading thing this route could return.
 *
 * PAID IS THREE-VALUED. A product that does not publish `paid` has an unknown
 * paid count, not a zero one, and `paidUnknown` counts the rows that could not
 * answer.
 *
 * ADDRESSES ARE NOT HERE AND CANNOT BE ASKED FOR. They are stored as a salted
 * hash (see 130_activity_users) and there is no filter, no query parameter and
 * no field below that takes or returns one. The domain is returned because
 * "gmail.com" identifies nobody.
 */
import { Hono } from "hono";
import { db } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { PLUGIN, docRows, type DocRow } from "./users.ts";
import { ventureFor } from "./link.ts";

export const userRoutes = new Hono();

function clamp(value: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, value));
}

/** The UTC day, `days` ago, as the ISO instant a `created_at` compares
 *  against. String comparison on ISO-8601 is chronological, which is why every
 *  window below is a `>=` on text. */
function since(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

type CountRow = { account_id: number; n: number };

function countsSince(iso: string | null): Map<number, number> {
  const rows = (
    iso === null
      ? db.prepare("SELECT account_id, COUNT(*) AS n FROM activity_users GROUP BY account_id").all()
      : db
          .prepare("SELECT account_id, COUNT(*) AS n FROM activity_users WHERE created_at >= ? GROUP BY account_id")
          .all(iso)
  ) as unknown as CountRow[];
  return new Map(rows.map((r) => [r.account_id, r.n]));
}

function paidCounts(): Map<number, { paid: number; free: number; unknown: number }> {
  const rows = db
    .prepare(
      `SELECT account_id,
              SUM(CASE WHEN paid = 1 THEN 1 ELSE 0 END) AS paid,
              SUM(CASE WHEN paid = 0 THEN 1 ELSE 0 END) AS free,
              SUM(CASE WHEN paid IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM activity_users GROUP BY account_id`,
    )
    .all() as unknown as { account_id: number; paid: number; free: number; unknown: number }[];
  return new Map(rows.map((r) => [r.account_id, { paid: r.paid, free: r.free, unknown: r.unknown }]));
}

type DayRow = { account_id: number; day: string; signups: number | null; total: number | null; source: string };

function dayRows(fromDay: string): Map<number, DayRow[]> {
  const rows = db
    .prepare("SELECT * FROM activity_user_days WHERE day >= ? ORDER BY day ASC")
    .all(fromDay) as unknown as DayRow[];
  const out = new Map<number, DayRow[]>();
  for (const r of rows) out.set(r.account_id, [...(out.get(r.account_id) ?? []), r]);
  return out;
}

function problemsOf(row: DocRow | undefined): string[] {
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.problems);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------- the roll-up */

userRoutes.get("/", (c) => {
  const days = clamp(Number(c.req.query("days") ?? 90) || 90, 1, 400);
  const fromDay = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

  const list = accounts.list(PLUGIN);
  const docs = new Map(docRows().map((d) => [d.account_id, d]));
  const held = countsSince(null);
  const new7 = countsSince(since(7));
  const new30 = countsSince(since(30));
  const paid = paidCounts();
  const series = dayRows(fromDay);
  const ventures = ventureFor(
    list.map((a) => ({ id: a.id, label: a.label })),
    new Map(list.map((a) => [a.id, docs.get(a.id)?.url ?? null])),
  );

  const products = list.map((account) => {
    const doc = docs.get(account.id);
    const shape = doc?.shape ?? null;
    const rowsHeld = held.get(account.id) ?? 0;
    const p = paid.get(account.id) ?? { paid: 0, free: 0, unknown: 0 };
    const countsOnly = shape === "counts";

    return {
      accountId: account.id,
      product: account.label,
      /** Which form of the contract this endpoint publishes. Null before
       *  anything has validated — not a failure, nobody has asked yet. */
      shape,
      url: doc?.url ?? null,
      reachable: doc ? doc.ok === 1 : null,
      lastFetchedAt: doc?.ts ?? null,
      /** The product's own clock on the document, if it stamped one. Older
       *  than lastFetchedAt means the product is serving a cached figure. */
      generatedAt: doc?.generated_at ?? null,
      status: doc?.status ?? null,
      ms: doc?.ms ?? null,
      error: doc?.error ?? account.lastError,
      problems: problemsOf(doc),
      venture: ventures.get(account.id) ?? null,

      /** THE PRODUCT'S OWN COUNT, which wins over a count of rows. Null when
       *  the document published none. */
      total: doc?.total ?? null,
      /** How many rows this box actually holds. A FLOOR: nothing is deleted
       *  here and no endpoint promises to list everybody. */
      rowsHeld,
      /** True when the two disagree — the endpoint is publishing a total
       *  larger than the list it sent, which is normal for a paged endpoint
       *  and worth saying rather than reconciling. */
      partialList: doc?.total != null && rowsHeld > 0 && doc.total > rowsHeld,

      /* THE TWO WINDOWS. Never added: the 7 is inside the 30. Null for a
         counts-only product, which has no rows to bucket. */
      new7d: countsOnly ? null : (new7.get(account.id) ?? 0),
      new30d: countsOnly ? null : (new30.get(account.id) ?? 0),
      /** What a counts-only product said about new users, in ITS window, in
         its own words. Null for everything else. */
      newWindow:
        countsOnly && doc?.doc
          ? (() => {
              try {
                const parsed = JSON.parse(doc.doc) as { counts?: { new?: { days?: number; n?: number } } };
                const n = parsed.counts?.new;
                return typeof n?.days === "number" && typeof n?.n === "number"
                  ? { days: n.days, n: n.n }
                  : null;
              } catch {
                return null;
              }
            })()
          : null,

      paid: countsOnly ? null : p.paid,
      free: countsOnly ? null : p.free,
      /** Rows whose product did not say whether they pay. Not free. */
      paidUnknown: countsOnly ? null : p.unknown,

      /** Signups per day from the rows we hold, or the observed level for a
       *  counts-only product. The two are on different rows and never mixed —
       *  `source` on each says which. */
      days: (series.get(account.id) ?? []).map((r) => ({
        day: r.day,
        signups: r.signups,
        total: r.total,
        source: r.source,
      })),
    };
  });

  const listing = products.filter((p) => p.shape !== "counts");
  return c.json({
    window: { days, of: "the daily series; the new counts are fixed at 7 and 30 days" },
    products,
    summary: {
      configured: products.length,
      answering: products.filter((p) => p.reachable === true).length,
      failing: products.filter((p) => p.reachable === false).length,
      neverCollected: products.filter((p) => p.reachable === null).length,
      countsOnly: products.filter((p) => p.shape === "counts").length,
      /*
        A PORTFOLIO TOTAL IS REAL HERE, unlike the products area's mapped
        metrics — two products' users are two disjoint sets of people and
        adding them is a count of people. It is still a FLOOR whenever any
        product refused, published no total, or listed less than it claims, and
        `complete` says which.
      */
      totalUsers: products.reduce((n, p) => n + (p.total ?? p.rowsHeld), 0),
      /** Whether every product answered and could be counted. NULL with
       *  nothing connected — "complete" over an empty list is a claim about
       *  nothing, and `true` there would read as "we have everybody". */
      complete: products.length
        ? products.every((p) => p.reachable === true && (p.total !== null || p.shape === "users"))
        : null,
      /** Summed only across the products that HAVE the window — a counts-only
       *  product is not a zero in it, it is absent, and this says how many. */
      new7d: listing.reduce((n, p) => n + (p.new7d ?? 0), 0),
      new30d: listing.reduce((n, p) => n + (p.new30d ?? 0), 0),
      windowsMissing: products.filter((p) => p.new7d === null).length,
      lastFetchedAt: products.map((p) => p.lastFetchedAt).filter(Boolean).sort().at(-1) ?? null,
      note:
        "A product's own `total` beats a count of the rows held here; the rows are a floor. " +
        "new7d and new30d are separate windows and are never added together. A counts-only " +
        "product contributes to totalUsers and to neither window.",
    },
  });
});

/**
 * What a venture could be linked to here — the same shape every other area
 * publishes for the venture map. The entity is the account id, because the URL
 * changes when a product moves and the account does not.
 *
 * REGISTERED BEFORE `/:product` because Hono takes the first pattern that
 * matches, and a bare segment would otherwise swallow this one. The cost is
 * that a product endpoint labelled exactly “entities” is unreachable by name;
 * it is still reachable by its account id, which is why `:product` accepts
 * both.
 */
userRoutes.get("/entities", (c) => {
  const docs = new Map(docRows().map((d) => [d.account_id, d]));
  return c.json({
    entities: accounts.list(PLUGIN).map((a) => {
      const url = docs.get(a.id)?.url ?? null;
      let host: string | null = null;
      if (url) {
        try {
          const h = new URL(url).hostname.toLowerCase();
          host = h === "localhost" || /^[0-9.]+$/.test(h) ? null : h;
        } catch {
          host = null;
        }
      }
      return { plugin: PLUGIN, entity: String(a.id), label: a.label, host };
    }),
  });
});

/**
 * THE LAST STORED DOCUMENT, for one product.
 *
 * ITS OWN ROUTE RATHER THAN A FIELD ON THE ROLL-UP, because it is several
 * kilobytes per product and is opened for one at a time — putting it on the
 * roll-up would make every page load carry every product's document to draw
 * four numbers.
 *
 * EVERY ADDRESS IN IT WAS REPLACED BEFORE IT WAS STORED and its arrays were cut
 * to three items. This is the SHAPE — for checking a contract error against the
 * document that caused it — and not the population.
 */
userRoutes.get("/:product/document", (c) => {
  const key = c.req.param("product").trim();
  const list = accounts.list(PLUGIN);
  const account =
    list.find((a) => String(a.id) === key) ??
    list.find((a) => a.label.toLowerCase() === key.toLowerCase());
  if (!account) return c.json({ error: `No product endpoint called \u201c${key}\u201d.` }, 404);

  const doc = docRows().find((d) => d.account_id === account.id);
  return c.json({
    product: account.label,
    ts: doc?.ts ?? null,
    shape: doc?.shape ?? null,
    /** Null before anything has ever been fetched. */
    document: doc?.doc ?? null,
    problems: problemsOf(doc),
    note:
      "Addresses were replaced with a placeholder and arrays cut to three items before this was " +
      "stored. It is the shape of the last document, not its contents.",
  });
});

/* ---------------------------------------------------------- one product's list */

/**
 * ONE PRODUCT'S USERS, FILTERED AND PAGED.
 *
 * `:product` is the account's id or its label, whichever the caller has to
 * hand, for the reason ventureRow accepts both: an agent told "APP-1" should not
 * have to look up a number first.
 *
 * `q` MATCHES THE ID, THE PLAN, THE COUNTRY AND THE MAIL DOMAIN — and never an
 * address, because there is no address stored to match. That is not a
 * limitation to be worked around; it is the design, and a caller that wants to
 * find a person by their email is asking this box for something it deliberately
 * cannot do.
 */
userRoutes.get("/:product", (c) => {
  const key = c.req.param("product").trim();
  const list = accounts.list(PLUGIN);
  const account =
    list.find((a) => String(a.id) === key) ??
    list.find((a) => a.label.toLowerCase() === key.toLowerCase());
  if (!account)
    return c.json(
      {
        error: `No product endpoint called “${key}”. The ones connected: ${list.map((a) => a.label).join(", ") || "none"}.`,
      },
      404,
    );

  const doc = docRows().find((d) => d.account_id === account.id);
  if (doc?.shape === "counts")
    return c.json(
      {
        error:
          `“${account.label}” publishes the counts-only form of the contract, so there is no list to page through — ` +
          `it reports a total and nothing about individual users. See GET /api/users for its figures.`,
      },
      409,
    );

  const limit = clamp(Number(c.req.query("limit") ?? 100) || 100, 1, 1000);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const plan = (c.req.query("plan") ?? "").trim();
  const country = (c.req.query("country") ?? "").trim();
  const paidParam = (c.req.query("paid") ?? "").trim().toLowerCase();
  const days = c.req.query("days") ? clamp(Number(c.req.query("days")) || 30, 1, 4000) : null;

  const where: string[] = ["account_id = ?"];
  const args: (string | number)[] = [account.id];
  if (q) {
    where.push("(LOWER(user_id) LIKE ? OR LOWER(COALESCE(plan,'')) LIKE ? OR LOWER(COALESCE(country,'')) LIKE ? OR LOWER(COALESCE(email_domain,'')) LIKE ?)");
    for (let i = 0; i < 4; i++) args.push(`%${q}%`);
  }
  if (plan) {
    where.push("plan = ?");
    args.push(plan);
  }
  if (country) {
    where.push("country = ?");
    args.push(country);
  }
  if (paidParam === "true" || paidParam === "false") {
    where.push("paid = ?");
    args.push(paidParam === "true" ? 1 : 0);
  } else if (paidParam === "unknown") {
    where.push("paid IS NULL");
  }
  if (days !== null) {
    where.push("created_at >= ?");
    args.push(since(days));
  }
  const clause = where.join(" AND ");

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM activity_users WHERE ${clause}`).get(...args) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT user_id, email_domain, created_at, plan, paid, last_seen, country, seen_at
         FROM activity_users WHERE ${clause}
        ORDER BY created_at DESC, user_id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as unknown as {
    user_id: string;
    email_domain: string | null;
    created_at: string;
    plan: string | null;
    paid: number | null;
    last_seen: string | null;
    country: string | null;
    seen_at: string;
  }[];

  /* The chips a page can build itself from what is actually present, rather
     than from a fixed list that fits no product. */
  const distinct = (column: string) =>
    (
      db
        .prepare(`SELECT DISTINCT ${column} AS v FROM activity_users WHERE account_id = ? AND ${column} IS NOT NULL ORDER BY v LIMIT 60`)
        .all(account.id) as unknown as { v: string }[]
    ).map((r) => r.v);

  return c.json({
    product: account.label,
    accountId: account.id,
    /** The product's own total, when it published one. `matching` is what the
     *  filters selected out of the rows this box holds — a floor. */
    total: doc?.total ?? null,
    rowsHeld: (db.prepare("SELECT COUNT(*) AS n FROM activity_users WHERE account_id = ?").get(account.id) as { n: number }).n,
    matching: total,
    page: { limit, offset, returned: rows.length },
    filters: {
      q: q || null, plan: plan || null, country: country || null,
      paid: paidParam || null, days,
      note:
        "q matches the product's own id, the plan, the country and the mail DOMAIN. It cannot match an " +
        "address: addresses are stored as a salted hash and there is no route here that takes one.",
    },
    facets: { plans: distinct("plan"), countries: distinct("country"), domains: distinct("email_domain") },
    users: rows.map((r) => ({
      id: r.user_id,
      /** The domain only. There is no address on this document. */
      emailDomain: r.email_domain,
      createdAt: r.created_at,
      plan: r.plan,
      paid: r.paid === null ? null : r.paid === 1,
      lastSeenAt: r.last_seen,
      country: r.country,
      /** When this box last read this row. Never a window is computed from it. */
      seenAt: r.seen_at,
    })),
  });
});
