/**
 * FINDING A SOURCE TO CUT UP, WITHOUT A KEY AND WITHOUT DOWNLOADING ANYTHING.
 *
 * The shorts pipeline has always taken a URL, which quietly assumed the owner
 * had already been to YouTube, searched there, and copied an address back. The
 * search that produced that address is the interesting half of the decision —
 * a wall of twenty candidates with their lengths on them is where "which video
 * is worth cutting" is actually answered — and it was happening in a different
 * tab, where this box could not see it and could not offer it.
 *
 * yt-dlp IS THE SEARCH ENGINE HERE, NOT THE DATA API. `ytsearchN:` is a query
 * yt-dlp already knows how to run, so there is NO API key to hold, no quota to
 * exhaust and nothing new in the vault — which matters because the one binary
 * this needs is the same one the shorts format already needs. A box that can
 * cut a short can search for one, and a box that cannot says so once.
 *
 * `--flat-playlist` IS WHAT MAKES IT A SEARCH BOX AND NOT A JOB. Without it
 * yt-dlp fetches a full metadata page PER RESULT, which is twelve round trips
 * and the better part of a minute; with it the whole answer is one request and
 * comes back in a couple of seconds. The cost is that some fields are simply
 * absent — an upload date usually, a view count sometimes — and every one of
 * those is reported as null rather than guessed at, because a made-up view
 * count would be read as a real one.
 *
 * NOTHING IS DOWNLOADED AND NOTHING IS SPENT. This route reads metadata; the
 * page previews a result with YouTube's own embedded player in the owner's
 * browser. The first byte of video only ever moves when a shorts RUN is
 * started, which is a different button on a different queue.
 *
 * THE ID IS VALIDATED HERE AND THAT IS A SAFETY PROPERTY, not tidiness. The id
 * that comes back is composed into a watch URL that becomes a run's input, and
 * into an embed URL the page loads in an iframe. Accepting only YouTube's own
 * eleven-character alphabet means neither of those can be turned into a
 * different address by something the search returned.
 */
import { configValue } from "../../db.ts";
import { readExtraArgs } from "./shorts.ts";
import { findYtDlp, run, VIDEO_PLUGIN } from "./tools.ts";

/** One candidate source. Every field that yt-dlp may not know is nullable and
 *  is null when it did not know it — see the note about `--flat-playlist`. */
export type YoutubeHit = {
  id: string;
  /** Composed here rather than on the page, because this is the string that
   *  becomes a shorts run's `url` input and there should be one speller of
   *  it. */
  url: string;
  title: string;
  channel: string | null;
  durationS: number | null;
  viewCount: number | null;
  thumbnail: string;
  /** `YYYY-MM-DD`, and usually null: a flat search rarely carries it. */
  uploadDate: string | null;
};

export type YoutubeSearchResult =
  | { ok: true; hits: YoutubeHit[] }
  | { ok: false; status: 400 | 502 | 503; error: string };

/** The most and fewest results worth asking for. Under five is not a wall to
 *  choose from and over thirty is a slower query for a page nobody scrolls. */
export const MIN_RESULTS = 5;
export const MAX_RESULTS = 30;
const MAX_QUERY = 200;

export const clampCount = (raw: string | null | undefined, fallback = 12): number => {
  const text = (raw ?? "").trim();
  /* AN ABSENT `n` IS THE DEFAULT AND NOT THE FLOOR. `Number("")` is zero and
     zero is finite, so a check that only asked whether the number was finite
     would turn "the caller did not say" into "the caller asked for five". */
  if (!text) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_RESULTS, Math.min(MAX_RESULTS, Math.round(n)));
};

/** YouTube's own id alphabet. Anything else is not addressed here. */
const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * One line of yt-dlp's `--dump-json`, read defensively.
 *
 * Exported for the test: this is a parser over something a website produced,
 * which is the only kind of thing this area's tests cover.
 */
export function readHit(line: string): YoutubeHit | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const id = typeof v.id === "string" ? v.id : "";
  if (!ID.test(id)) return null;

  const num = (x: unknown): number | null =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.round(x) : null;
  const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);

  /* The thumbnail is COMPOSED from the id rather than taken from the entry.
     A flat search's `thumbnails` array carries whatever CDN URL YouTube felt
     like that minute, sometimes with an expiring signature on it; the
     `i.ytimg.com/vi/<id>` form is stable, unsigned, and the one the page can
     still draw ten minutes later. */
  const date = str(v.upload_date);
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: str(v.title) ?? "(untitled)",
    channel: str(v.channel) ?? str(v.uploader) ?? null,
    durationS: num(v.duration),
    viewCount: num(v.view_count),
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    uploadDate: date && /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null,
  };
}

/**
 * Ask yt-dlp for candidates.
 *
 * THE QUERY IS AN ARGUMENT AND NEVER A SHELL STRING. `run` is `execFile` with
 * an array, so `ytsearch12:` and whatever was typed after it are one argv
 * entry that no shell ever sees — the same rule tools.ts states for the
 * encoder, and it applies more here because this string came off a form.
 *
 * A NON-ZERO EXIT WITH OUTPUT IS STILL AN ANSWER. yt-dlp reports a failure for
 * the whole query when one entry in it could not be resolved, and throwing
 * away eleven usable results because of the twelfth would be losing the
 * search to a footnote.
 */
export async function searchYoutube(query: string, count: number): Promise<YoutubeSearchResult> {
  const q = query.trim().slice(0, MAX_QUERY);
  if (!q) return { ok: false, status: 400, error: "Say what to search for." };

  const ytdlp = findYtDlp();
  if (!ytdlp.path)
    return {
      ok: false,
      status: 503,
      error:
        (ytdlp.error ?? "There is no yt-dlp on this box") +
        " — it is the same binary the shorts format needs, so searching and cutting are ready or unready together.",
    };

  const n = Math.max(MIN_RESULTS, Math.min(MAX_RESULTS, Math.round(count)));
  const r = await run(
    ytdlp.path,
    [
      "--flat-playlist",
      "--no-warnings",
      "--dump-json",
      "--socket-timeout",
      "15",
      ...readExtraArgs(),
      `ytsearch${n}:${q}`,
    ],
    /* THIRTY SECONDS AND NOT THE DOWNLOADER'S TWO MINUTES. Somebody is
       watching a spinner on a search box; a query that has not answered in
       half a minute has failed whatever yt-dlp thinks it is still doing. */
    { timeoutMs: 30_000 },
  );

  const hits = r.stdout.split("\n").map(readHit).filter((h): h is YoutubeHit => h !== null);
  if (!hits.length && !r.ok)
    return {
      ok: false,
      status: 502,
      error:
        r.error ??
        (r.stderr
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-1)[0]
          ?.slice(0, 300) ??
          "yt-dlp returned nothing and said nothing about why."),
    };
  return { ok: true, hits };
}

/** What the readiness document says about searching. Separate from the
 *  `shorts` capability's note even though both turn on the same binary,
 *  because they fail at different moments: this one at the search box, that
 *  one three minutes into a run. */
export function youtubeReadiness(): { ready: boolean; ytdlp: string | null; note: string } {
  const ytdlp = findYtDlp();
  const extra = (configValue(VIDEO_PLUGIN, "ytdlpArgs") ?? "").trim();
  return {
    ready: !!ytdlp.path,
    ytdlp: ytdlp.path,
    note: ytdlp.path
      ? `GET /api/video/youtube?q=… searches YouTube through yt-dlp's own \`ytsearch\`, with no API key and no quota. ` +
        `It reads metadata only — nothing is downloaded and nothing is spent until a shorts run is started with one of the addresses it returns.` +
        (extra ? ` The extra yt-dlp arguments set under the Video settings are passed to the search too.` : "")
      : (ytdlp.error ?? "no yt-dlp"),
  };
}
