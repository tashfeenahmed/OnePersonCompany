/**
 * THE VOICE HALF OF THE TELEGRAM BRIDGE — everything except the four lines
 * inside `handleUpdate` that call it.
 *
 * WHY IT IS HERE AND NOT THERE. `telegram/bridge.ts` is one of the shared
 * files the integration seam exists to keep out of, and a voice note is not
 * an idea that file should have to hold: it decides whose chat an update came
 * from and what to say back. What it is missing is TEXT, and this file's
 * whole contract is to turn a voice note into some. So the bridge gains one
 * conditional and one call; every byte of audio, every endpoint and every
 * failure sentence lives in this area.
 *
 * THE THREE TELEGRAM CALLS ARE MADE HERE RATHER THAN IN providers/telegram.ts
 * for the same reason: that provider exports `send`, `typing`, `getMe` and
 * `getUpdates` and keeps its `call` helper private, and widening it would be
 * a fifth area editing a shared file. `getFile`, `sendVoice` and `sendAudio`
 * are three requests against the same documented API, with the same token
 * scrubbing on the way out.
 *
 * A TOKEN NEVER APPEARS IN AN ERROR. The file download url carries the bot
 * token in its PATH — that is Telegram's design, not a choice made here — so
 * every message this file produces goes through `scrub` before it can be
 * stored on a run row or sent to a chat.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { scrub, type TelegramUpdate } from "../../../providers/telegram.ts";
import { MAX_AUDIO_BYTES, ffmpegPath, settings, speak, toOgg, transcribe } from "./provider.ts";

const API = "https://api.telegram.org";
const TIMEOUT_MS = 60_000;

/** The fields of a message this file reads. Telegram sends a great deal more
 *  and `TelegramUpdate` deliberately describes only what the bridge uses, so
 *  the two audio shapes are named here rather than widening that type. */
type AudioMessage = {
  voice?: { file_id?: string; duration?: number; file_size?: number; mime_type?: string };
  audio?: { file_id?: string; duration?: number; file_size?: number; mime_type?: string };
  video_note?: { file_id?: string };
};

/**
 * Does a spoken answer go back?
 *
 * Read on every message rather than cached, for the same reason the bridge
 * reads the live agent on every message: a setting changed a minute ago has
 * to be true now, and a bot that acts on yesterday's configuration is worse
 * than one that asks twice. Both halves must be true — the owner asked for
 * it, and there is something that can speak.
 */
export function shouldSpeakBack(): boolean {
  const s = settings();
  return s.replyWithVoice && s.tts !== "off";
}

export type Heard =
  /** The words, ready to go through the same path a typed message takes. */
  | { kind: "text"; text: string; ms: number; seconds: number | null }
  /** Something to say to the owner instead. Never silence: a bot that says
   *  nothing is indistinguishable from a bot that is down, and the owner is
   *  holding a phone with no logs on it. */
  | { kind: "say"; text: string };

/**
 * A voice note, transcribed — or null when this message has no audio at all,
 * which is the bridge's cue to say what it always said.
 *
 * A VIDEO NOTE IS REFUSED BY NAME rather than attempted. Telegram's round
 * video messages carry audio, and pulling it out means a video decode this
 * file has no business doing; saying so is better than an obscure failure
 * from a transcription endpoint handed an mp4.
 */
export async function hearVoice(
  message: NonNullable<TelegramUpdate["message"]>,
  token: string,
): Promise<Heard | null> {
  const audio = message as unknown as AudioMessage;
  const file = audio.voice ?? audio.audio;

  if (!file?.file_id) {
    if (audio.video_note)
      return {
        kind: "say",
        text: "That is a video note. I can hear a voice note or an audio file — send one of those and I will read it.",
      };
    return null;
  }

  const s = settings();
  if (!s.sttUrl.trim())
    return {
      kind: "say",
      text:
        "I heard a voice note, but no transcription endpoint is set up yet. " +
        "Connect the Voice integration on the dashboard — it takes an " +
        "OpenAI-compatible /v1 url, and a local whisper server needs no key.",
    };

  if (file.file_size && file.file_size > MAX_AUDIO_BYTES)
    return {
      kind: "say",
      text: `That recording is ${Math.round(file.file_size / 1024 / 1024)} MB. Telegram's bot API caps a download at 20 MB.`,
    };

  let bytes: Uint8Array;
  let name: string;
  try {
    const got = await download(token, file.file_id);
    bytes = got.bytes;
    name = got.name;
  } catch (err) {
    return {
      kind: "say",
      text: `I could not download that recording: ${scrub(err instanceof Error ? err.message : "unknown error", token)}`,
    };
  }

  try {
    const transcript = await transcribe(bytes, name, { reader: "telegram_voice" });
    if (!transcript.text)
      return {
        kind: "say",
        text: "That recording came back empty — the transcriber heard nothing in it.",
      };
    return {
      kind: "text",
      text: transcript.text,
      ms: transcript.ms,
      seconds: typeof file.duration === "number" ? file.duration : null,
    };
  } catch (err) {
    return {
      kind: "say",
      text: `I could not transcribe that: ${scrub(err instanceof Error ? err.message : "unknown error", token)}`,
    };
  }
}

/**
 * The agent's answer, spoken back — best effort, and its failure is never the
 * owner's problem.
 *
 * THE TEXT HAS ALREADY BEEN SENT by the time this runs. That order is the
 * design: the words are the answer and the voice note is a convenience, so a
 * TTS endpoint that is down, out of credit or slow costs a nicety rather than
 * the reply. This returns what happened so the caller can log it, and throws
 * nothing at all.
 *
 * OGG/OPUS OR AN ATTACHMENT. Telegram plays a voice note inline only when it
 * is ogg/opus; without ffmpeg the same audio goes as `sendAudio`, which
 * arrives as a file. That is a worse experience and a real one, so it happens
 * rather than being suppressed — and the note says which it was.
 */
export async function speakBack(
  token: string,
  chatId: string,
  text: string,
): Promise<{ sent: boolean; as: "voice" | "audio" | null; note: string }> {
  // Telegram's caption and file limits aside, a five-minute synthesised
  // monologue is not something anybody wants pushed to their phone. The
  // spoken form is the opening of a long answer; the text above it is whole.
  const body = text.length > 1_200 ? `${text.slice(0, 1_200).trimEnd()}…` : text;

  let clip: { path: string; format: string } | null = null;
  let ogg: string | null = null;
  try {
    const spoken = await speak(body);
    clip = { path: spoken.path, format: spoken.format };

    let path = spoken.path;
    let as: "voice" | "audio" = "audio";
    let note = `sent as an audio file: ${ffmpegPath() ? "conversion refused" : "ffmpeg is not on this machine"}`;

    if (ffmpegPath()) {
      try {
        const converted = await toOgg(spoken.path);
        ogg = converted.path;
        path = converted.path;
        as = "voice";
        note = `sent as a voice note (${converted.bytes} bytes of ogg/opus)`;
      } catch (err) {
        note = `sent as an audio file: ${err instanceof Error ? err.message : "conversion failed"}`;
      }
    }

    await upload(token, chatId, path, as);
    return { sent: true, as, note };
  } catch (err) {
    return {
      sent: false,
      as: null,
      note: scrub(err instanceof Error ? err.message : "speech failed", token),
    };
  } finally {
    /* The audio is a message that has been delivered, not a document. Both
       files go: keeping them would turn DATA_DIR into a recording of every
       answer the agent has ever given. */
    for (const path of [ogg, clip?.path]) {
      if (!path) continue;
      try {
        unlinkSync(path);
      } catch {
        /* already gone, or never written */
      }
    }
  }
}

/* ---------------------------------------------------------- the three calls */

/** `getFile` then the file itself. Telegram's download url carries the token
 *  in its path, which is why nothing here ever puts a url in an error. */
async function download(token: string, fileId: string): Promise<{ bytes: Uint8Array; name: string }> {
  const meta = await call<{ file_path?: string; file_size?: number }>(token, "getFile", {
    file_id: fileId,
  });
  const path = meta.file_path;
  if (!path) throw new Error("Telegram named no file to download.");
  if (meta.file_size && meta.file_size > MAX_AUDIO_BYTES)
    throw new Error(`that file is ${Math.round(meta.file_size / 1024 / 1024)} MB and the cap is 20 MB`);

  const res = await fetch(`${API}/file/bot${token}/${path}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Telegram answered HTTP ${res.status} for the file.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("that file is over the 20 MB cap");
  // The extension is what tells a transcription endpoint what it is holding;
  // Telegram's own path carries it (`voice/file_123.oga`).
  return { bytes, name: path.split("/").pop() || "voice.oga" };
}

/** One JSON call, in the same envelope shape providers/telegram.ts documents:
 *  `ok` with a `result`, or `ok: false` with a `description` worth showing. */
async function call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      err instanceof Error && err.name === "TimeoutError"
        ? `Telegram did not answer ${method} in time.`
        : `Could not reach Telegram (${err instanceof Error ? err.name : "network error"}).`,
    );
  }
  const envelope = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: T; description?: string }
    | null;
  if (!envelope?.ok)
    throw new Error(envelope?.description ?? `Telegram answered HTTP ${res.status}.`);
  return envelope.result as T;
}

/** `sendVoice` or `sendAudio`, as multipart. Built with FormData rather than
 *  by hand: Node 24 has it, and a hand-rolled boundary is a bug waiting for a
 *  file whose bytes happen to contain it. */
async function upload(token: string, chatId: string, path: string, as: "voice" | "audio") {
  const form = new FormData();
  form.append("chat_id", chatId);
  const bytes = readFileSync(path);
  const name = path.split("/").pop() ?? (as === "voice" ? "reply.ogg" : "reply.mp3");
  form.append(as, new Blob([bytes]), name);

  const res = await fetch(`${API}/bot${token}/${as === "voice" ? "sendVoice" : "sendAudio"}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const envelope = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!envelope?.ok) throw new Error(envelope?.description ?? `Telegram answered HTTP ${res.status}.`);
}
