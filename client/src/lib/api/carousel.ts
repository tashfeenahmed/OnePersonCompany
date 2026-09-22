import { call } from "@/lib/api";

/**
 * THE CAROUSELS, FROM THIS SIDE — written against
 * `server/src/integrations/videoplus/carousel-routes.ts`.
 *
 * A CAROUSEL IS A RUN. It is started with `runsApi.start({ kind: "video",
 * input: { format: "carousel", … } })` and deleted with the run, so there is no
 * `create` or `remove` here; this file only reads what the run left behind.
 *
 * `verdict` HAS THREE VALUES AND THE THIRD IS NOT A PASS. "unverified" means no
 * vision model looked at the slide — the geometry check still ran — and the
 * page must never draw it as a tick.
 */

export type SlideVerdict = "pass" | "fail" | "unverified";

export type CarouselSlide = {
  n: number;
  role: "hook" | "body" | "cta";
  headline: string;
  body: string;
  verdict: SlideVerdict;
  /** What the checks found on the KEPT render. Empty on a clean pass. */
  issues: string[];
  /** How many times the carousel's one document was coded. */
  attempts: number;
  /** This slide's verdict on each attempt, in order. */
  history: { verdict: SlideVerdict; issues: string[] }[];
  note: string | null;
  /** Null when the file is not on disk — nothing rendered, or it was pruned. */
  image: string | null;
};

export type Carousel = {
  runId: string;
  ventureId: string | null;
  ts: string;
  size: string;
  width: number;
  height: number;
  prompt: string;
  title: string | null;
  caption: string | null;
  slides: CarouselSlide[];
  /** The whole strip the six were cut from, when it is on disk. */
  strip: string | null;
  /** Issues about the set as a whole: consistency, text across a cut. */
  stripIssues: string[];
  /** How many times the one document was coded. More than one means the
   *  checks sent it back for revision. */
  attempts: number;
  thumbnailUrl: string | null;
  coderModel: string | null;
  visionModel: string | null;
  /** Why the slides are unverified, when they are. */
  visionNote: string | null;
  error: string | null;
};

export type CarouselList = { carousels: Carousel[] };

/** The workspace model a carousel will use — the one chosen under Settings →
 *  Models, whatever it is — and whether it has been seen to take a picture.
 *  `supports: null` is "not checked yet", never a no. */
export type CarouselModel = {
  provider: string | null;
  label: string | null;
  /** Null when the endpoint picks its own model. */
  model: string | null;
  vision: { supports: boolean | null; detail: string; at: string | null };
};

export const carouselApi = {
  list: (venture?: string | null) =>
    call<CarouselList>(`/carousel${venture ? `?venture=${encodeURIComponent(venture)}` : ""}`),
  get: (runId: string) => call<Carousel>(`/carousel/${encodeURIComponent(runId)}`),
  model: () => call<CarouselModel>("/carousel/model"),
  /** Plain addresses, for an <a download>: the browser fetches them itself. */
  slideDownload: (runId: string, n: number) => `/api/carousel/${encodeURIComponent(runId)}/slides/${n}?download=1`,
  zip: (runId: string) => `/api/carousel/${encodeURIComponent(runId)}/zip`,
  stripDownload: (runId: string) => `/api/carousel/${encodeURIComponent(runId)}/strip?download=1`,
};
