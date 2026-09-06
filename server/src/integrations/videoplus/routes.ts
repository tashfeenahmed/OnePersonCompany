/**
 * THE MOTION ROUTES — the scene specs, what they will cost, and what they look
 * like.
 *
 * A RENDER IS NEVER DONE HERE. `POST /:id/render` queues a `video` run with
 * `format=motion` and answers with the run; the frames are drawn by the
 * executor, on the queue, under the lease the video area already takes. A
 * route that rendered would hold an HTTP request open for minutes of headless
 * Chrome, and the first thing that went wrong would be a browser tab timing
 * out with a half-written file on the disk and nothing in the ledger.
 *
 * A PREVIEW IS DONE HERE, and that is the exception rather than an
 * inconsistency: it is ONE browser launch for the whole spec (motion.ts
 * explains how), it answers in about three seconds, and it is the thing
 * somebody presses while they are editing. Anything that took a queue slot to
 * answer "what does this look like" would not be used.
 *
 * THE SPEC ARRIVES AS EITHER AN OBJECT OR A STRING. The client sends JSON; the
 * skills proxy sends every parameter as a STRING, including one that happens
 * to contain a JSON document. Both are accepted and both go through the same
 * validator, because the alternative is an agent whose every save is rejected
 * for a reason it cannot see.
 */
import { Hono } from "hono";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { activeProvider } from "../../models/provider.ts";
import { ventureRow } from "../../db.ts";
import { ASPECTS, aspectFrame } from "../video/assemble.ts";
import { ffmpegFilters, findFfmpeg } from "../video/tools.ts";
import { hasUntile } from "../video/assemble.ts";
import { insertRun, mintRunId, runRow, shapeRun } from "../runs/store.ts";
import { pump } from "../runs/executor.ts";
import { findBrowser } from "./chrome.ts";
import { motionFps, specLimits } from "./settings.ts";
import { plan, previewSpec, writeSceneSpec } from "./motion.ts";
import { readSceneSpec, SCENE_KINDS, specSeconds, type SceneSpec } from "./scenespec.ts";
import { forgetSpec, previewFrame, previewToken, readSpecRow, saveSpec, shapeSpec, specRow, specRows } from "./store.ts";

export const motionRoutes = new Hono();

/* ------------------------------------------------------------- readiness */

async function readiness() {
  const ffmpeg = findFfmpeg();
  const browser = findBrowser();
  const provider = activeProvider();
  const filters = ffmpeg.path ? await ffmpegFilters(ffmpeg.path) : new Set<string>();
  const untile = hasUntile(filters);
  return {
    /* Three capabilities and not one flag, on routes.ts's argument next door:
       "can this box render a motion video" has three different answers and a
       single boolean would have to pick one of them to be wrong about. */
    renderer: {
      ready: browser.found,
      browser: browser.path,
      note: browser.found
        ? `Frames are drawn by ${browser.path}. Each one is a paused CSS animation at its own timestamp, so a spec always renders the same pixels.`
        : (browser.error ?? "no browser"),
    },
    encoder: {
      ready: !!ffmpeg.path && untile,
      ffmpeg: ffmpeg.path,
      untile,
      note: !ffmpeg.path
        ? (ffmpeg.error ?? "no ffmpeg")
        : untile
          ? "ffmpeg joins the frames and cuts each sheet apart with its `untile` filter."
          : "This ffmpeg build has no `untile` filter, so a sheet of frames cannot be cut into frames. A render would need one browser launch per frame, which is minutes per second of video.",
    },
    writer: {
      ready: provider !== null,
      provider: provider?.id ?? null,
      note: provider
        ? `A scene list can be drafted by ${provider.label}. A spec you write yourself needs no model at all.`
        : "No model provider is live, so nothing can draft a scene list. You can still write one by hand — the renderer needs no model.",
    },
    fps: motionFps(),
    limits: specLimits(),
    aspects: Object.entries(ASPECTS).map(([key, a]) => ({ key, width: a.width, height: a.height, about: a.about })),
  };
}

/* -------------------------------------------------------------- templates */

/** What a scene of each kind holds. This is a DOCUMENT rather than a schema
 *  dump: it is read by the editor page to build its form and by an agent to
 *  write a spec, and both need the sentence as much as the field name. */
const TEMPLATES = [
  {
    kind: "title",
    about: "An opening statement. One line of large type, a rule in the venture's colour, and an optional second line.",
    fields: [
      { name: "title", required: true, about: "The line itself. Under nine words — it is read in a second and a half." },
      { name: "subtitle", required: false, about: "One short line under the rule." },
    ],
  },
  {
    kind: "stat",
    about: "One number, enormous, with what it means under it. The number and its unit are separate fields so a reader can always see which part is the measurement.",
    fields: [
      { name: "value", required: true, about: "The number as it should be written — `73`, `12k`, `2×`, `£19`. At most twelve characters, and it should contain a digit." },
      { name: "unit", required: false, about: "What follows the number — `%`, `/mo`, `ms`. Set in smaller type beside it." },
      { name: "label", required: true, about: "What the number IS. A phrase, not a sentence." },
      { name: "note", required: false, about: "One line of context under the label." },
    ],
  },
  {
    kind: "compare",
    about: "Two stacked panels — before and after, ours and theirs. Stacked rather than side by side because a vertical frame has height to spend and no width.",
    fields: [
      { name: "heading", required: false, about: "A line above the two panels." },
      { name: "left", required: true, about: "`{ label, value, points[] }`. The cool side, drawn with a plain border." },
      { name: "right", required: true, about: "`{ label, value, points[] }`. The hot side, drawn in the venture's colour." },
    ],
  },
  {
    kind: "list",
    about: "A numbered list, each row sliding in from the left after the one above it. Up to six items; more than six does not fit on a phone.",
    fields: [
      { name: "heading", required: true, about: "What the list is." },
      { name: "items", required: true, about: "Three to six short items. Each is one line." },
    ],
  },
  {
    kind: "cta",
    about: "The last card. A headline, a pill in the venture's colour with the action on it, and optionally the address.",
    fields: [
      { name: "headline", required: true, about: "Under eight words." },
      { name: "action", required: true, about: "The two or three words on the pill — `Start free`, `Book a call`." },
      { name: "url", required: false, about: "An http address, shown small under the pill." },
    ],
  },
] as const;

const COMMON = [
  { name: "seconds", required: false, about: "How long the scene holds. Clamped to the limits on the default view; absent takes a sensible default for the kind." },
  { name: "kicker", required: false, about: "A small uppercase label above the scene, in the venture's colour." },
  { name: "say", required: false, about: "What a narrator would read over this scene. Only spoken when the render asks for voiceover AND the voice plugin has speech turned on; otherwise it is just the best description of what the scene is for." },
];

motionRoutes.get("/templates", (c) =>
  c.json({
    kinds: TEMPLATES,
    common: COMMON,
    limits: specLimits(),
    note:
      "A scene of any other kind is REFUSED rather than rendered as something else — that is the one hard refusal in the validator. " +
      "Everything else is clamped: a heading that is too long is cut, a list of nine is cut to six, a scene that is too long becomes the ceiling, and every change comes back as a sentence.",
  }),
);

/* ------------------------------------------------------------- the specs */

motionRoutes.get("/", async (c) => {
  const v = ventureRow(c.req.query("venture") ?? "");
  const rows = specRows({ ventureId: v?.id ?? null, limit: Number(c.req.query("limit") ?? 50) });
  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    specs: rows.map((r) => shapeSpec(r)),
    readiness: await readiness(),
    note:
      "A spec is a scene list, not a video. `seconds` here is what the scene list adds up to — the length of a FINISHED render is read off the file with ffprobe and lives on the video run. " +
      "Rendering is a queued run and never a request: POST /api/motion/<id>/render answers with the run it queued.",
  });
});

motionRoutes.get("/:id", (c) => {
  const row = specRow(c.req.param("id"));
  if (!row) return c.json({ error: "No scene spec with that id. GET /api/motion lists the ones there are." }, 404);
  const limits = specLimits();
  const spec = readSpecRow(row, limits);
  const frame = aspectFrame(row.aspect);
  return c.json({
    ...shapeSpec(row, { full: true }),
    /* WHAT IT WILL COST, BEFORE ANYBODY PRESSES ANYTHING. The number of
       browser launches is the render, and it is arithmetic the owner can
       check rather than a spinner they have to wait out. */
    cost: spec ? { ...plan(spec, motionFps(), frame), fps: motionFps() } : null,
    readable: !!spec,
  });
});

/** Whatever arrived, as something the validator can read. */
function bodySpec(body: Record<string, unknown>): unknown {
  const raw = body.spec ?? body;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

const newId = () => `ms-${Math.random().toString(36).slice(2, 9)}`;

motionRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const o = body as Record<string, unknown>;
  const v = ventureRow(String(o.venture ?? o.ventureId ?? ""));
  const raw = bodySpec(o);
  if (raw === null)
    return c.json({ error: "The `spec` field is not JSON this server could parse. Send the scene list as an object, or as a string containing one." }, 400);
  const id = newId();
  const { row, problems } = saveSpec({
    id,
    ventureId: v?.id ?? null,
    name: String(o.name ?? ""),
    raw,
    source: "owner",
    limits: specLimits(),
  });
  if (!row) return c.json({ error: "That is not a scene list this server can render.", problems }, 400);
  return c.json({ ...shapeSpec(row, { full: true }), problems }, 201);
});

motionRoutes.post("/draft", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const o = body as Record<string, unknown>;
  const v = ventureRow(String(o.venture ?? o.ventureId ?? ""));
  if (!activeProvider())
    return c.json({ error: "No model provider is live, so nothing can draft a scene list. Choose one under Integrations → Models, or write the spec by hand." }, 400);
  const limits = specLimits();
  const aspect = String(o.aspect ?? "9:16");
  let written: Awaited<ReturnType<typeof writeSceneSpec>>;
  try {
    written = await writeSceneSpec({ venture: v ?? null, brief: String(o.brief ?? ""), aspect, limits });
  } catch (err) {
    return c.json({ error: `The model refused: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  const id = newId();
  const { row, problems } = saveSpec({
    id,
    ventureId: v?.id ?? null,
    name: String(o.name ?? "").trim() || "Draft",
    raw: written.raw,
    /* `model` AND NOT `owner`. A spec a model wrote is a draft with claims in
       it; a spec the owner edited is a decision. The column keeps them apart
       and the page draws them differently. */
    source: "model",
    limits,
  });
  if (!row)
    return c.json(
      {
        error: "The model did not answer with a scene list this server could read.",
        problems,
        reply: written.text.slice(0, 600),
      },
      502,
    );
  return c.json({ ...shapeSpec(row, { full: true }), problems, model: written.model }, 201);
});

motionRoutes.post("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = specRow(id);
  if (!existing) return c.json({ error: "No scene spec with that id." }, 404);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const o = body as Record<string, unknown>;
  const raw = bodySpec(o);
  if (raw === null) return c.json({ error: "The `spec` field is not JSON this server could parse." }, 400);
  const v = o.venture !== undefined || o.ventureId !== undefined ? ventureRow(String(o.venture ?? o.ventureId ?? "")) : null;
  const { row, problems } = saveSpec({
    id,
    ventureId: v?.id ?? existing.venture_id,
    name: String(o.name ?? existing.name),
    raw,
    /* An edit makes it the owner's, whoever drafted it. */
    source: "owner",
    limits: specLimits(),
  });
  if (!row) return c.json({ error: "That is not a scene list this server can render.", problems }, 400);
  return c.json({ ...shapeSpec(row, { full: true }), problems });
});

motionRoutes.post("/:id/delete", (c) => {
  const row = specRow(c.req.param("id"));
  if (!row) return c.json({ error: "No scene spec with that id." }, 404);
  /* The row and its preview PNGs go together — see `forgetSpec`. */
  forgetSpec(row.id);
  return c.json({ deleted: row.id, note: "The spec and its preview frames are gone. Any video already rendered from it is not — a run keeps its own copy of the scene list." });
});

/* ------------------------------------------------------------ the preview */

motionRoutes.get("/:id/preview", async (c) => {
  const row = specRow(c.req.param("id"));
  if (!row) return c.json({ error: "No scene spec with that id." }, 404);
  const spec = readSpecRow(row, specLimits());
  if (!spec) return c.json({ error: "That spec is not readable as a scene list any more." }, 409);
  const v = row.venture_id ? ventureRow(row.venture_id) : null;
  /* A TOKEN PER CALL, IN THE URL. Two people pressing Preview on the same spec
     used to share one directory, and the second call's first act was to empty
     it — so the first response came back with image URLs that 404ed. The token
     is minted here and goes into every URL below, so the frames a response
     names are the frames that response drew.

     THE REQUEST'S SIGNAL GOES THROUGH TOO. This view spawns a browser; a
     client that navigated away used to leave it running to its own timeout. */
  const token = previewToken();
  const { frames, error } = await previewSpec({
    spec,
    venture: v ?? null,
    specId: row.id,
    token,
    signal: c.req.raw.signal,
  });
  return c.json({
    id: row.id,
    error,
    frames: frames.map((f) => ({
      index: f.index,
      kind: f.kind,
      seconds: f.seconds,
      image: f.file ? `/api/motion/${row.id}/preview/${token}/${f.index}/image` : null,
      error: f.error,
    })),
    note:
      "One frame per scene, a third of a second in — at exactly zero every animated element is still off screen and every card would preview as a blank rectangle. " +
      "It is the SAME renderer the video uses, drawn at a third of the size, not a thumbnail of a finished file. " +
      "Each call draws its own set at its own address, so two previews of one spec cannot overwrite each other; only the last three sets are kept, and an older set's URLs answer 404 rather than someone else's frames.",
  });
});

motionRoutes.get("/:id/preview/:token/:index/image", (c) => {
  const index = Number(c.req.param("index"));
  if (!Number.isInteger(index) || index < 1) return c.json({ error: "A preview frame is addressed by its scene number." }, 400);
  /* Both segments are checked before either reaches the filesystem — the token
     against a pattern in `previewFrame`, the index as an integer here — so
     nothing a caller sends composes a path. */
  const path = previewFrame(c.req.param("id"), c.req.param("token"), index);
  if (!path || !existsSync(path))
    return c.json(
      {
        error:
          "There is no preview frame at that address. Preview frames are kept for the last three previews of a spec; " +
          "GET /api/motion/<id>/preview draws a fresh set and answers with their URLs.",
      },
      404,
    );
  return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, {
    "Content-Type": "image/png",
    "Content-Length": String(statSync(path).size),
    /* A preview is redrawn whenever the spec is, at the same address, so it
       must not be cached across an edit. */
    "Cache-Control": "no-store",
  });
});

/* ------------------------------------------------------------- the render */

motionRoutes.post("/:id/render", async (c) => {
  const row = specRow(c.req.param("id"));
  if (!row) return c.json({ error: "No scene spec with that id." }, 404);
  const spec = readSpecRow(row, specLimits());
  if (!spec) return c.json({ error: "That spec is not readable as a scene list any more." }, 409);
  const browser = findBrowser();
  if (!browser.found) return c.json({ error: browser.error }, 400);

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const o = body as Record<string, unknown>;
  /* THE PROXY SENDS EVERY PARAMETER AS A STRING. `voiceover` is therefore
     read from the spellings a form and an agent actually send, and anything
     else is false — a truthiness check would narrate every render. */
  const voiceover = ["true", "on", "1", "yes"].includes(String(o.voiceover ?? "").trim().toLowerCase());

  const id = mintRunId();
  insertRun({
    id,
    kind: "video",
    ventureId: row.venture_id,
    title: `Motion — ${row.name}`,
    input: { format: "motion", spec: row.id, aspect: row.aspect, voiceover: voiceover ? "true" : "false", brief: "" },
  });
  pump();
  const run = runRow(id);
  return c.json(
    {
      run: run ? shapeRun(run) : { id, kind: "video", status: "queued" },
      spec: shapeSpec(row),
      note: `Queued. ${spec.scenes.length} scenes, ${specSeconds(spec).toFixed(1)}s, drawn by ${plan(spec, motionFps(), aspectFrame(row.aspect)).sheets} browser launches. The file lands on the run's page; nothing is published anywhere.`,
    },
    201,
  );
});

/** Exported for the skill's `about` and for a test: the kinds this renderer
 *  actually has templates for. */
export const KINDS = SCENE_KINDS;
export type { SceneSpec };
export { readSceneSpec };
