import { call } from "@/lib/api";
import { seg } from "@/lib/qs";

/**
 * THE THREE THINGS THIS BOX KNOWS ABOUT A VENTURE THAT THE VENTURE RECORD
 * DOES NOT: what it is connected to, what it looks like, and what is wrong
 * with it.
 *
 * These live in their own file rather than in `lib/api.ts` because they are
 * about a JOIN rather than about a service. `/api/gsc` answers with every
 * property and has never heard of a venture; `/api/venture-links` is the only
 * place that says `sc-domain:example.com` and the Cloudflare zone
 * `example.com` are two views of one business. That statement is the owner's,
 * stored as a row, and every type below carries the field that says so —
 * `source: "owner" | "auto"` — because "somebody looked at this and said yes"
 * and "this was accepted in a list of twelve" are different claims.
 *
 * THE TYPES ARE TRANSCRIBED FROM THE SERVER'S OWN, not guessed from a sample
 * response. Where the server says `string | null` this says `string | null`,
 * and the pages below it are written to draw the null: a capture that has
 * never been taken, a sitemap that could not be counted, an audit that has
 * never been run. Null means asked and not told, and nowhere in here is it
 * flattened into a zero.
 */

/* ------------------------------------------------------------------ links */

/** A thing one integration holds: a Cloudflare zone, a Search Console
 *  property, an uptime host. `entity` is that integration's OWN identifier
 *  for it — a zone id, a `sc-domain:` string, a package name — and it is what
 *  a link is stored against. */
export type Entity = {
  plugin: string;
  entity: string;
  label: string;
  /** The hostname it is about, when it has one. A fleet box does not. */
  host: string | null;
};

/** An entity plus the sentence that proposed it. Never stored: suggestions are
 *  recomputed on every read, so one about a zone deleted this morning stops
 *  being offered without anybody clearing a cache. */
export type Suggestion = Entity & { why: string };

/** A stored edge: this venture owns this thing. */
export type VentureLink = {
  plugin: string;
  entity: string;
  label: string | null;
  /** `owner` was linked one at a time; `auto` came in with "Accept all".
   *  Re-linking by hand promotes it, and nothing ever demotes it. */
  source: "owner" | "auto";
  createdAt: string;
};

/** Which listings were consulted, and what each said. Shipped so that
 *  "nothing from Umami" and "Umami was never asked" cannot read the same. */
export type SourceNote = {
  plugin: string;
  ok: boolean;
  entities: number;
  note: string | null;
};

export type VentureLinks = {
  venture: {
    id: string;
    slug: string;
    name: string;
    host: string | null;
    website: string | null;
  };
  links: VentureLink[];
  suggestions: Suggestion[];
  sources: SourceNote[];
  note: string;
};

/** What every write to the link table answers with: the table afterwards. The
 *  page redraws from this rather than from its own optimistic guess. */
export type LinksAfterWrite = { links: VentureLink[] };

/** A single link written or removed. The route answers `ok: true` AND the
 *  fresh list; a second client for these calls typed only the `ok`, so its one
 *  caller threw the list away and re-fetched a document it had already been
 *  handed. Both fields are named here so neither can be lost again. */
export type LinkWriteResult = LinksAfterWrite & { ok: true };

export type AcceptAll = LinksAfterWrite & {
  accepted: number;
  /** What was accepted and why — a bulk press leaving a record of what it was
   *  told, not only of what it did. */
  because: { plugin: string; entity: string; why: string }[];
};

/** The whole graph in one document. `entities` is EVERY entity, not only the
 *  linked ones: a map that drew only what is connected could not show what is
 *  not, and "twenty-three zones, nineteen of them belonging to no venture" is
 *  the most useful sentence it has. */
export type LinkMap = {
  ventures: {
    id: string;
    name: string;
    slug: string;
    color: string;
    stage: string;
    host: string | null;
  }[];
  plugins: { id: string; connected: boolean; entities: number }[];
  entities: Entity[];
  edges: {
    venture: string;
    plugin: string;
    entity: string;
    label: string | null;
    source: "owner" | "auto";
    /** False means the link points at something no collector currently
     *  reports. Not an error — a paused integration and a deleted zone look
     *  the same from here. */
    present: boolean;
  }[];
  unlinked: { plugin: string; entity: string; label: string }[];
  sources: SourceNote[];
  note: string;
};

/* ---------------------------------------------------------------- capture */

export type CaptureBrowser = {
  found: boolean;
  path: string | null;
  /** Where the path came from: `configured` is the owner's own, `known` and
   *  `path` were found. Different claims, so they are kept apart. `known` read
   *  `application` while the search was macOS-shaped; it is a general binary
   *  search now and the word moved with it. */
  source: "configured" | "known" | "path" | "none";
  error: string | null;
  windowSize: string;
  note: string;
};

/** The newest row in the shot table, whether or not it produced a picture. */
export type CaptureShot = {
  ts: string;
  ok: boolean;
  bytes: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  ageDays: number | null;
};

/** The newest row that DID produce a picture, which is not always the newest
 *  row: a failed attempt does not delete the last good photograph. */
export type CapturePicture = {
  ts: string;
  ageDays: number | null;
  onDisk: boolean;
  /** Already an absolute path on this origin — do not prefix it with /api. */
  url: string;
};

/** Colours out of a rendered page. A COARSER reading than the venture's own
 *  brand, which is parsed from the raw HTML and its stylesheets. */
export type RenderedReading = {
  readAt: string;
  source: string;
  title: string | null;
  palette: {
    primary: string | null;
    secondary: string | null;
    accent: string | null;
    background: string | null;
    ink: string | null;
    ranked: { hex: string; weight: number }[];
  };
  counts: number;
  notes: string[];
};

export type CaptureRendered = {
  ts: string;
  ageDays: number | null;
  domBytes: number | null;
  reading: RenderedReading | null;
};

export type CaptureVenture = {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  last: CaptureShot | null;
  picture: CapturePicture | null;
  rendered: CaptureRendered | null;
  /** The weekly refresh's own verdict, so the page does not re-derive it. */
  due: boolean;
};

export type CaptureReport = {
  browser: CaptureBrowser;
  refreshEveryDays: number;
  ventures: CaptureVenture[];
};

/** One run. It answers 200 whether or not it took the picture — a browser that
 *  could not load the page is an answer, not a transport failure — so `ok` is
 *  the thing to read, never the status. */
export type CaptureRun = {
  venture: { id: string; slug: string; name: string; website: string | null };
  ok: boolean;
  ts: string;
  /** Where the PNG landed on the box. On the wire and deliberately not drawn —
   *  the page shows the picture, and a path is of use to nobody reading a
   *  settings row. A second declaration of this type omitted the field, so a
   *  page typed against it could not have drawn the path even to debug with. */
  path: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  error: string | null;
  browser: string | null;
};

export type Rebrand = {
  venture: { id: string; slug: string; name: string };
  rendered: RenderedReading;
  domBytes: number;
  /** The colour this reading took, or null when it took none — because the
   *  owner had chosen one, or because nothing brandable survived. */
  colourTaken: string | null;
  colorSource: "owner" | "site" | "default";
  color: string;
  brandUntouched: boolean;
  note: string;
  brandNote: string;
};

/* ------------------------------------------------------------------ audit */

export type AuditFinding = {
  severity: "error" | "warning" | "notice";
  code: string;
  what: string;
  /** The real number. `pages` is capped so one bad template does not produce a
   *  finding with sixty URLs in it. */
  count: number;
  pages: string[];
  /** What the verdict was computed FROM, so it can be argued with. */
  evidence: string;
};

export type AuditPage = {
  url: string;
  status: number;
  redirects: string[];
  ms: number;
  https: boolean;
  title: string | null;
  titleLength: number | null;
  description: string | null;
  descriptionLength: number | null;
  h1: number;
  h1Text: string | null;
  canonical: string | null;
  canonicalSelf: boolean | null;
  noindex: boolean;
  words: number;
  internalLinks: number;
  externalLinks: number;
  images: number;
  imagesWithoutAlt: number;
  error: string | null;
};

export type Audit = {
  ts: string;
  venture: {
    id: string;
    slug: string;
    name: string;
    website: string;
    host: string | null;
  };
  userAgent: string;
  limits: {
    pages: number;
    links: number;
    gapMs: number;
    requestMs: number;
    crawlMs: number;
    linksMs: number;
  };
  robots: {
    present: boolean;
    status: number | null;
    sitemaps: string[];
    agent: string | null;
    rules: { allow: boolean; path: string }[];
    note: string | null;
  };
  sitemap: {
    checked: string[];
    found: string | null;
    urls: number | null;
    note: string;
  };
  https: { httpRedirectsToHttps: boolean | null; note: string };
  canonicalHost: { requested: string; answered: string | null; note: string };
  pages: AuditPage[];
  crawl: {
    reached: number;
    queuedButNotReached: number;
    blockedByRobots: string[];
    infrastructureSkipped: number;
    stoppedBecause: string;
    ms: number;
  };
  links: {
    checked: number;
    broken: {
      url: string;
      status: number;
      error: string | null;
      linkedFrom: string[];
    }[];
    note: string;
  };
  /** The Search Console join, when a property is linked to this venture. The
   *  note is the server's own and is quoted rather than paraphrased: it is the
   *  sentence that says what the crawl did NOT reach. */
  search: {
    property: string | null;
    note: string;
    ranked: {
      page: string;
      impressions: number;
      clicks: number;
      position: number | null;
      issues: string[];
    }[];
  };
  findings: AuditFinding[];
  summary: {
    pages: number;
    errors: number;
    warnings: number;
    notices: number;
    /** Always null. There is deliberately no score; `scoreNote` says why. */
    score: null;
    scoreNote: string;
  };
  bySeverity: {
    error: AuditFinding[];
    warning: AuditFinding[];
    notice: AuditFinding[];
  };
};

export type AuditHistory = {
  venture: { id: string; slug: string; name: string };
  runs: { id: number; ts: string; pages: number; issues: number }[];
  note: string;
};

/* ------------------------------------------------------------------ calls */

export const ventureApi = {
  links: (key: string) => call<VentureLinks>(`/venture-links/${seg(key)}`),
  map: () => call<LinkMap>("/venture-links/map"),
  link: (key: string, plugin: string, entity: string, label?: string | null) =>
    call<LinkWriteResult>(`/venture-links/${seg(key)}`, {
      method: "POST",
      body: JSON.stringify({ plugin, entity, label: label ?? null }),
    }),
  acceptAll: (key: string) =>
    call<AcceptAll>(`/venture-links/${seg(key)}/accept-all`, { method: "POST" }),
  unlink: (key: string, plugin: string, entity: string) =>
    call<LinkWriteResult>(
      `/venture-links/${seg(key)}/${seg(plugin)}/${seg(entity)}`,
      { method: "DELETE" },
    ),

  capture: () => call<CaptureReport>("/capture"),
  captureNow: (key: string) =>
    call<CaptureRun>(`/capture/${seg(key)}`, { method: "POST" }),
  rebrand: (key: string) =>
    call<Rebrand>(`/capture/${seg(key)}/rebrand`, { method: "POST" }),

  audit: (key: string) => call<Audit>(`/audit/${seg(key)}`),
  runAudit: (key: string) => call<Audit>(`/audit/${seg(key)}`, { method: "POST" }),
  auditHistory: (key: string) => call<AuditHistory>(`/audit/${seg(key)}/history`),
};
