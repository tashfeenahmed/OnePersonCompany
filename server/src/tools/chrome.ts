/**
 * HEADLESS CHROME — one launcher, and the picture that comes out of it.
 *
 * Launching a browser was copied four times on this box: a venture capture, a
 * motion sheet, a brand probe and a printed paper. `findBrowser` was shared;
 * everything after it was not, and the three copies had drifted three ways:
 *
 *   - The paper printer used a NAMED profile directory it never deleted, one
 *     per paper, for ever — the exact ProcessSingleton contention the capture
 *     documents at length, plus a directory leak. `withProfile` below is
 *     mkdtemp and a `finally`, so the cleanup cannot be forgotten by the next
 *     caller and cannot be skipped by a throw.
 *   - The flag sets differed. This file takes the UNION: the capture's
 *     hygiene flags, the sheet renderer's `--force-device-scale-factor=1`
 *     (without which a shot's pixel size is not the window size it was asked
 *     for, which is the thing the dimensions are read to check), and a
 *     `--timeout` that follows the caller's own budget rather than a constant.
 *   - The stderr filters differed. This file takes the STRICTER: the sheet
 *     renderer's, which drops Fontconfig noise as well as the GPU lines.
 *
 * THE BROWSER DOES NOT EXIT ON ITS OWN, and that is the whole reason none of
 * this is a one-line `execFile`. Measured on Google Chrome 152 on macOS,
 * 2026-09-05: `--headless=new --screenshot=…` writes a complete, valid PNG and
 * then sits there; `--headless=new --dump-dom` prints a complete document to
 * stdout and then sits there. Both had to be killed. The old `--headless`
 * mode, which did exit, was removed from Chrome long before that version. So
 * what is waited for is THE OUTPUT rather than the process:
 *
 *   a file       it appears, and its size stops changing between two polls a
 *                quarter-second apart. PNGs and PDFs are written in one pass,
 *                so a size that has settled is a file that is finished.
 *   a DOM dump   stdout carries a `</html>` and then goes quiet for most of a
 *                second. A document that has closed and stopped growing is a
 *                document.
 *
 * Then the browser is killed on purpose, which is not a failure and is not
 * reported as one. The wall-clock cap is still there and still means what it
 * says: nothing was produced in time.
 *
 * WHY THE VIEWPORT AND THE DIMENSION READER LIVE HERE TOO. They are the two
 * halves of one measurement. 1280x800 was typed in two files and judged
 * against a floor in a third that imported neither, and five separate
 * hand-rolled IHDR readers at three strictness levels measured the same PNG.
 * A picture's asked-for size and its actual size belong beside the code that
 * asks for it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DATA_DIR } from "../config.ts";
import { findBinary, type Binary, type ConfigKey } from "./find-binary.ts";

/* --------------------------------------------------------------- the size */

/**
 * THE CAPTURE VIEWPORT — one number, named once.
 *
 * 1280x800 is a desktop fold: wide enough that a site's desktop layout is what
 * gets drawn, short enough that the shot is the fold rather than a page. Both
 * the venture capture and the brand probe drive Chrome at the same site for
 * the same class of artefact, and they typed it separately — change one and
 * the two readings quietly stop being comparable.
 */
export const SHOT_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * Under this, a capture is not a picture of a page.
 *
 * DERIVED FROM THE VIEWPORT RATHER THAN TYPED, which is the fix. The QA check
 * that uses it was calibrated against 1280x800 and said so in a comment while
 * importing nothing, so raising the viewport would have left the floor
 * describing a window that no longer existed. Half in either dimension is a
 * thumbnail, an error image, or a window that never opened.
 */
export const SHOT_FLOOR = {
  width: SHOT_VIEWPORT.width / 2,
  height: SHOT_VIEWPORT.height / 2,
} as const;

/* ------------------------------------------------------------ the browser */

/** The pseudo-plugin the browser path hangs off. `plugin_config` has a foreign
 *  key onto `plugins`, so a setting has to hang off something, and there is no
 *  browser integration to hang it off. */
export const CAPTURE_PLUGIN = "capture";

const BROWSER_KEY: ConfigKey = { plugin: CAPTURE_PLUGIN, key: "chromium", label: "Capture" };

/**
 * Where a headless-capable browser might be, in the order they are tried.
 *
 * Chrome first because `--headless=new` is its flag and the Chromium builds
 * accept the same one. The four macOS applications and Chrome's Linux paths
 * are full paths; the PATH names are aliases, which is how any other Linux
 * box finds one.
 *
 * The application paths are probed on every platform rather than gated on
 * `darwin`. A path that is not there costs one `existsSync`, and a gate is one
 * more thing that can be wrong on a platform nobody tested.
 */
const BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  /* Chrome's own Linux paths, so Chrome beats a `chromium` that is merely
     earlier on PATH. GitHub's Ubuntu runner has both, and its Chromium hangs
     headless where Chrome does not; a box with only Chromium still finds it. */
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

const BROWSER_NAMES = [
  "google-chrome",
  "chromium-browser",
  "google-chrome-stable",
  "brave-browser",
] as const;

export type Browser = Binary;

/**
 * The browser this box will use, and where the answer came from.
 *
 * A CONFIGURED PATH THAT DOES NOT EXIST IS AN ERROR RATHER THAN A FALLBACK —
 * see find-binary.ts, which is where that rule now lives for every binary on
 * the box. Silently using Chrome when the owner typed a path to Brave would
 * mean the setting appears to work and does nothing.
 */
export function findBrowser(): Browser {
  return findBinary({
    name: "chromium",
    aliases: BROWSER_NAMES,
    candidates: BROWSER_CANDIDATES,
    configKeys: [BROWSER_KEY],
    install: "Google Chrome, Chromium, Brave or Edge",
  });
}

/* ------------------------------------------------------------ the profile */

/**
 * A profile directory of this run's own, made fresh and thrown away after.
 *
 * `--user-data-dir` IS LOAD-BEARING AND NOT TIDINESS: without it a headless
 * run reaches for the OWNER'S own Chrome profile, which is locked while their
 * browser is open and which this has no business reading.
 *
 * ONE PER RUN RATHER THAN ONE SHARED, and that is not caution either — it is
 * what a shared one actually did. Chrome puts a `ProcessSingleton` lock in a
 * profile and refuses to start a second instance against it: a screenshot and
 * a DOM dump a minute apart failed with "Failed to create a ProcessSingleton
 * for your profile directory. Aborting", and a run that had already written
 * its PNG hung on shutdown until the wall-clock kill. A directory per run
 * cannot contend with itself, and it costs Chrome's fresh-profile init — a
 * second or two — which is a fraction of the page load it is waiting for.
 *
 * THE CLEANUP IS A `finally` AND NOT A LINE THE CALLER REMEMBERS. One of the
 * copies this replaces used a named directory keyed on the document's id and
 * deleted it never, so a box that had printed four hundred papers carried four
 * hundred Chrome profiles. A helper that hands the directory to a callback is
 * the only shape where forgetting is not possible.
 */
export async function withProfile<T>(
  fn: (dir: string) => Promise<T>,
  prefix = "run-",
): Promise<T> {
  const base = resolve(DATA_DIR, "chrome-profile");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(resolve(base, prefix));
  try {
    return await fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* A profile that will not delete costs a few megabytes until the next
         backup prune. It is not worth failing a capture over. */
    }
  }
}

/* --------------------------------------------------------------- the flags */

/** Chrome's own budget for virtual time: how long the page may keep loading
 *  before the output is taken. Six seconds is a slow site with fonts and a
 *  hero image, and it is what a venture capture has always allowed. */
export const VIRTUAL_TIME_MS = 6_000;

/** The whole run, wall clock. A page that has not painted in twenty-five
 *  seconds is a page whose picture is not worth the socket. */
export const RUN_MS = 25_000;

/** How often the output is checked, and how long stdout must be quiet before a
 *  dumped DOM is called finished. */
const POLL_MS = 250;
const QUIET_MS = 800;

export type ArgOpts = {
  /** The profile directory, from `withProfile`. */
  profile: string;
  /** Defaults to SHOT_VIEWPORT. */
  width?: number;
  height?: number;
  /** How long the page may keep loading. Zero omits the flag, which is what a
   *  page with no network in it wants. */
  virtualTimeMs?: number;
  /** Chrome's own `--timeout`, in milliseconds. Follows the caller's budget
   *  rather than a constant, which is the sheet renderer's improvement over
   *  the capture's hardcoded 20 s. */
  timeoutMs?: number;
  /** Suppress the header and footer Chrome prints on a PDF. */
  printing?: boolean;
};

/**
 * The flags every launch on this box shares.
 *
 * THE UNION OF THE FOUR COPIES, not the intersection. Each of them had a flag
 * the others wanted: the capture's `--hide-scrollbars` (a scrollbar in a
 * thumbnail is an artefact of the window, not of the site), the sheet
 * renderer's `--force-device-scale-factor`, the printer's
 * `--no-pdf-header-footer`. Mode flags — `--screenshot=`, `--print-to-pdf=`,
 * `--dump-dom` — and the URL are the caller's, and are appended after these.
 *
 * NOTHING HERE NEEDS THE NETWORK EXCEPT THE PAGE ITSELF: no sync, no crash
 * upload, no component update on somebody else's dashboard while their site is
 * being photographed.
 */
export function baseArgs(opts: ArgOpts): string[] {
  const width = opts.width ?? SHOT_VIEWPORT.width;
  const height = opts.height ?? SHOT_VIEWPORT.height;
  const virtual = opts.virtualTimeMs ?? VIRTUAL_TIME_MS;
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    /* Device pixel ratio 1: at anything else the file's dimensions are not
       the window's, and the dimensions are read precisely to check they
       match. */
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
    `--user-data-dir=${opts.profile}`,
  ];
  if (virtual > 0) args.push(`--virtual-time-budget=${virtual}`);
  if (opts.timeoutMs && opts.timeoutMs > 0) args.push(`--timeout=${opts.timeoutMs}`);
  if (opts.printing) args.push("--no-pdf-header-footer");
  /* Chrome's sandbox refuses to start as root, which is how this runs on a
     server box and never how it runs on a laptop. Added only in the case that
     needs it, because turning the sandbox off unconditionally would be doing
     it on the machine where it works. */
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  return args;
}

/* --------------------------------------------------------------- the run */

export type ShotResult =
  | { ok: true; path: string; stdout: string; error: null }
  | { ok: false; path: null; stdout: string; error: string };

export type RunOpts = {
  bin: string;
  args: string[];
  /** How long the whole thing may take, wall clock. Defaults to RUN_MS. */
  budgetMs?: number;
  /** Cancellation from the run that asked for this. A cancelled run must not
   *  wait out a twenty-five-second browser. */
  signal?: AbortSignal;
};

/**
 * Run the browser until the file it was told to write stops growing, then kill it.
 *
 * `out` is the path Chrome was pointed at — a PNG from `--screenshot=`, a PDF
 * from `--print-to-pdf=`. The file is the contract: a size that is the same
 * across two polls and is not zero is a finished file.
 *
 * A browser that DOES exit — a bad flag, a missing library, a future version
 * that behaves — is honoured rather than waited out.
 */
export function shoot(opts: RunOpts & { out: string; requireDom?: boolean }): Promise<ShotResult> {
  return runBrowser(opts, { file: opts.out, dom: opts.requireDom });
}

export type DumpResult =
  | { ok: true; html: string; error: null }
  | { ok: false; html: string; error: string };

/** The rendered DOM of a page, from `--dump-dom`. A document that has closed
 *  and stopped growing is a document. */
export async function dump(opts: RunOpts): Promise<DumpResult> {
  const got = await runBrowser(opts, { dom: true });
  return got.ok
    ? { ok: true, html: got.stdout, error: null }
    : { ok: false, html: got.stdout, error: got.error };
}

/**
 * HOW MUCH SHORTER THAN ITS WINDOW THIS BROWSER DRAWS A PAGE.
 *
 * `--window-size=1080,1920` is the WINDOW. Chromium's new headless mode on
 * Linux keeps room for a toolbar it never draws, so the page is laid out
 * 1080x1833 and the screenshot's last 87 rows are the bare canvas: every frame
 * of every motion video made on a Linux box carried a black band along the
 * bottom, and every 1280x800 site capture was really 1280x713 of page over a
 * blank strip (measured 2026-09-17 on Chromium 146). On macOS the two agree and
 * the answer is 0.
 *
 * WHAT A CALLER DOES WITH IT: ask for a window `height + deficit` tall, so the
 * PAGE is the height that was wanted, then cut the surplus rows off the
 * picture — `trimPngFile` in tools/png.ts, or ffmpeg's crop for a frame sheet.
 *
 * MEASURED, NOT ASSUMED: a probe page writes its own `innerHeight` into its
 * title, once per browser per process. A probe that fails answers 0, which is
 * exactly the old behaviour.
 */
const deficits = new Map<string, Promise<number>>();
export function viewportDeficit(browser: string): Promise<number> {
  let known = deficits.get(browser);
  if (!known) {
    known = (async () => {
      const dir = mkdtempSync(resolve(tmpdir(), "opc-viewport-"));
      try {
        const page = resolve(dir, "probe.html");
        writeFileSync(page, "<!doctype html><title>?</title><script>document.title='h='+innerHeight</script>", "utf8");
        const asked = 600;
        const got = await withProfile(
          (profile) =>
            dump({
              bin: browser,
              args: [...baseArgs({ profile, width: 800, height: asked, virtualTimeMs: 1_000, timeoutMs: 20_000 }), "--dump-dom", `file://${page}`],
              budgetMs: 20_000,
            }),
          "probe-",
        );
        const inner = Number(/<title>h=(\d+)<\/title>/.exec(got.html)?.[1]);
        const gap = asked - inner;
        return Number.isFinite(gap) && gap > 0 && gap < 400 ? gap : 0;
      } catch {
        return 0;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    deficits.set(browser, known);
  }
  return known;
}

function runBrowser(opts: RunOpts, want: { file: string; dom?: boolean } | { dom: true }): Promise<ShotResult> {
  const budgetMs = opts.budgetMs ?? RUN_MS;
  /* How much stdout is read before the page is called abusive. Only a DOM
     dump produces any. */
  const maxBytes = 32 * 1024 * 1024;

  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      /* `spawn` throwing synchronously is rare and real — an argument list
         past the operating system's limit does it — and the copy that did not
         catch it turned a bad call into an unhandled rejection. */
      child = spawn(opts.bin, opts.args, { windowsHide: true });
    } catch (err) {
      return done({
        ok: false,
        path: null,
        stdout: "",
        error: `The browser could not be started — ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const deadline = Date.now() + budgetMs;
    let out = "";
    let err = "";
    let lastOut = Date.now();
    let overflowed = false;
    let settled = false;
    let lastSize = -1;

    child.stdout?.on("data", (b: Buffer) => {
      if (out.length + b.length > maxBytes) {
        overflowed = true;
        return;
      }
      out += b.toString("utf8");
      lastOut = Date.now();
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (err.length < 16_384) err += b.toString("utf8");
    });

    const finish = (result: ShotResult) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      /* SIGKILL rather than SIGTERM: a browser that would not exit when it had
         finished its one job is not a browser that is going to honour a polite
         request, and every renderer it started is a child of it. */
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(result);
    };

    const onAbort = () =>
      finish({ ok: false, path: null, stdout: out, error: "The run was cancelled." });
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    /** The file's size, or -1 when it is not there or cannot be read yet. */
    const sizeOf = (file: string): number => {
      try {
        return existsSync(file) ? statSync(file).size : -1;
      } catch {
        return -1;
      }
    };

    const timer = setInterval(() => {
      if (Date.now() > deadline)
        return finish({
          ok: false,
          path: null,
          stdout: out,
          error:
            `The browser produced nothing usable within ${Math.round(budgetMs / 1000)} seconds — ` +
            (reason(err) ?? "the page was too slow, or never loaded."),
        });

      if (overflowed)
        return finish({
          ok: false,
          path: null,
          stdout: out,
          error: `The page produced more than ${Math.round(maxBytes / 1024 / 1024)} MB of output, which is more than this reads.`,
        });

      if ("file" in want) {
        const size = sizeOf(want.file);
        if (size > 0 && size === lastSize && (!want.dom || (out.includes("</html>") && Date.now() - lastOut > QUIET_MS)))
          return finish({ ok: true, path: want.file, stdout: out, error: null });
        lastSize = size;
        return;
      }

      if (out.includes("</html>") && Date.now() - lastOut > QUIET_MS)
        return finish({ ok: true, path: "", stdout: out, error: null });
    }, POLL_MS);

    child.on("close", (code) => {
      /* `size > 0` rather than `existsSync`: Chrome creates the output file
         before it writes to it, so an exit with a zero-byte file beside it is
         a failure wearing a success's clothes. That is the stricter of the two
         copies, and it is the right one. */
      const enough = ("file" in want ? sizeOf(want.file) > 0 : true) &&
        (!want.dom || out.includes("</html>"));
      if (enough)
        return finish({
          ok: true,
          path: "file" in want ? want.file : "",
          stdout: out,
          error: null,
        });
      finish({
        ok: false,
        path: null,
        stdout: out,
        error: reason(err) ?? `The browser exited with code ${code} and produced nothing.`,
      });
    });

    child.on("error", (e) =>
      finish({
        ok: false,
        path: null,
        stdout: out,
        error: `The browser could not be started — ${e.message}`,
      }),
    );
  });
}

/**
 * The fault out of Chrome's stderr, or null.
 *
 * Chrome logs a line per subsystem on the way up and several of them are
 * ERRORs that mean nothing: a display link on a machine with no display, a GPU
 * it was told not to use, a font config on a box with no fonts installed. The
 * LAST line that is not one of those is the one that stopped it.
 *
 * NODE'S OWN `err.message` IS NEVER IT, which is why this exists at all:
 * node's message is "Command failed: " followed by three hundred characters of
 * Chrome flags. That is not a guess — the first version of the capture
 * reported exactly that truncated command line and nothing else.
 *
 * The filter is the STRICTER of the two copies this replaces: the Fontconfig
 * pattern was added by one of them and wanted by both.
 */
export function reason(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/cv_display_link_mac|CVDisplayLinkCreate|GPU|gpu_|Fontconfig/i.test(l));
  const last = lines[lines.length - 1];
  if (!last) return null;
  /* Chrome prefixes every line with pid, tid, timestamp and source location.
     The sentence is after the last "] ". */
  const i = last.lastIndexOf("] ");
  return (i >= 0 ? last.slice(i + 2) : last).slice(0, 300);
}

/* ---------------------------------------------------------- the dimensions */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * WHAT SIZE THIS PICTURE ACTUALLY IS, from its own header.
 *
 * Read rather than assumed, because the window size is what was ASKED for and
 * the file is what was PRODUCED. A device pixel ratio, a page that forced a
 * wider layout, or a Chrome that ignored the flag would all make the two
 * disagree, and the row should say what is in the file.
 *
 * FIVE COPIES OF THIS EXISTED AT THREE STRICTNESS LEVELS — one checked two
 * bytes of the signature, one checked all eight, one also checked for the
 * `IHDR` chunk type, and only one of the five read a JPEG at all. So the same
 * image's dimensions as stored on a row, as judged against a floor, and as
 * priced into a model's tokens were three independent measurements. This is
 * the STRICTEST of them, plus the JPEG walk, once.
 *
 * TWO FORMATS AND NO MORE, deliberately: PNG is what Chrome writes and JPEG is
 * what every camera and every uploader produces. A WebP or a GIF whose size
 * this cannot read is stored with null dimensions rather than with a guess.
 * Null means "not measured" everywhere it is shown, and never zero.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  return pngDimensions(bytes) ?? jpegDimensions(bytes);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIG.length; i++) if (bytes[i] !== PNG_SIG[i]) return null;
  /* The eight-byte signature, then a length and a chunk type. IHDR is required
     by the format to be the first chunk, so a file whose 12th byte is not the
     start of one is not a PNG this should be reading numbers out of. */
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  const u32 = (i: number) =>
    ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
  const width = u32(16);
  const height = u32(20);
  /* A zero dimension is a corrupt header, not a zero-pixel image. */
  return width > 0 && height > 0 ? { width, height } : null;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1]!;
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    /* SOF0..SOF3 and SOF5..SOF15 carry the frame size; SOF4 (0xc4), SOF8
       (0xc8) and SOF12 (0xcc) are not start-of-frame markers at all. The rest
       are skipped by their own declared length, which is what makes this a
       walk rather than a scan for a byte pattern that also occurs inside the
       compressed data. */
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    /* A segment claiming a length of zero would leave this walking two bytes
       at a time for ever on a truncated file. */
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}
