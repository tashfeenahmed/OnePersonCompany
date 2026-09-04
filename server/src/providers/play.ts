/**
 * Google Play.
 *
 * ONE CREDENTIAL — a Google Cloud service account JSON, invited to the Play
 * Console — and one place everything worth having comes from: the console's
 * own report bucket, `pubsite_prod_<developer id>`, read over the plain GCS
 * JSON API. Nothing here calls the Android Publisher API and nothing calls the
 * Play Developer Reporting API: reviews, listings, crash rates and ANR rates
 * are a different integration to a different question, and each needs its own
 * grant that can be missing on its own. This is the money and the store, which
 * is what the bucket already holds.
 *
 * THE SCOPE IS `devstorage.read_only` AND NOTHING ELSE. workdash mints its
 * Reporting token separately from its bucket token precisely so an API nobody
 * has switched on cannot cost the run its installs; the same argument, applied
 * to an integration that reads only the bucket, says to ask for only the scope
 * the bucket needs. A token carrying `androidpublisher` would buy reviews this
 * file does not read and would fail on a project where that API is off.
 *
 * TWO FOLDERS, TWO DIFFERENT KINDS OF MONEY, AND THEY ARE NEVER ADDED:
 *
 *   earnings/  one ZIP per month: every transaction in MERCHANT currency,
 *              with Google's fee as its own negative row. Summed, that is the
 *              payout — the money that actually lands. The only figure
 *              anything downstream may call revenue.
 *   sales/     one ZIP per month: every order in the BUYER's currency, gross,
 *              inclusive of tax and before Google's cut. An estimate, and the
 *              only thing that exists for the month still running — Google
 *              writes the earnings ZIP for a month only once it is settled.
 *
 * On this account, August 2026 has both: nine buyer currencies in `sales/`
 * against one merchant currency in `earnings/`. That is the whole reason the
 * route reports per currency and offers no total.
 *
 * THE CSVs ARE NOT ONE FORMAT. The console's `stats/` exports are UTF-16 (with
 * a BOM in some eras and without one in others); the CSVs inside the financial
 * ZIPs are UTF-8. Every column is matched by NAME, never by position, because
 * Google renames and reorders them between eras — the 2026 sales era calls the
 * package column "Package ID" where an earlier one called it "Package Name".
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";
import { createPrivateKey, sign } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const GCS = "https://storage.googleapis.com/storage/v1/b";
const TIMEOUT_MS = 45_000;
const USER_AGENT = "onepersoncompany-collector/1.0";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";

/** Months of financial report walked. A month whose newest object in the
 *  bucket has not changed since it was last read is not fetched again. */
export const EARNINGS_MONTHS = 13;

/** Months of daily install and rating CSVs read. Two is enough for every
 *  thirty-day window on the board, and Google rewrites the current month's
 *  file every day. */
export const STATS_MONTHS = 2;

export class PlayError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PlayError";
    this.status = status;
  }
}

/* -------------------------------------------------------------------- auth */

export type ServiceAccount = {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
  project_id?: string;
};

/** The JSON, parsed and checked for the three fields that make it usable.
 *  A key file missing `private_key` is refused here rather than at the point
 *  a signature comes out empty three frames away. */
export function readServiceAccount(text: string): ServiceAccount {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PlayError(400, "That is not JSON. Paste the service account key file whole.");
  }
  const sa = doc as ServiceAccount;
  if (!sa?.client_email || !sa?.private_key)
    throw new PlayError(
      400,
      "That JSON has no client_email and private_key — it does not look like a service account key.",
    );
  return sa;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * An access token, by the JWT-bearer grant.
 *
 * A self-signed RS256 assertion posted to Google's token endpoint, which is
 * the whole of what `google-auth` does for a service account. Written out
 * rather than depended on, because this server has two runtime dependencies
 * and both of them are Hono — a library that compiles at install time is a
 * library that eventually fails to install on the Pi this is meant to run on.
 */
export async function accessToken(sa: ServiceAccount): Promise<string> {
  const uri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: sa.private_key_id }),
  );
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: uri, iat: now, exp: now + 3600 }),
  );

  let key;
  try {
    key = createPrivateKey(sa.private_key);
  } catch {
    throw new PlayError(400, "The private_key in that JSON is not a readable PEM key.");
  }
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), key);
  const assertion = `${header}.${claims}.${b64url(signature)}`;

  let res: Response;
  try {
    res = await fetch(uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlayError(
      0,
      err instanceof Error && err.name === "TimeoutError"
        ? "Google's token endpoint did not answer within 45 seconds."
        : "Could not reach Google's token endpoint.",
    );
  }

  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token)
    throw new PlayError(
      res.status,
      // Google's own sentence, which is usually exact ("Invalid JWT Signature",
      // "Invalid grant: account not found") and always better than ours.
      `Google refused the service account: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`,
    );
  return body.access_token;
}

/* --------------------------------------------------------------- the bucket */

/**
 * The report bucket's name, which is the DEVELOPER ACCOUNT's id and not the
 * Cloud project's.
 *
 * It is shown on the Play Console's download-reports page as
 * `pubsite_prod_<developer id>`, and it is not discoverable from the service
 * account — the credential says nothing about which developer account it was
 * invited to. So it is a text field the owner pastes and can read back, beside
 * the key rather than inside it. A bare id is accepted and prefixed, because
 * that is what the console shows in some places.
 */
export function normaliseBucket(raw: string): string {
  const v = raw.trim().replace(/^gs:\/\//, "").replace(/\/.*$/, "");
  if (!v) return "";
  return /^\d+$/.test(v) ? `pubsite_prod_${v}` : v;
}

export type GcsObject = { name: string; updated: string; size: number };

async function gcs(token: string, url: string, accept: "json" | "bytes") {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new PlayError(
      0,
      err instanceof Error && err.name === "TimeoutError"
        ? "Cloud Storage did not answer within 45 seconds."
        : "Could not reach Cloud Storage.",
    );
  }
  if (res.status === 403 || res.status === 401)
    throw new PlayError(
      res.status,
      "Google refused the bucket. The service account is invited to the Play Console but has not been given the reports it needs, or the developer id is wrong.",
    );
  if (res.status === 404)
    throw new PlayError(
      404,
      "No such bucket. Check the developer id on Play Console → Download reports.",
    );
  if (!res.ok) throw new PlayError(res.status, `Cloud Storage answered HTTP ${res.status}.`);
  return accept === "json"
    ? ((await res.json()) as Record<string, unknown>)
    : Buffer.from(await res.arrayBuffer());
}

/** Every object under a prefix, with the timestamp Google last wrote it —
 *  which is what makes "has this month's report been revised" a question that
 *  costs one listing rather than a download per month. */
export async function listObjects(
  token: string,
  bucket: string,
  prefix: string,
): Promise<GcsObject[]> {
  const out: GcsObject[] = [];
  let page: string | undefined;
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({
      prefix,
      fields: "items(name,updated,size),nextPageToken",
      maxResults: "1000",
    });
    if (page) q.set("pageToken", page);
    const doc = (await gcs(token, `${GCS}/${bucket}/o?${q}`, "json")) as {
      items?: { name: string; updated: string; size: string }[];
      nextPageToken?: string;
    };
    for (const item of doc.items ?? [])
      out.push({ name: item.name, updated: item.updated, size: Number(item.size) || 0 });
    page = doc.nextPageToken;
    if (!page) return out;
  }
  return out;
}

export async function fetchObject(
  token: string,
  bucket: string,
  name: string,
): Promise<Buffer | null> {
  try {
    return (await gcs(
      token,
      `${GCS}/${bucket}/o/${encodeURIComponent(name)}?alt=media`,
      "bytes",
    )) as Buffer;
  } catch (err) {
    // A listed object that 404s on read is a race with Google's own rewrite,
    // not a broken integration: it costs this file and nothing else.
    if (err instanceof PlayError && err.status === 404) return null;
    throw err;
  }
}

/* --------------------------------------------------------------------- zip */

/**
 * A ZIP reader, in about forty lines.
 *
 * Node ships gzip and raw deflate but no archive reader, and the financial
 * reports are ZIPs. The alternative was a dependency; this is the whole of
 * what these files need — walk the central directory from the end, take each
 * entry's name and its data, inflate the deflated ones. Encryption, zip64 and
 * multi-disk archives are not handled and are not produced by Google: a report
 * ZIP here is one CSV of a few kilobytes.
 */
export function unzip(buf: Buffer): { name: string; data: Buffer }[] {
  // The end-of-central-directory record is the last thing in the file, after a
  // comment of unknown length — so it is found by scanning backwards for its
  // signature rather than by arithmetic.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65_557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PlayError(0, "That report is not a readable ZIP archive.");

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) break;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);

    // The local header's extra field is allowed to differ in length from the
    // central one, so the data offset is computed from the local header —
    // trusting the central directory's lengths here is the classic way to read
    // a ZIP that is off by a handful of bytes.
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressed);

    try {
      out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
    } catch {
      // One unreadable member must not cost the month: the others are still
      // whole, and a partial report says so through its row count.
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ------------------------------------------------------------------- text */

/**
 * A report's bytes as text.
 *
 * The console's `stats/` exports are UTF-16 — with a BOM in some eras, bare
 * little-endian in others — while the CSVs inside the financial ZIPs are
 * UTF-8. Sniffed rather than assumed: a BOM decides outright, a NUL byte early
 * in the file means UTF-16 without one, and everything else is UTF-8.
 */
export function decodeReport(buf: Buffer): string {
  if (buf.length >= 2) {
    const a = buf[0]!;
    const b = buf[1]!;
    if (a === 0xff && b === 0xfe) return buf.subarray(2).toString("utf16le");
    if (a === 0xfe && b === 0xff) return swap16(buf.subarray(2)).toString("utf16le");
  }
  const head = buf.subarray(0, 200);
  if (head.includes(0))
    return (head[0] === 0 ? swap16(buf) : buf).toString("utf16le");
  return buf.toString("utf8").replace(/^﻿/, "");
}

/** Big-endian UTF-16 to little, because Node decodes only the latter. */
function swap16(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i]!;
    out[i] = out[i + 1]!;
    out[i + 1] = t;
  }
  return out;
}

/**
 * CSV, with quotes.
 *
 * A hand-rolled parser rather than a split on commas, because these files
 * genuinely need one: the earnings export writes dates as `"Aug 8, 2026"` and
 * amounts as `"46,000.00"`, both of which a naive split cuts in half and
 * silently turns into a different table.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

/** "Daily Device Installs" and "daily_device_installs" are one column. */
const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A cell as a number. Empty and NA are null, never zero: an absent figure and
 *  a measured zero are different facts and the cards render them apart. */
export function number(s: string | undefined): number | null {
  const v = (s ?? "").trim().replace(/,/g, "");
  if (!v || v.toUpperCase() === "NA") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The first of several candidate column names that this era actually has. */
function column(head: string[], candidates: string[]): number {
  for (const c of candidates) {
    const i = head.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

/* -------------------------------------------------------------- financials */

const PACKAGE_COLS = ["package id", "package name", "product id", "product"];
const MERCHANT_AMOUNT_COLS = ["amount merchant currency", "merchant currency amount"];
const MERCHANT_CURRENCY_COLS = ["merchant currency"];
const SALE_AMOUNT_COLS = ["charged amount"];
const SALE_TAX_COLS = ["taxes collected"];
const SALE_CURRENCY_COLS = ["currency of sale", "buyer currency"];

/** One month's payout, per package per merchant currency. */
export type EarningsRow = {
  package: string;
  currency: string;
  /** Charges, before Google's fee and before refunds. */
  charged: number;
  /** Refunded charges. Negative. */
  refunds: number;
  /** Google's fee, and the fee given back on a refund. Negative overall. */
  fees: number;
  /** What is left, which is the money that lands. */
  net: number;
  transactions: number;
};

/**
 * An `earnings/` CSV summed.
 *
 * GOOGLE'S FEE IS A ROW, NOT A RATE. Every charge is followed by a negative
 * "Google fee" row, and a refund by both a negative charge and a positive fee
 * refund — so the payout is the plain sum of the merchant-currency column and
 * needs no percentage applied to it. The four transaction types are kept apart
 * as well as summed, because "what did Google take" is a question the netted
 * figure can no longer answer.
 */
export function parseEarnings(text: string): EarningsRow[] {
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map(normHeader);
  const pi = column(head, PACKAGE_COLS);
  const ai = column(head, MERCHANT_AMOUNT_COLS);
  const ci = column(head, MERCHANT_CURRENCY_COLS);
  const ti = column(head, ["transaction type"]);
  if (pi < 0 || ai < 0) return [];

  const acc = new Map<string, EarningsRow>();
  for (const row of rows) {
    const pkg = (row[pi] ?? "").trim();
    const amount = number(row[ai]);
    if (!pkg || amount === null) continue;
    const currency = (ci >= 0 ? row[ci] ?? "" : "").trim().toUpperCase() || "?";
    const key = `${pkg} ${currency}`;
    const bucket =
      acc.get(key) ??
      { package: pkg, currency, charged: 0, refunds: 0, fees: 0, net: 0, transactions: 0 };

    const type = (ti >= 0 ? row[ti] ?? "" : "").trim().toLowerCase();
    if (type.startsWith("google fee")) bucket.fees += amount;
    else if (type.includes("refund")) bucket.refunds += amount;
    else bucket.charged += amount;
    bucket.net += amount;
    bucket.transactions += 1;
    acc.set(key, bucket);
  }
  return [...acc.values()].map((r) => ({
    ...r,
    charged: round(r.charged),
    refunds: round(r.refunds),
    fees: round(r.fees),
    net: round(r.net),
  }));
}

/** One month's orders, per package per buyer currency. An estimate. */
export type SalesRow = {
  package: string;
  currency: string;
  /** What buyers were charged, tax included. Refunds are already negative in
   *  this column, which is why nothing here re-signs them — see below. */
  charged: number;
  taxes: number;
  orders: number;
  refunds: number;
};

/**
 * A `sales/` CSV summed.
 *
 * THE REFUND TRAP, FOUND IN THIS ACCOUNT'S OWN AUGUST FILE. A refund row
 * carries a NEGATIVE "Charged Amount" and a POSITIVE "Item Price" — the same
 * order, described twice, once signed and once not. Reading the item price and
 * negating it by the "Financial Status" column gets the right answer; reading
 * the charged amount and negating it by the same column gets the sign back to
 * front and turns a refund into a second sale. So the charged amount is taken
 * exactly as written and the status column is used only to COUNT refunds,
 * never to sign an amount. Both August EUR and August INR net to zero here,
 * which is how the trap was noticed.
 */
export function parseSales(text: string): SalesRow[] {
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map(normHeader);
  const pi = column(head, PACKAGE_COLS);
  const ai = column(head, SALE_AMOUNT_COLS);
  const ci = column(head, SALE_CURRENCY_COLS);
  const xi = column(head, SALE_TAX_COLS);
  const si = column(head, ["financial status"]);
  if (pi < 0 || ai < 0) return [];

  const acc = new Map<string, SalesRow>();
  for (const row of rows) {
    const pkg = (row[pi] ?? "").trim();
    const amount = number(row[ai]);
    if (!pkg || amount === null) continue;
    const currency = (ci >= 0 ? row[ci] ?? "" : "").trim().toUpperCase() || "?";
    const key = `${pkg} ${currency}`;
    const bucket =
      acc.get(key) ?? { package: pkg, currency, charged: 0, taxes: 0, orders: 0, refunds: 0 };
    bucket.charged += amount;
    bucket.taxes += (xi >= 0 ? number(row[xi]) : null) ?? 0;
    const status = (si >= 0 ? row[si] ?? "" : "").trim().toLowerCase();
    if (status.includes("refund") || status.includes("chargeback")) bucket.refunds += 1;
    else bucket.orders += 1;
    acc.set(key, bucket);
  }
  return [...acc.values()].map((r) => ({
    ...r,
    charged: round(r.charged),
    taxes: round(r.taxes),
  }));
}

const round = (n: number) => Number(n.toFixed(2));

/** Every CSV inside a report ZIP, parsed by whichever reader was handed in.
 *  One unreadable member is skipped rather than costing the month. */
function zipRows<T>(buf: Buffer, parse: (text: string) => T[]): T[] {
  const out: T[] = [];
  for (const member of unzip(buf)) {
    if (!member.name.toLowerCase().endsWith(".csv")) continue;
    try {
      out.push(...parse(decodeReport(member.data)));
    } catch {
      /* one bad member inside a zip must not cost the whole month */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ stats */

const MONTH_RE = /(\d{6})/;

/**
 * The newest object per month.
 *
 * Google re-uploads a month's report as it finalises — `…_202608_…-1.zip`
 * becomes `-2` — and summing two revisions would double the money. The
 * lexically largest name for a month is the newest revision.
 */
export function latestPerMonth(objects: GcsObject[], keep: number): Map<string, GcsObject> {
  const by = new Map<string, GcsObject>();
  for (const o of objects) {
    if (!o.name.toLowerCase().endsWith(".zip")) continue;
    const m = MONTH_RE.exec(o.name.split("/").pop() ?? "");
    if (!m) continue;
    const month = m[1]!;
    const held = by.get(month);
    if (!held || o.name > held.name) by.set(month, o);
  }
  return new Map([...by.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-keep));
}

/** `stats/installs/installs_<package>_<yyyymm>_overview.csv` and its ratings
 *  twin — the only two slices this reads. The others (country, device, OS,
 *  language, carrier) are the same totals cut up, and cutting them up is a
 *  different dashboard. */
const OVERVIEW_RE = /^stats\/([a-z_]+)\/[a-z_]+_(.+)_(\d{6})_overview\.csv$/;

export type StatsFile = { kind: string; package: string; month: string; object: GcsObject };

export function indexOverviews(objects: GcsObject[]): StatsFile[] {
  const out: StatsFile[] = [];
  for (const o of objects) {
    const m = OVERVIEW_RE.exec(o.name);
    if (m) out.push({ kind: m[1]!, package: m[2]!, month: m[3]!, object: o });
  }
  return out;
}

export type StatsDay = {
  day: string;
  installs: number | null;
  uninstalls: number | null;
  activeDevices: number | null;
  installEvents: number | null;
  uninstallEvents: number | null;
  ratingDaily: number | null;
  ratingTotal: number | null;
};

const INSTALL_FIELDS: Record<string, string[]> = {
  installs: ["daily device installs", "daily user installs"],
  uninstalls: ["daily device uninstalls", "daily user uninstalls"],
  activeDevices: ["active device installs", "daily active devices"],
  installEvents: ["install events"],
  uninstallEvents: ["uninstall events"],
};

const RATING_FIELDS: Record<string, string[]> = {
  ratingDaily: ["daily average rating"],
  ratingTotal: ["total average rating"],
};

/**
 * One overview CSV as {day: fields}.
 *
 * A field whose column this era does not carry is null on every row, and a
 * blank cell is null for that day. The rating columns need one extra rule:
 * Google writes `0.0` in "Daily Average Rating" for a day nobody rated, and
 * zero stars is not the average of no ratings — so a daily rating of exactly
 * zero is read as "nobody rated it", which is what it means.
 */
export function parseOverview(
  text: string,
  fields: Record<string, string[]>,
): Map<string, Record<string, number | null>> {
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map(normHeader);
  const di = column(head, ["date"]);
  if (di < 0) return new Map();

  const idx: [string, number][] = [];
  for (const [key, names] of Object.entries(fields)) {
    const i = column(head, names);
    if (i >= 0) idx.push([key, i]);
  }

  const out = new Map<string, Record<string, number | null>>();
  for (const row of rows) {
    const day = (row[di] ?? "").trim();
    if (!day) continue;
    const rec: Record<string, number | null> = {};
    for (const [key, i] of idx) {
      const v = number(row[i]);
      rec[key] = key === "ratingDaily" && v === 0 ? null : v;
    }
    out.set(day, rec);
  }
  return out;
}

/* ------------------------------------------------------------------ shapes */

export type PackageStats = { package: string; days: StatsDay[] };

export type MonthFile = { month: string; object: string; updated: string };

export type AccountResult = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  bucket?: string;
  serviceAccount?: string;
  packages?: string[];
  stats?: PackageStats[];
  /** The payout, per month. Merchant currency. */
  earnings?: { month: string; file: MonthFile; rows: EarningsRow[] }[];
  /** The estimate, per month. Buyer currency, gross of Google's cut. */
  sales?: { month: string; file: MonthFile; rows: SalesRow[] }[];
  /** Months whose report is unchanged since the last run and was not
   *  re-downloaded. Not missing — already held. */
  unchanged?: string[];
};

export type CollectResult = {
  accounts: AccountResult[];
  accountsTried: number;
  warnings: string[];
};

/* ------------------------------------------------------------------ verify */

/**
 * Is this key real, and does it reach this bucket?
 *
 * TWO THINGS TO GET WRONG AND TWO CHECKS. The token mint proves the JSON is a
 * live service account; it proves nothing about the Play Console, which is a
 * separate grant made by a human in a different interface and typically hours
 * later. So the bucket is listed as well, and its 403 comes back as the
 * sentence that names the actual next step rather than as an empty dashboard
 * discovered a day later.
 *
 * An empty bucket is NOT a failure. A developer account whose first month is
 * still running has no reports yet, and refusing to connect over that would be
 * refusing a working credential.
 */
export async function verify(
  json: string,
  bucketRaw: string,
): Promise<{ ok: true; objects: number; email: string } | { ok: false; error: string }> {
  try {
    const sa = readServiceAccount(json);
    const bucket = normaliseBucket(bucketRaw);
    if (!bucket)
      return { ok: false, error: "The developer id is needed — the reports live in a bucket named after it." };
    const token = await accessToken(sa);
    const objects = await listObjects(token, bucket, "");
    return { ok: true, objects: objects.length, email: sa.client_email };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof PlayError ? err.message : "Could not reach Google.",
    };
  }
}

/* ----------------------------------------------------------------- collect */

/** What this account already holds, so a run downloads only what changed. */
export type Known = { files: Map<string, string> };

const fileKey = (folder: string, month: string) => `${folder}/${month}`;

export async function collectAccount(
  account: Account,
  json: string,
  bucketRaw: string,
  known: Known,
): Promise<AccountResult> {
  const sa = readServiceAccount(json);
  const bucket = normaliseBucket(bucketRaw);
  const token = await accessToken(sa);

  /*
    PACKAGES ARE DISCOVERED, NEVER TYPED. The owner's apps are known by name
    and their package ids are not, and a hand-kept list silently misses the
    next launch — which is the one an owner most wants to see on a board.
  */
  const installObjects = await listObjects(token, bucket, "stats/installs/");
  const ratingObjects = await listObjects(token, bucket, "stats/ratings/");
  const installs = indexOverviews(installObjects);
  const ratings = indexOverviews(ratingObjects);
  const packages = [...new Set(installs.map((f) => f.package))].sort();

  /*
    The newest STATS_MONTHS of each package's overview file, re-read every run
    rather than cached: Google rewrites the running month's CSV daily and
    revises the previous month for a few days after it ends. The rows are
    keyed by day, so re-reading corrects rather than duplicates.
  */
  const months = [...new Set(installs.map((f) => f.month))].sort().slice(-STATS_MONTHS);
  const stats: PackageStats[] = [];

  const blank = (day: string): StatsDay => ({
    day,
    installs: null,
    uninstalls: null,
    activeDevices: null,
    installEvents: null,
    uninstallEvents: null,
    ratingDaily: null,
    ratingTotal: null,
  });

  for (const pkg of packages) {
    /*
      The two exports are merged ON THE DAY rather than kept as two series.
      They are one row of one table — how many installs and what people thought
      of it — and a package that has installs and no ratings file (four of the
      five here) gets nulls in the rating columns rather than missing days.
    */
    const byDay = new Map<string, StatsDay>();
    const take = async (file: StatsFile | undefined, fields: Record<string, string[]>) => {
      if (!file) return;
      const raw = await fetchObject(token, bucket, file.object.name);
      if (!raw) return;
      for (const [day, rec] of parseOverview(decodeReport(raw), fields))
        byDay.set(day, { ...(byDay.get(day) ?? blank(day)), ...rec });
    };

    for (const month of months) {
      await take(installs.find((f) => f.package === pkg && f.month === month), INSTALL_FIELDS);
      await take(ratings.find((f) => f.package === pkg && f.month === month), RATING_FIELDS);
    }
    if (byDay.size)
      stats.push({
        package: pkg,
        days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      });
  }

  /*
    THE TWO FINANCIAL FOLDERS, WALKED THE SAME WAY AND KEPT APART. A month is
    downloaded only when the newest object for it is one this account has not
    already ingested — the object NAME carries the revision, so a re-upload
    changes it and a settled month never gets fetched twice.
  */
  const unchanged: string[] = [];
  const earnings: AccountResult["earnings"] = [];
  const sales: AccountResult["sales"] = [];

  const earningsFiles = latestPerMonth(
    await listObjects(token, bucket, "earnings/"),
    EARNINGS_MONTHS,
  );
  for (const [month, object] of earningsFiles) {
    if (known.files.get(fileKey("earnings", month)) === object.name) {
      unchanged.push(`earnings ${month}`);
      continue;
    }
    const raw = await fetchObject(token, bucket, object.name);
    if (!raw) continue;
    earnings.push({
      month,
      file: { month, object: object.name, updated: object.updated },
      rows: zipRows(raw, parseEarnings),
    });
  }

  const salesFiles = latestPerMonth(
    await listObjects(token, bucket, "sales/"),
    EARNINGS_MONTHS,
  );
  for (const [month, object] of salesFiles) {
    /*
      The RUNNING month's sales file is re-read every time regardless of its
      name, because Google rewrites it in place as orders come in — skipping it
      on an unchanged name would freeze this month's estimate on the day it was
      first seen. Closed months are skipped exactly like the earnings ones.
    */
    const current = new Date().toISOString().slice(0, 7).replace("-", "");
    if (month !== current && known.files.get(fileKey("sales", month)) === object.name) {
      unchanged.push(`sales ${month}`);
      continue;
    }
    const raw = await fetchObject(token, bucket, object.name);
    if (!raw) continue;
    sales.push({
      month,
      file: { month, object: object.name, updated: object.updated },
      rows: zipRows(raw, parseSales),
    });
  }

  return {
    id: account.id,
    label: account.label,
    ok: true,
    bucket,
    serviceAccount: sa.client_email,
    packages,
    stats,
    earnings,
    sales,
    unchanged,
  };
}

export async function collect(
  known: (accountId: number) => Known,
  reader = "collect_playstore",
): Promise<CollectResult> {
  const { ready, broken } = accounts.credentialed(
    "playstore",
    ["key.json", "developer-id"],
    reader,
  );
  const out: AccountResult[] = [];
  const warnings: string[] = [];

  for (const { account, missing } of broken) {
    const error = `Missing ${missing.join(", ")}.`;
    out.push({ id: account.id, label: account.label, ok: false, error });
    warnings.push(`${account.label}: ${error}`);
  }

  for (const { account, values } of ready) {
    try {
      out.push(
        await collectAccount(
          account,
          values["key.json"] ?? "",
          values["developer-id"] ?? "",
          known(account.id),
        ),
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      out.push({ id: account.id, label: account.label, ok: false, error });
      warnings.push(`${account.label}: ${error}`);
    }
  }

  return { accounts: out, accountsTried: ready.length + broken.length, warnings };
}
