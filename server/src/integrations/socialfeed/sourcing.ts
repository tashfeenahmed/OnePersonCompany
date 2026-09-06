/**
 * SOURCE DISCOVERY — where a shorts job's raw material comes from.
 *
 * WHAT WAS MISSING. `integrations/video/autopilot.ts` says, in its own
 * settings hint, that `shorts` "needs a source URL and the autopilot has no
 * way to invent one" — so the only format a daily pass could ever queue was
 * `faceless`. That sentence is now false, and this file is why: a query
 * derived from the venture and the topic goes to the SearXNG node in its VIDEO
 * category, the results are ranked, the ones that cannot be used are refused
 * with a reason, and the winner's URL is what the run is dispatched with.
 *
 * SEARXNG RATHER THAN A VIDEO PLATFORM'S OWN API, for the reason the demand
 * collector reaches for it: there is no YouTube key in this vault, the node is
 * already connected and already metasearches half a dozen video engines. It is
 * called through `providers/searxng.ts`'s own credential function
 * (`borrowKey`) so the crossing is recorded in secret_access under this
 * reader's name.
 *
 * THE RAW DOCUMENT IS READ HERE RATHER THAN THROUGH `ask()`. That function is
 * the agent's search tool and it shapes results down to title, url, content,
 * engine, score and date — which is right for a link and wrong for a video,
 * because it drops the two fields this ranking is built on: `length` (the
 * duration the engine reported) and `author` (the channel). Rather than widen
 * a shared tool's return type for one caller, this makes the same request with
 * `categories=videos` and reads the fields it needs. The transport rules are
 * the same and are restated here, not re-derived: `format=json`, the key in an
 * `x-api-key` HEADER and never the query string, and `language=en-US` so the
 * answer does not change with the IP that asked.
 *
 * TWO SOURCES OF DURATION AND THE DOCUMENT SAYS WHICH. The engines publish a
 * length string ("40:11") that is sometimes absent and occasionally wrong;
 * yt-dlp reads the real metadata. yt-dlp is asked ONLY for the top few
 * candidates, with `--dump-json --skip-download` — it fetches metadata and
 * never a video file — because it is a network round trip per candidate and
 * the ranking only needs to be right at the top.
 *
 * THE RANK IS ARITHMETIC AND IS NOT A MODEL. Duration inside the usable band,
 * recency where a date was published, and how many engines carried the result.
 * A model choosing between twenty links would be a model call per pass, per
 * venture, to make a decision three numbers can make — and it would not be
 * reproducible, which is the property that makes a refusal explainable.
 */
import { randomUUID } from "node:crypto";
import { configValue, db, now, type VentureRow } from "../../db.ts";
import * as searxng from "../../providers/searxng.ts";
import { findYtDlp, run as runTool } from "../video/tools.ts";
import { checkSource, SOCIALFEED_PLUGIN } from "./novelty.ts";

/** How long a source has to be to have moments worth cutting out of it, and
 *  how long before it is a livestream nobody should be downloading. Both are
 *  settings; these are the defaults. */
export const DEFAULT_MIN_MINUTES = 3;
export const DEFAULT_MAX_MINUTES = 90;

const num = (key: string, fallback: number, lo: number, hi: number): number => {
  const raw = (configValue(SOCIALFEED_PLUGIN, key) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

export type SourcingSettings = {
  minSeconds: number;
  maxSeconds: number;
  /** How many candidates yt-dlp is asked about. Each is a network round trip
   *  to somebody else's site, so it is small and it is a setting. */
  probe: number;
  /** venture slug or id → the channel or playlist URL that venture's own
   *  videos live on. */
  channels: Record<string, string>;
};

/**
 * The per-venture channel map, parsed out of one multi-line setting.
 *
 * ONE SETTING RATHER THAN A COLUMN ON THE VENTURE, because this is a fact
 * about how this feature is used rather than a fact about the business, and
 * because the alternative is a migration on a table another area owns. The
 * shape is `slug = url`, one per line, `#` comments allowed — the same shape
 * every list setting on this box uses.
 */
export function parseChannels(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(raw ?? "").split(/\n/)) {
    const text = line.split("#")[0]!.trim();
    if (!text) continue;
    const at = text.indexOf("=");
    if (at < 0) continue;
    const key = text.slice(0, at).trim().toLowerCase();
    const url = text.slice(at + 1).trim();
    if (key && /^https?:\/\//i.test(url)) out[key] = url;
  }
  return out;
}

export function settings(): SourcingSettings {
  return {
    minSeconds: num("minMinutes", DEFAULT_MIN_MINUTES, 1, 600) * 60,
    maxSeconds: num("maxMinutes", DEFAULT_MAX_MINUTES, 1, 600) * 60,
    probe: num("probe", 4, 0, 12),
    channels: parseChannels(configValue(SOCIALFEED_PLUGIN, "channels")),
  };
}

export function channelFor(v: Pick<VentureRow, "id" | "slug">, s = settings()): string | null {
  return s.channels[v.slug.toLowerCase()] ?? s.channels[v.id.toLowerCase()] ?? null;
}

/* ------------------------------------------------------------------ parsing */

/**
 * A duration string as an engine wrote it, in seconds.
 *
 * SearXNG passes the engine's own value through unchanged, and the engines do
 * not agree: PeerTube sends a number of seconds, Bing and DuckDuckGo send
 * "40:11" or "1:02:33", and some send nothing at all. Null means the engine
 * did not say — never zero, because a zero-second video is a different claim.
 */
export function parseDuration(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 0 ? Math.round(n) : null;
  }
  const parts = text.split(":").map((p) => Number(p.trim()));
  if (!parts.length || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.length > 3) return null;
  const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
  return seconds > 0 ? Math.round(seconds) : null;
}

/**
 * The video id inside an address, where the host has one.
 *
 * YOUTUBE HAS FOUR SPELLINGS OF ONE VIDEO — watch?v=, youtu.be/, /shorts/ and
 * /embed/ — and the novelty gate compares sources by id precisely so that the
 * same talk cannot come back under a different spelling. A host this does not
 * recognise returns null and is compared by URL instead, which is weaker and
 * is the honest fallback rather than a guess.
 */
export function videoId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname);
    if (m) return m[1]!;
    return null;
  }
  if (host.endsWith("dailymotion.com")) {
    const m = /^\/video\/([^/?#]+)/.exec(u.pathname);
    return m ? m[1]! : null;
  }
  if (host.endsWith("vimeo.com")) {
    const m = /^\/(\d+)/.exec(u.pathname);
    return m ? m[1]! : null;
  }
  return null;
}

/* ------------------------------------------------------------ the search */

export type RawCandidate = {
  url: string;
  title: string;
  author: string | null;
  engine: string | null;
  engines: string[];
  publishedAt: string | null;
  durationS: number | null;
  durationFrom: "searxng" | "yt-dlp" | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * One video search against the node.
 *
 * The transport is written out here rather than borrowed from `ask()` — see
 * the header. It is a GET with `format=json`, the key in a header, and a
 * timeout: a metasearch node that hangs must not hang a pass.
 */
export async function videoSearch(
  query: string,
  opts: { url: string; key: string; timeoutMs?: number },
): Promise<{ ok: true; results: RawCandidate[]; refused: { engine: string; reason: string }[] } | { ok: false; error: string }> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: "videos",
    /* The same reason collect_presence.py sets it: without it the node answers
       in the locale of whatever IP asked. */
    language: "en-US",
  });
  let res: Response;
  try {
    res = await fetch(`${opts.url}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": searxng.USER_AGENT,
        ...(opts.key ? { "x-api-key": opts.key } : {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    });
  } catch (err) {
    return { ok: false, error: searxng.scrub(err instanceof Error ? err.message : String(err), opts.key) };
  }
  if (!res.ok) return { ok: false, error: `The SearXNG node answered HTTP ${res.status}.` };
  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc || !Array.isArray(doc.results))
    return { ok: false, error: "The SearXNG node answered in an unrecognised shape." };

  const results: RawCandidate[] = [];
  for (const raw of doc.results) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const url = str(row.url);
    const title = str(row.title);
    if (!url || !title) continue;
    const engines = Array.isArray(row.engines)
      ? row.engines.filter((e): e is string => typeof e === "string")
      : [];
    const seconds = parseDuration(row.length);
    results.push({
      url,
      title,
      author: str(row.author),
      engine: str(row.engine) ?? engines[0] ?? null,
      engines,
      publishedAt: str(row.publishedDate),
      durationS: seconds,
      durationFrom: seconds === null ? null : "searxng",
    });
  }

  const refused: { engine: string; reason: string }[] = [];
  if (Array.isArray(doc.unresponsive_engines))
    for (const pair of doc.unresponsive_engines)
      if (Array.isArray(pair) && typeof pair[0] === "string")
        refused.push({ engine: pair[0], reason: typeof pair[1] === "string" ? pair[1] : "no reason given" });

  return { ok: true, results, refused };
}

/**
 * The real duration and upload date, from yt-dlp's metadata.
 *
 * `--skip-download --dump-single-json` FETCHES NO VIDEO. That is worth saying
 * plainly because this is the same binary that downloads a whole talk in the
 * shorts pipeline: here it reads the page and prints the metadata, and the
 * flags are what make that true. `--playlist-items 1` stops a channel URL from
 * turning one call into a walk over five hundred videos.
 *
 * A FAILURE IS NOT A REFUSAL. yt-dlp not being installed, a site changing its
 * markup or a video being members-only all end here as `null` with the
 * candidate keeping whatever the engine said — the fallback is weaker
 * evidence, and the row says so with `durationFrom`.
 */
export async function probeDuration(
  url: string,
  signal?: AbortSignal,
): Promise<{ durationS: number | null; uploadedAt: string | null; title: string | null; error: string | null }> {
  const tool = findYtDlp();
  if (!tool.path) return { durationS: null, uploadedAt: null, title: null, error: tool.error ?? "no yt-dlp on this box" };
  const r = await runTool(
    tool.path,
    ["--skip-download", "--no-warnings", "--playlist-items", "1", "--dump-single-json", url],
    { timeoutMs: 45_000, signal },
  );
  if (!r.ok) return { durationS: null, uploadedAt: null, title: null, error: (r.error ?? r.stderr).slice(0, 200) };
  try {
    const doc = JSON.parse(r.stdout) as { duration?: unknown; upload_date?: unknown; title?: unknown };
    const d = typeof doc.duration === "number" && doc.duration > 0 ? Math.round(doc.duration) : null;
    /* yt-dlp writes YYYYMMDD. Turned into an ISO date rather than kept as a
       number, so it sorts and compares with everything else on this box. */
    const raw = typeof doc.upload_date === "string" ? doc.upload_date : "";
    const uploaded = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : null;
    return { durationS: d, uploadedAt: uploaded, title: str(doc.title), error: null };
  } catch {
    return { durationS: null, uploadedAt: null, title: null, error: "yt-dlp printed something that was not JSON" };
  }
}

/* ------------------------------------------------------------ the ranking */

export type Ranked = RawCandidate & {
  sourceId: string | null;
  score: number;
  verdict: "eligible" | "refused";
  reason: string | null;
};

/**
 * Rank and refuse, deterministically.
 *
 * PURE, AND TESTED AS SUCH. Nothing here reads the database or the clock
 * except through `now` and `used`, both handed in — which is what lets the
 * test assert that a video ten seconds long is refused for being ten seconds
 * long and not for some other reason that happened to fire first.
 *
 * THE ORDER OF THE REFUSALS IS PART OF THE ANSWER. A candidate is refused for
 * the FIRST reason that applies, and they are checked cheapest-first: not a
 * usable address, then already used, then outside the duration band. Somebody
 * reading "already used" wants to know that before they read "and also too
 * short".
 *
 * THE SCORE IS THREE TERMS AND EACH IS BOUNDED. Duration fit (a video in the
 * middle of the band beats one at its edge), recency (only where a date was
 * actually published — a video with no date is not penalised, because that is
 * a fact about the engine and not about the video), and engine agreement (a
 * link three engines returned is stronger evidence than one link from one).
 */
export function rank(
  candidates: RawCandidate[],
  opts: { minSeconds: number; maxSeconds: number; used: Set<string>; at?: Date },
): Ranked[] {
  const at = (opts.at ?? new Date()).getTime();
  const mid = (opts.minSeconds + opts.maxSeconds) / 2;
  const half = Math.max(1, (opts.maxSeconds - opts.minSeconds) / 2);

  const out: Ranked[] = candidates.map((c) => {
    const sourceId = videoId(c.url);
    const key = sourceId ?? c.url;

    if (!/^https?:\/\//i.test(c.url))
      return { ...c, sourceId, score: 0, verdict: "refused" as const, reason: "not an http(s) address" };
    if (opts.used.has(key))
      return {
        ...c,
        sourceId,
        score: 0,
        verdict: "refused" as const,
        reason: "already used — a second short out of the same footage is the same footage",
      };
    if (c.durationS !== null && c.durationS < opts.minSeconds)
      return {
        ...c,
        sourceId,
        score: 0,
        verdict: "refused" as const,
        reason: `${Math.round(c.durationS / 60)} min is under the ${Math.round(opts.minSeconds / 60)} min floor — too short to have moments in it`,
      };
    if (c.durationS !== null && c.durationS > opts.maxSeconds)
      return {
        ...c,
        sourceId,
        score: 0,
        verdict: "refused" as const,
        reason: `${Math.round(c.durationS / 60)} min is over the ${Math.round(opts.maxSeconds / 60)} min ceiling — that is a download nobody is watching happen`,
      };

    /* 1.0 at the middle of the band, falling to 0 at either edge. A video with
       no measured duration scores 0.5: unknown is not "bad", and treating it
       as zero would systematically prefer the engines that publish a length. */
    const fit =
      c.durationS === null ? 0.5 : Math.max(0, 1 - Math.abs(c.durationS - mid) / half);

    /* Recency over two years, and ONLY where a date exists. Most engines send
       none; scoring a missing date as old would rank every Bing result last
       for a fact about Bing. */
    let recency = 0.5;
    if (c.publishedAt) {
      const when = Date.parse(c.publishedAt);
      if (Number.isFinite(when)) {
        const ageDays = Math.max(0, (at - when) / 86_400_000);
        recency = Math.max(0, 1 - ageDays / 730);
      }
    }

    const agreement = Math.min(1, Math.max(1, c.engines.length) / 3);

    return {
      ...c,
      sourceId,
      score: Number((0.45 * fit + 0.35 * recency + 0.2 * agreement).toFixed(4)),
      verdict: "eligible" as const,
      reason: null,
    };
  });

  /* Eligible first, then by score. Refused rows are KEPT and returned so the
     page can draw why — a discovery that returned only its winner would answer
     "why not that one" with nothing. */
  return out.sort((a, b) => {
    if (a.verdict !== b.verdict) return a.verdict === "eligible" ? -1 : 1;
    return b.score - a.score;
  });
}

/* --------------------------------------------------------------- the pass */

export type CandidateRow = {
  id: string;
  venture_id: string;
  format: string;
  query: string;
  url: string;
  source_id: string | null;
  title: string | null;
  author: string | null;
  engine: string | null;
  published_at: string | null;
  duration_s: number | null;
  duration_from: string | null;
  score: number | null;
  rank: number | null;
  verdict: string;
  reason: string | null;
  ts: string;
};

export function candidateRows(opts: { ventureId?: string | null; limit?: number }): CandidateRow[] {
  const args: (string | number)[] = [];
  let where = "";
  if (opts.ventureId) {
    where = "WHERE venture_id = ?";
    args.push(opts.ventureId);
  }
  args.push(Math.max(1, Math.min(300, Math.floor(opts.limit ?? 60))));
  return db
    .prepare(`SELECT * FROM source_candidates ${where} ORDER BY ts DESC, rank ASC LIMIT ?`)
    .all(...args) as unknown as CandidateRow[];
}

export type Discovery = {
  ok: boolean;
  query: string;
  /** The venture's own channel, when a setting names one and it was searched
   *  as well. Null when no setting names one. */
  channel: string | null;
  candidates: Ranked[];
  /** The one a run would be dispatched with, or null with `why`. */
  chosen: Ranked | null;
  why: string;
  /** Engines the node could not reach. Reported even on a successful search,
   *  because a metasearch node down to one engine still answers ten links. */
  enginesRefused: { engine: string; reason: string }[];
  error: string | null;
};

/**
 * Find something to cut up, for one venture.
 *
 * THE QUERY IS ABOUT THE PROBLEM AND NOT ABOUT THE PRODUCT, which is the one
 * judgement in this file and it carries over from the system this replaces:
 * nobody has filmed this business, so searching for its name finds nothing
 * worth cutting. The topic the autopilot derived is the subject, and the
 * venture's own words are what narrow it.
 *
 * THE VENTURE'S OWN CHANNEL IS SEARCHED FIRST WHERE ONE IS NAMED, because a
 * business that publishes its own long videos should be cut from those before
 * it is cut from a stranger's. It is a per-venture setting and there is no
 * default: with none named, this is one search instead of two.
 */
export async function discover(
  venture: VentureRow,
  topic: string,
  opts: { signal?: AbortSignal; probe?: number } = {},
): Promise<Discovery> {
  const s = settings();
  const cred = searxng.borrowKey("socialfeed_sourcing");
  const channel = channelFor(venture, s);
  const query = [topic.trim(), venture.name].filter(Boolean).join(" ").slice(0, 160);

  if (!cred)
    return {
      ok: false,
      query,
      channel,
      candidates: [],
      chosen: null,
      why: "There is nowhere to search.",
      enginesRefused: [],
      error:
        "SearXNG is not connected, so no source can be found. Connect it under Integrations → SearXNG; " +
        "there is no other search on this box and nothing here invents a URL.",
    };

  const found = await videoSearch(query, { url: cred.url, key: cred.key });
  if (!found.ok)
    return { ok: false, query, channel, candidates: [], chosen: null, why: "The search failed.", enginesRefused: [], error: found.error };

  let raw = found.results;
  /* The venture's own channel, searched as a second query restricted to that
     host. Its results go FIRST in the list handed to `rank`, which does not
     itself know about channels — ordering is the caller's opinion and the
     ranking is arithmetic. */
  if (channel) {
    let host: string | null = null;
    try {
      host = new URL(channel).hostname.replace(/^www\./, "");
    } catch {
      host = null;
    }
    if (host) {
      const own = await videoSearch(`site:${host} ${topic}`.slice(0, 160), { url: cred.url, key: cred.key });
      if (own.ok) raw = [...own.results, ...raw];
    }
  }

  /* De-duplicated by id where there is one, by URL where there is not — the
     same key the novelty gate uses, so a video cannot be both "new" here and
     "used" there. */
  const seen = new Set<string>();
  const unique: RawCandidate[] = [];
  for (const c of raw) {
    const key = videoId(c.url) ?? c.url;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  const usedRows = db
    .prepare("SELECT source_id, source_url FROM content_history WHERE source_id IS NOT NULL OR source_url IS NOT NULL")
    .all() as unknown as { source_id: string | null; source_url: string | null }[];
  const used = new Set<string>();
  for (const r of usedRows) {
    if (r.source_id) used.add(r.source_id);
    else if (r.source_url) used.add(r.source_url);
  }

  let ranked = rank(unique, { minSeconds: s.minSeconds, maxSeconds: s.maxSeconds, used });

  /* THE METADATA PROBE, on the top few only. Every one of these is a request
     to somebody else's site, so the number is a setting and the default is
     four. A probe that comes back with a real duration REPLACES the engine's
     guess and the list is ranked again — which can, and should, change the
     winner: a "12:00" that is really 45 seconds must not be chosen. */
    const probeN = Math.min(opts.probe ?? s.probe, ranked.length);
  if (probeN > 0) {
    const eligible = ranked.filter((c) => c.verdict === "eligible").slice(0, probeN);
    for (const c of eligible) {
      const m = await probeDuration(c.url, opts.signal);
      const target = unique.find((u) => u.url === c.url);
      if (!target) continue;
      if (m.durationS !== null) {
        target.durationS = m.durationS;
        target.durationFrom = "yt-dlp";
      }
      if (m.uploadedAt) target.publishedAt = m.uploadedAt;
    }
    ranked = rank(unique, { minSeconds: s.minSeconds, maxSeconds: s.maxSeconds, used });
  }

  const ts = now();
  db.prepare("DELETE FROM source_candidates WHERE venture_id = ? AND format = 'shorts'").run(venture.id);
  const insert = db.prepare(
    `INSERT INTO source_candidates
       (id, venture_id, format, query, url, source_id, title, author, engine, published_at,
        duration_s, duration_from, score, rank, verdict, reason, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  ranked.forEach((c, i) => {
    insert.run(
      `sc-${randomUUID().slice(0, 8)}`,
      venture.id,
      "shorts",
      query,
      c.url,
      c.sourceId,
      c.title.slice(0, 300),
      c.author,
      c.engine,
      c.publishedAt,
      c.durationS,
      c.durationFrom,
      c.score,
      i + 1,
      c.verdict,
      c.reason,
      ts,
    );
  });

  const chosen = ranked.find((c) => c.verdict === "eligible") ?? null;
  return {
    ok: true,
    query,
    channel,
    candidates: ranked,
    chosen,
    why: chosen
      ? `${ranked.filter((c) => c.verdict === "eligible").length} of ${ranked.length} results were usable; the top one was chosen.`
      : ranked.length
        ? `All ${ranked.length} results were refused — see the reason on each.`
        : "The search returned nothing at all.",
    enginesRefused: found.refused,
    error: null,
  };
}

/**
 * Discovery plus the novelty gate, which is what a caller about to queue a
 * shorts run wants. The gate is consulted for the CHOSEN candidate as well,
 * even though `rank` has already excluded used sources: the ranking's
 * exclusion is a filter and the gate is the record, and the record is what a
 * person reads when they ask why nothing was made.
 */
export async function findSource(
  venture: VentureRow,
  topic: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ url: string; candidate: Ranked } | { error: string; discovery: Discovery }> {
  const d = await discover(venture, topic, opts);
  if (!d.ok || !d.chosen) return { error: d.error ?? d.why, discovery: d };
  const verdict = checkSource(venture.id, d.chosen.sourceId, d.chosen.url);
  if (!verdict.ok) return { error: verdict.reason, discovery: d };
  return { url: d.chosen.url, candidate: d.chosen };
}
