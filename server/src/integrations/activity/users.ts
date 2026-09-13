/**
 * USERS — the one population no vendor can be asked about.
 *
 * Stripe knows who paid and Umami knows who visited. Neither of them knows who
 * SIGNED UP, because a signup happens inside an application and no third party
 * is told about it. So the application tells this box, the way it already tells
 * its own admin page: a JSON document at a URL, one account per product, the
 * account's label being the product's name.
 *
 * THE CONTRACT IS PUBLISHED AND IT HAS TWO FORMS, because products differ in
 * what they can honestly offer.
 *
 *   {
 *     "users": [
 *       { "id": "u_1",                     // required, the product's own id
 *         "email": "mary@example.com",     // optional
 *         "createdAt": "2026-08-01T09:00:00Z",  // required, ISO 8601
 *         "plan": "pro",                   // optional
 *         "paid": true,                    // optional
 *         "lastSeenAt": "2026-09-01T…",    // optional, ISO 8601
 *         "country": "IE",                 // optional
 *         "population": "customer",        // optional; missing means customer
 *         "contactPermitted": false }      // optional; missing means false
 *     ],
 *     "total": 4873,                       // optional, the product's own count
 *     "generatedAt": "2026-09-05T…"        // optional, ISO 8601
 *   }
 *
 * and, for a product that cannot list its users at all — an app whose users
 * live in a third party, a database this box has no route to:
 *
 *   { "counts": { "total": 158, "new": { "days": 7, "n": 12 } },
 *     "generatedAt": "2026-09-05T…" }
 *
 * WHY A SECOND FORM RATHER THAN AN EMPTY LIST. `{"users": []}` is a product
 * saying it has no users. `{"counts": {"total": 158}}` is a product saying it
 * has 158 and cannot name them. Those are opposite facts and a schema that
 * could only express the first would have made the second invisible — which is
 * exactly the failure the system this replaces was built to avoid, where
 * counting one product's local table would have reported 1 user for its
 * largest customer base.
 *
 * A DOCUMENT THAT FAILS VALIDATION CHANGES NOTHING. The rows the last good
 * document produced stay exactly as they were, dated, beside a sentence saying
 * which field is wrong. A product ships a bad deploy at four in the morning
 * more often than it deletes its users, and a collector that let a malformed
 * document truncate the table would turn one bad minute into a page with
 * nobody on it.
 *
 * EVERY PROBLEM IS ITS OWN SENTENCE, NAMING THE FIELD AND SHOWING THE VALUE.
 * "The document is invalid" sends the owner to read their own JSON by hand;
 * `users[3].createdAt is "yesterday", which is not an ISO 8601 timestamp` sends
 * them to line 3. That is the whole difference between a validator worth
 * running at connect time and one worth ignoring.
 *
 * TWO FIELDS WERE ADDED AFTER THE FACT AND BOTH DEFAULT TO THE OLD MEANING.
 * `population` says who this person is to the business — customer, participant,
 * admin, trial or internal — because a portfolio whose products each mean
 * something different by "user" produces a total that is true of nothing;
 * missing is `customer`, which is what the contract always implied.
 * `contactPermitted` is false unless the document said true, and the only
 * legitimate source for a true is the product's own consent record; see the
 * ContractUser type for why nothing here will ever infer one. Every endpoint
 * written against the original contract is still valid and still means the
 * same thing.
 *
 * ADDRESSES ARE HASHED AND THE SALT IS PER INSTALL. See 130_activity_users:
 * the address is needed for identity across collections and for nothing else,
 * a hash serves identity exactly as well, and there is no route here that
 * takes an address — a lookup by address is the capability being declined.
 */
import { createHash, randomBytes } from "node:crypto";
import { db, finishRun, now, startRun, syncPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import {
  boxDocument,
  boxReader,
  parsePrefixes,
  SOURCES,
  sourceFor,
  stripeDocument,
  type BoxRead,
} from "./users-boxes.ts";

export const PLUGIN = "users";

/**
 * How much of a document is kept and parsed.
 *
 * A megabyte rather than product_docs' 64 KB, because this one legitimately
 * carries thousands of rows — the largest product on this box is ~4,900 users
 * and 478 KB. It is still a cap and it is still refused rather than truncated: half
 * a JSON document parsed as if it were whole would report a user base that had
 * halved overnight.
 */
export const MAX_DOC = 1024 * 1024;
/** How much of a document is stored for the panel to show. The whole thing is
 *  parsed; only this much is kept, because the page needs the SHAPE and not
 *  the population. */
export const KEEP_DOC = 24 * 1024;
const TIMEOUT_MS = 20_000;
const UA = "OnePersonCompany/0.1 (+users)";

/* ------------------------------------------------------------------- salt */

/**
 * The per-install salt, made once.
 *
 * Lazily rather than in a migration because a migration is pure SQL with no
 * imports and cannot reach a random number generator. `INSERT OR IGNORE` makes
 * two collectors racing at boot produce one salt rather than two.
 */
export function salt(): string {
  const held = saltIfAny();
  if (held) return held;
  db.prepare(
    "INSERT OR IGNORE INTO activity_salt (id, salt, created_at) VALUES (1, ?, ?)",
  ).run(randomBytes(32).toString("hex"), now());
  return saltIfAny()!;
}

/**
 * The salt as it stands, WITHOUT minting one.
 *
 * The difference from `salt()` matters to a reader rather than a writer: a
 * missing salt means no users document has ever been collected, so there is
 * nothing to look up, and creating one to answer a question would be a lookup
 * with a side effect.
 */
export function saltIfAny(): string | null {
  const row = db.prepare("SELECT salt FROM activity_salt WHERE id = 1").get() as
    | { salt: string }
    | undefined;
  return row?.salt ?? null;
}

/**
 * THE SCHEME, IN ONE PLACE — the normalisation, the separator and the digest.
 *
 * It was copied inline into another area's lookup, which is a silent and
 * unfalsifiable failure waiting to happen: if this side ever changes the
 * normalisation, the separator or rotates the salt, the copy goes on computing
 * the old hash and finds nothing — and the file holding the copy documents a
 * miss as meaning "no product's users document carries this address", which is
 * a FACT ABOUT THE PERSON. A wrong answer that looks like a finding.
 */
export const emailHash = (email: string, withSalt: string): string =>
  createHash("sha256").update(`${withSalt}:${email.trim().toLowerCase()}`).digest("hex");

/** One address as it is stored: a hash nothing can reverse, and the domain,
 *  which identifies nobody and is the only part worth a chart. Minting the
 *  salt if there is not one, because this is the WRITE path. */
export function hashEmail(email: string): { hash: string; domain: string | null } {
  const clean = email.trim().toLowerCase();
  const at = clean.lastIndexOf("@");
  return {
    hash: emailHash(clean, salt()),
    domain: at > 0 && at < clean.length - 1 ? clean.slice(at + 1) : null,
  };
}

/** The same hash for a READER: null when no document has ever been collected,
 *  so a caller can tell "nothing is connected" from "this address is not in
 *  it" without minting a salt to find out. */
export function lookupHash(email: string): string | null {
  const s = saltIfAny();
  return s === null ? null : emailHash(email, s);
}

/* --------------------------------------------------------------- contract */

/**
 * WHO THIS PERSON IS TO THE BUSINESS — the field added when the portfolio's
 * products started disagreeing about what "user" means.
 *
 * One product's user table holds people who signed up and pay. Another's holds
 * everyone who was ever invited into somebody else's session and never had an
 * account of their own. A third's holds the two staff logins that operate it.
 * Adding those three together produces a headline that is true of nothing, and
 * the predecessor of this box learned that by publishing it — see
 * deploy/adapters/CHECKLIST.md, which carries the distinctions over.
 *
 * FIVE VALUES AND NO OTHERS, because a free-text field here becomes twelve
 * spellings of "admin" inside a year:
 *   customer     signed up for this product on their own behalf
 *   participant  present because somebody else invited them
 *   admin        operates the product
 *   trial        signed up, has not paid, and the product tracks the difference
 *   internal     the owner's own accounts, test rows, seed data
 *
 * MISSING MEANS `customer`, and that is what makes this backwards compatible:
 * every endpoint written against the original contract keeps meaning exactly
 * what it meant, because "a user of this product" was always what it was
 * saying. A product that has participants and does not distinguish them is
 * over-reporting customers, which is a mapping to fix in the adapter and not a
 * reason to make every existing endpoint invalid overnight.
 */
export const POPULATIONS = ["customer", "participant", "admin", "trial", "internal"] as const;
export type Population = (typeof POPULATIONS)[number];

export type ContractUser = {
  id: string;
  email: string | null;
  createdAt: string;
  plan: string | null;
  paid: boolean | null;
  lastSeenAt: string | null;
  country: string | null;
  /** See POPULATIONS. Never null on a parsed row: an absent field is
   *  `customer`, stated once here rather than defaulted by every reader. */
  population: Population;
  /**
   * MAY ANYBODY WRITE TO THIS PERSON.
   *
   * False unless the document said true, and the document is only allowed to
   * say true when the adapter was configured with an explicit consent mapping
   * — a column in the product's own database that records the person agreeing.
   * There is no inference here and there is deliberately no way to add one:
   * "we hold an address" is not consent, and a field that quietly derived one
   * from the other would make this box the place a mailing list came from.
   *
   * It is stored beside a hash, not an address. Nothing in this application
   * can turn a permitted row back into somebody to write to; what the flag is
   * for is COUNTING — how many of a population could lawfully be contacted, so
   * a recovery campaign can be sized before anyone decides to run it, and
   * exported deliberately from the product that holds the consent.
   */
  contactPermitted: boolean;
};

export type Parsed =
  | {
      shape: "users";
      users: ContractUser[];
      /** The product's own count. Null when it did not publish one. */
      total: number | null;
      generatedAt: string | null;
    }
  | {
      shape: "counts";
      total: number | null;
      /** "n new in the last days days", exactly as the product framed it. */
      fresh: { days: number; n: number } | null;
      generatedAt: string | null;
    };

export type Validation =
  | { ok: true; parsed: Parsed; problems: string[] }
  | { ok: false; problems: string[] };

/** ISO 8601 that Date can read AND that carries a date. `Date.parse` accepts
 *  "2026" and a bare "Sep 5", which are not what this contract asks for. */
function isoAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim()))
    return null;
  const at = Date.parse(value.trim());
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function show(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "string") return `"${value.length > 40 ? `${value.slice(0, 40)}…` : value}"`;
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === "object") return "an object";
  return String(value);
}

/** How many bad rows are reported before the list is cut. A product that
 *  renamed one field produces one problem per user, and a page carrying four
 *  thousand identical sentences is a page nobody reads. */
const MAX_PROBLEMS = 12;

/**
 * One document against the contract.
 *
 * `ok: false` means NOTHING is stored — see this file's header. `ok: true` with
 * a non-empty `problems` means the document was accepted and some rows were
 * skipped, which is the right outcome for one malformed row in four thousand:
 * refusing the lot would lose 3,999 good ones over one typo.
 */
export function validate(doc: unknown): Validation {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return {
      ok: false,
      problems: [
        `The document is ${show(doc)}. It has to be a JSON object with either a "users" array or a "counts" object at the top level.`,
      ],
    };
  const top = doc as Record<string, unknown>;
  const generatedAt =
    top.generatedAt === undefined || top.generatedAt === null ? null : isoAt(top.generatedAt);
  const genProblem =
    top.generatedAt !== undefined && top.generatedAt !== null && generatedAt === null
      ? [`generatedAt is ${show(top.generatedAt)}, which is not an ISO 8601 timestamp.`]
      : [];

  /* THE COUNTS FORM. Checked first only because it is smaller; a document
     carrying both is a users document with a counts object it will ignore, and
     that is said out loud rather than silently preferred. */
  if (top.users === undefined && top.counts !== undefined) {
    const counts = top.counts;
    if (counts === null || typeof counts !== "object" || Array.isArray(counts))
      return { ok: false, problems: [`counts is ${show(counts)}, and it has to be an object: { "total": n, "new": { "days": 7, "n": n } }.`] };
    const c = counts as Record<string, unknown>;
    const problems = [...genProblem];

    let total: number | null = null;
    if (c.total === undefined || c.total === null)
      problems.push('counts.total is missing. A counts-only document exists to publish a total, so this is the one field it must have.');
    else if (typeof c.total !== "number" || !Number.isFinite(c.total) || c.total < 0)
      problems.push(`counts.total is ${show(c.total)}, which is not a count. It has to be a number that is not negative.`);
    else total = Math.round(c.total);

    let fresh: { days: number; n: number } | null = null;
    if (c.new !== undefined && c.new !== null) {
      const n = c.new;
      if (typeof n !== "object" || Array.isArray(n))
        problems.push(`counts.new is ${show(n)}, and it has to be an object: { "days": 7, "n": 12 }.`);
      else {
        const nn = n as Record<string, unknown>;
        const days = typeof nn.days === "number" && Number.isFinite(nn.days) && nn.days > 0 ? Math.round(nn.days) : null;
        const value = typeof nn.n === "number" && Number.isFinite(nn.n) && nn.n >= 0 ? Math.round(nn.n) : null;
        if (days === null) problems.push(`counts.new.days is ${show(nn.days)}, which is not a window in days.`);
        if (value === null) problems.push(`counts.new.n is ${show(nn.n)}, which is not a count.`);
        if (days !== null && value !== null) fresh = { days, n: value };
      }
    }

    if (total === null) return { ok: false, problems };
    return { ok: true, parsed: { shape: "counts", total, fresh, generatedAt }, problems };
  }

  /* THE USERS FORM. */
  if (top.users === undefined)
    return {
      ok: false,
      problems: [
        `The document has neither "users" nor "counts" at the top level. It has: ${Object.keys(top).slice(0, 10).join(", ") || "nothing"}.`,
      ],
    };
  if (!Array.isArray(top.users))
    return { ok: false, problems: [`users is ${show(top.users)}, and it has to be an array of user objects.`] };

  const problems = [...genProblem];
  let total: number | null = null;
  if (top.total !== undefined && top.total !== null) {
    if (typeof top.total !== "number" || !Number.isFinite(top.total) || top.total < 0)
      problems.push(`total is ${show(top.total)}, which is not a count. Leave it out rather than send a string.`);
    else total = Math.round(top.total);
  }

  const users: ContractUser[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  top.users.forEach((raw, i) => {
    const note = (message: string) => {
      skipped += 1;
      if (problems.length < MAX_PROBLEMS) problems.push(`users[${i}].${message}`);
    };
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      skipped += 1;
      if (problems.length < MAX_PROBLEMS)
        problems.push(`users[${i}] is ${show(raw)}, and every item of users has to be an object.`);
      return;
    }
    const u = raw as Record<string, unknown>;

    const id =
      typeof u.id === "string" && u.id.trim()
        ? u.id.trim()
        : typeof u.id === "number" && Number.isFinite(u.id)
          ? String(u.id)
          : null;
    if (id === null) return note(`id is ${show(u.id)}. Every user needs the product's own id for it — that is what makes the same person one row across collections.`);
    if (id.length > 200) return note(`id is ${id.length} characters long, which is longer than any id this stores (200).`);

    const createdAt = isoAt(u.createdAt);
    if (createdAt === null)
      return note(`createdAt is ${show(u.createdAt)}, which is not an ISO 8601 timestamp — "2026-08-01T09:00:00Z" or "2026-08-01".`);

    if (seen.has(id)) return note(`id ${show(id)} appears more than once in this document.`);
    seen.add(id);

    let email: string | null = null;
    if (u.email !== undefined && u.email !== null && u.email !== "") {
      if (typeof u.email !== "string" || !u.email.includes("@"))
        return note(`email is ${show(u.email)}, which is not an address. Leave the field out for a user who has none.`);
      email = u.email;
    }

    const lastSeenAt =
      u.lastSeenAt === undefined || u.lastSeenAt === null || u.lastSeenAt === ""
        ? null
        : isoAt(u.lastSeenAt);
    if (u.lastSeenAt !== undefined && u.lastSeenAt !== null && u.lastSeenAt !== "" && lastSeenAt === null)
      return note(`lastSeenAt is ${show(u.lastSeenAt)}, which is not an ISO 8601 timestamp.`);

    if (u.paid !== undefined && u.paid !== null && typeof u.paid !== "boolean")
      return note(`paid is ${show(u.paid)}. It is true or false, and it is left out entirely for a product that cannot say — which is not the same as false.`);

    /* POPULATION. Absent is `customer` and a WRONG value is a refused row, not
       a quiet fallback: "subscriber" arriving where "customer" was meant is a
       mapping the owner can fix in a minute if they are told, and a silent
       coercion is a portfolio-wide miscount nobody ever finds. */
    let population: Population = "customer";
    if (u.population !== undefined && u.population !== null && u.population !== "") {
      if (typeof u.population !== "string" || !POPULATIONS.includes(u.population as Population))
        return note(
          `population is ${show(u.population)}. It is one of ${POPULATIONS.join(", ")}, or left out entirely — a missing population is “customer”.`,
        );
      population = u.population as Population;
    }

    /* CONTACT PERMITTED. Only a literal `true` is consent. A string "true", a
       1, or anything else is refused rather than read generously, because this
       is the one field where a lenient parse would turn a type error into
       permission to write to somebody. */
    if (
      u.contactPermitted !== undefined &&
      u.contactPermitted !== null &&
      typeof u.contactPermitted !== "boolean"
    )
      return note(
        `contactPermitted is ${show(u.contactPermitted)}. It is true or false and nothing else — a "true" in quotes is not consent, and this is the one field that will not be read generously.`,
      );

    users.push({
      id,
      email,
      createdAt,
      plan: typeof u.plan === "string" && u.plan.trim() ? u.plan.trim().slice(0, 80) : null,
      paid: typeof u.paid === "boolean" ? u.paid : null,
      lastSeenAt,
      country:
        typeof u.country === "string" && u.country.trim()
          ? u.country.trim().slice(0, 40)
          : null,
      population,
      contactPermitted: u.contactPermitted === true,
    });
  });

  if (skipped > problems.length)
    problems.push(`…and ${skipped - problems.length} more row(s) with the same kinds of problem. ${skipped} of ${top.users.length} were skipped.`);

  /* EVERY ROW BAD IS A REFUSAL, not an empty import. A document with rows in
     it that produced nothing is a contract mismatch, and letting it through as
     "0 users read" would keep the old rows without ever saying why. */
  if (!users.length && top.users.length)
    return { ok: false, problems };

  return { ok: true, parsed: { shape: "users", users, total, generatedAt }, problems };
}

/* ------------------------------------------------------------------ fetch */

export type Fetched = {
  ok: boolean;
  status: number | null;
  ms: number;
  doc: unknown;
  /** The raw text, kept only so a non-JSON answer can be quoted back. */
  text: string | null;
  error: string | null;
};

/** GET one endpoint. Never throws: the caller has to report one product's
 *  failure without losing the others. */
export async function fetchEndpoint(url: string, token: string | null): Promise<Fetched> {
  const started = Date.now();
  const empty = { status: null, doc: null, text: null };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": UA,
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return {
      ok: false, ...empty, ms: Date.now() - started,
      error: cause?.code ?? (err instanceof Error ? err.message : String(err)),
    };
  }

  let body = "";
  let over = false;
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
        if (body.length > MAX_DOC) {
          over = true;
          break;
        }
      }
    } catch (err) {
      return {
        ok: false, ...empty, status: res.status, ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  const ms = Date.now() - started;
  if (!res.ok)
    return {
      ok: false, ...empty, status: res.status, ms,
      error: `HTTP ${res.status} ${res.statusText}`.trim(),
    };
  if (over)
    return {
      ok: false, ...empty, status: res.status, ms,
      error:
        `The document is larger than ${MAX_DOC / 1024} KB and was NOT parsed — half a user list read as if it were whole ` +
        `would report a population that had halved overnight. Page it, or publish the counts-only form.`,
    };

  try {
    return { ok: true, status: res.status, ms, doc: JSON.parse(body), text: body, error: null };
  } catch {
    return {
      ok: false, status: res.status, ms, doc: null, text: body,
      error: `It answered ${res.status} but not with JSON${body ? ` — it starts “${body.slice(0, 60).replace(/\s+/g, " ")}”` : ""}.`,
    };
  }
}

/* ------------------------------------------------------------- three doors */

/**
 * WHERE ONE PRODUCT'S USERS COME FROM.
 *
 * The contract has not changed and neither has anything downstream of it: every
 * branch below produces a document, `validate` checks it, and the same upsert
 * stores it. What differs is only who was asked.
 *
 *   endpoint  the product published the document itself, at a URL. The
 *             original door and still the right one — a product that can
 *             publish its own users needs nothing here to know its schema.
 *   box       the product's database is on one of the owner's own machines and
 *             will never have an endpoint. The `fleet` account for that box
 *             already holds the ssh credential, and a read-only probe on the
 *             box turns its tables into rows; see users-boxes.ts.
 *   stripe    the product has no self-hosted user table worth counting — its
 *             customers are subscribers, and they are counted from the Stripe
 *             tables this box already collects.
 *
 * THE KIND IS DERIVED FROM THE FIELDS AND NOT STORED, so there is no way for an
 * account to claim one kind and hold another's credentials. An account holding
 * fields for two kinds is refused by name rather than resolved by precedence:
 * picking one would be picking on the owner's behalf, and the wrong pick is a
 * product silently reporting somebody else's figures.
 */
export type DocSource = "endpoint" | "box" | "stripe";

export type AccountKind =
  | { kind: "endpoint"; url: string; token: string | null }
  | { kind: "box"; box: string; product: string }
  | { kind: "stripe"; prefixes: string[] }
  | { kind: "none"; why: string };

export function kindOf(values: Record<string, string>): AccountKind {
  const url = (values.url ?? "").trim();
  const box = (values.box ?? "").trim();
  const product = (values.product ?? "").trim();
  const stripe = (values.stripe ?? "").trim();

  const named = [url && "an endpoint", (box || product) && "a box", stripe && "Stripe"].filter(
    Boolean,
  ) as string[];
  if (named.length > 1)
    return {
      kind: "none",
      why:
        `This account names ${named.join(" and ")}. One account is one product read ONE way — fill in the endpoint, ` +
        `or the box and product, or the Stripe prefixes, and clear the rest.`,
    };

  if (url) return { kind: "endpoint", url, token: (values.token ?? "").trim() || null };
  if (box || product) {
    if (!box)
      return { kind: "none", why: `“${product}” has no box. Type the name of the Fleet account whose machine holds it.` };
    if (!product)
      return {
        kind: "none",
        why:
          `The box “${box}” is set but no product is. Type the probe's own id for the application — ` +
          `${SOURCE_IDS}.`,
      };
    return { kind: "box", box, product };
  }
  if (stripe) return { kind: "stripe", prefixes: parsePrefixes(stripe) };

  return {
    kind: "none",
    why:
      "This account says nothing about where its users are. Give it an endpoint publishing the users contract, " +
      "or a Fleet box and the probe's id for the application on it, or the Stripe product prefixes whose " +
      "subscribers are the user base.",
  };
}

/** The ids an account may name, for an error message that does not send the
 *  owner to read a source file. */
const SOURCE_IDS = SOURCES.map((s) => s.id).join(", ");

/** What one read produced, whichever door it came through. `url` is the
 *  LOCATOR — an https endpoint, an ssh target and the application, or the name
 *  of this box's own tables — and is what the panel prints under "where". */
export type Read = {
  ok: boolean;
  status: number | null;
  ms: number;
  doc: unknown;
  error: string | null;
  url: string;
  source: DocSource;
  site: string | null;
  /** Sentences the READER produced, as distinct from the validator's. A row
   *  the probe returned with no id is a problem with the source, not with the
   *  contract, and the two are kept apart so neither hides the other. */
  problems: string[];
};

/** One product read off a box, through a reader that probes each box once —
 *  see `boxReader`. Split out so `verify` and the collector share it. */
async function readBox(
  kind: { box: string; product: string },
  probeOne: (label: string) => Promise<BoxRead>,
): Promise<Read> {
  const src = sourceFor(kind.product);
  const where = `ssh://${kind.box}#${kind.product}`;
  const site = src?.site ? `https://${src.site}` : null;
  const base = { status: null, source: "box" as const, site, url: where };

  const run = await probeOne(kind.box);
  if (!run.probe)
    return { ...base, ok: false, ms: run.ms, doc: null, error: run.error, problems: [], url: run.target ? `ssh://${run.target}#${kind.product}` : where };

  const locator = `ssh://${run.target}#${kind.product}`;
  const app = run.probe.apps.find((a) => a.id === kind.product);
  if (!app)
    return {
      ...base, url: locator, ok: false, ms: run.ms, doc: null, problems: [],
      error:
        `The probe on ${run.target} ran, and no application there calls itself “${kind.product}”. It found: ` +
        `${run.probe.apps.map((a) => a.id).join(", ") || "nothing at all"}. An application whose container is ` +
        `stopped is simply absent from that list.`,
    };
  /* A PROBE THAT RAN AND AN APPLICATION THAT DID NOT ANSWER are two different
     failures and the second is reported as the product's own, not the box's:
     one stopped database must not read as an unreachable machine. */
  if (app.error)
    return { ...base, url: locator, ok: false, ms: run.ms, doc: null, problems: [], error: `${app.app} on ${run.target}: ${app.error}` };

  const built = boxDocument(app, src, run.probe.collectedAt);
  return { ...base, url: locator, ok: true, ms: run.ms, doc: built.doc, error: null, problems: built.problems };
}

/** One product's users derived from this box's own Stripe tables. No call
 *  goes out: `stripe_subscriptions` is already collected. */
function readStripe(prefixes: string[]): Read {
  const started = Date.now();
  const built = stripeDocument(prefixes);
  return {
    ok: built.error === null,
    status: null,
    ms: Date.now() - started,
    doc: built.doc,
    error: built.error,
    url: `stripe:${prefixes.join(",")}`,
    source: "stripe",
    site: null,
    /* THE FIRST CLAUSE HAS TO STAND ALONE. Surfaces that draw a product's
       problems cut the sentence short — the board's "worth a look" card takes
       sixty characters — so the caveat that matters is said before the
       explanation of it, not after. */
    problems: built.matched.length
      ? [
          `Counted from Stripe: a total, and nobody named. A row in stripe_subscriptions is a SUBSCRIPTION and not a ` +
            `person — somebody holding two of them is two rows — so this product publishes a count rather than a list. ` +
            `Matched: ${built.matched.join(", ")}.`,
        ]
      : [],
  };
}

/** One account, read whichever way its fields say. */
export async function readAccount(
  values: Record<string, string>,
  probeOne: (label: string) => Promise<BoxRead>,
): Promise<Read> {
  const kind = kindOf(values);
  if (kind.kind === "none")
    return { ok: false, status: null, ms: 0, doc: null, error: kind.why, url: "", source: "endpoint", site: null, problems: [] };
  if (kind.kind === "box") return readBox(kind, probeOne);
  if (kind.kind === "stripe") return readStripe(kind.prefixes);
  const got = await fetchEndpoint(kind.url, kind.token);
  return { ...got, url: kind.url, source: "endpoint", site: null, problems: [] };
}

/**
 * Verify, for the credential registry.
 *
 * IT VALIDATES THE CONTRACT AND NOT MERELY THE CONNECTION, which is the whole
 * value of doing it at connect time: the owner is standing at the form with
 * the endpoint's code open, and "users[0].createdAt is missing" costs them a
 * minute there and half a day if it is found later as an empty chart. The same
 * is true of a box — "no application there calls itself example-app-5-clod" is a
 * typo caught at the form, and an empty card a fortnight later otherwise.
 */
export async function verify(values: Record<string, string>): Promise<string | null> {
  const kind = kindOf(values);
  if (kind.kind === "none") return kind.why;

  if (kind.kind === "box" && !sourceFor(kind.product))
    return (
      `“${kind.product}” is not an application this box has a mapping for, so its rows could not be read even if the ` +
      `probe returned them. The ones it knows: ${SOURCE_IDS}.`
    );

  if (kind.kind === "endpoint") {
    let parsed: URL;
    try {
      parsed = new URL(kind.url);
    } catch {
      return `“${kind.url}” is not a URL. It needs a scheme: https://app.example.com/api/users.json.`;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return "Only http and https endpoints can be read here.";
  }

  const got = await readAccount(values, boxReader());
  if (!got.ok) {
    if (got.status === 401 || got.status === 403)
      return kind.kind === "endpoint" && kind.token
        ? `The endpoint refused the token (${got.status}). It is sent as “Authorization: Bearer <token>” — check that is the header it wants.`
        : `The endpoint needs authentication (${got.status}). Paste a token, or put the key in the URL if that is how it is read.`;
    return got.error ?? "It did not answer.";
  }

  const check = validate(got.doc);
  if (!check.ok) return `It answered, but the document does not match the contract. ${check.problems.join(" ")}`;
  /* Accepted with reservations is still accepted, and the reservations are
     returned as a REFUSAL here on purpose: verify is the only moment the owner
     is looking at the field, and a warning printed on a page they navigate
     away from is a warning nobody sees. They can save again to accept it —
     nothing here rejects a document the collector would keep. */
  /* ONLY THE VALIDATOR'S RESERVATIONS ARE A REFUSAL. `check.problems` are facts
     about the DOCUMENT — a mis-spelled createdAt the owner can go and fix — and
     showing them at the form is the whole value of verifying at connect time.
     `got.problems` are facts about the SOURCE, permanent and structural: a
     Stripe product that counts subscriptions rather than people, an application
     whose rows carry no id. Refusing on those would put a gate in front of the
     owner that saving again is the only way through and that no amount of
     fixing would ever open. They are stored on the document instead and are on
     the plugin panel, dated, beside the figures they qualify. */
  if (check.problems.length)
    return `It answered and the shape is right, but: ${check.problems.slice(0, 3).join(" ")} Save again to connect anyway — those rows will be skipped and the rest kept.`;
  return null;
}

/* ------------------------------------------------------------------ store */

export type DocRow = {
  account_id: number;
  ts: string;
  ok: number;
  status: number | null;
  ms: number | null;
  shape: string | null;
  url: string | null;
  /** How the document was obtained: 'endpoint' (the product published it),
   *  'box' (read off a fleet box with the users probe) or 'stripe' (derived
   *  from this box's own Stripe tables). NULL on a row stored before this
   *  column existed, which means 'endpoint' — it was the only way then. */
  source: string | null;
  /** The product's own site, where there is no endpoint URL to guess a venture
   *  from. NULL for an endpoint account, whose `url` already carries a host. */
  site: string | null;
  doc: string | null;
  users: number | null;
  total: number | null;
  generated_at: string | null;
  error: string | null;
  problems: string;
};

export function docRows(): DocRow[] {
  return db.prepare("SELECT * FROM activity_user_docs").all() as unknown as DocRow[];
}

/**
 * A copy of the document with every address taken out, small enough to keep.
 *
 * The panel needs the SHAPE — is `createdAt` spelled `created_at` here? — and
 * not the population, and a debugging aid is not a reason to keep four
 * thousand real addresses in the one table built to avoid holding them.
 */
export function redact(doc: unknown): string {
  const strip = (node: unknown, depth: number): unknown => {
    if (depth > 6) return "…";
    if (Array.isArray(node)) return node.slice(0, 3).map((n) => strip(n, depth + 1));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>))
        out[k] = /mail|address/i.test(k) && typeof v === "string" ? "«address removed»" : strip(v, depth + 1);
      return out;
    }
    return node;
  };
  const text = JSON.stringify(strip(doc, 0), null, 1) ?? "";
  return text.length > KEEP_DOC ? `${text.slice(0, KEEP_DOC)}\n… truncated for storage` : text;
}

function writeDoc(
  accountId: number,
  where: { url: string; source: DocSource; site: string | null },
  f: { ok: boolean; status: number | null; ms: number },
  fields: {
    shape: string | null;
    doc: string | null;
    users: number | null;
    total: number | null;
    generatedAt: string | null;
    error: string | null;
    problems: string[];
  },
) {
  db.prepare(
    `INSERT INTO activity_user_docs
       (account_id, ts, ok, status, ms, shape, url, source, site, doc, users, total, generated_at, error, problems)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET
       ts = excluded.ts, ok = excluded.ok, status = excluded.status, ms = excluded.ms,
       -- A failed fetch or a refused document KEEPS what the last good one
       -- said. See this file's header: the figures on the page go on saying
       -- what they last said, dated, beside the reason — which is the true
       -- picture, where nulls would be a page that lost its users.
       shape = COALESCE(excluded.shape, activity_user_docs.shape),
       url = excluded.url,
       -- Both follow the account every time, including to NULL: an account
       -- moved from an endpoint to a box has changed where its figures come
       -- from, and a COALESCE here would leave the panel naming the old one.
       source = excluded.source,
       site = excluded.site,
       doc = COALESCE(excluded.doc, activity_user_docs.doc),
       users = COALESCE(excluded.users, activity_user_docs.users),
       total = COALESCE(excluded.total, activity_user_docs.total),
       generated_at = COALESCE(excluded.generated_at, activity_user_docs.generated_at),
       error = excluded.error,
       problems = excluded.problems`,
  ).run(
    accountId,
    now(),
    f.ok ? 1 : 0,
    f.status,
    f.ms,
    fields.shape,
    where.url,
    where.source,
    where.site,
    fields.doc,
    fields.users,
    fields.total,
    fields.generatedAt,
    fields.error,
    JSON.stringify(fields.problems),
  );
}

/** The users of one account, upserted. Never a delete — see 130's header. */
function writeUsers(accountId: number, product: string, users: ContractUser[]) {
  const seen = now();
  const stmt = db.prepare(
    `INSERT INTO activity_users
       (account_id, product, user_id, email_hash, email_domain, created_at, plan, paid, last_seen, country, seen_at,
        population, contact_permitted)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id, user_id) DO UPDATE SET
       product = excluded.product,
       -- Both of these follow the document every time, including downwards.
       -- A product that revokes consent, or reclassifies somebody from
       -- customer to internal, is correcting the record, and a COALESCE here
       -- would make consent a thing this box could be told once and never
       -- told back.
       population = excluded.population,
       contact_permitted = excluded.contact_permitted,
       email_hash = COALESCE(excluded.email_hash, activity_users.email_hash),
       email_domain = COALESCE(excluded.email_domain, activity_users.email_domain),
       -- createdAt is NOT updated. A signup happened once; a product that
       -- re-dates it is describing its own database and not the event, and the
       -- first date this box was told is the earliest evidence it has.
       plan = excluded.plan,
       paid = excluded.paid,
       last_seen = COALESCE(excluded.last_seen, activity_users.last_seen),
       country = COALESCE(excluded.country, activity_users.country),
       seen_at = excluded.seen_at`,
  );
  db.exec("BEGIN");
  try {
    for (const u of users) {
      const mail = u.email ? hashEmail(u.email) : null;
      stmt.run(
        accountId,
        product,
        u.id,
        mail?.hash ?? null,
        mail?.domain ?? null,
        u.createdAt,
        u.plan,
        u.paid === null ? null : u.paid ? 1 : 0,
        u.lastSeenAt,
        u.country,
        seen,
        u.population,
        u.contactPermitted ? 1 : 0,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * The daily counts for one account, rebuilt from the rows it holds.
 *
 * REBUILT RATHER THAN INCREMENTED, because the rows themselves change: a
 * product that back-fills its history changes what this box knows about last
 * March, and a running total would carry the old answer forever. It is a
 * GROUP BY over one account's rows, which is thousands of rows at most.
 */
function rebuildDays(accountId: number) {
  const seen = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM activity_user_days WHERE account_id = ? AND source = 'rows'").run(accountId);
    db.prepare(
      `INSERT OR REPLACE INTO activity_user_days (account_id, day, signups, total, source, seen_at)
       SELECT account_id, substr(created_at, 1, 10), COUNT(*), NULL, 'rows', ?
         FROM activity_users WHERE account_id = ?
        GROUP BY substr(created_at, 1, 10)`,
    ).run(seen, accountId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** One day's level, for a product that publishes a count and no rows. */
function writeCountDay(accountId: number, total: number | null) {
  const seen = now();
  db.prepare(
    `INSERT INTO activity_user_days (account_id, day, signups, total, source, seen_at)
     VALUES (?, ?, NULL, ?, 'counts', ?)
     ON CONFLICT(account_id, day) DO UPDATE SET total = excluded.total, seen_at = excluded.seen_at`,
  ).run(accountId, seen.slice(0, 10), total, seen);
}

/** Rows of accounts that no longer exist, forgotten. The plugin_accounts row
 *  is gone, so nothing could ever name these again. */
export function forgetGoneAccounts(): number {
  const live = accounts.list(PLUGIN).map((a) => a.id);
  const ids = (
    db.prepare("SELECT DISTINCT account_id FROM activity_user_docs").all() as unknown as {
      account_id: number;
    }[]
  ).map((r) => r.account_id);
  let gone = 0;
  for (const id of ids) {
    if (live.includes(id)) continue;
    db.prepare("DELETE FROM activity_user_docs WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM activity_user_days WHERE account_id = ?").run(id);
    gone += Number(db.prepare("DELETE FROM activity_users WHERE account_id = ?").run(id).changes);
  }
  return gone;
}

/* -------------------------------------------------------------- collector */

export type UsersSummary = {
  ok: boolean;
  runId: number;
  endpoints: number;
  answered: number;
  rows: number;
  warnings: string[];
  error?: string | null;
  note?: string | null;
};

export async function collectUsers(): Promise<UsersSummary> {
  const runId = startRun(PLUGIN);
  forgetGoneAccounts();
  /*
    NO FIELD IS REQUIRED OF AN ACCOUNT HERE, because three kinds of account
    need three different sets of them — see `kindOf`, which derives the kind
    from what is present and refuses anything that names two. An account that
    says nothing is reported by name with what to fill in, which is what
    `credentialed`'s own `broken` list would have said about a missing URL.
  */
  const { ready } = accounts.credentialed(PLUGIN, [], "collect_users");
  const warnings: string[] = [];

  if (!ready.length) {
    const error =
      "No product is connected. Add one on the plugin page: an endpoint publishing the users contract, a Fleet box " +
      "and the application on it, or the Stripe product whose subscribers are the user base.";
    finishRun(runId, false, undefined, error);
    syncPlugin(PLUGIN, error);
    return { ok: false, runId, endpoints: 0, answered: 0, rows: 0, warnings, error };
  }

  let answered = 0;
  let rows = 0;
  /* ONE PROBE RUN PER BOX, however many of these products live on it. */
  const probeOne = boxReader();

  for (const { account, values } of ready) {
    const got = await readAccount(values, probeOne);
    const where = { url: got.url, source: got.source, site: got.site };

    if (!got.ok) {
      writeDoc(account.id, where, got, {
        shape: null, doc: null, users: null, total: null, generatedAt: null,
        error: got.error, problems: got.problems,
      });
      accounts.markFailed(account.id, got.error ?? "It did not answer.");
      warnings.push(`${account.label}: ${got.error}`);
      continue;
    }

    const check = validate(got.doc);
    if (!check.ok) {
      const why = `The document does not match the contract. ${check.problems.join(" ")}`;
      writeDoc(account.id, where, { ...got, ok: false }, {
        shape: null, doc: redact(got.doc), users: null, total: null, generatedAt: null,
        error: why, problems: [...got.problems, ...check.problems],
      });
      accounts.markFailed(account.id, why);
      warnings.push(`${account.label}: ${why}`);
      continue;
    }

    accounts.markOk(account.id);
    answered += 1;
    const p = check.parsed;
    if (p.total !== null) db.prepare("INSERT INTO activity_user_totals (account_id, day, total, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, day) DO UPDATE SET total = excluded.total, seen_at = excluded.seen_at").run(account.id, now().slice(0, 10), p.total, now());
    /* THE READER'S PROBLEMS COME FIRST. "12 rows carried no id" is a fact about
       the source and "users[3].createdAt is not ISO" is a fact about the
       document; both are kept, in that order, because the first usually
       explains the second. */
    const problems = [...got.problems, ...check.problems];

    if (p.shape === "users") {
      writeUsers(account.id, account.label, p.users);
      rebuildDays(account.id);
      rows += p.users.length;
      writeDoc(account.id, where, got, {
        shape: "users",
        doc: redact(got.doc),
        users: p.users.length,
        total: p.total,
        generatedAt: p.generatedAt,
        error: null,
        problems,
      });
    } else {
      writeCountDay(account.id, p.total);
      writeDoc(account.id, where, got, {
        shape: "counts",
        doc: redact(got.doc),
        users: null,
        total: p.total,
        generatedAt: p.generatedAt,
        error: null,
        problems,
      });
    }
    if (check.problems.length)
      warnings.push(`${account.label}: ${check.problems.length} row problem(s) — ${check.problems[0]}`);
  }

  const endpoints = ready.length;
  if (!answered) {
    const error = warnings.join("; ") || "No product endpoint answered.";
    finishRun(runId, false, undefined, error);
    syncPlugin(PLUGIN, error);
    return { ok: false, runId, endpoints, answered, rows, warnings, error };
  }

  const note = `${answered}/${endpoints} product${endpoints === 1 ? "" : "s"}, ${rows} user row(s) read`;
  finishRun(runId, true, note, warnings.join("; ") || undefined);
  syncPlugin(PLUGIN, warnings.join("; ") || null);
  return { ok: true, runId, endpoints, answered, rows, warnings, note };
}
