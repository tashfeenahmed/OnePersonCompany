/**
 * THE SIZES A CAROUSEL CAN BE, spelled once for both sides.
 *
 * The server renders each slide at exactly these pixels and the Studio's
 * picker offers exactly these names, so they live here rather than being typed
 * twice and drifting. Portrait is the default because 4:5 is the tallest shape
 * every feed shows uncropped — it takes the most screen of the four.
 *
 * NOT `video/assemble.ts`'s ASPECTS. That list is the shapes a VIDEO renders
 * at, and 4:5 is not one of them; adding it there would offer a portrait
 * option to every video format that has no idea what to do with it.
 */
export const CAROUSEL_SIZES = {
  square: { label: "Square", ratio: "1:1", width: 1080, height: 1080 },
  portrait: { label: "Portrait", ratio: "4:5", width: 1080, height: 1350 },
  story: { label: "Story", ratio: "9:16", width: 1080, height: 1920 },
  landscape: { label: "Landscape", ratio: "16:9", width: 1920, height: 1080 },
} as const;

export type CarouselSize = keyof typeof CAROUSEL_SIZES;

export const DEFAULT_CAROUSEL_SIZE: CarouselSize = "portrait";

/** Always six: a hook, four slides of substance, and the ask. */
export const CAROUSEL_SLIDES = 6;

/** A size name out of whatever a form or an agent sent, or the default. */
export function carouselSize(raw: unknown): CarouselSize {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v in CAROUSEL_SIZES ? (v as CarouselSize) : DEFAULT_CAROUSEL_SIZE;
}
