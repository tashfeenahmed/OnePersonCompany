import { Download, Film } from "lucide-react";
import { bytes } from "@/lib/format";
import { useApi } from "@/hooks/useApi";
import { videoApi, type VideoJob } from "@/lib/api/video";

/**
 * THE THING THE RUN MADE, ABOVE THE NOTE ABOUT IT.
 *
 * A video run's markdown is a NOTE — the script, the credits, what could not
 * be done — the way a paper run's is a note about a PDF. So the file comes
 * first and the words come after it, which is the same trade `RunReport` makes
 * for a paper and for the same reason: a page that led with the paragraph
 * would bury the thing the run exists to produce.
 *
 * IT PLAYS INLINE, WITH `preload="metadata"`. The server answers byte ranges,
 * so the player can scrub without downloading the whole file, and metadata-only
 * preload means opening a history of twenty runs does not pull twenty videos
 * down the wire. `controls` and nothing else: no autoplay, because a page that
 * starts making noise is a page somebody closes.
 *
 * THE CREDITS ARE NOT COLLAPSED BEHIND A DISCLOSURE. Every clip in a faceless
 * video is somebody's work under a licence that asks for them to be named, and
 * a credit hidden behind a chevron is a credit that does not get copied out
 * with the video. It is a table, it is open, and it is directly under the
 * player.
 *
 * WHAT IS DRAWN WHEN THERE IS NOTHING TO DRAW. A run still working has no row
 * yet and this renders nothing at all — the steps list above it is already
 * saying what is happening, and a second empty panel saying "no video yet"
 * would be noise. A row whose file has gone says so in a sentence rather than
 * offering a player that will not play.
 */
export function VideoResult({ runId }: { runId: string }) {
  /* Keyed on the run id only. The run page polls the RUN while it moves; this
     document does not change until the run finishes, and re-fetching it every
     1.5 seconds to redraw the same "nothing yet" would be a request a second
     for no picture. The parent remounts this when the run settles. */
  const doc = useApi(() => videoApi.get(runId).catch(() => null), [runId]);
  const job = doc.data;
  if (!job) return null;
  return <VideoPanel job={job} />;
}

/** The six ways a window can come to exist, each in the words that say how
 *  much was actually known. The last three are cuts rather than highlights and
 *  the page must never draw them as though a model had chosen them. */
const CHOSEN_BY: Record<string, string> = {
  transcript: "chosen from the site's own timed subtitles",
  words: "chosen from a transcript timed word by word on this machine",
  speech: "chosen from a transcript with no timestamps",
  density: "found by arithmetic on the word timings — not a judgement about what is interesting",
  scenes: "starts at a real scene change — a clean cut, not a chosen moment",
  spacing: "cut at an even interval — not chosen from content",
};

export function VideoPanel({ job }: { job: VideoJob }) {
  const faceless = job.format === "faceless";
  return (
    <div className="bg-card mb-4 rounded-[10px] border p-3.5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <Film className="size-[15px] shrink-0" strokeWidth={1.8} />
        <span className="text-[13.5px] font-medium tracking-tight">
          {faceless ? (job.script?.title ?? "Faceless video") : `${job.clips.length} clips`}
        </span>
        <span className="text-muted-foreground text-[12px]">
          {job.width && job.height ? `${job.width}×${job.height}` : job.aspect}
          {job.durationS !== null && ` · ${job.durationS.toFixed(1)}s`}
          {job.bytes !== null && ` · ${bytes(job.bytes)}`}
        </span>
      </div>

      {/* ------------------------------------------------------ the player */}
      {job.file && job.onDisk ? (
        <div className="grid gap-2">
          <video
            src={job.file}
            controls
            preload="metadata"
            className="border-line-soft mx-auto max-h-[540px] w-auto rounded-[8px] border bg-black"
          />
          <a
            href={job.file}
            download
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 justify-self-center text-[12px]"
          >
            <Download className="size-[13px]" strokeWidth={1.8} />
            Download the file
          </a>
        </div>
      ) : job.clips.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {job.clips.map((c) => (
            <div key={c.index} className="grid gap-1.5">
              {c.file && c.onDisk ? (
                <video
                  src={c.file}
                  controls
                  preload="metadata"
                  className="border-line-soft max-h-[420px] w-full rounded-[8px] border bg-black"
                />
              ) : (
                <p className="text-muted-foreground text-[12.5px]">
                  Clip {c.index} was written to a file that is no longer on disk.
                </p>
              )}
              <div className="text-[12.5px]">{c.title}</div>
              <div className="text-muted-foreground text-[11.5px]">
                {stamp(c.startS)}–{stamp(c.endS)}
                {c.durationS !== null && ` · ${c.durationS.toFixed(1)}s`}
                {" · "}
                {/* THE HONESTY LINE. `spacing` is not highlight selection and
                    is never drawn as though it were — see the migration. */}
                {CHOSEN_BY[c.chosenBy] ?? "cut at an even interval — not chosen from content"}
              </div>
              {/* HOW THE FRAME WAS CHOSEN, and the fixed case carries its own
                  limitation. A tracked crop and a centre crop are not the same
                  product and a page that drew them identically would be
                  claiming this box followed a subject it never looked for. */}
              {c.framing && (
                <div
                  className={
                    c.framing.mode === "tracked"
                      ? "text-muted-foreground text-[11.5px]"
                      : "text-warn border-line-soft border-l-2 pl-2 text-[11.5px]"
                  }
                >
                  {c.framing.mode === "tracked"
                    ? `Tracked crop — followed measured motion across ${c.framing.samples ?? 0} sampled frames, travelling ${c.framing.driftPx ?? 0}px. Not face detection.`
                    : `Fixed centre crop — anything outside the middle of the source is not in this clip. ${c.framing.note ?? ""}`}
                </div>
              )}
              {c.reason && (
                <div className="text-muted-foreground text-[11.5px] italic">{c.reason}</div>
              )}
              {c.file && (
                <a
                  href={c.file}
                  download
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[11.5px]"
                >
                  <Download className="size-[12px]" strokeWidth={1.8} />
                  Download clip {c.index}
                </a>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-[12.5px]">
          This run wrote no file. {job.error ?? "Its report says which step stopped it."}
        </p>
      )}

      {/* ------------------------------------------------------ the script */}
      {faceless && !!job.script?.beats?.length && (
        <div className="mt-4">
          <div className="text-muted-foreground mb-1.5 text-[11px] tracking-[0.06em] uppercase">
            The script
          </div>
          <div className="flex flex-col gap-2">
            {job.script.beats.map((b, i) => (
              <div key={i} className="border-line-soft flex gap-2.5 border-l-2 pl-2.5">
                <span className="text-muted-foreground w-[74px] shrink-0 text-[11.5px]">
                  {b.role === "hook" ? "Hook" : b.role === "cta" ? "Call to action" : `Beat ${i}`}
                  <br />
                  {b.seconds.toFixed(1)}s
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px]">{b.caption}</span>
                  {b.voiceover !== b.caption && (
                    <span className="text-muted-foreground block text-[12px]">{b.voiceover}</span>
                  )}
                  <span className="text-muted-foreground block text-[11.5px]">
                    searched: {b.terms.join(", ")}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ----------------------------------------------------- the credits */}
      {!!job.assets.length && (
        <div className="mt-4">
          <div className="text-muted-foreground mb-1.5 text-[11px] tracking-[0.06em] uppercase">
            Footage — credit these with the video
          </div>
          <div className="flex flex-col gap-px">
            {job.assets.map((a, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-2 py-0.5 text-[12px]">
                <a
                  href={a.page}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground text-muted-foreground underline decoration-dotted"
                >
                  {a.width}×{a.height}, {a.duration}s
                </a>
                <a
                  href={a.authorUrl || a.page}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground"
                >
                  {a.author}
                </a>
                <span className="text-muted-foreground text-[11.5px]">
                  {a.licence} · found by “{a.term}”
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --------------------------------------------------- what was done */}
      <div className="text-muted-foreground mt-3.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
        <span>
          Captions:{" "}
          {job.captions === "typst"
            ? "typeset and composited"
            : job.captions === "drawtext"
              ? "burned in by ffmpeg"
              : "none — nothing on this box could draw them"}
        </span>
        <span>
          Sound:{" "}
          {job.narration === "tts"
            ? "narrated by the voice endpoint"
            : job.format === "shorts"
              ? "the source's own audio"
              : "silent — speech is off and nothing copyrighted is bundled"}
        </span>
        <span>Nothing has been published anywhere.</span>
      </div>

      {job.error && <p className="text-destructive mt-2 text-[12px]">{job.error}</p>}
    </div>
  );
}

const stamp = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
