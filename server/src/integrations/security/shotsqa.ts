/**
 * SCREENSHOT QA — is the picture on the venture page a picture of the site, or
 * a picture of an outage.
 *
 * WHY THIS IS WORTH A RUN. `ventures/capture.ts` takes a screenshot of every
 * venture on a weekly timer, and its own success test is "did Chrome write a
 * file". That test is exactly right for what it is doing and it cannot tell a
 * homepage from a 502: Cloudflare's error page is a page, it renders, and Chrome
 * writes a perfectly good PNG of it. The dashboard then shows a thumbnail of a
 * gateway error under a business's name for a week, and nothing anywhere says
 * so. This looks at the pictures.
 *
 * EVERY CHECK IS A HEURISTIC AND SAYS WHICH KIND IT IS. There are three
 * verdicts and never two: `pass`, `fail`, and `unchecked` — the last one
 * meaning the check could not be run at all, which is the only honest answer
 * for a PNG this decoder cannot read or a venture with no audit. Folding
 * `unchecked` into `pass` would be the exact lie this whole codebase is built to
 * refuse, and it is a tempting one because it makes the table look green.
 *
 * THE PNG IS DECODED HERE, IN NODE, WITH NO DEPENDENCY. `zlib.inflateSync` plus
 * the five PNG filters is about sixty lines and it means the blankness check
 * works on a Raspberry Pi with nothing installed. `sips` and `ffmpeg` were the
 * alternative and both were declined: one is macOS-only and the other is a
 * hundred megabytes to compute a variance. What this decoder does NOT handle —
 * interlaced files, bit depths other than 8, palette images — is reported as
 * `unchecked` with the reason, because Chrome does not write those and a file
 * that is one of them is a file worth being told about.
 *
 * NO MODEL IS CALLED FROM THIS FILE, AND A MODEL'S OPINION IS NOW CARRIED
 * BESIDE IT. This header used to say that asking a model whether a screenshot
 * looks broken needed a capability flag to exist first, because
 * `models/provider.ts` declared nothing about whether a provider could accept
 * an image. `integrations/seoops/vision.ts` now PROBES that — one 1x1 PNG,
 * cached per provider and model — and stores its verdicts in `shot_vision`.
 * What changed here is only that this file READS that table, so a reader sees
 * both; what did not change is that every CHECK below is still arithmetic over
 * a PNG and two tables, still runs for every venture, and still costs nothing.
 *
 * THE TWO ARE NEVER MERGED INTO ONE VERDICT. A `visual` block sits apart from
 * `checks`, with its own words — ok, broken, unsure — and its own provenance.
 * A measured check can be wrong about a page; a model can be wrong about
 * anything, and folding a model's `broken` into the count of failed checks
 * would make a column of arithmetic quietly contain an opinion.
 */
import { inflateSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { db, now, ventureRows, type VentureRow } from "../../db.ts";
import { pruneOne, registerRetention, retentionFor } from "../../shared/retention.ts";
import { imageDimensions, SHOT_FLOOR } from "../../tools/chrome.ts";
import { lastRendered, lastShot } from "../ventures/capture.ts";

/* ------------------------------------------------------------- the decoder */

export type PixelStats = {
  width: number;
  height: number;
  sampled: number;
  /** Mean luminance, 0–255. */
  mean: number;
  /** Standard deviation of luminance across the sampled pixels. The blankness
   *  test: a solid colour is 0, a white page with text is a few units, a
   *  photograph is thirty or more. */
  stdev: number;
  /** The share of sampled pixels that are the single most common colour. A
   *  blank page is over 0.99; a real page is rarely over 0.85. */
  dominantShare: number;
  distinctColours: number;
};

export type Decoded = { stats: PixelStats; error: null } | { stats: null; error: string };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Every pixel is not needed to know whether a page is blank. One in nine (a
 *  3x3 grid step) is forty thousand samples on a 1280x800 shot, which settles a
 *  variance to more decimal places than anything here reads. */
const STEP = 3;

/**
 * A PNG, far enough to say what is in it.
 *
 * Truecolour and greyscale, 8 bits, non-interlaced — which is what Chrome
 * writes and what `capture.ts` therefore has on disk. Anything else returns an
 * error string, which becomes an `unchecked` verdict rather than a failure.
 */
export function decodePng(bytes: Buffer): Decoded {
  if (bytes.length < 24) return { stats: null, error: "The file is too short to be a PNG." };
  for (let i = 0; i < PNG_SIG.length; i++)
    if (bytes[i] !== PNG_SIG[i]) return { stats: null, error: "The file does not start with a PNG signature." };

  const size = imageDimensions(bytes);
  if (!size) return { stats: null, error: "The PNG has no readable IHDR." };
  const { width, height } = size;

  let at = 8;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];

  while (at + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.toString("ascii", at + 4, at + 8);
    const body = at + 8;
    if (body + len > bytes.length) break;
    if (type === "IHDR") {
      depth = bytes[body + 8]!;
      colorType = bytes[body + 9]!;
      interlace = bytes[body + 12]!;
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(body, body + len));
    } else if (type === "IEND") {
      break;
    }
    at = body + len + 4;
  }

  if (depth !== 8) return { stats: null, error: `This reader handles 8-bit samples; that file is ${depth}-bit.` };
  if (interlace !== 0) return { stats: null, error: "That PNG is interlaced, which this reader does not undo." };
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels)
    return { stats: null, error: `Colour type ${colorType} (palette or unknown) is not one this reader decodes.` };
  if (!idat.length) return { stats: null, error: "The PNG carries no image data." };

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (err) {
    return { stats: null, error: `The image data would not decompress — ${err instanceof Error ? err.message : String(err)}` };
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height)
    return { stats: null, error: "The decompressed image is shorter than its own header says it should be." };

  /* Unfiltered in place, one scanline at a time, into a single buffer holding
     the previous row — the five PNG filters are all defined against the byte
     to the left and the byte above. */
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = out.subarray(y * stride, (y + 1) * stride);
    src.copy(row);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          row[i] = (row[i]! + a) & 0xff;
          break;
        case 2:
          row[i] = (row[i]! + b) & 0xff;
          break;
        case 3:
          row[i] = (row[i]! + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          row[i] = (row[i]! + pred) & 0xff;
          break;
        }
        default:
          return { stats: null, error: `Scanline ${y} uses filter ${filter}, which is not a PNG filter.` };
      }
    }
    prev = row;
  }

  let n = 0;
  let sum = 0;
  let sumSq = 0;
  const counts = new Map<number, number>();
  for (let y = 0; y < height; y += STEP) {
    for (let x = 0; x < width; x += STEP) {
      const i = y * stride + x * channels;
      const r = out[i]!;
      const g = channels >= 3 ? out[i + 1]! : r;
      const b = channels >= 3 ? out[i + 2]! : r;
      /* Rec. 601 luma, which is what "how bright is this" means to an eye. */
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      n += 1;
      sum += lum;
      sumSq += lum * lum;
      /* Colours quantised to 5 bits a channel before counting: a gradient of
         four thousand nearly identical greys is a blank page, and an exact
         count would call it four thousand colours. */
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (!n) return { stats: null, error: "The image has no pixels to sample." };

  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  let dominant = 0;
  for (const v of counts.values()) if (v > dominant) dominant = v;

  return {
    stats: {
      width,
      height,
      sampled: n,
      mean: Math.round(mean * 10) / 10,
      stdev: Math.round(Math.sqrt(variance) * 100) / 100,
      dominantShare: Math.round((dominant / n) * 1000) / 1000,
      distinctColours: counts.size,
    },
    error: null,
  };
}

/* --------------------------------------------------------------- the checks */

export type Verdict = "pass" | "fail" | "unchecked";
export type Check = { key: string; label: string; verdict: Verdict; detail: string };

/** Below this standard deviation of luminance, or above this share of one
 *  colour, a capture is called blank. Both are wide: a real homepage with a
 *  large white hero still measures a stdev in the twenties, and the point of
 *  this check is to catch a solid white or solid grey rectangle, not to have an
 *  opinion about minimalism. */
const BLANK_STDEV = 4;
const BLANK_DOMINANT = 0.985;

/** capture.ts refreshes a picture after 7 days. Twice that is the point at
 *  which a picture is describing a site that may have changed twice since. */
const STALE_DAYS = 14;

/**
 * Words that appear in the TITLE of a page that is not the page.
 *
 * A title is used rather than the body because a title is one line the site's
 * own author wrote or its host substituted, and matching "error" anywhere in a
 * rendered DOM would flag every page with a form validation string in it.
 */
const ERROR_TITLE =
  /\b(404|403|500|502|503|504|not found|bad gateway|gateway time-?out|service unavailable|application error|internal server error|forbidden|under (?:construction|maintenance)|temporarily unavailable|site can'?t be reached|coming soon|default web ?page|welcome to nginx|apache2? (?:ubuntu |debian )?default)\b/i;

export type ShotFacts = {
  shotTs: string | null;
  shotPath: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  captureError: string | null;
  title: string | null;
  titleSource: string | null;
};

type AuditFacts = {
  ts: string;
  homepageTitle: string | null;
  homepageStatus: number | null;
  homepageHttps: boolean | null;
  httpRedirectsToHttps: boolean | null;
  insecurePages: number | null;
};

/** What the latest audit can say about the same site. Absent for a venture that
 *  has never been audited, which is a great many of them — and that absence is
 *  `unchecked`, never a pass. */
function newestAudit(ventureId: string): AuditFacts | null {
  let row: { ts: string; doc: string } | undefined;
  try {
    row = db
      .prepare("SELECT ts, doc FROM venture_audits WHERE venture_id = ? ORDER BY ts DESC LIMIT 1")
      .get(ventureId) as { ts: string; doc: string } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    const doc = JSON.parse(row.doc) as {
      https?: { httpRedirectsToHttps?: boolean | null };
      pages?: { url: string; status: number; title: string | null; https: boolean }[];
    };
    const pages = Array.isArray(doc.pages) ? doc.pages : [];
    const home = pages[0] ?? null;
    return {
      ts: row.ts,
      homepageTitle: home?.title ?? null,
      homepageStatus: home?.status ?? null,
      homepageHttps: home ? home.https : null,
      httpRedirectsToHttps: doc.https?.httpRedirectsToHttps ?? null,
      insecurePages: pages.length ? pages.filter((p) => p.https === false).length : null,
    };
  } catch {
    return null;
  }
}

/**
 * A MODEL'S OPINION OF THE SAME PICTURE, CARRIED APART FROM THE CHECKS.
 *
 * Read out of `shot_vision`, which `integrations/seoops/vision.ts` writes. It
 * is never counted into `failed` or `unchecked` — those are the arithmetic —
 * and `verdict: null` means no model looked, which is the ordinary case: the
 * pass is opt-in per venture and off by default.
 */
export type VisualVerdict = {
  verdict: "ok" | "broken" | "unsure" | null;
  issues: { kind: string; where: string; confidence: number }[];
  at: string | null;
  /** The capture this verdict is ABOUT, which may be older than the newest
   *  one — a verdict is reused for an unchanged picture and stale for a
   *  changed one until the next pass. */
  shotTs: string | null;
  model: string | null;
  /** Why there is no verdict, when there is none. */
  error: string | null;
};

export type VentureQa = {
  ventureId: string;
  venture: string;
  website: string | null;
  shotTs: string | null;
  shotPath: string | null;
  ageDays: number | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  pixels: PixelStats | null;
  checks: Check[];
  failed: number;
  unchecked: number;
  /** MEASURED and VISUAL are two columns and never one. See VisualVerdict. */
  visual: VisualVerdict | null;
};

/**
 * The newest stored visual verdict for a venture, or null.
 *
 * A read of another area's table, guarded: a box where seoops has not migrated
 * yet answers null, which reads as "no model looked" — the truth on such a box
 * and the default everywhere else.
 */
export function newestVisual(ventureId: string): VisualVerdict | null {
  let row: { ts: string; shot_ts: string | null; verdict: string | null; issues: string; model: string | null; error: string | null } | undefined;
  try {
    row = db
      .prepare(
        `SELECT ts, shot_ts, verdict, issues, model, error FROM shot_vision
          WHERE venture_id = ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(ventureId) as typeof row;
  } catch {
    return null;
  }
  if (!row) return null;
  let issues: { kind: string; where: string; confidence: number }[] = [];
  try {
    const parsed: unknown = JSON.parse(row.issues);
    if (Array.isArray(parsed)) issues = parsed as typeof issues;
  } catch {
    /* A row hand-edited into invalid JSON costs its issues, not its verdict. */
  }
  return {
    verdict: (row.verdict as VisualVerdict["verdict"]) ?? null,
    issues,
    at: row.ts,
    shotTs: row.shot_ts,
    model: row.model,
    error: row.error,
  };
}

const ageDays = (ts: string | null): number | null => {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? Math.round(((Date.now() - t) / 86_400_000) * 10) / 10 : null;
};

/**
 * One venture, judged.
 *
 * Never throws — a venture whose file has been deleted, whose PNG is truncated
 * or whose audit will not parse produces `unchecked` verdicts with the reason,
 * because a QA pass that died on the third of eleven ventures would be worth
 * less than no pass at all.
 */
export function judge(v: VentureRow): VentureQa {
  const checks: Check[] = [];
  /* THE NEWEST ROW, not the newest SUCCESSFUL one — `lastShot(v.id)` rather
     than `lastShot(v.id, true)`, which is what seoops/vision.ts asks for. The
     disagreement is deliberate and it is this file's whole subject: a failed
     attempt is a fact this pass has to REPORT ("the last attempt failed"),
     while the vision pass wants a picture it can actually look at and a
     failure there is nothing to judge. */
  const cap = lastShot(v.id);

  if (!v.website)
    checks.push({
      key: "website",
      label: "Has a website to photograph",
      verdict: "fail",
      detail: "The venture record has no website, so there is nothing to capture. Add one on the venture page.",
    });

  if (!cap) {
    checks.push({
      key: "capture",
      label: "A capture exists",
      verdict: "fail",
      detail: "This venture has never been captured. Press Capture on its page, or wait for the weekly pass.",
    });
    return {
      ventureId: v.id,
      venture: v.name,
      website: v.website,
      shotTs: null,
      shotPath: null,
      ageDays: null,
      width: null,
      height: null,
      bytes: null,
      pixels: null,
      checks,
      failed: checks.filter((c) => c.verdict === "fail").length,
      unchecked: checks.filter((c) => c.verdict === "unchecked").length,
      visual: newestVisual(v.id),
    };
  }

  const age = ageDays(cap.ts);

  if (cap.error || !cap.path) {
    checks.push({
      key: "capture",
      label: "A capture exists",
      verdict: "fail",
      detail: `The last attempt, ${cap.ts}, failed: ${cap.error ?? "no file was written and no reason was recorded."}`,
    });
  } else {
    checks.push({
      key: "capture",
      label: "A capture exists",
      verdict: "pass",
      detail: `Captured ${cap.ts}${cap.bytes ? `, ${Math.round(cap.bytes / 1024)} KB` : ""}.`,
    });
  }

  /* ---- dimensions */
  if (cap.width === null || cap.height === null) {
    checks.push({
      key: "dimensions",
      label: "Sensible dimensions",
      verdict: "unchecked",
      detail: "The capture row has no width or height — the IHDR was not read when it was taken.",
    });
  } else if (cap.width < SHOT_FLOOR.width || cap.height < SHOT_FLOOR.height) {
    checks.push({
      key: "dimensions",
      label: "Sensible dimensions",
      verdict: "fail",
      detail: `${cap.width}x${cap.height}, under the ${SHOT_FLOOR.width}x${SHOT_FLOOR.height} floor. A window that small is not a picture of a page.`,
    });
  } else {
    checks.push({
      key: "dimensions",
      label: "Sensible dimensions",
      verdict: "pass",
      detail: `${cap.width}x${cap.height}.`,
    });
  }

  /* ---- the pixels */
  let pixels: PixelStats | null = null;
  if (!cap.path) {
    checks.push({
      key: "blank",
      label: "Not a blank rectangle",
      verdict: "unchecked",
      detail: "There is no file to read.",
    });
  } else {
    let bytes: Buffer | null = null;
    try {
      statSync(cap.path);
      bytes = readFileSync(cap.path);
    } catch (err) {
      checks.push({
        key: "blank",
        label: "Not a blank rectangle",
        verdict: "unchecked",
        detail: `The file is not on disk any more (${err instanceof Error ? err.message : String(err)}). Only the last three pictures of a venture are kept; the row outlives them.`,
      });
    }
    if (bytes) {
      const decoded = decodePng(bytes);
      /* Discriminated on `stats` rather than on `error`, because an error
         string is narrowable and a truthiness test on one is not: an empty
         message would read as a success. */
      const stats = decoded.stats;
      if (stats === null) {
        checks.push({
          key: "blank",
          label: "Not a blank rectangle",
          verdict: "unchecked",
          detail: decoded.error,
        });
      } else {
        pixels = stats;
        const blank = stats.stdev < BLANK_STDEV || stats.dominantShare > BLANK_DOMINANT;
        checks.push({
          key: "blank",
          label: "Not a blank rectangle",
          verdict: blank ? "fail" : "pass",
          detail:
            `luminance stdev ${stats.stdev}, ${Math.round(stats.dominantShare * 100)}% of pixels one colour, ` +
            `${stats.distinctColours} colours over ${stats.sampled} samples` +
            (blank
              ? ` — under stdev ${BLANK_STDEV} or over ${Math.round(BLANK_DOMINANT * 100)}% one colour, which is a flat rectangle rather than a page.`
              : "."),
        });
      }
    }
  }

  /* ---- the title, off the newest RENDERED-DOM row. A different row from the
     picture and often a different moment; the report says which it used. */
  const rendered = lastRendered(v.id);
  const audit = newestAudit(v.id);
  let title: string | null = null;
  let titleSource: string | null = null;
  if (rendered) {
    try {
      const doc = JSON.parse(rendered.brand_rendered!) as { title?: string | null };
      if (typeof doc.title === "string" && doc.title.trim()) {
        title = doc.title.trim();
        titleSource = `rendered DOM, ${rendered.ts}`;
      }
    } catch {
      /* a rendered reading that will not parse is a title nobody has */
    }
  }
  if (!title && audit?.homepageTitle) {
    title = audit.homepageTitle;
    titleSource = `audit crawl, ${audit.ts}`;
  }

  if (!title) {
    checks.push({
      key: "title",
      label: "No error words in the page title",
      verdict: "unchecked",
      detail:
        "No title has been read for this site. A capture only dumps the DOM when the brand is being re-read, and " +
        "this venture has no audit either.",
    });
  } else {
    const hit = ERROR_TITLE.exec(title);
    checks.push({
      key: "title",
      label: "No error words in the page title",
      verdict: hit ? "fail" : "pass",
      detail: hit
        ? `The title is “${title.slice(0, 120)}” (${titleSource}) — “${hit[0]}” is what a host puts there when the site is not answering.`
        : `“${title.slice(0, 120)}” (${titleSource}).`,
    });
  }

  /* ---- what the audit says about the transport */
  if (!audit) {
    checks.push({
      key: "mixed-content",
      label: "Nothing insecure in the audit",
      verdict: "unchecked",
      detail: "This venture has never been audited, so there is no crawl to read this out of. Run the audit on its page.",
    });
  } else if (audit.homepageStatus !== null && audit.homepageStatus >= 400) {
    checks.push({
      key: "mixed-content",
      label: "Nothing insecure in the audit",
      verdict: "fail",
      detail: `The last audit (${audit.ts}) got HTTP ${audit.homepageStatus} from the homepage, so whatever was photographed was not the site.`,
    });
  } else if (audit.insecurePages && audit.insecurePages > 0) {
    checks.push({
      key: "mixed-content",
      label: "Nothing insecure in the audit",
      verdict: "fail",
      detail: `${audit.insecurePages} page(s) in the last audit (${audit.ts}) were served over plain http. A browser will flag the padlock.`,
    });
  } else if (audit.httpRedirectsToHttps === false) {
    checks.push({
      key: "mixed-content",
      label: "Nothing insecure in the audit",
      verdict: "fail",
      detail: `The last audit (${audit.ts}) found that http:// does not redirect to https. Every link written without a scheme lands on the insecure one.`,
    });
  } else {
    checks.push({
      key: "mixed-content",
      label: "Nothing insecure in the audit",
      verdict: "pass",
      detail:
        `The last audit (${audit.ts}) crawled no plain-http page` +
        (audit.httpRedirectsToHttps === null
          ? ", and whether http:// redirects was not asked (the venture's own address is http, or the probe did not run)."
          : " and http:// redirects to https."),
    });
  }

  /* ---- freshness */
  if (age === null) {
    checks.push({
      key: "fresh",
      label: "Recent enough to believe",
      verdict: "unchecked",
      detail: "The capture row has no readable timestamp.",
    });
  } else {
    checks.push({
      key: "fresh",
      label: "Recent enough to believe",
      verdict: age > STALE_DAYS ? "fail" : "pass",
      detail:
        `${age} day(s) old` +
        (age > STALE_DAYS
          ? `, past the ${STALE_DAYS}-day line. The weekly refresh has not run or has been failing.`
          : "."),
    });
  }

  return {
    ventureId: v.id,
    venture: v.name,
    website: v.website,
    shotTs: cap.ts,
    shotPath: cap.path,
    ageDays: age,
    width: cap.width,
    height: cap.height,
    bytes: cap.bytes,
    pixels,
    checks,
    failed: checks.filter((c) => c.verdict === "fail").length,
    unchecked: checks.filter((c) => c.verdict === "unchecked").length,
    /* Read, never computed here, and never counted into the two numbers
       above. */
    visual: newestVisual(v.id),
  };
}

/* ---------------------------------------------------------------- the pass */

export type QaPass = { ts: string; ventures: VentureQa[] };

export function runQa(): QaPass {
  return { ts: now(), ventures: ventureRows().map((v) => judge(v)) };
}

/**
 * The same pass, yielding between ventures.
 *
 * Inflating and unfiltering a 1280x800 PNG is a few hundred milliseconds of
 * SYNCHRONOUS work, and a dozen of them back to back is a couple of seconds
 * during which this process answers nothing at all — the collectors, the chat
 * stream and the health check included. `setImmediate` between ventures costs
 * nothing and keeps the server answering while the run works, which is the
 * whole promise a run makes.
 */
export async function runQaAsync(onVenture?: (v: VentureQa, i: number, total: number) => void): Promise<QaPass> {
  const rows = ventureRows();
  const ventures: VentureQa[] = [];
  for (const [i, v] of rows.entries()) {
    const judged = judge(v);
    ventures.push(judged);
    onVenture?.(judged, i + 1, rows.length);
    await new Promise((r) => setImmediate(r));
  }
  return { ts: now(), ventures };
}

/** The rows, written under the run that produced them. One row per venture per
 *  pass, so "when did this start failing" is a query rather than a diff of two
 *  reports. */
/**
 * NINETY DAYS, AND THIS TABLE HAD NO WINDOW AT ALL UNTIL NOW.
 *
 * A row is a VERDICT ON THE NEWEST CAPTURE, one per venture per pass. The
 * moment a newer capture is judged, the older verdict stops answering "is this
 * picture broken" and starts answering only "has this been broken before" —
 * which is a real question, and is why these are kept at all rather than
 * replaced in place. A quarter of it is enough to see a venture that fails
 * every few passes, which is the pattern worth finding; a year of it would be
 * the same finding with more rows.
 *
 * It is deliberately the same window as the snapshots beside it: both are
 * "evidence about a thing that has since been changed", and two numbers for
 * one idea is how the four hardcoded windows happened in the first place.
 */
registerRetention({
  table: "security_shotsqa",
  column: "ts",
  days: 90,
  source: "area",
  note:
    "One verdict per venture per pass. A quarter shows a venture that fails repeatedly; the current verdict " +
    "is always the newest row, so everything older is trend rather than state.",
});

/** Verdicts past their window. Run at the end of a pass rather than on a
 *  sweep, because a pass is the only thing that adds to this table. */
export function pruneQa(): number {
  return pruneOne(retentionFor("security_shotsqa")!);
}

export function storeQa(runId: string, pass: QaPass) {
  const stmt = db.prepare(
    `INSERT INTO security_shotsqa
       (run_id, ts, venture_id, venture, shot_ts, shot_path, age_days, width, height, bytes, failed, unchecked, checks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const v of pass.ventures)
    stmt.run(
      runId,
      pass.ts,
      v.ventureId,
      v.venture,
      v.shotTs,
      v.shotPath,
      v.ageDays,
      v.width,
      v.height,
      v.bytes,
      v.failed,
      v.unchecked,
      JSON.stringify({ checks: v.checks, pixels: v.pixels, website: v.website, visual: v.visual }),
    );
  pruneQa();
}

/* -------------------------------------------------------------- the report */

const MARK: Record<Verdict, string> = { pass: "ok", fail: "FAIL", unchecked: "—" };

/**
 * The markdown the run leaves behind.
 *
 * WRITTEN BY THIS FILE RATHER THAN BY A MODEL, and that is the one structural
 * difference between this run kind and the six beside it. Every one of those
 * asks a model to reason over a brief; this one has nothing to reason about —
 * the checks are arithmetic over a PNG and two tables, the verdicts are already
 * decided, and a model asked to summarise them could only paraphrase them, at
 * the cost of tokens and of a chance to get one wrong. A run kind is the right
 * shape for this because of the QUEUE and the ledger, not because of the model:
 * decoding eleven PNGs is seconds of CPU that must not happen inside a request.
 */
export function report(pass: QaPass): string {
  const lines: string[] = [];
  const failing = pass.ventures.filter((v) => v.failed > 0);
  const totalUnchecked = pass.ventures.reduce((n, v) => n + v.unchecked, 0);

  lines.push(`# Screenshot QA — ${pass.ts}`, "");
  lines.push(
    `${pass.ventures.length} venture(s) examined. ` +
      `${failing.length} with at least one failed check; ${totalUnchecked} check(s) could not be run at all.`,
    "",
  );

  lines.push("## Findings", "");
  if (!pass.ventures.length) {
    lines.push("There are no ventures on this box, so there was nothing to check.", "");
  } else if (!failing.length) {
    lines.push(
      "Nothing failed. Every venture with a capture has a picture with sensible dimensions, more than a flat " +
        "colour in it, no error wording in its title, and nothing insecure in its latest audit.",
      "",
    );
  } else {
    for (const v of failing) {
      lines.push(`- **${v.venture}** — ${v.failed} failed check(s):`);
      for (const c of v.checks.filter((x) => x.verdict === "fail")) lines.push(`    - ${c.label}: ${c.detail}`);
    }
    lines.push("");
  }

  lines.push("## Evidence", "");
  lines.push("| Venture | Captured | Age | Size | Blankness | Failed | Unchecked |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const v of pass.ventures) {
    const blank = v.pixels ? `stdev ${v.pixels.stdev}, ${Math.round(v.pixels.dominantShare * 100)}% one colour` : "not decoded";
    lines.push(
      `| ${v.venture} | ${v.shotTs ?? "never"} | ${v.ageDays === null ? "—" : `${v.ageDays}d`} | ` +
        `${v.width && v.height ? `${v.width}x${v.height}` : "—"} | ${blank} | ${v.failed} | ${v.unchecked} |`,
    );
  }
  lines.push("");

  for (const v of pass.ventures) {
    lines.push(`### ${v.venture}${v.website ? ` — ${v.website}` : ""}`, "");
    for (const c of v.checks) lines.push(`- [${MARK[c.verdict]}] **${c.label}** — ${c.detail}`);
    lines.push("");
  }

  lines.push("## Recommendations", "");
  const recs: string[] = [];
  for (const v of failing) {
    for (const c of v.checks.filter((x) => x.verdict === "fail")) {
      if (c.key === "capture") recs.push(`Capture ${v.venture} again from its venture page and read the error if it fails twice.`);
      if (c.key === "blank") recs.push(`Open ${v.venture}'s site yourself: the picture is a flat rectangle, which is what a blocked page, a JavaScript app that never painted, or a splash screen looks like.`);
      if (c.key === "title") recs.push(`${v.venture}'s page title reads like an error page. Check the host and the certificate before trusting anything else measured about it.`);
      if (c.key === "mixed-content") recs.push(`Run the audit on ${v.venture} and fix what it says about http — the picture on its card was taken through the same door.`);
      if (c.key === "fresh") recs.push(`${v.venture}'s picture is stale. The weekly capture pass is not reaching it; check that a browser is still installed and configured under Settings → Server.`);
      if (c.key === "website") recs.push(`Give ${v.venture} a website on its venture page, or accept that nothing on this box can photograph it.`);
    }
  }
  if (!recs.length) recs.push("Nothing to do.");
  for (const r of [...new Set(recs)]) lines.push(`- ${r}`);
  lines.push("");

  /*
    THE MODEL'S OPINIONS, IN THEIR OWN SECTION AND UNDER THEIR OWN HEADING.
    Deliberately after the evidence table and outside it: a reader scanning the
    table is reading arithmetic, and a column of opinions in the middle of it
    would be read as more of the same.
  */
  const looked = pass.ventures.filter((v) => v.visual?.verdict);
  lines.push("## Visual verdicts (a model, not a measurement)", "");
  if (!looked.length) {
    lines.push(
      "No model has looked at any of these pictures. The visual pass is opt-in per venture and off by " +
        "default — a vision call is a bill — and it is switched on under Integrations → SEO Ops.",
      "",
    );
  } else {
    lines.push(
      `${looked.length} venture(s) have a stored visual verdict. These are a MODEL's opinion of a picture ` +
        "and are not counted in the failed or unchecked columns above.",
      "",
    );
    for (const v of looked) {
      lines.push(`- **${v.venture}** — ${v.visual!.verdict}${v.visual!.model ? ` (${v.visual!.model})` : ""}, about the capture of ${v.visual!.shotTs ?? "an unrecorded time"}:`);
      if (!v.visual!.issues.length) lines.push("    - no issue named");
      for (const i of v.visual!.issues)
        lines.push(`    - ${i.kind}: ${i.where} (confidence ${i.confidence})`);
    }
    lines.push("");
  }
  const refused = pass.ventures.filter((v) => v.visual && !v.visual.verdict && v.visual.error);
  if (refused.length) {
    for (const v of refused) lines.push(`- **${v.venture}** — no visual verdict: ${v.visual!.error}`);
    lines.push("");
  }

  lines.push("## What was not checked", "");
  lines.push(
    "- **Every verdict in the table above is arithmetic**, over the PNG's own pixels and over two tables this " +
      "box already had. No model is called from this pass. Where a model HAS looked, its opinion is in the " +
      "Visual verdicts section above, apart from the measurements and never folded into them.",
  );
  lines.push(
    "- **A page that renders perfectly and says the wrong thing passes everything here.** These checks catch a " +
      "blank rectangle, a gateway error and a stale file. They cannot catch a redesign nobody approved.",
  );
  lines.push(
    `- **\`—\` in the table is not a pass.** ${totalUnchecked} check(s) could not be run: no audit, no title on ` +
      "record, a file already pruned off disk, or a PNG this decoder does not handle. Each says which in its own line.",
  );
  lines.push("");

  return lines.join("\n");
}

/* ------------------------------------------------------------------ reads */

export type QaRow = {
  id: number;
  run_id: string;
  ts: string;
  venture_id: string;
  venture: string;
  shot_ts: string | null;
  shot_path: string | null;
  age_days: number | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  failed: number;
  unchecked: number;
  checks: string;
};

/** The rows of the newest pass, or of a named run. */
export function latestRows(runId?: string | null): QaRow[] {
  const id =
    runId ??
    (db.prepare("SELECT run_id FROM security_shotsqa ORDER BY ts DESC, id DESC LIMIT 1").get() as
      | { run_id: string }
      | undefined)?.run_id;
  if (!id) return [];
  return db.prepare("SELECT * FROM security_shotsqa WHERE run_id = ? ORDER BY id").all(id) as QaRow[];
}

/** Every pass, newest first: when it ran and what it found. */
export function passes(limit = 20): { runId: string; ts: string; ventures: number; failed: number; unchecked: number }[] {
  return db
    .prepare(
      `SELECT run_id AS runId, MIN(ts) AS ts, COUNT(*) AS ventures,
              SUM(failed) AS failed, SUM(unchecked) AS unchecked
         FROM security_shotsqa
        GROUP BY run_id
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 200)) as {
    runId: string;
    ts: string;
    ventures: number;
    failed: number;
    unchecked: number;
  }[];
}
