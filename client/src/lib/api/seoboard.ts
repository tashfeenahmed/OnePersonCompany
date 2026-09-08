import { call } from "@/lib/api";
import { growthApi, type Authority } from "@/areas/growth/api";
import { runsApi, type GeoDoc } from "@/lib/api/runs";
import { seoopsApi, type FollowUpsDoc } from "@/lib/api/seoops";

/**
 * THE FOUR SEO DOCUMENTS THIS BOX COMPUTES ITSELF, fetched for the board.
 *
 * ONE INPUT AND FOUR DOCUMENTS, and the reason it is one is the reason the
 * audit, the runs and the ledger are fetched unconditionally: nothing here is
 * behind a credential. Authority is arithmetic over rows other collectors
 * wrote, AI visibility is what a run recorded, the follow-ups are Search
 * Console readings this box took after a card was finished, and IndexNow is a
 * log of what this box sent. Four routes because they are four kinds of
 * thing — a figure, a tally, a verdict and a receipt — and NOTHING SUMS
 * ACROSS THEM; four fields on one document because the board asks once and
 * one route failing must not empty the other three, which `allSettled` and a
 * null per field are for.
 *
 * Each field carries its own clock — `generatedAt` on three of them, the
 * newest reading on the follow-ups — and `collectedAt` in live.tsx quotes the
 * one that belongs to the card's source rather than the moment this bundle
 * was assembled.
 */
export type IndexingOverview = {
  hosts: {
    host: string;
    submissions: number;
    received: number;
    refused: number;
    /** Attempts this box declined to make because the key file was missing —
     *  not a refusal by IndexNow, which is somebody else's no. */
    dryRun: number;
    last: { at: string; outcome: string; reason: string } | null;
  }[];
  autoSubmit: boolean;
  told: number;
  never: number;
  means: string;
  generatedAt: string;
};

export type SeoOpsDocs = {
  authority: { hosts: Authority[]; label: string; note: string } | null;
  geo: GeoDoc | null;
  followups: FollowUpsDoc | null;
  indexing: IndexingOverview | null;
  /** When the bundle was assembled. Not a source's clock — see above. */
  fetchedAt: string;
};

const settled = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export const seoboard = {
  /** All four, each null on its own failure and never on a neighbour's. */
  docs: async (): Promise<SeoOpsDocs> => {
    const [authority, geo, followups, indexing] = await Promise.all([
      settled(growthApi.authority()),
      settled(runsApi.geo("")),
      settled(seoopsApi.followUps()),
      settled(call<IndexingOverview>("/growth/indexing")),
    ]);
    return { authority, geo, followups, indexing, fetchedAt: new Date().toISOString() };
  },
};
