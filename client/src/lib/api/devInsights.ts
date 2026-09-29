import { call } from "@/lib/api";

/**
 * STARS BY DAY, RELEASE DOWNLOADS AND PER-REPO DAILY TRAFFIC — the Development
 * board's second document. See server providers/githubInsights.ts.
 */
export type DevInsights = {
  window: { days: number; from: string; to: string };
  generatedAt: string;
  starDays: { repo: string; day: string; n: number }[];
  /** From which day each repo's star history is complete. */
  starCoverage: { repo: string; covered_from: string; synced_at: string }[];
  releases: {
    repo: string; tag: string; name: string | null; publishedAt: string | null; downloads: number;
    assets: { name: string; downloads: number; platform: string }[];
  }[];
  /** Each repo's running download total, one snapshot per day. */
  releaseDays: { repo: string; day: string; downloads: number }[];
  repoTraffic: { repo: string; day: string; views: number; uniques: number; clones: number }[];
};

export const devInsightsApi = {
  doc: (days: number) => call<DevInsights>(`/github/insights?days=${days}`),
};
