/**
 * THE BINARIES THIS AREA SHELLS OUT TO, AND HOW IT RUNS THEM.
 *
 * Everything else on this box is HTTP. Video is not: cutting, scaling and
 * encoding a 1080x1920 file is ffmpeg's job, downloading a YouTube video is
 * yt-dlp's, and neither has an API. So this area runs processes, and the whole
 * of that decision — which binary, what it is allowed to be told, how long it
 * may take — is in this one file, so no pipeline below grows its own idea of
 * it. The typesetter is named by runs/typst.ts instead: it is the papers
 * area's tool and captions borrow it, and having video name it a second time
 * under a second settings key is exactly the bug that left every video
 * captionless on a box that had typst installed.
 *
 * DISCOVERY IS NOT HERE ANY MORE. Four areas wrote the same twenty lines of
 * "a configured path, then the places a package manager puts things, then
 * PATH", and two of them had `onPath` byte for byte identical; it lives once
 * in tools/find-binary.ts and this file only names the binaries. THE PATHS
 * DIFFER PER MACHINE — one install is a laptop with Homebrew, the next a Linux
 * box with apt — which is why discovery is probed at all.
 *
 * NO ARGUMENT IS EVER A STRING THE OWNER TYPED, joined into a shell. Every
 * call below is `execFile` with an ARRAY, so there is no shell, no quoting
 * question and no way for a caption containing a semicolon to become a
 * command. This matters more here than anywhere else on this box, because the
 * text going into these arguments was written by a model.
 *
 * THE FILTER PROBE EXISTS BECAUSE THIS BOX'S FFMPEG CANNOT DRAW TEXT.
 * `ffmpeg -filters` on the Homebrew build installed here lists no `drawtext`,
 * no `subtitles` and no `ass`: the build is configured without libfreetype and
 * without libass, which is not unusual and is not something this server can
 * fix. A pipeline that assumed drawtext would fail at the last step of a
 * three-minute render with an error about a filter. So the capability is
 * MEASURED once, cached for the process, and captions.ts picks a renderer out
 * of what is actually there. See that file for the three ways it can go.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { findBinary, type Binary, type ConfigKey } from "../../tools/find-binary.ts";

/** The settings plugin. Config only — there is no video credential; the one
 *  key this area needs (Pexels) belongs to the stock plugin that already
 *  holds it. */
export const VIDEO_PLUGIN = "video";

/* --------------------------------------------------------------- discovery */

/** A settings key under the Video page. `label` is what a failure sentence
 *  tells somebody to go and open, so it names a screen and not a table. */
const videoKey = (key: string): ConfigKey => ({
  plugin: VIDEO_PLUGIN,
  key,
  label: "the Video settings",
});

export const findFfmpeg = (): Binary =>
  findBinary({
    name: "ffmpeg",
    configKeys: [videoKey("ffmpeg")],
    install: "brew install ffmpeg, or apt install ffmpeg",
  });

export const findFfprobe = (): Binary =>
  findBinary({
    name: "ffprobe",
    configKeys: [videoKey("ffprobe")],
    install: "it ships with ffmpeg",
  });

export const findYtDlp = (): Binary =>
  findBinary({
    name: "yt-dlp",
    configKeys: [videoKey("ytdlp")],
    install: "brew install yt-dlp, or pipx install yt-dlp",
  });

/* ----------------------------------------------------------------- running */

export type Ran = { ok: boolean; code: number | null; stdout: string; stderr: string; error: string | null };

/**
 * One process, awaited, never throwing.
 *
 * A NON-ZERO EXIT IS A RESULT AND NOT AN EXCEPTION, for typst.ts's reason: the
 * caller of an encode wants to put the encoder's own complaint into the run's
 * report, and an exception carrying a truncated `Command failed` string throws
 * that complaint away. `error` is set only when the process could not be run
 * at all or ran out of time — the two cases that are about this box rather
 * than about the arguments.
 *
 * `signal` IS THREADED THROUGH FROM THE RUN. Cancelling a video run has to
 * kill the encode, not wait for it: a 1080x1920 concat is a minute of CPU that
 * nobody is going to look at.
 */
export function run(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal; cwd?: string } = { timeoutMs: 120_000 },
): Promise<Ran> {
  return new Promise((done) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs,
        maxBuffer: 8_000_000,
        signal: opts.signal,
        cwd: opts.cwd,
        killSignal: "SIGKILL",
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errText = String(stderr ?? "");
        if (!err) return done({ ok: true, code: 0, stdout: out, stderr: errText, error: null });
        const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
        const killed = (err as { killed?: boolean }).killed === true;
        done({
          ok: false,
          code,
          stdout: out,
          stderr: errText,
          error:
            /ENOENT/.test(err.message ?? "")
              ? `${bin} is not where this box thought it was`
              : killed
                ? `${bin} was stopped after ${Math.round(opts.timeoutMs / 1000)} seconds`
                : null,
        });
      },
    );
  });
}

/** The last few lines of a tool's complaint, which is the part that says what
 *  was wrong. ffmpeg prints its whole configuration first and the error last;
 *  quoting the head of that would quote the build flags. */
export function tail(text: string, lines = 6, cap = 1_200): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-lines)
    .join(" · ")
    .slice(0, cap);
}

/* ---------------------------------------------------------- what ffmpeg has */

/**
 * WHICH TEXT FILTERS THIS BUILD ACTUALLY HAS.
 *
 * Cached for the life of the process and keyed on the binary's path, because
 * `ffmpeg -filters` is a fork and a hundred milliseconds and the answer cannot
 * change while a process is running unless somebody swaps the binary
 * underneath it — in which case the next restart, which is two seconds away
 * under `node --watch`, gets it right.
 */
const filterCache = new Map<string, Set<string>>();

export async function ffmpegFilters(bin: string): Promise<Set<string>> {
  const cached = filterCache.get(bin);
  if (cached) return cached;
  const r = await run(bin, ["-hide_banner", "-filters"], { timeoutMs: 15_000 });
  const set = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    /*
      The listing is ` <flags> <name> <in>-><out>  <description>`, and the
      FLAG COLUMN IS NOT A FIXED WIDTH — which cost a real bug. Homebrew's
      ffmpeg 9.0.1 prints two characters (` TS gblur  V->V`) because that build
      has two flags to report; older and differently configured builds print
      three (` T.. gblur`). A pattern that insisted on three matched NOTHING
      here, so the probe returned an empty set, so `blurFilter` said this box
      has no blur and a letterboxed clip came out with flat colour bars behind
      it instead of the blurred frame. The arrow is the part that is really
      structural — only a filter line has one — so that is what this anchors
      on, and the flags are allowed to be one to four characters.
    */
    const m = /^\s*[A-Z.]{1,4}\s+(\S+)\s+[AVN|]+->[AVN|]+(\s|$)/.exec(line);
    if (m?.[1]) set.add(m[1]);
  }
  filterCache.set(bin, set);
  return set;
}

/* -------------------------------------------------------------- ffprobe --- */

/** A file's duration in seconds, read off the container. Null when ffprobe
 *  could not read it, which is never zero: a file that cannot be probed is a
 *  file whose length nobody knows. */
export async function probeDuration(ffprobe: string, path: string, signal?: AbortSignal): Promise<number | null> {
  const r = await run(
    ffprobe,
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
    { timeoutMs: 30_000, signal },
  );
  if (!r.ok) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Width and height, for the manifest and for deciding whether a source is
 *  worth upscaling. Null on either half that could not be read. */
export async function probeSize(
  ffprobe: string,
  path: string,
  signal?: AbortSignal,
): Promise<{ width: number | null; height: number | null }> {
  const r = await run(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
    { timeoutMs: 30_000, signal },
  );
  if (!r.ok) return { width: null, height: null };
  const nums = r.stdout.trim().split(",").map((x) => Number(x));
  const ok = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null);
  return { width: ok(nums[0]), height: ok(nums[1]) };
}

/** Bytes on disk, or null for a file that is not there. Used rather than
 *  trusting the writer, because a truncated encode has a size and a plausible
 *  one. */
export function bytesOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}
