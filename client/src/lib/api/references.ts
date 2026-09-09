import { call, type VentureBrand, type VentureStage } from "@/lib/api";
import { qs } from "@/lib/qs";
import type { Asset } from "@/areas/publishing/api";

/**
 * THE REFERENCE MATERIAL, FROM THIS SIDE.
 *
 * TWO SHAPES BEHIND ONE PATH, and the types keep them apart rather than
 * merging them into one optional-everything object. `/api/references` with no
 * venture is the OVERVIEW — a row per business carrying its measured brand,
 * its guide and its asset counts, which is everything the Logos & branding
 * tab needs to draw every card from one request — and with one it is the
 * whole document for that business, pictures included.
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
 * TWO KINDS OF FIELD ON THE GUIDE. The prose fields are opinion in sentences
 * and null means unwritten. The brand fields — four hexes and a logo — are
 * the owner's word OVER the measurement: null means "use what was read off
 * the site", a hex means "no, this one". The card shows which is in force.
 */

export type GuideTextField =
  | "summary"
  | "tone"
  | "audience"
  | "dos"
  | "donts"
  | "colours"
  | "fonts"
  | "language"
  | "notes"
  | "style";

export type GuideBrandField = "primary" | "secondary" | "background" | "ink" | "logo";

export type StyleGuide = Record<GuideTextField, string | null> &
  Record<GuideBrandField, string | null> & {
    ventureId: string;
    /** Whether anything at all has been typed or chosen. A saved blank form
     *  is not a guide, and this is how the page tells the difference. */
    written: boolean;
    updatedAt: string | null;
  };

/** The ceiling per prose field, in characters, as the server enforces it. */
export type GuideLimits = Record<GuideTextField, number>;

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

/** One row of the overview: the brand card's worth, without the pictures. */
export type ReferencesRow = {
  id: string;
  slug: string;
  name: string;
  stage: VentureStage;
  description: string;
  website: string | null;
  guide: boolean;
  guideUpdatedAt: string | null;
  brand: VentureBrand;
  style: StyleGuide;
  /** Keyed by kind, plus `total`. */
  assets: Record<string, number>;
};

export type ReferencesOverview = {
  venture: null;
  kinds: readonly string[];
  ventures: ReferencesRow[];
  limits: GuideLimits;
  note: string;
};

export type GuidePatch = Partial<Record<GuideTextField | GuideBrandField, string>>;

export const referencesApi = {
  overview: () => call<ReferencesOverview>("/references"),

  read: (venture: string) => call<ReferencesDoc>(`/references${qs({ venture })}`),

  /**
   * Save the guide.
   *
   * A MERGE, NOT A REPLACEMENT: a field that is not in `patch` is left as it
   * was on the server, and an empty string clears one — which for a brand
   * field means "back to the measurement". The card sends only what changed.
   */
  saveGuide: (venture: string, patch: GuidePatch) =>
    call<{ venture: { id: string; slug: string; name: string }; guide: StyleGuide; note: string }>(
      `/references/${encodeURIComponent(venture)}/guide`,
      { method: "PUT", body: JSON.stringify(patch) },
    ),
};
