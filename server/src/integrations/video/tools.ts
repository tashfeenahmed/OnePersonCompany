/**
 * THE FOUR BINARIES THIS AREA SHELLS OUT TO, AND HOW IT FINDS THEM.
 *
 * Everything else on this box is HTTP. Video is not: cutting, scaling and
 * encoding a 1080x1920 file is ffmpeg's job, downloading a YouTube video is
 * yt-dlp's, and neither has an API. So this area runs processes, and the whole
 * of that decision — where a binary is, whether it is there, what it is allowed
 * to be told, how long it may take — is in this one file, so no pipeline below
 * grows its own idea of it.
 *
 * DISCOVERY IS PROBED AND NOT ASSUMED, and it follows papers.ts's pattern
 * exactly: a configured path first, then the two or three places a package
 * manager puts things, then PATH. THE PATHS DIFFER PER MACHINE — this is a
 * laptop with Homebrew, the next install will be a Linux box with apt — so a
 * constant would be a feature that works here and nowhere else, which is the
 * one thing every feature in this codebase is forbidden to be.
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
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { configValue } from "../../db.ts";

/** The settings plugin. Config only — there is no video credential; the one
 *  key this area needs (Pexels) belongs to the stock plugin that already
 *  holds it. */
export const VIDEO_PLUGIN = "video";

/* --------------------------------------------------------------- discovery */

export type Tool = {
  name: string;
  /** Absolute path, or null when nothing was found. */
  path: string | null;
  /** Where it came from, so a page can say "the one you configured" rather
   *  than just naming a path. */
  source: "configured" | "known" | "path" | "none";
  /** Why there is none, in a sentence somebody can act on. Null when found. */
  error: string | null;
};

/** The places a package manager puts a binary on the two systems this is
 *  likely to run on. Homebrew on Apple silicon, Homebrew on Intel, and the
 *  two Linux prefixes. PATH is asked after all of them. */
const PREFIXES = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = resolve(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * One binary, found or explained.
 *
 * `configKey` names the setting that overrides discovery. A configured path
 * that is not there is a HARD failure rather than a fall-through to the
 * probe: the owner said where it is, and quietly using a different one would
 * make the setting a lie the next time somebody read it.
 */
export function findTool(name: string, configKey: string, install: string): Tool {
  const configured = (configValue(VIDEO_PLUGIN, configKey) ?? "").trim();
  if (configured) {
    if (existsSync(configured)) return { name, path: configured, source: "configured", error: null };
    return {
      name,
      path: null,
      source: "none",
      error: `The ${name} configured under the Video settings — ${configured} — is not there.`,
    };
  }
  for (const dir of PREFIXES) {
    const p = `${dir}/${name}`;
    if (existsSync(p)) return { name, path: p, source: "known", error: null };
  }
  const found = onPath(name);
  if (found) return { name, path: found, source: "path", error: null };
  return {
    name,
    path: null,
    source: "none",
    error:
      `No ${name} was found. Looked in ${PREFIXES.join(", ")} and on PATH. ` +
      `Install it (${install}) or set its path under the Video settings.`,
  };
}

export const findFfmpeg = () => findTool("ffmpeg", "ffmpeg", "brew install ffmpeg, or apt install ffmpeg");
export const findFfprobe = () => findTool("ffprobe", "ffprobe", "it ships with ffmpeg");
export const findYtDlp = () => findTool("yt-dlp", "ytdlp", "brew install yt-dlp, or pipx install yt-dlp");
export const findTypstBin = () => findTool("typst", "typst", "brew install typst");

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
