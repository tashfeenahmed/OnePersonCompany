/**
 * Voice, "collected" — which here means PROVED, once every couple of hours.
 *
 * There is nothing to gather. What this integration has instead of a series
 * is a QUESTION: would a voice note sent to the bot right now come back as
 * words? The honest way to answer it is the way the plugin's verify answers
 * it — post half a second of silence and see whether JSON with a `text` field
 * comes back — so that is what a collection is, and its result lands on the
 * plugin page as a run row like every other integration's.
 *
 * A SLOW CLOCK, because the probe costs a request to somebody's endpoint (and
 * on a hosted one, a fraction of a cent) to learn something that changes only
 * when a machine goes down. Two hours is twelve proofs a day; the owner's own
 * voice notes exercise the same path far more often, and each of those writes
 * its own row.
 *
 * CONNECTED MEANS AN ENDPOINT IS SET, not that it answered — npm's rule, one
 * layer along. A whisper server that is off at four in the morning has not
 * had its credential withdrawn, and un-connecting the plugin would stop the
 * scheduler ever asking again.
 */
import { db, finishRun, startRun, upsertPlugin } from "../../../db.ts";
import type { CollectResult } from "../../manifest.ts";
import { PLUGIN, probe, sttConfigured, state } from "./provider.ts";

export const EVERY_HOURS = 2;

export type VoiceSummary = CollectResult & { runId: number; ms: number | null };

export async function collectVoice(): Promise<VoiceSummary> {
  const runId = startRun(PLUGIN);

  if (!sttConfigured()) {
    const error =
      "No transcription endpoint is set. Voice needs an OpenAI-compatible " +
      "`sttUrl` — a local whisper server needs no key at all.";
    finishRun(runId, false, undefined, error);
    upsertPlugin(PLUGIN, false, error);
    return { ok: false, runId, ms: null, error };
  }

  const last = db
    .prepare("SELECT MAX(ts) AS ts FROM voice_runs WHERE kind = 'probe' AND ok = 1")
    .get() as { ts: string | null } | undefined;
  if (last?.ts && Date.now() - Date.parse(last.ts) < EVERY_HOURS * 3_600_000) {
    const note = `fresh — the endpoint answered inside the last ${EVERY_HOURS}h`;
    finishRun(runId, true, note);
    upsertPlugin(PLUGIN, true, null);
    return { ok: true, runId, ms: null, note };
  }

  const got = await probe();
  const s = state();
  const tts = s.tts.mode === "off" ? "speech off" : s.tts.ready ? `speech via ${s.tts.mode}` : `speech ${s.tts.mode}: ${s.tts.why}`;
  const note = got.ok
    ? `the transcription endpoint answered a silent probe in ${got.ms} ms · ${tts}` +
      (s.ffmpeg ? "" : " · no ffmpeg, so a spoken reply goes as a file rather than a voice note")
    : undefined;

  finishRun(runId, got.ok, note, got.error ?? undefined);
  // Connected either way: the endpoint is configured, and a bad minute is not
  // a withdrawal. The error rides on the plugin row so the page can say it.
  upsertPlugin(PLUGIN, true, got.error);
  return { ok: got.ok, runId, ms: got.ms, note: note ?? null, error: got.error };
}
