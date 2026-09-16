/**
 * What a domain IS, once a registrar has been asked about it.
 *
 * Two registrars answer this question in two vocabularies — Dynadot sends
 * epoch milliseconds and yes/no strings and names its privacy product;
 * Spaceship sends ISO instants, real booleans, and reports the EPP statuses the
 * registry holds rather than a lock flag. This file is where both are folded
 * onto one shape, so nothing downstream has to know which registrar a row came
 * from in order to read it.
 *
 * The rules are lifted from the domain collector this replaced, which is the
 * version that had actually been run against real registrar accounts — every
 * one of the coercions below exists because a live API answered in a way the
 * obvious parse got wrong.
 *
 * NULL MEANS "ASKED AND NOT TOLD", never "no". An auto-renew that this API
 * cannot see is not auto-renew off — the difference is a domain you think is
 * safe and a domain that lapses on a Tuesday — so every uncertain field stays
 * null and the UI says "unknown" rather than drawing a warning it cannot
 * justify.
 */
import { allDomains, type DomainRecord } from "../db.ts";

export type DomainRow = {
  name: string;
  /** The plugin that read it: "dynadot" | "spaceship". */
  source: string;
  /** The registrar's own display name. */
  registrar: string;
  /** YYYY-MM-DD, or null when the registrar did not say. */
  expiresAt: string | null;
  registeredOn: string | null;
  autoRenew: boolean | null;
  locked: boolean | null;
  status: string | null;
  /** One lowercase word, or null. "off" is the only value drawn as a warning. */
  privacy: string | null;
  nameservers: string[] | null;
};

/* ------------------------------------------------------------------ dates */

/** Epoch milliseconds → YYYY-MM-DD. A ten-digit stamp is a date in seconds,
 *  not a date in 1970, so it is scaled rather than believed. */
function fromEpoch(value: number): string | null {
  let n = value;
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) < 1e11) n *= 1000;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * A date in whichever unit the registrar chose → YYYY-MM-DD.
 *
 * A number is an epoch, a string of digits is an epoch, anything else is
 * parsed as ISO, and a value that is none of those is null rather than a
 * thrown error — neither API has promised not to change its mind.
 */
export function asDay(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return fromEpoch(value);
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^-?\d+$/.test(raw)) return fromEpoch(Number(raw));
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Whole days from today until a date, UTC.
 *
 * COMPUTED WHEN READ, NEVER STORED. A "expires in 30 days" written into the
 * database at collection time is wrong by one the next morning and wrong by
 * thirty a month later if a collection fails — and a stale renewal countdown is
 * the single most dangerous number on a domains dashboard.
 */
export function daysUntil(day: string | null, now = new Date()): number | null {
  if (!day) return null;
  const then = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((then - today) / 86_400_000);
}

/** Keep today's renewals and unknown dates active. Re-evaluate on every read,
 * so expiry and a subsequently reported renewal need no destructive cleanup. */
export function domainHasExpired(day: string | null, now = new Date()): boolean {
  const days = daysUntil(day, now);
  return days !== null && days < 0;
}

/* ----------------------------------------------------------------- fields */

/** Dynadot answers yes/no in a string where JSON has had a boolean all along;
 *  a real boolean is honoured if one ever turns up. */
export function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const low = String(value ?? "").trim().toLowerCase();
  if (["yes", "true", "1"].includes(low)) return true;
  if (["no", "false", "0"].includes(low)) return false;
  return null;
}

/**
 * "auto-renew" → true, "donot renew" → false.
 *
 * "no renew option" means the domain follows the account default, which this
 * call cannot see — so null, never false.
 */
export function renewOption(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const low = String(value ?? "").trim().toLowerCase();
  if (low.includes("auto")) return true;
  if ((low.includes("do") && low.includes("not")) || low.includes("expire") || low.includes("manual"))
    return false;
  return null;
}

/**
 * A privacy setting as one lowercase word.
 *
 * The vocabularies differ — Spaceship grades it (high / basic), Dynadot names
 * the product ("Full Privacy") — so the trailing noun is dropped and every way
 * of spelling "there is none" folds onto "off", because that is the one value
 * the dashboard draws as a warning. Whatever is left passes through as the
 * registrar's own word rather than being forced into a vocabulary invented
 * here.
 */
export function privacyWord(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "high" : "off";
  if (typeof value !== "string") return null;
  let low = value.trim().toLowerCase().replace(/_/g, " ").split(/\s+/).join(" ");
  if (low.endsWith(" privacy")) low = low.slice(0, -" privacy".length).trim();
  if (!low || low === "privacy") return low ? "on" : null;
  const none = ["none", "no", "off", "false", "public", "disabled", "not set", "unset", "0"];
  return none.includes(low) ? "off" : low.slice(0, 24);
}

/** A nameserver list, lowercased, deduped and trimmed. Anything that is not a
 *  list of strings is nothing — a hostname is the only thing worth printing. */
export function hosts(values: unknown, limit = 8): string[] | null {
  if (!Array.isArray(values)) return null;
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== "string") continue;
    const h = v.trim().toLowerCase();
    if (h && !out.includes(h)) out.push(h);
  }
  return out.length ? out.slice(0, limit) : null;
}

/** A domain name as a key: lowercase, no trailing dot, or null if it is not
 *  one. Everything joins on this, so it is normalised in exactly one place. */
export function domainName(value: unknown): string | null {
  const name = String(value ?? "").trim().toLowerCase().replace(/\.+$/, "");
  return name || null;
}

/**
 * A registrar's own error message, with the credentials taken back out.
 *
 * Some APIs echo the key you sent them into the message when they reject it,
 * and that message is on its way to a run log the dashboard displays. Nothing
 * that was a secret when it left this process is a secret once it has been
 * written to a log somebody screenshots.
 */
export function scrub(text: string, ...secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out.slice(0, 220);
}

/** Both registrar reads share this: a name from an error nobody can act on. */
export function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "TimeoutError" ? "timed out" : err.message || err.name;
  }
  return "Error";
}

/* ------------------------------------------------------------- the portfolio */

/**
 * EVERY REGISTERED NAME THIS BOX KNOWS ABOUT, FROM WHICHEVER COLLECTOR FOUND
 * IT.
 *
 * There used to be two tables. `domains` held what the registrar plugins
 * report and `cloudflare_registrar` held what the Cloudflare plugin reports —
 * identical columns, identical meaning, and nothing that asked "what do I own
 * and when does it lapse" read the second. A name registered at Cloudflare was
 * therefore missing from the portfolio total, from the lapsed and expiring
 * counts, from auto-renew-off, from unlocked and from the renewal runway,
 * while the Cloudflare page filed that same zone under "no connected registrar
 * holds this name" three inches above printing it in its own registrar block.
 *
 * Migration `400_domains_cloudflare` carried those rows across under
 * `source = 'cloudflare'` and dropped the second table, so this is now one
 * read. It stays a NAMED function rather than becoming `allDomains()` at every
 * call site: it is the answer to "what does the portfolio contain", and the
 * surfaces that ask it should not each have to remember which collectors there
 * are.
 *
 * IT STILL HAS TO DEDUPE, and that is the whole reason it is not a synonym.
 * One name can be read by two collectors — a domain registered at Cloudflare
 * and also listed by a registrar plugin the owner has connected — and the
 * merge into one table turned what used to be two rows in two tables into two
 * rows in one. Counting the portfolio off the raw rows bills that name twice,
 * inflates the total, and double-counts it in every lapsed and expiring
 * bucket it falls into.
 *
 * THE REGISTRAR PLUGIN'S ROW WINS. Cloudflare's registrar endpoint reports
 * neither `registered_on`, nor privacy, nor nameservers, so its row is a
 * strict subset; preferring it would blank three fields the other collector
 * actually read. `routes/cloudflare.ts` reports the same overlap as
 * `claimedTwice`, which is the right answer to "who holds this name" — but it
 * is not the right answer to "how many names are there".
 */
export function registeredDomains(options: { includeExpired?: boolean; now?: Date } = {}): DomainRecord[] {
  const byName = new Map<string, DomainRecord>();
  for (const d of allDomains()) {
    const key = d.name.trim().toLowerCase();
    const held = byName.get(key);
    if (!held || (held.source === "cloudflare" && d.source !== "cloudflare"))
      byName.set(key, d);
  }
  // Deduplicate first: an older secondary provider row must not resurrect a
  // domain whose authoritative registrar row has expired. Raw records remain
  // available for history and for joins that describe DNS configuration.
  const at = options.now ?? new Date();
  return [...byName.values()].filter((d) => options.includeExpired || !domainHasExpired(d.expires_at, at));
}
