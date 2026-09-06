/**
 * THE TWO THINGS A MODEL IS ASKED FOR HERE, AND WHY BOTH GO TO THE RAW
 * PROVIDER RATHER THAN TO AN AGENT.
 *
 * A faceless script and a set of highlight windows are both ONE ARTEFACT SAID
 * OUT LOUD — a short JSON object, nothing else — and executor.ts's header
 * records what happens when that kind of turn goes to an agent: asked for a
 * plan on 2026-09-05, the agent wrote it to /tmp/proposal.json and said it had
 * done so. A turn that wants a thing rather than a file goes to the thing that
 * only says things. It is also the honest choice for a script: there is nothing
 * here to look up, and an agent with a web search would go and read somebody
 * else's video about the subject.
 *
 * THE SCRIPT IS NOT A REPORT AND DOES NOT USE THE REPORT SHAPE. kinds.ts fixes
 * `## Findings / ## Evidence / ## Recommendations` for the six kinds that
 * produce a document; this produces a FILE, and the run's markdown is a note
 * about it. So the shape asked for here is a JSON object and the brief says so
 * in the first line rather than in the last.
 *
 * WHAT THE MODEL IS FORBIDDEN TO INVENT, and it is the same rule the studio
 * applies to a caption, for the same reason: this box knows a venture's name,
 * the sentence its owner wrote, its stage and its address, and it does not know
 * its pricing, its customer count or its launch date. A script that says "used
 * by 4,000 teams" is a claim the owner would then have to either delete or
 * make true.
 *
 * THE SEARCH TERMS ARE THE SECOND HALF OF EACH BEAT AND ARE ASKED FOR IN THE
 * SAME TURN. Two turns — write the script, then find footage words for it —
 * was tried first in the shape workdash uses, and it costs a round trip to
 * produce terms for a beat the model can no longer see. Asked together, a beat
 * about "the paperwork nobody reads" gets "stack of documents" and "tired
 * office worker" rather than the noun phrase from the caption, which is what a
 * separate pass tends to return.
 *
 * A TERM THAT IS AN ABSTRACT NOUN FINDS NOTHING, and that is stated in the
 * brief in those words, because it is the single failure mode of this step:
 * "regulatory uncertainty" has no stock footage and "planning application
 * paperwork" does. Every beat gets two to four terms so a miss on the first is
 * not a miss on the beat.
 */
import { complete } from "../../models/provider.ts";
import { fencedJson } from "../runs/kinds.ts";
import type { VentureRow } from "../../db.ts";

export type BeatRole = "hook" | "beat" | "cta";

export type Beat = {
  role: BeatRole;
  /** The words burned onto the frame. Short: this is read in a second and a
   *  half on a phone. */
  caption: string;
  /** What a narrator would say over it. Written even when speech is off,
   *  because it is also the best description of what the beat is FOR and it
   *  goes on the run page beside the caption. */
  voiceover: string;
  /** Two to four stock search terms, most specific first. */
  terms: string[];
  /** How long this beat holds. Set by this server rather than by the model —
   *  see `plan()`. */
  seconds: number;
};

export type Script = {
  title: string;
  beats: Beat[];
  /** What the model was told the video is about, kept so a report can show
   *  the brief the script answers. */
  brief: string;
};

/* ------------------------------------------------------------- the shape */

/** How long a beat holds by default. Under three seconds nobody finishes
 *  reading the caption; over six the footage starts to look like a
 *  screensaver. */
const BEAT_SECONDS = 5;
/** The end card. Long enough to read a name and an address, short enough that
 *  nobody scrolls past it. */
export const END_CARD_SECONDS = 3;

/** How many footage beats a video of this length wants, hook and CTA
 *  included. Clamped to 3–10: fewer is a slideshow of two pictures, more is
 *  a minute and a half of stock footage. */
export function beatCount(seconds: number): number {
  const usable = Math.max(6, seconds - END_CARD_SECONDS);
  return Math.max(3, Math.min(10, Math.round(usable / BEAT_SECONDS)));
}

/* --------------------------------------------------------------- the ask */

function ventureFacts(v: VentureRow): string[] {
  const out = [`Name: ${v.name}`, `Stage: ${v.stage}`];
  if (v.description) out.push(`What the owner says it is: ${v.description}`);
  if (v.website) out.push(`Address: ${v.website}`);
  return out;
}

/**
 * The script, in one turn.
 *
 * `count` IS THIS SERVER'S NUMBER AND NOT A SUGGESTION. The length of the
 * finished video is a thing the owner typed and the beat count follows from
 * it arithmetically; asking a model to "write about six beats" produces four
 * or nine and a video that is not the length that was asked for. So the count
 * is stated, and a reply with the wrong number of beats is trimmed or padded
 * by the caller rather than re-requested.
 */
export async function writeScript(opts: {
  venture: VentureRow;
  brief: string;
  seconds: number;
  signal?: AbortSignal;
}): Promise<{ script: Script; model: string | null; raw: string }> {
  const count = beatCount(opts.seconds);
  const middle = Math.max(1, count - 2);

  const system = [
    `You write short vertical videos — the kind that plays with the sound off, one line of text on the screen at a time over stock footage. You are writing one for a small software business, from a dashboard that holds what is actually known about it.`,
    ``,
    `ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE. No preamble, no explanation, no markdown around it. The object is:`,
    ``,
    `{`,
    `  "title": "a short name for this video, for a file list",`,
    `  "hook": { "caption": "…", "voiceover": "…", "terms": ["…", "…"] },`,
    `  "beats": [ { "caption": "…", "voiceover": "…", "terms": ["…", "…"] } ],`,
    `  "cta": { "caption": "…", "voiceover": "…", "terms": ["…", "…"] }`,
    `}`,
    ``,
    `EXACTLY ${middle} entries in "beats" — not more and not fewer. With the hook and the CTA that is ${count} shots, which is the length this video was asked to be.`,
    ``,
    `THE RULES, all binding:`,
    `- "caption" is what is BURNED ONTO THE SCREEN. At most nine words. It is read in a second and a half on a phone held at arm's length, so it is a sentence a person says, not a heading. No emoji, no hashtags, no quotation marks, no line breaks.`,
    `- "voiceover" is what a narrator would say over that shot. One or two sentences. It carries the argument; the caption is the part somebody reads.`,
    `- "terms" is two to four STOCK FOOTAGE SEARCH TERMS for that shot, most specific first. A stock library has footage of THINGS AND PEOPLE DOING THINGS. It has none of abstract nouns: "regulatory uncertainty", "scalability", "customer trust" return nothing. Write what the camera would see — "stack of paper documents", "tired office worker at night", "hands typing on laptop". One to three words each, English.`,
    `- The HOOK is the first shot and it has one job: stop the scroll. A question, a number, or a plain statement of the problem. Never "in this video" and never a greeting.`,
    `- The CTA is the last shot before the end card. It asks for one specific thing — visit the site, try it free, reply — and it names the business.`,
    `- NEVER INVENT A FACT ABOUT THIS BUSINESS. You are told its name, the sentence its owner wrote, its stage and its address. You are NOT told its pricing, its customer count, its funding, its launch date or its reviews, and you must not write any of those. A number you were not given is a claim the owner would have to go and make true.`,
    `- A business at stage "idea" or "pre-launch" has no customers and no results. Do not write a script that implies it has either.`,
    `- Plain words. No "unlock", no "revolutionise", no "game-changer", no "in today's fast-paced world".`,
  ].join("\n");

  const user = [
    `THE BUSINESS`,
    ...ventureFacts(opts.venture),
    ``,
    `WHAT THIS VIDEO IS ABOUT`,
    opts.brief.trim() || `Nothing in particular was singled out — make the case for ${opts.venture.name} to somebody who has never heard of it.`,
    ``,
    `Write the JSON object now.`,
  ].join("\n");

  const reply = await complete([{ role: "system", content: system }, { role: "user", content: user }], {
    signal: opts.signal,
  });

  const parsed = readScript(reply.text, opts.brief, count, opts.seconds);
  if (!parsed)
    throw new Error(
      "The model did not answer with a script this server could read. It was asked for one JSON object with a hook, beats and a CTA; what came back is in the run's report.",
    );
  return { script: parsed, model: reply.model, raw: reply.text };
}

/** A string field, trimmed and capped. Empty becomes null so the caller can
 *  tell "not written" from "written empty". */
const str = (v: unknown, cap: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, cap) : null;
};

function readBeat(raw: unknown, role: BeatRole): Beat | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const caption = str(o.caption, 160);
  if (!caption) return null;
  const terms = Array.isArray(o.terms)
    ? o.terms.map((t) => str(t, 60)).filter((t): t is string => !!t).slice(0, 4)
    : [];
  return {
    role,
    caption,
    voiceover: str(o.voiceover, 600) ?? caption,
    /* A beat with no terms is not refused: the caption's own words are a
       worse search term than a chosen one and are better than nothing, and
       refusing the whole script over one missing array would throw away six
       good beats. */
    terms: terms.length ? terms : [caption.split(/\s+/).slice(0, 3).join(" ")],
    seconds: 0,
  };
}

/**
 * The reply, read.
 *
 * TOLERANT ABOUT THE WRAPPER AND STRICT ABOUT THE CONTENTS, which is
 * `fencedJson`'s rule applied one level up: a model that fenced its JSON, or
 * put a sentence in front of it, has still answered, and that is recovered.
 * A model that answered with beats that have no captions has not answered, and
 * that is a failure with the raw text kept.
 */
export function readScript(text: string, brief: string, count: number, seconds: number): Script | null {
  const candidates: unknown[] = [];
  const fenced = fencedJson(text, "script");
  if (fenced) candidates.push(fenced);
  /* The bare object, which is what the brief actually asked for. Bounded by
     the outermost braces so a sentence before or after it does not matter. */
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      candidates.push(JSON.parse(text.slice(first, last + 1)) as unknown);
    } catch {
      /* Not JSON. The fenced candidate above may still be. */
    }
  }

  for (const c of candidates) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const o = c as Record<string, unknown>;
    const hook = readBeat(o.hook, "hook");
    const cta = readBeat(o.cta, "cta");
    const middle = Array.isArray(o.beats)
      ? o.beats.map((b) => readBeat(b, "beat")).filter((b): b is Beat => !!b)
      : [];
    if (!hook && !middle.length) continue;

    /* TRIMMED TO THE COUNT THIS SERVER ASKED FOR rather than rejected for
       missing it. A model that wrote seven beats when six were asked for has
       written a good script and one beat too many; the video is the length the
       owner typed, so the tail goes. */
    const wanted = Math.max(1, count - (hook ? 1 : 0) - (cta ? 1 : 0));
    const beats = [
      ...(hook ? [hook] : []),
      ...middle.slice(0, wanted),
      ...(cta ? [cta] : []),
    ];
    if (!beats.length) continue;

    /* THE LENGTH IS SHARED OUT BY THIS SERVER AND NOT BY THE MODEL. Every beat
       gets an equal share of what is left after the end card, floored at two
       seconds — which is the point at which a caption stops being readable. */
    const each = Math.max(2, (Math.max(6, seconds - END_CARD_SECONDS)) / beats.length);
    for (const b of beats) b.seconds = Math.round(each * 100) / 100;

    return { title: str(o.title, 120) ?? beats[0]!.caption, beats, brief };
  }
  return null;
}

/* ------------------------------------------------------- highlight windows */

export type Window = {
  title: string;
  reason: string;
  start: number;
  end: number;
};

/**
 * Two to four windows out of a long video, chosen from what was said in it.
 *
 * THE TRANSCRIPT IS THE WHOLE INPUT AND THE ABSENCE OF ONE IS FATAL TO THIS
 * FUNCTION, deliberately. A model asked to pick the best moments of a video it
 * has not seen and has no transcript of will pick some, confidently, and they
 * will be arbitrary. The caller handles the no-transcript case by cutting at
 * even intervals and RECORDING THAT IT DID — see `chosen_by` on video_clips —
 * rather than by asking anyway and presenting the answer as a choice.
 */
export async function pickWindows(opts: {
  transcript: string;
  duration: number;
  want: number;
  maxSeconds: number;
  brief: string;
  signal?: AbortSignal;
}): Promise<{ windows: Window[]; model: string | null; raw: string }> {
  const system = [
    `You are choosing the moments of a long video that would work on their own as a short vertical clip.`,
    ``,
    `ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE:`,
    ``,
    `{ "clips": [ { "title": "…", "reason": "…", "start": 0, "end": 0 } ] }`,
    ``,
    `RULES:`,
    `- Between 2 and ${opts.want} clips. Fewer good ones beats more weak ones.`,
    `- "start" and "end" are SECONDS from the beginning of the video, as numbers. They must fall inside 0 and ${Math.floor(opts.duration)}.`,
    `- Each clip is between 15 and ${opts.maxSeconds} seconds long. Under fifteen seconds there is no room for a point to be made.`,
    `- A clip must START AT THE BEGINNING OF A THOUGHT and end at the end of one. A clip that opens mid-sentence is unusable however good the middle of it is.`,
    `- Clips must not overlap.`,
    `- "title" is what the clip is about, at most eight words.`,
    `- "reason" is why this window and not another one — quote the thing that was actually said. It is not a prediction of how the clip will perform: you have no way to know that and neither does the person reading this.`,
    `- Choose from what is IN THE TRANSCRIPT. Do not describe anything visual, because you have not seen the video.`,
  ].join("\n");

  const user = [
    `The video is ${Math.floor(opts.duration)} seconds long.`,
    opts.brief.trim() ? `The owner asked for: ${opts.brief.trim()}` : `Nothing in particular was asked for.`,
    ``,
    `TRANSCRIPT, with the time each line starts:`,
    opts.transcript,
    ``,
    `Choose the clips now.`,
  ].join("\n");

  const reply = await complete([{ role: "system", content: system }, { role: "user", content: user }], {
    signal: opts.signal,
  });
  return { windows: readWindows(reply.text, opts.duration, opts.maxSeconds, opts.want), model: reply.model, raw: reply.text };
}

export function readWindows(text: string, duration: number, maxSeconds: number, want: number): Window[] {
  const candidates: unknown[] = [];
  const fenced = fencedJson(text, "clips");
  if (fenced) candidates.push(fenced);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      candidates.push(JSON.parse(text.slice(first, last + 1)) as unknown);
    } catch {
      /* Not JSON. */
    }
  }

  for (const c of candidates) {
    const list = Array.isArray(c) ? c : Array.isArray((c as { clips?: unknown })?.clips) ? ((c as { clips: unknown[] }).clips) : null;
    if (!list) continue;
    const out: Window[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const o = raw as Record<string, unknown>;
      const start = seconds(o.start);
      const end = seconds(o.end);
      if (start === null || end === null) continue;
      /* CLAMPED HERE AND NOT TRUSTED. A window past the end of the file
         produces an empty clip that ffmpeg writes happily; a window longer
         than the cap is the model ignoring an instruction. Both are fixed
         rather than refused, because the choice of WHERE is the valuable part
         and it survives the clamp. */
      const s = Math.max(0, Math.min(start, Math.max(0, duration - 5)));
      const e = Math.max(s + 5, Math.min(end, Math.min(duration, s + maxSeconds)));
      if (e - s < 5) continue;
      if (out.some((w) => s < w.end && e > w.start)) continue;
      out.push({
        title: str(o.title, 120) ?? `Clip at ${Math.round(s)}s`,
        reason: str(o.reason, 600) ?? "",
        start: Math.round(s * 100) / 100,
        end: Math.round(e * 100) / 100,
      });
      if (out.length >= want) break;
    }
    if (out.length) return out.sort((a, b) => a.start - b.start);
  }
  return [];
}

/** A time the model may have written as a number, as "90", or as "1:30". */
function seconds(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
