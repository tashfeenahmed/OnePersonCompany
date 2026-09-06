/**
 * `/api/socialfeed`, from this side.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND, and the nulls are the
 * interesting half. `metrics` is a bag keyed by META'S OWN metric names, not a
 * fixed shape, precisely because a shape with a `reach` field would force this
 * file to decide that `post_media_view` and Instagram's `reach` are the same
 * number — which they are not. A key that is absent was not reported; it is
 * not zero, and nothing on this side supplies one.
 */
import { call } from "@/lib/api";

/* --------------------------------------------------------------- posts */

export type SocialPost = {
  platform: string;
  id: string;
  pageId: string;
  pageName: string | null;
  ventureId: string | null;
  ventureName: string | null;
  createdTime: string | null;
  permalink: string | null;
  mediaType: string | null;
  imageUrl: string | null;
  text: string | null;
  /** Meta's own metric names. Never renamed, never summed across platforms. */
  metrics: Record<string, number>;
  note: string | null;
  fetchedAt: string;
  /** The draft this box generated, where the post came out of one. Null means
   *  it was posted somewhere else, which is most posts. */
  fromDraft: { id: string; sourceKind: string; sourceId: string | null; caption: string | null } | null;
};

export type SocialAccount = {
  platform: string;
  pageId: string;
  pageName: string | null;
  account: string | null;
  ventureId: string | null;
  ventureName: string | null;
  /** The last time posts actually came back. A failing Page keeps this. */
  lastOkAt: string | null;
  lastTriedAt: string | null;
  posts: number | null;
  error: string | null;
  insightsError: string | null;
};

export type PostsDoc = {
  venture: { id: string; slug: string; name: string } | null;
  lastReadAt: string | null;
  posts: SocialPost[];
  accounts: SocialAccount[];
  metrics: { facebook: string[]; retired: string[]; instagram: string[]; note: string };
  /** `instagramLinked` is NULL until a read has happened — not measured, not
   *  "none". Zero after a read means no Page has one linked. */
  coverage: { pagesMapped: number; instagramLinked: number | null; note: string };
  note: string;
};

export type CollectResult = {
  ok: boolean;
  at: string;
  pages: number;
  posts: number;
  problems: { page: string; error: string }[];
  instagram: number;
  error: string | null;
  note: string;
};

/* ------------------------------------------------------------- sourcing */

export type Candidate = {
  id: string;
  ventureId: string;
  query: string;
  url: string;
  sourceId: string | null;
  title: string | null;
  author: string | null;
  engine: string | null;
  publishedAt: string | null;
  durationS: number | null;
  /** `yt-dlp` is measured; `searxng` is the engine's own string; null is
   *  neither. It decides how much the duration is worth. */
  durationFrom: string | null;
  score: number | null;
  rank: number | null;
  verdict: string;
  reason: string | null;
  ts: string;
};

export type HistoryEntry = {
  id: number;
  ventureId: string;
  ventureName: string | null;
  format: string;
  topic: string;
  fingerprint: string;
  sourceUrl: string | null;
  sourceId: string | null;
  pageUrl: string | null;
  assetKind: string | null;
  assetRef: string | null;
  createdAt: string;
  /** Null is a live entry the gate counts. A date is one the owner set aside:
   *  the gate ignores it and the row is still here. */
  archivedAt: string | null;
};

export type Verdict = {
  id: number;
  ts: string;
  ventureId: string | null;
  format: string;
  kind: string;
  value: string;
  verdict: string;
  reason: string | null;
  matched: string | null;
  matchedId: number | null;
  score: number | null;
};

export type SourcingDoc = {
  venture: { id: string; slug: string; name: string } | null;
  settings: {
    noveltyDays: number;
    repeatLimit: number;
    minMinutes: number;
    maxMinutes: number;
    probeTop: number;
    channels: { venture: string; url: string }[];
    /** Where a finished asset is announced. `off` still files the draft. */
    deliverTo: "telegram" | "off";
  };
  ventures: { id: string; slug: string; name: string; channel: string | null }[];
  candidates: Candidate[];
  history: HistoryEntry[];
  verdicts: Verdict[];
  deliveries: { ref: string; ventureId: string | null; at: string; channel: string | null; sent: boolean; reason: string | null; publishItem: string | null }[];
  note: string;
};

export type Discovery = {
  ok: boolean;
  query: string;
  channel: string | null;
  candidates: (Candidate & { url: string })[];
  chosen: { url: string; title: string } | null;
  why: string;
  enginesRefused: { engine: string; reason: string }[];
  error: string | null;
  note: string;
};

/* ------------------------------------------------------------------ ugc */

export type UgcJob = {
  runId: string;
  ventureId: string | null;
  ts: string;
  assetIds: string[];
  imagePrompt: string | null;
  videoPrompt: string | null;
  imageModel: string | null;
  /** Null means the image model takes NO picture as an input and the
   *  references were described in words, which is much weaker. */
  imageField: string | null;
  videoModel: string | null;
  seconds: number | null;
  captions: string | null;
  publishItem: string | null;
  steps: { step: string; ok: boolean; note: string }[];
  skipped: string | null;
  error: string | null;
  imageOnDisk: boolean;
  videoOnDisk: boolean;
};

export type UgcDoc = {
  venture: { id: string; slug: string; name: string } | null;
  ready: {
    replicate: boolean;
    imageModel: string;
    /** Null is the default and is not a fault: the animation step is skipped
     *  and nothing is spent on video. */
    videoModel: string | null;
    seconds: number;
    note: string;
  };
  ventures: { id: string; slug: string; name: string; assets: number; canRun: boolean }[];
  jobs: UgcJob[];
  note: string;
};

export type UgcStarted = {
  run: { id: string; kind: string; status: string; title: string };
  queued: number;
  spend: { image: string; video: string };
  note: string;
};

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const text = s.toString();
  return text ? `?${text}` : "";
};

export const socialfeedApi = {
  posts: (params: { venture?: string; platform?: string; limit?: number } = {}) =>
    call<PostsDoc>(`/socialfeed/posts${q(params)}`),
  collect: () => call<CollectResult>("/socialfeed/collect", { method: "POST" }),
  sourcing: (params: { venture?: string; limit?: number } = {}) =>
    call<SourcingDoc>(`/socialfeed/sourcing${q(params)}`),
  discover: (venture: string, topic: string) =>
    call<Discovery>("/socialfeed/discover", { method: "POST", body: JSON.stringify({ venture, topic }) }),
  forget: (id: number) => call<{ ok: true; id: number; already: boolean; note: string }>("/socialfeed/forget", { method: "POST", body: JSON.stringify({ id }) }),
  restore: (id: number) => call<{ ok: true; id: number; note: string }>("/socialfeed/restore", { method: "POST", body: JSON.stringify({ id }) }),
  deliver: () => call<{ looked: number; delivered: { ref: string; sent: boolean; reason: string | null }[]; note: string }>("/socialfeed/deliver", { method: "POST" }),
  ugc: (params: { venture?: string; limit?: number } = {}) => call<UgcDoc>(`/socialfeed/ugc${q(params)}`),
  startUgc: (body: { venture: string; brief?: string; assets?: string[]; aspect?: string }) =>
    call<UgcStarted>("/socialfeed/ugc/start", { method: "POST", body: JSON.stringify(body) }),
};
