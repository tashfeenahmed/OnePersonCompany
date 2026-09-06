import { call } from "@/lib/api";

/**
 * THE MOTION AREA, FROM THIS SIDE — scene specs, their cost, and their preview.
 *
 * A SPEC IS NOT A VIDEO AND THIS FILE KEEPS THEM APART. `seconds` on a spec is
 * what its scene list adds up to — a plan. The length of a finished render is
 * read off the file with ffprobe and lives on the video run, which is the
 * `videoApi` next door. A page that showed one where the other belongs would
 * be reporting an intention as a measurement.
 *
 * `problems` IS NOT AN ERROR LIST. Every save comes back with one, and it is
 * the list of things the validator CHANGED on the way in — a heading cut to
 * length, a nine-item list cut to six, a scene shortened to the ceiling. They
 * are shown beside the editor because "why did my list come back with five
 * items" should have an answer on the screen.
 *
 * RENDERING IS A QUEUED RUN AND NEVER A REQUEST. `render` answers with the run
 * it queued, and the file appears on that run's own page.
 */

export type SceneKind = "title" | "stat" | "compare" | "list" | "cta";

export type Side = { label: string; value: string; points: string[] };

export type Scene = {
  kind: SceneKind;
  seconds: number;
  kicker: string | null;
  /** What a narrator would read. Only spoken when the render asks for
   *  voiceover AND the voice plugin has speech on. */
  say: string | null;
  title?: string;
  subtitle?: string | null;
  value?: string;
  unit?: string | null;
  label?: string;
  note?: string | null;
  heading?: string | null;
  left?: Side;
  right?: Side;
  items?: string[];
  headline?: string;
  action?: string;
  url?: string | null;
};

export type SceneSpec = {
  title: string;
  aspect: string;
  accent: string | null;
  voiceover: boolean;
  scenes: Scene[];
};

export type SpecSummary = {
  id: string;
  ventureId: string | null;
  ventureName: string | null;
  name: string;
  aspect: string;
  scenes: number;
  /** What the scene list adds up to. NOT the length of any rendered file. */
  seconds: number | null;
  /** `owner` — typed or edited here. `model` — drafted from a brief, so its
   *  numbers are claims nobody has checked. */
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type SpecDetail = SpecSummary & {
  spec: SceneSpec | null;
  /** What a render would take, before anything is pressed. */
  cost: { sheets: number; frames: number; tiles: number; fps: number } | null;
  readable: boolean;
};

export type SpecLimits = {
  maxScenes: number;
  minSceneSeconds: number;
  maxSceneSeconds: number;
  maxTotalSeconds: number;
};

export type MotionCapability = { ready: boolean; note: string };

export type MotionReadiness = {
  renderer: MotionCapability & { browser: string | null };
  encoder: MotionCapability & { ffmpeg: string | null; untile: boolean };
  writer: MotionCapability & { provider: string | null };
  fps: number;
  limits: SpecLimits;
  aspects: { key: string; width: number; height: number; about: string }[];
};

export type MotionList = {
  venture: { id: string; slug: string; name: string } | null;
  specs: SpecSummary[];
  readiness: MotionReadiness;
  note: string;
};

export type TemplateDoc = {
  kinds: { kind: SceneKind; about: string; fields: { name: string; required: boolean; about: string }[] }[];
  common: { name: string; required: boolean; about: string }[];
  limits: SpecLimits;
  note: string;
};

export type PreviewFrame = {
  index: number;
  kind: string;
  seconds: number;
  /** The URL of the frame, or null when it could not be drawn. */
  image: string | null;
  error: string | null;
};

export type PreviewDoc = { id: string; error: string | null; frames: PreviewFrame[]; note: string };

export type SaveResult = SpecDetail & { problems: string[]; model?: string | null };

export type RenderResult = {
  run: { id: string; kind: string; status: string };
  spec: SpecSummary;
  note: string;
};

export const motionApi = {
  list: (venture?: string | null) =>
    call<MotionList>(`/motion${venture ? `?venture=${encodeURIComponent(venture)}` : ""}`),
  templates: () => call<TemplateDoc>("/motion/templates"),
  get: (id: string) => call<SpecDetail>(`/motion/${encodeURIComponent(id)}`),
  preview: (id: string) => call<PreviewDoc>(`/motion/${encodeURIComponent(id)}/preview`),
  create: (body: { name: string; venture: string | null; spec: unknown }) =>
    call<SaveResult>("/motion", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: { name: string; venture?: string | null; spec: unknown }) =>
    call<SaveResult>(`/motion/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }),
  draft: (body: { venture: string | null; brief: string; name: string; aspect: string }) =>
    call<SaveResult>("/motion/draft", { method: "POST", body: JSON.stringify(body) }),
  render: (id: string, voiceover: boolean) =>
    call<RenderResult>(`/motion/${encodeURIComponent(id)}/render`, {
      method: "POST",
      body: JSON.stringify({ voiceover: voiceover ? "true" : "false" }),
    }),
  remove: (id: string) =>
    call<{ deleted: string; note: string }>(`/motion/${encodeURIComponent(id)}/delete`, { method: "POST" }),
};
