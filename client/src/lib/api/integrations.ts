/**
 * VOICE, AND THE NAME THE INTEGRATION PANELS CALL EVERYTHING ELSE BY.
 *
 * This file used to be a second, hand-written client for the same ten report
 * routes `lib/api/reports.ts` already describes — 10 endpoints and 10
 * same-named types, transcribed twice from the same server. Both copies were
 * careful and both were maintained, and they had still drifted in three ways
 * that a reader of either one could not see:
 *
 *   - `verified.checked` was `number` here and `number | null` there, so one
 *     side invited a bare arithmetic on a figure the server declines to give;
 *   - `links[].fromDomain` was `string` here and `string | null` there, so a
 *     panel typed against this file rendered the word "null" as a domain;
 *   - `BacklinkSourceRow.source` widened to `string` here, so the `switch` a
 *     panel writes over it was exhaustive only when typed against the other.
 *
 * And the defaults disagreed on the SAME ROUTE — products 7 against 30,
 * bluesky 30 against 90, umami 30 against 90 — so one integration's card
 * quoted a different window on its panel than on the dashboard, with nothing
 * on either surface saying which span it was showing.
 *
 * `reports.ts` won because it is the stricter of the two everywhere they
 * differ: closed unions where this file had `| string`, `| null` where this
 * file had a bare number, and its default windows are the ones the server
 * itself uses when the query parameter is absent. It is now the only
 * description of those ten documents.
 *
 * WHAT IS ACTUALLY DECLARED HERE IS VOICE, which no other module describes,
 * and the venture-link calls are aliased through from `lib/api/ventures.ts`,
 * which owns them. Everything else below is a re-export, kept so that the ten
 * panels in `components/integrations/` can go on saying `integrations.umami()`
 * — the name that reads correctly standing in that directory.
 */
import { call } from "@/lib/api";
import { reports } from "@/lib/api/reports";
import { ventureApi } from "@/lib/api/ventures";

export * from "@/lib/api/reports";

/** The whole graph in one document. `LinkMap` is its name at home. */
export type { LinkMap as VentureMap } from "@/lib/api/ventures";

/* ------------------------------------------------------------------ voice */

export type VoiceReport = {
  /** An endpoint is SET. Whether it answers is what the probe says. */
  connected: boolean;
  state: {
    stt: { url: string | null; model: string; keyed: boolean; configured: boolean };
    tts: {
      mode: "off" | "openai" | "piper" | string;
      url: string | null;
      model: string;
      voice: string;
      keyed: boolean;
      ready: boolean;
      why: string | null;
    };
    /** The path ffmpeg was found at, or null — no voice note without it. */
    ffmpeg: string | null;
    replyWithVoice: boolean;
  };
  latency: {
    unit: string;
    transcriptionMedian: number | null;
    lastAt: string | null;
    lastMs: number | null;
  };
  counts: { kind: string; ok: number; failed: number; medianMs: number | null }[];
  runs: { ts: string; kind: string; ms: number | null; bytes: number | null; ok: boolean; error: string | null }[];
  notes: string[];
};

/** What `POST /api/voice/speak` answers. Never audio — a path and a url. */
export type SpokenClip = {
  id: string;
  path: string;
  url: string;
  format: "mp3" | "wav" | "ogg" | string;
  bytes: number;
  ms: number;
  via: string;
};

/* ------------------------------------------------------------------ calls */

export const integrations = {
  ...reports,

  voice: () => call<VoiceReport>("/voice"),

  /** Text in, a clip on this machine out. Refused with a sentence — 409 —
   *  when speech is off, which is the default. */
  speak: (text: string) =>
    call<SpokenClip>("/voice/speak", { method: "POST", body: JSON.stringify({ text }) }),

  /* The venture-link calls belong to `lib/api/ventures.ts` and are only named
     again here so a panel can reach them without a second import. They are the
     same functions, not second copies: the DELETE in particular used to be
     typed `{ ok: true }` on this side, which threw away the fresh link list
     the server answers with and left the only caller re-fetching a document it
     had already been handed. */
  ventureMap: ventureApi.map,
  linkVenture: ventureApi.link,
  unlinkVenture: ventureApi.unlink,
};
