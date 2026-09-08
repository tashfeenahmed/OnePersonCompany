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
 * ACTIVE IS A LEVEL INSIDE A WINDOW AND IS NOT A DAILY ACTIVE COUNT. The
 * contract publishes one `lastSeenAt` per person — the latest moment their
 * product knew of them — so what can be counted is how many of those moments
 * fall inside the window. Nothing here records that somebody was present on a
 * particular Tuesday, so nothing here can produce a DAU line, and `returned`
 * is the first point of a retention curve rather than the curve.
 *
 * AN ADDRESS ON FILE IS NOT AN AUDIENCE. `withEmail` counts rows carrying a
 * hash; `contactPermitted` counts the ones whose own product recorded somebody
 * agreeing. They are two figures and never one, because the difference between
 * them is the difference between a table and a lawful mailing list.
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

/**
 * WHO CAN BE REACHED, AND WHO SAID SO — two counts from one scan.
 *
 * They answer the same question at two strengths and must never be printed as
 * one. An address on file is a FACT ABOUT THE TABLE; `contact_permitted` is a
 * product's record of somebody agreeing, and it is the only one of the two that
 * makes a mailing list lawful. See users.ts: nothing here infers the second
 * from the first, and a card that quoted "with an email" as an audience size
 * would be doing exactly that inference on the reader's behalf.
 */
function reachCounts(): Map<number, { withEmail: number; permitted: number }> {
  const rows = db
    .prepare(
      `SELECT account_id,
              SUM(CASE WHEN email_hash IS NOT NULL THEN 1 ELSE 0 END) AS with_email,
              SUM(CASE WHEN contact_permitted = 1 THEN 1 ELSE 0 END) AS permitted
         FROM activity_users GROUP BY account_id`,
    )
    .all() as unknown as { account_id: number; with_email: number; permitted: number }[];
  return new Map(rows.map((r) => [r.account_id, { withEmail: r.with_email, permitted: r.permitted }]));
}

/**
 * SEEN INSIDE THE WINDOW, AND NEVER SEEN AT ALL — the two halves of "active".
 *
 * `lastSeenAt` IS A LEVEL AND NOT A SESSION LOG. The contract publishes the
 * latest moment a product knew of a person; nothing anywhere records that they
 * were here on Tuesday. So "active" here is exactly "that level falls inside
 * the window" — which is the first thing anyone means by the word and is not
 * the same as a daily active count, a figure this box cannot produce and does
 * not pretend to.
 *
 * `unknown` IS WHY THE ROUTE RETURNS NULL RATHER THAN ZERO. A product that
 * publishes no `lastSeenAt` on any row has not said nobody came back; it has
 * said nothing, and a 0 under "active" would be the most misleading figure on
 * the whole document.
 */
function seenCounts(iso: string): Map<number, { active: number; unknown: number }> {
  const rows = db
    .prepare(
      `SELECT account_id,
              SUM(CASE WHEN last_seen IS NOT NULL AND last_seen >= ? THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN last_seen IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM activity_users GROUP BY account_id`,
    )
    .all(iso) as unknown as { account_id: number; active: number; unknown: number }[];
  return new Map(rows.map((r) => [r.account_id, { active: r.active, unknown: r.unknown }]));
}

/**
 * CAME BACK — signups inside the window that were seen again a day or more
 * after they joined.
 *
 * THIS IS THE CLOSEST THING TO RETENTION THIS CONTRACT CAN SUPPORT, and it is
 * deliberately not called that on any card. A retention curve needs to know
 * whether somebody was present in week two AND in week three; the contract
 * publishes ONE `lastSeenAt` per person, so week two and week three are the
 * same field. What can be said honestly is whether a new signup ever came back
 * at all — the first point of that curve, and no other point of it.
 *
 * A DAY IS THE THRESHOLD because a fresh signup's `lastSeenAt` is normally the
 * signup itself: without it every product would report that everybody returned.
 * `julianday` rather than a string compare, because the two timestamps are
 * being subtracted rather than ordered.
 */
function returnedCounts(iso: string): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT account_id, COUNT(*) AS n
         FROM activity_users
        WHERE created_at >= ? AND last_seen IS NOT NULL
          AND julianday(last_seen) >= julianday(created_at) + 1
        GROUP BY account_id`,
    )
    .all(iso) as unknown as CountRow[];
  return new Map(rows.map((r) => [r.account_id, r.n]));
}

/**
 * WHO THESE PEOPLE ARE TO THE BUSINESS, per product — see `POPULATIONS` in
 * users.ts for why the field exists at all.
 *
 * A NULL POPULATION IS `customer`, resolved here rather than by every reader,
 * because that is what the contract always implied and what every row written
 * before the field existed means. It is the one place the default lives on the
 * read side, matching the one place it lives on the write side.
 */
function populationCounts(): Map<number, Record<string, number>> {
  const rows = db
    .prepare(
      `SELECT account_id, COALESCE(population, 'customer') AS population, COUNT(*) AS n
         FROM activity_users GROUP BY account_id, COALESCE(population, 'customer')`,
    )
    .all() as unknown as { account_id: number; population: string; n: number }[];
  const out = new Map<number, Record<string, number>>();
  for (const r of rows) out.set(r.account_id, { ...(out.get(r.account_id) ?? {}), [r.population]: r.n });
  return out;
}

/**
 * The plans, or the countries, a product's rows carry — largest first.
 *
 * THE COLUMN IS A UNION AND NOT A STRING, so there is no way to reach this
 * with a caller's text: the two names below are the only two values the type
 * admits and neither comes off a request.
 *
 * A PLAN IS NEVER COMPARABLE ACROSS PRODUCTS and a country always is. One
 * product's "pro" and another's are two words somebody chose; IE is IE. That
 * is why these come back per product and the route adds neither — the reader
 * that may sum countries is the one that knows it is allowed to.
 */
function facetCounts(column: "plan" | "country", cap: number): Map<number, { value: string; n: number }[]> {
  const rows = db
    .prepare(
      `SELECT account_id, ${column} AS value, COUNT(*) AS n
         FROM activity_users WHERE ${column} IS NOT NULL AND ${column} <> ''
        GROUP BY account_id, ${column} ORDER BY n DESC, value ASC`,
    )
    .all() as unknown as { account_id: number; value: string; n: number }[];
  const out = new Map<number, { value: string; n: number }[]>();
  for (const r of rows) {
    const held = out.get(r.account_id) ?? [];
    if (held.length < cap) out.set(r.account_id, [...held, { value: r.value, n: r.n }]);
  }
  return out;
}

/** The oldest and newest signup this box holds for each product. Both are a
 *  floor: an endpoint that lists its newest hundred has an older first signup
 *  than anything here can see. */
function signupSpans(): Map<number, { first: string; last: string }> {
  const rows = db
    .prepare("SELECT account_id, MIN(created_at) AS first, MAX(created_at) AS last FROM activity_users GROUP BY account_id")
    .all() as unknown as { account_id: number; first: string; last: string }[];
  return new Map(rows.map((r) => [r.account_id, { first: r.first, last: r.last }]));
}

/** How many newest signups the roll-up carries. Small on purpose: this is the
 *  "who just arrived" list, and the full page-through is `/api/users/:product`. */
const RECENT = 25;

/**
 * THE NEWEST SIGNUPS ACROSS EVERY PRODUCT, merged and re-sorted here.
 *
 * IT CANNOT BE ASSEMBLED FROM THE PER-PRODUCT ROWS by a reader: five from each
 * of four products is not the newest twenty overall, and a page that merged
 * them would be showing "recent" with a quiet bias towards whichever product
 * signs people up slowest.
 *
 * THERE IS NO ADDRESS ON IT AND THERE CANNOT BE. The domain is what is stored
 * (see users.ts) and "gmail.com" identifies nobody; the product's own id is
 * opaque to this box. A list of who signed up that could be used to write to
 * them is the capability this whole area declines.
 */
function recentSignups(): {
  accountId: number;
  product: string;
  id: string;
  emailDomain: string | null;
  createdAt: string;
  plan: string | null;
  paid: boolean | null;
  country: string | null;
}[] {
  const rows = db
    .prepare(
      `SELECT account_id, product, user_id, email_domain, created_at, plan, paid, country
         FROM activity_users ORDER BY created_at DESC, user_id DESC LIMIT ?`,
    )
    .all(RECENT) as unknown as {
    account_id: number;
    product: string;
    user_id: string;
    email_domain: string | null;
    created_at: string;
    plan: string | null;
    paid: number | null;
    country: string | null;
  }[];
  return rows.map((r) => ({
    accountId: r.account_id,
    product: r.product,
    id: r.user_id,
    emailDomain: r.email_domain,
    createdAt: r.created_at,
    plan: r.plan,
    paid: r.paid === null ? null : r.paid === 1,
    country: r.country,
  }));
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
  /* THE THREE THAT FOLLOW THE PICKER. `new7d`/`new30d` above are fixed windows
     the contract's own vocabulary named; these are measured over whatever
     `days` was asked for, and the document says which is which so a card can
     never caption one with the other's span. */
  const seen = seenCounts(since(days));
  const returned = returnedCounts(since(days));
  const reach = reachCounts();
  const populations = populationCounts();
  const plans = facetCounts("plan", 8);
  const countries = facetCounts("country", 12);
  const spans = signupSpans();
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
    /*
      WHETHER THIS PRODUCT HAS EVER LISTED ANYBODY, which is the gate on every
      per-row figure below — and it is `shape === "users"` rather than "not
      counts-only". A product nobody has collected yet, and one whose first
      document was refused, have NO SHAPE AT ALL: they have said nothing about
      windows, plans or who pays, and a 0 in those columns would be this box
      answering on their behalf. (A product that listed users once and failed
      this morning keeps its shape — see writeDoc's COALESCE — so it goes on
      reporting what it last said, dated, which is the true picture.)
    */
    const lists = shape === "users";
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
      new7d: lists ? (new7.get(account.id) ?? 0) : null,
      new30d: lists ? (new30.get(account.id) ?? 0) : null,
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

      paid: lists ? p.paid : null,
      free: lists ? p.free : null,
      /** Rows whose product did not say whether they pay. Not free. */
      paidUnknown: lists ? p.unknown : null,

      /** An address on file. NOT an audience: see `reachCounts`. */
      withEmail: lists ? (reach.get(account.id)?.withEmail ?? 0) : null,
      /** Rows whose product records this person agreeing to be written to.
       *  The only one of the two figures that sizes a campaign. */
      contactPermitted: lists ? (reach.get(account.id)?.permitted ?? 0) : null,

      /* ACTIVE, OVER `days`, AND NULL WHERE THE PRODUCT CANNOT SAY. A product
         that publishes no lastSeenAt on any row has said nothing about who
         came back, and a zero here would read as "nobody did". */
      active: lists && (seen.get(account.id)?.unknown ?? 0) !== rowsHeld ? (seen.get(account.id)?.active ?? 0) : null,
      /** Rows carrying no lastSeenAt at all — absent from `active` rather than
       *  counted as inactive. */
      lastSeenUnknown: lists ? (seen.get(account.id)?.unknown ?? 0) : null,
      /** Signups inside the window that were seen again a day or more later.
       *  The first point of a retention curve and NOT the curve — see
       *  `returnedCounts`. Null on a product with no lastSeenAt. */
      returned: lists && (seen.get(account.id)?.unknown ?? 0) !== rowsHeld ? (returned.get(account.id) ?? 0) : null,

      /** Who these people are to the business — a missing population is
       *  `customer`, resolved on the way out. */
      populations: lists ? (populations.get(account.id) ?? {}) : null,
      /** This product's plans, largest first. NEVER comparable with another
       *  product's: two owners chose the word "pro" independently. */
      plans: lists ? (plans.get(account.id) ?? []) : [],
      /** Countries, largest first. These DO compare across products — IE is
       *  IE — and this route still does not add them; the reader that may is
       *  the one that knows it. */
      countries: lists ? (countries.get(account.id) ?? []) : [],
      /** The oldest and newest signup held. Both are floors: an endpoint that
       *  lists its newest hundred has an older first signup than this sees. */
      firstSignupAt: spans.get(account.id)?.first ?? null,
      lastSignupAt: spans.get(account.id)?.last ?? null,

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
  /* PRODUCTS THAT CAN ANSWER "ACTIVE" AT ALL — the denominator every active
     figure below is out of, and it is not the product count. A product with no
     lastSeenAt is ABSENT from the active total, exactly as a counts-only
     product is absent from the two new windows. */
  const seenAble = products.filter((p) => p.active !== null);
  const populationTotals: Record<string, number> = {};
  for (const p of products)
    for (const [name, n] of Object.entries(p.populations ?? {}))
      populationTotals[name] = (populationTotals[name] ?? 0) + n;
  return c.json({
    window: {
      days,
      of: "the daily series, the active count and the returned count; the new counts are fixed at 7 and 30 days",
    },
    products,
    /** The newest signups across every product, merged here because five from
     *  each of four products is not the newest twenty overall. No address. */
    recentSignups: recentSignups(),
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

      /* THE PAID SPLIT, PORTFOLIO-WIDE AND THREE-VALUED. `paidUnknown` is the
         reason there is no conversion rate on this document: a rate over a
         denominator that is partly guesswork is a rate about nothing, and the
         reader that draws one has to see the size of the guess first. */
      paid: listing.reduce((n, p) => n + (p.paid ?? 0), 0),
      free: listing.reduce((n, p) => n + (p.free ?? 0), 0),
      paidUnknown: listing.reduce((n, p) => n + (p.paidUnknown ?? 0), 0),

      /** An address on file. Not an audience — see `contactPermitted`. */
      withEmail: listing.reduce((n, p) => n + (p.withEmail ?? 0), 0),
      /** People whose own product records them agreeing to be written to. */
      contactPermitted: listing.reduce((n, p) => n + (p.contactPermitted ?? 0), 0),

      /* ACTIVE AND RETURNED, over `window.days`, summed only across the
         products that can answer. `activeMissing` is how many are absent from
         them rather than counted as zero — the same rule `windowsMissing`
         states for the two new windows. */
      active: seenAble.reduce((n, p) => n + (p.active ?? 0), 0),
      returned: seenAble.reduce((n, p) => n + (p.returned ?? 0), 0),
      activeMissing: products.length - seenAble.length,

      /** Who the portfolio's users are to the business. Added across products
       *  because a customer of one and a customer of another are two people —
       *  which is the same argument `totalUsers` rests on. */
      populations: populationTotals,

      lastFetchedAt: products.map((p) => p.lastFetchedAt).filter(Boolean).sort().at(-1) ?? null,
      note:
        "A product's own `total` beats a count of the rows held here; the rows are a floor. " +
        "new7d and new30d are separate windows and are never added together. A counts-only " +
        "product contributes to totalUsers and to neither window. `active` is a lastSeenAt " +
        "level inside the window and is not a daily active count; a product that publishes no " +
        "lastSeenAt is absent from it rather than counted as zero.",
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
