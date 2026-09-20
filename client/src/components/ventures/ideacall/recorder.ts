/**
 * THE MICROPHONE, AS A RECORDING — the way of hearing that does not depend on
 * which browser this is.
 *
 * The browser's own speech recognition is a Chrome feature other browsers
 * carry in name: Edge ships the constructor and then fails it with a network
 * error, Firefox has none. A recording is universal — `getUserMedia` and
 * `MediaRecorder` are everywhere — and the box already has an ear
 * (POST /api/idea-call/listen, the voice integration's transcription model),
 * so the call records a turn, stops when the speaker does, and sends the clip.
 *
 * STOPPING IS LISTENED FOR, NOT TIMED. The level is sampled off an analyser:
 * the first third of a second sets the room's own noise floor, speech is
 * anything well above it, and a second and a half of quiet AFTER speech ends
 * the turn. Nothing said at all for eight seconds ends it empty. The mic
 * button stops it by hand either way.
 *
 * Framework-free and with no opinion about what happens to the clip.
 */
export type Recording = { blob: Blob; filename: string; heard: boolean };
export type Recorder = { done: Promise<Recording | null>; stop(): void; cancel(): void };

const QUIET_AFTER_SPEECH_MS = 1500;
const GIVE_UP_MS = 8000;
const MAX_MS = 60_000;
const TYPES: [string, string][] = [["audio/webm;codecs=opus", "webm"], ["audio/webm", "webm"], ["audio/mp4", "m4a"], ["audio/ogg;codecs=opus", "ogg"]];

/** Why a page cannot have the microphone, in the order worth checking. */
export function micBlocked(): "insecure" | "unsupported" | null {
  if (!window.isSecureContext) return "insecure";
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return "unsupported";
  return null;
}

/** Start recording. Rejects with the browser's own error when the mic is
 *  refused (`NotAllowedError`) or missing (`NotFoundError`). */
export async function startRecorder(onLevel?: (level: number) => void): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const [mime, ext] = TYPES.find(([type]) => MediaRecorder.isTypeSupported(type)) ?? ["", "webm"];
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 1024;
  audio.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  let heard = false, cancelled = false, floor = 0, floorSamples = 0, lastLoud = 0;
  const began = performance.now();
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    const level = Math.sqrt(sum / samples.length), now = performance.now();
    onLevel?.(level);
    if (now - began < 350) { floor += level; floorSamples++; if (level > 0.045) { heard = true; lastLoud = now; } return; }
    /* Capped, because the "room" is sometimes a person who started talking at
       once: a floor measured over speech would set a bar speech never clears. */
    const threshold = Math.min(0.045, Math.max(0.012, (floorSamples ? floor / floorSamples : 0) * 3));
    if (level > threshold) { heard = true; lastLoud = now; }
    if ((heard && now - lastLoud > QUIET_AFTER_SPEECH_MS) || (!heard && now - began > GIVE_UP_MS) || now - began > MAX_MS) stop();
  }, 60);

  function stop() { if (recorder.state !== "inactive") recorder.stop(); }
  const done = new Promise<Recording | null>(resolve => {
    recorder.onstop = () => {
      clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      void audio.close().catch(() => {});
      resolve(cancelled || !chunks.length ? null : { blob: new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" }), filename: `turn.${ext}`, heard });
    };
  });
  recorder.start(250);
  return { done, stop, cancel() { cancelled = true; stop(); } };
}
