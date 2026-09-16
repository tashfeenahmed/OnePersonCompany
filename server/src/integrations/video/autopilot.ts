/**
 * THE AUTOPILOT — once a day, at an hour the owner chose, queue the work
 * nobody got round to.
 *
 * WHAT IT DOES AND, MUCH MORE IMPORTANTLY, WHAT IT DOES NOT. It queues two
 * kinds of thing: a Studio post for a venture, and a video run for a venture.
 * Finished assets are filed as Publishing drafts. Autopilot does not approve
 * or publish them; the owner reviews each item in Publishing.
 *
 * OFF UNTIL IT IS TURNED ON, like the nightly backup and for the same reason:
 * this uses the owner's generation providers and media quota, and a
 * process that started doing that at nine in the morning because a default
 * said so would be a surprise somebody pays for.
 *
 * THREE BRAKES, AND EACH ONE IS THERE BECAUSE OF A DIFFERENT FAILURE:
 *
 *   the cadence   Posts and videos per venture per WEEK, counted over a
 *                 rolling seven days rather than a calendar one. A calendar
 *                 week means a portfolio of nineteen ventures produces
 *                 nineteen videos every Monday morning and nothing on Friday;
 *                 rolling means the work spreads itself.
 *   the day cap   A ceiling on how many things one pass may queue at all,
 *                 across every venture. Without it, switching this on with
 *                 nineteen ventures and a cadence of two would queue
 *                 thirty-eight pieces of work in one second, and the run queue
 *                 is a SINGLE SLOT — that is two days of solid encoding
 *                 nobody asked for.
 *   the queue     If the run queue already has work waiting, videos are not
 *                 added to it. The slot is shared with everything the owner
 *                 starts by hand, and an autopilot that pushed a research run
 *                 six hours down the line would be the autopilot's fault.
 *
 * EVERY DECISION IS LOGGED, INCLUDING THE DECISIONS TO DO NOTHING. See the
 * migration: a log that only held successes answers "why was there no video
 * this week" with silence, and silence sends somebody looking for a bug in a
 * feature that is doing exactly what it was told.
 *
 * THE TOPIC IS GATED BEFORE IT IS PAID FOR, added 2026-09-06. A derived topic
 * now goes through integrations/socialfeed/novelty.ts BEFORE any Studio call
 * or any run is queued: a topic whose normalised fingerprint was already used
 * for this venture and this format inside the novelty window is REFUSED, the
 * refusal is logged as a skip with the clash quoted, and nothing is spent. The
 * "recent briefs in the prompt" trick below is still there and is still worth
 * having — it makes a good topic more likely — but an instruction to a model
 * is not a constraint, and the gate is the constraint.
 *
 * A `shorts` JOB NEEDS A SOURCE URL, AND THE AUTOPILOT CAN FIND ONE.
 * integrations/socialfeed/sourcing.ts searches the
 * owner's own SearXNG node's video category, ranks what comes back by duration,
 * recency and engine agreement, refuses anything already cut up, and hands back
 * one URL. With no SearXNG connected there is no source and the pass logs a
 * skip that says so.
 *
 * THE TOPIC IS DERIVED, NOT TYPED. A brief for a post or a video comes from
 * the venture record and from what this box has recently run and made for it,
 * put to the model as one question. With no model provider there is no topic,
 * and then the pass logs a skip that says so rather than making something up
 * from the venture's name.
 */
import { randomUUID } from "node:crypto";
import { nextZonedTime } from "../../../../shared/zonedTime.ts";
import { configValue, db, now, ventureRows, type VentureRow } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { createPost } from "../ventures/studio.ts";
import { queuedCount, runningRow } from "../runs/store.ts";
import { dispatch, type DispatchBody } from "../subagents/routes.ts";
import { ensureTeam, subagentId, subagentRow } from "../subagents/store.ts";
/* THE ONE LINE THAT CONNECTS THIS TO PUBLISHING, added 2026-09-06. A finished
   post is filed into the publishing queue AS A DRAFT — see
   integrations/publishing/autopilot-hook.ts, which explains why the strongest
   thing a setting there can do is propose a date. The claim in this file's
   header stands: nothing here publishes anything anywhere. */
import { onAutopilotAsset } from "../publishing/autopilot-hook.ts";
import { ownerZone } from "../publishing/settings.ts";
/* THE TWO LINES THAT CONNECT THIS TO SOURCING AND NOVELTY, added 2026-09-06 by
   the socialfeed area. Both are ordinary static imports of modules that reach
   nothing but db.ts and the providers — neither closes a manifest cycle, and
   the delivery half, which DOES reach the telegram bridge, is a timer in that
   area rather than a call from here. */
import { checkTopic, historyRows, remember } from "../socialfeed/novelty.ts";
import { findSource } from "../socialfeed/sourcing.ts";

export const AUTOPILOT_PLUGIN = "autopilot";
export const AUTOPILOT_FORMATS = ["faceless", "shorts", "motion", "stewie", "ugc"] as const;

/** The session id every autopilot dispatch is filed under, so a run it started
 *  is distinguishable in the ledger from one the owner asked for in a chat.
 *  It is not a real conversation and nothing streams into it — see
 *  `childrenBySession`, which will simply never be asked about this key. */
export const AUTOPILOT_SESSION = "autopilot";

export const DEFAULT_HOUR = 9;
export const DEFAULT_CAP = 4;
/** Off. Both cadences default to zero, so switching the autopilot on without
 *  setting a cadence does nothing at all and says so — which is better than a
 *  default that starts spending money the moment the switch is flipped. */
export const DEFAULT_POSTS = 0;
export const DEFAULT_VIDEOS = 0;
/** Stages that are skipped unless the owner says otherwise. An idea has no
 *  product to make a video about, and a video for one would be a video full of
 *  claims nobody can stand behind. */
export const DEFAULT_QUIET = "idea";

/* ------------------------------------------------------------- settings */

export type Schedule = {
  enabled: boolean;
  posts: number;
  videos: number;
  hour: number;
  timezone: string;
  /** Stage names, lower case. A venture at one of these is skipped. */
  quiet: string[];
  /** Rotate through these formats per venture, within the existing cadence. */
  formats: string[];
  cap: number;
};

const num = (key: string, fallback: number, lo: number, hi: number) => {
  const raw = (configValue(AUTOPILOT_PLUGIN, key) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

const list = (key: string, fallback: string) =>
  ((configValue(AUTOPILOT_PLUGIN, key) ?? "").trim() || fallback)
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** The machine's own zone, which is what a laptop's owner means by "nine in
 *  the morning" until they say otherwise. */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function schedule(): Schedule {
  return {
    enabled: (configValue(AUTOPILOT_PLUGIN, "enabled") ?? "").trim().toLowerCase() === "on",
    posts: num("posts", DEFAULT_POSTS, 0, 21),
    videos: num("videos", DEFAULT_VIDEOS, 0, 14),
    hour: num("hour", DEFAULT_HOUR, 0, 23),
    timezone: ownerZone(),
    quiet: list("quiet", DEFAULT_QUIET),
    formats: [...new Set(list("formats", "faceless").filter(f => (AUTOPILOT_FORMATS as readonly string[]).includes(f)))],
    cap: num("cap", DEFAULT_CAP, 1, 50),
  };
}

/* ------------------------------------------------------------ the clock */

/** The local wall clock in a named zone, as numbers. Intl is the only thing
 *  on this box that knows about zones and daylight saving; deriving an offset
 *  by hand would be wrong twice a year. */
export function wall(tz: string, at: Date = new Date()): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

/**
 * When the next pass would be, as an instant.
 *
 * WALKED FORWARD A MINUTE AT A TIME RATHER THAN COMPUTED. Turning "09:00 next
 * Tuesday in Europe/Dublin" into a UTC instant by arithmetic means handling
 * the two nights a year where the local hour happens twice or not at all, and
 * getting that wrong is a schedule that silently skips a day in March. Walking
 * forward and asking Intl what the local hour is at each step cannot be wrong
 * about a transition it does not have to model. Up to forty-eight hours, including fractional UTC offsets.
 */
export function nextRunAt(s: Schedule, from: Date = new Date()): string | null {
  if (!s.enabled) return null;
  const today = wall(s.timezone, from);
  const done = lastPassDay();
  if (today.hour === s.hour && today.day !== done) return from.toISOString();
  let next = nextZonedTime(s.timezone, s.hour, 0, from);
  if (wall(s.timezone, new Date(next)).day === done) next = nextZonedTime(s.timezone, s.hour, 0, new Date(next));
  return next;
}

/* ---------------------------------------------------------------- the log */

export type LogRow = {
  id: number;
  ts: string;
  pass_id: string;
  venture_id: string | null;
  kind: string;
  action: string;
  ref: string | null;
  note: string | null;
};

function log(entry: {
  passId: string;
  ventureId: string | null;
  kind: "post" | "video" | "pass";
  action: "queued" | "skipped" | "failed";
  ref?: string | null;
  note?: string | null;
}) {
  db.prepare(
    "INSERT INTO video_autopilot_log (ts, pass_id, venture_id, kind, action, ref, note) VALUES (?,?,?,?,?,?,?)",
  ).run(now(), entry.passId, entry.ventureId, entry.kind, entry.action, entry.ref ?? null, entry.note ?? null);
}

export function logRows(limit = 60): LogRow[] {
  return db
    .prepare("SELECT * FROM video_autopilot_log ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as LogRow[];
}

/** The local day of the last pass that actually ran, in the configured zone.
 *  Read off the `pass` row rather than off any queued work, because a pass
 *  that correctly queued nothing is still a pass that happened and must not
 *  run again four minutes later. */
function lastPassDay(): string | null {
  const row = db
    .prepare("SELECT note FROM video_autopilot_log WHERE kind = 'pass' ORDER BY id DESC LIMIT 1")
    .get() as { note: string | null } | undefined;
  const m = row?.note ? /^\d{4}-\d{2}-\d{2}/.exec(row.note) : null;
  return m?.[0] ?? null;
}

/** How many of one kind were QUEUED for one venture in the last seven days.
 *  Rolling rather than calendar — see the header. */
function queuedInWeek(ventureId: string, kind: "post" | "video"): number {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM video_autopilot_log WHERE venture_id = ? AND kind = ? AND action = 'queued' AND ts >= ?",
    )
    .get(ventureId, kind, since) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Everything queued by any pass today, against the day cap. */
export function queuedToday(tz: string, at = new Date()): number {
  const day = wall(tz, at).day;
  const rows = db.prepare("SELECT ts FROM video_autopilot_log WHERE action = 'queued' AND kind IN ('post','video') AND ts >= ? AND ts <= ?")
    .all(new Date(at.getTime() - 26 * 3_600_000).toISOString(), at.toISOString()) as { ts: string }[];
  return rows.filter(row => wall(tz, new Date(row.ts)).day === day).length;
}

export function nextVideoFormat(ventureId: string, formats: string[]): string | null {
  if (!formats.length) return null;
  const previous = historyRows({ ventureId, limit: 100 }).find(row => formats.includes(row.format));
  return formats[previous ? (formats.indexOf(previous.format) + 1) % formats.length : 0]!;
}

/* ------------------------------------------------------------- the topic */

/**
 * What this venture should be posting about, derived.
 *
 * The model is given the venture record and the last few things this box
 * actually did for it — finished runs and Studio posts — and asked for ONE
 * LINE. The recent work is in the prompt for one reason: without it, a daily
 * autopilot writes the same post about the same feature every day, because
 * the venture record has not changed and nothing else was in the question.
 *
 * IT IS TOLD WHAT IT DOES NOT KNOW, in the same words the studio's caption
 * prompt uses. A derived topic that says "announce the new pricing" for a
 * business whose pricing this box has never seen is a brief that produces a
 * post full of invented numbers.
 */
async function deriveTopic(
  v: VentureRow,
  kind: "post" | "video",
  /** The format the gate will judge this topic under. IT MUST BE THE SAME ONE
   *  the branch is about to queue — see the `used` lookup below. */
  format: string,
): Promise<{ topic: string } | { error: string }> {
  const runs = db
    .prepare("SELECT title, finished_at FROM agent_runs WHERE venture_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 5")
    .all(v.id) as unknown as { title: string; finished_at: string }[];
  const posts = db
    .prepare("SELECT brief, ts FROM studio_posts WHERE venture_id = ? ORDER BY ts DESC LIMIT 5")
    .all(v.id) as unknown as { brief: string; ts: string }[];
  /* THE DURABLE HISTORY, and not just the Studio's own rows. `content_history`
     remembers every topic this box has committed to for this venture in this
     format, including the videos — which the studio_posts table has never
     known about. Ten rather than five: the gate refuses a clash anyway, so a
     longer list here is a cheaper way to avoid one than a refusal is.

     THE FORMAT IS PASSED IN AND WAS ONCE HARD-CODED TO "faceless", which was a
     deadlock waiting for the first owner who set the format to `shorts`: the
     prompt would be handed zero previous briefs while the gate compared
     against the `shorts` history, so the model would re-derive yesterday's
     subject, the gate would refuse it, and the pass would log a skip — every
     day, forever, with nothing ever queued. The two must read the same rows.

     ARCHIVED ROWS ARE EXCLUDED, for the same reason the gate excludes them:
     a topic the owner set aside is one they want back, and listing it as
     "do not repeat" would be the prompt re-imposing what the archive lifted. */
  const used = historyRows({ ventureId: v.id, format, limit: 10, archived: false });

  const system = [
    `You choose what a small software business should make a short ${kind === "video" ? "video" : "social post"} about this week. You answer with ONE LINE and nothing else — no quotes, no preamble, no explanation. It is a BRIEF, not the post: "the three things people get wrong about planning permission", not a finished caption.`,
    ``,
    `RULES:`,
    `- At most twenty words.`,
    `- It must be about something this business genuinely does, from the description you are given.`,
    `- DO NOT repeat a recent brief. The last few are listed; pick a different angle.`,
    `- You do NOT know this business's pricing, customer count, funding, launch date or results, and you must not choose a topic that would require inventing any of them.`,
    `- A business at stage "idea" or "pre-launch" has no customers and no results. Choose a topic about the problem, not about traction.`,
  ].join("\n");

  const user = [
    `BUSINESS: ${v.name}${v.website ? ` (${v.website})` : ""}`,
    `STAGE: ${v.stage}`,
    v.description ? `WHAT IT IS: ${v.description}` : `The owner has written no description.`,
    ``,
    posts.length || used.length ? `RECENT BRIEFS, newest first. DO NOT REPEAT ANY OF THESE:` : `Nothing has been made for this business yet.`,
    ...used.map((h) => `- ${h.topic}`),
    ...posts.map((p) => `- ${p.brief}`),
    runs.length ? `` : ``,
    ...(runs.length ? [`RECENT WORK ON THIS BOX:`, ...runs.map((r) => `- ${r.title}`)] : []),
    ``,
    `Give the one-line brief now.`,
  ].join("\n");

  try {
    const reply = await complete([{ role: "system", content: system }, { role: "user", content: user }]);
    const topic = reply.text.trim().split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
    const clean = topic.replace(/^["“']|["”']$/g, "").trim();
    if (!clean) return { error: "the model answered with nothing" };
    return { topic: clean.slice(0, 300) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/* --------------------------------------------------------------- a pass */

export type PassResult = {
  passId: string;
  trigger: "clock" | "manual";
  at: string;
  ran: boolean;
  why: string;
  queued: { post: number; video: number };
  entries: { ventureId: string | null; ventureName: string | null; kind: string; action: string; ref: string | null; note: string | null }[];
};

let passing = false;

/**
 * One pass.
 *
 * REENTRANT-SAFE BY A FLAG, not by a lock, because there is exactly one
 * process and the only two callers are a timer and a route. Two passes at once
 * would double every cadence count that was read before either wrote.
 */
export async function runPass(trigger: "clock" | "manual"): Promise<PassResult> {
  const s = schedule();
  const at = new Date();
  const passId = `ap-${randomUUID().slice(0, 8)}`;
  const day = wall(s.timezone, at).day;
  const out: PassResult = {
    passId,
    trigger,
    at: at.toISOString(),
    ran: false,
    why: "",
    queued: { post: 0, video: 0 },
    entries: [],
  };

  if (passing) {
    out.why = "A pass was already running. Two at once would count the same cadence twice.";
    return out;
  }
  if (!s.enabled && trigger === "clock") {
    out.why = "The autopilot is switched off.";
    return out;
  }
  if (!s.posts && !s.videos) {
    out.why =
      "Both cadences are zero, so there is nothing to queue. Set posts or videos per venture per week under the autopilot settings.";
    log({ passId, ventureId: null, kind: "pass", action: "skipped", note: `${day} — both cadences are zero` });
    return out;
  }

  passing = true;
  out.ran = true;
  try {
    const remaining = Math.max(0, s.cap - queuedToday(s.timezone));
    if (remaining === 0) {
      out.why = `The day's cap of ${s.cap} is already spent.`;
      log({ passId, ventureId: null, kind: "pass", action: "skipped", note: `${day} — the day's cap of ${s.cap} was already spent` });
      return out;
    }

    let budget = remaining;
    const record = (e: {
      v: VentureRow | null;
      kind: "post" | "video";
      action: "queued" | "skipped" | "failed";
      ref?: string | null;
      note?: string | null;
    }) => {
      log({ passId, ventureId: e.v?.id ?? null, kind: e.kind, action: e.action, ref: e.ref, note: e.note });
      out.entries.push({
        ventureId: e.v?.id ?? null,
        ventureName: e.v?.name ?? null,
        kind: e.kind,
        action: e.action,
        ref: e.ref ?? null,
        note: e.note ?? null,
      });
      if (e.action === "queued") {
        budget -= 1;
        out.queued[e.kind] += 1;
      }
    };

    for (const v of ventureRows()) {
      if (budget <= 0) break;
      if (s.quiet.includes(v.stage.toLowerCase())) {
        record({ v, kind: "post", action: "skipped", note: `stage “${v.stage}” is on the quiet list` });
        continue;
      }

      /* --- the post ---------------------------------------------------- */
      if (s.posts > 0 && budget > 0) {
        const made = queuedInWeek(v.id, "post");
        if (made >= s.posts) {
          record({ v, kind: "post", action: "skipped", note: `${made} posts already queued in the last seven days, and the cadence is ${s.posts}` });
        } else {
          const topic = await deriveTopic(v, "post", "post");
          if ("error" in topic) record({ v, kind: "post", action: "failed", note: `no topic could be derived — ${topic.error}` });
          else {
            /* THE GATE, BEFORE THE STUDIO CALL AND THEREFORE BEFORE THE MONEY.
               A refusal is a SKIP and not a failure: nothing broke, a duplicate
               post was prevented, and the sentence quotes the clash.

               A BRANCH RATHER THAN A `continue` OUT OF THE VENTURE LOOP,
               because a refused POST must not cost this venture its VIDEO —
               the two cadences are independent and a repeat of one is not a
               repeat of the other. */
            const gate = checkTopic(v.id, "post", topic.topic);
            const post = gate.ok ? await makePost(v, topic.topic) : null;
            if (!post) {
              record({ v, kind: "post", action: "skipped", note: `“${topic.topic}” was refused — ${gate.reason}` });
            } else if ("error" in post) {
              record({ v, kind: "post", action: "failed", note: post.error });
            } else {
              /* Filed into the publishing queue as a draft. Its outcome is
                 appended to the log line rather than being a log line of its
                 own: the thing that happened is that a post was queued, and a
                 second row saying "and it was also put in a list" would double
                 every count on the Autopilot page. */
              const filed = onAutopilotAsset({
                ventureId: v.id,
                ventureSlug: v.slug,
                source: { kind: "studio_post", id: post.id },
              });
              /* FILED IN THE HISTORY AT THE MOMENT IT IS QUEUED, not when it
                 finishes. A post that failed to render still used up its
                 topic; re-deriving the same subject tomorrow because tonight's
                 image call timed out would be the gate failing open. */
              remember({
                ventureId: v.id,
                format: "post",
                topic: topic.topic,
                assetKind: "studio_post",
                assetRef: post.id,
              });
              record({
                v,
                kind: "post",
                action: "queued",
                ref: post.id,
                note: `${topic.topic} — ${filed.note}`,
              });
            }
          }
        }
      }

      /* --- the video --------------------------------------------------- */
      if (s.videos > 0 && budget > 0) {
        const made = queuedInWeek(v.id, "video");
        if (made >= s.videos) {
          record({ v, kind: "video", action: "skipped", note: `${made} videos already queued in the last seven days, and the cadence is ${s.videos}` });
        } else if (queuedCount() >= 2) {
          record({
            v,
            kind: "video",
            action: "skipped",
            note: `the run queue already has ${queuedCount()} waiting${runningRow() ? ` and one running` : ""} — the autopilot does not push the owner's own work down the line`,
          });
        } else {
          /* THE FORMAT IS DECIDED BEFORE THE TOPIC, so the prompt and the gate
             read the same history. See deriveTopic. */
          const format = nextVideoFormat(v.id, s.formats);
          if (!format) { record({ v, kind: "video", action: "skipped", note: "No supported video format is selected. Choose formats in Autopilot settings." }); continue; }
          const topic = await deriveTopic(v, "video", format);
          if ("error" in topic) record({ v, kind: "video", action: "failed", note: `no topic could be derived — ${topic.error}` });
          else {
            /* THE GATE, BEFORE THE SOURCE SEARCH AND BEFORE THE RUN. A shorts
               job's search costs a request on the owner's own node and a
               handful of metadata reads; a faceless run costs Pexels quota and
               ten minutes of CPU. Neither is spent on a repeat. */
            const gate = checkTopic(v.id, format, topic.topic);
            if (!gate.ok) {
              record({ v, kind: "video", action: "skipped", note: `“${topic.topic}” was refused — ${gate.reason}` });
              continue;
            }

            /* THE SOURCE, FOR THE ONE FORMAT THAT NEEDS ONE. This is what the
               settings hint used to say was impossible. A format that does not
               need a URL skips this entirely and costs nothing. */
            let url: string | null = null;
            let source: { url: string; id: string | null } | null = null;
            if (format === "shorts") {
              const found = await findSource(v, topic.topic, { signal: undefined });
              if ("error" in found) {
                record({
                  v,
                  kind: "video",
                  action: "skipped",
                  note: `no source video could be found for “${topic.topic}” — ${found.error}`,
                });
                continue;
              }
              url = found.url;
              source = { url: found.url, id: found.candidate.sourceId };
            }

            const run = queueVideo(v, topic.topic, format, url);
            if ("error" in run) record({ v, kind: "video", action: "failed", note: run.error });
            else {
              remember({
                ventureId: v.id,
                format,
                topic: topic.topic,
                sourceUrl: source?.url ?? null,
                sourceId: source?.id ?? null,
                assetKind: "run",
                assetRef: run.id,
              });
              record({
                v,
                kind: "video",
                action: "queued",
                ref: run.id,
                note: source ? `${topic.topic} — cut from ${source.url}` : topic.topic,
              });
            }
          }
        }
      }
    }

    out.why = `${out.queued.post} posts and ${out.queued.video} videos queued.`;
    log({
      passId,
      ventureId: null,
      kind: "pass",
      action: out.queued.post + out.queued.video > 0 ? "queued" : "skipped",
      note: `${day} — ${out.why}`,
    });
    return out;
  } finally {
    passing = false;
  }
}

/**
 * One Studio post.
 *
 * `createPost` IS THE STUDIO'S OWN FUNCTION, called directly rather than
 * through a request built against its route, so this and the campaigns pass
 * both call one definition of what a post is and neither has to unwrap an
 * HTTP reply to find out whether a post was made.
 */
async function makePost(v: VentureRow, brief: string): Promise<{ id: string } | { error: string }> {
  const made = await createPost({ ventureId: v.id, brief, format: "square" });
  return made.ok ? { id: made.post.id } : { error: made.error };
}

/**
 * One video run, through the sub-agent dispatch.
 *
 * NOT `POST /api/runs`, and the difference matters. A dispatch files the run
 * against the venture's own Video Producer and against a parent session, so
 * the run appears in the org chart as that worker's work and in the ledger as
 * something that was dispatched rather than started by hand. `parentSessionId`
 * is the constant `autopilot`: not a conversation, and deliberately a name a
 * person reading the row will recognise.
 *
 * A WORKER THE OWNER SWITCHED OFF REFUSES THE JOB, which is the whole reason
 * this goes through the dispatch: switching off a venture's Video Producer is
 * how the owner says "not this one", and a path that went round it would make
 * that switch a decoration.
 */
function queueVideo(
  v: VentureRow,
  brief: string,
  format: string,
  /** The source a `shorts` job cuts up, found by the sourcing pass. Null for
   *  every format that does not need one. */
  url: string | null = null,
): { id: string } | { error: string } {
  ensureTeam(v.id);
  const row = subagentRow(subagentId(v.id, "producer"));
  if (!row) return { error: `${v.name} has no video producer.` };
  const body: DispatchBody = {
    brief,
    parentSessionId: AUTOPILOT_SESSION,
    input: url ? { format, url } : { format },
  };
  const res = dispatch(row, body);
  if (res.status !== 201) {
    const json = res.json as { error?: unknown };
    return { error: typeof json.error === "string" ? json.error : `the dispatch was refused (${res.status})` };
  }
  const json = res.json as { run: { id: string } };
  return { id: json.run.id };
}

/* --------------------------------------------------------------- the timer */

/**
 * Wake every ten minutes and do nothing until it is the hour.
 *
 * TEN MINUTES RATHER THAN SLEEPING UNTIL THE HOUR, which is backups.ts's
 * argument applied here: this runs on a laptop that gets shut. A timer set for
 * nine hours' time does not fire on a machine that was asleep for eight of
 * them; a timer that wakes often and asks what the local hour is runs the pass
 * whenever the laptop is next open inside that hour, and skips the day
 * entirely if it never was.
 */
export function startAutopilot() {
  const tick = () => {
    try {
      const s = schedule();
      if (!s.enabled) return;
      const w = wall(s.timezone);
      if (w.hour !== s.hour) return;
      if (lastPassDay() === w.day) return;
      void runPass("clock").catch(() => {
        /* A pass that throws has already logged whatever it managed. The
           timer must not die with it — that would take the schedule with it
           until the next restart. */
      });
    } catch {
      /* onStart work must not throw. See the manifest contract. */
    }
  };
  setInterval(tick, 600_000).unref?.();
  /* Not on boot: a restart inside the hour would otherwise run a pass the
     moment the process came up, and `node --watch` restarts this server on
     every save. The first tick is ten minutes away. */
}
