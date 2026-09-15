import { workflowOwns } from "../pipeline/workflow-store.ts";
/**
 * THE MORNING BRIEFING — the facts first, the prose second, and both kept.
 *
 * WHAT IT IS. Once a day, at an hour the owner sets, this assembles what
 * actually happened since the last one — alerts raised, figures that moved,
 * agent runs that finished, board cards falling due, a line per venture — and
 * asks the model to write it up. The assembled facts are stored beside the
 * prose, in the same row, and the page shows both.
 *
 * WHY BOTH ARE STORED, WHICH IS THE ONE DECISION HERE THAT MATTERS. A daily
 * digest written by a language model is the single easiest place in a product
 * like this to end up with confident sentences about numbers nobody can check.
 * Keeping the facts table means every sentence has something behind it that
 * can be read, and a sentence with nothing behind it is visible as such. It
 * also means a box with no model provider still produces a real briefing —
 * the facts — with one honest line saying nobody was available to write them
 * up. The prose is the optional half.
 *
 * WHERE THE FACTS COME FROM: `GET /api/skills/<id>`, over loopback, exactly as
 * the rule engine reads them and exactly as `opc` does. There is no direct
 * table access in this file for anything that is a business figure. The
 * consequence is the usual one: an integration added next year is in the
 * briefing without this file being edited, and a plugin that is not connected
 * contributes nothing rather than a zero.
 *
 * MOVEMENT IS THE SNAPSHOT DIFF, NOT A HAND-WRITTEN LIST OF HEADLINES. The
 * alert engine already stores a snapshot of each watched skill's document on
 * every cycle; the briefing diffs the newest against the one nearest 24 hours
 * ago and reports what changed. That is why "revenue and traffic movement"
 * needs no list of which field in which document is revenue: whatever moved,
 * moved, and the paths name themselves. On a box installed this morning there
 * is no 24-hour-old snapshot and the section says so instead of showing zeroes.
 *
 * IDEMPOTENT ACROSS RESTARTS. The row's key is the local day in the owner's
 * configured zone, so building today twice is one upsert. The timer wakes every
 * ten minutes rather than sleeping until the hour — the same shape
 * ops/backups.ts uses, for the same reason: a laptop shut at seven builds the
 * morning's briefing when it wakes rather than skipping the day.
 */
import { appendChatMessage, chatMessages, configValue, ventureRows } from "../../db.ts";
import { dailySchedule, zoned } from "../../shared/time.ts";
import { complete, NoProviderError } from "../../models/provider.ts";
import { plainRich, PRESENT_BRIEF } from "../../skills/present.ts";
import { apiBase, snapshotSkills, takeSnapshots } from "./catalogue.ts";
import { serviceHeaders } from "../../auth.ts";
import { flattenNumbers, movements, type Movement } from "./movement.ts";
import {
  briefing,
  briefings,
  events,
  markDelivered,
  openEvents,
  rules,
  snapshotAtOrBefore,
  snapshots,
  writeBriefing,
  type BriefingRow,
} from "./store.ts";

export const PLUGIN = "briefing";

/** The chat session a briefing is filed under. One id, forever, so the rail
 *  shows one growing conversation rather than a session per day. */
export const SESSION = "briefing";
/** The channel on the message, beside "web" and "telegram". It says where the
 *  line came from, which is neither a person nor a bot. */
export const CHANNEL = "briefing";

export const DEFAULT_HOUR = 7;

/* ---------------------------------------------------------------- settings */

export type Sections = {
  alerts: boolean;
  movement: boolean;
  runs: boolean;
  board: boolean;
  ventures: boolean;
};

export type Settings = {
  hour: number;
  timezone: string;
  telegram: boolean;
  sections: Sections;
};

/**
 * THE WALL CLOCK LIVES IN `shared/time.ts` NOW — see its header for the rules
 * — and these three names are kept as re-exports because two other areas
 * import them from here.
 */
export { systemZone, validZone, zoned } from "../../shared/time.ts";

const onOff = (v: string | null, fallback: boolean) => {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return fallback;
  return t === "on" || t === "yes" || t === "true" || t === "1";
};

export function settings(): Settings {
  /* AN EMPTY SETTING IS NOT A ZERO, and an out-of-range one is not clamped:
     `Number("")` is 0, which is a legal hour, so an unset field would silently
     schedule the briefing for midnight rather than for the default. Both rules
     live in `dailySchedule` now, with the zone fallback beside them. This
     schedule has no on/off switch of its own — the sections are the switches —
     so it is always enabled. */
  const schedule = dailySchedule(PLUGIN, { defaultHour: DEFAULT_HOUR, defaultEnabled: true });
  return {
    hour: schedule.hour,
    timezone: schedule.timezone,
    /* OFF UNTIL ASKED FOR. A daily message arriving on somebody's phone
       because a default said so is a surprise, and the same argument
       ops/backups.ts makes about writing an archive at four in the morning. */
    telegram: onOff(configValue(PLUGIN, "telegram"), false),
    sections: {
      alerts: onOff(configValue(PLUGIN, "sectionAlerts"), true),
      movement: onOff(configValue(PLUGIN, "sectionMovement"), true),
      runs: onOff(configValue(PLUGIN, "sectionRuns"), true),
      board: onOff(configValue(PLUGIN, "sectionBoard"), true),
      ventures: onOff(configValue(PLUGIN, "sectionVentures"), true),
    },
  };
}

/* ------------------------------------------------------------------- facts */

export type Facts = {
  day: string;
  timezone: string;
  since: string;
  builtAt: string;
  alerts: {
    included: boolean;
    /** Null when the section is off. Never zero for "off". */
    trips: { ts: string; rule: string; skill: string; message: string; narration: string | null; ventureId: string | null }[] | null;
    unreadable: { ts: string; rule: string; message: string }[] | null;
    openTotal: number | null;
    note: string | null;
  };
  movement: {
    included: boolean;
    skills: { skill: string; from: string; to: string; moved: Movement[] }[] | null;
    note: string | null;
  };
  runs: {
    included: boolean;
    finished: { id: string; kind: string; venture: string | null; title: string; status: string; finishedAt: string | null }[] | null;
    note: string | null;
  };
  board: {
    included: boolean;
    overdue: { title: string; due: string; column: string; venture: string | null }[] | null;
    dueSoon: { title: string; due: string; column: string; venture: string | null }[] | null;
    note: string | null;
  };
  ventures: {
    included: boolean;
    lines: { id: string; name: string; stage: string; host: string | null; openAlerts: number; runsFinished: number; note: string | null }[] | null;
    note: string | null;
  };
};

async function getJson(path: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: serviceHeaders(), signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * ASSEMBLE THE DAY.
 *
 * `since` is the previous briefing's `built_at`, or 24 hours ago when there
 * is none. That is what makes "since yesterday" true rather than
 * approximately true: a box that missed three days reports three days, and
 * says so in the window, rather than quietly dropping two of them.
 */
export async function assemble(
  s: Settings,
  day: string,
  signal?: AbortSignal,
): Promise<Facts> {
  const previous = lastBriefingBefore(day);
  const since = previous?.built_at ?? new Date(Date.now() - 86_400_000).toISOString();
  const builtAt = new Date().toISOString();

  const facts: Facts = {
    day,
    timezone: s.timezone,
    since,
    builtAt,
    alerts: { included: s.sections.alerts, trips: null, unreadable: null, openTotal: null, note: null },
    movement: { included: s.sections.movement, skills: null, note: null },
    runs: { included: s.sections.runs, finished: null, note: null },
    board: { included: s.sections.board, overdue: null, dueSoon: null, note: null },
    ventures: { included: s.sections.ventures, lines: null, note: null },
  };

  const byRule = new Map(rules().map((r) => [r.id, r]));

  /* ---- alerts ------------------------------------------------------- */
  if (s.sections.alerts) {
    const rows = events({ days: 30, limit: 400 }).filter((e) => e.ts >= since);
    facts.alerts.trips = rows
      .filter((e) => e.kind === "trip")
      .map((e) => ({
        ts: e.ts,
        rule: byRule.get(e.rule_id)?.name ?? `rule ${e.rule_id}`,
        skill: byRule.get(e.rule_id)?.skill ?? "unknown",
        message: e.message,
        narration: e.narration,
        ventureId: byRule.get(e.rule_id)?.venture_id ?? null,
      }));
    facts.alerts.unreadable = rows
      .filter((e) => e.kind === "unreadable")
      .map((e) => ({
        ts: e.ts,
        rule: byRule.get(e.rule_id)?.name ?? `rule ${e.rule_id}`,
        message: e.message,
      }));
    facts.alerts.openTotal = openEvents().length;
    if (!byRule.size)
      facts.alerts.note = "There are no alert rules on this box, so nothing was watched.";
  }

  /* ---- movement ----------------------------------------------------- */
  if (s.sections.movement) {
    /* A FRESH SNAPSHOT FIRST, so the "to" side of every diff is the present
       rather than whatever the last evaluation cycle happened to catch. It is
       the same function the engine calls; a briefing built by hand at noon and
       one built by the timer at seven are the same code path. */
    let ids: string[] = [];
    try {
      ids = await snapshotSkills(signal);
      await takeSnapshots(ids, builtAt, signal);
    } catch {
      ids = [];
    }
    const earlier = new Date(Date.parse(builtAt) - 86_400_000).toISOString();
    const out: NonNullable<Facts["movement"]["skills"]> = [];
    for (const skill of ids) {
      const now = snapshots(skill, 1)[0];
      const then = snapshotAtOrBefore(skill, earlier);
      if (!now || !then || then.ts === now.ts) continue;
      const moved = movements(flattenNumbers(then.doc), flattenNumbers(now.doc), 8);
      if (moved.length) out.push({ skill, from: then.ts, to: now.ts, moved });
    }
    facts.movement.skills = out;
    if (!out.length)
      facts.movement.note = ids.length
        ? "No document has a reading from 24 hours ago yet, or nothing in one moved. This box keeps snapshots for seven days; a fresh install has nothing to compare against."
        : "No connected skill could be snapshotted, so there is nothing to compare.";
  }

  /* ---- runs --------------------------------------------------------- */
  if (s.sections.runs) {
    const doc = (await getJson("/api/skills/runs?limit=60", signal)) as
      | { runs?: { id: string; kind: string; ventureName?: string | null; title: string; status: string; finishedAt: string | null }[] }
      | null;
    if (!doc?.runs) facts.runs.note = "The runs document could not be read.";
    else {
      facts.runs.finished = doc.runs
        .filter((r) => r.finishedAt && r.finishedAt >= since)
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          venture: r.ventureName ?? null,
          title: r.title,
          status: r.status,
          finishedAt: r.finishedAt,
        }));
    }
  }

  /* ---- board -------------------------------------------------------- */
  if (s.sections.board) {
    const doc = (await getJson("/api/skills/board", signal)) as
      | {
          ventures?: Record<string, { name?: string }>;
          columns?: { title: string; cards?: { title: string; due: string | null; ventureId?: string | null }[] }[];
        }
      | null;
    if (!doc?.columns) facts.board.note = "The board document could not be read.";
    else {
      const today = day;
      const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      const overdue: NonNullable<Facts["board"]["overdue"]> = [];
      const dueSoon: NonNullable<Facts["board"]["dueSoon"]> = [];
      for (const col of doc.columns)
        for (const card of col.cards ?? []) {
          if (!card.due) continue;
          const venture = card.ventureId ? (doc.ventures?.[card.ventureId]?.name ?? card.ventureId) : null;
          const row = { title: card.title, due: card.due, column: col.title, venture };
          if (card.due < today) overdue.push(row);
          else if (card.due <= soon) dueSoon.push(row);
        }
      facts.board.overdue = overdue;
      facts.board.dueSoon = dueSoon;
      if (!overdue.length && !dueSoon.length)
        facts.board.note = "No card on the board has a due date inside the next three days.";
    }
  }

  /* ---- ventures ----------------------------------------------------- */
  if (s.sections.ventures) {
    const open = openEvents();
    const rows = ventureRows();
    facts.ventures.lines = rows.map((v) => {
      const openAlerts = open.filter((e) => byRule.get(e.rule_id)?.venture_id === v.id).length;
      const runsFinished = (facts.runs.finished ?? []).filter((r) => r.venture === v.name).length;
      return {
        id: v.id,
        name: v.name,
        stage: v.stage,
        host: v.host,
        openAlerts,
        runsFinished,
        /* ALWAYS NULL, and deliberately. A venture line carries its counts
           and nothing else; the sentence about a venture is the model's job
           and it is told to leave out a venture with nothing to say. This was
           written as a ternary with `null` on both arms, which reads as an
           unfinished thought rather than a decision. */
        note: null,
      };
    });
    if (!rows.length) facts.ventures.note = "There are no ventures on this box yet.";
  }

  return facts;
}

function lastBriefingBefore(day: string): BriefingRow | undefined {
  const rows = briefings(5).filter((b) => b.day < day);
  return rows[0];
}

/* -------------------------------------------------------------- the prose */

const SYSTEM =
  "You are writing the morning briefing for the owner of a small software " +
  "business — one person, several ventures. You are handed a JSON document of " +
  "FACTS that were read from this business's own dashboard minutes ago.\n\n" +
  "RULES, and they are absolute:\n" +
  "- Every figure you write must appear in the facts. Do not compute a new " +
  "one, do not total across currencies, do not annualise, do not estimate.\n" +
  "- `null` means nobody measured it. Say \"not reported\" — never zero, never " +
  "\"none\".\n" +
  "- A section marked `included: false` was switched off by the owner. Do not " +
  "mention it at all.\n" +
  "- An alert is a comparison the owner configured crossing a line they set. " +
  "It is not a judgement and not necessarily a problem; say what crossed what.\n" +
  "- An `unreadable` alert means a document could not be read. It is NOT a " +
  "business figure moving and must never be reported as one.\n" +
  "- A movement is a path in a document with a before and an after. Name the " +
  "document and the path when you quote one; do not translate a path into a " +
  "business claim you cannot support (`portfolio.window.pageviews` is " +
  "pageviews over that document's own window, not \"traffic this month\").\n" +
  "- If a section has nothing in it, one short sentence saying so. Do not pad.\n" +
  "- DO NOT COUNT THINGS YOURSELF. If the facts carry a count, quote it; if " +
  "they carry a list and no count, describe the list without stating how long " +
  "it is. A tally you worked out is a figure that is not in the document.\n\n" +
  "SHAPE: markdown. A one-paragraph opening that says what the day looks like, " +
  "then a `## ` section per part of the briefing that has anything in it. Keep " +
  "the whole thing under 500 words.\n\n" +
  PRESENT_BRIEF +
  /* THE FENCE LANGUAGE IS THE ONE THING MODELS GET WRONG HERE, every time. The
     brief above names the five languages and a model still reaches for ```json
     because the body is JSON — which renders as a wall of code instead of a
     card. Saying it again, last, in one line, is cheap. */
  "\n\nThe fence language is the BLOCK'S NAME and never `json`: write ```cards, " +
  "```chart, ```bars, ```meters or ```table. A block fenced as ```json is drawn " +
  "as source code and is worse than the sentence it replaced.";

export type Written = { markdown: string; model: string | null; note: string | null };

/**
 * Ask the model to write the facts up.
 *
 * NO PROVIDER MEANS NO PROSE, and the briefing is still built. What comes back
 * then is an empty markdown with a `note` naming what to connect, and the page
 * shows the facts table it already has. Nothing here writes a plausible
 * paragraph in the absence of a model.
 */
export async function write(facts: Facts, signal?: AbortSignal): Promise<Written> {
  try {
    const reply = await complete(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(facts) },
      ],
      { signal },
    );
    const text = reply.text.trim();
    if (!text)
      return { markdown: "", model: reply.model, note: "The model answered with an empty message." };
    return { markdown: text, model: reply.model, note: null };
  } catch (err) {
    if (err instanceof NoProviderError)
      return { markdown: "", model: null, note: err.message };
    return {
      markdown: "",
      model: null,
      note: `The briefing was assembled but not written up: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/* ------------------------------------------------------------- delivery */

/**
 * Two doors, and neither of them may fail the build.
 *
 * The chat message is the record: it puts the briefing in the same transcript
 * every other conversation lives in, under a session id that never changes, so
 * the rail shows it as an ordinary chat and the agent can be asked about it.
 * The Telegram push is optional, off by default, and goes only to a paired
 * chat — `notify()` is the function that cannot send to the wrong person.
 *
 * THE RICH BLOCKS ARE STRIPPED ON THE WAY TO TELEGRAM and kept in the
 * transcript, which is what `plainRich` is for: the chat page draws a card, a
 * phone gets the same figures as lines of text, and the stored message is the
 * one the page can still draw tomorrow.
 */
export async function deliver(
  row: BriefingRow,
  s: Settings,
): Promise<{ chat: boolean; telegram: boolean; note: string | null }> {
  const body = row.markdown.trim();
  const text = body || factsFallback(row);

  let chat = false;
  try {
    appendChatMessage({
      sessionId: SESSION,
      role: "assistant",
      content: text,
      channel: CHANNEL,
      model: row.model,
    });
    chat = true;
  } catch {
    chat = false;
  }

  if (!s.telegram) return { chat, telegram: false, note: "Telegram push is switched off." };
  /*
    THE BRIDGE IS IMPORTED HERE AND NOT AT THE TOP, and that is a real
    constraint rather than a style choice. `telegram/bridge.ts` imports
    `routes/chat.ts`, which imports `skills/registry.ts`, which imports
    `integrations/index.ts` — which imports this area's manifest, which imports
    this file. A static import would close that loop THROUGH a module whose top
    level builds an object literal out of imported functions, which is exactly
    the kind of cycle that works until somebody moves a line. Deferring it to
    the moment a briefing is actually pushed costs one module lookup a day.

    `notify` is the right function and not `telegram.send`: it resolves the
    paired chat and the bot token itself, sends only to a chat that has been
    paired, and returns `{ sent: false, reason }` rather than throwing when
    nothing is. See its header — an alert path that can crash the thing raising
    the alert is worse than a missed alert.
  */
  const { notify } = await import("../../telegram/bridge.ts");
  const sent = await notify(`Briefing — ${row.day}\n\n${plainRich(text)}`);
  return {
    chat,
    telegram: sent.sent,
    note: sent.sent ? null : (sent.reason ?? "Telegram push did not go."),
  };
}

/** What is sent when there is no prose: the honest sentence and the counts, so
 *  a briefing with no model behind it is still a message worth receiving. */
function factsFallback(row: BriefingRow): string {
  let facts: Facts | null = null;
  try {
    facts = JSON.parse(row.facts) as Facts;
  } catch {
    facts = null;
  }
  const lines = [`# Briefing — ${row.day}`, ""];
  lines.push(row.note ?? "No prose was written for this briefing.");
  if (facts) {
    lines.push("");
    if (facts.alerts.included)
      lines.push(
        `- Alerts since ${facts.since}: ${facts.alerts.trips?.length ?? 0} trip(s), ` +
          `${facts.alerts.unreadable?.length ?? 0} unreadable, ${facts.alerts.openTotal ?? 0} open.`,
      );
    if (facts.movement.included)
      lines.push(`- Documents with movement over 24h: ${facts.movement.skills?.length ?? 0}.`);
    if (facts.runs.included)
      lines.push(`- Runs finished: ${facts.runs.finished?.length ?? 0}.`);
    if (facts.board.included)
      lines.push(
        `- Board: ${facts.board.overdue?.length ?? 0} overdue, ${facts.board.dueSoon?.length ?? 0} due within three days.`,
      );
    if (facts.ventures.included)
      lines.push(`- Ventures: ${facts.ventures.lines?.length ?? 0}.`);
    lines.push("");
    lines.push("The facts are on the briefing page; only the write-up is missing.");
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------- the build */

export type BuildResult = {
  day: string;
  rebuilt: boolean;
  row: BriefingRow;
  delivery: { chat: boolean; telegram: boolean; note: string | null };
};

/**
 * Build (or rebuild) one day's briefing and deliver it.
 *
 * `force` is what the page's Build now button sends: without it, a day that
 * already has a briefing is left alone, which is what makes the ten-minute
 * timer idempotent. With it, the day's row is replaced and delivered again —
 * a rebuild is a rebuild, not a second briefing, because the day is the key.
 */
export async function build(
  opts: { force?: boolean; signal?: AbortSignal; inAppOnly?: boolean } = {},
): Promise<BuildResult> {
  const s = settings();
  const { day } = zoned(s.timezone);
  const held = briefing(day);
  if (held && !opts.force)
    return {
      day,
      rebuilt: false,
      row: held,
      delivery: { chat: held.to_chat === 1, telegram: held.to_telegram === 1, note: held.delivery_note },
    };

  const facts = await assemble(s, day, opts.signal);
  const written = await write(facts, opts.signal);
  const row = writeBriefing({
    day,
    timezone: s.timezone,
    markdown: written.markdown,
    facts,
    model: written.model,
    note: written.note,
  });
  const delivery = await deliver(row, opts.inAppOnly ? { ...s, telegram: false } : s);
  markDelivered(day, { chat: delivery.chat, telegram: delivery.telegram, note: delivery.note });
  return { day, rebuilt: true, row: briefing(day)!, delivery };
}

/* ------------------------------------------------------------- the timer */

let timer: NodeJS.Timeout | null = null;

/**
 * WAKE EVERY TEN MINUTES AND DO NOTHING MOST OF THE TIME.
 *
 * The same shape ops/backups.ts uses and for the same reason: a timer that
 * slept until the hour would miss the day entirely on a laptop that was shut,
 * where this one builds the morning's briefing when the machine wakes. Once
 * the local hour has passed and today has no row, it builds; after that the
 * row exists and the check is a single indexed SELECT.
 *
 * IT NEVER THROWS. A briefing that took the API down would be a dashboard that
 * will not start because a model endpoint is having a bad morning.
 */
export function startBriefing() {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      try {
        if (workflowOwns("briefing")) return;
        const s = settings();
        const { day, hour } = zoned(s.timezone);
        if (hour < s.hour) return;
        if (briefing(day)) return;
        const r = await build();
        console.log(
          `[briefing] built ${r.day} (${r.row.markdown ? `${r.row.markdown.length} chars` : "facts only"})` +
            ` · chat ${r.delivery.chat ? "yes" : "no"} · telegram ${r.delivery.telegram ? "yes" : "no"}`,
        );
      } catch (err) {
        console.error("[briefing] build failed:", err);
      }
    })();
  }, 10 * 60_000);
  timer.unref();
}

/** The transcript this box has filed under the briefing session, for the page
 *  that wants to prove delivery happened. */
export function deliveredMessages(limit = 20) {
  return chatMessages(SESSION, limit);
}
