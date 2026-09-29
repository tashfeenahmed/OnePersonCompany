import { call } from "@/lib/api";

/**
 * EVERY APP, BOTH STORES JOINED ON THE BUNDLE ID — the Apps board's document.
 * See server integrations/mobilehealth/apps.ts. One document for every app so
 * the board's app picker narrows every card without a request per card.
 */
export type AppEntry = {
  key: string;
  name: string;
  /** A small data URL from the store listing, or null before release. */
  icon: string | null;
  ventureId: string | null;
  appstore: {
    id: string; state: string | null; onStore: boolean | null; version: string | null;
    url: string | null; rating: number | null; ratingCount: number | null;
  } | null;
  play: { package: string; url: string | null; rating: number | null; ratingCount: number | null; activeDevices: number | null; activeAt: string | null } | null;
  /** Weighted across stores where counts are known; count null = Play's Console average alone. */
  rating: { average: number; count: number | null } | null;
  totals: { ios: number; android: number; uninstalls: number };
  daily: { day: string; ios: number; android: number }[];
  countries: { label: string; n: number }[];
  sources: { label: string; n: number; store: "appstore" | "play" }[];
  /** Play's store listing: visitors and acquisitions over the window. */
  listing: { visitors: number; acquisitions: number } | null;
  stability: { crashes: number; anrs: number } | null;
  reviews: { count: number; average: number | null; stars: number[] };
};

export type AppReview = {
  key: string; store: string; id: string; rating: number | null; title: string | null; body: string | null;
  author: string | null; territory: string | null; version: string | null; created: string | null; replied: boolean;
};

export type AppsDoc = {
  window: { days: number; from: string; to: string };
  generatedAt: string;
  listingsFetchedAt: string | null;
  apps: AppEntry[];
  reviews: AppReview[];
};

export const appsApi = {
  doc: (days: number) => call<AppsDoc>(`/mobilehealth/apps?days=${days}`),
};

/** The document narrowed to one app — what every Apps card reads when the
 *  board's picker has one selected. */
export function narrowApps(doc: AppsDoc, key: string | null): AppsDoc {
  if (!key) return doc;
  return { ...doc, apps: doc.apps.filter((a) => a.key === key), reviews: doc.reviews.filter((r) => r.key === key) };
}
