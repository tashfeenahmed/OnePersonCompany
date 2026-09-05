/**
 * THE STUDIO, THE BACKUPS AND THE SITE CAPTURE — the three routes behind the
 * Studio app and the three new Settings sections.
 *
 * WHY ONE FILE FOR THREE ROUTES. They are not one subject; they are one
 * SCREEN'S WORTH each, and every one of them is consumed by exactly one page
 * this file's owner also writes. Splitting them into three modules would buy a
 * tidier index and cost three imports on every page, which is the wrong trade
 * for a client with one caller per type. `lib/api.ts` stays the place for
 * anything a second page reads.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. Every type below was
 * written against `server/src/integrations/ventures/{studio,capture}.ts` and
 * `ops/backups-routes.ts` and checked against the live JSON — including the
 * nulls, which are the interesting half: `remoteOk: null` is "no remote is
 * configured", not "the copy failed"; `image: null` is "there is no picture",
 * and `error` beside it says why; `swapped: false` on a restore is the whole
 * point of that route and is typed as the literal it always is.
 */
import { call } from "@/lib/api";

/* ----------------------------------------------------------------- studio */

/**
 * Whether a post can be made at all, half by half.
 *
 * THE TWO HALVES FAIL SEPARATELY and this type keeps them separate, because
 * the page has to be able to say "words yes, picture no" — which is a real and
 * usable state on the server, not an error.
 */
export type StudioReadiness = {
  caption: {
    ready: boolean;
    /** The provider id, e.g. "freellmapi". Null when none is live. */
    provider: string | null;
    label: string | null;
    /** The provider's own default model, which is often null — it is not the
     *  image model and the page must not conflate them. */
    model: string | null;
    note: string;
  };
  image: {
    ready: boolean;
    /** How many Replicate tokens are stored. 0 means no picture will be made. */
    accounts: number;
    /** owner/name, always a string — the server substitutes its default. */
    model: string;
    isDefault: boolean;
    note: string;
  };
  formats: { key: string; ratio: string; about: string }[];
  note: string;
};

export type StudioFormat = "square" | "story" | "landscape";

/**
 * One post.
 *
 * `caption` is nullable and `image` is nullable and they are nullable for
 * different reasons, which is why `error` is one string covering both: the
 * server joins the problems it hit into one sentence rather than pretending
 * each half has its own status.
 */
export type StudioPost = {
  id: string;
  ventureId: string;
  ts: string;
  brief: string;
  platform: string | null;
  format: string;
  caption: string | null;
  /** Already split by the server — a list, never the stored line. */
  hashtags: string[];
  /** What the image model was actually told. The colours in it are the
   *  palette this post was made with, which is why the page shows them. */
  imagePrompt: string | null;
  /** The path to fetch the PNG from, or null when there is no picture. */
  image: string | null;
  imageOnDisk: boolean;
  model: string | null;
  /** Wall clock, milliseconds. NOT money — Replicate publishes no price. */
  ms: number | null;
  error: string | null;
};

export type StudioPosts = {
  venture: { id: string; slug: string; name: string } | null;
  posts: StudioPost[];
  readiness: StudioReadiness;
};

export type StudioCreated = {
  post: StudioPost;
  venture: { id: string; slug: string; name: string };
  imageMs: number;
  note: string;
};

/** Regenerate answers 200 with the post even when the half it was asked to
 *  remake failed, and puts the reason in `error`. */
export type StudioRegenerated = {
  post: StudioPost;
  ms?: number;
  error?: string | null;
};

export const studioApi = {
  readiness: () => call<StudioReadiness>("/studio"),

  /** `venture` is a venture's id or slug; omit it for every venture's posts. */
  posts: (venture?: string | null) =>
    call<StudioPosts>(
      `/studio/posts${venture ? `?venture=${encodeURIComponent(venture)}` : ""}`,
    ),

  create: (body: {
    ventureId: string;
    brief: string;
    format: StudioFormat;
    platform: string | null;
  }) =>
    call<StudioCreated>("/studio/posts", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  regenerate: (id: string, what: "caption" | "image") =>
    call<StudioRegenerated>(`/studio/posts/${id}/regenerate`, {
      method: "POST",
      body: JSON.stringify({ what }),
    }),

  remove: (id: string) =>
    call<{ ok: boolean; deleted: string }>(`/studio/posts/${id}`, {
      method: "DELETE",
    }),
};

/* ---------------------------------------------------------------- backups */

export type BackupArchive = {
  /** The absolute path on the box. */
  file: string;
  /** The bare file name, which is the only thing the run/verify/restore
   *  routes accept — they refuse a path. */
  name: string;
  bytes: number;
  at: string;
};

export type BackupRun = {
  ts: string;
  kind: string;
  ok: boolean;
  file: string | null;
  bytes: number | null;
  ms: number | null;
  members: string[] | null;
  /** null = no remote is configured, true = the copy left, false = it did
   *  not. A local archive is still a real backup. */
  remoteOk: boolean | null;
  error: string | null;
};

export type BackupsDoc = {
  settings: {
    dir: string;
    dirExists: boolean;
    remote: string | null;
    /** The fleet box whose ssh key rsync borrows, by label. */
    remoteKey: string | null;
    keep: number;
    hour: number;
    nightly: boolean;
    defaults: { keep: number; hour: number };
  };
  nextRunAt: string | null;
  contents: {
    always: string[];
    whenPresent: string[];
    never: string[];
    warning: string;
  };
  archives: BackupArchive[];
  totalBytes: number;
  runs: BackupRun[];
  summary: {
    archives: number;
    newest: BackupArchive | null;
    oldest: BackupArchive | null;
    lastRunAt: string | null;
    lastOkAt: string | null;
    /** The question the section exists to answer, as a sentence. */
    state: string;
  };
};

export type BackupResult = {
  ok: boolean;
  file: string | null;
  name: string | null;
  bytes: number | null;
  ms: number;
  remote: {
    attempted: boolean;
    ok: boolean | null;
    target: string | null;
    error: string | null;
  };
  members: string[];
  skipped: string[];
  pruned: string[];
  error: string | null;
  warning: string;
};

export type ArchiveMember = { name: string; bytes: number | null; raw: string };

export type BackupVerified = {
  /** The RESOLVED path, not the bare name that was sent — verify and restore
   *  echo back where they looked, which is not what the CLI takes. */
  file: string;
  ok: boolean;
  members: ArchiveMember[];
  bytes: number;
  hasDatabase: boolean;
  hasVaultKey: boolean;
  error: string | null;
  state: string;
};

/**
 * What `POST /api/backups/restore` did — which is extract and explain.
 *
 * `swapped` is typed as `false` and not as `boolean` on purpose: this route
 * has no path on which it becomes true, the swap is a CLI step with the server
 * stopped, and a page that treated it as a boolean would eventually draw the
 * branch that says the database was replaced when nothing was.
 */
export type BackupRestore = {
  /** The resolved path again — see BackupVerified. */
  file: string;
  extractedTo: string;
  members: ArchiveMember[];
  hasDatabase: boolean;
  hasVaultKey: boolean;
  swapped: false;
  note: string;
  steps: string[];
};

export const backupsApi = {
  get: () => call<BackupsDoc>("/backups"),
  run: () => call<BackupResult>("/backups/run", { method: "POST" }),
  verify: (file: string) =>
    call<BackupVerified>("/backups/verify", {
      method: "POST",
      body: JSON.stringify({ file }),
    }),
  restore: (file: string) =>
    call<BackupRestore>("/backups/restore", {
      method: "POST",
      body: JSON.stringify({ file }),
    }),
};

/* ---------------------------------------------------------------- capture */

export type CaptureVenture = {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  /** The newest attempt, successful or not — this is what says "Chrome is not
   *  installed" and "the page never loaded". */
  last: {
    ts: string;
    ok: boolean;
    bytes: number | null;
    width: number | null;
    height: number | null;
    error: string | null;
    ageDays: number | null;
  } | null;
  /** The newest attempt that produced a file. Null when there has never been
   *  one, which is not the same as the last one having failed. */
  picture: {
    ts: string;
    ageDays: number | null;
    onDisk: boolean;
    url: string;
  } | null;
  /** A rendered-DOM brand reading from `POST /rebrand`. Not a picture. */
  rendered: { ts: string; ageDays: number | null; domBytes: number | null } | null;
  due: boolean;
};

export type CaptureDoc = {
  browser: {
    found: boolean;
    path: string | null;
    /** "application", "path", "config" — where the path came from, because
     *  "found in /Applications" and "you typed this" are different claims. */
    source: string | null;
    error: string | null;
    windowSize: string;
    note: string;
  };
  refreshEveryDays: number;
  ventures: CaptureVenture[];
};

export type CaptureResult = {
  venture: { id: string; slug: string; name: string; website: string | null };
  ok: boolean;
  ts: string;
  /** Where the PNG landed on the box. On the wire and deliberately not drawn
   *  — the page shows the picture, and a path is of use to nobody reading a
   *  settings row. */
  path: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  browser: string | null;
};

export const captureApi = {
  get: () => call<CaptureDoc>("/capture"),
  /** One venture, by id or slug. Answers 200 whether or not it worked — a
   *  failed capture is a row, and `ok` is what says which happened. */
  shoot: (ventureKey: string) =>
    call<CaptureResult>(`/capture/${encodeURIComponent(ventureKey)}`, {
      method: "POST",
    }),
};
