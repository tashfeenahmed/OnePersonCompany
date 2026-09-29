/**
 * EVERY APP, BOTH STORES, ONE ROW — the document the Apps board is drawn from.
 *
 * /api/mobile reads the stores as two ledgers and /api/mobilehealth as a pile
 * of slices; neither can answer "how is AI Group Call doing", because the App
 * Store calls it 6801929313 and Play calls it com.aigroupcall. This joins them
 * on the bundle id — Apple's bundle id and Play's package are the same string
 * for every app here, give or take a `.ios` / `.android` suffix — and hangs
 * everything the box holds about the app off that one key: the icon and the
 * public rating from each store's listing, the daily downloads and installs,
 * countries, acquisition sources, Play's listing conversion, crashes and
 * ANRs, and the reviews themselves.
 *
 * THE CLIENT FILTERS, NOT THE ROUTE. Every app's slice travels in one
 * document so the board's app picker narrows every card at once without a
 * second request per card.
 *
 * ICONS AND PUBLIC RATINGS ARE CACHED (`mobile_listings`) and refreshed at
 * most every twelve hours, in the background, on read. Apple's ratings are
 * per storefront, so a handful of storefronts is asked and the counts added,
 * each average weighted by its own count. An icon is stored as a small data
 * URL so the board never hotlinks a store CDN on every view.
 */
import { db } from "../../db.ts";
import { linkIndex, normaliseEntity } from "../ventures/links.ts";
import { parsePlayPage } from "../growth/aso.ts";
import { fetchHtml } from "../growth/pages.ts";

const REFRESH_MS = 12 * 3_600_000;
/** The storefronts Apple's public rating is summed over. */
const STOREFRONTS = ["us", "gb", "ie", "ca", "au", "in", "de", "es", "fr", "mx", "ng", "pk", "ae", "sa"];

type ListingRow = {
  store: string;
  app: string;
  name: string | null;
  icon: string | null;
  rating: number | null;
  rating_count: number | null;
  url: string | null;
  fetched_at: string;
};

const now = () => new Date().toISOString();

/* ------------------------------------------------------------ listings */

async function iconData(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "image/png";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 200_000) return null;
    return `data:${type.split(";")[0]};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function appleListing(appId: string): Promise<Omit<ListingRow, "store" | "app" | "fetched_at">> {
  let name: string | null = null;
  let artwork: string | null = null;
  let url: string | null = null;
  let count = 0;
  let weighted = 0;
  for (const cc of STOREFRONTS) {
    try {
      const res = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${cc}`, {
        headers: { Accept: "application/json", "User-Agent": "OnePersonCompany/0.1 (+apps)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const r = ((await res.json()) as { results?: Record<string, unknown>[] }).results?.[0];
      if (!r) continue;
      name ??= typeof r.trackName === "string" ? r.trackName : null;
      artwork ??= typeof r.artworkUrl100 === "string" ? r.artworkUrl100 : null;
      url ??= typeof r.trackViewUrl === "string" ? r.trackViewUrl.split("?")[0]! : null;
      const n = typeof r.userRatingCount === "number" ? r.userRatingCount : 0;
      const avg = typeof r.averageUserRating === "number" ? r.averageUserRating : null;
      if (n > 0 && avg !== null) {
        count += n;
        weighted += avg * n;
      }
    } catch {
      /* one storefront failing is not the listing failing */
    }
  }
  return {
    name,
    icon: await iconData(artwork),
    rating: count ? Number((weighted / count).toFixed(2)) : null,
    rating_count: name ? count : null,
    url,
  };
}

async function playListing(pkg: string): Promise<Omit<ListingRow, "store" | "app" | "fetched_at">> {
  const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}&hl=en&gl=US`;
  const got = await fetchHtml(url);
  if ("error" in got) return { name: null, icon: null, rating: null, rating_count: null, url: null };
  const page = parsePlayPage(got.html);
  const og = /<meta property="og:image" content="([^"]+)"/i.exec(got.html)?.[1] ?? null;
  /* Play's icon URLs take a size suffix; 128px is plenty for a 20px chip. */
  const icon = og ? `${og.replace(/=[^/]*$/, "")}=s128` : null;
  return {
    name: page.name,
    icon: await iconData(icon),
    rating: page.rating,
    rating_count: page.ratingCount,
    url: `https://play.google.com/store/apps/details?id=${pkg}`,
  };
}

let refreshing = false;

/** Re-read every listing whose cache is older than twelve hours. */
export async function refreshListings(force = false): Promise<number> {
  if (refreshing) return 0;
  refreshing = true;
  try {
    const cached = new Map(
      (db.prepare("SELECT * FROM mobile_listings").all() as unknown as ListingRow[]).map((r) => [`${r.store}:${r.app}`, r]),
    );
    const stale = (store: string, app: string) => {
      const c = cached.get(`${store}:${app}`);
      return force || !c || Date.now() - Date.parse(c.fetched_at) > REFRESH_MS;
    };
    const upsert = db.prepare(
      `INSERT INTO mobile_listings (store, app, name, icon, rating, rating_count, url, fetched_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT (store, app) DO UPDATE SET
         name = COALESCE(excluded.name, name), icon = COALESCE(excluded.icon, icon),
         rating = excluded.rating, rating_count = excluded.rating_count,
         url = COALESCE(excluded.url, url), fetched_at = excluded.fetched_at`,
    );
    let n = 0;
    for (const a of db.prepare("SELECT DISTINCT app_id FROM appstore_apps").all() as { app_id: string }[]) {
      if (!stale("appstore", a.app_id)) continue;
      const l = await appleListing(a.app_id);
      upsert.run("appstore", a.app_id, l.name, l.icon, l.rating, l.rating_count, l.url, now());
      n++;
    }
    for (const p of playPackages()) {
      if (!stale("play", p)) continue;
      const l = await playListing(p);
      upsert.run("play", p, l.name, l.icon, l.rating, l.rating_count, l.url, now());
      n++;
    }
    return n;
  } finally {
    refreshing = false;
  }
}

function playPackages(): string[] {
  return (db.prepare("SELECT DISTINCT package FROM play_stats").all() as { package: string }[]).map((r) => r.package);
}

/* ------------------------------------------------------------ the join */

/** The key both stores share: the bundle id with any platform suffix off. */
export const appKey = (id: string) => id.trim().toLowerCase().replace(/\.(ios|android)$/, "");

export type AppsDoc = ReturnType<typeof appsDoc>;

type Count = { label: string; n: number };

const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export function appsDoc(days: number) {
  const from = since(days);
  const to = new Date().toISOString().slice(0, 10);
  /* Stale or missing listings are refreshed in the background; this read
     answers from whatever the cache holds now. */
  const oldest = db.prepare("SELECT MIN(fetched_at) t, COUNT(*) n FROM mobile_listings").get() as { t: string | null; n: number };
  if (!oldest.n || !oldest.t || Date.now() - Date.parse(oldest.t) > REFRESH_MS) void refreshListings().catch(() => 0);

  const listings = new Map(
    (db.prepare("SELECT * FROM mobile_listings").all() as unknown as ListingRow[]).map((r) => [`${r.store}:${r.app}`, r]),
  );
  const iosApps = db
    .prepare("SELECT app_id, bundle_id, name, state, version, on_store FROM appstore_apps")
    .all() as { app_id: string; bundle_id: string | null; name: string | null; state: string | null; version: string | null; on_store: number | null }[];
  const packages = playPackages();
  const iosVenture = linkIndex("appstore");
  const playVenture = linkIndex("playstore");

  type Entry = {
    key: string;
    name: string;
    icon: string | null;
    ventureId: string | null;
    appstore: { id: string; state: string | null; onStore: boolean | null; version: string | null; url: string | null; rating: number | null; ratingCount: number | null } | null;
    play: { package: string; url: string | null; rating: number | null; ratingCount: number | null; activeDevices: number | null; activeAt: string | null } | null;
    rating: { average: number; count: number | null } | null;
    totals: { ios: number; android: number; uninstalls: number };
    daily: { day: string; ios: number; android: number }[];
    countries: Count[];
    sources: (Count & { store: "appstore" | "play" })[];
    listing: { visitors: number; acquisitions: number } | null;
    stability: { crashes: number; anrs: number } | null;
    reviews: { count: number; average: number | null; stars: number[] };
  };
  const byKey = new Map<string, Entry>();
  const blank = (key: string, name: string): Entry => ({
    key, name, icon: null, ventureId: null, appstore: null, play: null, rating: null,
    totals: { ios: 0, android: 0, uninstalls: 0 }, daily: [], countries: [], sources: [],
    listing: null, stability: null, reviews: { count: 0, average: null, stars: [0, 0, 0, 0, 0] },
  });
  const iosKey = new Map<string, string>();
  for (const a of iosApps) {
    const key = appKey(a.bundle_id ?? a.app_id);
    iosKey.set(a.app_id, key);
    const l = listings.get(`appstore:${a.app_id}`);
    const e = byKey.get(key) ?? blank(key, a.name ?? l?.name ?? a.app_id);
    e.name = a.name ?? e.name;
    e.icon = l?.icon ?? e.icon;
    e.ventureId ??= iosVenture.get(normaliseEntity(a.app_id))?.[0] ?? null;
    e.appstore = {
      id: a.app_id, state: a.state, onStore: a.on_store === null ? null : a.on_store === 1, version: a.version,
      url: l?.url ?? null, rating: l?.rating ?? null, ratingCount: l?.rating_count ?? null,
    };
    byKey.set(key, e);
  }
  const latestPlay = new Map(
    (db.prepare(
      /* The newest day that CARRIES each figure: Play's latest rows often
         arrive before their device count and rating, and a null there read
         as "no devices" on the board. */
      `SELECT p.package,
              (SELECT active_devices FROM play_stats WHERE package = p.package AND active_devices IS NOT NULL ORDER BY day DESC LIMIT 1) active_devices,
              (SELECT day FROM play_stats WHERE package = p.package AND active_devices IS NOT NULL ORDER BY day DESC LIMIT 1) active_at,
              (SELECT rating_total FROM play_stats WHERE package = p.package AND rating_total IS NOT NULL ORDER BY day DESC LIMIT 1) rating_total
         FROM (SELECT DISTINCT package FROM play_stats) p`,
    ).all() as { package: string; active_devices: number | null; active_at: string | null; rating_total: number | null }[]).map((r) => [r.package, r]),
  );
  for (const p of packages) {
    const key = appKey(p);
    const l = listings.get(`play:${p}`);
    const e = byKey.get(key) ?? blank(key, l?.name ?? p);
    if (!e.appstore && l?.name) e.name = l.name;
    e.icon ??= l?.icon ?? null;
    e.ventureId ??= playVenture.get(normaliseEntity(p))?.[0] ?? null;
    const s = latestPlay.get(p);
    e.play = {
      package: p, url: l?.url ?? `https://play.google.com/store/apps/details?id=${p}`,
      rating: l?.rating ?? s?.rating_total ?? null, ratingCount: l?.rating_count ?? null,
      activeDevices: s?.active_devices ?? null,
      activeAt: s?.active_at ?? null,
    };
    byKey.set(key, e);
  }
  const entryOf = (store: string, app: string) => byKey.get(store === "appstore" ? (iosKey.get(app) ?? appKey(app)) : appKey(app));

  /* Ratings: weighted by count where both stores give one; Play's Console
     average (no count) stands alone when it is the only figure. */
  for (const e of byKey.values()) {
    const parts = [e.appstore, e.play].filter((x) => x && x.rating !== null) as { rating: number | null; ratingCount: number | null }[];
    const counted = parts.filter((x) => (x.ratingCount ?? 0) > 0);
    if (counted.length) {
      const n = counted.reduce((m, x) => m + x.ratingCount!, 0);
      e.rating = { average: Number((counted.reduce((m, x) => m + x.rating! * x.ratingCount!, 0) / n).toFixed(2)), count: n };
    } else if (parts.length) e.rating = { average: parts[0]!.rating!, count: null };
  }

  /* Daily downloads (App Store) and installs (Play). */
  const grid: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(d.getTime() + 86_400_000))
    grid.push(d.toISOString().slice(0, 10));
  const dayIndex = new Map(grid.map((d, i) => [d, i]));
  for (const e of byKey.values()) e.daily = grid.map((day) => ({ day, ios: 0, android: 0 }));
  for (const r of db.prepare("SELECT day, app_id, SUM(downloads) n FROM appstore_sales WHERE day >= ? GROUP BY day, app_id").all(from) as { day: string; app_id: string; n: number }[]) {
    const e = entryOf("appstore", r.app_id);
    const i = dayIndex.get(r.day);
    if (!e || i === undefined) continue;
    e.daily[i]!.ios += r.n;
    e.totals.ios += r.n;
  }
  for (const r of db.prepare("SELECT day, package, SUM(installs) i, SUM(uninstalls) u FROM play_stats WHERE day >= ? GROUP BY day, package").all(from) as { day: string; package: string; i: number | null; u: number | null }[]) {
    const e = entryOf("play", r.package);
    const i = dayIndex.get(r.day);
    if (!e || i === undefined) continue;
    e.daily[i]!.android += r.i ?? 0;
    e.totals.android += r.i ?? 0;
    e.totals.uninstalls += r.u ?? 0;
  }
  /* The daily table's uninstall column is empty in this export era; the
     per-version slices carry user uninstalls, so they are summed instead. */
  for (const r of db.prepare(
    `SELECT app, SUM(amount) n FROM mobile_dimensions
      WHERE day >= ? AND store = 'play' AND dimension = 'app_version' AND metric = 'user_uninstalls'
      GROUP BY app`,
  ).all(from) as { app: string; n: number | null }[]) {
    const e = entryOf("play", r.app);
    if (e && (r.n ?? 0) > e.totals.uninstalls) e.totals.uninstalls = r.n ?? 0;
  }

  /* Countries: App Store downloads by territory, Play installs by country. */
  const countries = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, Map<string, number>>, key: string, label: string, n: number) => {
    const inner = m.get(key) ?? new Map<string, number>();
    inner.set(label, (inner.get(label) ?? 0) + n);
    m.set(key, inner);
  };
  for (const r of db.prepare(
    `SELECT store, app, value, SUM(amount) n FROM mobile_dimensions
      WHERE day >= ? AND ((store = 'appstore' AND dimension = 'territory' AND metric = 'downloads.counts')
                       OR (store = 'play' AND dimension = 'country' AND metric = 'installs'))
      GROUP BY store, app, value`,
  ).all(from) as { store: string; app: string; value: string; n: number }[]) {
    const e = entryOf(r.store, r.app);
    if (e && r.n > 0) bump(countries, e.key, r.value.toUpperCase(), r.n);
  }
  /* Sources: how people arrived — Apple's source types, Play's traffic sources. */
  const sources = new Map<string, Map<string, number>>();
  for (const r of db.prepare(
    `SELECT app, value, SUM(amount) n FROM mobile_dimensions
      WHERE day >= ? AND store = 'appstore' AND dimension = 'source_type' AND metric = 'downloads.counts'
      GROUP BY app, value`,
  ).all(from) as { app: string; value: string; n: number }[]) {
    const e = entryOf("appstore", r.app);
    if (e && r.n > 0) bump(sources, e.key, `appstore|${r.value}`, r.n);
  }
  for (const r of db.prepare(
    `SELECT app, value, SUM(visitors) v, SUM(acquisitions) a FROM mobile_store_performance
      WHERE day >= ? AND dimension = 'traffic_source' GROUP BY app, value`,
  ).all(from) as { app: string; value: string; v: number | null; a: number | null }[]) {
    const e = entryOf("play", r.app);
    if (!e) continue;
    if ((r.a ?? 0) > 0) bump(sources, e.key, `play|${r.value}`, r.a ?? 0);
    e.listing = { visitors: (e.listing?.visitors ?? 0) + (r.v ?? 0), acquisitions: (e.listing?.acquisitions ?? 0) + (r.a ?? 0) };
  }
  for (const e of byKey.values()) {
    e.countries = [...(countries.get(e.key) ?? new Map()).entries()]
      .map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n).slice(0, 15);
    e.sources = [...(sources.get(e.key) ?? new Map()).entries()]
      .map(([k, n]) => ({ store: k.split("|")[0] as "appstore" | "play", label: k.split("|")[1]!, n }))
      .sort((a, b) => b.n - a.n);
  }

  /* Stability: Play's crash and ANR counts over the window. */
  for (const r of db.prepare(
    `SELECT app, metric, SUM(amount) n FROM mobile_stability
      WHERE day >= ? AND source = 'play-bucket' AND dimension = '(all)' GROUP BY app, metric`,
  ).all(from) as { app: string; metric: string; n: number | null }[]) {
    const e = entryOf("play", r.app);
    if (!e) continue;
    e.stability ??= { crashes: 0, anrs: 0 };
    if (r.metric === "crashes") e.stability.crashes += r.n ?? 0;
    if (r.metric === "anrs") e.stability.anrs += r.n ?? 0;
  }

  /* Reviews: every one the box holds (they are few), newest first. */
  const reviews = (db.prepare(
    `SELECT store, app, id, rating, title, body, author, territory, app_version, created, reply
       FROM mobile_reviews ORDER BY created DESC LIMIT 200`,
  ).all() as { store: string; app: string; id: string; rating: number | null; title: string | null; body: string | null; author: string | null; territory: string | null; app_version: string | null; created: string | null; reply: string | null }[])
    .map((r) => ({ ...r, key: entryOf(r.store, r.app)?.key ?? appKey(r.app) }));
  for (const r of reviews) {
    const e = byKey.get(r.key);
    if (!e || !r.rating) continue;
    e.reviews.count++;
    e.reviews.stars[Math.min(5, Math.max(1, r.rating)) - 1]!++;
  }
  for (const e of byKey.values()) {
    const s = e.reviews.stars;
    e.reviews.average = e.reviews.count ? Number((s.reduce((m, n, i) => m + n * (i + 1), 0) / e.reviews.count).toFixed(2)) : null;
  }

  const apps = [...byKey.values()].sort(
    (a, b) => b.totals.ios + b.totals.android - (a.totals.ios + a.totals.android) || a.name.localeCompare(b.name),
  );
  return {
    window: { days, from, to },
    generatedAt: now(),
    listingsFetchedAt: oldest.t,
    apps,
    reviews: reviews.map((r) => ({
      key: r.key, store: r.store, id: r.id, rating: r.rating, title: r.title, body: r.body, author: r.author,
      territory: r.territory, version: r.app_version, created: r.created, replied: !!r.reply,
    })),
  };
}
