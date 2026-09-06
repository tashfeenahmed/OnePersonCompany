/**
 * HEADLESS CHROME, DRIVEN FOR PICTURES RATHER THAN FOR PAGES.
 *
 * ventures/capture.ts already owns "find a browser on this machine" and "run
 * it until the file it was asked for stops growing, then kill it", and the
 * comments there record what that cost to get right — the browser does not
 * exit on its own, a shared profile directory contends with itself, and node's
 * own error message is three hundred characters of Chrome flags rather than
 * the fault. NONE OF THAT IS REPEATED HERE. This file imports `findBrowser`
 * from that module and re-implements only the part that differs: the window is
 * whatever size the caller asks for rather than 1280×800, the URL is usually a
 * `file://` of a page this server wrote, and there is no DOM dump.
 *
 * WHY A LOCAL FILE AND NOT A DATA URL. Chrome treats a `data:` document as an
 * opaque origin with no base URL, which is survivable for a page with no
 * assets and is a trap the moment one is added; a file in the run's own
 * directory is also the thing somebody debugging a scene wants to open in a
 * real browser. The file is written next to the frames it produced and goes
 * when the run's directory goes.
 *
 * THE WINDOW SIZE IS BOUNDED AND THE BOUND IS NOT DECORATION. A screenshot is
 * a bitmap Chrome has to allocate: 8640×1920 is 66 megabytes of RGBA and works
 * on this machine, and asking for four times that gets a browser that either
 * refuses or writes a truncated PNG with no error. So a sheet's width is
 * computed from a pixel budget rather than typed, and `tilesPerSheet` below is
 * the only place that arithmetic lives.
 *
 * A CAPTURE OF A VENTURE'S OWN SITE IS STILL A REQUEST TO SOMEBODY ELSE'S
 * SERVER, even when the somebody is the owner. It is made with the same flags
 * ventures/capture.ts uses — no sync, no crash reporting, no component
 * updates — and it is made once per page per run rather than once per shot.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { findBrowser, type Browser } from "../ventures/capture.ts";

export { findBrowser, type Browser };

/** How many pixels a single screenshot may be. Measured rather than guessed:
 *  8640×1920 (eight 9:16 frames) writes a valid 1.4 MB PNG on this machine in
 *  about 2.6 seconds. Twenty-four megapixels leaves room above that and stays
 *  well under the 16,384-pixel limit a software rasteriser has per side. */
const PIXEL_BUDGET = 24_000_000;
const MAX_SIDE = 16_000;

/** How many frames of a given size fit in one sheet. Always at least one — a
 *  frame that does not fit the budget on its own is still rendered, because a
 *  refusal here would mean 16:9 videos could not be made at all. */
export function tilesPerSheet(width: number, height: number, most = 8): number {
  const byPixels = Math.floor(PIXEL_BUDGET / Math.max(1, width * height));
  const bySide = Math.floor(MAX_SIDE / Math.max(1, width));
  return Math.max(1, Math.min(most, byPixels, bySide));
}

/** How long any one browser run may take. A sheet is a local file with no
 *  network in it and settles in seconds; a page capture is somebody else's
 *  site and is given the same twenty-five seconds ventures/capture.ts allows. */
const LOCAL_MS = 20_000;
const REMOTE_MS = 25_000;
const POLL_MS = 250;

export type Shot = { ok: true; path: string; error: null } | { ok: false; path: null; error: string };

/**
 * Run a browser until the PNG it was told to write stops growing, then kill it.
 *
 * The wait is on the OUTPUT and not on the process, for the reason
 * ventures/capture.ts documents at length: `--headless=new --screenshot` writes
 * a complete file and then sits there forever. A size that is the same across
 * two polls a quarter-second apart is a finished PNG, because a PNG is written
 * in one pass.
 */
function shoot(bin: string, args: string[], out: string, budgetMs: number, signal?: AbortSignal): Promise<Shot> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      return done({ ok: false, path: null, error: `The browser could not be started — ${err instanceof Error ? err.message : String(err)}` });
    }
    const deadline = Date.now() + budgetMs;
    let settled = false;
    let err = "";
    let lastSize = -1;

    child.stderr?.on("data", (b: Buffer) => {
      if (err.length < 8_192) err += b.toString("utf8");
    });

    const finish = (result: Shot) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done(result);
    };
    const onAbort = () => finish({ ok: false, path: null, error: "the run was cancelled" });
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setInterval(() => {
      if (Date.now() > deadline)
        return finish({
          ok: false,
          path: null,
          error: `The browser produced nothing usable within ${Math.round(budgetMs / 1000)} seconds — ${lastLine(err) ?? "the page was too slow, or never loaded."}`,
        });
      let size = -1;
      try {
        size = existsSync(out) ? statSync(out).size : -1;
      } catch {
        size = -1;
      }
      if (size > 0 && size === lastSize) return finish({ ok: true, path: out, error: null });
      lastSize = size;
    }, POLL_MS);

    child.on("close", (code) => {
      if (existsSync(out) && (statSync(out).size ?? 0) > 0) return finish({ ok: true, path: out, error: null });
      finish({ ok: false, path: null, error: lastLine(err) ?? `The browser exited with code ${code} and produced nothing.` });
    });
    child.on("error", (e) => finish({ ok: false, path: null, error: `The browser could not be started — ${e.message}` }));
  });
}

/** The last line of Chrome's stderr that is not a GPU complaint on a machine
 *  that was told not to use one. Same filter as ventures/capture.ts. */
function lastLine(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/cv_display_link_mac|CVDisplayLinkCreate|GPU|gpu_|Fontconfig/i.test(l));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const i = last.lastIndexOf("] ");
  return (i >= 0 ? last.slice(i + 2) : last).slice(0, 300);
}

function profile(): string {
  const base = resolve(DATA_DIR, "chrome-profile");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(resolve(base, "vplus-"));
}

const drop = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a profile that will not delete costs megabytes, not a render */
  }
};

function baseArgs(dir: string, width: number, height: number, budgetMs: number): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
    `--timeout=${budgetMs}`,
    `--user-data-dir=${dir}`,
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  return args;
}

/**
 * ONE SHEET OF THE OWN-WRITTEN HTML, SCREENSHOTTED.
 *
 * `--virtual-time-budget` is small here on purpose. It exists to let a page
 * finish loading before the shot; the scenes have no network, no fonts to
 * fetch and no scripts, and their animation is paused with a negative delay
 * rather than played — so nothing about the picture depends on how much
 * virtual time passed. Two seconds is layout and paint with room to spare.
 */
export async function shootSheet(opts: {
  browser: string;
  html: string;
  dir: string;
  name: string;
  width: number;
  height: number;
  signal?: AbortSignal;
}): Promise<Shot> {
  mkdirSync(opts.dir, { recursive: true });
  const page = resolve(opts.dir, `${opts.name}.html`);
  const out = resolve(opts.dir, `${opts.name}.png`);
  writeFileSync(page, opts.html, "utf8");
  rmSync(out, { force: true });
  const dir = profile();
  try {
    return await shoot(
      opts.browser,
      [...baseArgs(dir, opts.width, opts.height, LOCAL_MS), "--virtual-time-budget=2000", `--screenshot=${out}`, `file://${page}`],
      out,
      LOCAL_MS,
      opts.signal,
    );
  } finally {
    drop(dir);
  }
}

/**
 * A PAGE OF THE VENTURE'S OWN SITE, AS ONE TALL PICTURE.
 *
 * THE HEIGHT IS THE SCROLL. There is no browser-recording API on this box and
 * no DevTools client in this project, so a walkthrough cannot be a recording
 * of somebody scrolling. What Chrome's command line DOES give is a window of
 * any height, and a 1280×3600 window renders 3600 pixels of the page in one
 * shot. reel.ts then PANS a 1280×800 crop down that picture with ffmpeg, which
 * is the same motion a person scrolling would make and is smoother than a
 * screen recording because it is arithmetic rather than a frame rate.
 *
 * WHAT THAT COSTS, AND IT IS STATED ON THE RUN: a page whose layout responds
 * to viewport HEIGHT — a full-height hero, a sticky header, anything using
 * `100vh` — is drawn as it would look in a very tall window, which is not what
 * a visitor sees. It is the honest trade for having no CDP client, and it is
 * why the fold shot is taken at a real 1280×800 as well: the first thing the
 * reel shows is always the page as it actually looks.
 */
export async function shootPage(opts: {
  browser: string;
  url: string;
  dir: string;
  name: string;
  width: number;
  height: number;
  signal?: AbortSignal;
}): Promise<Shot> {
  mkdirSync(opts.dir, { recursive: true });
  const out = resolve(opts.dir, `${opts.name}.png`);
  rmSync(out, { force: true });
  const dir = profile();
  try {
    return await shoot(
      opts.browser,
      [
        ...baseArgs(dir, opts.width, opts.height, REMOTE_MS),
        /* Six seconds of virtual time, the same as a venture capture: enough
           for a framework to mount and for an intro animation to land. */
        "--virtual-time-budget=6000",
        `--screenshot=${out}`,
        opts.url,
      ],
      out,
      REMOTE_MS,
      opts.signal,
    );
  } finally {
    drop(dir);
  }
}
