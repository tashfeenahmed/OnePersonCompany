import { call } from "@/lib/api";

/**
 * THE VIDEO AREA, FROM THIS SIDE — two documents and two file routes.
 *
 * A VIDEO IS ADDRESSED BY ITS RUN ID, and that is not an accident of the
 * schema: the run IS the job. Everything about when it started, what it did
 * while it worked and whether it finished is on `/api/runs/:id`; what is here
 * is the ARTEFACT — the script, the credits, the file — which the run row has
 * no column for. So the Video app fetches both, and neither one duplicates the
 * other.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. `durationS: null` is
 * a file ffprobe could not read, never a zero-length video; `onDisk: false` is
 * a row that outlived its file; `captions: "none"` is a video with no words on
 * it and not a video whose captions were not recorded. Each of those is drawn
 * as what it is.
 *
 * THE FILE URLS ARE SERVER-COMPOSED AND ARE NOT BUILT HERE. `file` on a job
 * and on a clip is already the path to fetch, or null when there is nothing to
 * fetch — a client that guessed `/api/video/${id}/file` would offer a player
 * for a shorts job, which has no single file, and get a 404 with a paragraph
 * in it.
 */

/** One piece of stock footage, and the credit that goes with it. This is not
 *  metadata: the Pexels licence asks for the photographer to be named, and
 *  this is the only place their name exists. */
export type VideoAsset = {
  library: string;
  id: number;
  page: string;
  author: string;
  authorUrl: string;
  licence: string;
  file: string;
  width: number;
  height: number;
  /** The whole clip's length as the library reports it, not the length used. */
  duration: number;
  /** The search term that found it. */
  term: string;
  bytes: number;
};

export type VideoBeat = {
  role: "hook" | "beat" | "cta";
  caption: string;
  voiceover: string;
  terms: string[];
  seconds: number;
};

/** The shape a faceless job's `script` takes. A shorts job's is a different
 *  object — the source URL, its title, and the windows — so both are read
 *  defensively rather than typed as one thing that is two things. */
export type FacelessScript = {
  title?: string;
  beats?: VideoBeat[];
  brief?: string;
};

export type ShortsScript = {
  source?: string;
  title?: string;
  sourceSeconds?: number;
  chosenBy?: string;
  windows?: { title: string; reason: string; start: number; end: number }[];
};

export type VideoClip = {
  runId: string;
  index: number;
  title: string;
  /** The model's sentence for choosing this window. Not a score, and null on
   *  a clip that was cut rather than chosen. */
  reason: string | null;
  /** `transcript` — chosen from timed subtitles. `speech` — chosen from a
   *  transcription with no timestamps. `spacing` — NOT chosen at all; the
   *  video was cut at even intervals. The page must never draw the third as
   *  though it were the first. */
  chosenBy: string;
  startS: number;
  endS: number;
  durationS: number | null;
  bytes: number | null;
  captions: string | null;
  file: string | null;
  onDisk: boolean;
};

export type VideoJob = {
  runId: string;
  ventureId: string | null;
  ventureName: string | null;
  format: string;
  ts: string;
  aspect: string;
  width: number | null;
  height: number | null;
  script?: FacelessScript & ShortsScript;
  assets: VideoAsset[];
  durationS: number | null;
  bytes: number | null;
  /** Which machine drew the words: `typst`, `drawtext`, or `none`. */
  captions: string | null;
  /** `tts` or `none`. `none` is the ordinary case — speech is off by default
   *  and nothing copyrighted is bundled. */
  narration: string | null;
  transcript: string | null;
  error: string | null;
  file: string | null;
  onDisk: boolean;
  clips: VideoClip[];
};

export type VideoCapability = { ready: boolean; note: string };

export type VideoReadiness = {
  encoder: VideoCapability & { ffmpeg: string | null; ffprobe: string | null };
  script: VideoCapability & { provider: string | null };
  footage: VideoCapability;
  captions: VideoCapability & { renderer: string };
  narration: VideoCapability & { mode: string };
  shorts: VideoCapability & { ytdlp: string | null; transcription: string | null };
  formats: { key: string; about: string }[];
  aspects: { key: string; width: number; height: number; about: string }[];
  note: string;
};

export type VideoList = {
  venture: { id: string; slug: string; name: string } | null;
  videos: (VideoJob & { clipCount: number })[];
  readiness: VideoReadiness;
};

export const videoApi = {
  list: (venture?: string | null) =>
    call<VideoList>(`/video${venture ? `?venture=${encodeURIComponent(venture)}` : ""}`),
  get: (runId: string) => call<VideoJob>(`/video/${encodeURIComponent(runId)}`),
};

/* ------------------------------------------------------------- autopilot */

export type AutopilotSchedule = {
  enabled: boolean;
  /** Per venture, over a ROLLING seven days — not a calendar week. */
  postsPerVenturePerWeek: number;
  videosPerVenturePerWeek: number;
  hour: number;
  timezone: string;
  quietStages: string[];
  formats: string[];
  dailyCap: number;
};

export type AutopilotVenture = {
  id: string;
  slug: string;
  name: string;
  stage: string;
  quiet: boolean;
  posts: { made: number; cadence: number; due: boolean };
  videos: { made: number; cadence: number; due: boolean };
};

export type AutopilotEntry = {
  id: number;
  ts: string;
  passId: string;
  ventureId: string | null;
  ventureName: string | null;
  kind: string;
  /** `queued` is work that now exists, `skipped` is a rule being obeyed,
   *  `failed` is something breaking. Three words and the page keeps them
   *  apart — a correctly quiet week is not an outage. */
  action: string;
  ref: string | null;
  note: string | null;
};

export type AutopilotDoc = {
  schedule: AutopilotSchedule;
  now: { local: { day: string; hour: number }; queued: number; running: string | null };
  /** Null means it is switched OFF, not that the next run is unknown. */
  nextRunAt: string | null;
  ready: { model: string | null; note: string };
  ventures: AutopilotVenture[];
  log: AutopilotEntry[];
  note: string;
};

export type PassResult = {
  passId: string;
  trigger: string;
  at: string;
  ran: boolean;
  why: string;
  queued: { post: number; video: number };
  entries: { ventureId: string | null; ventureName: string | null; kind: string; action: string; ref: string | null; note: string | null }[];
  note: string;
};

export const autopilotApi = {
  read: () => call<AutopilotDoc>("/autopilot"),
  runNow: () => call<PassResult>("/autopilot/now", { method: "POST" }),
};
