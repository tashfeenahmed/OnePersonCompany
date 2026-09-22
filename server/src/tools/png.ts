import { crc32, deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { imageDimensions } from "./chrome.ts";

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

/** Decoded 8-bit samples, row-major, `channels` bytes a pixel. */
export type Pixels = { width: number; height: number; channels: number; data: Buffer };

export type Decoded = { stats: PixelStats; error: null } | { stats: null; error: string };

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Every pixel is not needed to know whether a page is blank. One in nine (a
 *  3x3 grid step) is forty thousand samples on a 1280x800 shot, which settles a
 *  variance to more decimal places than anything here reads. */
const STEP = 3;

/**
 * A PNG's samples, unfiltered — the half of `decodePng` that the carousel's
 * cutter also needs.
 *
 * Truecolour and greyscale, 8 bits, non-interlaced — which is what Chrome
 * writes and what `capture.ts` therefore has on disk. Anything else returns an
 * error string.
 */
export function decodePixels(bytes: Buffer): Pixels | { error: string } {
  if (bytes.length < 24) return { error: "The file is too short to be a PNG." };
  for (let i = 0; i < PNG_SIG.length; i++)
    if (bytes[i] !== PNG_SIG[i]) return { error: "The file does not start with a PNG signature." };

  const size = imageDimensions(bytes);
  if (!size) return { error: "The PNG has no readable IHDR." };
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

  if (depth !== 8) return { error: `This reader handles 8-bit samples; that file is ${depth}-bit.` };
  if (interlace !== 0) return { error: "That PNG is interlaced, which this reader does not undo." };
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels)
    return { error: `Colour type ${colorType} (palette or unknown) is not one this reader decodes.` };
  if (!idat.length) return { error: "The PNG carries no image data." };

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (err) {
    return { error: `The image data would not decompress — ${err instanceof Error ? err.message : String(err)}` };
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height)
    return { error: "The decompressed image is shorter than its own header says it should be." };

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
          return { error: `Scanline ${y} uses filter ${filter}, which is not a PNG filter.` };
      }
    }
    prev = row;
  }
  return { width, height, channels, data: out };
}

/**
 * A PNG, far enough to say what is in it.
 *
 * Truecolour and greyscale, 8 bits, non-interlaced — which is what Chrome
 * writes and what `capture.ts` therefore has on disk. Anything else returns an
 * error string, which becomes an `unchecked` verdict rather than a failure.
 */
export function decodePng(bytes: Buffer): Decoded {
  const px = decodePixels(bytes);
  if ("error" in px) return { stats: null, error: px.error };
  const { width, height, channels, data: out } = px;
  const stride = width * channels;

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



/**
 * A PNG WITH ITS BOTTOM ROWS CUT OFF, in plain JavaScript.
 *
 * WHY THIS IS POSSIBLE WITHOUT AN IMAGE LIBRARY. A PNG's pixel stream is one
 * filtered scanline after another, and every filter refers only to the row
 * ABOVE. So the first N scanlines of the inflated stream are, byte for byte, a
 * complete N-row image: truncate, deflate again, rewrite IHDR's height, done.
 * Nothing is decoded to pixels and nothing is re-filtered.
 *
 * WHY IT EXISTS. Chromium's new headless mode on Linux lays a page out shorter
 * than the window it is given and screenshots the WINDOW, so the picture ends
 * in rows of bare canvas — see `viewportDeficit` in tools/chrome.ts. The
 * callers ask for a taller window and cut the surplus off with this.
 *
 * Non-interlaced only, which is what Chrome writes. Anything it cannot handle
 * comes back UNCHANGED: a picture with a blank strip beats no picture.
 */
export function cropPngHeight(bytes: Buffer, height: number): Buffer {
  try {
    for (let i = 0; i < PNG_SIG.length; i++) if (bytes[i] !== PNG_SIG[i]) return bytes;
    let at = 8;
    let ihdr: Buffer | null = null;
    const idat: Buffer[] = [];
    const before: Buffer[] = [];
    const after: Buffer[] = [];
    while (at + 12 <= bytes.length) {
      const len = bytes.readUInt32BE(at);
      const type = bytes.toString("latin1", at + 4, at + 8);
      const end = at + 12 + len;
      if (end > bytes.length) return bytes;
      const data = bytes.subarray(at + 8, at + 8 + len);
      if (type === "IHDR") ihdr = Buffer.from(data);
      else if (type === "IDAT") idat.push(data);
      else if (type !== "IEND") (idat.length ? after : before).push(bytes.subarray(at, end));
      at = end;
      if (type === "IEND") break;
    }
    if (!ihdr || ihdr.length !== 13 || !idat.length) return bytes;
    const width = ihdr.readUInt32BE(0);
    const full = ihdr.readUInt32BE(4);
    const depth = ihdr[8]!;
    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ihdr[9]!];
    if (!channels || ihdr[12] !== 0 || !(height > 0) || height >= full) return bytes;

    const row = 1 + Math.ceil((width * channels * depth) / 8);
    const raw = inflateSync(Buffer.concat(idat));
    if (raw.length < row * height) return bytes;
    const packed = deflateSync(raw.subarray(0, row * height));
    ihdr.writeUInt32BE(height, 4);

    const chunk = (type: string, data: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, "latin1");
      const tail = Buffer.alloc(4);
      tail.writeUInt32BE(crc32(data, crc32(head.subarray(4))) >>> 0, 0);
      return Buffer.concat([head, data, tail]);
    };
    return Buffer.concat([
      bytes.subarray(0, 8),
      chunk("IHDR", ihdr),
      ...before,
      chunk("IDAT", packed),
      ...after,
      chunk("IEND", Buffer.alloc(0)),
    ]);
  } catch {
    return bytes;
  }
}

/** `cropPngHeight`, on a file, in place. Silent when there is nothing to cut or
 *  the file cannot be read: the screenshot is still a screenshot. */
export function trimPngFile(path: string, height: number): void {
  try {
    const bytes = readFileSync(path);
    const cut = cropPngHeight(bytes, height);
    if (cut !== bytes) writeFileSync(path, cut);
  } catch {
    /* Left as the browser wrote it. */
  }
}

/* ------------------------------------------------ cutting and shrinking
 *
 * ADDED FOR THE CAROUSEL (videoplus/carousel.ts), which renders six slides as
 * one wide strip in one browser launch and cuts it apart here. Pure JS on the
 * decoder above and zlib, like everything else in this file: no image
 * library, because this is two loops over a buffer. */

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(data, crc32(head.subarray(4))) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

/** An 8-bit PNG from samples, every scanline filter 0. */
export function encodePng(px: Pixels): Buffer {
  const colorType = ({ 1: 0, 2: 4, 3: 2, 4: 6 } as Record<number, number>)[px.channels];
  if (colorType === undefined) throw new Error(`${px.channels} channels is not a PNG layout`);
  const stride = px.width * px.channels;
  const raw = Buffer.alloc((stride + 1) * px.height);
  for (let y = 0; y < px.height; y++) px.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px.width, 0);
  ihdr.writeUInt32BE(px.height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([Buffer.from(PNG_SIG), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** The rectangle x, y, w, h of a decoded picture. Clamped to the picture. */
export function cropPixels(px: Pixels, x: number, y: number, w: number, h: number): Pixels {
  const x0 = Math.max(0, Math.min(px.width, Math.round(x)));
  const y0 = Math.max(0, Math.min(px.height, Math.round(y)));
  const cw = Math.max(0, Math.min(px.width - x0, Math.round(w)));
  const ch = Math.max(0, Math.min(px.height - y0, Math.round(h)));
  const stride = px.width * px.channels;
  const out = Buffer.alloc(cw * ch * px.channels);
  for (let row = 0; row < ch; row++) {
    const from = (y0 + row) * stride + x0 * px.channels;
    px.data.copy(out, row * cw * px.channels, from, from + cw * px.channels);
  }
  return { width: cw, height: ch, channels: px.channels, data: out };
}

/** A smaller copy, by averaging each `factor`×`factor` block. For a picture
 *  a model only needs to see the shape of — never for anything published. */
export function shrinkPixels(px: Pixels, factor: number): Pixels {
  const f = Math.max(1, Math.floor(factor));
  if (f === 1) return px;
  const w = Math.max(1, Math.floor(px.width / f));
  const h = Math.max(1, Math.floor(px.height / f));
  const c = px.channels;
  const out = Buffer.alloc(w * h * c);
  const sums = new Float64Array(c);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      sums.fill(0);
      for (let dy = 0; dy < f; dy++) {
        const base = ((y * f + dy) * px.width + x * f) * c;
        for (let dx = 0; dx < f; dx++) for (let k = 0; k < c; k++) sums[k] = sums[k]! + px.data[base + dx * c + k]!;
      }
      for (let k = 0; k < c; k++) out[(y * w + x) * c + k] = Math.round(sums[k]! / (f * f));
    }
  return { width: w, height: h, channels: c, data: out };
}
