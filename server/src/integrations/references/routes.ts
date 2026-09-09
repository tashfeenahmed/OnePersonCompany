/**
 * THE REFERENCES ROUTES — everything a generator draws on for one business,
 * in one document.
 *
 *   GET   /api/references                 every venture, with what it has
 *   GET   /api/references?venture=<key>   one venture: guide, assets, brand
 *   PUT   /api/references/:venture/guide  save the guide (PATCH is the same)
 *
 * WHY ONE DOCUMENT RATHER THAN THREE CALLS. The three things a picture or a
 * caption is made from live in three places and were only ever visible in
 * three places: the palette on the venture's own Brand card, the pictures
 * behind a tab on the Publishing page, and — until this area — the tone of
 * voice nowhere at all, because there was nothing to type it into. The owner's
 * question is not "what assets does this venture have", it is "what does the
 * Studio know about this business before it writes anything", and that
 * question had no answer at a single address.
 *
 * NOTHING HERE OWNS AN ASSET. The library is the publishing area's — its
 * table, its upload route, its 12 MB cap, its URL importer with the SSRF check
 * — and this route READS it. A second upload path would be a second place to
 * get the byte sniffing and the private-address refusal wrong, so the page
 * this serves posts its files to `/api/publishing/assets` like everything
 * else, and the only write on this router is the guide.
 *
 * THE BRAND BLOB IS PASSED THROUGH AS MEASURED. It is not merged with the
 * guide's `colours` field and never will be: one is what a browser saw on the
 * site and the other is a sentence the owner typed, and a reader who cannot
 * tell them apart cannot tell whether the site is wrong or the guide is.
 *
 * PUT AND PATCH ARE THE SAME HANDLER, and both merge. See saveGuide: a field
 * that was not sent was not cleared. PATCH exists because the skill registry's
 * actions may be POST, PATCH or DELETE and never PUT, so an agent needs a verb
 * it is allowed to use; PUT exists because that is what the page sends and
 * what the contract is written as.
 */
import { Hono, type Context } from "hono";
import { ventureRow, ventureRows } from "../../db.ts";
import { readBrand } from "../../ventures/enrich.ts";
import {
  ASSET_KINDS,
  assetCounts,
  assetRows,
  libraryBytes,
  shapeAsset,
  UPLOAD_CAP,
} from "../publishing/assets.ts";
import { GUIDE_FIELDS, GUIDE_LIMITS, guideRow, saveGuide, shapeGuide, writtenGuides } from "./guide.ts";

export const referencesRoutes = new Hono();

const bad = (message: string) => ({ error: message });

/** What the generators are told, in the words the page shows. Kept here so the
 *  route, the page and the skill say the same thing. */
const USED_BY =
  "The written guide is appended to the Studio's caption prompt, the faceless video's " +
  "script prompt and the reel's dialogue prompt, marked as the owner's own instruction " +
  "rather than as evidence. The assets are the publishing area's library: the Studio " +
  "passes a selected one to the image model where that model has an image input, and " +
  "describes it in words where it has not.";

/* ------------------------------------------------------------- overview */

referencesRoutes.get("/", (c) => {
  const key = c.req.query("venture");

  if (!key) {
    /* COUNTED IN SQL, in one statement — see assetCounts in publishing's
       assets.ts for why tallying the listed rows would be wrong. */
    const counts = assetCounts();
    const written = writtenGuides();
    return c.json({
      venture: null,
      kinds: ASSET_KINDS,
      ventures: ventureRows().map((v) => {
        const per = counts.get(v.id) ?? {};
        return {
          id: v.id,
          slug: v.slug,
          name: v.name,
          stage: v.stage,
          description: v.description,
          /** Whether the owner has written ANYTHING. A saved blank form is not
           *  a guide — see shapeGuide's `written`. */
          guide: written.has(v.id),
          guideUpdatedAt: written.get(v.id) ?? null,
          assets: {
            total: per.total ?? 0,
            ...Object.fromEntries(ASSET_KINDS.map((k) => [k, per[k] ?? 0])),
          } as Record<string, number>,
        };
      }),
      note:
        "One row per venture: how many pictures of each kind it has, and whether a style " +
        `guide has been written for it. ${USED_BY}`,
    });
  }

  const v = ventureRow(key);
  if (!v) return c.json(bad(`There is no venture “${key}”.`), 404);

  /* THE ASSET LIST IS BOUNDED BY THE PUBLISHING AREA'S OWN LIMIT (300, newest
     first) and is not re-capped here. A shelf that silently held a different
     number than the Assets tab would be two answers to one question. */
  const assets = assetRows(v.id).map(shapeAsset);
  return c.json({
    venture: {
      id: v.id,
      slug: v.slug,
      name: v.name,
      stage: v.stage,
      description: v.description,
      website: v.website,
      color: v.color,
      /** Whether the colour was measured or chosen. The page draws the two
       *  differently, because "this is the site's green" and "he picked green"
       *  are different claims. */
      colorSource: v.color_source,
    },
    /** MEASURED off the site by ventures/enrich.ts. Never merged with the
     *  guide's own colour and font notes, which are opinion. */
    brand: readBrand(v.brand),
    guide: shapeGuide(v.id, guideRow(v.id)),
    limits: GUIDE_LIMITS,
    assets,
    kinds: ASSET_KINDS,
    bytes: libraryBytes(v.id),
    uploadCap: UPLOAD_CAP,
    note: USED_BY,
  });
});

/* ---------------------------------------------------------------- write */

async function writeGuide(c: Context) {
  const key = c.req.param("venture");
  const v = ventureRow(key ?? "");
  if (!v) return c.json(bad(`There is no venture “${key}”.`), 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object")
    return c.json(bad(`Expected a JSON body with any of: ${GUIDE_FIELDS.join(", ")}.`), 400);

  const unknown = Object.keys(body).filter((k) => !(GUIDE_FIELDS as string[]).includes(k));
  if (unknown.length)
    return c.json(
      bad(
        `${unknown.slice(0, 4).map((k) => `\`${k}\``).join(", ")} is not a guide field. ` +
          `The fields are: ${GUIDE_FIELDS.join(", ")}.`,
      ),
      400,
    );

  const res = saveGuide(v.id, body);
  if (!res.ok) return c.json(bad(res.error), 400);
  return c.json({
    venture: { id: v.id, slug: v.slug, name: v.name },
    guide: res.guide,
    note:
      "Saved. A field that was not sent was left as it was; send it as an empty string to " +
      `clear it. ${USED_BY}`,
  });
}

referencesRoutes.put("/:venture/guide", writeGuide);
referencesRoutes.patch("/:venture/guide", writeGuide);
