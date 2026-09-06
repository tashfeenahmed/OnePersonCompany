/**
 * The signals area's own rows.
 *
 * WHY THESE ARE HERE AND NOT IN db.ts. The shared file owns the tables every
 * area reads — plugins, accounts, runs, readings, config — and adding a
 * helper to it for each new integration is what the manifest seam exists to
 * stop. So the SQL for these three tables is in `migrations.ts` beside this
 * file, and the only statements that touch them are here.
 *
 * EVERY WRITE IS A REPLACEMENT OF ONE (host, source) OR (product, source)
 * PAIR, never a truncate. A source that failed this morning keeps the row it
 * wrote last night with its own `ts` on it, so "Bing last answered on Tuesday
 * and Common Crawl an hour ago" is a readable fact rather than two rows that
 * pretend to be the same age. The `ts` is the row's, not the run's.
 */
import { db, now } from "../../db.ts";

/* --------------------------------------------------------------- backlinks */

export type BacklinkSourceRow = {
  host: string;
  source: string;
  ts: string;
  ok: number | null;
  referring_domains: number | null;
  backlinks: number | null;
  linked_pages: number | null;
  crawl_pages: number | null;
  checked: number | null;
  live: number | null;
  followed: number | null;
  confidence: number;
  note: string | null;
  error: string | null;
};

export type BacklinkSourceWrite = Omit<BacklinkSourceRow, "ts">;

export function writeBacklinkSource(row: BacklinkSourceWrite) {
  db.prepare(
    `INSERT INTO backlink_sources
       (host, source, ts, ok, referring_domains, backlinks, linked_pages,
        crawl_pages, checked, live, followed, confidence, note, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(host, source) DO UPDATE SET
       ts = excluded.ts, ok = excluded.ok,
       referring_domains = excluded.referring_domains,
       backlinks = excluded.backlinks,
       linked_pages = excluded.linked_pages,
       crawl_pages = excluded.crawl_pages,
       checked = excluded.checked, live = excluded.live,
       followed = excluded.followed, confidence = excluded.confidence,
       note = excluded.note, error = excluded.error`,
  ).run(
    row.host, row.source, now(), row.ok,
    row.referring_domains, row.backlinks, row.linked_pages, row.crawl_pages,
    row.checked, row.live, row.followed, row.confidence, row.note, row.error,
  );
}

export function backlinkSources(): BacklinkSourceRow[] {
  return db
    .prepare("SELECT * FROM backlink_sources ORDER BY host, source")
    .all() as unknown as BacklinkSourceRow[];
}

/**
 * REFERRING DOMAINS FOR ONE HOST, AS ONE ANSWER — the single place this
 * figure is computed, so a per-source list and an authority estimate elsewhere
 * cannot each apply a different rule to the same table.
 *
 * BOTH RULES ARE TRUE AND BOTH ARE HERE. `combined` is null on principle —
 * the sources overlap by an unknown amount and neither is a census, so a sum
 * is a number in no unit at all. `best` is the largest single source WITH THE
 * SOURCE NAMED, which is the most defensible single figure there is and the
 * only one an estimate may be built on. `perSource` is what each said.
 */
export type ReferringDomains = {
  /** The largest single source's count, or null when none answered. */
  best: number | null;
  /** Which source that was. Never a sum of two. */
  source: string | null;
  perSource: { source: string; ok: number | null; referringDomains: number | null }[];
  /** NULL ON PRINCIPLE, not for want of data. See above. */
  combined: null;
};

export function referringDomains(host: string): ReferringDomains {
  const rows = db
    .prepare("SELECT source, ok, referring_domains FROM backlink_sources WHERE host = ?")
    .all(host) as unknown as { source: string; ok: number | null; referring_domains: number | null }[];
  const perSource = rows.map((r) => ({ source: r.source, ok: r.ok, referringDomains: r.referring_domains }));
  let best: { source: string; value: number } | null = null;
  for (const r of perSource)
    if (r.referringDomains !== null && (best === null || r.referringDomains > best.value))
      best = { source: r.source, value: r.referringDomains };
  return { best: best?.value ?? null, source: best?.source ?? null, perSource, combined: null };
}

/** When this host's cheapest source last answered, for the day clock. Null
 *  for a host nothing has ever been asked about — which is collected now,
 *  whatever the clock says, because the point of adding a host is to see it. */
export function backlinkLastRun(host: string): string | null {
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM backlink_sources WHERE host = ?")
    .get(host) as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

export type BacklinkRow = {
  host: string;
  source: string;
  from_domain: string;
  from_url: string;
  to_url: string | null;
  anchor: string | null;
  live: number | null;
  nofollow: number | null;
  error: string | null;
  seen_at: string;
};

/**
 * Replace one (host, source)'s rows with what this run found, capped.
 *
 * SCOPED TO THE SOURCE that produced them, so a Bing failure does not delete
 * the pages the verification crawler read an hour ago — and so a link that
 * has genuinely gone from an index disappears from that index's list rather
 * than lingering forever under an `ON CONFLICT` that only ever inserts.
 */
export function writeBacklinkRows(
  host: string,
  source: string,
  rows: Omit<BacklinkRow, "host" | "source" | "seen_at">[],
  cap: number,
) {
  const ts = now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM backlink_rows WHERE host = ? AND source = ?").run(host, source);
    const insert = db.prepare(
      `INSERT OR REPLACE INTO backlink_rows
         (host, source, from_domain, from_url, to_url, anchor, live, nofollow, error, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows.slice(0, cap))
      insert.run(host, source, r.from_domain, r.from_url, r.to_url, r.anchor, r.live, r.nofollow, r.error, ts);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function backlinkRows(host: string): BacklinkRow[] {
  return db
    .prepare("SELECT * FROM backlink_rows WHERE host = ? ORDER BY source, from_domain")
    .all(host) as unknown as BacklinkRow[];
}

/** A host taken off the list takes its rows with it, or it would go on being
 *  answered by a route whose list no longer names it. */
export function forgetBacklinkHosts(keep: string[]) {
  const held = db
    .prepare("SELECT DISTINCT host FROM backlink_sources")
    .all() as unknown as { host: string }[];
  for (const { host } of held) {
    if (keep.includes(host)) continue;
    db.prepare("DELETE FROM backlink_sources WHERE host = ?").run(host);
    db.prepare("DELETE FROM backlink_rows WHERE host = ?").run(host);
  }
}

/* ---------------------------------------------------------------- presence */

export type PresenceRow = {
  product: string;
  host: string;
  source: string;
  ts: string;
  status: string;
  url: string | null;
  evidence: string | null;
  note: string | null;
};

export function writePresence(row: Omit<PresenceRow, "ts">) {
  db.prepare(
    `INSERT INTO presence (product, host, source, ts, status, url, evidence, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product, source) DO UPDATE SET
       host = excluded.host, ts = excluded.ts, status = excluded.status,
       url = excluded.url, evidence = excluded.evidence, note = excluded.note`,
  ).run(row.product, row.host, row.source, now(), row.status, row.url, row.evidence, row.note);
}

export function presenceRows(): PresenceRow[] {
  return db
    .prepare("SELECT * FROM presence ORDER BY product, source")
    .all() as unknown as PresenceRow[];
}

export function presenceLastRun(product: string): string | null {
  const row = db
    .prepare("SELECT MAX(ts) AS ts FROM presence WHERE product = ?")
    .get(product) as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

export function forgetPresenceProducts(keep: string[]) {
  const held = db
    .prepare("SELECT DISTINCT product FROM presence")
    .all() as unknown as { product: string }[];
  for (const { product } of held)
    if (!keep.includes(product))
      db.prepare("DELETE FROM presence WHERE product = ?").run(product);
}

/* ------------------------------------------------------------------- voice */

export type VoiceRunRow = {
  id: number;
  ts: string;
  kind: string;
  ms: number | null;
  bytes: number | null;
  ok: number;
  error: string | null;
};

/** One attempt. Never the words, never the bytes — see 052 in migrations. */
export function writeVoiceRun(row: {
  kind: "stt" | "tts" | "ogg" | "probe";
  ms: number | null;
  bytes: number | null;
  ok: boolean;
  error?: string | null;
}) {
  db.prepare(
    "INSERT INTO voice_runs (ts, kind, ms, bytes, ok, error) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(now(), row.kind, row.ms, row.bytes, row.ok ? 1 : 0, row.error ?? null);
}

export function voiceRuns(limit = 20): VoiceRunRow[] {
  return db
    .prepare("SELECT * FROM voice_runs ORDER BY id DESC LIMIT ?")
    .all(limit) as unknown as VoiceRunRow[];
}

/** Counts and the median latency per kind, computed at read time from the
 *  rows themselves — a stored average would decay the way every derived
 *  figure on this box refuses to. */
export function voiceTotals(): { kind: string; ok: number; failed: number; medianMs: number | null }[] {
  const kinds = db
    .prepare("SELECT DISTINCT kind FROM voice_runs")
    .all() as unknown as { kind: string }[];
  return kinds.map(({ kind }) => {
    const rows = db
      .prepare("SELECT ms, ok FROM voice_runs WHERE kind = ?")
      .all(kind) as unknown as { ms: number | null; ok: number }[];
    const times = rows
      .filter((r) => r.ok === 1 && typeof r.ms === "number")
      .map((r) => r.ms!)
      .sort((a, b) => a - b);
    return {
      kind,
      ok: rows.filter((r) => r.ok === 1).length,
      failed: rows.filter((r) => r.ok === 0).length,
      medianMs: times.length ? times[Math.floor(times.length / 2)]! : null,
    };
  });
}
