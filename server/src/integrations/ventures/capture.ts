/**
 * WHAT THE SITE LOOKS LIKE — a headless browser, when the machine has one.
 *
 * This is the one thing on this box that DOES have a browser available and it
 * is worth saying why that does not contradict ventures/enrich.ts's header.
 * That file refuses to DEPEND on a browser: it is the path a venture is
 * created through, it runs on a Pi, and a create that needed a hundred and
 * fifty megabytes of Chromium installed would be a create that fails on the
 * machine this app is for. This is different in every one of those respects.
 * It is optional, it is never on the path of anything the owner is waiting
 * for, and when no browser is found it reports that in a sentence and does
 * nothing else. A screenshot is also the one thing text cannot substitute for:
 * a palette can be read out of CSS, and what the page LOOKS like cannot.
 *
 * NO PUPPETEER, NO DEPENDENCY, NO PROTOCOL. Chrome's own command line takes a
 * `--screenshot` and a `--dump-dom` and prints a PNG and a rendered DOM
 * respectively — which is the whole of what is wanted here. Driving it over
 * DevTools would buy scrolling, waiting on selectors and a full-page capture,
 * at the cost of a websocket client and a dependency this project does not
 * have. The window is 1280x800 and the shot is the fold, which is what a
 * thumbnail wants anyway.
 *
 * THE BROWSER IS FOUND RATHER THAN CONFIGURED, and then configurable. Four
 * macOS applications and four names on PATH are tried in order, because the
 * overwhelmingly likely case is that one of them is there and asking the owner
 * to type a path to a thing this code could have found is the kind of setup
 * step that makes a feature go unused. The config key exists for the case the
 * search cannot cover: a browser installed somewhere else, or a second one the
 * owner would rather this used.
 *
 * A FAILED CAPTURE IS A ROW. "There is no picture yet", "Chrome is not
 * installed", "the page took longer than 25 seconds" and "the venture has no
 * website" are four different answers and the page has to be able to tell them
 * apart, which a nullable path on the ventures table could not.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { DATA_DIR } from "../../config.ts";
import {
  configValue,
  db,
  now,
  ventureRow,
  ventureRowById,
  ventureRows,
  writeVentureBrand,
  type VentureRow,
} from "../../db.ts";
import { assignRoles, readBrand, type ColourCount } from "../../ventures/enrich.ts";

export const captureRoutes = new Hono();

/** The pseudo-plugin the browser path hangs off. `chat` and `models` do the
 *  same thing one layer up: plugin_config has a foreign key onto plugins, so a
 *  setting has to hang off something, and there is no `capture` integration. */
export const CAPTURE_PLUGIN = "capture";

export const SHOTS_DIR = resolve(DATA_DIR, "shots");

/** The whole run, wall clock. A page that has not painted in twenty-five
 *  seconds is a page whose picture is not worth the socket. */
const RUN_MS = 25_000;
/** Chrome's own budget for virtual time, i.e. how long the page is allowed to
 *  keep loading before the shot is taken. Six seconds is a slow site with
 *  fonts and a hero image. */
const VIRTUAL_TIME_MS = 6_000;
const WIDTH = 1280;
const HEIGHT = 800;

/** How many pictures of one venture are kept on disk. History rows outlive
 *  their files — the row says a capture happened, the file is the picture —
 *  and three is enough to see a redesign happen without keeping a year of
 *  half-megabyte PNGs. */
const KEEP_SHOTS = 3;

/** How stale a picture may get before the background pass takes another. */
export const REFRESH_DAYS = 7;

/* ------------------------------------------------------------- the browser */

/**
 * Where a headless-capable browser might be, in the order they are tried.
 *
 * Chrome first because it is what is installed on this machine and because
 * `--headless=new` is its flag; the Chromium builds accept the same one.
 */
const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const PATH_CANDIDATES = [
  "chromium",
  "google-chrome",
  "chromium-browser",
  "google-chrome-stable",
  "brave-browser",
];

function onPath(name: string): string | null {
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const d of dirs) {
    const full = resolve(d, name);
    try {
      if (existsSync(full) && statSync(full).isFile()) return full;
    } catch {
      /* an unreadable PATH entry is not this feature's problem */
    }
  }
  return null;
}

export type Browser =
  | { found: true; path: string; source: "configured" | "application" | "path"; error: null }
  | { found: false; path: null; source: "none"; error: string };

/**
 * The browser this box will use, and where the answer came from.
 *
 * A CONFIGURED PATH THAT DOES NOT EXIST IS AN ERROR RATHER THAN A FALLBACK.
 * Silently using Chrome when the owner typed a path to Brave would mean the
 * setting appears to work and does nothing, which is the exact failure the
 * settings registry's `check` exists to prevent one layer up.
 */
export function findBrowser(): Browser {
  const configured = (configValue(CAPTURE_PLUGIN, "chromium") ?? "").trim();
  if (configured) {
    if (existsSync(configured))
      return { found: true, path: configured, source: "configured", error: null };
    return {
      found: false,
      path: null,
      source: "none",
      error: `The browser configured under Capture — ${configured} — is not there.`,
    };
  }

  if (process.platform === "darwin")
    for (const p of MAC_CANDIDATES)
      if (existsSync(p)) return { found: true, path: p, source: "application", error: null };

  for (const name of PATH_CANDIDATES) {
    const p = onPath(name);
    if (p) return { found: true, path: p, source: "path", error: null };
  }

  return {
    found: false,
    path: null,
    source: "none",
    error:
      "No Chrome or Chromium was found. Looked in /Applications for Google " +
      "Chrome, Chromium, Brave and Edge, and on PATH for chromium, " +
      "google-chrome, chromium-browser, google-chrome-stable and brave-browser. " +
      "Install one, or set the path under the Capture settings.",
  };
}

/**
 * A profile directory of this run's own, made fresh and thrown away after.
 *
 * `--user-data-dir` IS LOAD-BEARING AND NOT TIDINESS: without it a headless
 * run reaches for the OWNER'S Chrome profile, which is locked while their
 * browser is open and which this has no business reading.
 *
 * ONE PER RUN RATHER THAN ONE SHARED, and that is not caution either — it is
 * what a shared one actually did on this machine. Chrome puts a
 * `ProcessSingleton` lock in a profile and refuses to start a second instance
 * against it: the screenshot and the DOM dump one minute later failed with
 * "Failed to create a ProcessSingleton for your profile directory. Aborting",
 * and a screenshot run that had already written its PNG hung on shutdown until
 * the 25-second kill. A directory per run cannot contend with itself, and it
 * costs Chrome's fresh-profile init — a second or two — which is a fraction of
 * the page load this is waiting for anyway.
 */
function profileDir(): string {
  const base = resolve(DATA_DIR, "chrome-profile");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(resolve(base, "run-"));
}

function dropProfile(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* A profile that will not delete costs a few megabytes until the next
       backup prune. It is not worth failing a capture over. */
  }
}

/** Chrome's flags, shared by the screenshot and the DOM dump. */
function baseArgs(profile: string): string[] {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`,
    `--virtual-time-budget=${VIRTUAL_TIME_MS}`,
    "--timeout=20000",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    /* Nothing this does needs the network except the page itself: no sync, no
       crash upload, no component updates on somebody else's dashboard. */
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
    `--user-data-dir=${profile}`,
  ];
  /* Chrome's sandbox refuses to start as root, which is how this runs on a
     server box and never how it runs on the owner's Mac. Added only in the
     case that needs it, because turning the sandbox off unconditionally would
     be doing it on the machine where it works. */
  if (typeof process.getuid === "function" && process.getuid() === 0)
    args.push("--no-sandbox");
  return args;
}

/**
 * RUN THE BROWSER, TAKE ITS OUTPUT, AND END IT.
 *
 * THE BROWSER DOES NOT EXIT ON ITS OWN, AND THAT IS THE WHOLE REASON THIS IS
 * NOT A `execFile` ONE-LINER. Measured on Google Chrome 152.0.7977.76 on
 * macOS, 2026-09-05: `--headless=new --screenshot=…` writes a complete, valid
 * PNG and then sits there; `--headless=new --dump-dom` prints a complete
 * document to stdout and then sits there. Both had to be killed. The old
 * `--headless` mode, which did exit, was removed from Chrome long before this
 * version. So waiting for the process is waiting for something that will not
 * happen, and the first version of this file did exactly that: every capture
 * took the full twenty-five-second cap and only worked because the PNG was
 * already on disk when the kill landed.
 *
 * WHAT IS WAITED FOR INSTEAD IS THE OUTPUT ITSELF, which is the thing that was
 * actually wanted:
 *
 *   a screenshot   the file appears, and its size stops changing between two
 *                  polls a quarter-second apart. A PNG is written in one pass,
 *                  so a size that has settled is a file that is finished.
 *   a DOM dump     stdout carries a `</html>` and then goes quiet for most of
 *                  a second. A document that has closed and stopped growing is
 *                  a document.
 *
 * Then the browser is killed on purpose, which is not a failure and is not
 * reported as one. The wall-clock cap is still there and still means what it
 * says: nothing was produced in time.
 */

/** How often the output is checked. */
const POLL_MS = 250;
/** How long stdout must be quiet before a dumped DOM is called finished. */
const QUIET_MS = 800;

type Run = { ok: boolean; stdout: string; error: string | null };

function run(
  bin: string,
  args: string[],
  want: { file: string } | { dom: true },
  maxBytes = 32 * 1024 * 1024,
): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(bin, args, { windowsHide: true });
    const deadline = Date.now() + RUN_MS;

    let out = "";
    let err = "";
    let lastOut = Date.now();
    let overflowed = false;
    let settled = false;
    let lastSize = -1;

    child.stdout.on("data", (b: Buffer) => {
      if (out.length + b.length > maxBytes) {
        overflowed = true;
        return;
      }
      out += b.toString("utf8");
      lastOut = Date.now();
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < 16_384) err += b.toString("utf8");
    });

    const finish = (result: Run) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
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

    const timer = setInterval(() => {
      if (Date.now() > deadline) {
        return finish({
          ok: false,
          stdout: out,
          error:
            `The browser produced nothing usable within ${RUN_MS / 1000} seconds — ` +
            (reason(err) ?? "the page was too slow, or never loaded."),
        });
      }
      if (overflowed)
        return finish({
          ok: false,
          stdout: out,
          error: `The page produced more than ${Math.round(maxBytes / 1024 / 1024)} MB of output, which is more than this reads.`,
        });

      if ("file" in want) {
        let size = -1;
        try {
          size = existsSync(want.file) ? statSync(want.file).size : -1;
        } catch {
          size = -1;
        }
        if (size > 0 && size === lastSize) return finish({ ok: true, stdout: out, error: null });
        lastSize = size;
        return;
      }

      if (out.includes("</html>") && Date.now() - lastOut > QUIET_MS)
        return finish({ ok: true, stdout: out, error: null });
    }, POLL_MS);

    /* A browser that DOES exit — a bad flag, a missing library, a future
       version that behaves — is honoured rather than waited out. */
    child.on("close", (code) => {
      const enough =
        "file" in want ? existsSync(want.file) : out.includes("</html>");
      if (enough) return finish({ ok: true, stdout: out, error: null });
      finish({
        ok: false,
        stdout: out,
        error: reason(err) ?? `The browser exited with code ${code} and produced nothing.`,
      });
    });

    child.on("error", (e) =>
      finish({ ok: false, stdout: out, error: `The browser could not be started — ${e.message}` }),
    );
  });
}

/**
 * The fault out of Chrome's stderr, or null.
 *
 * Chrome logs a line per subsystem on the way up and several of them are
 * ERRORs that mean nothing (a display link on a machine with no display, a
 * GPU it was told not to use). The LAST line is the one that stopped it — and
 * `err.message` from node is never it, because node's message is "Command
 * failed: " followed by three hundred characters of Chrome flags. That is not
 * a guess: the first version of this file reported exactly that truncated
 * command line and nothing else.
 */
function reason(stderr: string): string | null {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/cv_display_link_mac|CVDisplayLinkCreate|GPU|gpu_/i.test(l));
  const last = lines[lines.length - 1];
  if (!last) return null;
  /* Chrome prefixes every line with pid, tid, timestamp and source location.
     The sentence is after the last "] ". */
  const i = last.lastIndexOf("] ");
  return (i >= 0 ? last.slice(i + 2) : last).slice(0, 300);
}

/* ------------------------------------------------------------------ the PNG */

/**
 * A PNG's own idea of its size, from the IHDR chunk.
 *
 * Read rather than assumed, because the window size is what was ASKED for and
 * the file is what was produced — a device pixel ratio, a page that forced a
 * wider layout, or a Chrome that ignored the flag would all make the two
 * disagree, and the row should say what is in the file.
 */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;
  const u32 = (i: number) =>
    ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
  return { width: u32(16), height: u32(20) };
}

/* --------------------------------------------------------------- the rows */

export type ShotRow = {
  id: number;
  venture_id: string;
  ts: string;
  path: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  brand_rendered: string | null;
  error: string | null;
};

/**
 * The newest CAPTURE of a venture, or the newest successful one.
 *
 * `brand_rendered IS NULL` is what keeps the two kinds of row in this table
 * apart, and it has to be here rather than left to the caller. A rebrand
 * writes a row with a rendered reading and no picture — which is exactly what
 * a FAILED capture looks like on every column but that one — and without this
 * clause the overview reported a successful DOM dump as "the last capture
 * failed, with no error". The column's own comment in 061 says NULL means "a
 * capture that did not dump"; this is the other side of that sentence.
 */
function lastShot(ventureId: string, okOnly = false): ShotRow | undefined {
  return db
    .prepare(
      `SELECT * FROM venture_shots
        WHERE venture_id = ? AND brand_rendered IS NULL${okOnly ? " AND path IS NOT NULL AND error IS NULL" : ""}
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(ventureId) as ShotRow | undefined;
}

/** The newest rendered-DOM reading, which is the other kind of row here. */
function lastRendered(ventureId: string): ShotRow | undefined {
  return db
    .prepare(
      `SELECT * FROM venture_shots
        WHERE venture_id = ? AND brand_rendered IS NOT NULL
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(ventureId) as ShotRow | undefined;
}

/** Old pictures of one venture, deleted from disk. The ROWS stay: a capture
 *  that happened is a fact, and it does not stop being one when the bytes are
 *  reclaimed. `path` on a row whose file is gone reads as absent, which is
 *  what `GET .../shot` answers. */
function prunePictures(ventureId: string) {
  let files: string[];
  try {
    files = readdirSync(SHOTS_DIR).filter((f) => f.startsWith(`${ventureId}-`) && f.endsWith(".png"));
  } catch {
    return;
  }
  files.sort().reverse();
  for (const f of files.slice(KEEP_SHOTS)) {
    try {
      unlinkSync(resolve(SHOTS_DIR, f));
    } catch {
      /* a file already gone is the state this wanted */
    }
  }
}

/* -------------------------------------------------------------- capturing */

export type CaptureResult = {
  ok: boolean;
  ts: string;
  path: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  browser: string | null;
};

/**
 * One picture of one venture's site.
 *
 * Never throws. Every failure — no website, no browser, a browser that hung, a
 * file that was not written — is a row with an error on it and a document
 * saying which, because the only thing worse than no screenshot is a 500 on
 * the page that was going to show one.
 */
export async function captureVenture(v: VentureRow): Promise<CaptureResult> {
  const ts = now();
  const fail = (error: string, browser: string | null = null): CaptureResult => {
    db.prepare(
      `INSERT INTO venture_shots (venture_id, ts, path, bytes, width, height, brand_rendered, error)
       VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
    ).run(v.id, ts, error);
    return { ok: false, ts, path: null, bytes: null, width: null, height: null, error, browser };
  };

  if (!v.website)
    return fail(`${v.name} has no website to photograph. Add one and this has something to do.`);

  const browser = findBrowser();
  if (!browser.found) return fail(browser.error);

  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = resolve(SHOTS_DIR, `${v.id}-${ts.replace(/[:.]/g, "")}.png`);

  const profile = profileDir();
  const res = await run(
    browser.path,
    [...baseArgs(profile), `--screenshot=${file}`, v.website],
    { file },
  );
  dropProfile(profile);

  /* THE EXIT CODE IS NOT THE TEST — the file is. Chrome exits non-zero for
     things that have nothing to do with whether it took the picture (a GPU
     warning, a profile lock it recovered from), and it exits zero having
     written nothing when the page never loaded. */
  if (!existsSync(file))
    return fail(
      res.error ?? "The browser ran and wrote no image, which usually means the page never loaded.",
      browser.path,
    );

  const bytes = readFileSync(file);
  const size = pngSize(bytes);

  db.prepare(
    `INSERT INTO venture_shots (venture_id, ts, path, bytes, width, height, brand_rendered, error)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(v.id, ts, file, bytes.length, size?.width ?? null, size?.height ?? null);

  prunePictures(v.id);

  return {
    ok: true,
    ts,
    path: file,
    bytes: bytes.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
    error: null,
    browser: browser.path,
  };
}

/* --------------------------------------------------- the rendered reading */

/**
 * COLOURS OUT OF A RENDERED DOM.
 *
 * This is a COARSER reader than ventures/enrich.ts's and it is written out
 * again here rather than imported because that file exports its colour
 * ARITHMETIC — `assignRoles`, `isBrandable`, the thresholds tuned against real
 * sites — and not its scanner. The arithmetic is what mattered, and it is
 * reused; the scanning is thirty lines of regex over a string.
 *
 * WHAT IT SEES THAT THE STATIC READER CANNOT: whatever the page's JavaScript
 * wrote into the DOM after load — a styled-components block, a theme applied
 * from local storage, an inline style on a hero. WHAT IT DOES NOT SEE: linked
 * stylesheets, which are still just a `<link>` in a dumped DOM, and which the
 * static reader does fetch. They are two different windows onto one site,
 * which is why this one is stored beside the picture rather than over the top
 * of the other's answer.
 *
 * It resolves fewer notations than the static reader — `#rgb`, `#rrggbb` and
 * `rgb()/rgba()`, not `hsl()` and not named colours. A colour it misses is a
 * colour missing from THIS reading, and the document says the reading is the
 * rendered one.
 */
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_RE = /\brgba?\(([^)]{0,120})\)/g;
const VAR_RE = /(--[\w-]+)\s*:\s*([^;{}"']{0,200})/g;

function hex6(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v.startsWith("#")) return null;
  const d = v.slice(1);
  if (d.length === 3 || d.length === 4)
    return `#${d[0]}${d[0]}${d[1]}${d[1]}${d[2]}${d[2]}`.toUpperCase();
  if (d.length === 6 || d.length === 8) return `#${d.slice(0, 6)}`.toUpperCase();
  return null;
}

function rgbHex(inside: string): string | null {
  const parts = inside.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const n = parts.slice(0, 3).map((p) => {
    const v = p.endsWith("%") ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p);
    return Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : null;
  });
  if (n.some((v) => v === null)) return null;
  if (parts[3] !== undefined) {
    const a = parts[3].endsWith("%")
      ? Number.parseFloat(parts[3]) / 100
      : Number.parseFloat(parts[3]);
    /* Alpha is a filter rather than a blend, the rule enrich.ts states: a
       colour at 30% is that colour over something nothing here knows. */
    if (Number.isFinite(a) && a < 0.5) return null;
  }
  return `#${n.map((v) => v!.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function scan(css: string, kind: "var" | "css", out: ColourCount[]) {
  for (const m of css.matchAll(HEX_RE)) {
    const h = hex6(m[0]);
    if (h) out.push({ hex: h, n: 1, kind });
  }
  for (const m of css.matchAll(RGB_RE)) {
    const h = rgbHex(m[1] ?? "");
    if (h) out.push({ hex: h, n: 1, kind });
  }
}

export type RenderedReading = {
  readAt: string;
  source: "rendered DOM";
  title: string | null;
  palette: ReturnType<typeof assignRoles>;
  counts: number;
  notes: string[];
};

export function readRendered(html: string): RenderedReading {
  const counts: ColourCount[] = [];
  const notes: string[] = [];

  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]{0,200000}?)<\/style>/gi)) {
    const css = m[1] ?? "";
    for (const v of css.matchAll(VAR_RE)) scan(v[2] ?? "", "var", counts);
    scan(css, "css", counts);
  }
  for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]{0,600})"/gi)) {
    for (const v of (m[1] ?? "").matchAll(VAR_RE)) scan(v[2] ?? "", "var", counts);
    scan(m[1] ?? "", "css", counts);
  }

  if (!counts.length)
    notes.push(
      "The rendered DOM carries no colour of its own — everything it paints with " +
        "comes from a linked stylesheet, which a DOM dump does not inline.",
    );
  if (/<link\b[^>]*stylesheet/i.test(html))
    notes.push(
      "The page links at least one stylesheet, which is NOT part of this reading. " +
        "The venture's own `brand` is read from those; this is what the browser " +
        "found in the document after it ran.",
    );

  const title =
    /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1]?.trim().slice(0, 200) ?? null;

  return {
    readAt: now(),
    source: "rendered DOM",
    title: title || null,
    palette: assignRoles(counts),
    counts: counts.length,
    notes,
  };
}

/* ------------------------------------------------------------------ routes */

function ageDays(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? Math.round(((Date.now() - t) / 86_400_000) * 10) / 10 : null;
}

/**
 * The state of the whole feature: whether there is a browser at all, and what
 * each venture's newest picture is.
 */
captureRoutes.get("/", (c) => {
  const browser = findBrowser();
  const rows = ventureRows();

  return c.json({
    browser: {
      found: browser.found,
      path: browser.path,
      /* Where the path came from, because "found in /Applications" and "you
         typed this" are different claims and only one of them is the owner's. */
      source: browser.source,
      error: browser.error,
      windowSize: `${WIDTH}x${HEIGHT}`,
      note:
        "A capture is the top of the page at " +
        `${WIDTH}x${HEIGHT} after ${VIRTUAL_TIME_MS / 1000}s of loading — not a ` +
        "full-page scroll. The whole run is capped at " +
        `${RUN_MS / 1000}s.`,
    },
    refreshEveryDays: REFRESH_DAYS,
    ventures: rows.map((v) => {
      const last = lastShot(v.id);
      const ok = lastShot(v.id, true);
      return {
        id: v.id,
        slug: v.slug,
        name: v.name,
        website: v.website,
        last: last
          ? {
              ts: last.ts,
              ok: last.error === null && last.path !== null,
              bytes: last.bytes,
              width: last.width,
              height: last.height,
              error: last.error,
              ageDays: ageDays(last.ts),
            }
          : null,
        picture: ok
          ? {
              ts: ok.ts,
              ageDays: ageDays(ok.ts),
              onDisk: ok.path ? existsSync(ok.path) : false,
              url: `/api/capture/${v.slug}/shot`,
            }
          : null,
        /* The other kind of row in this table: a rendered-DOM reading from
           `POST .../rebrand`, which takes no picture and is not a capture. */
        rendered: (() => {
          const r = lastRendered(v.id);
          if (!r) return null;
          let reading: unknown = null;
          try {
            reading = JSON.parse(r.brand_rendered!);
          } catch {
            reading = null;
          }
          return { ts: r.ts, ageDays: ageDays(r.ts), domBytes: r.bytes, reading };
        })(),
        due: !v.website
          ? false
          : !ok || (ageDays(ok.ts) ?? Number.POSITIVE_INFINITY) >= REFRESH_DAYS,
      };
    }),
  });
});

captureRoutes.post("/:ventureKey", async (c) => {
  const v = ventureRow(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const res = await captureVenture(v);
  return c.json(
    { venture: { id: v.id, slug: v.slug, name: v.name, website: v.website }, ...res },
    res.ok ? 200 : 200,
  );
});

/**
 * The picture itself.
 *
 * 404 WITH A SENTENCE rather than an empty body: the caller is a page that has
 * to draw something, and "no browser is installed" and "this site has never
 * been captured" want different things drawn.
 */
captureRoutes.get("/:ventureKey/shot", (c) => {
  const v = ventureRow(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);

  const shot = lastShot(v.id, true);
  if (!shot?.path) {
    const last = lastShot(v.id);
    return c.json(
      {
        error: last?.error
          ? `The last capture of ${v.name} failed — ${last.error}`
          : `${v.name} has never been captured. POST /api/capture/${v.slug} to take one.`,
      },
      404,
    );
  }
  if (!existsSync(shot.path))
    return c.json(
      {
        error:
          `The picture taken on ${shot.ts} is no longer on disk — only the newest ` +
          `${KEEP_SHOTS} are kept. POST /api/capture/${v.slug} for a new one.`,
      },
      404,
    );

  const bytes = readFileSync(shot.path);
  return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, {
    "Content-Type": "image/png",
    "Content-Length": String(bytes.length),
    /* Private and short. The picture changes weekly and it is of the owner's
       own site, on a service bound to loopback. */
    "Cache-Control": "private, max-age=300",
  });
});

/**
 * Read the site again THROUGH THE BROWSER, and take its colour if the owner
 * has not chosen one.
 *
 * WHY THIS DOES NOT PATCH `/api/ventures/:key`. That route's `color` field
 * sets `color_source` to `owner` — it exists for the owner CHOOSING a colour —
 * so pushing a measured colour through it would file a measurement as a
 * decision, and no later reading could ever correct it. `writeVentureBrand` is
 * the sanctioned writer for exactly this: it stamps `site`, and it refuses
 * nothing because the caller decides whether the owner's choice is in play.
 *
 * THE `brand` BLOB IS PASSED THROUGH UNCHANGED. It belongs to
 * ventures/enrich.ts, it holds a favicon and a title this reading does not
 * have, and a coarser measurement must not overwrite a finer one. The rendered
 * reading is stored on the shot row instead.
 */
captureRoutes.post("/:ventureKey/rebrand", async (c) => {
  const v = ventureRow(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  if (!v.website)
    return c.json({ error: `${v.name} has no website to read.` }, 400);

  const browser = findBrowser();
  if (!browser.found) return c.json({ error: browser.error }, 400);

  const profile = profileDir();
  const res = await run(
    browser.path,
    [...baseArgs(profile), "--dump-dom", v.website],
    { dom: true },
  );
  dropProfile(profile);
  if (!res.stdout.trim())
    return c.json(
      { error: res.error ?? "The browser produced no DOM, which usually means the page never loaded." },
      200,
    );

  const reading = readRendered(res.stdout);
  const ts = now();
  db.prepare(
    `INSERT INTO venture_shots (venture_id, ts, path, bytes, width, height, brand_rendered, error)
     VALUES (?, ?, NULL, ?, NULL, NULL, ?, NULL)`,
  ).run(v.id, ts, res.stdout.length, JSON.stringify(reading));

  const primary = reading.palette.primary;
  let colourTaken: string | null = null;
  if (primary && v.color_source !== "owner") {
    writeVentureBrand(v.id, { host: v.host, brand: v.brand, color: primary });
    colourTaken = primary;
  }

  const after = ventureRowById(v.id) ?? v;
  return c.json({
    venture: { id: v.id, slug: v.slug, name: v.name },
    rendered: reading,
    domBytes: res.stdout.length,
    colourTaken,
    colorSource: after.color_source,
    color: after.color,
    brandUntouched: true,
    note:
      colourTaken
        ? `The rendered page's strongest brandable colour is ${colourTaken}, and it is now ` +
          "the venture's — recorded as measured from the site, not chosen."
        : v.color_source === "owner"
          ? `${v.name}'s colour is the owner's own choice, so no measurement may replace it.`
          : "No brandable colour survived the rendered reading, so the venture's colour is unchanged.",
    /* Said out loud because the obvious reading of "rebrand" is that it
       rewrote the brand, and it did not. */
    brandNote:
      "`ventures.brand` — the favicon, the title, the palette on the venture — is " +
      "read from the raw HTML and its stylesheets by ventures/enrich.ts and is NOT " +
      "touched here. This reading is the rendered DOM's, stored beside the capture.",
  });
});

/* ------------------------------------------------------------ the schedule */

let sweeping = false;

/**
 * The weekly refresh, checked hourly.
 *
 * HOURLY RATHER THAN WEEKLY, because a timer that fires once a week is a timer
 * that has never fired on a machine that is restarted more often than that.
 * The check is one indexed query per venture and the capture only happens when
 * the newest picture is actually a week old.
 *
 * SEQUENTIAL, for the reason index.ts's boot enrichment is: four Chromiums at
 * once on a small box is four page loads, four GPU-less renderers and a
 * hundred megabytes each, to save a minute of something nobody is waiting for.
 */
export function startCaptureTimer() {
  const tick = () => {
    if (sweeping) return;
    const browser = findBrowser();
    if (!browser.found) return;

    const due = ventureRows().filter((v) => {
      if (!v.website) return false;
      const ok = lastShot(v.id, true);
      const age = ageDays(ok?.ts);
      return age === null || age >= REFRESH_DAYS;
    });
    if (!due.length) return;

    sweeping = true;
    void (async () => {
      for (const v of due) {
        try {
          const res = await captureVenture(v);
          console.log(
            `[capture] ${v.host ?? v.website} — ${res.ok ? `${res.width}x${res.height}, ${res.bytes} bytes` : `failed: ${res.error}`}`,
          );
        } catch (err) {
          console.error(
            `[capture] ${v.id} — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      sweeping = false;
    })();
  };

  /* A minute after boot rather than at it: the boot enrichment pass in
     index.ts is already fetching four sites, and starting a browser on top of
     that is the one moment this box is busy. */
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 3_600_000).unref();
}

/** Used by the studio's prompt builder: the brand as the venture holds it. */
export const ventureBrand = (v: VentureRow) => readBrand(v.brand);
