/**
 * `/api/publishing`, from this side.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. Every type below was
 * written against `server/src/integrations/publishing/` and checked against the
 * live JSON — including the nulls, which are the interesting half:
 * `probe.at: null` is "nobody has ever asked", not a probe that failed;
 * `probe.ok: null` is the same fact from the other side; `permalink: null` on
 * a published item is a platform that gives no link (TikTok), never a post
 * that did not land.
 *
 * `problems` IS COMPUTED BY THE SERVER ON EVERY READ and is not stored. The
 * page never recomputes it: a caption trimmed in the browser is not the
 * caption the server will send, and a second implementation of the platform
 * limits here would be a second set of numbers to be wrong about.
 */
import { call } from "@/lib/api";
import { qs } from "@/lib/qs";

/* ---------------------------------------------------------------- shared */

export type DestinationKind = "page" | "ig" | "linkedin" | "tiktok";

export type Limits = {
  kind: DestinationKind;
  label: string;
  caption: number;
  hashtags: number | null;
  media: ("image" | "video" | "none")[];
  imageTypes: string[];
  imageBytes: number;
  videoBytes: number | null;
  /** How many pictures one carousel post may carry, or null where this app
   *  does not publish carousels to that destination at all. */
  carousel: { min: number; max: number } | null;
  /** Why not, when `carousel` is null. */
  carouselNote: string | null;
  needsPublicUrl: boolean;
  note: string;
};

export type Capabilities = {
  text: boolean;
  photo: boolean;
  video: boolean;
  /** What a false is missing, in the words that identify what to change. */
  missing: string[];
  facts: Record<string, string | number | boolean | null>;
  note: string;
};

export type Destination = {
  id: string;
  ventureId: string;
  plugin: string;
  account: string | null;
  accountId: number | null;
  kind: string;
  label: string;
  externalId: string;
  handle: string | null;
  enabled: boolean;
  capabilities: Capabilities;
  limits: Limits | null;
  probe: { at: string | null; ok: boolean | null; error: string | null };
};

export type LimitProblem = {
  field: "caption" | "media" | "hashtags" | "public-url";
  message: string;
};

export type ItemStatus =
  | "draft"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled";

export type PublishItem = {
  id: string;
  ventureId: string;
  venture: { id: string; slug: string; name: string } | null;
  destinationId: string | null;
  destination: {
    id: string;
    kind: string;
    label: string;
    handle: string | null;
    enabled: boolean;
    capabilities: Capabilities;
  } | null;
  source: { kind: string; id: string | null };
  caption: string | null;
  media: {
    /** `carousel` is several pictures, in order, as one post. */
    kind: "image" | "video" | "none" | "carousel";
    onDisk: boolean;
    mime: string | null;
    bytes: number | null;
    /** For a carousel, the FIRST slide — a thumbnail, never what is posted. */
    url: string | null;
    count: number;
    /** A carousel's slides, in order. Empty for every other kind. */
    images: { n: number; url: string; onDisk: boolean; mime: string | null; bytes: number | null }[];
  };
  status: ItemStatus;
  scheduledFor: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  note: string | null;
  campaignId: string | null;
  publishedAt: string | null;
  createdAt: string;
  problems: LimitProblem[];
};

export type StatusCounts = Record<ItemStatus, number>;

export type Readiness = {
  settings: {
    timezone: string;
    maxAttempts: number;
    blackout: string[];
    autoSchedule: string[];
    publicBaseUrl: string | null;
  };
  publicMedia: { configured: boolean; note: string };
  scheduler: { everyMs: number; due: number; next: { id: string; at: string | null } | null };
  destinations: { total: number; enabled: number; canPublish: number; neverProbed: number };
  counts: StatusCounts;
  kinds: Limits[];
  note: string;
};

export type ProbeReport = {
  at: string;
  venture: { id: string; name: string } | null;
  plugins: {
    plugin: string;
    connected: boolean;
    accountsTried: number;
    found: number;
    problems: string[];
    note: string;
  }[];
  destinations: Destination[];
  note: string;
};

/** One request a publish attempt made, or would have made. Credentials are
 *  already removed by the server; nothing here has to redact anything. */
export type RecordedCall = {
  method: string;
  url: string;
  body: string | null;
  status: number | null;
  ms: number | null;
  dry: boolean;
};

export type Attempt = {
  id: number;
  at: string;
  dry: boolean;
  ok: boolean;
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  ms: number | null;
  calls: RecordedCall[];
};

export type PublishResult = {
  ok: boolean;
  dry: boolean;
  itemId: string;
  status: string;
  externalId: string | null;
  permalink: string | null;
  error: string | null;
  note: string | null;
  calls: RecordedCall[];
  ms: number;
};

export type CalendarDay = { day: string; items: PublishItem[] };

export type Campaign = {
  id: string;
  ventureId: string;
  runId: string | null;
  goal: string;
  audience: string | null;
  channels: string[];
  brief: string[];
  startsOn: string | null;
  endsOn: string | null;
  status: string;
  /** The producing run's own status. Null when the campaign was never run. */
  runStatus: string | null;
  /** The run is over and the campaign still says it is working — the server
   *  restarting mid-run is the common cause. Not a stored field: a reading. */
  stalled: boolean;
  progress: { planned: number; produced: number; failed: number; remaining: number };
  concepts: {
    id: string;
    idx: number;
    theme: string;
    description: string | null;
    imageNote: string | null;
    variants: { id: string; channel: string; postId: string | null; itemId: string | null; error: string | null }[];
  }[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Asset = {
  id: string;
  ventureId: string;
  kind: string;
  name: string | null;
  mime: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
  source: string;
  sourceUrl: string | null;
  prompt: string | null;
  notes: string | null;
  onDisk: boolean;
  url: string;
  usedCount: number;
  lastUsedAt: string | null;
  createdAt: string;
};

/** Whether the CURRENT image model can be handed a picture, read off that
 *  model's own schema. `checked: false` is "could not ask" — never "no". */
export type ImageModelSupport = {
  model: string;
  checked: boolean;
  supported: boolean;
  field: string | null;
  many: boolean;
  note: string;
};

export type AssetsDoc = {
  venture: { id: string; slug: string; name: string } | null;
  assets: Asset[];
  kinds: readonly string[];
  bytes: number;
  uploadCap: number;
  imageModel: ImageModelSupport;
  note: string;
};

export const publishingApi = {
  readiness: () => call<Readiness>("/publishing"),

  destinations: (venture?: string | null) =>
    call<{ venture: unknown; destinations: Destination[]; kinds: Limits[]; note: string }>(
      `/publishing/destinations${qs({ venture })}`,
    ),

  probe: (ventureId: string) =>
    call<ProbeReport>("/publishing/destinations/probe", {
      method: "POST",
      body: JSON.stringify({ ventureId }),
    }),

  setDestination: (id: string, patch: { enabled?: boolean; ventureId?: string }) =>
    call<{ destination: Destination }>(`/publishing/destinations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  removeDestination: (id: string) =>
    call<{ ok: boolean }>(`/publishing/destinations/${id}`, { method: "DELETE" }),

  items: (opts: { venture?: string | null; status?: string | null; campaign?: string | null } = {}) =>
    call<{ venture: unknown; counts: StatusCounts; items: PublishItem[]; note: string }>(
      `/publishing/items${qs(opts)}`,
    ),

  item: (id: string) =>
    call<{ item: PublishItem; attempts: Attempt[]; publicMediaUrl: string | null }>(
      `/publishing/items/${id}`,
    ),

  queue: (body: {
    ventureId?: string;
    sourceKind: "studio_post" | "video_job" | "video_clip" | "carousel" | "manual";
    sourceId?: string;
    destinationId?: string | null;
    caption?: string;
  }) =>
    call<{ item: PublishItem; created: boolean; note: string }>("/publishing/items", {
      method: "POST",
      body: JSON.stringify({
        ventureId: body.ventureId,
        source: { kind: body.sourceKind, id: body.sourceId ?? null },
        destinationId: body.destinationId ?? null,
        caption: body.caption,
      }),
    }),

  /**
   * Edit the words or the account. AN EDIT UNAPPROVES: the server returns the
   * item as a `draft` again with `unapproved: true`, because the approval was
   * of a document and the document is now a different one.
   */
  patchItem: (id: string, patch: { caption?: string; destinationId?: string | null }) =>
    call<{ item: PublishItem; unapproved: boolean; note: string | null }>(
      `/publishing/items/${id}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    ),

  approve: (id: string) =>
    call<{ item: PublishItem; note: string }>(`/publishing/items/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ by: "owner" }),
    }),

  schedule: (id: string, at: string) =>
    call<{ item: PublishItem; timezone: string }>(`/publishing/items/${id}/schedule`, {
      method: "POST",
      body: JSON.stringify({ at }),
    }),

  unschedule: (id: string) =>
    call<{ item: PublishItem }>(`/publishing/items/${id}/unschedule`, { method: "POST" }),

  cancel: (id: string) =>
    call<{ item: PublishItem }>(`/publishing/items/${id}/cancel`, { method: "POST" }),

  /**
   * A rehearsal. Its OWN route, which cannot publish — see the server's
   * comment: this was a `dry` flag on the publish route until the flag arrived
   * as the string `"true"` from the skills proxy, read false, and posted for
   * real. A route that can only rehearse is the only shape of this that is
   * safe.
   */
  rehearse: (id: string) =>
    call<{ result: PublishResult; item: PublishItem | null }>(`/publishing/items/${id}/rehearse`, {
      method: "POST",
    }),

  /** This one really posts. */
  publish: (id: string) =>
    call<{ result: PublishResult; item: PublishItem | null }>(`/publishing/items/${id}/publish`, {
      method: "POST",
      body: JSON.stringify({ dry: false }),
    }),

  retry: (id: string) =>
    call<{ result: PublishResult; item: PublishItem }>(`/publishing/items/${id}/retry`, {
      method: "POST",
    }),

  calendar: (opts: { venture?: string | null; days?: number; from?: string } = {}) =>
    call<{
      timezone: string;
      from: string;
      days: number;
      calendar: CalendarDay[];
      outside: number;
      blackout: string[];
      note: string;
    }>(`/publishing/calendar${qs(opts)}`),

  tick: () =>
    call<{
      at: string;
      ran: boolean;
      why: string;
      reclaimed: number;
      due: number;
      publishedId: string | null;
      error: string | null;
    }>("/publishing/tick", { method: "POST" }),

  campaigns: (venture?: string | null) =>
    call<{ venture: unknown; campaigns: Campaign[]; note: string }>(
      `/publishing/campaigns${qs({ venture })}`,
    ),

  campaignSuggestions: (venture: string) =>
    call<{
      venture: { id: string; slug: string; name: string };
      channels: { channel: string; label: string; destinationId: string | null; note: string }[];
      angles: { title: string; why: string }[];
      note: string;
    }>(`/publishing/campaigns/suggestions${qs({ venture })}`),

  /** Forget a plan. The drafts it produced are kept. */
  removeCampaign: (id: string) =>
    call<{ ok: boolean; note: string }>(`/publishing/campaigns/${id}`, { method: "DELETE" }),

  startCampaign: (body: {
    ventureId: string;
    goal: string;
    channels: string[];
    audience?: string;
    concepts?: number;
  }) =>
    call<{ run: { id: string; kind: string; status: string }; note: string }>(
      "/publishing/campaigns",
      { method: "POST", body: JSON.stringify(body) },
    ),

  assets: (opts: { venture?: string | null; kind?: string | null } = {}) =>
    call<AssetsDoc>(`/publishing/assets${qs(opts)}`),

  /** A multipart POST, so it does NOT go through `call` — that helper sets a
   *  JSON content type, and a multipart body needs the browser to write its
   *  own boundary. The 401 redirect `call` performs is not lost: a browser
   *  that has been logged out will hit it on the very next read. */
  uploadAsset: async (body: {
    ventureId: string;
    kind: string;
    file: File;
    name?: string;
    prompt?: string;
  }): Promise<{ asset: Asset }> => {
    const form = new FormData();
    form.set("ventureId", body.ventureId);
    form.set("kind", body.kind);
    form.set("file", body.file, body.file.name);
    if (body.name) form.set("name", body.name);
    if (body.prompt) form.set("prompt", body.prompt);
    const res = await fetch("/api/publishing/assets", { method: "POST", body: form });
    const doc: unknown = await res.json().catch(() => null);
    if (!res.ok)
      throw new Error(
        doc && typeof doc === "object" && "error" in doc
          ? String((doc as { error: unknown }).error)
          : `HTTP ${res.status}`,
      );
    window.dispatchEvent(new Event("opc:data-changed"));
    return doc as { asset: Asset };
  },

  importAsset: (body: { ventureId: string; kind: string; url: string; name?: string; prompt?: string }) =>
    call<{ asset: Asset }>("/publishing/assets", { method: "POST", body: JSON.stringify(body) }),

  patchAsset: (id: string, patch: { kind?: string; name?: string; prompt?: string; notes?: string; ventureId?: string }) =>
    call<{ asset: Asset }>(`/publishing/assets/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  removeAsset: (id: string) =>
    call<{ ok: boolean }>(`/publishing/assets/${id}`, { method: "DELETE" }),
};
