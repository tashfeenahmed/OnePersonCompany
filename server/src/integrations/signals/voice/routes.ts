/**
 * The voice endpoints: what is set up, one transcription, one clip of speech.
 *
 * `POST /speak` ANSWERS JSON WITH A PATH RATHER THAN AUDIO BYTES, and that is
 * a decision about the skills layer. An action published to an agent has to
 * come back as something an agent can hold — a path and an id it can quote —
 * and forty seconds of mp3 down a tool call is neither useful nor readable.
 * The bytes are one GET away at `/api/voice/clip/:id`, which is what a phase-2
 * page puts in an <audio src>. Both doors, one file on disk, no duplication.
 *
 * `POST /transcribe` TAKES RAW AUDIO OR A FORM, because the two callers want
 * different things: `curl --data-binary @clip.wav` is what a person testing
 * this will type, and a browser file input produces multipart. Neither is
 * asked to know about the other.
 */
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { getPlugin } from "../../../db.ts";
import { voiceRuns, voiceTotals } from "../db.ts";
import {
  MAX_AUDIO_BYTES,
  clipPath,
  probe,
  settings,
  speak,
  state,
  transcribe,
} from "./provider.ts";

export const voiceRoutes = new Hono();

/** What is configured, what it can do, and what it has done. Self-describing
 *  because the page that will render it does not exist yet. */
voiceRoutes.get("/", (c) => {
  const s = state();
  const runs = voiceRuns(20);
  const totals = voiceTotals();
  const stt = totals.find((t) => t.kind === "stt");
  const last = runs.find((r) => r.kind === "stt" || r.kind === "probe");

  return c.json({
    connected: getPlugin("voice")?.connected === 1,
    state: s,
    /** Milliseconds, and a MEDIAN rather than a mean: one 40-second cold
     *  start on a local model would drag an average past every real answer. */
    latency: {
      unit: "ms",
      transcriptionMedian: stt?.medianMs ?? null,
      lastAt: last?.ts ?? null,
      lastMs: last?.ms ?? null,
    },
    counts: totals.map((t) => ({ kind: t.kind, ok: t.ok, failed: t.failed, medianMs: t.medianMs })),
    runs: runs.map((r) => ({
      ts: r.ts,
      kind: r.kind,
      ms: r.ms,
      bytes: r.bytes,
      ok: r.ok === 1,
      error: r.error,
    })),
    notes: [
      "Nothing here stores a word that was said or a byte that was heard. A " +
        "transcript goes into the chat transcript where the typed message would " +
        "have gone; these rows are timings and outcomes only.",
      "`connected` means an STT endpoint is SET. Whether it answers is what the " +
        "probe says, and the two are different sentences.",
      s.ffmpeg
        ? `ffmpeg at ${s.ffmpeg} — a spoken reply goes to Telegram as a voice note.`
        : "ffmpeg was not found, so a spoken reply goes as an audio file attachment rather than an inline voice note.",
    ],
  });
});

/** The silent-wav probe, on demand. The same one `verify` runs when a key is
 *  pasted and the collector runs on the scheduler. */
voiceRoutes.post("/probe", async (c) => {
  const got = await probe();
  return c.json(got, got.ok ? 200 : 502);
});

/**
 * One transcription. Raw body or multipart `file`.
 *
 * A REFUSAL IS A SENTENCE AND A STATUS, never an empty 200: the caller is
 * usually a script, and "no transcription endpoint is set" has to be
 * distinguishable from "your audio contained no words", which is a legitimate
 * empty string on a successful call.
 */
voiceRoutes.post("/transcribe", async (c) => {
  const s = settings();
  if (!s.sttUrl.trim())
    return c.json(
      {
        error:
          "No transcription endpoint is set. Put an OpenAI-compatible base url in " +
          "the voice plugin's `sttUrl` setting — a local whisper server, or " +
          "https://api.openai.com/v1.",
      },
      409,
    );

  let bytes: Uint8Array;
  let name = "audio.wav";
  const type = c.req.header("content-type") ?? "";
  try {
    if (type.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File))
        return c.json({ error: "Send the audio as a `file` part, or as the raw request body." }, 400);
      bytes = new Uint8Array(await file.arrayBuffer());
      name = file.name || name;
    } else {
      bytes = new Uint8Array(await c.req.arrayBuffer());
      // The extension is the only hint a transcription endpoint gets about
      // what it is holding, so it is taken from the content type rather than
      // guessed as wav for everything.
      const ext = /ogg|opus/.test(type) ? "ogg" : /mpeg|mp3/.test(type) ? "mp3" : /mp4|m4a/.test(type) ? "m4a" : "wav";
      name = `audio.${ext}`;
    }
  } catch {
    return c.json({ error: "That body could not be read as audio." }, 400);
  }

  if (!bytes.byteLength) return c.json({ error: "The body was empty — there is nothing to transcribe." }, 400);
  if (bytes.byteLength > MAX_AUDIO_BYTES)
    return c.json({ error: `That is ${Math.round(bytes.byteLength / 1024 / 1024)} MB; the cap is 20 MB.` }, 413);

  try {
    const got = await transcribe(bytes, name, { reader: "api_transcribe" });
    return c.json({
      text: got.text,
      /** An empty string is a real answer: silence transcribes to nothing. */
      empty: got.text === "",
      ms: got.ms,
      bytes: got.bytes,
      model: got.model,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "The transcription failed." }, 502);
  }
});

/** Speech out. Returns where the clip is, not the clip — see the header. */
voiceRoutes.post("/speak", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "Expected { text: \"…\" }." }, 400);
  if (text.length > 4_000) return c.json({ error: "That is longer than 4,000 characters." }, 400);

  try {
    const spoken = await speak(text);
    return c.json({
      id: spoken.id,
      path: spoken.path,
      url: `/api/voice/clip/${spoken.id}.${spoken.format}`,
      format: spoken.format,
      bytes: spoken.bytes,
      ms: spoken.ms,
      via: spoken.via,
    });
  } catch (err) {
    /* 409 rather than 502 for a refusal: speech being off is a configuration
       state the caller can fix, not an endpoint having a bad minute. */
    const message = err instanceof Error ? err.message : "Speech failed.";
    return c.json({ error: message }, /off|not configured|No speech|No piper/i.test(message) ? 409 : 502);
  }
});

/** The bytes of a clip this server made. Ids are uuids minted by `speak`, and
 *  the format is a fixed pair, so nothing a caller sends composes a path. */
voiceRoutes.get("/clip/:file", (c) => {
  const file = c.req.param("file");
  const m = /^([0-9a-f-]{36})\.(mp3|wav|ogg)$/.exec(file);
  if (!m) return c.json({ error: "Not a clip id." }, 400);
  const path = clipPath(m[1]!, m[2]!);
  if (!existsSync(path)) return c.json({ error: "That clip is no longer on disk." }, 404);
  const type = m[2] === "mp3" ? "audio/mpeg" : m[2] === "ogg" ? "audio/ogg" : "audio/wav";
  return c.body(readFileSync(path), 200, { "content-type": type });
});
