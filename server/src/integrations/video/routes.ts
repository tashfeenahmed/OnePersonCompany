/**
 * THE VIDEO ROUTES — what this box can make, what it has made, and the files.
 *
 * THE FILE ROUTES ARE THE ONLY PLACE AN MP4 ON THIS DISK IS SERVED, and they
 * take no path from the caller: the row says where the file is and the id in
 * the URL is a run id. That is the same rule the paper routes keep, and here
 * it is doing more work — a video pipeline writes a dozen intermediate files
 * per run and a route that took a filename would hand out any of them.
 *
 * `Range` IS ANSWERED PROPERLY AND THAT IS NOT OPTIONAL. A `<video>` element
 * seeks by asking for byte ranges; a server that answers every request with
 * the whole file and a 200 gives a player that cannot scrub and, on Safari,
 * often will not play at all. So a range request gets a 206 with the slice it
 * asked for, and everything else gets the file with `Accept-Ranges` on it so
 * the player knows it may ask.
 *
 * THE READINESS DOCUMENT IS THE POINT OF `GET /api/video`. Making a video
 * needs four things this box may not have — an ffmpeg, a Pexels key, a model
 * provider and something that can draw text — and each of them fails at a
 * different minute of a three-minute run. So they are all reported before
 * anybody presses anything, each with the sentence that says what to do about
 * it. A page that offered the button and discovered the missing typesetter at
 * minute two would be wasting the owner's Pexels quota to find out.
 *
 * NOTHING HERE PUBLISHES ANYTHING. There is no upload route, no scheduler that
 * posts, and no credential for any video platform in the vault. A finished
 * video is a file on this page.
 */
import { Hono, type Context } from "hono";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { activeProvider } from "../../models/provider.ts";
import { db, ventureRow } from "../../db.ts";
import { settings as voiceSettings, state as voiceState } from "../signals/voice/provider.ts";
import { ASPECTS } from "./assemble.ts";
import { pickCaptioner } from "./captions.ts";
import { pexelsKey } from "./footage.ts";
import { FORMATS } from "./execute.ts";
import { clipCounts, clipPathsByRun, clipRows, jobRow, jobRows, shapeJob } from "./store.ts";
import { thumbnailSource, thumbnailUrl, videoThumbnail } from "./thumbnails.ts";
import { findFfmpeg, findFfprobe, findYtDlp } from "./tools.ts";
import { clampCount, searchYoutube, youtubeReadiness } from "./youtube.ts";

export const videoRoutes = new Hono();

/* ------------------------------------------------------------- readiness */

async function readiness() {
  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe();
  const ytdlp = findYtDlp();
  const provider = activeProvider();
  const key = pexelsKey("video_readiness");
  const captioner = await pickCaptioner();
  const voice = voiceSettings();
  const speech = voiceState().tts;

  return {
    /* Four capabilities and not one boolean. "Can this box make a video" has
       four different answers depending on which half you mean, and a single
       flag would have to pick one of them to be wrong about. */
    encoder: {
      ready: !!ffmpeg.path,
      ffmpeg: ffmpeg.path,
      ffprobe: ffprobe.path,
      note: ffmpeg.path
        ? `ffmpeg at ${ffmpeg.path}${ffprobe.path ? "" : " — but no ffprobe, so a finished video's length and size cannot be read off it"}.`
        : (ffmpeg.error ?? "no ffmpeg"),
    },
    script: {
      ready: provider !== null,
      provider: provider?.id ?? null,
      note: provider
        ? `Scripts and highlight windows come from ${provider.label}, with no tools and no web access.`
        : "No model provider is live, so nothing can write a script or choose a highlight. Choose one under Integrations → Models.",
    },
    footage: {
      ready: !("error" in key),
      note:
        "error" in key
          ? key.error
          : "Stock footage comes from Pexels. Every clip's photographer is recorded on the run and must be credited with the video.",
    },
    captions: { ready: captioner.id !== "none", renderer: captioner.id, note: captioner.note },
    narration: {
      ready: speech.ready,
      mode: speech.mode,
      note: speech.why ?? `Narration uses ${speech.mode}, model ${speech.model}. ${speech.check?.ok ? "Last speech attempt succeeded." : "Use Test voice in Studio to check the connection."}`,
    },
    shorts: {
      ready: !!ytdlp.path,
      ytdlp: ytdlp.path,
      transcription: voice.sttUrl.trim() ? "the voice plugin's endpoint" : null,
      note: ytdlp.path
        ? `yt-dlp at ${ytdlp.path}. Highlights are chosen from the site's own subtitles where there are any, ` +
          (voice.sttUrl.trim()
            ? "from the voice plugin's transcription of the audio where there are not, "
            : "and there is no transcription endpoint configured to fall back on, ") +
          "and from even spacing where there is neither — which is cutting, not choosing, and every clip row says which it was."
        : (ytdlp.error ?? "no yt-dlp"),
    },
    youtube: youtubeReadiness(),
    formats: FORMATS.map((f) => ({
      key: f,
      about:
        f === "faceless"
          ? "A script written from the venture, stock footage for each beat, captions in the venture's colours, and an end card. Needs Pexels and a model."
          : "A long video downloaded and cut into one to five vertical clips, chosen from what was said in it. Needs yt-dlp and a model.",
    })),
    aspects: Object.entries(ASPECTS).map(([key, a]) => ({ key, width: a.width, height: a.height, about: a.about })),
    note:
      "Nothing here publishes anything. A finished video is a file on its run page — there is no credential for any video platform in this vault and no route that would upload one.",
  };
}

/* ------------------------------------------------------------- the reads */

videoRoutes.get("/", async (c) => {
  const key = c.req.query("venture") ?? null;
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: "No venture by that id or slug." }, 404);
  const format = c.req.query("format") ?? null;
  const limit = Number(c.req.query("limit") ?? 50);

  const rows = jobRows({
    ventureId: v?.id ?? null,
    format,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  const counts = clipCounts();
  const clipPaths = clipPathsByRun(rows.filter((r) => (counts.get(r.run_id) ?? 0) > 0).map((r) => r.run_id));

  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    /* The LIST does not carry clips or the script — a page of fifty videos
       would otherwise ship fifty transcripts to draw a table of dates. Both
       are one request away at /api/video/:runId, which is what the run page
       asks for. */
    videos: rows.map((r) => {
      const source = thumbnailSource([r.path, ...(clipPaths.get(r.run_id) ?? [])]);
      return {
        ...shapeJob(r, []),
        script: undefined,
        clipCount: counts.get(r.run_id) ?? 0,
        onDisk: source !== null,
        thumbnailUrl: thumbnailUrl(r.run_id, source),
      };
    }),
    readiness: await readiness(),
  });
});

/**
 * SEARCH YOUTUBE FOR SOMETHING TO CUT UP.
 *
 * BEFORE `/:runId` AND THAT ORDER IS LOAD BEARING. Hono matches in
 * registration order, so a literal segment declared after a parameter one is
 * never reached — `/youtube` would be read as a run id and answered with the
 * paragraph about there being no video for it.
 *
 * A GET WITH NO SIDE EFFECTS, which is why it is a GET: it downloads nothing,
 * queues nothing and spends nothing. The three failures are told apart on
 * purpose — 400 is an empty query, 503 is a box without yt-dlp, and 502 is
 * yt-dlp answering badly — because only the middle one is something the owner
 * can go and fix.
 */
videoRoutes.get("/youtube", async (c) => {
  const res = await searchYoutube(c.req.query("q") ?? "", clampCount(c.req.query("n")));
  if (!res.ok) return c.json({ error: res.error }, res.status);
  return c.json({
    query: (c.req.query("q") ?? "").trim().slice(0, 200),
    count: res.hits.length,
    results: res.hits,
    note: "Metadata only. Previewing one of these plays it from YouTube in your own browser; cutting one starts a shorts run, which is what actually downloads it.",
  });
});

videoRoutes.get("/:runId", (c) => {
  const row = jobRow(c.req.param("runId"));
  if (!row)
    return c.json(
      {
        error:
          "No video for that run. Either it is not a video run, or it has not finished — the run itself is at /api/runs/" +
          c.req.param("runId") +
          ".",
      },
      404,
    );
  const clips = clipRows(row.run_id);
  const source = thumbnailSource([row.path, ...clips.map((clip) => clip.path)]);
  return c.json({ ...shapeJob(row, clips), onDisk: source !== null, thumbnailUrl: thumbnailUrl(row.run_id, source) });
});

/* -------------------------------------------------------------- the files */

videoRoutes.get("/:runId/thumbnail", async (c) => {
  const row = jobRow(c.req.param("runId"));
  if (!row) return c.notFound();
  const source = thumbnailSource([row.path, ...clipRows(row.run_id).map((clip) => clip.path)]);
  if (!source) return c.notFound();
  const image = await videoThumbnail(source, row.run_id);
  if (!image) return c.notFound();
  return c.body(new Uint8Array(image), 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
});

/**
 * The finished video.
 *
 * FIVE DIFFERENT 404s WITH FIVE DIFFERENT SENTENCES, on the paper route's
 * argument: "there is no video" has several causes and only some of them are
 * the owner's to fix. A run that is still working, a run that failed, a shorts
 * job whose files are its clips rather than one file, and a file that has been
 * deleted from under the row are four different things to say.
 */
videoRoutes.get("/:runId/file", (c) => {
  const runId = c.req.param("runId");
  const row = jobRow(runId);
  if (!row) {
    const run = db.prepare("SELECT kind, status FROM agent_runs WHERE id = ?").get(runId) as
      | { kind: string; status: string }
      | undefined;
    if (!run) return c.json({ error: "No run by that id." }, 404);
    if (run.kind !== "video")
      return c.json({ error: `Only a video run has a video, and this is a ${run.kind} run.` }, 404);
    return c.json(
      {
        error:
          run.status === "done"
            ? "That video run finished without writing a file — read its report for which step stopped it."
            : `That video run is ${run.status}. There is nothing to play yet.`,
      },
      404,
    );
  }
  if (!row.path)
    return c.json(
      {
        error:
          row.format === "shorts"
            ? `A shorts job has no single video — it has its clips, at /api/video/${runId}/clips/1/file and up. GET /api/video/${runId} lists them.`
            : "That job wrote no file.",
      },
      404,
    );
  return sendVideo(c, row.path, `${runId}.mp4`);
});

videoRoutes.get("/:runId/clips/:index/file", (c) => {
  const runId = c.req.param("runId");
  const idx = Number(c.req.param("index"));
  if (!Number.isInteger(idx)) return c.json({ error: "A clip is addressed by its number." }, 400);
  const clip = clipRows(runId).find((r) => r.idx === idx);
  if (!clip) return c.json({ error: `That run has no clip ${idx}. GET /api/video/${runId} lists what it has.` }, 404);
  if (!clip.path) return c.json({ error: `Clip ${idx} was not written.` }, 404);
  return sendVideo(c, clip.path, `${runId}-${idx}.mp4`);
});

/**
 * An mp4, with byte ranges.
 *
 * The whole file is streamed rather than read into memory: a forty-megabyte
 * buffer per request would be forty megabytes of heap for something the OS is
 * already better at. A range request is answered with exactly the slice asked
 * for and a 206; a malformed one is answered with the whole file rather than
 * a 416, because a player that sent nonsense still wants to play.
 */
function sendVideo(c: Context, path: string, filename: string) {
  if (!existsSync(path)) return c.json({ error: `The video was written to ${path} and is not there now.` }, 404);
  const size = statSync(path).size;
  const range = c.req.header("range");
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    /* INLINE. The page plays it; the download link on the page is the same
       URL with the browser's own "save" behind it. */
    "Content-Disposition": `inline; filename="${filename}"`,
  };

  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= 0 && start <= end && end < size) {
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      headers["Content-Length"] = String(end - start + 1);
      return c.body(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, 206, headers);
    }
  }
  headers["Content-Length"] = String(size);
  return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, headers);
}
