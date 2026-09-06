/**
 * HEADLESS CHROME, DRIVEN FOR PICTURES RATHER THAN FOR PAGES.
 *
 * tools/chrome.ts owns "find a browser on this machine", "give it a profile of
 * its own and throw the profile away", "run it until the file it was asked for
 * stops growing, then kill it" and "get the actual fault out of its stderr".
 * NONE OF THAT IS REPEATED HERE any more — it was, byte for byte and with
 * three different flag sets, in four files. What is left in this file is the
 * part that is genuinely this area's: how big a sheet may be, and the two
 * things it points a browser at.
 *
 * WHY A LOCAL FILE AND NOT A DATA URL. Chrome treats a `data:` document as an
 * opaque origin with no base URL, which is survivable for a page with no
 * assets and is a trap the moment one is added; a file in the run's own
 * directory is also the thing somebody debugging a scene wants to open in a
 * real browser. The file is written next to the frames it produced and goes
 * when the run's directory goes.
 *
 * THE WINDOW SIZE IS BOUNDED AND THE BOUND IS NOT DECORATION. A screenshot is
 * a bitmap Chrome has to allocate: 8640x1920 is 66 megabytes of RGBA and works
 * on the machine this was measured on, and asking for four times that gets a
 * browser that either refuses or writes a truncated PNG with no error. So a
 * sheet's width is computed from a pixel budget rather than typed, and
 * `tilesPerSheet` below is the only place that arithmetic lives.
 *
 * A CAPTURE OF A VENTURE'S OWN SITE IS STILL A REQUEST TO SOMEBODY ELSE'S
 * SERVER, even when the somebody is the owner. It is made with the same flags
 * every other capture on this box uses — no sync, no crash reporting, no
 * component updates — and it is made once per page per run rather than once
 * per shot.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  baseArgs,
  findBrowser,
  shoot,
  withProfile,
  type Browser,
  type ShotResult,
} from "../../tools/chrome.ts";

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
 *  site and is given the same twenty-five seconds a venture capture allows. */
const LOCAL_MS = 20_000;
const REMOTE_MS = 25_000;

/** What both calls below answer with. The name is kept because the callers
 *  read it; the shape is the shared launcher's. */
export type Shot = ShotResult;

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
  return withProfile(
    (profile) =>
      shoot({
        bin: opts.browser,
        args: [
          ...baseArgs({
            profile,
            width: opts.width,
            height: opts.height,
            virtualTimeMs: 2_000,
            timeoutMs: LOCAL_MS,
          }),
          `--screenshot=${out}`,
          `file://${page}`,
        ],
        out,
        budgetMs: LOCAL_MS,
        signal: opts.signal,
      }),
    "vplus-",
  );
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
  return withProfile(
    (profile) =>
      shoot({
        bin: opts.browser,
        args: [
          /* The default virtual-time budget, which is a venture capture's:
             enough for a framework to mount and for an intro animation to
             land. */
          ...baseArgs({ profile, width: opts.width, height: opts.height, timeoutMs: REMOTE_MS }),
          `--screenshot=${out}`,
          opts.url,
        ],
        out,
        budgetMs: REMOTE_MS,
        signal: opts.signal,
      }),
    "vplus-",
  );
}
