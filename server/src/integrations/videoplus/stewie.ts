/**
 * THE STEWIE REEL — Peter explains, Stewie interrupts, over mobile-game
 * footage, with cloned voices and word-by-word subtitles.
 *
 * THIS BOX DOES NOT RENDER IT, AND THAT IS THE WHOLE DESIGN. The format was
 * built in the render relay: the Pi owns the job — the search, the page captures, the
 * render, the decision to spend a wake — and the Dell under the desk owns the
 * voice model and the cores. Voice cloning wants a GPU; this machine has none
 * to spare and the Pi has none at all. So the pipeline here is a CLIENT of the
 * render relay's own reel routes, over the LAN, with the agent's service
 * key. This workspace writes the script using its selected LLM; it starts the job, watches it, and fetches the file when it is done.
 * The rendering engine now runs as OPC’s dedicated relay. It wakes the Dell
 * when needed and leaves it running when the job finishes.
 *
 * WHAT A RUN HERE ADDS is the ledger: the run row, the steps as the job moves
 * through the Pi's states, the mp4 copied into this box's own video store, and
 * the job row beside every other video, so it shows on the Studio's rail and
 * plays on the run page like a faceless video does. The Pi keeps its own copy
 * for as long as its keep-cap allows; ours is ours.
 *
 * TWO KINDS OF PICTURE, the same two the Pi offers. `images` drops a searched
 * picture over the footage for every line, which explains a concept and sells
 * nothing. `pages` scrolls real screenshots of the pages the owner listed while
 * the two of them talk over the top — the mode for showing a product. In
 * pages mode the prompt is optional: the page titles are the topic.
 *
 * THE CREDENTIAL IS THE AGENT'S SERVICE KEY, held in the vault under the
 * `workdash` plugin (the retained database ID for Render worker): the relay
 * address and the bearer it expects. It is
 * read through `accounts.credentialed` with this module's own reader name, so
 * the vault's audit trail says the Stewie pipeline read it, not "video".
 *
 * WHAT THIS CANNOT PROMISE. The Dell may be off, in which case the Pi wakes
 * it and the first ninety seconds of the run are a boot; the worker may be
 * busy with another reel, in which case the Pi refuses with a sentence and so
 * does this. Both are on the run's report in the Pi's own words.
 */
import { createWriteStream, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { VentureRow } from "../../db.ts";
import * as accounts from "../../accounts.ts";
import { StepError, runDir, type RunSession } from "../video/faceless.ts";
import { saveJob } from "../video/store.ts";
import { bytesOf, findFfprobe, probeDuration } from "../video/tools.ts";
import { gameplayBackgrounds } from "./gameplay-previews.ts";
import type { GameplayBackground } from "../../../../shared/gameplay.ts";
import { writeStewieScript, type PreparedReel } from "./stewie-script.ts";
import { activeProvider, NoProviderError } from "../../models/provider.ts";

export const WORKDASH_PLUGIN = "workdash";
const READER = "videoplus.stewie";

/** How long a job may take end to end before this run gives up on it. A cold
 *  Dell is ninety seconds of boot, the script is a model turn on that box, and
 *  a render is minutes — twenty-five is generous and still finite. */
const JOB_TIMEOUT_MS = 25 * 60_000;
const POLL_MS = 5_000;

export type StewieInput = {
  prompt: string;
  /** `pages` when addresses were given, else `images`. */
  mode: "images" | "pages";
  /** One address per line, pages mode only. */
  urls: string;
  /** A gameplay clip name the worker knows, or blank for the worker's default. */
  background: string;
};

type Agent = { url: string; key: string; label: string };

type ReelLine = { id: number; character: string; text: string; image_search?: string };
type ReelCapture = { url: string; title: string | null; file: string | null; width: number | null; height: number | null; error: string | null };
type ReelItem = {
  id: string;
  at: number;
  prompt: string;
  status: string;
  mode?: "images" | "pages";
  urls?: string[];
  captures?: ReelCapture[];
  grounded?: boolean;
  sources?: { title: string; url: string }[];
  dell: string | null;
  slept: boolean | null;
  lines: ReelLine[] | null;
  video: string | null;
  background: string | null;
  renderSeconds?: number | null;
  error: string | null;
};
type ReelWorker = {
  reachable: boolean;
  gpu?: string | null;
  modelLoaded?: boolean;
  busy?: boolean;
  backgrounds?: string[];
  voices?: string[];
  modes?: string[];
  error?: string;
};
type ReelDoc = { items: ReelItem[]; running: boolean; sleepDueAt: number | null; worker: ReelWorker; externalScript?: boolean };

/** The one connected render relay, or a sentence saying why there is none. */
export function agent(): { agent: Agent | null; note: string } {
  const { ready, broken } = accounts.credentialed(WORKDASH_PLUGIN, ["url", "key"], READER);
  const first = ready[0];
  if (first) {
    const url = first.values.url!.trim().replace(/\/+$/, "");
    return { agent: { url, key: first.values.key!.trim(), label: first.account.label }, note: `render relay at ${url}.` };
  }
  if (broken.length)
    return { agent: null, note: `The Render worker account “${broken[0]!.account.label}” is missing ${broken[0]!.missing.join(" and ")}.` };
  return { agent: null, note: "No render relay is connected. Add one under Integrations → Render worker: the agent's address and its service key." };
}

async function ask<T>(a: Agent, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${a.url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${a.key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const error = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : text.slice(0, 200);
    throw new Error(`${res.status} from ${path}: ${error || res.statusText}`);
  }
  return body as T;
}

/**
 * What the Pi and, through it, the Dell can do right now — for the Studio's
 * tab. Answers honestly while the Dell is off rather than waking it to ask:
 * `worker.reachable: false` with the Pi's own reason.
 */
export async function capabilities(): Promise<{
  configured: boolean;
  note: string;
  agent: string | null;
  running: boolean;
  worker: ReelWorker | null;
  backgrounds: GameplayBackground[];
  recent: { id: string; status: string; prompt: string; at: number; mode: string }[];
}> {
  const { agent: a, note } = agent();
  if (!a) return { configured: false, note, agent: null, running: false, worker: null, backgrounds: [], recent: [] };
  try {
    const doc = await ask<ReelDoc>(a, "/agent/reel");
    return {
      configured: true,
      note: doc.worker.reachable
        ? `The render worker is up${doc.worker.gpu ? ` on ${doc.worker.gpu}` : ""}.`
        : `The render worker is not answering (${doc.worker.error ?? "asleep"}). The Pi wakes it when a reel starts — expect about ninety seconds before rendering begins.`,
      agent: a.url,
      running: doc.running,
      worker: doc.worker,
      backgrounds: gameplayBackgrounds(a.url, doc.worker.reachable ? doc.worker.backgrounds ?? [] : undefined),
      recent: (doc.items ?? []).slice(0, 5).map((i) => ({ id: i.id, status: i.status, prompt: i.prompt, at: i.at, mode: i.mode ?? "images" })),
    };
  } catch (err) {
    return {
      configured: true,
      note: `The render relay at ${a.url} did not answer: ${err instanceof Error ? err.message : String(err)}`,
      agent: a.url,
      running: false,
      worker: null,
      backgrounds: gameplayBackgrounds(a.url),
      recent: [],
    };
  }
}

const STATUS_LABEL: Record<string, string> = {
  queued: "waiting for the Pi's queue",
  capturing: "the Pi is screenshotting the pages",
  researching: "the Pi is searching for grounding",
  waking: "waking the Dell — about ninety seconds",
  "writing-script": "the Dell is writing the two-hander",
  rendering: "cloning the voices and compositing",
};

export async function stewieVideo(opts: {
  runId: string;
  session: RunSession;
  venture: VentureRow | null;
  input: StewieInput;
  signal?: AbortSignal;
}): Promise<void> {
  const { session: s, input, signal } = opts;
  if (!activeProvider()) throw new NoProviderError();
  const dir = runDir(opts.runId);
  mkdirSync(dir, { recursive: true });

  /* ------------------------------------------------------- 1. the agent */
  const agentStep = s.startStep("workdash", "finding the render relay");
  const { agent: a, note } = agent();
  if (!a) {
    s.endStep(agentStep, "none");
    throw new StepError("workdash", note);
  }
  let before: ReelDoc;
  try {
    before = await ask<ReelDoc>(a, "/agent/reel");
  } catch (err) {
    s.endStep(agentStep, "unreachable");
    throw new StepError("workdash", `The render relay at ${a.url} did not answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (before.running) {
    s.endStep(agentStep, "busy");
    throw new StepError("workdash", "The Pi is already rendering a reel. It does one at a time; try again when that one is done.");
  }
  s.endStep(agentStep, before.worker.reachable ? `worker up${before.worker.gpu ? ` · ${before.worker.gpu}` : ""}` : "worker asleep — the Pi will wake it");

  /* ------------------------------------------------------------ 2. start */
  const urls = input.urls.split(/\r?\n|,/).map((u) => u.trim()).filter(Boolean);
  const mode = input.mode === "pages" && urls.length ? "pages" : "images";
  if (!before.externalScript) {
    throw new StepError("script", "Update the render relay to support workspace-written scripts. This keeps Stewie on your selected LLM.");
  }
  const scriptStep = s.startStep("script", "writing with the workspace LLM");
  let script: Awaited<ReturnType<typeof writeStewieScript>>;
  try {
    const prepared = await ask<PreparedReel>(a, "/agent/reel/prepare-script", {
      method: "POST", body: JSON.stringify({ prompt: input.prompt, mode, urls }),
    }, AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]));
    script = await writeStewieScript(prepared, signal);
    s.endStep(scriptStep, `${script.provider}${script.model ? ` · ${script.model}` : ""}`);
  } catch (error) {
    s.endStep(scriptStep, "failed");
    throw new StepError("script", error instanceof Error ? error.message : String(error));
  }
  const startStep = s.startStep("start", `asking for a ${mode} reel`);
  let item: ReelItem;
  try {
    const out = await ask<{ ok: boolean; error?: string; item?: ReelItem }>(a, "/agent/reel/start", {
      method: "POST",
      body: JSON.stringify({
        prompt: input.prompt,
        background: input.background || null,
        mode,
        urls: mode === "pages" ? urls : [],
        script,
      }),
    });
    if (!out.ok || !out.item) throw new Error(out.error ?? "the agent refused without a reason");
    item = out.item;
  } catch (err) {
    s.endStep(startStep, "refused");
    throw new StepError("start", err instanceof Error ? err.message : String(err));
  }
  s.endStep(startStep, item.id);

  /* ------------------------------------------------------------- 3. wait */
  const began = Date.now();
  let lastStatus = "";
  let step = s.startStep("reel", STATUS_LABEL[item.status] ?? item.status);
  lastStatus = item.status;
  while (item.status !== "done" && item.status !== "failed") {
    if (signal?.aborted) {
      s.endStep(step, "cancelled here — the Pi's job keeps going");
      throw new StepError("reel", "Cancelled. The Pi was not told; its reel finishes on its own and stays in the render relay.");
    }
    if (Date.now() - began > JOB_TIMEOUT_MS) {
      s.endStep(step, "timed out");
      throw new StepError("reel", `The Pi's job ${item.id} was still “${item.status}” after ${Math.round(JOB_TIMEOUT_MS / 60_000)} minutes. It may yet finish in the render relay; this run stopped watching.`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    let doc: ReelDoc;
    try {
      doc = await ask<ReelDoc>(a, "/agent/reel");
    } catch {
      continue; /* one missed poll is a blip, not a failure */
    }
    const found = doc.items.find((i) => i.id === item.id);
    if (!found) {
      s.endStep(step, "gone");
      throw new StepError("reel", `The Pi no longer lists job ${item.id}. Its keep-cap may have dropped it, or it was deleted in the render relay.`);
    }
    item = found;
    if (item.status !== lastStatus) {
      s.endStep(step, `${Math.round((Date.now() - began) / 1000)}s`);
      lastStatus = item.status;
      if (item.status !== "done" && item.status !== "failed") step = s.startStep("reel", STATUS_LABEL[item.status] ?? item.status);
    }
  }
  if (item.status === "failed") {
    if (lastStatus !== "failed") s.endStep(step, "failed");
    throw new StepError("reel", item.error ?? "The Pi reported the reel failed and gave no reason.");
  }
  if (lastStatus !== "done") s.endStep(step, "done");
  if (!item.video) throw new StepError("reel", "The Pi says the reel is done but names no file.");

  /* ------------------------------------------------------------ 4. fetch */
  const fetchStep = s.startStep("fetch", "copying the file from the Pi");
  const out = resolve(dir, "video.mp4");
  try {
    const res = await fetch(`${a.url}/agent/reel/video/${encodeURIComponent(item.video)}`, {
      headers: { Authorization: `Bearer ${a.key}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(out));
  } catch (err) {
    s.endStep(fetchStep, "failed");
    throw new StepError("fetch", `The file could not be copied from the Pi: ${err instanceof Error ? err.message : String(err)}. It is still in the render relay as ${item.video}.`);
  }
  const ffprobe = findFfprobe();
  const duration = ffprobe.path ? await probeDuration(ffprobe.path, out, signal) : null;
  const bytes = bytesOf(out);
  s.endStep(fetchStep, `${duration ? `${duration.toFixed(1)}s · ` : ""}${bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "copied"}`);

  /* ----------------------------------------------------------- 5. record */
  const lines = item.lines ?? [];
  const title = (item.prompt || item.captures?.find((c) => c.title)?.title || "Peter & Stewie").slice(0, 80);
  saveJob({
    runId: opts.runId,
    ventureId: opts.venture?.id ?? null,
    format: "stewie",
    aspect: "9:16",
    width: 1080,
    height: 1920,
    script: {
      title,
      brief: item.prompt,
      mode: item.mode ?? mode,
      lines: lines.map((l) => ({ role: l.character, text: l.text, search: l.image_search ?? null })),
      captures: (item.captures ?? []).map((c) => ({ url: c.url, title: c.title, captured: !!c.file, error: c.error })),
      background: item.background,
      grounded: !!item.grounded,
      provider: script.provider,
      model: script.model,
      sources: item.sources ?? [],
      workdash: { id: item.id, dell: item.dell, slept: item.slept, renderSeconds: item.renderSeconds ?? null },
    },
    assets: [],
    durationS: duration,
    bytes,
    path: out,
    captions: "worker",
    narration: "tts — cloned voices on the Dell",
    transcript: lines.map((l) => `${l.character}: ${l.text}`).join("\n"),
    error: null,
  });

  s.say(
    [
      `## ${title}`,
      ``,
      `${lines.length} lines, ${duration ? `${duration.toFixed(1)} seconds` : "length unread"}, 1080×1920${item.background ? `, over ${item.background.replace(/_/g, " ")}` : ""}. Rendered by OPC's reel worker on the Dell and copied here. The file is on this page. Nothing has been published anywhere.`,
      ``,
      `## The dialogue`,
      ``,
      ...lines.map((l, i) => `**${i + 1}. ${l.character}** — ${l.text}`),
      ...(item.mode === "pages" && item.captures?.length
        ? [
            ``,
            `## The pages`,
            ``,
            ...item.captures.map((c) => `- ${c.file ? "" : "**not captured** — "}[${c.title ?? c.url}](${c.url})${c.error ? ` (${c.error})` : ""}`),
          ]
        : []),
      ...(item.sources?.length
        ? [``, `## What the script leaned on`, ``, ...item.sources.map((src) => `- [${src.title}](${src.url})`)]
        : [``, `No research sources were available for this script.`]),
      ``,
      `## Where the work happened`,
      ``,
      `The workspace wrote the script with ${script.provider}${script.model ? ` (${script.model})` : ""}. The Pi owned the render job (${item.id}); the Dell rendered it. ${
        item.dell === "woken"
          ? `This job woke the Dell${item.slept ? " and powered it off again" : item.slept === false ? " and left it on" : ""}.`
          : item.dell === "already-awake"
            ? "The Dell was already up for somebody else's reasons and was left on."
            : ""
      } The voices are Chatterbox clones from ten seconds of reference audio each; the subtitles are word-timed by the worker. Read the lines before you publish this — they were written by a model.`,
    ].join("\n"),
  );
}
