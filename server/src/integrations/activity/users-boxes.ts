/** Adapt locally configured SSH user probes to the shared users contract.
 * Keep per-product schema mappings in the private data directory. */
import { db } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { parseSsh, ssh, sshLabel, sshProblem, writeKeyFile } from "../ops/fleet.ts";
import type { Population } from "./users.ts";

/**
 * Where `users-probe` is installed on every box.
 *
 * A constant rather than a per-account field — see this file's header. The
 * environment variable exists for a box that puts it somewhere else and for the
 * tests, and an environment variable is set by whoever starts the process,
 * which is not the same door as an HTTP route.
 */
export const PROBE_PATH = process.env.OPC_USERS_PROBE?.trim() || "/usr/local/bin/users-probe";

/** How much of the probe's stdout is parsed. The largest box answers with
 *  several megabytes and the cap is refused
 *  rather than truncated, for exactly the reason users.ts refuses an oversized
 *  HTTP document: half a JSON document read as if it were whole reports a user
 *  base that halved overnight. */
export const MAX_PROBE = 8 * 1024 * 1024;

/* ------------------------------------------------------- the probe's shape */

/** One row as the probe emits it. `fields` is present only on a source that
 *  declared named columns; every source in the probe's table does today, and a
 *  source that does not cannot supply an id — see `boxDocument`. */
export type ProbeRow = {
  created: number | null;
  email: string | null;
  label: string | null;
  extra: string | null;
  fields?: Record<string, string | number | null>;
};

export type ProbeApp = {
  id: string;
  app: string;
  slug: string;
  source: string;
  container: string | null;
  total: number;
  deleted: number;
  withEmail: number;
  new: Record<string, number>;
  recent: ProbeRow[];
  capped: boolean;
  columns?: { key: string; label: string; type: string }[];
  error: string | null;
};

export type ProbeDoc = { collectedAt: number; host: string; windows: string[]; apps: ProbeApp[] };

/* --------------------------------------------------------- the source table */

/**
 * WHAT EACH PRODUCT'S PROBE ROW MEANS, one entry per source `users-probe`
 * knows about.
 *
 * `id` is the probe's own key for the source, which it derives from the
 * application's name — so "Example App 7" is `example-app-7` and it is
 * the value an account stores. `box` is the `fleet` account the product is
 * expected on; it is documentation and the provisioning list, not a
 * constraint — the account says which box to ask, because a product that moves
 * should be one field edited rather than a release.
 *
 * `cannot` IS THE POINT OF HALF THESE ENTRIES. The contract has fields for
 * paid, country and last-seen; almost no application's user table has a column
 * for them, and a source that cannot say must produce a NULL that the route
 * counts as unknown rather than a false or a zero. Every absence is written
 * down here as a sentence so the panel can say which figure is missing and
 * why, instead of drawing a product with nobody paying.
 */
export type BoxSource = {
  id: string;
  product: string;
  /** The product's own site, for the venture host guess — there is no endpoint
   *  URL to guess from when the document was read off a box. Null where the
   *  product has no site of its own. */
  site: string | null;
  /** The `fleet` account label this product is expected on. */
  box: string;
  /** Which probe field carries the product's own id, as a dot path. */
  idField: string;
  /** Which field carries the plan, where the application has one. */
  planField?: string;
  /** Which field carries a payment state, and which of its values mean paid
   *  and which mean not. A value in neither list is `null` — the source said
   *  something this table has not been told about, and guessing at it is how a
   *  paid count quietly becomes wrong. */
  paidField?: string;
  paid?: string[];
  free?: string[];
  /** Which field carries a last-seen moment, in Unix SECONDS as every probe
   *  column of type `epoch` is. */
  lastSeenField?: string;
  /** Which field says who this person is to the business, and what its values
   *  mean. A value this table does not name falls to `populationDefault`. */
  populationField?: string;
  populations?: Record<string, Population>;
  populationDefault?: Population;
  /** What this source structurally cannot say. Printed on the document. */
  cannot: string[];
};

/** Said by nearly every source, so it is written once. */
const NO_COUNTRY = "country: no application here records one, so every user's country is unknown.";
const NO_SEEN = "lastSeenAt: this application's user table has no last-seen column, so “active” and “returned” are unknown for it rather than zero.";
const NO_PAID = "paid: this application's user table records no payment state, so paid/free is unknown for every row rather than free.";
const NO_CONSENT = "contactPermitted: no application here keeps a consent column, so nobody is counted as contactable — see users.ts, which will not infer one from an address on file.";

export const SOURCES: BoxSource[] = [
  {
    id: "example-app-1",
    product: "Example App 1",
    site: "example-app-1.example.test",
    box: "Example host 6",
    idField: "fields.id",
    /* `extra` here is better-auth's emailVerified rendered as "verified"/"" —
       a verification state, not a plan and not a role, so it is read as
       neither. */
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT, "plan: better-auth's user table has no plan column."],
  },
  {
    id: "example-app-2",
    product: "Example App 2",
    site: "example-app-2.example.test",
    box: "Demo box",
    idField: "fields.id",
    planField: "extra",
    /* `fields.stripe` is "yes" when a stripe_customer_id exists, which is
       whether they ever REACHED checkout and not whether they pay. It is
       deliberately not read as `paid`: a customer id is created by an
       abandoned checkout too, and a paid count built from one would be a
       revenue figure nobody could reconcile. */
    cannot: [NO_PAID + " Its stripe_customer_id says only that somebody reached checkout.", NO_SEEN, NO_COUNTRY, NO_CONSENT],
  },
  {
    id: "example-app-3",
    product: "Example App 3",
    site: "example-app-3.example.test",
    box: "Example host 12",
    idField: "fields.id",
    planField: "fields.plan",
    /* TWO POPULATIONS IN ONE COLLECTION, and this is the one source where the
       contract's `population` field earns its place. `role: admin` is somebody
       who came to run research — the demand side, the people the pricing page
       is for. `role: participant` signed up to BE tested and to be paid for
       it. Both were simply "signups" in the previous dashboard until it learned
       to split them, and the split turned "3 signups against a 0.6 norm" into
       two participants and a double count. A role neither name covers is a
       customer by the contract's own default and is visible as such, because
       nothing here silently folds it into the other bucket. */
    populationField: "extra",
    populations: { admin: "customer", participant: "participant" },
    populationDefault: "customer",
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT],
  },
  {
    id: "example-app-4",
    product: "Example App 4",
    site: "example-app-4.example.test",
    box: "Example host 12",
    idField: "fields.id",
    /* `extra` is platform_role — tutor, student, admin. Tutors and students are
       BOTH customers under this contract's definition (they signed up on their
       own behalf); only the operator role is not. The marketplace split that
       Example App 3 gets is not made here, because `participant` means
       "present because somebody else invited them" and a tutor is not. */
    populationField: "extra",
    populations: { admin: "admin" },
    populationDefault: "customer",
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT, "plan: the platform's user table has a role, not a plan."],
  },
  {
    id: "example-app-5",
    product: "Example App 5",
    site: "example-app-7.example.test",
    box: "Example host 6",
    idField: "fields.id",
    /* `extra` is the handle — an identifier, not a plan. */
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT, "plan: this table has no plan column."],
  },
  {
    id: "example-app-6",
    product: "Example App 6",
    site: "example-app-7.example.test",
    box: "Example host 6",
    idField: "fields.id",
    /* Kept as a product of its own rather than added to Example App 5 above. These
       are people who signed up for HOSTED Example App 5; the users inside any one
       tenant's instance live in that instance's database. Summing them would
       invent people. */
    cannot: [NO_PAID + " Its stripe_customer_id says only that somebody reached checkout.", NO_SEEN, NO_COUNTRY, NO_CONSENT, "plan: the control plane has no plan column on its users."],
  },
  {
    id: "example-app-7",
    product: "Example App 7",
    site: "example-app-7.example.test",
    box: "Demo box",
    idField: "fields.id",
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT, "plan: this table has no plan column.", "This is the DEMO deployment and a separate database from Example App 5 above — the two are never added."],
  },
  {
    id: "example-app-8",
    product: "Example App 8",
    site: "example-app-8.example.test",
    box: "Apps box",
    idField: "fields.id",
    /* THE ONLY SOURCE HERE THAT CAN ANSWER "ACTIVE". Its users table is the one
       with a last_seen_at, which is what makes the active and returned figures
       real for this product and unknown for every other. */
    lastSeenField: "fields.lastSeen",
    cannot: [NO_PAID, NO_COUNTRY, NO_CONSENT, "plan: this table records an auth provider, not a plan."],
  },
  {
    id: "example-app-9",
    product: "Example App 9",
    site: "example-app-9.example.test",
    box: "Apps box",
    idField: "fields.id",
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT, "plan: this table records an auth provider, not a plan."],
  },
  {
    id: "example-app-10",
    product: "Example App 10",
    site: "example-app-10.example.test",
    box: "Apps box",
    idField: "fields.id",
    planField: "extra",
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT],
  },
  {
    id: "example-app-11",
    product: "Example App 11",
    site: "example-app-11.example.test",
    box: "Example host 12",
    idField: "fields.id",
    /* `extra` is google/apple/email — how the account was created, which for a
       mobile app is the nearest thing to a plan but is not one, so it is left
       unread rather than filed under `plan` where a chart would compare it with
       Example App 2's "free" and "pro". */
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT, "plan: this table records the sign-in provider, not a plan."],
  },
  {
    id: "example-app-12",
    product: "Example App 12",
    site: "example-app-12.example.test",
    box: "Example host 12",
    idField: "fields.id",
    planField: "fields.tier",
    /* THE ONE SOURCE THAT CAN ANSWER "PAID". `subscriptionStatus` is a payment
       state the application itself keeps, which is what makes paid/free real
       here and unknown everywhere else on a box. A value in neither list is
       null rather than false. */
    paidField: "fields.sub",
    paid: ["active", "trialing", "in_grace_period"],
    free: ["inactive", "expired", "cancelled", "canceled", "none"],
    cannot: [NO_SEEN, NO_COUNTRY, NO_CONSENT],
  },
  {
    id: "example-app-13",
    product: "Example App 13",
    site: "example-app-13.example.test",
    box: "Apps box",
    idField: "fields.id",
    /* WP_USERS ARE NOT CUSTOMERS. This is a WordPress site and its user table
       holds the people who write the posts. Counting them as signups would put
       the site's own authors in a portfolio total of customers, so they are
       filed as `admin` — which is what they are, and which keeps them out of
       every customer figure while leaving them visible. */
    populationDefault: "admin",
    cannot: [NO_PAID, NO_SEEN, NO_COUNTRY, NO_CONSENT, "plan: wp_users has no plan, and these are the site's authors rather than its customers."],
  },
];

export const sourceFor = (id: string): BoxSource | undefined =>
  SOURCES.find((s) => s.id === id.trim().toLowerCase());

/* ------------------------------------------------------------ reading a box */

/** A dot path into one probe row: "extra", or "fields.lastSeen". */
function at(row: ProbeRow, path: string): string | number | null {
  if (path.startsWith("fields.")) return row.fields?.[path.slice(7)] ?? null;
  const flat = row as unknown as Record<string, unknown>;
  const value = flat[path];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

const text = (v: string | number | null): string | null => {
  const s = v === null ? "" : String(v).trim();
  return s || null;
};

/** A probe epoch, in seconds, as the contract's ISO string. Zero and null are
 *  both "the source did not say" — the probe emits 0 for a row whose date it
 *  could not read at all. */
function iso(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

export type BoxRead = {
  ok: boolean;
  ms: number;
  /** The whole box's document, or null with `error` saying why. */
  probe: ProbeDoc | null;
  error: string | null;
  /** The ssh target as fleet.ts writes it, for the panel to say where this
   *  came from. Null when the box could not even be resolved to one. */
  target: string | null;
};

/**
 * Run the probe on one box, over the `fleet` account's own ssh credential.
 *
 * THE CREDENTIAL IS NOT COPIED HERE and that is the whole design. `fleet`
 * already holds one account per box with the host and, where one was pasted,
 * the private key; a second store of the same nine credentials would be nine
 * chances for the two to disagree about which key opens which box. So this
 * reads the fleet account by LABEL — the name the owner already sees on the
 * fleet page — and hands the values straight to fleet.ts's own `ssh`.
 *
 * A BOX THAT IS NOT IN THE FLEET IS AN ERROR THAT NAMES THE FLEET. The likely
 * mistake is a label typed slightly differently, and a message listing the
 * labels that do exist is the difference between a fix and a hunt.
 */
export async function probeBox(boxLabel: string, command = PROBE_PATH): Promise<BoxRead> {
  const started = Date.now();
  const fail = (error: string, target: string | null = null): BoxRead => ({
    ok: false, ms: Date.now() - started, probe: null, error, target,
  });

  const wanted = boxLabel.trim().toLowerCase();
  const fleet = accounts.list("fleet");
  const account = fleet.find((a) => a.label.trim().toLowerCase() === wanted);
  if (!account)
    return fail(
      `There is no box called “${boxLabel}” on the Fleet plugin. The ones there are: ` +
        `${fleet.map((a) => a.label).join(", ") || "none — connect a box on the Fleet page first"}.`,
    );
  if (!account.connected)
    return fail(`The Fleet account “${account.label}” is not connected, so there is no credential to read this box with.`);

  const { ready } = accounts.credentialed("fleet", ["host"], "collect_users");
  const held = ready.find((r) => r.account.id === account.id);
  if (!held)
    return fail(`The Fleet account “${account.label}” has no address stored. Set it as user@host on the Fleet page.`);

  const target = parseSsh(held.values.host ?? "");
  if (!target) return fail(`The Fleet account “${account.label}” holds “${held.values.host}”, which is not an ssh target.`);

  const key = (held.values.key ?? "").trim();
  const keyFile = key ? writeKeyFile("fleet", account.id, key) : null;
  const ran = await ssh(target, keyFile, `${command}\n`);
  const where = sshLabel(target);

  if (ran.code !== 0 || !ran.stdout.trim())
    return { ok: false, ms: ran.ms, probe: null, target: where, error: sshProblem(ran, keyFile !== null) };
  if (ran.stdout.length > MAX_PROBE)
    return {
      ok: false, ms: ran.ms, probe: null, target: where,
      error:
        `${command} on ${where} answered with more than ${MAX_PROBE / 1024 / 1024} MB, which was NOT parsed — ` +
        `half a user list read as if it were whole would report a population that had halved overnight.`,
    };

  /* THE LAST LINE THAT LOOKS LIKE A DOCUMENT, for the reason fleet.ts's own
     probe takes the last line: a login shell printing a banner to stdout would
     otherwise poison a perfectly good answer. */
  const line = ran.stdout.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
  if (!line)
    return {
      ok: false, ms: ran.ms, probe: null, target: where,
      error:
        `${where} answered, but not with a document. Check that ${command} is installed there and is executable — ` +
        `it is the same read-only probe the previous dashboard runs. (${ran.stdout.trim().slice(0, 80).replace(/\s+/g, " ")})`,
    };
  try {
    return { ok: true, ms: ran.ms, probe: JSON.parse(line) as ProbeDoc, error: null, target: where };
  } catch {
    return { ok: false, ms: ran.ms, probe: null, target: where, error: `${command} on ${where} printed something that is not JSON.` };
  }
}

/**
 * A reader that probes each box ONCE, however many products are read off it.
 *
 * Four of these products live on one box and the probe reads every application
 * it finds there in a single pass, so an uncached reader would scan the same
 * four production databases four times per collection. The cache lives for the
 * length of one collection and is a promise rather than a value, so two
 * accounts on one box asked at once share the one connection.
 */
export function boxReader(command = PROBE_PATH): (label: string) => Promise<BoxRead> {
  const held = new Map<string, Promise<BoxRead>>();
  return (label: string) => {
    const key = label.trim().toLowerCase();
    const going = held.get(key);
    if (going) return going;
    const started = probeBox(label, command);
    held.set(key, started);
    return started;
  };
}

/* ------------------------------------------------- probe rows -> the contract */

export type BoxDocument = {
  doc: unknown;
  /** Sentences about what could NOT be translated, in the same voice the
   *  validator's problems are written in. */
  problems: string[];
};

/**
 * One application's probe rows, as a users-contract document.
 *
 * IT IS THE `users` FORM AND ITS `total` IS THE PROBE'S OWN COUNT. The probe
 * counts live rows at the database and separately lists the newest 5,000, so
 * `total` and the list can legitimately disagree on a deep table — which is
 * precisely what the contract's `total` is for, and what makes the route print
 * "1,204 of 4,873 listed" instead of a user base that shrank.
 *
 * A ROW WITH NO ID IS SKIPPED AND SAID OUT LOUD. The id is what makes the same
 * person one row across collections; without it every collection would insert
 * the same people again under new keys. Every source the probe knows about
 * declares an id column, so this is a contract mismatch worth a sentence rather
 * than a case to paper over.
 */
export function boxDocument(app: ProbeApp, src: BoxSource | undefined, collectedAt: number): BoxDocument {
  const problems: string[] = [];
  const users: Record<string, unknown>[] = [];
  let noId = 0;
  let noDate = 0;

  for (const row of app.recent ?? []) {
    const id = src ? text(at(row, src.idField)) : null;
    if (!id) {
      noId += 1;
      continue;
    }
    const createdAt = iso(row.created);
    if (!createdAt) {
      noDate += 1;
      continue;
    }

    const entry: Record<string, unknown> = { id, createdAt };
    if (row.email) entry.email = row.email;

    if (src?.planField) {
      const plan = text(at(row, src.planField));
      if (plan) entry.plan = plan;
    }
    if (src?.paidField) {
      const state = (text(at(row, src.paidField)) ?? "").toLowerCase();
      if (src.paid?.includes(state)) entry.paid = true;
      else if (src.free?.includes(state)) entry.paid = false;
      /* A state in neither list is left OUT, not set to false. The source said
         something this table has not been told about, and a false there is a
         paid count that is quietly wrong. */
    }
    if (src?.lastSeenField) {
      const seen = at(row, src.lastSeenField);
      const stamp = iso(typeof seen === "number" ? seen : Number(seen) || null);
      if (stamp) entry.lastSeenAt = stamp;
    }
    if (src?.populationField || src?.populationDefault) {
      const value = src.populationField ? (text(at(row, src.populationField)) ?? "").toLowerCase() : "";
      entry.population = src.populations?.[value] ?? src.populationDefault ?? "customer";
    }
    users.push(entry);
  }

  if (!src)
    problems.push(
      `“${app.id}” is a source this box has no mapping for, so nothing could be read from it — its rows have no id, ` +
        `and every field beyond a signup date means something different per application. Add it to SOURCES in users-boxes.ts.`,
    );
  else if (noId)
    problems.push(
      `${noId} of ${app.recent?.length ?? 0} rows carry nothing at ${src.idField}, which is the product's own id for the ` +
        `person and the only thing that makes them one row across collections. They were skipped.`,
    );
  if (noDate)
    problems.push(`${noDate} row(s) carry no signup time and were skipped — a signup with no date cannot be put in a day.`);
  if (app.capped)
    problems.push(
      `The probe was capped at collection: it returned the newest ${app.recent?.length ?? 0} of ${app.total} rows, so the ` +
        `daily series reaches back only as far as the oldest of those. The total beside it is the whole table.`,
    );

  return {
    doc: { users, total: app.total, generatedAt: new Date(collectedAt * 1000).toISOString() },
    problems,
  };
}

/* ------------------------------------------------------- the Stripe product */

/**
 * WHICH SUBSCRIPTIONS ARE STILL RUNNING.
 *
 * `ended_at` is set only when a subscription has actually stopped billing — a
 * subscription that has merely asked to cancel still bills and is still a
 * customer, which is why `canceled` alone is not the test. `incomplete_expired`
 * is a checkout that never completed and was never a customer at all.
 */
const LIVE_STATUSES = ["active", "trialing", "past_due"];

/** The window the counts form publishes. Seven days because that is the one
 *  the contract's own example uses and the one the route prints verbatim. */
const STRIPE_WINDOW_DAYS = 7;

export type StripeDocument = { doc: unknown; matched: string[]; error: string | null };

/**
 * A product whose users are Stripe subscribers, counted from the tables this
 * box already collects.
 *
 * NO STRIPE CALL. `stripe_subscriptions` is filled by the finance collector
 * every half hour; asking Stripe again here would mean a second credential and
 * a second copy of the same numbers that could disagree with the Payments
 * board. Matched by PREFIX against the product name, the same way the previous
 * dashboard attributes revenue — "FreeLLMAPI Premium" and "FreeLLMAPI Team" are
 * one product's plans.
 *
 * IT IS THE COUNTS FORM AND NOT A LIST OF PEOPLE, and that is the one decision
 * in this file worth arguing. `stripe_subscriptions` has no customer column —
 * the revenue walk never needed one — so a row here is a SUBSCRIPTION. Emitting
 * one contract user per subscription would give a customer with two
 * subscriptions two rows, hash no address, and put an id that is not a person's
 * into the table whose whole purpose is that the same person is one row. The
 * contract has a second form for exactly this: "there are 391 of them and I
 * cannot name them", which is true, and which the route already draws as a
 * total with no windows rather than as a product where nobody signed up.
 *
 * The one thing this can say beyond a bare total is WHEN those subscriptions
 * started, so `new` is real here where the previous dashboard's fallback had to
 * publish null.
 */
export function stripeDocument(prefixes: string[], asOf = new Date()): StripeDocument {
  const wanted = prefixes.map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length)
    return { doc: null, matched: [], error: "No Stripe product prefix was given, so there is nothing to count." };

  const rows = db
    .prepare("SELECT product, status, created_at, ended_at FROM stripe_subscriptions WHERE product IS NOT NULL")
    .all() as unknown as { product: string; status: string; created_at: string; ended_at: string | null }[];

  const matched = new Set<string>();
  const since = new Date(asOf.getTime() - STRIPE_WINDOW_DAYS * 86_400_000).toISOString();
  let total = 0;
  let fresh = 0;

  for (const row of rows) {
    const name = row.product.toLowerCase();
    if (!wanted.some((p) => name.startsWith(p))) continue;
    matched.add(row.product);
    if (row.ended_at !== null || !LIVE_STATUSES.includes(row.status)) continue;
    total += 1;
    if (row.created_at >= since) fresh += 1;
  }

  if (!matched.size) {
    const names = [...new Set(rows.map((r) => r.product))].slice(0, 8);
    return {
      doc: null, matched: [],
      error:
        `No Stripe product name starts with ${wanted.map((p) => `“${p}”`).join(" or ")}. The products Stripe has ` +
        `told this box about: ${names.join(", ") || "none — connect Stripe first"}.`,
    };
  }

  return {
    doc: {
      counts: { total, new: { days: STRIPE_WINDOW_DAYS, n: fresh } },
      generatedAt: asOf.toISOString(),
    },
    matched: [...matched].sort(),
    error: null,
  };
}

/** How a Stripe-derived product's prefixes are typed: one per line, or comma
 *  separated, because both are what a person reaches for. */
export const parsePrefixes = (raw: string): string[] =>
  raw
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter(Boolean);
