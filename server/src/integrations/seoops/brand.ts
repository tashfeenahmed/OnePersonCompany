/**
 * WHAT A BRAND ACTUALLY LOOKS LIKE, MEASURED IN THE BROWSER THAT PAINTS IT.
 *
 * `ventures/enrich.ts` reads a brand out of the TEXT of a site — the HTML, the
 * `<style>` blocks, a few linked stylesheets, the favicon's pixels — and its
 * own header is unusually clear about what that costs: a colour declared in
 * CSS is counted whether or not anything is painted with it, a site whose
 * palette arrives from a bundled framework at runtime is invisible, and
 * `:root` scoping is not evaluated because a regex cannot. Those are three
 * different ways of being wrong about the same site, and every one of them is
 * fixed by asking the engine instead of the file.
 *
 * SO THIS RUNS ONE `Runtime.evaluate` IN THE BROWSER `capture.ts` ALREADY
 * FINDS, and asks for COMPUTED styles: what the body's background actually
 * resolved to, which colours are painted over how much AREA, what font the
 * headings really got, what the buttons are, and which image is the logo. It
 * is the reading workdash's `agent/branddna.js` took, on the browser this box
 * already has for screenshots.
 *
 * COLOURS ARE RANKED BY AREA AND NOT BY COUNT, which is the one place this
 * departs from both ancestors. A page with ninety little grey borders and one
 * full-bleed brand-coloured hero has ninety grey votes and one brand vote if
 * you count elements; measured in square pixels the hero wins, which is also
 * what a person means when they say what colour a site is.
 *
 * IT NEVER OVERWRITES THE STATIC READING. `ventures.brand` stays exactly what
 * enrich.ts measured; this lands in `brand_measured` with `method: rendered`
 * beside it, and the venture page shows both and says which is which. Static
 * parsing remains the fallback for a box with no browser, a site that will not
 * render, and every venture nobody opted in.
 *
 * WHY CDP AND NOT `--dump-dom`. capture.ts drives Chrome through its command
 * line, which can print a document and take a picture and cannot run a line of
 * script in the page — and computed styles exist only in a live document. The
 * DevTools protocol is the only door, so this opens one: a browser started
 * with `--remote-debugging-port=0`, its port read out of the profile
 * directory's own `DevToolsActivePort` file, and a WebSocket (Node's own,
 * global since 22 — no dependency) carrying four messages. It is about a
 * hundred lines and it is the whole difference between guessing and measuring.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { db, now, ventureRowById, type VentureRow } from "../../db.ts";
import { findBrowser } from "../ventures/capture.ts";
import { assignRoles, normaliseWebsite, type ColourCount, type Palette } from "../../ventures/enrich.ts";

/* -------------------------------------------------------------- the shape */

export type MeasuredFont = { tag: string; family: string; weight: number | null; sizePx: number | null };
export type MeasuredColour = { hex: string; kind: "bg" | "text" | "border" | "var"; area: number; share: number };
export type MeasuredLogo = { src: string; kind: "img" | "svg"; alt: string; score: number; widthPx: number | null };

export type MeasuredBrand = {
  method: "rendered";
  readAt: string;
  url: string;
  finalUrl: string | null;
  title: string | null;
  /** The body's own resolved font stack — what unstyled paragraph text got. */
  bodyFont: string | null;
  headingFont: string | null;
  fonts: MeasuredFont[];
  /** Ranked by painted area, largest first. */
  colours: MeasuredColour[];
  background: string | null;
  ink: string | null;
  buttons: { hex: string; n: number }[];
  logos: MeasuredLogo[];
  /** The roles, assigned by ventures/enrich.ts's own arithmetic so that a
   *  rendered palette and a static one mean the same words. */
  palette: Palette;
  elementsMeasured: number;
  notes: string[];
  error: string | null;
};

/* ------------------------------------------------------ the in-page script */

/**
 * ONE evaluate, one object back.
 *
 * Written as a plain string with no interpolation, because everything it needs
 * is a constant and a script assembled from variables is a script a reader has
 * to run in their head to know what the page will see.
 *
 * The caps are the cost control: 400 visible elements and the first 4000
 * pixels of scroll. A homepage with four thousand nodes has its palette in the
 * first four hundred visible ones, and a colour used only in a footer nobody
 * scrolls to is not what the brand looks like.
 */
const EXTRACT = String.raw`(() => {
  const abs = (u) => { try { return new URL(u, location.href).href } catch (e) { return null } };
  const hex = (v) => {
    const s = String(v == null ? "" : v).trim();
    const m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map((x) => parseFloat(x));
      if (p.length < 3 || p.slice(0,3).some((x) => !isFinite(x))) return null;
      /* Alpha is a FILTER and never a blend: a colour at 30% is that colour
         over something this cannot see, and blending it would invent a hex
         nothing on the page is painted with. enrich.ts's rule, verbatim. */
      if (p.length > 3 && p[3] < 0.5) return null;
      return "#" + p.slice(0, 3).map((n) => {
        const c = Math.max(0, Math.min(255, Math.round(n)));
        return (c < 16 ? "0" : "") + c.toString(16);
      }).join("").toUpperCase();
    }
    const h = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    if (!h) return null;
    const b = h[1];
    const full = b.length === 3 ? b.split("").map((c) => c + c).join("") : b;
    return "#" + full.toUpperCase();
  };

  const area = new Map();
  const bump = (v, kind, px) => {
    const h = hex(v);
    if (!h || !(px > 0)) return;
    const key = h + "|" + kind;
    area.set(key, (area.get(key) || 0) + px);
  };

  const notes = [];
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);

  /* Custom properties declared on :root, which are a DECLARATION of intent
     rather than one more painted pixel. They carry no area, so they are given
     the median painted area at the end rather than competing with a hero. */
  const vars = [];
  try {
    for (let i = 0; i < rootStyle.length && vars.length < 120; i++) {
      const name = rootStyle.item(i);
      if (!name || !name.startsWith("--")) continue;
      const value = String(rootStyle.getPropertyValue(name) || "").trim().slice(0, 80);
      const h = hex(value);
      if (h) vars.push({ name: name.slice(0, 60), hex: h });
    }
  } catch (e) { notes.push("this engine would not enumerate the custom properties on :root"); }

  let counted = 0;
  let skippedHidden = 0;
  const els = document.body ? Array.from(document.body.querySelectorAll("*")) : [];
  for (const el of els) {
    if (counted >= 400) break;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (e) { continue }
    if (!rect || rect.width < 4 || rect.height < 4) continue;
    if (rect.top + window.scrollY > 4000) continue;
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue }
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) { skippedHidden++; continue }
    counted++;
    const px = Math.round(rect.width * rect.height);
    bump(cs.backgroundColor, "bg", px);
    const hasText = Array.from(el.childNodes || []).some((n) => n.nodeType === 3 && String(n.nodeValue).trim().length > 1);
    /* Text is painted over a fraction of its box. A tenth is a coarse stand-in
       for glyph coverage and it is stated rather than pretended to be exact. */
    if (hasText) bump(cs.color, "text", Math.round(px / 10));
    if (parseFloat(cs.borderTopWidth) > 0) bump(cs.borderTopColor, "border", Math.round(rect.width * parseFloat(cs.borderTopWidth)));
  }

  const bodyStyle = document.body ? getComputedStyle(document.body) : rootStyle;
  const pageBg = hex(bodyStyle.backgroundColor) || hex(rootStyle.backgroundColor);
  const pageInk = hex(bodyStyle.color) || hex(rootStyle.color);

  const fonts = [];
  const seenFont = new Set();
  for (const tag of ["h1", "h2", "h3", "p", "li", "button", "a"]) {
    for (const el of Array.from(document.querySelectorAll(tag)).slice(0, 5)) {
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { continue }
      const family = String(cs.fontFamily || "").slice(0, 200);
      const key = tag + "|" + family;
      if (seenFont.has(key)) continue;
      seenFont.add(key);
      fonts.push({ tag, family, weight: parseInt(cs.fontWeight, 10) || null, sizePx: parseFloat(cs.fontSize) || null });
    }
  }

  /* Buttons, because a button's background is the one colour a brand chooses
     on purpose and paints on almost nothing — it loses every area contest and
     is usually the answer. */
  const buttons = new Map();
  const buttonish = Array.from(document.querySelectorAll("button, [role=button], input[type=submit], a.btn, a.button")).slice(0, 40);
  for (const el of buttonish) {
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { continue }
    const h = hex(cs.backgroundColor);
    if (!h) continue;
    buttons.set(h, (buttons.get(h) || 0) + 1);
  }

  const logos = [];
  const scoreOf = (hay, el, rect) => {
    let score = 0;
    if (/logo|wordmark|brandmark|\bmark\b/.test(hay)) score += 4;
    if (/icon|favicon/.test(hay)) score += 1;
    /* Somebody ELSE'S logo. A page of "works with" tiles is a page full of
       images whose alt text says "logo". */
    if (/maker|partner|customer|client|integration|sponsor|badge|avatar|testimonial|review|press/.test(hay)) score -= 4;
    if (el.closest && el.closest("header, nav, [role=banner]")) score += 2;
    const link = el.closest && el.closest("a");
    if (link) {
      const href = link.getAttribute("href");
      if (href === "/" || href === "#" || href === location.origin + "/") score += 2;
    }
    if (rect && rect.top + window.scrollY < 200) score += 2;
    if (rect && rect.width >= 20 && rect.width <= 400) score += 1;
    if (rect && (rect.width < 12 || rect.height < 12)) score -= 4;
    return score;
  };
  for (const img of Array.from(document.images || []).slice(0, 60)) {
    const src = abs(img.currentSrc || img.src);
    if (!src) continue;
    /* Data URIs are inlined sprites and tracking pixels far more often than
       they are logos, and a 200 KB one would be carried into the row. */
    if (src.startsWith("data:")) continue;
    const alt = String(img.alt || "").slice(0, 120);
    const hay = (alt + " " + String(img.className || "") + " " + src + " " + String(img.id || "")).toLowerCase();
    let rect = null;
    try { rect = img.getBoundingClientRect(); } catch (e) { rect = null }
    const score = scoreOf(hay, img, rect);
    if (score <= 0) continue;
    logos.push({ src: src.slice(0, 400), kind: "img", alt, score, widthPx: rect ? Math.round(rect.width) : null });
  }
  for (const svg of Array.from(document.querySelectorAll("svg")).slice(0, 40)) {
    const alt = String(svg.getAttribute("aria-label") || (svg.querySelector("title") ? svg.querySelector("title").textContent : "") || "").slice(0, 120);
    const hay = (alt + " " + String(svg.getAttribute("class") || "") + " " + String(svg.id || "")).toLowerCase();
    let rect = null;
    try { rect = svg.getBoundingClientRect(); } catch (e) { rect = null }
    /* AN INLINE SVG IS USUALLY AN ICON. Measured on a real site: a header full
       of 16px lucide icons scores two points each just for being in a header,
       and the top-scoring "logo" came back as a chevron. So an SVG has to
       either SAY it is a mark, or be too big to be an icon; and nothing under
       24 pixels is a candidate at all. An <img> keeps the looser rule because
       a file name and an alt attribute are real evidence and an icon sprite
       rarely has either. */
    if (!rect || rect.width < 24 || rect.height < 24) continue;
    if (!/logo|wordmark|brandmark|\bmark\b/.test(hay) && rect.width < 60) continue;
    const score = scoreOf(hay, svg, rect);
    if (score <= 0) continue;
    /* An inline SVG has no src. Its OUTER HTML is the mark, capped, because a
       500 KB illustration is not a logo and is not worth carrying. */
    const markup = String(svg.outerHTML || "");
    if (markup.length > 20000) continue;
    logos.push({ src: markup.slice(0, 4000), kind: "svg", alt, score, widthPx: rect ? Math.round(rect.width) : null });
  }
  logos.sort((a, b) => b.score - a.score);

  const colours = Array.from(area.entries())
    .map(([key, px]) => ({ hex: key.split("|")[0], kind: key.split("|")[1], area: px }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 24);

  if (!counted) notes.push("the browser rendered the document and found no visible element with a box in it — a page that had not painted when this ran");
  if (!logos.length) notes.push("no logo candidate survived: an inline SVG has to name itself a logo or be wider than 60 pixels, and nothing under 24 pixels is considered at all");
  if (skippedHidden) notes.push(skippedHidden + " element(s) were hidden and were not counted");

  return {
    title: document.title ? String(document.title).slice(0, 200) : null,
    finalUrl: location.href,
    bodyFont: String(bodyStyle.fontFamily || "").slice(0, 200) || null,
    pageBg, pageInk,
    colours,
    vars: vars.slice(0, 40),
    fonts,
    buttons: Array.from(buttons.entries()).map(([hex, n]) => ({ hex, n })),
    logos: logos.slice(0, 6),
    counted,
    notes,
  };
})()`;

/* ------------------------------------------------------------- the browser */

/** The whole run, wall clock. capture.ts's 25 s, for its reason: a page that
 *  has not painted in twenty-five seconds is not going to. */
const RUN_MS = 25_000;
/** How long the port file is waited for. Chrome's fresh-profile init is a
 *  second or two on a warm machine and longer on a cold one. */
const PORT_MS = 15_000;
/** After the load event, how long the page is given to finish painting. Some
 *  frameworks paint on the frame after load. */
const SETTLE_MS = 1_200;
const WIDTH = 1280;
const HEIGHT = 800;

function profileDir(): string {
  const base = resolve(DATA_DIR, "chrome-profile");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(resolve(base, "cdp-"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The port Chrome chose, out of the file it writes into its own profile. Not
 *  a fixed port: two of these must be able to run at once, and a fixed one is
 *  a collision waiting for the day somebody presses two buttons. */
async function waitForPort(profile: string, deadline: number, failed?: () => boolean): Promise<number | null> {
  const file = resolve(profile, "DevToolsActivePort");
  while (Date.now() < deadline) {
    /* A browser that never started will never write the file, and waiting
       fifteen seconds to be told so is fifteen seconds of a request hanging. */
    if (failed?.()) return null;
    if (existsSync(file)) {
      try {
        const first = readFileSync(file, "utf8").split("\n")[0]?.trim();
        const port = Number(first);
        if (Number.isInteger(port) && port > 0) return port;
      } catch {
        /* Written between the exists check and the read. Try again. */
      }
    }
    await sleep(120);
  }
  return null;
}

/** A minimal DevTools client: send a command, await its id. Four messages is
 *  the whole conversation, so this is a Map of pending resolvers and nothing
 *  more — an event router would be machinery bought with nothing. */
type Cdp = {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;
  close: () => void;
};

async function connect(wsUrl: string, deadline: number): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, { ok: (v: Record<string, unknown>) => void; no: (e: Error) => void }>();
  let id = 0;

  /* THE SOCKET IS CLOSED ON EVERY PATH OUT OF THE OPEN, including the two that
     throw. It was harmless before only because the browser is killed a moment
     later, and "harmless because something else cleans up" is how a handle
     leak survives until the day that something else changes. */
  const closeSocket = () => {
    try {
      ws.close();
    } catch {
      /* Already gone. */
    }
  };
  await new Promise<void>((ok, no) => {
    const timer = setTimeout(() => {
      closeSocket();
      no(new Error("the browser's DevTools socket did not open in time"));
    }, Math.max(1, deadline - Date.now()));
    ws.addEventListener("open", () => { clearTimeout(timer); ok(); }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      closeSocket();
      no(new Error("the browser's DevTools socket refused the connection"));
    }, { once: true });
  });

  ws.addEventListener("message", (ev) => {
    let doc: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      doc = JSON.parse(String((ev as MessageEvent).data)) as typeof doc;
    } catch {
      return;
    }
    if (typeof doc.id !== "number") return; // an event, which nothing here waits on
    const waiter = pending.get(doc.id);
    if (!waiter) return;
    pending.delete(doc.id);
    if (doc.error) waiter.no(new Error(doc.error.message ?? "the browser refused that command"));
    else waiter.ok(doc.result ?? {});
  });

  return {
    send(method, params = {}, sessionId) {
      const messageId = ++id;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        /* Every command carries the RUN's deadline rather than one of its own:
           a page that hangs must not be able to buy another twenty-five
           seconds per message. */
        const timer = setTimeout(() => {
          if (pending.delete(messageId)) reject(new Error(`${method} did not answer in time`));
        }, Math.max(1, deadline - Date.now()));
        pending.set(messageId, {
          ok: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          no: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        ws.send(JSON.stringify(sessionId ? { id: messageId, method, params, sessionId } : { id: messageId, method, params }));
      });
    },
    close: closeSocket,
  };
}

export type RawReading = {
  title: string | null;
  finalUrl: string | null;
  bodyFont: string | null;
  pageBg: string | null;
  pageInk: string | null;
  colours: { hex: string; kind: string; area: number }[];
  vars: { name: string; hex: string }[];
  fonts: MeasuredFont[];
  buttons: { hex: string; n: number }[];
  logos: MeasuredLogo[];
  counted: number;
  notes: string[];
  /** Set by the driver, not by the page: whether the extractor ran in an
   *  isolated world. The page cannot forge it — it is written over whatever
   *  came back. */
  isolated?: boolean;
};

/**
 * DRIVE THE BROWSER ONCE AND BRING BACK ONE OBJECT.
 *
 * Never throws: every failure comes back as `{ error }` in words, because this
 * is called from a venture page and from a background pass and neither of them
 * should be able to fail on a site being slow.
 */
export async function evaluateInBrowser(url: string): Promise<{ raw: RawReading } | { error: string }> {
  const browser = findBrowser();
  if (!browser.found) return { error: browser.error };

  const deadline = Date.now() + RUN_MS;
  /* MAKING THE PROFILE IS THE FIRST THING THAT CAN THROW and it used to do it
     OUTSIDE the try, which made the doc comment above a lie: an unwritable
     DATA_DIR came out of here as a 500 rather than as a sentence. */
  let profile: string;
  try {
    profile = profileDir();
  } catch (err) {
    return {
      error: `A profile directory for the browser could not be made: ${
        err instanceof Error ? err.message.slice(0, 160) : "unknown error"
      }`,
    };
  }
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ];
  /* Chrome's sandbox refuses to start as root, which is how this runs on a
     server box and never on the owner's Mac. capture.ts's rule and its
     reason. */
  if (typeof process.getuid === "function" && process.getuid() === 0) args.splice(1, 0, "--no-sandbox");

  const child = spawn(browser.path, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => {
    if (stderr.length < 4000) stderr += b.toString();
  });

  /*
    AN UNHANDLED 'error' ON A ChildProcess TAKES THE SERVER WITH IT.

    `findBrowser()` only checks that the path EXISTS, so a Capture setting
    pointing at a directory, or at a file with no execute bit, spawns fine and
    then emits EISDIR/EACCES asynchronously. An EventEmitter with no `error`
    listener rethrows that as an uncaught exception and this process exits —
    the whole API, over a mistyped setting. capture.ts handles exactly this and
    so does this now: the failure becomes the run's own sentence, and the
    waiter below stops waiting for a port that will never be published.
  */
  let spawnError: string | null = null;
  let onSpawnFailure: (() => void) | null = null;
  child.on("error", (err: Error) => {
    spawnError = `The browser at ${browser.path} could not be started: ${err.message.slice(0, 160)}`;
    onSpawnFailure?.();
  });

  const stop = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* Already gone. */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* A profile that will not delete costs a few megabytes. */
    }
  };

  let cdp: Cdp | null = null;
  /* Set so the `error` listener above has something to poke. It only shortens
     the wait; `spawnError` being non-null is what actually ends it. */
  onSpawnFailure = () => undefined;
  try {
    const port = await waitForPort(profile, Math.min(deadline, Date.now() + PORT_MS), () => spawnError !== null);
    if (spawnError !== null) {
      stop();
      return { error: spawnError };
    }
    if (port === null) {
      stop();
      return {
        error:
          "The browser started and never published a DevTools port. " +
          (stderr.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? "It wrote nothing to stderr either."),
      };
    }

    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5_000) })).json()) as {
      webSocketDebuggerUrl?: string;
    };
    if (!version.webSocketDebuggerUrl) {
      stop();
      return { error: "The browser published a DevTools port with no websocket url on it." };
    }

    cdp = await connect(version.webSocketDebuggerUrl, deadline);

    /* NO `width`/`height` HERE. Measured on Google Chrome 152 (macOS,
       2026-09-06): passing them to `Target.createTarget` on a tab that is not
       a new WINDOW is refused with "Target position can only be set for new
       windows", and the whole read fails. The viewport is set below through
       Emulation instead, which is the thing that actually decides what
       `getBoundingClientRect` returns. */
    const target = (await cdp.send("Target.createTarget", { url: "about:blank" })) as {
      targetId?: string;
    };
    if (!target.targetId) {
      stop();
      return { error: "The browser would not open a tab to load the page in." };
    }
    const attached = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as {
      sessionId?: string;
    };
    const session = attached.sessionId;
    if (!session) {
      stop();
      return { error: "The browser opened a tab and would not attach to it." };
    }

    await cdp.send("Page.enable", {}, session);
    /* THE VIEWPORT IS THE MEASUREMENT'S UNIT. Colours are ranked by painted
       AREA, so a tab that opened at some default size would rank a different
       set of colours than the 1280x800 the screenshots are taken at. Set
       explicitly, and best-effort: a Chromium that will not emulate still
       gives a usable reading at whatever size it chose, and the notes on the
       reading say how many elements it saw. */
    await cdp
      .send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, session)
      .catch(() => undefined);
    await cdp.send("Page.navigate", { url }, session);
    /* The load event is not awaited as an EVENT: this client routes replies
       and ignores events on purpose (four messages is the whole
       conversation). Instead the document's readiness is polled, which is the
       same fact asked a different way and is correct for a page that finished
       loading before the poll started. */
    const settleBy = Math.min(deadline - SETTLE_MS, Date.now() + 18_000);
    for (;;) {
      if (Date.now() > settleBy) break;
      const state = (await cdp.send(
        "Runtime.evaluate",
        { expression: "document.readyState", returnByValue: true },
        session,
      )) as { result?: { value?: unknown } };
      if (state.result?.value === "complete") break;
      await sleep(250);
    }
    await sleep(SETTLE_MS);

    /*
      THE EXTRACTOR RUNS IN AN ISOLATED WORLD, NOT IN THE PAGE'S OWN.

      This drives a real browser at a URL the box did not write, with
      JavaScript enabled. In the main world the page owns every global the
      script leans on: redefine `getComputedStyle`, `Array.from`,
      `Array.prototype.push`, `document.title` or `JSON` and every field that
      comes back is the site's to choose — including the `notes` array, which
      would then be the site writing sentences into the owner's dashboard. An
      isolated world shares the DOM and nothing else: same document, same
      computed styles, its own copy of every intrinsic.

      IT IS NOT THE ONLY DEFENCE and must not be treated as one. `shapeReading`
      validates every field that comes back regardless, because a page still
      controls what the DOM SAYS — an element really can be called
      `url(http://…)` — and a hex that is stored raw ends up in a `style`
      attribute on the venture page.

      BEST EFFORT, because it is not worth losing the reading over: a Chromium
      that will not create one is used in the main world with the validation
      still standing, and the reading says which world it came from.
      */
    let contextId: number | null = null;
    try {
      const frame = (await cdp.send("Page.getFrameTree", {}, session)) as {
        frameTree?: { frame?: { id?: string } };
      };
      const frameId = frame.frameTree?.frame?.id;
      if (frameId) {
        const world = (await cdp.send(
          "Page.createIsolatedWorld",
          { frameId, worldName: "opc-brand-reader", grantUniveralAccess: false },
          session,
        )) as { executionContextId?: number };
        if (typeof world.executionContextId === "number") contextId = world.executionContextId;
      }
    } catch {
      /* No isolated world on this build. The validation below still stands. */
    }

    const evaluated = (await cdp.send(
      "Runtime.evaluate",
      {
        expression: EXTRACT,
        returnByValue: true,
        awaitPromise: true,
        ...(contextId === null ? {} : { contextId }),
      },
      session,
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };

    if (evaluated.exceptionDetails) {
      stop();
      return { error: `The reading script threw in the page: ${String(evaluated.exceptionDetails.text ?? "no detail").slice(0, 200)}` };
    }
    const value = evaluated.result?.value;
    if (!value || typeof value !== "object") {
      stop();
      return { error: "The reading script returned nothing the browser could hand back." };
    }
    return { raw: { ...(value as RawReading), isolated: contextId !== null } };
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 240) : "The browser could not be driven." };
  } finally {
    cdp?.close();
    stop();
  }
}

/* ------------------------------------------------------------ the reading */

/**
 * THE RAW OBJECT, SHAPED — and the roles assigned by enrich.ts's OWN
 * arithmetic.
 *
 * `assignRoles` is imported rather than reimplemented because its thresholds
 * (near-white, pale, murk, the 25-degree hue gap) were tuned against live
 * sites, and a second implementation would drift into a second brand. What is
 * fed into it is different, which is the point: painted AREA in place of a
 * count of declarations, so the votes come from what the page looks like.
 *
 * A custom property is given the MEDIAN painted area rather than a fixed
 * weight, because area and count are not the same unit and mixing them by
 * multiplying would put a `--brand` on a par with a full-bleed hero for
 * reasons nobody could reconstruct. The median is "as much as an ordinary
 * painted thing", which is what a declaration of intent is worth here.
 */
/* ------------------------------------------------- validating the reading */

/*
  EVERYTHING BELOW THIS LINE TREATS THE BROWSER'S ANSWER AS HOSTILE INPUT, and
  it is the second of two defences rather than a substitute for the first.

  The extractor runs in an isolated world, so the page cannot redefine the
  intrinsics it leans on. What the page STILL controls is what the DOM SAYS: an
  element's class really can be `url(http://attacker/beacon)`, a font-family
  can be a paragraph, a title can be a megabyte. Those come back as honest
  readings of a hostile document — and one of them, a colour, is written into a
  `style` attribute on the venture page, where `background: url(http://...)` is
  a live request fired from the owner's dashboard every time they open the tab.

  So each field is checked against what it IS rather than trusted for where it
  came from: a colour is six hex digits or it is dropped, a font name is
  bounded and stripped of `url(` and parentheses, a count is a finite
  non-negative number, a logo source is an http(s) url. A value that fails is
  LEFT OUT and counted in a note, never sanitised into something the page did
  not say.
*/

const HEX_STRICT = /^#[0-9A-F]{6}$/;
/** Control characters, which have no business in anything read off a page. */
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** A measured hex, or null. Upper-cased first, because the extractor emits
 *  upper case and a lower-case one from a future edit is the same colour. */
export function safeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toUpperCase();
  return HEX_STRICT.test(hex) ? hex : null;
}

/**
 * A font stack, bounded and disarmed.
 *
 * `url(` and parentheses go because a font-family is rendered as text beside a
 * colour swatch and is pasted into prompts; a family carrying a url is either a
 * page playing games or a stylesheet this reader has no business quoting.
 * Empty after all that is null, not "".
 */
export function safeFontName(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(CONTROL, " ")
    .replace(/url\s*\(/gi, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned || null;
}

/** Any other text the page supplied — a title, an alt, a note. The same
 *  treatment minus the url stripping, which would mangle a real title. */
export function safeText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return cleaned || null;
}

/** A finite, non-negative number, or null. `Infinity` and `-1` are both things
 *  a page can make `getBoundingClientRect` return. */
export function safeCount(value: unknown, max = 1e12): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(value, max);
}

/** An http(s) url the venture page may render as an href or an <img src>, or
 *  null. `javascript:` and `data:` are refused rather than cleaned. */
export function safeAssetUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().slice(0, 400);
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * TAKE THE BROWSER'S OBJECT AND KEEP ONLY WHAT IS THE RIGHT SHAPE.
 *
 * Exported so the rules above can be asserted against a fabricated hostile
 * reading, which is the only way to test them — the alternative is a malicious
 * website.
 */
export function validateRaw(input: unknown): { raw: RawReading; dropped: string[] } {
  const dropped: string[] = [];
  const src = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const arr = (v: unknown, cap: number): unknown[] => (Array.isArray(v) ? v.slice(0, cap) : []);
  const obj = (v: unknown): Record<string, unknown> =>
    (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;

  const colours: RawReading["colours"] = [];
  for (const item of arr(src.colours, 60)) {
    const c = obj(item);
    const hex = safeHex(c.hex);
    const area = safeCount(c.area);
    if (!hex || area === null) {
      dropped.push("a colour that was not six hex digits with a finite area");
      continue;
    }
    const kind = typeof c.kind === "string" && ["bg", "text", "border", "var"].includes(c.kind) ? c.kind : "bg";
    colours.push({ hex, kind, area });
  }

  const vars: RawReading["vars"] = [];
  for (const item of arr(src.vars, 60)) {
    const v = obj(item);
    const hex = safeHex(v.hex);
    if (!hex) {
      dropped.push("a custom property whose value was not a hex colour");
      continue;
    }
    vars.push({ name: safeFontName(v.name, 60) ?? "--", hex });
  }

  const buttons: RawReading["buttons"] = [];
  for (const item of arr(src.buttons, 20)) {
    const b = obj(item);
    const hex = safeHex(b.hex);
    if (!hex) {
      dropped.push("a button colour that was not six hex digits");
      continue;
    }
    buttons.push({ hex, n: Math.max(1, Math.round(safeCount(b.n, 1000) ?? 1)) });
  }

  const fonts: MeasuredFont[] = [];
  for (const item of arr(src.fonts, 40)) {
    const f = obj(item);
    const family = safeFontName(f.family);
    const tag = safeText(f.tag, 20);
    if (!family || !tag) {
      dropped.push("a font row with no usable family or tag");
      continue;
    }
    const weight = safeCount(f.weight, 1000);
    fonts.push({
      tag,
      family,
      weight: weight === null ? null : Math.round(weight),
      sizePx: safeCount(f.sizePx, 10_000),
    });
  }

  const logos: MeasuredLogo[] = [];
  for (const item of arr(src.logos, 10)) {
    const l = obj(item);
    const kind = l.kind === "svg" ? "svg" : "img";
    /* An <img> logo becomes an href and an <img src> on the venture page, so it
       has to be a real http(s) url. An inline SVG is markup and is kept as
       TEXT — it is never injected as HTML anywhere; the page shows the string. */
    const source = kind === "img" ? safeAssetUrl(l.src) : safeText(l.src, 4000);
    if (!source) {
      dropped.push("a logo candidate with no usable source");
      continue;
    }
    const width = safeCount(l.widthPx, 100_000);
    logos.push({
      src: source,
      kind,
      alt: safeText(l.alt, 120) ?? "",
      score: Math.round(safeCount(l.score, 100) ?? 0),
      widthPx: width === null ? null : Math.round(width),
    });
  }

  const notes: string[] = [];
  for (const n of arr(src.notes, 12)) {
    const text = safeText(n, 300);
    if (text) notes.push(text);
  }

  return {
    raw: {
      title: safeText(src.title, 200),
      /* The final url is a claim about where the browser LANDED and it is shown
         to the owner, so it gets the same treatment as any other url here. */
      finalUrl: safeAssetUrl(src.finalUrl),
      bodyFont: safeFontName(src.bodyFont),
      pageBg: safeHex(src.pageBg),
      pageInk: safeHex(src.pageInk),
      colours,
      vars,
      fonts,
      buttons,
      logos,
      counted: Math.round(safeCount(src.counted, 100_000) ?? 0),
      notes,
      /* Written by the DRIVER after the evaluate, never by the page. */
      isolated: src.isolated === true,
    },
    dropped,
  };
}

export function shapeReading(url: string, input: RawReading | unknown): MeasuredBrand {
  /* VALIDATED FIRST, ALWAYS. This function is exported and is the only door
     into the stored document, so the check lives here rather than at the one
     call site that happens to exist today. */
  const { raw, dropped } = validateRaw(input);
  const notes = [...raw.notes];
  const areas = raw.colours.map((c) => c.area).filter((n) => n > 0).sort((a, b) => a - b);
  const median = areas.length ? areas[Math.floor(areas.length / 2)]! : 1;

  const counts: ColourCount[] = [];
  for (const c of raw.colours) counts.push({ hex: c.hex, n: Math.max(1, Math.round(c.area)), kind: "css" });
  for (const v of raw.vars) counts.push({ hex: v.hex, n: Math.max(1, median), kind: "var" });
  /* A button background is a colour a brand chose and paints on almost
     nothing. Given the median too, for the same reason a var is. */
  for (const b of raw.buttons) counts.push({ hex: b.hex, n: Math.max(1, median) * Math.max(1, b.n), kind: "var" });

  const totalArea = raw.colours.reduce((n, c) => n + c.area, 0);
  const colours: MeasuredColour[] = raw.colours.slice(0, 12).map((c) => ({
    hex: c.hex,
    kind: c.kind as MeasuredColour["kind"],
    area: c.area,
    share: totalArea ? Number(((c.area / totalArea) * 100).toFixed(1)) : 0,
  }));

  const headingFont = raw.fonts.find((f) => f.tag === "h1" || f.tag === "h2")?.family ?? null;

  if (!raw.vars.length)
    notes.push(
      "The page declares no colour custom properties on :root that this engine would enumerate, so every colour below was measured off something painted.",
    );
  if (!raw.buttons.length)
    notes.push("No button-shaped element was found, so no button colour is in the ranking.");
  if (raw.isolated === false)
    notes.push(
      "This browser would not create an isolated world, so the reading script ran in the page's own. Every field was still checked for shape, but a page that rewrites its own intrinsics could have chosen what was measured.",
    );
  if (dropped.length)
    notes.push(
      `${dropped.length} value(s) the browser returned were not the right shape and were dropped: ${[...new Set(dropped)].slice(0, 3).join("; ")}.`,
    );

  return {
    method: "rendered",
    readAt: now(),
    url,
    finalUrl: raw.finalUrl,
    title: raw.title,
    bodyFont: raw.bodyFont,
    headingFont,
    fonts: raw.fonts,
    colours,
    background: raw.pageBg,
    ink: raw.pageInk,
    buttons: raw.buttons,
    logos: raw.logos,
    palette: assignRoles(counts, { background: raw.pageBg, color: raw.pageInk }),
    elementsMeasured: raw.counted,
    notes,
    error: null,
  };
}

/* ------------------------------------------------------------- the storage */

export type MeasuredRow = {
  venture_id: string;
  method: string;
  ts: string;
  url: string | null;
  doc: string;
  error: string | null;
};

export const measuredRow = (ventureId: string): MeasuredRow | undefined =>
  db.prepare("SELECT * FROM brand_measured WHERE venture_id = ?").get(ventureId) as MeasuredRow | undefined;

export const overrideRow = (ventureId: string): { venture_id: string; doc: string; updated_at: string } | undefined =>
  db.prepare("SELECT * FROM brand_overrides WHERE venture_id = ?").get(ventureId) as
    | { venture_id: string; doc: string; updated_at: string }
    | undefined;

function store(ventureId: string, url: string, doc: MeasuredBrand | { method: "rendered"; error: string }, error: string | null) {
  db.prepare(
    `INSERT INTO brand_measured (venture_id, method, ts, url, doc, error) VALUES (?, 'rendered', ?, ?, ?, ?)
     ON CONFLICT(venture_id) DO UPDATE SET method = 'rendered', ts = excluded.ts, url = excluded.url,
       doc = excluded.doc, error = excluded.error`,
  ).run(ventureId, now(), url, JSON.stringify(doc), error);
}

/**
 * MEASURE ONE VENTURE'S SITE IN THE BROWSER.
 *
 * A failure is STORED, with its sentence and its timestamp. A row saying "the
 * browser could not reach this site on Tuesday" is a fact; leaving the last
 * successful reading in place with no mark on it would let a stale palette
 * pass for a fresh one indefinitely.
 */
export async function measureVenture(v: VentureRow): Promise<MeasuredBrand> {
  const failed = (error: string): MeasuredBrand => ({
    method: "rendered",
    readAt: now(),
    url: v.website ?? "",
    finalUrl: null,
    title: null,
    bodyFont: null,
    headingFont: null,
    fonts: [],
    colours: [],
    background: null,
    ink: null,
    buttons: [],
    logos: [],
    palette: { primary: null, secondary: null, accent: null, background: null, ink: null, ranked: [] },
    elementsMeasured: 0,
    notes: [],
    error,
  });

  if (!v.website) return failed("This venture has no website, so there is nothing to render.");
  const norm = normaliseWebsite(v.website);
  if (!norm) return failed(`“${v.website}” is not a website address this can open.`);

  const got = await evaluateInBrowser(norm.website);
  if ("error" in got) {
    const doc = failed(got.error);
    store(v.id, norm.website, doc, got.error);
    return doc;
  }
  const doc = shapeReading(norm.website, got.raw);
  store(v.id, norm.website, doc, null);
  return doc;
}

export function readMeasured(raw: string | null): MeasuredBrand | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MeasuredBrand) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ the override */

/** What the owner may type over a measurement. Everything is optional and a
 *  field left out is not overridden — an override that had to restate the
 *  whole palette to correct one hex would be a form nobody fills in. */
export type BrandOverride = {
  primary?: string | null;
  secondary?: string | null;
  accent?: string | null;
  background?: string | null;
  ink?: string | null;
  bodyFont?: string | null;
  headingFont?: string | null;
  logo?: string | null;
  note?: string | null;
};

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function validateOverride(input: unknown): { doc: BrandOverride } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { error: "An override is an object of the fields you want to fix." };
  const src = input as Record<string, unknown>;
  const doc: BrandOverride = {};
  for (const key of ["primary", "secondary", "accent", "background", "ink"] as const) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null || v === "") {
      doc[key] = null;
      continue;
    }
    const hex = String(v).trim().toUpperCase();
    if (!HEX6.test(hex))
      return { error: `${key} must be a six-digit hex colour like #2F7D4F, or empty to clear the override.` };
    doc[key] = hex;
  }
  for (const key of ["bodyFont", "headingFont", "logo", "note"] as const) {
    if (!(key in src)) continue;
    const v = src[key];
    if (v === null || v === "") {
      doc[key] = null;
      continue;
    }
    const s = String(v).replace(/\s+/g, " ").trim().slice(0, key === "note" ? 400 : 200);
    doc[key] = s || null;
  }
  return { doc };
}

export function setOverride(ventureId: string, doc: BrandOverride): void {
  const empty = Object.values(doc).every((v) => v === null || v === undefined);
  if (empty) {
    db.prepare("DELETE FROM brand_overrides WHERE venture_id = ?").run(ventureId);
    return;
  }
  db.prepare(
    `INSERT INTO brand_overrides (venture_id, doc, updated_at) VALUES (?,?,?)
     ON CONFLICT(venture_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
  ).run(ventureId, JSON.stringify(doc), now());
}

/* ------------------------------------------------------------ the document */

/**
 * THE THREE READINGS OF ONE VENTURE'S BRAND, SIDE BY SIDE AND NEVER MERGED
 * INTO ONE ANSWER WITHOUT SAYING SO.
 *
 * `effective` is what a caller that just wants a colour should use, and every
 * field on it carries the method that produced it: `override` beats `rendered`
 * beats `static`. Three sources collapsed into one hex with no provenance is
 * how a venture page ends up showing a colour nobody can explain.
 */
export function shapeBrand(ventureId: string) {
  const v = ventureRowById(ventureId);
  if (!v) return null;

  const measured = readMeasured(measuredRow(v.id)?.doc ?? null);
  const measuredMeta = measuredRow(v.id);
  const over = overrideRow(v.id);
  let overrideDoc: BrandOverride = {};
  if (over) {
    try {
      overrideDoc = JSON.parse(over.doc) as BrandOverride;
    } catch {
      overrideDoc = {};
    }
  }

  let staticBrand: { palette: Palette; fonts: string[]; enrichedAt: string | null } | null = null;
  try {
    const parsed = JSON.parse(v.brand || "{}") as { palette?: Palette; fonts?: string[]; enrichedAt?: string | null };
    staticBrand = {
      palette: parsed.palette ?? { primary: null, secondary: null, accent: null, background: null, ink: null, ranked: [] },
      fonts: Array.isArray(parsed.fonts) ? parsed.fonts : [],
      enrichedAt: parsed.enrichedAt ?? null,
    };
  } catch {
    staticBrand = null;
  }

  const pick = (
    key: "primary" | "secondary" | "accent" | "background" | "ink",
  ): { value: string | null; method: "override" | "rendered" | "static" | "none" } => {
    if (overrideDoc[key] !== undefined && overrideDoc[key] !== null)
      return { value: overrideDoc[key]!, method: "override" };
    const r = measured && !measured.error ? measured.palette[key] : null;
    if (r) return { value: r, method: "rendered" };
    const s = staticBrand?.palette[key] ?? null;
    if (s) return { value: s, method: "static" };
    return { value: null, method: "none" };
  };

  const bodyFont =
    overrideDoc.bodyFont !== undefined && overrideDoc.bodyFont !== null
      ? { value: overrideDoc.bodyFont, method: "override" as const }
      : measured?.bodyFont
        ? { value: measured.bodyFont, method: "rendered" as const }
        : staticBrand?.fonts[0]
          ? { value: staticBrand.fonts[0], method: "static" as const }
          : { value: null, method: "none" as const };

  const headingFont =
    overrideDoc.headingFont !== undefined && overrideDoc.headingFont !== null
      ? { value: overrideDoc.headingFont, method: "override" as const }
      : measured?.headingFont
        ? { value: measured.headingFont, method: "rendered" as const }
        : { value: null, method: "none" as const };

  return {
    ventureId: v.id,
    venture: v.name,
    slug: v.slug,
    website: v.website,
    rendered: measured
      ? { ...measured, at: measuredMeta?.ts ?? measured.readAt }
      : null,
    renderedError: measuredMeta?.error ?? null,
    static: staticBrand
      ? { method: "static" as const, palette: staticBrand.palette, fonts: staticBrand.fonts, at: staticBrand.enrichedAt }
      : null,
    override: over ? { ...overrideDoc, at: over.updated_at } : null,
    effective: {
      primary: pick("primary"),
      secondary: pick("secondary"),
      accent: pick("accent"),
      background: pick("background"),
      ink: pick("ink"),
      bodyFont,
      headingFont,
      logo:
        overrideDoc.logo != null
          ? { value: overrideDoc.logo, method: "override" as const }
          : measured?.logos[0]
            ? { value: measured.logos[0].src, method: "rendered" as const }
            : { value: null, method: "none" as const },
    },
    notes: [
      "The RENDERED reading is computed styles measured in a headless browser: " +
        "what the page is actually painted with, ranked by painted AREA. The " +
        "STATIC reading is ventures/enrich.ts's parse of the HTML and stylesheets, " +
        "which counts a colour whether or not anything uses it and cannot see a " +
        "palette applied at runtime.",
      "Neither overwrites the other, and the rendered pass never touches " +
        "`ventures.brand`. `effective` says which of the three produced each " +
        "field; `none` means nothing measured it and nothing was typed.",
      "The rendered pass costs a browser and a page load per venture, so it is " +
        "opt-in per venture and runs on nothing by default.",
    ],
  };
}

/**
 * THE HOOK ventures/enrich.ts CALLS, and everything it must not do.
 *
 * A venture create waits on `enrich()`; it must not also wait on a browser
 * starting, a page loading and a script evaluating, which is fifteen seconds
 * on a slow site. So this returns immediately and does the work behind it,
 * exactly as `knowledge/first-read.ts` does one line above it in that file.
 *
 * THREE CONSTRAINTS, and each is why it is a call and not an await:
 *   · it is OPT-IN. A venture whose slug is not in the setting returns before
 *     anything is spawned, so pressing "read the site again" costs nothing for
 *     the ventures nobody asked for.
 *   · it is NOT AWAITED, so a browser that will not start cannot stop a colour
 *     being stored by the static reader.
 *   · it cannot throw into its caller. Every failure lands on the
 *     `brand_measured` row, where the venture page draws it.
 */
export function startRenderedRead(ventureId: string): void {
  void (async () => {
    try {
      const v = ventureRowById(ventureId);
      if (!v || !v.website) return;
      const { optedIn, settings } = await import("./settings.ts");
      if (!optedIn(settings().renderedVentures, v)) return;
      await measureVenture(v);
    } catch (err) {
      /* Swallowed on purpose: this is a background pass with nobody to catch
         it, and its failures are already stored on the row. */
      console.error("[seoops] rendered brand read failed", err);
    }
  })();
}
