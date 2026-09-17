import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { cropPngHeight, decodePng } from "./png.ts";
import { imageDimensions } from "./chrome.ts";

/** A w×h RGB PNG whose row y is solid (y, 0, 255 - y), filter type 0. */
function png(w: number, h: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) row.set([y, 0, 255 - y], 1 + x * 3);
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(data, crc32(head.subarray(4))) >>> 0, 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a PNG's bottom rows are cut off without touching the rows that stay", () => {
  const whole = png(16, 40);
  const cut = cropPngHeight(whole, 25);
  assert.deepEqual(imageDimensions(cut), { width: 16, height: 25 });
  assert.equal(decodePng(cut).error, null);

  /* The kept scanlines are the original's, byte for byte. */
  const idat = (b: Buffer) => { const at = b.indexOf("IDAT", 0, "latin1"); return inflateSync(b.subarray(at + 4, at + 4 + b.readUInt32BE(at - 4))); };
  assert.ok(idat(cut).equals(idat(whole).subarray(0, 25 * (1 + 16 * 3))));

  /* Nothing to cut, and nonsense, both hand the picture back untouched. */
  assert.equal(cropPngHeight(whole, 40), whole);
  assert.equal(cropPngHeight(whole, 0), whole);
  const junk = Buffer.from("not a png at all");
  assert.equal(cropPngHeight(junk, 5), junk);
});
