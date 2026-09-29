import { call } from "@/lib/api";

/**
 * PUBLIC TIKTOK — the watched accounts, their videos, the daily history this
 * box keeps of them, and the two trend reads. See server
 * integrations/analytics/tiktok-route.ts.
 *
 * Every count is TikTok's running total as of the last read; null is "not
 * read", never zero.
 */
export type TiktokVideo = {
  id: string;
  url: string | null;
  cover: string | null;
  caption: string | null;
  createdAt: string | null;
  duration: number | null;
  isPhoto: boolean;
  pinned: boolean;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  seenAt: string;
};

export type TiktokDay = {
  day: string;
  followers: number | null;
  likes: number | null;
  videos: number | null;
  /** Sum of play counts over the videos read that day. */
  views: number | null;
  /** Whether that read reached every video — only complete days difference. */
  viewsComplete: boolean;
  videosRead: number | null;
};

export type TiktokHandle = {
  handle: string;
  entity: string;
  url: string;
  nickname: string | null;
  avatar: string | null;
  bioHost: string | null;
  ventureId: string | null;
  ventureVia: "link" | "bio" | null;
  profile: {
    followers: number | null;
    following: number | null;
    likes: number | null;
    videos: number | null;
    seenAt: string | null;
  };
  days: TiktokDay[];
  videos: TiktokVideo[];
  lastOkAt: string | null;
  lastError: string | null;
  lastReadAt: string | null;
};

export type TiktokTerm = {
  term: string;
  /** Reciprocal rank summed over probes. ORDINAL — never a search volume. */
  score: number;
  rank: number;
  hits: number;
  firstSeen: string;
  daysSeen: number;
};

export type TiktokDiscoverItem = {
  id: string;
  rank: number;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  link: string | null;
  cover: string | null;
  views: number | null;
  followers: number | null;
  likes: number | null;
  videos: number | null;
  verified: boolean | null;
  firstSeen: string;
};

export type TiktokReport = {
  generatedAt: string;
  window: { days: number };
  handles: TiktokHandle[];
  searches: { seed: string; day: string | null; reads: number; lastReadAt: string | null; terms: TiktokTerm[] }[];
  discover: {
    day: string | null;
    region: string | null;
    lastReadAt: string | null;
    hashtags: TiktokDiscoverItem[];
    creators: TiktokDiscoverItem[];
    sounds: TiktokDiscoverItem[];
  };
  notes: Record<string, string>;
};

export const tiktokApi = {
  report: (days: number) => call<TiktokReport>(`/tiktok-public?days=${days}`),
};
