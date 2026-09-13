import {
  mobileHealthApi,
  type Conversion,
  type Readiness,
  type Retention,
  type ReviewTrend,
  type Reviews,
  type Segments,
  type Stability,
  type Versions,
} from "@/areas/mobilehealth/api";

/**
 * WHAT THE APPS DO, FETCHED FOR THE BOARD — eight documents, one bundle.
 *
 * THIS IS THE `seoboard` SHAPE AND IT IS HERE FOR THE SAME REASON: the board
 * asks once, one route failing must not empty the other seven, and NOTHING
 * SUMS ACROSS THEM. A crash rate, a star, a store visitor and a version state
 * are four kinds of thing measured by four reports on two stores; the only
 * thing they share is the collector's six-hour clock, which is why they are
 * one source here and not filed under the App Store and Play cards that carry
 * the money. `/api/mobile` is a different clock and a different question — see
 * the `mobile` source in data/widgets.
 *
 * ITS OWN SOURCE RATHER THAN A WIDENING OF `mobile`, for the rule
 * `collectedAt` in lib/live is built on: one source per clock. The money
 * collector and this one run on their own timers and disagree about how fresh
 * they are, and that disagreement is a fact a card should be able to state.
 *
 * WHY THE THEMES ARE IN HERE AT ALL. `trend` is the only field that can reach
 * a model, and it is cached against the exact set of review ids it read — so
 * it costs a call only when a review this box has never seen arrives, which on
 * this account is a few times a month. The reviews are the half of this area a
 * board is most likely to be opened for; a card that could only exist on a
 * page nobody kept would not have been worth moving.
 */
export type MobileHealthDocs = {
  /** Which reports were asked for, what each store said, and the probes. */
  readiness: Readiness | null;
  /** Crash and ANR rates AND counts — two measurements, never one figure. */
  stability: Stability | null;
  /** The reviews themselves, with the window's star distribution. */
  reviews: Reviews | null;
  /** The same aggregates plus a model's reading of what they are about. */
  trend: ReviewTrend | null;
  /** Store visitors against acquisitions. Android only, and it says so. */
  conversion: Conversion | null;
  /** The install cohorts' curve, or the server's reason there is none. */
  retention: Retention | null;
  /** Where each version is, as observed once per collection. */
  versions: Versions | null;
  /**
   * Install segments for ONE dimension, because the route takes one.
   *
   * Country, which is the dimension the report's own Acquisition tab opens on
   * and the one both stores publish under a name of their own — Play calls it
   * `country`, Apple `territory`, and the route reconciles them. A picker
   * would be a second thing on a card that has no room for it; the card names
   * the dimension it drew instead.
   */
  segments: Segments | null;
  /** When the bundle was assembled — never a source's own clock. */
  fetchedAt: string;
};

const settled = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export const mobilehealthboard = {
  /** All eight, each null on its own failure and never on a neighbour's. */
  docs: async (days: number): Promise<MobileHealthDocs> => {
    const [readiness, stability, reviews, trend, conversion, retention, versions, segments] =
      await Promise.all([
        settled(mobileHealthApi.readiness()),
        settled(mobileHealthApi.stability({ days })),
        settled(mobileHealthApi.reviews({ days })),
        settled(mobileHealthApi.trend({ days })),
        settled(mobileHealthApi.conversion({ days })),
        settled(mobileHealthApi.retention({ days })),
        settled(mobileHealthApi.versions({ days })),
        settled(mobileHealthApi.segments({ days, dimension: "country", limit: 10 })),
      ]);
    return {
      readiness,
      stability,
      reviews,
      trend,
      conversion,
      retention,
      versions,
      segments,
      fetchedAt: new Date().toISOString(),
    };
  },
};
