/**
 * The video area's two skill entries.
 *
 * Types only from skills/registry.ts — importing it at value level would put
 * the registry inside the seam's own import graph, and its header says why
 * that must not happen.
 *
 * `video` HAS NO ACTIONS AND `autopilot` HAS ONE. Starting a video is already
 * published: it is a run, and the `runs` skill's `start` action takes a kind.
 * A second door onto the same thing would be a second set of parameter
 * descriptions to keep in step with the kind's own inputs. What `autopilot`
 * adds is a thing that has no other door — running the scheduled pass now —
 * and it is not marked destructive because it is not: it queues work that can
 * be cancelled, and it obeys every limit the clock does.
 *
 * BOTH ENTRIES ARE ALWAYS LIVE (`plugins: []`), which is deliberate and is the
 * honest reading of an ANY-OF list. A faceless video needs Pexels; a shorts
 * job needs yt-dlp and no credential at all; the autopilot needs neither.
 * Gating the pair on `pexels` would take the shorts half and the whole
 * autopilot dark because one key was removed. What each half needs is
 * reported, per capability, by `GET /api/video` — which is a document the
 * agent can read rather than an absence it has to guess at.
 */
import type { Skill } from "../../skills/registry.ts";

export const SKILLS: Skill[] = [
  {
    id: "video",
    title: "Video — what this box has made, and what it can",
    plugins: [],
    about:
      "Vertical videos made on this machine, in two shapes. `faceless` is a " +
      "script written from a venture record, stock footage from Pexels for " +
      "each beat, captions burned in with the venture's own colour and font, " +
      "and an end card. `shorts` is a long video downloaded with yt-dlp and " +
      "cut into two to four vertical clips. Every job carries its script, the " +
      "footage manifest with the photographer of each clip, the duration and " +
      "size read off the finished file, and which machine drew the captions. " +
      "The readiness block on the default view says which of the five things a " +
      "video needs — an encoder, a model, Pexels, a caption renderer, a " +
      "speech endpoint — this box actually has.",
    rules: [
      "NOTHING HERE IS PUBLISHED ANYWHERE. A finished video is a file on its " +
        "run page. There is no credential for any video or social platform in " +
        "this vault and no route on this server that would upload one, so never " +
        "tell the owner that something has been posted, scheduled to post, or " +
        "sent. Say where the file is.",
      "THE FOOTAGE MANIFEST IS A CREDIT AND NOT METADATA. Every clip in a " +
        "faceless video is somebody's work under the Pexels licence, which asks " +
        "for the photographer to be named. When you describe a video, carry the " +
        "authors with it — a video described without its credits is one that is " +
        "easy to publish without them.",
      "`captions` NAMES THE MACHINE THAT DREW THE WORDS. `typst` is typeset " +
        "cards composited onto the frames; `drawtext` is ffmpeg's own text " +
        "filter with lines wrapped by character count rather than measured " +
        "width; `none` means this box could do neither and the video has NO " +
        "words on it. Never describe a `none` video as captioned.",
      "`narration` IS `tts` OR `none` AND `none` IS THE ORDINARY CASE. Speech " +
        "is off by default in the voice plugin, and nothing copyrighted is " +
        "bundled with this dashboard, so a video made here is usually SILENT. " +
        "That is not a fault and it is not a missing file.",
      "ON A SHORTS JOB, `chosenBy` DECIDES WHAT THE CLIPS ARE. `transcript` " +
        "means the windows were chosen from the site's own timed subtitles. " +
        "`speech` means from a transcription with no timestamps, which is " +
        "weaker. `spacing` means THERE WAS NO TRANSCRIPT AT ALL and the video " +
        "was cut at even intervals — those are cuts, not highlights, and " +
        "presenting them as chosen moments is the one thing this document " +
        "exists to prevent.",
      "`durationS` and `bytes` are read off the finished file with ffprobe. " +
        "Null means the file could not be probed, which is not a zero-length " +
        "video. `onDisk: false` means the row outlived its file.",
      "There is no view count, no watch time and no engagement here, and there " +
        "never will be: nothing on this box publishes a video, so nothing on " +
        "this box can measure how one performed.",
    ],
    views: [
      {
        key: "default",
        path: "/api/video",
        about:
          "Every video this box has made, newest first, with its script, its footage credits and its file — plus a readiness block saying what a new one would need.",
        params: [
          {
            name: "venture",
            type: "string",
            required: false,
            about: "A venture's id or slug. Absent lists every venture's videos.",
          },
          {
            name: "format",
            type: "string",
            required: false,
            about: "`faceless` or `shorts`. Absent lists both.",
          },
          {
            name: "limit",
            type: "number",
            required: false,
            fallback: 50,
            about: "How many jobs to return. Clamped to 1–200.",
          },
        ],
      },
      {
        key: "one",
        path: "/api/video/:runId",
        about:
          "One job in full: the script beat by beat, every clip's photographer and licence, and — for a shorts job — every cut with the window it came from and why.",
        params: [
          {
            name: "runId",
            type: "string",
            required: true,
            in: "path",
            about: "The run that made it. A video is addressed by its run id, because the run IS the job.",
          },
        ],
      },
    ],
    asks: [
      "What videos have been made for this venture, and who do I have to credit?",
      "Did that shorts job actually choose its clips, or did it just cut at intervals?",
    ],
  },

  {
    id: "autopilot",
    title: "Autopilot — the daily pass that queues posts and videos",
    plugins: [],
    about:
      "A once-a-day pass, at an hour the owner set, that queues Studio posts " +
      "and video runs for each venture up to a cadence set per venture per " +
      "week. It reports the schedule as it resolves, the next instant it will " +
      "wake, how much of each venture's cadence has been used in the last " +
      "seven days, and a log of every decision it has taken — including the " +
      "decisions to do nothing, which are most of them.",
    rules: [
      "IT QUEUES WORK AND IT NEVER POSTS ANYTHING ANYWHERE. What a pass " +
        "produces is a post in the Studio gallery and a video on its run page, " +
        "for the owner to use. Nothing is sent, uploaded, scheduled to publish " +
        "or shared, because there is no credential and no route on this box " +
        "that could. Never tell the owner their content went out.",
      "`made` IS WHAT THE AUTOPILOT ITSELF QUEUED, over a ROLLING SEVEN DAYS " +
        "and not a calendar week. A post the owner made by hand in the Studio " +
        "is not counted and does not use up the cadence.",
      "A `skipped` ROW IS A RULE BEING OBEYED AND IS NOT A FAILURE. A quiet " +
        "stage, a cadence already met, a day's cap already spent and a busy run " +
        "queue are the four, and each says which. `failed` is the only action " +
        "that means something broke.",
      "`nextRunAt: null` MEANS IT IS SWITCHED OFF, not that the next run is " +
        "unknown. Both cadences at zero means it is on and will queue nothing, " +
        "which is a different state again and the document says so.",
      "Running a pass now obeys exactly the same brakes as the scheduled one. " +
        "It is not a way to get round the cadence or the cap, and a pass that " +
        "queues nothing because everything is up to date has succeeded.",
      "A pass spends the owner's money — a Studio post calls Replicate, a " +
        "faceless video spends Pexels quota and minutes of this laptop's CPU. " +
        "Say so before you run one on somebody's behalf.",
    ],
    views: [
      {
        key: "default",
        path: "/api/autopilot",
        about:
          "The schedule, the next run, each venture's cadence and how much of it is used, and the log of every decision.",
        params: [],
      },
    ],
    actions: [
      {
        key: "run_now",
        method: "POST",
        path: "/api/autopilot/now",
        about:
          "Run the daily pass immediately. Obeys the cadence, the day's cap and the run queue exactly as the scheduled pass does, and answers with what it queued and what it skipped and why.",
        params: [],
      },
    ],
    asks: [
      "Is the autopilot on, and what is it going to make tomorrow?",
      "Why has nothing been queued for this venture this week?",
    ],
  },
];

/** Where these land in Hermes' skill directory. Both under media: one is what
 *  was made and the other is what schedules the making. */
export const PACKS: Record<string, { name: string; category: string }> = {
  video: { name: "video-producer", category: "media" },
  autopilot: { name: "studio-autopilot", category: "media" },
};
