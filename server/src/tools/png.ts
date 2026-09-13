import { inflateSync } from "node:zlib";
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

