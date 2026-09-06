/**
 * THE UGC PIPELINE — a product in a scene, made to move, captioned, filed as a
 * draft.
 *
 * WHAT IT IS. Four steps and a gate. Reference pictures out of the venture's
 * own asset library go to the Studio's image model, which puts the product
 * into a scene; that still frame goes to a Replicate image-to-video model,
 * which animates it; the video area's captioner burns one line onto the
 * result; and the finished file becomes a DRAFT in the publishing queue. It is
 * the shape workdash's studio.js has — image, video, caption, delivery — with
 * the two things that box did not have: a model whose image-input capability
 * is MEASURED rather than assumed, and an animation step that refuses to spend
 * money nobody has configured.
 *
 * THE ANIMATION MODEL HAS NO DEFAULT AND THAT IS THE DESIGN. Image-to-video is
 * the most expensive thing on Replicate that this box could call — dollars a
 * clip rather than fractions of a cent — and the prices differ by two orders
 * of magnitude between models. A default here would be a button that charges
 * somebody the first time they press it, for a model somebody else chose. With
 * the setting blank the step is SKIPPED, the job finishes with a still image
 * and a sentence naming the setting, and nothing is spent. That path is the
 * one the test exercises, deliberately.
 *
 * THE IMAGE MODEL'S CAPABILITY IS MEASURED, NOT LISTED. `modelImageInput` in
 * the publishing area reads the model's own OpenAPI schema off Replicate and
 * says which input property takes a picture. A model with none gets the
 * references DESCRIBED IN WORDS in the prompt and the job says so — that is
 * much weaker than an actual reference and pretending otherwise would produce
 * a "product shot" of a product the model has never seen.
 *
 * IT IS A `video` RUN AND NOT A KIND OF ITS OWN. The executor already
 * dispatches that kind per format; a third format is one branch in
 * video/execute.ts rather than a new member of the RunKind union, a new page,
 * a new sub-agent role and a new entry in three shared files. The finished
 * file is written into the run's own directory and saved through the video
 * area's `saveJob`, so a UGC clip appears on the Video page beside the others.
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { configValue, db, now, type VentureRow } from "../../db.ts";
import { tokenAccounts, REPLICATE_API } from "../../providers/replicate.ts";
import { readBrand } from "../../ventures/enrich.ts";
import { imageModel, makeImage, STUDIO_DIR } from "../ventures/studio.ts";
import { assetAsDataUrl, assetAsText, assetRows, markUsed, modelImageInput } from "../publishing/assets.ts";
import { createItem, sniff } from "../publishing/items.ts";
import { runDir, StepError, type RunSession } from "../video/faceless.ts";
import { ASPECTS, segment, type Fit } from "../video/assemble.ts";
import { pickCaptioner, stripPath, type CaptionStyle } from "../video/captions.ts";
import { blurFilter } from "../video/assemble.ts";
import { bytesOf, ffmpegFilters, findFfmpeg, findFfprobe, probeDuration } from "../video/tools.ts";
import { saveJob } from "../video/store.ts";
import { SOCIALFEED_PLUGIN } from "./novelty.ts";

/** How long the animation is asked to be. Every image-to-video model on
 *  Replicate takes a `duration` in whole seconds and most cap at ten; five is
 *  a social clip and is the default. */
export const DEFAULT_UGC_SECONDS = 5;

/** Replicate's synchronous door holds a connection for up to sixty seconds.
 *  Video models routinely take longer than that, so this is generous and the
 *  prediction is polled — see `animate`. */
const PREDICT_MS = 90_000;
const POLL_MS = 5_000;
/** One poll's own ceiling. Without it a hung connection hangs the whole run. */
const POLL_TIMEOUT_MS = 20_000;
/** Consecutive failed polls before the prediction is given up on. Three,
 *  because the money is already spent and a 502 is not a verdict. */
const POLL_FAILURES_ALLOWED = 3;
const POLL_FOR_MS = 12 * 60_000;
const DOWNLOAD_MS = 120_000;
/** A social clip bigger than this is not a social clip. */
const VIDEO_CAP = 200 * 1024 * 1024;

export type UgcRow = {
  run_id: string;
  venture_id: string | null;
  ts: string;
  asset_ids: string;
  image_prompt: string | null;
  video_prompt: string | null;
  image_path: string | null;
  video_path: string | null;
  image_model: string | null;
  image_field: string | null;
  video_model: string | null;
  seconds: number | null;
  captions: string | null;
  publish_item: string | null;
  steps: string;
  skipped: string | null;
  error: string | null;
};

export function ugcRow(runId: string): UgcRow | undefined {
  return db.prepare("SELECT * FROM ugc_jobs WHERE run_id = ?").get(runId) as UgcRow | undefined;
}

export function ugcRows(ventureId?: string | null, limit = 40): UgcRow[] {
  const args: (string | number)[] = [];
  let where = "";
  if (ventureId) {
    where = "WHERE venture_id = ?";
    args.push(ventureId);
  }
  args.push(Math.max(1, Math.min(200, Math.floor(limit))));
  return db
    .prepare(`SELECT * FROM ugc_jobs ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...args) as unknown as UgcRow[];
}

const parseSteps = (raw: string): { step: string; ok: boolean; note: string }[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as { step: string; ok: boolean; note: string }[]) : [];
  } catch {
    return [];
  }
};

const parseList = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
};

export function shapeUgc(r: UgcRow) {
  return {
    runId: r.run_id,
    ventureId: r.venture_id,
    ts: r.ts,
    assetIds: parseList(r.asset_ids),
    imagePrompt: r.image_prompt,
    videoPrompt: r.video_prompt,
    imageModel: r.image_model,
    /* The input property the image model actually takes a picture in, read off
       its own schema. Null means it takes none and the references were words. */
    imageField: r.image_field,
    videoModel: r.video_model,
    seconds: r.seconds,
    captions: r.captions,
    publishItem: r.publish_item,
    steps: parseSteps(r.steps),
    /* Which step did not run, and why. The ordinary value is the animation
       step with "no model is configured", and that is not a failure. */
    skipped: r.skipped,
    error: r.error,
    imageOnDisk: r.image_path ? existsSync(r.image_path) : false,
    videoOnDisk: r.video_path ? existsSync(r.video_path) : false,
  };
}

/* --------------------------------------------------------------- settings */

/** The Replicate image-to-video model, as `owner/name`. BLANK BY DEFAULT and
 *  the whole animation step depends on it — see the header. */
export function videoModel(): string | null {
  const raw = (configValue(SOCIALFEED_PLUGIN, "ugcVideoModel") ?? "").trim();
  return raw || null;
}

export function ugcSeconds(): number {
  const raw = (configValue(SOCIALFEED_PLUGIN, "ugcSeconds") ?? "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(20, Math.round(n))) : DEFAULT_UGC_SECONDS;
}

/* ------------------------------------------------------------ the animation */

export type AnimateResult =
  | { ok: true; path: string; model: string; ms: number }
  | { ok: false; skipped: boolean; error: string; model: string | null; ms: number };

/**
 * One image-to-video prediction.
 *
 * `Prefer: wait` AND THEN A POLL, unlike the Studio's image call which only
 * waits. A four-step image model finishes inside the sixty seconds Replicate
 * will hold a connection; a video model usually does not, and a route that
 * gave up there would charge for a prediction it then threw away. So the wait
 * is tried first and the prediction is polled through its own `urls.get` after
 * — the money is already spent by then and abandoning it would be the worst of
 * both.
 *
 * THE FRAME TRAVELS AS A `data:` URI. Nothing on the internet can fetch a file
 * from this laptop; the same reason every upload in the publishing area is
 * multipart bytes rather than a URL.
 */
export async function animate(opts: {
  imagePath: string;
  prompt: string;
  seconds: number;
  out: string;
  signal?: AbortSignal;
}): Promise<AnimateResult> {
  const started = Date.now();
  const model = videoModel();
  if (!model)
    return {
      ok: false,
      skipped: true,
      model: null,
      ms: 0,
      error:
        "No image-to-video model is configured, so the animation step was skipped and NOTHING WAS SPENT. " +
        "Name one under Integrations → Social feed → “UGC video model”, as owner/name. There is deliberately " +
        "no default: image-to-video costs dollars a clip and the price differs by a hundredfold between models.",
    };
  if (!/^[\w.-]+\/[\w.-]+$/.test(model))
    return {
      ok: false,
      skipped: true,
      model,
      ms: 0,
      error: `“${model}” is not a Replicate model. It wants owner/name. Nothing was spent.`,
    };

  const tokens = tokenAccounts("socialfeed_ugc");
  if (!tokens.length)
    return {
      ok: false,
      skipped: true,
      model,
      ms: 0,
      error: "Replicate is not connected, so there is no animation. Paste an `r8_…` token under Integrations → Replicate.",
    };
  const token = tokens[0]!.token;

  const { readFileSync, writeFileSync } = await import("node:fs");
  let dataUrl: string;
  try {
    const bytes = readFileSync(opts.imagePath);
    dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return { ok: false, skipped: false, model, ms: Date.now() - started, error: "The still frame is no longer on disk." };
  }

  let doc: { id?: string; status?: string; output?: unknown; error?: unknown; detail?: string; urls?: { get?: string } };
  try {
    const res = await fetch(`${REPLICATE_API}/models/${model}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          prompt: opts.prompt,
          /* `image` is the input property every image-to-video model on
             Replicate uses for its first frame. Unlike the Studio's reference
             field this is not probed, because a model that has no `image`
             input is not an image-to-video model and the prediction's own
             error is the right place for that to be said. */
          image: dataUrl,
          duration: opts.seconds,
        },
      }),
      /* BOTH SIGNALS, NOT ONE OR THE OTHER. `opts.signal ?? timeout` meant a
         run that had a cancellation signal made a request with NO timeout at
         all, so a Replicate that stopped answering hung the run until somebody
         cancelled it by hand. `any` fires on whichever comes first. */
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(PREDICT_MS)])
        : AbortSignal.timeout(PREDICT_MS),
    });
    doc = (await res.json().catch(() => ({}))) as typeof doc;
    if (!res.ok)
      return {
        ok: false,
        skipped: false,
        model,
        ms: Date.now() - started,
        error: `Replicate answered HTTP ${res.status}${doc?.detail ? ` — ${doc.detail}` : ""}.`,
      };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, skipped: false, model, ms: Date.now() - started, error: `Could not reach Replicate (${name}).` };
  }

  /*
    THE POLL, AND WHY IT DOES NOT GIVE UP ON ONE BAD ANSWER.

    By the time this loop runs the prediction has been PAID FOR. Abandoning it
    because a single poll timed out or came back 502 is the "worst of both"
    this function's header warns about: the money is spent and the file is
    thrown away. So a failed poll is counted, not fatal — only
    POLL_FAILURES_ALLOWED consecutive failures end it, and the error then says
    the prediction may still have finished at Replicate.

    EVERY POLL HAS ITS OWN TIMEOUT. Without one, a hung connection hangs the
    run: `Date.now() < deadline` is only checked BETWEEN iterations and a fetch
    that never settles never reaches the next one.
  */
  const deadline = Date.now() + POLL_FOR_MS;
  let failures = 0;
  while (doc.status && !["succeeded", "failed", "canceled"].includes(doc.status) && Date.now() < deadline) {
    if (opts.signal?.aborted) return { ok: false, skipped: false, model, ms: Date.now() - started, error: "The run was cancelled while the prediction was still going." };
    await new Promise((r) => setTimeout(r, POLL_MS));
    const get = doc.urls?.get;
    if (!get) break;
    const poll = await fetch(get, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)])
        : AbortSignal.timeout(POLL_TIMEOUT_MS),
    }).catch(() => null);
    if (!poll?.ok) {
      failures += 1;
      if (failures >= POLL_FAILURES_ALLOWED)
        return {
          ok: false,
          skipped: false,
          model,
          ms: Date.now() - started,
          error:
            `Replicate stopped answering when asked how the prediction was going (${failures} tries in a row). ` +
            `The prediction was paid for and may still have finished — look for it in Replicate's own dashboard.`,
        };
      continue;
    }
    failures = 0;
    doc = (await poll.json().catch(() => doc)) as typeof doc;
  }

  if (doc.status !== "succeeded")
    return {
      ok: false,
      skipped: false,
      model,
      ms: Date.now() - started,
      error: `The prediction is “${doc.status ?? "unknown"}”${doc.error ? ` — ${String(doc.error).slice(0, 200)}` : ""}.`,
    };

  const url = firstUrl(doc.output);
  if (!url) return { ok: false, skipped: false, model, ms: Date.now() - started, error: "The prediction succeeded and produced no video URL." };

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_MS) });
    if (!res.ok) return { ok: false, skipped: false, model, ms: Date.now() - started, error: `The video URL answered HTTP ${res.status}.` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return { ok: false, skipped: false, model, ms: Date.now() - started, error: "The video URL answered with nothing." };
    if (bytes.length > VIDEO_CAP)
      return { ok: false, skipped: false, model, ms: Date.now() - started, error: `The clip is ${Math.round(bytes.length / 1_048_576)} MB, larger than this stores.` };
    writeFileSync(opts.out, bytes);
    return { ok: true, path: opts.out, model, ms: Date.now() - started };
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { ok: false, skipped: false, model, ms: Date.now() - started, error: `The finished clip could not be downloaded (${name}).` };
  }
}

function firstUrl(output: unknown): string | null {
  if (typeof output === "string") return output.startsWith("http") ? output : null;
  if (Array.isArray(output)) for (const o of output) {
    const u = firstUrl(o);
    if (u) return u;
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const key of ["video", "url", "output"]) {
      const u = firstUrl(o[key]);
      if (u) return u;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- the run */

type StepNote = { step: string; ok: boolean; note: string };

/**
 * One UGC job, as a video run.
 *
 * Reached from `video/execute.ts` through a guarded dynamic import when the
 * run's `format` input is `ugc`. Dynamic rather than static so this area's
 * module graph is never pulled into the video manifest's — see the manifest
 * contract's note about `MANIFESTS` and initialisation order.
 */
export async function ugcVideo(opts: {
  runId: string;
  session: RunSession;
  venture: VentureRow | null;
  input: { brief: string; assets: string; aspect: string; fit: Fit; seconds: number };
  signal?: AbortSignal;
}): Promise<void> {
  const { session: s, venture: v, input } = opts;
  if (!v)
    throw new StepError(
      "input",
      "A UGC job is made out of a venture's own reference pictures. Choose a business.",
    );

  const dir = runDir(opts.runId);
  mkdirSync(dir, { recursive: true });
  const frame = ASPECTS[input.aspect] ?? ASPECTS["9:16"]!;
  const steps: StepNote[] = [];
  const record = (step: string, ok: boolean, note: string) => steps.push({ step, ok, note });

  /* ------------------------------------------------------- 1. the assets */
  const assetStep = s.startStep("assets", "finding the venture's reference pictures");
  const wanted = input.assets
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const library = assetRows(v.id).filter((a) => existsSync(a.path));
  const chosen = (
    wanted.length ? wanted.map((id) => library.find((a) => a.id === id)).filter((a) => a !== undefined) : library
  ).slice(0, 4);
  if (!chosen.length) {
    s.endStep(assetStep, "no reference pictures");
    throw new StepError(
      "assets",
      `${v.name} has no reference pictures in its asset library, and a UGC shot is a picture of a real ` +
        `product rather than a prompt. Upload a logo or a product photo under Social media → Publishing → Assets.`,
    );
  }
  record("assets", true, `${chosen.length} reference picture${chosen.length === 1 ? "" : "s"} from the library`);
  s.endStep(assetStep, `${chosen.length} reference${chosen.length === 1 ? "" : "s"}`);
  markUsed(chosen.map((a) => a.id));

  /* -------------------------------------------------------- 2. the image */
  const model = imageModel();
  const support = await modelImageInput(model);
  const brand = readBrand(v.brand);
  const imagePrompt = buildImagePrompt(v, input.brief, chosen.map(assetAsText), support.supported);
  const videoPrompt = buildVideoPrompt(input.brief);
  const seconds = ugcSeconds();

  saveUgc({
    runId: opts.runId,
    ventureId: v.id,
    assetIds: chosen.map((a) => a.id),
    imagePrompt,
    videoPrompt,
    imagePath: null,
    videoPath: null,
    imageModel: model,
    imageField: support.field,
    videoModel: videoModel(),
    seconds,
    captions: null,
    publishItem: null,
    steps,
    skipped: null,
    error: null,
  });

  const imageStep = s.startStep("image", `putting the product in a scene with ${model}`);
  const dataUrls = support.supported ? chosen.map((a) => assetAsDataUrl(a.id)).filter((u) => u !== null) : [];
  const image = await makeImage(
    imagePrompt,
    input.aspect === "1:1" ? "square" : input.aspect === "16:9" ? "landscape" : "story",
    `ugc-${opts.runId}`,
    support.supported ? { dataUrls, field: support.field, many: support.many } : undefined,
  );
  if (!image.ok || !image.path) {
    s.endStep(imageStep, "the scene could not be made");
    saveUgc({ runId: opts.runId, error: image.error, steps: [...steps, { step: "image", ok: false, note: image.error ?? "" }] });
    throw new StepError("image", image.error ?? "the image model produced nothing");
  }
  record(
    "image",
    true,
    support.supported
      ? `${support.note} The ${chosen.length} reference${chosen.length === 1 ? " was" : "s were"} passed as an image input.`
      : `${support.note}`,
  );
  s.endStep(imageStep, support.supported ? "the scene, from the references" : "the scene, from words only");
  s.say(
    support.supported
      ? `The image model takes a picture in its \`${support.field}\` input, so the venture's own references went in as pictures.`
      : `**The image model takes no picture as an input.** ${support.note} The scene was made from the prompt alone, which is much weaker than a reference — the product in it is the model's idea of the product.`,
  );

  /* ---------------------------------------------------- 3. the animation */
  const animStep = s.startStep("animate", "asking a video model to move it");
  const out = resolve(dir, "ugc.mp4");
  const anim = await animate({ imagePath: image.path, prompt: videoPrompt, seconds, out, signal: opts.signal });
  let videoPath: string | null = null;
  let skipped: string | null = null;
  if (anim.ok) {
    videoPath = anim.path;
    record("animate", true, `${anim.model} produced a ${seconds}-second clip in ${(anim.ms / 1000).toFixed(1)}s`);
    s.endStep(animStep, `${seconds} seconds from ${anim.model}`);
  } else {
    skipped = anim.error;
    record("animate", false, anim.error);
    s.endStep(animStep, anim.skipped ? "skipped — nothing was spent" : "the model refused");
    s.say(
      anim.skipped
        ? `**The animation step did not run and nothing was spent.** ${anim.error}`
        : `**The animation failed.** ${anim.error} The still frame above is what this job produced.`,
    );
    /* A failed or skipped animation is NOT a failed run. What exists is a
       product shot, which is a usable thing, and failing the run would throw
       it away along with the money the image cost. */
  }

  /* ------------------------------------------------------ 4. the caption */
  let captionNote = "no caption — there was no video to put one on";
  if (videoPath) {
    const capStep = s.startStep("captions", "burning the line in");
    const ffmpeg = findFfmpeg();
    const captioner = await pickCaptioner();
    const style: CaptionStyle = { width: frame.width, height: frame.height, color: v.color, font: brand.fonts[0] ?? null };
    const line = (input.brief || v.name).slice(0, 120);
    captionNote = captioner.note;
    if (!ffmpeg.path) {
      captionNote = ffmpeg.error ?? "no ffmpeg on this box, so nothing could be drawn onto the clip";
      record("captions", false, captionNote);
      s.endStep(capStep, "no encoder");
    } else {
      const filters = await ffmpegFilters(ffmpeg.path);
      const png = captioner.strip ? await captioner.strip(line, style, stripPath(dir, 0), opts.signal) : null;
      const expr = captioner.expr ? captioner.expr(line, style) : null;
      const captioned = resolve(dir, "ugc-captioned.mp4");
      const res = await segment({
        ffmpeg: ffmpeg.path,
        source: videoPath,
        out: captioned,
        start: 0,
        seconds,
        width: frame.width,
        height: frame.height,
        fit: input.fit,
        blur: blurFilter(filters),
        pad: v.color,
        overlays: png ? [{ png, from: null, to: null }] : [],
        drawtext: png ? null : expr,
        audio: null,
        /* A silent track rather than no track: a clip with no audio stream
           behaves differently in every player and in every uploader. */
        silentTrack: true,
        signal: opts.signal,
      });
      if (res.ok) {
        videoPath = res.path;
        record("captions", true, captioner.note);
        s.endStep(capStep, captioner.id);
      } else {
        captionNote = `${res.error} — the uncaptioned clip is what was kept.`;
        record("captions", false, captionNote);
        s.endStep(capStep, "the overlay failed");
      }
    }
  }

  /* --------------------------------------------------- 5. review and file */
  const ffprobe = findFfprobe();
  const duration = videoPath && ffprobe.path ? await probeDuration(ffprobe.path, videoPath, opts.signal) : null;

  /* The job goes on the Video page through the video area's own store, so a
     UGC clip is read with the same route, the same player and the same "is the
     file still there" check as everything else this box makes. */
  saveJob({
    runId: opts.runId,
    ventureId: v.id,
    format: "ugc",
    aspect: input.aspect,
    width: frame.width,
    height: frame.height,
    script: { brief: input.brief, imagePrompt, videoPrompt, references: chosen.map((a) => a.name ?? a.id) },
    assets: [],
    durationS: duration,
    bytes: videoPath ? bytesOf(videoPath) : bytesOf(image.path),
    path: videoPath ?? image.path,
    captions: captionNote,
    narration: "none — a UGC clip is silent unless the model that made it produced sound.",
    transcript: null,
    error: skipped,
  });

  /* THE DRAFT. `video_job` is the source kind whether the file is a clip or
     the still: the publishing area reads `video_jobs.path` and sniffs the
     bytes, so it draws whichever one is actually there. It is a DRAFT and
     nothing here approves it — see integrations/publishing/items.ts, where the
     path from draft to published passes through the owner. */
  const filed = createItem({
    ventureId: v.id,
    source: { kind: "video_job", id: opts.runId },
    caption: input.brief || null,
  });
  const publishItem = filed.ok ? filed.item.id : null;
  /* AND ONE CORRECTION, because a UGC job is the first `video_job` that can
     legitimately produce a STILL. `resolveSource` reads the source kind and
     records `media_kind: "video"`, which is right for every other job of that
     kind and wrong for this one — and the queue uses that column to pick which
     platform limits apply and whether the destination can post it at all. So
     the kind is re-derived from the file's OWN FIRST BYTES with the publishing
     area's own sniffer, and the row is corrected only when the two disagree.
     Nothing else about the item is touched. */
  if (filed.ok && filed.created && filed.item.media_path) {
    const real = mediaKindOf(filed.item.media_path);
    if (real && real !== filed.item.media_kind)
      db.prepare("UPDATE publish_items SET media_kind = ?, updated_at = ? WHERE id = ?").run(real, now(), filed.item.id);
  }
  record("draft", filed.ok, filed.ok ? `filed as draft ${filed.item.id}` : filed.error);

  saveUgc({
    runId: opts.runId,
    imagePath: image.path,
    videoPath,
    captions: captionNote,
    publishItem,
    steps,
    skipped,
    error: null,
  });

  s.say(report({ venture: v, brief: input.brief, model, support: support.note, seconds, skipped, captionNote, publishItem, references: chosen.length }));
}

/** What a file actually is, from its first bytes, in the publishing area's own
 *  vocabulary. Null when the bytes name nothing recognisable, in which case the
 *  row keeps whatever it was given. */
function mediaKindOf(path: string): "image" | "video" | null {
  /* Sixteen bytes and a seek, the way the publishing area's own `mediaFacts`
     reads a mime: one of these files can be a video and reading it whole to
     learn its first four bytes would be absurd. */
  let mime: string | null = null;
  try {
    const fd = openSync(path, "r");
    try {
      const head = new Uint8Array(16);
      const read = readSync(fd, head, 0, 16, 0);
      mime = sniff(head.subarray(0, read));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  if (!mime) return null;
  return mime.startsWith("video/") ? "video" : mime.startsWith("image/") ? "image" : null;
}

function buildImagePrompt(v: VentureRow, brief: string, assetTexts: string[], hasImageInput: boolean): string {
  const lines = [
    `A photorealistic user-generated-content style photograph for ${v.name}${v.website ? ` (${v.website})` : ""}.`,
    brief ? `The scene: ${brief}.` : `The scene: the product in ordinary use, in a real room, in natural light.`,
    `Shot as if on a phone by a customer — handheld framing, natural light, no studio lighting, no stock-photo gloss.`,
    /* The same rule the Studio's own image prompt keeps: no text in the
       picture. A model asked for a logo draws a wrong one. */
    `No text, no lettering, no logos, no signage, no watermark and no user interface of any kind in the picture.`,
  ];
  if (!hasImageInput && assetTexts.length) {
    lines.push(
      `The reference pictures could NOT be passed to this model, so they are described instead: ${assetTexts.join("; ")}.`,
    );
  }
  return lines.join(" ").slice(0, 1_800);
}

function buildVideoPrompt(brief: string): string {
  return [
    brief ? `${brief}.` : `The product in ordinary use.`,
    `Subtle handheld camera motion, natural light, the subject stays in frame. No cuts, no text, no captions.`,
  ]
    .join(" ")
    .slice(0, 1_200);
}

function report(ctx: {
  venture: VentureRow;
  brief: string;
  model: string;
  support: string;
  seconds: number;
  skipped: string | null;
  captionNote: string;
  publishItem: string | null;
  references: number;
}): string {
  const lines: string[] = [];
  lines.push(`## A UGC shot for ${ctx.venture.name}`);
  lines.push("");
  lines.push(
    ctx.skipped
      ? `A still frame, from ${ctx.references} of this venture's own reference picture${ctx.references === 1 ? "" : "s"}. **There is no video.** ${ctx.skipped}`
      : `A ${ctx.seconds}-second clip, grown from a still made out of ${ctx.references} of this venture's own reference picture${ctx.references === 1 ? "" : "s"}.`,
  );
  lines.push("");
  lines.push(`## How it was made`);
  lines.push("");
  lines.push(`- Scene: ${ctx.model}. ${ctx.support}`);
  lines.push(`- Animation: ${ctx.skipped ? "not run" : (videoModel() ?? "unknown")}`);
  lines.push(`- Captions: ${ctx.captionNote}`);
  lines.push(
    `- Sound: none. Nothing copyrighted is bundled with this dashboard and no voice was asked for, so this clip is silent.`,
  );
  lines.push("");
  if (ctx.publishItem) {
    lines.push(
      `Filed in the publishing queue as **draft ${ctx.publishItem}**. It is a DRAFT: nothing has been posted anywhere, and the path from draft to published goes through your approval.`,
    );
  } else {
    lines.push(`It could not be filed in the publishing queue. The file is on this run page.`);
  }
  return lines.join("\n");
}

/** Upsert, so the row exists from the first step and survives a failure with
 *  everything that had been decided by then. */
function saveUgc(job: {
  runId: string;
  ventureId?: string | null;
  assetIds?: string[];
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  imagePath?: string | null;
  videoPath?: string | null;
  imageModel?: string | null;
  imageField?: string | null;
  videoModel?: string | null;
  seconds?: number | null;
  captions?: string | null;
  publishItem?: string | null;
  steps?: { step: string; ok: boolean; note: string }[];
  skipped?: string | null;
  error?: string | null;
}) {
  const existing = ugcRow(job.runId);
  const value = <T>(fresh: T | undefined, old: T): T => (fresh === undefined ? old : fresh);
  db.prepare(
    `INSERT INTO ugc_jobs
       (run_id, venture_id, ts, asset_ids, image_prompt, video_prompt, image_path, video_path,
        image_model, image_field, video_model, seconds, captions, publish_item, steps, skipped, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET
       venture_id = excluded.venture_id, asset_ids = excluded.asset_ids,
       image_prompt = excluded.image_prompt, video_prompt = excluded.video_prompt,
       image_path = excluded.image_path, video_path = excluded.video_path,
       image_model = excluded.image_model, image_field = excluded.image_field,
       video_model = excluded.video_model, seconds = excluded.seconds,
       captions = excluded.captions, publish_item = excluded.publish_item,
       steps = excluded.steps, skipped = excluded.skipped, error = excluded.error`,
  ).run(
    job.runId,
    value(job.ventureId, existing?.venture_id ?? null),
    existing?.ts ?? now(),
    JSON.stringify(value(job.assetIds, parseList(existing?.asset_ids ?? "[]"))),
    value(job.imagePrompt, existing?.image_prompt ?? null),
    value(job.videoPrompt, existing?.video_prompt ?? null),
    value(job.imagePath, existing?.image_path ?? null),
    value(job.videoPath, existing?.video_path ?? null),
    value(job.imageModel, existing?.image_model ?? null),
    value(job.imageField, existing?.image_field ?? null),
    value(job.videoModel, existing?.video_model ?? null),
    value(job.seconds, existing?.seconds ?? null),
    value(job.captions, existing?.captions ?? null),
    value(job.publishItem, existing?.publish_item ?? null),
    /* THE EXISTING ROW'S STEPS, not an empty array. Every other field here
       falls back to what is stored; this one did not, so the first call site
       that omitted `steps` would silently wipe the per-step record. */
    JSON.stringify(value(job.steps, parseSteps(existing?.steps ?? "[]"))),
    value(job.skipped, existing?.skipped ?? null),
    value(job.error, existing?.error ?? null),
  );
}

/** Where the Studio writes its images, re-exported so a route can serve a UGC
 *  still without knowing that a UGC still is a Studio image. */
export const UGC_IMAGE_DIR = STUDIO_DIR;
