/**
 * The pure halves of the security area — the parts that can be checked without
 * a box, a browser or a network.
 *
 * WHAT IS TESTED AND WHY IT IS THESE FOUR. The PNG decoder, because it is the
 * only thing in this repository that reads a binary format byte by byte and a
 * mistake in it is silent: an off-by-one in the unfilter does not throw, it
 * reports a page as blank. The magic packet, because nothing on the wire
 * acknowledges it — a wrong byte layout is a wake that quietly never works. The
 * MAC and broadcast parsers, because they are the door to that packet. And the
 * cookie reader, because a cookie header with three cookies in it is the
 * ordinary case and a naive split gets it wrong.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: anything that opens an ssh connection
 * or writes to the database. Those are verified against the live box and
 * written up in the README.
 */
import { deflateSync } from "node:zlib";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { decodePng } from "./shotsqa.ts";
import { DEFAULT_BROADCAST, macLabel, magicPacket, parseMac, validBroadcast } from "./workstation.ts";
import { cookieValue } from "./owner.ts";

/* ------------------------------------------------------------ a real PNG */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** An 8-bit RGB, non-interlaced PNG with filter 0 on every scanline — the
 *  simplest legal file, and enough to prove the reader's arithmetic. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = y * (stride + 1) + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a solid rectangle reads as blank and a busy one does not", () => {
  const white = decodePng(png(60, 60, () => [255, 255, 255]));
  assert.equal(white.error, null);
  assert.equal(white.stats!.width, 60);
  assert.equal(white.stats!.stdev, 0, "one colour has no variance at all");
  assert.equal(white.stats!.dominantShare, 1);
  assert.equal(white.stats!.distinctColours, 1);

  /* A checkerboard of black and white: maximum variance, two colours, and
     neither of them dominant. */
  const noisy = decodePng(png(60, 60, (x, y) => ((x + y) % 2 ? [0, 0, 0] : [255, 255, 255])));
  assert.equal(noisy.error, null);
  assert.ok(noisy.stats!.stdev > 100, `expected a large stdev, got ${noisy.stats!.stdev}`);
  assert.ok(noisy.stats!.dominantShare < 0.9);
});

test("the decoder refuses what it cannot read, with a reason rather than a guess", () => {
  assert.match(decodePng(Buffer.from("not a png at all")).error!, /too short|signature/i);
  assert.match(decodePng(Buffer.alloc(200)).error!, /signature/i);
});

test("a mean luminance is the eye's, not the average of three channels", () => {
  /* Pure green at 255 is 0.587 * 255 ≈ 149.7 in Rec. 601, not 85. */
  const green = decodePng(png(20, 20, () => [0, 255, 0]));
  assert.ok(Math.abs(green.stats!.mean - 149.7) < 0.5, `got ${green.stats!.mean}`);
});

/* -------------------------------------------------------------- the packet */

test("a MAC is read in all three spellings and nothing else", () => {
  const expected = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
  for (const form of ["aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", "aabbccddeeff", "  aa:bb:cc:dd:ee:ff  "])
    assert.deepEqual(parseMac(form), expected, form);
  for (const bad of ["", "aa:bb:cc:dd:ee", "aa:bb:cc:dd:ee:ff:00", "zz:bb:cc:dd:ee:ff", "192.168.1.1"])
    assert.equal(parseMac(bad), null, bad);
  assert.equal(macLabel(expected), "aa:bb:cc:dd:ee:ff");
});

test("the magic packet is six 0xFF bytes and the MAC sixteen times", () => {
  const mac = parseMac("01:02:03:04:05:06")!;
  const p = magicPacket(mac);
  assert.equal(p.length, 102);
  assert.deepEqual([...p.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  for (let i = 0; i < 16; i++)
    assert.deepEqual([...p.subarray(6 + i * 6, 12 + i * 6)], mac, `repetition ${i}`);
});

test("a broadcast address is a dotted IPv4 or it is refused", () => {
  assert.ok(validBroadcast(DEFAULT_BROADCAST));
  assert.ok(validBroadcast("192.168.1.255"));
  for (const bad of ["192.168.1", "192.168.1.256", "example.com", "::1", ""])
    assert.equal(validBroadcast(bad), false, bad);
});

/* -------------------------------------------------------------- the cookie */

test("the session is found among other cookies and nowhere else", () => {
  assert.equal(cookieValue("opc_session=abc123"), "abc123");
  assert.equal(cookieValue("theme=dark; opc_session=abc123; other=1"), "abc123");
  assert.equal(cookieValue("  opc_session = abc123 "), "abc123");
  assert.equal(cookieValue("not_opc_session=abc123"), null);
  /* A prefix must not match: this is the mistake a naive `includes` makes. */
  assert.equal(cookieValue("xopc_session=abc123"), null);
  assert.equal(cookieValue(""), null);
  assert.equal(cookieValue(null), null);
});
