/**
 * FINDING AN EXTERNAL BINARY ON THIS MACHINE — the one implementation.
 *
 * Four areas shell out to something: video to ffmpeg, ffprobe and yt-dlp,
 * papers to typst, capture to a headless browser, video extras to whisper.cpp.
 * All four wrote the same twenty lines — a configured path first, then the two
 * or three places a package manager puts things, then PATH, then a sentence
 * telling you how to install it — and `onPath` was byte-for-byte identical in
 * two of them. This file is that shape, once.
 *
 * THE PATHS DIFFER PER MACHINE and that is the whole reason discovery is
 * probed rather than assumed. One install is a Mac with Homebrew, the next is
 * a Debian box with apt, the one after that is a Pi. A constant would be a
 * feature that works on the machine it was written on and nowhere else.
 *
 * A CONFIGURED PATH THAT IS NOT THERE IS AN ERROR, NOT A FALL-THROUGH. Someone
 * typed it. Quietly using a different binary would make the setting a lie the
 * next time anybody read it, and would hide the typo that caused it. All four
 * copies already agreed on this; it is written down here so the fifth caller
 * inherits it rather than re-deciding it.
 *
 * `configKeys` IS A LIST, AND THAT IS THE BUG IT EXISTS TO FIX. Typst was
 * discovered under two different plugin settings keys: the video area read the
 * video plugin's, the papers area read Papers'. Set the path under Papers and
 * every video still rendered captionless, with a message telling you to
 * install a typesetter you already had. One binary can therefore be named by
 * several settings, the first one that carries a value wins, and the sentence
 * on failure lists all of them so an owner is told every place they may set it
 * rather than one arbitrary place.
 *
 * WHAT THIS IS NOT: it does not run anything, does not read a version and does
 * not cache. Discovery is a handful of `existsSync` calls — cheaper than the
 * process it precedes, and a cache would be a box that keeps saying "no ffmpeg"
 * for an hour after you installed one.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { configValue } from "../db.ts";

/**
 * The places a package manager puts a binary, in the order they are tried.
 *
 * Homebrew on Apple silicon, Homebrew on Intel, the two Linux prefixes, and
 * snap. The trailing slash is load-bearing — see `candidates` below, where it
 * is what separates "a directory to look in" from "a file to look at".
 */
export const KNOWN_PREFIXES = [
  "/opt/homebrew/bin/",
  "/usr/local/bin/",
  "/usr/bin/",
  "/bin/",
  "/snap/bin/",
] as const;

/**
 * One settings key that may name this binary's path.
 *
 * `label` is how the key is described in a sentence somebody has to act on —
 * "the Video settings", "Papers" — because "set it under video.typst" names a
 * database row rather than a screen.
 */
export type ConfigKey = { plugin: string; key: string; label: string };

export type BinarySpec = {
  /** What the binary is called, and what the failure sentence names. */
  name: string;
  /**
   * Other names the same tool ships under, tried after `name` in every
   * directory and on PATH. whisper.cpp's CLI has been `whisper-cli`,
   * `whisper-cpp`, `whisper` and — from a hand-built checkout — `main`.
   */
  aliases?: readonly string[];
  /**
   * Where to look before PATH. AN ENTRY ENDING IN "/" IS A DIRECTORY and is
   * joined with the name and each alias; anything else is a full path to a
   * file and is used verbatim. That distinction is explicit rather than
   * guessed because both kinds are real: `/opt/homebrew/bin/` is a prefix, and
   * "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" is a path
   * whose basename is not any name this would have composed.
   *
   * Defaults to KNOWN_PREFIXES.
   */
  candidates?: readonly string[];
  /** The settings that may override discovery, in the order they are asked. */
  configKeys?: readonly ConfigKey[];
  /** How to get it, in the failure sentence. "brew install typst", and so on. */
  install?: string;
};

export type Binary =
  | {
      found: true;
      name: string;
      path: string;
      /** "configured" — a setting named it. "known" — one of `candidates`.
       *  "path" — PATH had it. */
      source: "configured" | "known" | "path";
      /** Which setting named it, when one did. Null otherwise, so a page can
       *  say "the one you configured under Papers" rather than just a path. */
      via: ConfigKey | null;
      error: null;
    }
  | { found: false; name: string; path: null; source: "none"; via: null; error: string };

/**
 * The first entry on PATH that is a readable file called `name`.
 *
 * An unreadable PATH entry — a directory that has gone, a mount that is not
 * there — is skipped rather than thrown, because a broken PATH is not this
 * feature's problem and a `statSync` on a dangling symlink throws.
 *
 * The `isFile` check is capture.ts's and is the stricter of the two copies
 * this replaces: a DIRECTORY named `ffmpeg` on PATH would otherwise be handed
 * to `spawn`, which fails later with a message about a permission.
 */
export function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const full = resolve(dir, name);
    try {
      if (existsSync(full) && statSync(full).isFile()) return full;
    } catch {
      /* an unreadable PATH entry is not this feature's problem */
    }
  }
  return null;
}

/** Every name this tool answers to, in the order they are tried. */
function names(spec: BinarySpec): string[] {
  return [spec.name, ...(spec.aliases ?? [])];
}

/**
 * One binary, found or explained.
 *
 * The order is: the settings, then the known places, then PATH. Nothing here
 * runs the binary, so "found" means "there is a file at that path" and never
 * "it works" — the process's own error is a better report of a broken install
 * than anything this could compose.
 */
export function findBinary(spec: BinarySpec): Binary {
  const fail = (error: string): Binary => ({
    found: false,
    name: spec.name,
    path: null,
    source: "none",
    via: null,
    error,
  });

  for (const ck of spec.configKeys ?? []) {
    const configured = (configValue(ck.plugin, ck.key) ?? "").trim();
    if (!configured) continue;
    if (existsSync(configured))
      return {
        found: true,
        name: spec.name,
        path: configured,
        source: "configured",
        via: ck,
        error: null,
      };
    return fail(`The ${spec.name} configured under ${ck.label} — ${configured} — is not there.`);
  }

  const candidates = spec.candidates ?? KNOWN_PREFIXES;
  for (const entry of candidates) {
    if (entry.endsWith("/")) {
      for (const name of names(spec)) {
        const p = `${entry}${name}`;
        if (existsSync(p))
          return { found: true, name: spec.name, path: p, source: "known", via: null, error: null };
      }
      continue;
    }
    if (existsSync(entry))
      return { found: true, name: spec.name, path: entry, source: "known", via: null, error: null };
  }

  for (const name of names(spec)) {
    const p = onPath(name);
    if (p) return { found: true, name: spec.name, path: p, source: "path", via: null, error: null };
  }

  return fail(missingSentence(spec, candidates));
}

/**
 * The sentence somebody reads when there is none.
 *
 * It says WHERE IT LOOKED, because "no ffmpeg was found" on a machine with
 * ffmpeg installed in an unusual prefix is a dead end, and the list of places
 * is what turns it into "ah — it is in /usr/local/sbin". And it names EVERY
 * settings key, which is finding 33's actual fix: an owner who set the path
 * under one plugin and got this message under another had no way to know the
 * two keys existed.
 */
function missingSentence(spec: BinarySpec, candidates: readonly string[]): string {
  const looked = candidates.map((c) => (c.endsWith("/") ? `${c}${spec.name}` : c));
  const where = looked.length
    ? `Looked at ${looked.slice(0, 6).join(", ")}${looked.length > 6 ? ", …" : ""} and on PATH`
    : "Looked on PATH";
  const labels = (spec.configKeys ?? []).map((k) => k.label).join(" or ");
  const fix = [
    spec.install ? `install it (${spec.install})` : null,
    labels ? `set its path under ${labels}` : null,
  ].filter(Boolean);
  const tail = fix.length ? ` ${fix.join(", or ").replace(/^./, (c) => c.toUpperCase())}.` : "";
  const aliases = spec.aliases?.length ? ` (also tried ${spec.aliases.join(", ")})` : "";
  return `No ${spec.name} was found${aliases}. ${where}.${tail}`.replace(/\s+/g, " ").trim();
}
