import { call, type VentureBrand, type VentureStage } from "@/lib/api";
import { qs } from "@/lib/qs";
import type { Asset } from "@/areas/publishing/api";

/**
 * THE REFERENCE MATERIAL, FROM THIS SIDE.
 *
 * TWO SHAPES BEHIND ONE PATH, and the types keep them apart rather than
 * merging them into one optional-everything object. `/api/references` with no
 * venture is an OVERVIEW — a row per business, counts and a boolean — and with
 * one it is the whole document for that business. A single type covering both
 * would make every field optional, and a page reading `guide.tone` off the
 * overview would compile.
 *
 * THE ASSET TYPE IS THE PUBLISHING AREA'S, IMPORTED RATHER THAN RESTATED. The
 * pictures on this page are that library — same table, same route, same file
 * URLs — and a second declaration of the same JSON is how the two end up
 * disagreeing about whether `prompt` can be null.
 *
 * THE UPLOADS DO NOT GO THROUGH HERE EITHER. Adding a picture is
 * `publishingApi.uploadAsset` / `importAsset` / `patchAsset` / `removeAsset`,
 * because the route that accepts a file is the publishing area's and there is
 * only one of it. This module owns exactly one write: the style guide.
 *
 * `written: false` IS THE FIELD TO READ FIRST on a guide. Every field will be
 * null and that means UNWRITTEN, not "he decided this business has no tone".
 */

/** The nine fields, all optional, all prose. Null is unwritten. */
export type StyleGuide = {
  ventureId: string;
  /** Whether anything at all has been typed. A saved blank form is not a
   *  guide, and this is how the page tells the difference. */
  written: boolean;
  updatedAt: string | null;
  summary: string | null;
  tone: string | null;
  audience: string | null;
  dos: string | null;
  donts: string | null;
  /** Prose about colour, NOT hexes. The hexes are measured and live on
   *  `brand.palette`; this is the sentence that says the measurement is out of
   *  date. */
  colours: string | null;
  fonts: string | null;
  language: string | null;
  /** A note to a person. Deliberately not put in any prompt. */
  notes: string | null;
};

/** The ceiling per field, in characters, as the server enforces it. Sent down
 *  so the form can show what it will be held to instead of finding out on a
 *  failed save. */
export type GuideLimits = Record<keyof Omit<StyleGuide, "ventureId" | "written" | "updatedAt">, number>;

export type ReferencesVenture = {
  id: string;
  slug: string;
  name: string;
  stage: VentureStage;
  description: string;
  website: string | null;
  color: string;
  /** "owner" when he picked it, otherwise it was measured off the site. */
  colorSource: string;
};

/** One venture's whole document. */
export type ReferencesDoc = {
  venture: ReferencesVenture;
  /** MEASURED off the site. `enrichedAt: null` means never read — an empty
   *  palette there is "not measured" and never "this site has no colours". */
  brand: VentureBrand;
  guide: StyleGuide;
  limits: GuideLimits;
  assets: Asset[];
  kinds: readonly string[];
  bytes: number;
  uploadCap: number;
  note: string;
};

/** One row of the overview: what this business has, without the contents. */
export type ReferencesRow = {
  id: string;
  slug: string;
  name: string;
  stage: VentureStage;
  description: string;
  guide: boolean;
  guideUpdatedAt: string | null;
  /** Keyed by kind, plus `total`. */
  assets: Record<string, number>;
};

export type ReferencesOverview = {
  venture: null;
  kinds: readonly string[];
  ventures: ReferencesRow[];
  note: string;
};

export const referencesApi = {
  overview: () => call<ReferencesOverview>("/references"),

  read: (venture: string) => call<ReferencesDoc>(`/references${qs({ venture })}`),

  /**
   * Save the guide.
   *
   * A MERGE, NOT A REPLACEMENT: a field that is not in `patch` is left as it
   * was on the server, and an empty string clears one. The form sends all nine
   * every time, so for the page the distinction is invisible; it exists for
   * the agent, which is handed one field to change and must not wipe the other
   * eight to do it.
   */
  saveGuide: (venture: string, patch: Partial<Record<keyof GuideLimits, string>>) =>
    call<{ venture: { id: string; slug: string; name: string }; guide: StyleGuide; note: string }>(
      `/references/${encodeURIComponent(venture)}/guide`,
      { method: "PUT", body: JSON.stringify(patch) },
    ),
};
