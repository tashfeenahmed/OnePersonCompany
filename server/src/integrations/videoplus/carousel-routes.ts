/**
 * THE CAROUSELS, READ — and the six pictures, served.
 *
 * MAKING ONE IS NOT HERE. A carousel is a `video` run with `format:
 * "carousel"` (see carousel.ts), started through `POST /api/runs` like every
 * other Studio video, and deleted with its run — `forgetVideo` takes the row
 * and the run directory takes the files. What is here is the reading side the
 * Studio needs: the list its rail merges with the runs, one carousel with its
 * verdicts, each slide's PNG, the strip they were cut from, and all six as
 * one zip.
 *
 * NO PATH FROM A CALLER EVER REACHES THE DISK. A slide is addressed by run id
 * and number, both checked, and the file name is rebuilt from the number
 * (`slidePath`) — the same rule the video routes keep for their files.
 */
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { db, ventureRow } from "../../db.ts";
import { carouselRow, shapeCarousel, slidePath, stripPath, type CarouselRow } from "./carousel.ts";
import { CAROUSEL_SIZES, CAROUSEL_SLIDES } from "../../../../shared/carousel.ts";

export const carouselRoutes = new Hono();

carouselRoutes.get("/", (c) => {
  const key = c.req.query("venture");
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: "No venture by that id or slug." }, 404);
  const rows = (v
    ? db.prepare("SELECT * FROM studio_carousels WHERE venture_id = ? ORDER BY ts DESC LIMIT 200").all(v.id)
    : db.prepare("SELECT * FROM studio_carousels ORDER BY ts DESC LIMIT 200").all()) as unknown as CarouselRow[];
  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    carousels: rows.map(shapeCarousel),
    sizes: Object.entries(CAROUSEL_SIZES).map(([key, s]) => ({ key, ...s })),
  });
});

/**
 * WHICH MODEL A CAROUSEL WILL USE, AND WHETHER IT CAN SEE — for the one line
 * the Studio's Carousel tab draws under its form.
 *
 * There is no carousel model. Planning, coding and the visual check are all
 * `complete()` with no provider and no model named, so they go to whatever the
 * owner chose under Settings → Models: a hosted router, OpenRouter, or their
 * own local box serving whatever model they loaded. This route only reports
 * that choice.
 *
 * NOTHING IS PROBED HERE. Whether the model takes pictures is read from the
 * vision probe's cache (`seoops/vision.ts`, keyed by provider and model); a
 * model never asked is `supports: null`, and the first carousel asks. Naming
 * the model does not call the endpoint either: the configured model is
 * reported, and "the endpoint chooses" is said as that.
 */
carouselRoutes.get("/model", async (c) => {
  const { activeProvider } = await import("../../models/provider.ts");
  const p = activeProvider();
  if (!p)
    return c.json({
      provider: null,
      label: null,
      model: null,
      vision: { supports: null, detail: "No model is chosen. Choose one under Settings → Models.", at: null },
    });
  let vision: { supports: boolean | null; detail: string; at: string | null } = {
    supports: null,
    detail: "Not checked yet — the first carousel asks whether this model takes a picture.",
    at: null,
  };
  try {
    const { storedCapability } = await import("../seoops/vision.ts");
    const held = storedCapability(p.id, p.defaultModel);
    if (held) vision = { supports: held.supports, detail: held.detail, at: held.at };
  } catch { /* no vision probe on this server: "not checked" */ }
  return c.json({ provider: p.id, label: p.label, model: p.defaultModel, vision });
});

carouselRoutes.get("/:runId", (c) => {
  const row = carouselRow(c.req.param("runId"));
  if (!row) return c.json({ error: "No carousel for that run. It may still be planning, or it was not a carousel run." }, 404);
  return c.json(shapeCarousel(row));
});

const png = (bytes: Buffer, name: string, download: boolean) =>
  new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=300",
      ...(download ? { "Content-Disposition": `attachment; filename="${name}"` } : {}),
    },
  });

carouselRoutes.get("/:runId/slides/:n", (c) => {
  const runId = c.req.param("runId");
  const n = Number(c.req.param("n"));
  const path = slidePath(runId, n);
  if (!path) return c.json({ error: `Slide ${c.req.param("n")} of that carousel is not on disk.` }, 404);
  return png(readFileSync(path), `${runId}-slide-${n}.png`, c.req.query("download") === "1");
});

/** The whole strip the six were cut from — what the carousel looks like
 *  swiped end to end. */
carouselRoutes.get("/:runId/strip", (c) => {
  const runId = c.req.param("runId");
  const path = stripPath(runId);
  if (!path) return c.json({ error: "That carousel's strip is not on disk." }, 404);
  return png(readFileSync(path), `${runId}-strip.png`, c.req.query("download") === "1");
});

/**
 * ALL SIX AS ONE ZIP, STORED RATHER THAN DEFLATED.
 *
 * A PNG is already compressed, so deflating it again saves nothing and costs
 * CPU on a Pi; the STORE method is also the whole of the format this needs to
 * write — a local header per file, the bytes, and a central directory — which
 * is forty lines rather than a dependency.
 */
export function storedZip(files: { name: string; bytes: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.bytes) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time + date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.bytes.length, 18);
    local.writeUInt32LE(f.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, f.bytes);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6); // needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt32LE(0, 12);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(f.bytes.length, 20);
    entry.writeUInt32LE(f.bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + f.bytes.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

carouselRoutes.get("/:runId/zip", (c) => {
  const runId = c.req.param("runId");
  if (!carouselRow(runId)) return c.json({ error: "No carousel for that run." }, 404);
  const files: { name: string; bytes: Buffer }[] = [];
  for (let n = 1; n <= CAROUSEL_SLIDES; n++) {
    const path = slidePath(runId, n);
    if (path) files.push({ name: `slide-${n}.png`, bytes: readFileSync(path) });
  }
  if (!files.length) return c.json({ error: "None of that carousel's slides are on disk." }, 404);
  const zip = storedZip(files);
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename="carousel-${runId}.zip"`,
    },
  });
});
