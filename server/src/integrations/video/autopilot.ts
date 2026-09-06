/**
 * THE AUTOPILOT — once a day, at an hour the owner chose, queue the work
 * nobody got round to.
 *
 * WHAT IT DOES AND, MUCH MORE IMPORTANTLY, WHAT IT DOES NOT. It queues two
 * kinds of thing: a Studio post for a venture, and a video run for a venture.
 * That is all. IT NEVER PUBLISHES ANYTHING ANYWHERE. There is no social
 * credential in this vault, no upload route on this server, and nothing here
 * that would use one if there were. What comes out of a pass is a post in the
 * Studio gallery and a video on its run page, waiting for the owner. An
 * automation that posted on somebody's behalf on a schedule is a different
 * product and a much worse idea, and the rules on the `autopilot` skill say so
 * to the agent as well as to the reader.
 *
 * OFF UNTIL IT IS TURNED ON, like the nightly backup and for the same reason:
 * this spends the owner's Replicate credit and their Pexels quota, and a
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
 * THE TOPIC IS DERIVED, NOT TYPED. A brief for a post or a video comes from
 * the venture record and from what this box has recently run and made for it,
 * put to the model as one question. With no model provider there is no topic,
 * and then the pass logs a skip that says so rather than making something up
 * from the venture's name.
 */
import { randomUUID } from "node:crypto";
import { configValue, db, now, ventureRows, type VentureRow } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { studioRoutes } from "../ventures/studio.ts";
import { queuedCount, runningRow } from "../runs/store.ts";
import { dispatch, type DispatchBody } from "../subagents/routes.ts";
import { ensureTeam, subagentId, subagentRow } from "../subagents/store.ts";

export const AUTOPILOT_PLUGIN = "autopilot";

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
  /** Which video formats a pass may queue. `shorts` needs a URL, which the
   *  autopilot has no way to invent, so only `faceless` is ever useful here —
   *  the setting exists so the answer is a setting rather than a constant. */
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
  const tz = (configValue(AUTOPILOT_PLUGIN, "timezone") ?? "").trim();
  return {
    enabled: (configValue(AUTOPILOT_PLUGIN, "enabled") ?? "").trim().toLowerCase() === "on",
    posts: num("posts", DEFAULT_POSTS, 0, 21),
    videos: num("videos", DEFAULT_VIDEOS, 0, 14),
    hour: num("hour", DEFAULT_HOUR, 0, 23),
    timezone: tz && validZone(tz) ? tz : localZone(),
    quiet: list("quiet", DEFAULT_QUIET),
    formats: list("formats", "faceless"),
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
 * WALKED FORWARD AN HOUR AT A TIME RATHER THAN COMPUTED. Turning "09:00 next
 * Tuesday in Europe/Dublin" into a UTC instant by arithmetic means handling
 * the two nights a year where the local hour happens twice or not at all, and
 * getting that wrong is a schedule that silently skips a day in March. Walking
 * forward and asking Intl what the local hour is at each step cannot be wrong
 * about a transition it does not have to model. Forty-eight steps.
 */
export function nextRunAt(s: Schedule, from: Date = new Date()): string | null {
  if (!s.enabled) return null;
  const today = wall(s.timezone, from);
  const done = lastPassDay();
  for (let i = 0; i <= 48; i++) {
    const at = new Date(from.getTime() + i * 3_600_000);
    const w = wall(s.timezone, at);
    if (w.hour !== s.hour) continue;
    /* The hour that is happening RIGHT NOW does not count as "next" once the
       pass for that day has run — otherwise the page would say the next run is
       four minutes ago. */
    if (i === 0 && w.day === today.day && done === w.day) continue;
    if (w.day === done) continue;
    /* Truncated to the top of that local hour: the pass fires on the first
       ten-minute tick inside it, and reporting the minute this happened to be
       called would be reporting the wrong thing. */
    return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString();
  }
  return null;
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
function queuedToday(tz: string): number {
  const day = wall(tz).day;
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM video_autopilot_log WHERE action = 'queued' AND ts >= ?")
    .get(`${day}T00:00:00.000Z`) as { n: number } | undefined;
  /* A UTC-shaped comparison against a local day is deliberately generous by
     up to a day's offset: the cap is a brake, and a brake that occasionally
     brakes early is the correct direction to be wrong in. */
  return row?.n ?? 0;
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
async function deriveTopic(v: VentureRow, kind: "post" | "video"): Promise<{ topic: string } | { error: string }> {
  const runs = db
    .prepare("SELECT title, finished_at FROM agent_runs WHERE venture_id = ? AND status = 'done' ORDER BY finished_at DESC LIMIT 5")
    .all(v.id) as unknown as { title: string; finished_at: string }[];
  const posts = db
    .prepare("SELECT brief, ts FROM studio_posts WHERE venture_id = ? ORDER BY ts DESC LIMIT 5")
    .all(v.id) as unknown as { brief: string; ts: string }[];

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
    posts.length ? `RECENT BRIEFS, newest first:` : `Nothing has been made for this business yet.`,
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
          const topic = await deriveTopic(v, "post");
          if ("error" in topic) record({ v, kind: "post", action: "failed", note: `no topic could be derived — ${topic.error}` });
          else {
            const post = await makePost(v, topic.topic);
            if ("error" in post) record({ v, kind: "post", action: "failed", note: post.error });
            else record({ v, kind: "post", action: "queued", ref: post.id, note: topic.topic });
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
          const topic = await deriveTopic(v, "video");
          if ("error" in topic) record({ v, kind: "video", action: "failed", note: `no topic could be derived — ${topic.error}` });
          else {
            const run = queueVideo(v, topic.topic, s.formats[0] ?? "faceless");
            if ("error" in run) record({ v, kind: "video", action: "failed", note: run.error });
            else record({ v, kind: "video", action: "queued", ref: run.id, note: topic.topic });
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
 * One Studio post, through the Studio's own route handler.
 *
 * `studioRoutes.request()` IS A DIRECT CALL AND NOT A NETWORK HOP. Hono apps
 * are callable objects; this runs the same handler the browser reaches at
 * `POST /api/studio/posts`, in this process, with no port and no listener
 * involved. It is done this way rather than by importing the generation
 * functions because the post-making logic is INSIDE that route handler — the
 * caption turn, the image call, the row — and a copy of it here would be a
 * second definition of what a post is, in a directory another area owns.
 */
async function makePost(v: VentureRow, brief: string): Promise<{ id: string } | { error: string }> {
  try {
    const res = await studioRoutes.request("/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ventureId: v.id, brief, format: "square" }),
    });
    const body = (await res.json().catch(() => null)) as { post?: { id?: unknown }; error?: unknown } | null;
    if (!res.ok || !body?.post) return { error: typeof body?.error === "string" ? body.error : `the Studio refused it (HTTP ${res.status})` };
    return { id: String((body.post as { id: unknown }).id) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
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
function queueVideo(v: VentureRow, brief: string, format: string): { id: string } | { error: string } {
  ensureTeam(v.id);
  const row = subagentRow(subagentId(v.id, "producer"));
  if (!row) return { error: `${v.name} has no video producer.` };
  const body: DispatchBody = {
    brief,
    parentSessionId: AUTOPILOT_SESSION,
    input: { format },
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
