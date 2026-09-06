/**
 * VOICE, AND THE NAME THE INTEGRATION PANELS CALL EVERYTHING ELSE BY.
 *
 * DO NOT DESCRIBE A REPORT ROUTE HERE. `lib/api/reports.ts` is the only
 * description of those ten documents, and a second transcription of the same
 * server is not caught by anything: two careful, maintained copies still drift
 * into a `number` against a `number | null` (inviting arithmetic on a figure
 * the server declines to give), a `string` against a `string | null` (a panel
 * rendering the word "null" as a domain), a widened union (a `switch` that is
 * exhaustive against only one of them) — and into different DEFAULT WINDOWS on
 * one route, so a card quotes 7 days on its panel and 30 on the dashboard with
 * neither surface saying which. `reports.ts` is the stricter side everywhere:
 * closed unions, `| null` where a figure can be absent, and default windows
 * that are the server's own when the query parameter is missing.
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
     SAME FUNCTIONS, not re-typed ones — the DELETE answers with the fresh link
     list, and a local `{ ok: true }` would throw that away and leave the only
     caller re-fetching a document it had already been handed. */
  ventureMap: ventureApi.map,
  linkVenture: ventureApi.link,
  unlinkVenture: ventureApi.unlink,
};
