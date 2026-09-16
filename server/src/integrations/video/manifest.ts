/**
 * VIDEO — making one, and deciding when to.
 *
 * TWO CONFIG-ONLY PLUGINS AND NO CREDENTIAL, which is unusual here and is the
 * right shape for what this does. Everything a video needs a key for is
 * already keyed somewhere else: stock footage is the `pexels` plugin's key,
 * the script is the chosen model provider's, narration and transcription are
 * the `voice` plugin's. A third copy of any of them would be a second place to
 * revoke and a second place to be out of date. What this area owns is
 * DECISIONS — where the binaries are, how long a source may be, when the
 * autopilot wakes and how much it may do — and those are settings.
 *
 * `video` HOLDS THE MACHINE FACTS and `autopilot` HOLDS THE POLICY. They are
 * two plugin pages rather than one because they are read at different moments
 * by different people: the first is opened once, when something is not found;
 * the second is the one somebody comes back to.
 *
 * NO COLLECTOR. Nothing here is a measurement on a schedule — a video is made
 * when it is asked for, and the one number worth watching about the stock
 * library (the monthly quota) is already collected by the stock plugin that
 * owns the key. A collector here would spend that quota to report on itself.
 *
 * THE ONE TIMER IS THE AUTOPILOT'S, and it arms nothing on its own: it wakes
 * every ten minutes and does nothing at all until the owner has switched the
 * setting on and set a cadence above zero.
 */
import type { IntegrationManifest } from "../manifest.ts";
import { upsertPlugin } from "../../db.ts";
import { videoRoutes } from "./routes.ts";
import { autopilotRoutes } from "./autopilot-routes.ts";
import {
  AUTOPILOT_PLUGIN,
  AUTOPILOT_FORMATS,
  DEFAULT_CAP,
  DEFAULT_HOUR,
  DEFAULT_QUIET,
  localZone,
  startAutopilot,
  validZone,
} from "./autopilot.ts";
import { VIDEO_PLUGIN } from "./tools.ts";

import { SKILLS, PACKS } from "./skills.ts";

const path = (value: string): string | null => {
  if (!value.trim()) return null;
  if (!value.trim().startsWith("/"))
    return "An absolute path, please — a relative one would mean something different depending on where the server was started from.";
  return null;
};

const whole = (value: string, lo: number, hi: number, what: string): string | null => {
  if (!value.trim()) return null;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < lo || n > hi) return `${what}, between ${lo} and ${hi}.`;
  return null;
};

export const manifest: IntegrationManifest = {
  id: "video",

  config: {
    /*
      WHERE THE BINARIES ARE, AND WHAT MAY BE ASKED OF THEM. Every one of these
      is blank by default and blank means "probe for it" — the paths differ
      between a Mac with Homebrew and a Linux box with apt, and a constant here
      would be a feature that works on the machine it was written on.
    */
    [VIDEO_PLUGIN]: {
      keys: {
        ffmpeg: {
          label: "ffmpeg",
          hint:
            "Blank probes /opt/homebrew/bin, /usr/local/bin, /usr/bin, /bin, " +
            "/snap/bin and then PATH. Set it only if the one you want is " +
            "somewhere else — a path here that is not there is a hard failure " +
            "rather than a fall-back to the probe, because you said where it is.",
          ph: "/opt/homebrew/bin/ffmpeg",
          check: (v) => path(v),
        },
        ffprobe: {
          label: "ffprobe",
          hint:
            "The same, for the tool that reads a finished file's length and " +
            "size. It ships with ffmpeg. Without it a video is still made and " +
            "its duration is recorded as null rather than guessed.",
          ph: "/opt/homebrew/bin/ffprobe",
          check: (v) => path(v),
        },
        ytdlp: {
          label: "yt-dlp",
          hint:
            "Needed only for the shorts format, which downloads a long video " +
            "and cuts it up. Use a current yt-dlp release with its EJS scripts. " +
            "OPC enables its Node runtime and official EJS solver for YouTube. Blank probes as above.",
          ph: "/opt/homebrew/bin/yt-dlp",
          check: (v) => path(v),
        },
        typst: {
          label: "typst",
          hint:
            "The typesetter that draws the caption cards. It is the SAME " +
            "binary the runs area's Papers feature uses, and there is one of " +
            "it on a machine, so a path set here or under Papers is picked up " +
            "by both — you only need to set it in one place. Blank probes. " +
            "To turn captions off, use “Caption renderer”.",
          ph: "/opt/homebrew/bin/typst",
          check: (v) => path(v),
        },
        captions: {
          label: "Caption renderer",
          hint:
            "Blank picks the best of what is on this machine: typst if it is " +
            "here, otherwise ffmpeg's drawtext filter if this build has one " +
            "AND a usable font file was found, otherwise nothing. Write " +
            "“typst”, “drawtext” or “off” to force it. Forcing one that is not " +
            "available produces a video with no captions and a sentence saying " +
            "which one you asked for — it never quietly falls back to the " +
            "other, because you asked for a specific machine.",
          ph: "typst",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "typst" || v === "drawtext" || v === "off"
              ? null
              : "One of “typst”, “drawtext” or “off”, or blank to use whatever is on this machine.";
          },
        },
        maxSource: {
          label: "Longest source video (minutes)",
          hint:
            "A shorts job refuses anything longer than this before it starts " +
            "downloading. Default 90. The limit exists because a long download " +
            "is a long download and nobody is watching it happen.",
          ph: "90",
          check: (v) => whole(v, 1, 600, "A whole number of minutes"),
        },
        ytdlpArgs: {
          label: "Extra yt-dlp arguments",
          hint:
            "Passed to every yt-dlp call, split on spaces, at most twenty. " +
            "This exists because what a video site requires of a downloader " +
            "changes every few months and the fix is always a flag — a " +
            "dashboard that needed a release to carry one would be broken for " +
            "weeks. Leave it blank unless a download is failing and yt-dlp's " +
            "own error tells you what to add. " +
            "WHAT YOU TYPE HERE BECOMES ARGUMENTS TO A PROGRAM ON THIS MACHINE, " +
            "on every shorts run, until you clear it. Some of yt-dlp's flags " +
            "make it run OTHER programs — `--exec` and `--exec-before-download` " +
            "run a shell command per file, and `--downloader` replaces the " +
            "downloader with a binary you name — so those four are refused here. " +
            "That refusal is a guard rail and not a security boundary: anything " +
            "that can write this setting can already write anything else on " +
            "this box. `--cookies-from-browser chrome` is the flag you actually " +
            "want most of the time, and note that it reads your own browser's " +
            "cookies and sends them to the video site.",
          ph: "--cookies-from-browser chrome",
          check(value) {
            const args = value.trim().split(/\s+/).filter(Boolean);
            if (args.length > 20) return "That is more than twenty arguments. Something is wrong.";
            /*
              THE FOUR FLAGS THAT TURN A DOWNLOADER INTO A COMMAND RUNNER.
              Matched on the argument's own head — `--exec`, `--exec=…` and
              `--exec cmd` are the same flag written three ways — and case
              folded, because yt-dlp accepts either.
            */
            const banned = ["--exec", "--exec-before-download", "--downloader", "--external-downloader"];
            const bad = args.find((a) => banned.includes(a.split("=")[0]!.toLowerCase()));
            if (bad)
              return `“${bad}” makes yt-dlp run another program, and this setting is not a place to do that. Everything else is allowed.`;
            return null;
          },
        },
        keep: {
          label: "Keep the working files",
          hint:
            "“on” keeps the downloaded stock clips and the per-shot segments " +
            "beside the finished video, which is the only way to work out why " +
            "one shot looks wrong. Off by default: they are a couple of hundred " +
            "megabytes per video and the finished file does not need them.",
          ph: "off",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "on" || v === "off" ? null : "Either “on” or “off”.";
          },
        },
      },
      /* CONNECTED MEANS "SOMETHING HERE IS SET", the reading `uptime` and `npm`
         use: there are no accounts to derive it from. It is not a claim that a
         video can be made — `GET /api/video` answers that, per capability, and
         it is a longer answer than one boolean. */
      after(values) {
        upsertPlugin(VIDEO_PLUGIN, Object.values(values).some((v) => (v ?? "").trim().length > 0), null);
      },
    },

    /*
      THE AUTOPILOT'S POLICY. Off, and both cadences at zero, until somebody
      says otherwise — this spends Replicate credit and Pexels quota, and a
      default that started doing that would be a surprise somebody pays for.
    */
    [AUTOPILOT_PLUGIN]: {
      keys: {
        enabled: {
          label: "Autopilot",
          hint:
            "“on” or “off”. OFF UNTIL YOU TURN IT ON. When it is on it wakes " +
            "once a day at the hour below and queues up to the cadences below. " +
            "It NEVER publishes anything: a post lands in the Studio gallery " +
            "and a video lands on its run page, for you.",
          ph: "off",
          check(value) {
            const v = value.trim().toLowerCase();
            return !v || v === "on" || v === "off" ? null : "Either “on” or “off”.";
          },
        },
        posts: {
          label: "Studio posts per venture per week",
          hint:
            "How many posts the autopilot may queue for EACH venture over a " +
            "rolling seven days. Zero — the default — means none. Posts you " +
            "make by hand are not counted and do not use this up. Each one " +
            "calls your model provider for the caption and Replicate for the " +
            "picture.",
          ph: "0",
          check: (v) => whole(v, 0, 21, "A whole number of posts a week"),
        },
        videos: {
          label: "Videos per venture per week",
          hint:
            "The same, for faceless videos. Zero is the default. Each one " +
            "spends a handful of Pexels requests, downloads a few hundred " +
            "megabytes of stock footage and takes minutes of this machine's " +
            "CPU — and there is ONE run slot on this box, shared with " +
            "everything you start by hand.",
          ph: "0",
          check: (v) => whole(v, 0, 14, "A whole number of videos a week"),
        },
        hour: {
          label: "Hour of the daily pass",
          hint:
            `The local hour, 0–23, in the time zone below. Default ${DEFAULT_HOUR}. ` +
            "The timer wakes every ten minutes rather than sleeping until the " +
            "hour, so a laptop that was shut at nine runs the pass when it " +
            "opens inside that hour — and skips the day entirely if it never " +
            "does.",
          ph: String(DEFAULT_HOUR),
          check: (v) => whole(v, 0, 23, "An hour of the day"),
        },
        timezone: {
          label: "Time zone",
          hint:
            `An IANA name — Europe/Dublin, America/New_York. Blank uses this ` +
            `machine's own, which right now is ${localZone()}.`,
          ph: localZone(),
          check(value) {
            if (!value.trim()) return null;
            return validZone(value.trim())
              ? null
              : `“${value.trim()}” is not a time zone this machine knows. Use an IANA name like Europe/Dublin.`;
          },
        },
        quiet: {
          label: "Stages to skip",
          hint:
            `Ventures at these stages get nothing, whatever the cadence says. ` +
            `Comma separated; the stages are idea, pre-launch and launched. ` +
            `Default “${DEFAULT_QUIET}” — an idea has no product to make a ` +
            `video about, and a video for one would be full of claims nobody ` +
            `can stand behind. Type “none” to skip nothing.`,
          ph: DEFAULT_QUIET,
          check(value) {
            const bad = value
              .split(/[,\n]/)
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
              .filter((s) => !["idea", "pre-launch", "launched", "none"].includes(s));
            return bad.length ? `Not stages: ${bad.join(", ")}. The stages are idea, pre-launch, launched.` : null;
          },
        },
        formats: {
          label: "Video formats it may queue",
          hint:
            `Comma separated, out of ${AUTOPILOT_FORMATS.join(", ")}. Default “faceless”. ` +
            `Formats rotate per venture across passes, within the weekly cadence. ` +
            `“shorts” now works unattended: the pass finds its own source video ` +
            `through the SearXNG node and refuses anything it has already cut ` +
            `up (Integrations → Social feed holds the duration band and the ` +
            `novelty window). With SearXNG not connected a shorts pass logs a ` +
            `skip saying there was nowhere to search. “ugc” generates an opening ` +
            `image from the brief, then animates it when animation is connected. ` +
            `“motion” also works ` +
            `unattended — a motion ` +
            `video drafts its own scene list from the topic. “stewie” hands ` +
            `the job to OPC's render relay, which may wake the Dell — better ` +
            `started by hand from the Studio.`,
          ph: "faceless",
          check(value) {
            const bad = value
              .split(/[,\n]/)
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean)
              .filter((s) => !AUTOPILOT_FORMATS.includes(s as (typeof AUTOPILOT_FORMATS)[number]));
            return bad.length ? `Not formats: ${bad.join(", ")}. The formats are ${AUTOPILOT_FORMATS.join(", ")}.` : null;
          },
        },
        cap: {
          label: "Most one pass may queue",
          hint:
            `Across every venture, in one day. Default ${DEFAULT_CAP}. This is ` +
            `the brake that matters: with nineteen ventures and a cadence of ` +
            `two, a pass without a cap would queue thirty-eight pieces of work ` +
            `in one second onto a queue that drains one at a time.`,
          ph: String(DEFAULT_CAP),
          check: (v) => whole(v, 1, 50, "A whole number of items"),
        },
      },
      after(values) {
        upsertPlugin(AUTOPILOT_PLUGIN, (values.enabled ?? "").trim().toLowerCase() === "on", null);
      },
    },
  },

  skills: SKILLS,
  packs: PACKS,

  routes: [
    { path: "/api/video", app: videoRoutes },
    { path: "/api/autopilot", app: autopilotRoutes },
  ],

  onStart: startAutopilot,
};
