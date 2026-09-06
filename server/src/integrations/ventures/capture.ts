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
 * have. The shot is the fold at SHOT_VIEWPORT, which is what a thumbnail wants
 * anyway.
 *
 * HOW THE BROWSER IS FOUND AND RUN IS NOT HERE — see tools/chrome.ts, the one
 * shared launcher, for ProcessSingleton locks, the browser that does not exit
 * on its own, and node's useless error message. What is left here is what a
 * CAPTURE is: which site, which row, which failures are worth telling the
 * owner about.
 *
 * A FAILED CAPTURE IS A ROW. "There is no picture yet", "Chrome is not
 * installed", "the page took longer than 25 seconds" and "the venture has no
 * website" are four different answers and the page has to be able to tell them
 * apart, which a nullable path on the ventures table could not.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { DATA_DIR } from "../../config.ts";
import {
  db,
  now,
  ventureRow,
  ventureRowById,
  ventureRows,
  writeVentureBrand,
  type VentureRow,
} from "../../db.ts";
import {
  CAPTURE_PLUGIN,
  RUN_MS,
  SHOT_VIEWPORT,
  VIRTUAL_TIME_MS,
  baseArgs,
  dump,
  findBrowser,
  imageDimensions,
  shoot,
  withProfile,
  type Browser,
} from "../../tools/chrome.ts";
import { assignRoles, type ColourCount } from "../../ventures/enrich.ts";

/* The browser lives in tools/chrome.ts now. These two are re-exported because
   other areas still ask this module for them and it is the venture capture
   they are asking about — seoops/brand.ts drives the same browser over CDP. */
export { CAPTURE_PLUGIN, findBrowser, SHOT_VIEWPORT, type Browser };

export const captureRoutes = new Hono();

export const SHOTS_DIR = resolve(DATA_DIR, "shots");

/** How many pictures of one venture are kept on disk. History rows outlive
 *  their files — the row says a capture happened, the file is the picture —
 *  and three is enough to see a redesign happen without keeping a year of
 *  half-megabyte PNGs. */
const KEEP_SHOTS = 3;

/** How stale a picture may get before the background pass takes another. */
export const REFRESH_DAYS = 7;

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
 * THE NEWEST CAPTURE OF A VENTURE, or the newest SUCCESSFUL one.
 *
 * EXPORTED, because this query was written out three times and the copies
 * already disagreed: one took the newest row, another added "path IS NOT NULL
 * AND error IS NULL" and took the newest successful one. So after a single
 * failed capture, one report printed "the last attempt failed" beside a
 * verdict on last week's perfectly good picture — two answers about one
 * venture in one document. `okOnly` makes the difference a PARAMETER the
 * caller states rather than a rule each copy re-decided.
 *
 * `brand_rendered IS NULL` is what keeps the two kinds of row in this table
 * apart, and it has to be here rather than left to the caller. A rebrand
 * writes a row with a rendered reading and no picture — which is exactly what
 * a FAILED capture looks like on every column but that one — and without this
 * clause the overview reported a successful DOM dump as "the last capture
 * failed, with no error". The column's own comment in 061 says NULL means "a
 * capture that did not dump"; this is the other side of that sentence.
 */
export function lastShot(ventureId: string, okOnly = false): ShotRow | undefined {
  return db
    .prepare(
      `SELECT * FROM venture_shots
        WHERE venture_id = ? AND brand_rendered IS NULL${okOnly ? " AND path IS NOT NULL AND error IS NULL" : ""}
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(ventureId) as ShotRow | undefined;
}

/** The newest rendered-DOM reading, which is the other kind of row here. */
export function lastRendered(ventureId: string): ShotRow | undefined {
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

  /* `shoot` waits on the FILE rather than on the process, because Chrome exits
     non-zero for things that have nothing to do with whether it took the
     picture and exits zero having written nothing when the page never loaded.
     tools/chrome.ts says why at length. */
  const res = await withProfile((profile) =>
    shoot({
      bin: browser.path,
      args: [...baseArgs({ profile, timeoutMs: RUN_MS }), `--screenshot=${file}`, v.website!],
      out: file,
    }),
  );

  /* THE FILE IS THE TEST, not the run's verdict: a page that painted and then
     hung past the wall-clock cap has still produced the picture, and throwing
     it away would be this code being right at the owner's expense. A file of
     zero bytes is not one — Chrome creates the output before it writes to it. */
  const bytes = existsSync(file) ? readFileSync(file) : null;
  if (!bytes?.length)
    return fail(
      res.error ?? "The browser ran and wrote no image, which usually means the page never loaded.",
      browser.path,
    );

  const size = imageDimensions(bytes);

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
      /* Where the path came from, because "found in one of the usual places"
         and "you typed this" are different claims and only one of them is the
         owner's. `known` is the former; it read `application` before the
         search moved into tools/find-binary.ts and stopped being macOS-shaped. */
      source: browser.source,
      error: browser.error,
      windowSize: `${SHOT_VIEWPORT.width}x${SHOT_VIEWPORT.height}`,
      note:
        "A capture is the top of the page at " +
        `${SHOT_VIEWPORT.width}x${SHOT_VIEWPORT.height} after ${VIRTUAL_TIME_MS / 1000}s of loading — not a ` +
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

  const res = await withProfile((profile) =>
    dump({
      bin: browser.path,
      args: [...baseArgs({ profile, timeoutMs: RUN_MS }), "--dump-dom", v.website!],
    }),
  );
  if (!res.html.trim())
    return c.json(
      { error: res.error ?? "The browser produced no DOM, which usually means the page never loaded." },
      200,
    );

  const reading = readRendered(res.html);
  const ts = now();
  db.prepare(
    `INSERT INTO venture_shots (venture_id, ts, path, bytes, width, height, brand_rendered, error)
     VALUES (?, ?, NULL, ?, NULL, NULL, ?, NULL)`,
  ).run(v.id, ts, res.html.length, JSON.stringify(reading));

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
    domBytes: res.html.length,
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
