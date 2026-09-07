/**
 * THE TWO THINGS A LEDGER CAN LOOK UP RATHER THAN BE TOLD.
 *
 * Every other figure in this area is either measured by a provider's collector
 * or typed by the owner. These two are PUBLISHED — by the registrar that will
 * send the renewal invoice, and by the central bank whose reference rate is
 * the closest thing to a neutral exchange rate that exists — and reading them
 * turns twenty-three unpriced domain rows into priced ones and lets a card
 * put euro servers and dollar services on one axis with the rate named.
 *
 * CACHED FOR A DAY, IN THE DATABASE. Dynadot's list is 800-odd TLDs and the
 * ECB's file changes once a business day; neither is worth asking for on
 * every half-hourly collection, and neither answer should be lost to a bad
 * minute at the other end. So each refresh keeps yesterday's rows when today's
 * read fails, reports the failure, and stamps every row with when it was
 * actually fetched — the date is what keeps a figure drawn from here from
 * pretending to be current.
 *
 * NEVER AUTHORITATIVE OVER THE OWNER. A domain price the owner typed is in
 * `owner_fields` and the seeder leaves it alone; a rate the owner typed on the
 * Finance page wins over the ECB's for that pair. This file supplies the
 * default, not the last word.
 */
import { db, now } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import * as dynadot from "../../providers/dynadot.ts";
import { currencyCode } from "./money.ts";

/** How old a cached row may be before a refresh asks again. */
const FRESH_MS = 20 * 60 * 60 * 1000;

const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ECB_TIMEOUT_MS = 20_000;
const ECB_BASE = "EUR";

/* ------------------------------------------------------------ registrar */

export type TldPriceRow = {
  registrar: string;
  tld: string;
  annual: number;
  currency: string;
  price_level: string | null;
  fetched_at: string;
};

const DYNADOT = "dynadot";

function freshEnough(fetchedAt: string | null | undefined): boolean {
  if (!fetchedAt) return false;
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) && Date.now() - t < FRESH_MS;
}

/** When the registrar's list was last read, and how much of it. */
export function priceListMeta(registrar = DYNADOT): { tlds: number; priceLevel: string | null; currency: string; fetchedAt: string } | null {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS tlds, MAX(price_level) AS level, MAX(currency) AS currency, MAX(fetched_at) AS fetched_at FROM finance_tld_prices WHERE registrar = ?",
    )
    .get(registrar) as { tlds: number; level: string | null; currency: string | null; fetched_at: string | null };
  if (!row || !row.tlds || !row.fetched_at) return null;
  return { tlds: row.tlds, priceLevel: row.level, currency: row.currency ?? "USD", fetchedAt: row.fetched_at };
}

/**
 * The suffixes a price list might be keyed on, longest first:
 * `example.co.uk` → `co.uk`, `uk`; `example.ie` → `ie`. A second-level registry
 * prices the pair, so the pair is asked first and the bare code only when
 * nobody keyed the pair.
 */
export function tldCandidates(name: string): string[] {
  const parts = name.toLowerCase().split(".").filter(Boolean);
  const out: string[] = [];
  if (parts.length >= 3) out.push(parts.slice(-2).join("."));
  if (parts.length >= 2) out.push(parts[parts.length - 1]!);
  return out;
}

/** The registrar's renewal price for this name, or null — never zero. */
export function tldPrice(name: string, registrar = DYNADOT): TldPriceRow | null {
  for (const tld of tldCandidates(name)) {
    const row = db
      .prepare("SELECT * FROM finance_tld_prices WHERE registrar = ? AND tld = ?")
      .get(registrar, tld) as TldPriceRow | undefined;
    if (row) return row;
  }
  return null;
}

/** Write a whole list at once, replacing the registrar's previous one. Only
 *  called with a list that parsed — a failed read keeps yesterday's rows. */
export function storeTldPrices(registrar: string, list: dynadot.PriceList, fetchedAt = now()): number {
  /* BEGIN/COMMIT by hand, the way db.ts's own writers do: node:sqlite's
     DatabaseSync has no transaction helper, and a list half-replaced by a
     thrown insert would price this morning's domains off two days' lists. */
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM finance_tld_prices WHERE registrar = ?").run(registrar);
    const ins = db.prepare(
      "INSERT INTO finance_tld_prices (registrar, tld, annual, currency, price_level, fetched_at) VALUES (?,?,?,?,?,?)",
    );
    for (const [tld, annual] of Object.entries(list.prices))
      ins.run(registrar, tld, annual, currencyCode(list.currency), list.priceLevel, fetchedAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return Object.keys(list.prices).length;
}

export type RefreshOutcome = { skipped: boolean; rows: number; error: string | null };

/**
 * Read Dynadot's list if the cached one is a day old, through whichever
 * connected Dynadot account has both halves of its credential.
 *
 * NEVER THROWS. A registrar that is not connected is `skipped` with no error
 * — there is nothing to ask — and a read that fails keeps the cached rows and
 * reports why, so the seeder prices what it can and the run log says what it
 * could not.
 */
export async function refreshTldPrices(): Promise<RefreshOutcome> {
  const meta = priceListMeta(DYNADOT);
  if (meta && freshEnough(meta.fetchedAt)) return { skipped: true, rows: meta.tlds, error: null };
  const { ready } = accounts.credentialed(DYNADOT, ["key", "secret"], "finance_prices");
  const first = ready[0];
  if (!first) return { skipped: true, rows: meta?.tlds ?? 0, error: null };
  try {
    const list = await dynadot.renewalPrices({ key: first.values.key!, secret: first.values.secret! });
    return { skipped: false, rows: storeTldPrices(DYNADOT, list), error: null };
  } catch (err) {
    return {
      skipped: false,
      rows: meta?.tlds ?? 0,
      error: `Dynadot price list: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/* ------------------------------------------------------------------ ECB */

export type ReferenceRates = {
  base: string;
  /** The ECB's own date for the file — a business day, so a Sunday read
   *  carries Friday's date, which is the honest one. */
  asOf: string;
  fetchedAt: string;
  /** currency → how many of it one unit of `base` buys. */
  rates: Record<string, number>;
};

/**
 * The ECB's daily file is one small XML: nested <Cube> elements where the
 * dated one carries time="YYYY-MM-DD" and each currency one carries
 * currency="USD" rate="1.16…" — units of that currency per euro. Pure, so a
 * captured file can be tested against it; throws in words on anything else.
 */
export function parseEcb(xml: string): { asOf: string; rates: Record<string, number> } {
  /* The live file single-quotes its attributes (`time='2026-09-07'`); the
     ECB's own documentation double-quotes them. Either is read. */
  const day = /<Cube[^>]*\btime=["'](\d{4}-\d{2}-\d{2})["']/.exec(xml)?.[1];
  if (!day) throw new Error("the ECB file carried no dated Cube");
  const rates: Record<string, number> = {};
  for (const m of xml.matchAll(/<Cube[^>]*\bcurrency=["']([A-Za-z]{3})["'][^>]*\brate=["']([0-9.]+)["']/g)) {
    const rate = Number(m[2]);
    if (Number.isFinite(rate) && rate > 0) rates[m[1]!.toUpperCase()] = rate;
  }
  if (!Object.keys(rates).length) throw new Error("the ECB file carried no rates");
  return { asOf: day, rates };
}

export function storeReferenceRates(parsed: { asOf: string; rates: Record<string, number> }, fetchedAt = now()): number {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM finance_fx_rates WHERE base = ?").run(ECB_BASE);
    const ins = db.prepare(
      "INSERT INTO finance_fx_rates (base, currency, rate, as_of, fetched_at) VALUES (?,?,?,?,?)",
    );
    for (const [currency, rate] of Object.entries(parsed.rates)) ins.run(ECB_BASE, currency, rate, parsed.asOf, fetchedAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return Object.keys(parsed.rates).length;
}

/** What is cached, or null before the first successful read. */
export function referenceRates(): ReferenceRates | null {
  const rows = db
    .prepare("SELECT currency, rate, as_of, fetched_at FROM finance_fx_rates WHERE base = ? ORDER BY currency")
    .all(ECB_BASE) as { currency: string; rate: number; as_of: string; fetched_at: string }[];
  if (!rows.length) return null;
  return {
    base: ECB_BASE,
    asOf: rows[0]!.as_of,
    fetchedAt: rows[0]!.fetched_at,
    rates: Object.fromEntries(rows.map((r) => [r.currency, r.rate])),
  };
}

/**
 * One unit of `from` in `to`, through the euro, or null when either leg is
 * missing. A cross rate through a reference base is what every desk quotes
 * for a pair the bank does not publish directly; it is still approximate,
 * and the caller says so.
 */
export function crossRate(ref: ReferenceRates | null, from: string, to: string): number | null {
  if (!ref) return null;
  const f = currencyCode(from);
  const t = currencyCode(to);
  if (f === t) return 1;
  const perEuro = (c: string) => (c === ref.base ? 1 : ref.rates[c] ?? null);
  const a = perEuro(f);
  const b = perEuro(t);
  if (a === null || b === null) return null;
  return b / a;
}

/** Fetch the ECB file if the cached one is a day old. Never throws. */
export async function refreshReferenceRates(): Promise<RefreshOutcome> {
  const have = referenceRates();
  if (have && freshEnough(have.fetchedAt))
    return { skipped: true, rows: Object.keys(have.rates).length, error: null };
  try {
    const res = await fetch(ECB_URL, {
      headers: { Accept: "application/xml", "User-Agent": "onepersoncompany-finance" },
      signal: AbortSignal.timeout(ECB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseEcb(await res.text());
    return { skipped: false, rows: storeReferenceRates(parsed), error: null };
  } catch (err) {
    return {
      skipped: false,
      rows: have ? Object.keys(have.rates).length : 0,
      error: `ECB reference rates: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
