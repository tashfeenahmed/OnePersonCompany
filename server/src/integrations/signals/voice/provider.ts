/**
 * VOICE: transcription in, speech out.
 *
 * WHAT THIS IS FOR. The Telegram bridge is the one door onto this dashboard
 * that is used from a phone, and on a phone the fastest way to ask a question
 * is to say it. Everything else here already works: the bridge locks to one
 * chat, the agent answers, the transcript is shared with the Chat page. The
 * only missing piece is that a voice note arrives with no `text` field and is
 * answered with "I can only read text". This file is the text.
 *
 * NO MODEL RUNS HERE AND NO KEY IS ASSUMED. Both halves are
 * OPENAI-COMPATIBLE HTTP endpoints named by the owner: `sttUrl` may be a
 * whisper server on this laptop, a box on the LAN, or api.openai.com, and the
 * key is optional because a local server does not want one. That is the same
 * shape `local` takes for completions, and it is the only shape that works for
 * a box whose owner may not want a word of speech leaving the house.
 *
 * TTS IS OFF UNTIL IT IS CHOSEN, AND `off` IS A REAL VALUE. Speech out costs
 * money on a hosted endpoint and disk on a local one, and a dashboard that
 * starts talking because it could is a dashboard somebody turns off entirely.
 * Modes: `off`, `freellmapi` (the selected account), `openai` (any speech endpoint) and `piper`
 * (a binary on this machine). Piper is not installed here; the code path is
 * written, and `GET /api/voice` says out loud that the binary was not found
 * rather than failing at the moment somebody sends a voice note.
 *
 * TELEGRAM WANTS OGG/OPUS FOR A VOICE NOTE, and whatever a TTS endpoint
 * returns is mp3 or wav. `ffmpeg` does that conversion in one call and it is
 * on this machine at /opt/homebrew/bin/ffmpeg; where it is missing the reply
 * goes as `sendAudio` with the raw file instead, and the run note says so.
 * The difference matters on a phone: a voice note plays inline, an audio file
 * is an attachment.
 *
 * NOTHING IN THIS FILE STORES A WORD OR A BYTE OF SPEECH IN THE DATABASE. The
 * transcript goes where a typed message would have gone — the chat transcript
 * — and generated audio goes on disk under DATA_DIR/voice, addressable by an
 * id. `voice_runs` holds how long it took and whether it worked.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR } from "../../../config.ts";
import { configValue, configValues, setConfig } from "../../../db.ts";
import * as accounts from "../../../accounts.ts";
import { writeVoiceRun } from "../db.ts";
import { chosen as freeLLMAccount } from "../../../providers/freellmapi.ts";

export const PLUGIN = "voice";

/** Where generated audio lands. Gitignored with the rest of DATA_DIR. */
export const VOICE_DIR = join(DATA_DIR, "voice");

/** Telegram will not accept a file over 20 MB through the bot API, and a
 *  voice note that size is not a question anybody asked. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const TIMEOUT_MS = 120_000;

/* ------------------------------------------------------------- settings */

export type VoiceSettings = {
  sttUrl: string;
  sttModel: string;
  tts: "off" | "openai" | "piper" | "freellmapi";
  ttsUrl: string;
  ttsModel: string;
  ttsVoice: string;
  piperPath: string;
  piperModel: string;
  replyWithVoice: boolean;
};

export const DEFAULT_STT_MODEL = "whisper-1";
export const DEFAULT_TTS_MODEL = "tts-1";
export const DEFAULT_TTS_VOICE = "alloy";

export function settings(): VoiceSettings {
  const c = configValues(PLUGIN);
  const tts = c.tts === "openai" || c.tts === "piper" || c.tts === "freellmapi" ? c.tts : "off";
  return {
    sttUrl: (c.sttUrl ?? "").trim(),
    sttModel: (c.sttModel ?? "").trim() || DEFAULT_STT_MODEL,
    tts,
    ttsUrl: (c.ttsUrl ?? "").trim(),
    ttsModel: (c.ttsModel ?? "").trim() || (tts === "freellmapi" ? "auto" : DEFAULT_TTS_MODEL),
    ttsVoice: (c.ttsVoice ?? "").trim() || (tts === "freellmapi" ? "" : DEFAULT_TTS_VOICE),
    piperPath: (c.piperPath ?? "").trim(),
    piperModel: (c.piperModel ?? "").trim(),
    replyWithVoice: (c.replyWithVoice ?? "").trim().toLowerCase() === "on",
  };
}

/**
 * The two keys, read from the vault at the moment they are needed.
 *
 * BOTH ARE OPTIONAL AND THE ABSENCE OF ONE IS NOT AN ERROR. A whisper server
 * on the LAN wants no Authorization header at all, and sending an empty
 * bearer token to one that does not expect it is how a working endpoint
 * starts refusing. So a missing key means the header is simply not sent.
 */
function keys(reader: string): { stt: string | null; tts: string | null } {
  const { ready } = accounts.credentialed(PLUGIN, [], reader);
  const values = ready[0]?.values ?? {};
  return {
    stt: (values.sttKey ?? "").trim() || null,
    tts: (values.ttsKey ?? "").trim() || null,
  };
}

/**
 * The base url, tidied the way providers/local.ts tidies an endpoint: the
 * origin on its own is fine and `/v1` is added when it is missing, because
 * "paste the endpoint" and "paste the endpoint including the version segment"
 * are the same instruction to everybody except a URL parser.
 */
export function normaliseBase(raw: string): string | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return null;
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(path) && !path.endsWith("/audio")) path = `${path}/v1`;
  return `${url.origin}${path}`;
}

/* ------------------------------------------------------- the silent probe */

/**
 * Half a second of silence as a WAV, built in code.
 *
 * WHY A REAL FILE RATHER THAN A PING. There is no `/health` on an
 * OpenAI-compatible transcription endpoint, and a GET against it answers 405
 * on some servers and 404 on others — neither of which proves the thing the
 * owner needs proved, which is that a POSTed audio file comes back as JSON
 * with a `text` field in it. Silence is the cheapest audio that exercises the
 * whole path, and every engine answers it with an empty or near-empty string,
 * which is a PASS: what is being tested is the shape of the answer, not its
 * content.
 *
 * 16 kHz mono 16-bit PCM is what every speech model resamples to anyway, and
 * it needs no encoder — 44 bytes of header and 16,000 zeroed samples.
 */
export function silentWav(seconds = 0.5, rate = 16_000): Buffer {
  const samples = Math.round(seconds * rate);
  const data = Buffer.alloc(samples * 2); // 16-bit, already zero: silence
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);          // PCM header length
  header.writeUInt16LE(1, 20);           // format 1 = PCM
  header.writeUInt16LE(1, 22);           // one channel
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);    // byte rate
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/* ---------------------------------------------------------------- speech in */

export type Transcript = { text: string; ms: number; bytes: number; model: string };

/**
 * One transcription.
 *
 * MULTIPART, because that is what `/v1/audio/transcriptions` takes and there
 * is no JSON form of it. `FormData` and `Blob` are built into Node 24, so
 * this needs no dependency and no hand-rolled boundary.
 *
 * AN EMPTY `text` IS A SUCCESS. Silence transcribes to nothing, and a caller
 * that treated "" as a failure would report the health probe as broken every
 * time it worked. The failure this checks for is a body with no `text` field
 * at all, which is what a server answering some other shape looks like.
 */
export async function transcribe(
  audio: Uint8Array,
  filename: string,
  opts: { reader?: string; key?: string | null } = {},
): Promise<Transcript> {
  const s = settings();
  const base = normaliseBase(s.sttUrl);
  if (!base)
    throw new Error(
      "No transcription endpoint is set. Put an OpenAI-compatible base url in " +
        "the voice plugin's `sttUrl` setting — a local whisper server, or " +
        "https://api.openai.com/v1.",
    );
  if (audio.byteLength > MAX_AUDIO_BYTES)
    throw new Error(`That is ${Math.round(audio.byteLength / 1024 / 1024)} MB; the cap is 20 MB.`);

  /* `key` is passed in only by `verify`, which runs BEFORE the credential it
     is checking has been written — the whole point of verifying is to refuse
     a bad key at the point it was pasted rather than storing it and going
     quiet. Every other caller reads the vault. */
  const key = opts.key !== undefined ? opts.key : keys(opts.reader ?? "voice_transcribe").stt;
  const form = new FormData();
  form.append("file", new Blob([audio]), filename);
  form.append("model", s.sttModel);
  // The endpoint's own default is a JSON object with `text` in it; asked for
  // explicitly so a server whose default is SRT does not surprise this.
  form.append("response_format", "json");

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const ms = Date.now() - started;
    const why =
      err instanceof Error && err.name === "TimeoutError"
        ? "the transcription endpoint did not answer within two minutes"
        : `could not reach the transcription endpoint (${err instanceof Error ? err.name : "error"})`;
    writeVoiceRun({ kind: "stt", ms, bytes: audio.byteLength, ok: false, error: why });
    throw new Error(why);
  }

  const ms = Date.now() - started;
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    const why = `the transcription endpoint answered HTTP ${res.status}${body ? `: ${body}` : ""}`;
    writeVoiceRun({ kind: "stt", ms, bytes: audio.byteLength, ok: false, error: why });
    throw new Error(why);
  }

  const doc = (await res.json().catch(() => null)) as { text?: unknown } | null;
  if (!doc || typeof doc.text !== "string") {
    const why = "the transcription endpoint answered without a `text` field, so that is not a transcript";
    writeVoiceRun({ kind: "stt", ms, bytes: audio.byteLength, ok: false, error: why });
    throw new Error(why);
  }

  writeVoiceRun({ kind: "stt", ms, bytes: audio.byteLength, ok: true });
  return { text: doc.text.trim(), ms, bytes: audio.byteLength, model: s.sttModel };
}

/* --------------------------------------------------------------- speech out */

export type Speech = { id: string; path: string; bytes: number; ms: number; format: string; via: string };

/** Where a clip lives, given its id. Ids are uuids minted here, so nothing a
 *  caller sends can escape the directory. */
export function clipPath(id: string, format: string): string {
  return join(VOICE_DIR, `${id}.${format}`);
}

/** `voice` NAMES A DIFFERENT VOICE FOR THIS ONE CLIP, and it exists for the
 *  video area's dialogue reels, which need two speakers out of one endpoint.
 *  It is an override of the plugin's own setting and nothing else: an unknown
 *  name is the endpoint's to refuse, and it is refused loudly rather than
 *  quietly falling back to the default, because a reel whose two speakers
 *  silently became one voice is a reel that reads as a fault. Piper takes its
 *  voice from a model FILE rather than a name, so this is ignored there and
 *  the caller is told. */
type SpeechEndpoint = { base: string | null; key: string | null };
function speechEndpoint(s: VoiceSettings): SpeechEndpoint {
  if (s.tts === "freellmapi") {
    const account = freeLLMAccount("voice_speech");
    return { base: account?.baseUrl ?? null, key: account?.key ?? null };
  }
  return { base: normaliseBase(s.ttsUrl), key: s.tts === "openai" ? keys("voice_speech").tts : null };
}

type SpeechCheck = { at: string; ok: boolean; error: string | null; via: string | null };
// Bind verification to these exact speech settings, including account/key changes.
// Only a one-way digest is persisted; credentials remain in the encrypted vault.
function speechFingerprint(s: VoiceSettings, endpoint: SpeechEndpoint): string {
  return createHash("sha256").update(JSON.stringify([
    s.tts, endpoint.base, endpoint.key, s.ttsModel, s.ttsVoice, s.piperPath, s.piperModel,
  ])).digest("hex");
}
function speechCheck(s: VoiceSettings, endpoint: SpeechEndpoint): SpeechCheck | null {
  try {
    const saved = JSON.parse(configValue(PLUGIN, "speechCheck") ?? "null");
    if (saved?.fingerprint !== speechFingerprint(s, endpoint)) return null;
    return { at: saved.at, ok: saved.ok, error: saved.error, via: saved.via };
  } catch { return null; }
}

export async function speak(text: string, opts: { voice?: string } = {}): Promise<Speech> {
  const s = settings();
  if (s.tts === "off") throw new Error("Speech is off. Choose FreeLLMAPI, an OpenAI-compatible endpoint or Piper in Integrations → Voice.");
  const body = text.trim();
  if (!body) throw new Error("There is nothing to say.");
  mkdirSync(VOICE_DIR, { recursive: true });
  const endpoint = speechEndpoint(s);
  const voice = (opts.voice ?? "").trim();
  const fingerprint = speechFingerprint(s, endpoint);
  const record = (check: Omit<SpeechCheck, "at">) => {
    // A dialogue's alternative speaker must not overwrite the default voice's check.
    if (!voice || voice === s.ttsVoice)
      setConfig(PLUGIN, "speechCheck", JSON.stringify({ ...check, at: new Date().toISOString(), fingerprint }));
  };
  const started = Date.now();
  try {
    const result = s.tts === "piper" ? await speakPiper(body, s)
      : await speakOpenAI(body, voice ? { ...s, ttsVoice: voice } : s, endpoint);
    record({ ok: true, error: null, via: result.via });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : "Speech failed.";
    writeVoiceRun({ kind: "tts", ms: Date.now() - started, bytes: null, ok: false, error });
    record({ ok: false, error, via: null });
    throw err;
  }
}

/** Use the actual audio container: FreeLLMAPI may return WAV despite an MP3 request. */
function audioFormat(bytes: Buffer): "wav" | "ogg" | "mp3" {
  if (bytes.length > 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (bytes.length > 27 && bytes.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (bytes.length > 10 && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))) return "mp3";
  throw new Error("The speech endpoint returned empty or unsupported audio; expected MP3, WAV or Ogg.");
}

async function speakOpenAI(text: string, s: VoiceSettings, { base, key }: SpeechEndpoint): Promise<Speech> {
  if (!base) throw new Error(s.tts === "freellmapi"
    ? "FreeLLMAPI is not configured. Connect an account in Integrations → FreeLLMAPI."
    : "No speech endpoint is set. Set the voice integration's speech endpoint.");
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: s.ttsModel,
        ...(s.ttsVoice ? { voice: s.ttsVoice } : {}),
        input: text,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(err instanceof Error && err.name === "TimeoutError"
      ? "The speech endpoint did not answer within two minutes."
      : "Could not reach the speech endpoint.");
  }
  // Never persist an upstream response body, which could echo credentials or input.
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`The speech endpoint answered HTTP ${res.status}. Check the speech model and provider connection.`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const format = audioFormat(bytes);
  const ms = Date.now() - started;
  const id = randomUUID();
  writeFileSync(clipPath(id, format), bytes);
  writeVoiceRun({ kind: "tts", ms, bytes: bytes.length, ok: true });
  const provider = res.headers.get("x-provider");
  const via = s.tts === "freellmapi" ? `FreeLLMAPI${provider && /^[a-z0-9_-]{1,60}$/i.test(provider) ? ` · ${provider}` : ""}` : "openai";
  return { id, path: clipPath(id, format), bytes: bytes.length, ms, format, via };
}

/**
 * Piper, a binary on this machine reading text on stdin and writing a WAV.
 *
 * NOT INSTALLED HERE, and this path has therefore never run against a real
 * binary. It is written because the setting exists and half a feature is
 * worse than none: what it must not do is fail obscurely, so a missing binary
 * or model is refused by name before anything is spawned, and
 * `GET /api/voice` reports the same thing without waiting to be asked.
 */
async function speakPiper(text: string, s: VoiceSettings): Promise<Speech> {
  if (!s.piperPath || !existsSync(s.piperPath))
    throw new Error(
      s.piperPath
        ? `No piper binary at ${s.piperPath}.`
        : "No piper binary is configured. Set the voice plugin's `piperPath`.",
    );
  if (!s.piperModel || !existsSync(s.piperModel))
    throw new Error(
      s.piperModel
        ? `No piper voice model at ${s.piperModel}.`
        : "No piper voice is configured. Set the voice plugin's `piperModel` to a .onnx voice.",
    );
  const id = randomUUID();
  const out = clipPath(id, "wav");
  const started = Date.now();
  await run(s.piperPath, ["--model", s.piperModel, "--output_file", out], text);
  const bytes = existsSync(out) ? (await import("node:fs")).statSync(out).size : 0;
  const ms = Date.now() - started;
  if (!bytes) {
    throw new Error("piper wrote no audio.");
  }
  writeVoiceRun({ kind: "tts", ms, bytes, ok: true });
  return { id, path: out, bytes, ms, format: "wav", via: "piper" };
}

/* ------------------------------------------------------------------ ffmpeg */

/**
 * Where ffmpeg is, or null.
 *
 * Looked for in the three places a Mac or a Linux box puts it, and the answer
 * is cached for the life of the process because a binary does not appear
 * between two messages. `GET /api/voice` publishes it, so "why did my reply
 * arrive as a file attachment instead of a voice note" has an answer on the
 * page rather than in a log.
 */
const FFMPEG_CANDIDATES = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
let ffmpegCache: string | null | undefined;
export function ffmpegPath(): string | null {
  if (ffmpegCache !== undefined) return ffmpegCache;
  ffmpegCache = FFMPEG_CANDIDATES.find((p) => existsSync(p)) ?? null;
  return ffmpegCache;
}

/**
 * mp3 or wav → ogg/opus, which is the only container Telegram will play as a
 * VOICE NOTE. 48 kHz mono at 32 kbit is what a phone records and is
 * indistinguishable from anything higher for speech.
 */
export async function toOgg(input: string): Promise<{ path: string; bytes: number; ms: number }> {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error("ffmpeg is not on this machine, so nothing can be converted to ogg/opus.");
  const out = input.replace(/\.[^.]+$/, "") + ".ogg";
  const started = Date.now();
  try {
    await run(ffmpeg, ["-y", "-i", input, "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", out]);
  } catch (err) {
    const why = err instanceof Error ? err.message : "ffmpeg failed";
    writeVoiceRun({ kind: "ogg", ms: Date.now() - started, bytes: null, ok: false, error: why });
    throw new Error(why);
  }
  const { statSync } = await import("node:fs");
  const bytes = existsSync(out) ? statSync(out).size : 0;
  const ms = Date.now() - started;
  writeVoiceRun({ kind: "ogg", ms, bytes, ok: bytes > 0, error: bytes ? null : "ffmpeg wrote no file" });
  if (!bytes) throw new Error("ffmpeg wrote no file.");
  return { path: out, bytes, ms };
}

/** One child process, with its stderr kept for the error message and a wall
 *  clock so a wedged binary cannot hold a request open forever. */
function run(bin: string, args: string[], stdin?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stderr?.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-2_000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`${bin} could not be run: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited ${code}: ${err.trim().split("\n").at(-1) ?? ""}`.slice(0, 300)));
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}

/* ------------------------------------------------------------------ state */

export type VoiceState = {
  stt: { url: string | null; model: string; keyed: boolean; configured: boolean };
  tts: {
    mode: VoiceSettings["tts"];
    url: string | null;
    model: string;
    voice: string;
    keyed: boolean;
    ready: boolean;
    why: string | null;
    check: SpeechCheck | null;
  };
  ffmpeg: string | null;
  replyWithVoice: boolean;
};

/** What is set up and what is not, computed at read time and never cached —
 *  a setting changed a minute ago has to be true now. */
export function state(): VoiceState {
  const s = settings();
  const held = accounts.list(PLUGIN).flatMap((a) => accounts.entries(a.id));
  const hasStt = held.some((e) => e.field === "sttKey");
  const hasTts = held.some((e) => e.field === "ttsKey");

  const endpoint = speechEndpoint(s);
  let ready = false;
  let why: string | null = null;
  if (s.tts === "off") why = "Speech is off. Connect speech in Integrations → Voice.";
  else if (s.tts === "openai" || s.tts === "freellmapi") {
    ready = !!endpoint.base;
    why = ready ? null : s.tts === "freellmapi" ? "Connect a FreeLLMAPI account in Integrations." : "No speech endpoint is set.";
  } else {
    const bin = s.piperPath && existsSync(s.piperPath);
    const model = s.piperModel && existsSync(s.piperModel);
    ready = !!bin && !!model;
    why = ready ? null : !bin ? "no piper binary at `piperPath`" : "no piper voice at `piperModel`";
  }

  return {
    stt: {
      url: normaliseBase(s.sttUrl),
      model: s.sttModel,
      keyed: hasStt,
      configured: !!normaliseBase(s.sttUrl),
    },
    tts: { mode: s.tts, url: endpoint.base, model: s.ttsModel, voice: s.ttsVoice, keyed: s.tts === "freellmapi" ? !!endpoint.key : hasTts, ready, why, check: ready ? speechCheck(s, endpoint) : null },
    ffmpeg: ffmpegPath(),
    replyWithVoice: s.replyWithVoice,
  };
}

/** The probe the plugin's verify and its collector both run: a silent wav
 *  through the whole transcription path. */
export async function probe(
  key?: string | null,
): Promise<{ ok: boolean; ms: number; error: string | null }> {
  const started = Date.now();
  try {
    const wav = silentWav();
    const got = await transcribe(wav, "silence.wav", { reader: "voice_probe", ...(key === undefined ? {} : { key }) });
    writeVoiceRun({ kind: "probe", ms: got.ms, bytes: wav.length, ok: true });
    return { ok: true, ms: got.ms, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    writeVoiceRun({ kind: "probe", ms: Date.now() - started, bytes: null, ok: false, error });
    return { ok: false, ms: Date.now() - started, error };
  }
}

/** The plugin's own truth: connected means an STT endpoint is set. Whether it
 *  ANSWERS is what the probe says, and that is a different sentence. */
export const sttConfigured = () => !!normaliseBase(configValue(PLUGIN, "sttUrl") ?? "");
