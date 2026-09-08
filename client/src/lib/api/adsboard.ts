import { call } from "@/lib/api";
import { growthApi, type AdsHealth } from "@/areas/growth/api";

/**
 * THE THREE ADS DOCUMENTS THIS BOX COMPUTES ITSELF, fetched for the board.
 *
 * `/api/meta` publishes what Meta SAID — an account's window, its campaigns,
 * its daily line — and stops there, which is right for a route that publishes a
 * measurement. It cannot answer the three questions the Ads board is actually
 * built around:
 *
 *   IS THE SPEND WORKING — a rubric over those same rows, scored on this box
 *   (`/growth/ads`), with the arithmetic printed and a coverage floor under
 *   which a subscore is refused rather than guessed;
 *
 *   WHAT RAN — the ADVERTISEMENTS, with the picture and the words people
 *   actually saw (`/webanalytics/creatives`). Meta's insights live at two
 *   grains and only this one carries a creative;
 *
 *   WHO IT WAS FOR — the campaign → venture map and the suggestions nobody has
 *   accepted yet (`/webanalytics/campaigns`), which is the only join between an
 *   ad account that knows nothing about a business and a portfolio that is
 *   made of them.
 *
 * ONE BUNDLE AND THREE FIELDS, seoboard.ts's shape and for its reason: the
 * board asks once, and one route failing must not empty the other two. Each
 * field is null on its own failure. NOTHING SUMS ACROSS THEM — a health score,
 * a creative's cost per click and a venture's spend are three different kinds
 * of thing measured over three different spans, and every card that draws one
 * says which.
 *
 * NO CREDENTIAL OF ITS OWN. All three read tables the Meta collector wrote, so
 * live.tsx gates the whole bundle on the Meta plugin exactly as it gates
 * `/api/meta` — an unconnected token is three cards showing samples, not three
 * cards showing zero.
 */

/** One advertisement's own window, summed from its daily rows. */
export type AdCreativeWindow = {
  /** The days that CARRIED A ROW, never the days in the window: Meta writes
   *  no row for a day an advertisement did not deliver. */
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  /** Null is "no row carried an actions map"; 0 is a row that delivered and
   *  produced none. */
  leads: number | null;
  /** A PERCENTAGE, derived from the sums — never a mean of daily rates. */
  ctr: number | null;
  cpm: number | null;
  cpc: number | null;
  costPerLead: number | null;
};

/** Meta's own figures for one explicit week. Reach and frequency appear ONLY
 *  here, because both are de-duplicated over the window Meta was asked about
 *  and neither can be recovered from daily rows at any grain. */
export type AdWeekFigures = {
  startDay: string;
  endDay: string;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  spend: number | null;
  ctr: number | null;
  cpm: number | null;
};

export type AdRow = {
  adId: string;
  adAccountId: string;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  name: string | null;
  /** effective_status — what is happening after the parents fold in. */
  status: string | null;
  configuredStatus: string | null;
  /** SIGNED AND EXPIRING within days. Never cached, and a frame that fails is
   *  hidden rather than drawn broken. */
  imageUrl: string | null;
  thumbUrl: string | null;
  title: string | null;
  body: string | null;
  callToAction: string | null;
  /** Where the advertisement SENT people. There is no permalink to an
   *  advertisement; Meta publishes none. */
  link: string | null;
  creativeName: string | null;
  createdTime: string | null;
  verdict: "fatigued" | "tiring" | "steady" | "no-verdict";
  /** Why there is no verdict, where there is none. Never a quiet "steady". */
  why: string | null;
  week: AdWeekFigures | null;
  before: AdWeekFigures | null;
  ctrChange: number | null;
  frequencyChange: number | null;
  evidence: string[];
  window: AdCreativeWindow;
  /** The days that carried a row, in order. A day this advertisement did not
   *  deliver has NO ENTRY — never a zero, which would read as a collapse. */
  daily: { day: string; spend: number | null; impressions: number | null; clicks: number | null }[];
  venture: { id: string; name: string | null } | null;
};

export type AdSetRow = {
  adsetId: string;
  adAccountId: string;
  campaignId: string | null;
  name: string | null;
  status: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  bidStrategy: string | null;
  /** MINOR UNITS of `currency`, as Meta sends them. Nothing divides by a
   *  hundred without saying so. */
  dailyBudgetMinor: number | null;
  lifetimeBudgetMinor: number | null;
  currency: string | null;
  startTime: string | null;
  endTime: string | null;
  ads: number;
};

export type AdStatusRow = {
  adId: string;
  name: string | null;
  status: string | null;
  configuredStatus: string | null;
  campaignId: string | null;
  /** META'S OWN issues_info, unedited. */
  issues: unknown[];
  /** Configured ACTIVE, effectively not delivering — it reads as live in the
   *  interface it was set up in. */
  mismatched: boolean;
};

export type CreativesDoc = {
  compareDays: number;
  windowDays: number;
  minImpressions: number;
  counts: Record<string, number>;
  adSets: AdSetRow[];
  ads: AdRow[];
  statuses: AdStatusRow[];
  rules: string[];
};

export type CampaignLink = {
  platform: string;
  campaignId: string;
  venture: { id: string; name: string | null };
  /** "auto-by-link" — a URL in the campaign pointed at that venture's host.
   *  "manual" — the owner chose. Neither is written without a press. */
  source: string;
  evidence: string | null;
  createdAt: string;
};

export type CampaignSuggestion = {
  platform: string;
  campaignId: string;
  campaignName: string | null;
  adAccountId: string | null;
  venture: { id: string; name: string | null };
  via: string;
  evidence: string | null;
};

export type CampaignMapDoc = {
  links: CampaignLink[];
  /** A SUGGESTION IS NOT A LINK — recomputed on every read, filed by nobody. */
  suggestions: CampaignSuggestion[];
  /** Campaigns that matched more than one venture. Nothing is applied. */
  contested: string[];
  rules: string[];
};

export type AdsBoardDocs = {
  health: { accounts: AdsHealth[]; note: string } | null;
  creatives: CreativesDoc | null;
  map: CampaignMapDoc | null;
  /** When the bundle was assembled. Not a source's clock — the cards quote
   *  the ad account's own `seenAt`, which is when Meta was last read. */
  fetchedAt: string;
};

const settled = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export const adsboard = {
  /** All three, each null on its own failure and never on a neighbour's. */
  docs: async (days: number): Promise<AdsBoardDocs> => {
    const [health, creatives, map] = await Promise.all([
      settled(growthApi.ads()),
      settled(call<CreativesDoc>(`/webanalytics/creatives?days=${days}`)),
      settled(call<CampaignMapDoc>("/webanalytics/campaigns")),
    ]);
    return { health, creatives, map, fetchedAt: new Date().toISOString() };
  },
};
