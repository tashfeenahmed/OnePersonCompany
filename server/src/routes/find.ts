/**
 * FIND — the owner's own words, looked up across everything this box keeps.
 *
 * IT IS NOT `/api/search`. That route goes OUT, through SearXNG, and hands an
 * agent links from the web. This one goes IN: conversations, board cards,
 * reports and ventures, which is what ⌘K on the page is asking about. Two
 * routes because they are two questions, and a single `search` that guessed
 * which one was meant would be wrong half the time for both callers.
 *
 * WHY THE SERVER AND NOT THE PAGE. The page already holds session titles,
 * ventures and dashboards, and it matches those itself without asking. What it
 * does not hold is what was SAID: a transcript is fetched when its chat is
 * opened, and a report when its run is. "Which conversation was the one about
 * the refund" is the question a palette exists for, and only this side can
 * answer it.
 *
 * LIKE, NOT FTS5. The whole archive is a few megabytes and a scan of it is
 * milliseconds; a virtual table would need triggers on four tables that three
 * other modules write to, and a rebuild for every box already installed. When
 * the scan is felt, the index is the fix, and this file is the only caller.
 *
 * EVERY WORD MUST MATCH, anywhere in the row's title or text. "stripe refund"
 * finds the message that has both and not the hundred that have one.
 */
import { Hono } from "hono";
import { db } from "../db.ts";
import { runThreadPage } from "../integrations/subagents/store.ts";

export type FindHit = {
  group: "chat" | "card" | "report" | "venture" | "person";
  /** Stable within a group, so the page can key a row on it. */
  id: string;
  title: string;
  /** The text around the first word found, or null when the title was the
   *  match and there is nothing more to show. */
  snippet: string | null;
  /** Where it is read. Written here rather than composed by the page, for the
   *  reason every run address is: see `runThreadPage`. */
  to: string;
  ventureId: string | null;
  at: string | null;
  /** How many messages in this conversation matched — chats only. */
  matches?: number;
};

const PER_GROUP = 8;
const MAX_WORDS = 6;
const SNIPPET_BEFORE = 40;
const SNIPPET_LENGTH = 160;

/** The words of a query, lowercased, each once. */
export function findWords(q: string): string[] {
  const words = [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))];
  return words.slice(0, MAX_WORDS);
}

/** `%` and `_` are characters to the person typing them, not wildcards. */
function like(word: string): string {
  return `%${word.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** `(lower(a || ' ' || b) LIKE ? ESCAPE '\') AND …` — one clause per word. */
function allWords(columns: string[], words: string[]): { sql: string; params: string[] } {
  const hay = columns.map((col) => `coalesce(${col}, '')`).join(" || ' ' || ");
  return {
    sql: words.map(() => `lower(${hay}) LIKE ? ESCAPE '\\'`).join(" AND "),
    params: words.map(like),
  };
}

/** A report is often a whole HTML page. The tags are not what it says. */
export function readableText(text: string): string {
  if (!/<[a-z!/]/i.test(text)) return text;
  return text
    .replace(/<(style|script|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** The stretch of `text` around the earliest word found, on one line. */
export function snippetAround(text: string, words: string[]): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const word of words) {
    const i = lower.indexOf(word);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return null;
  let start = Math.max(0, at - SNIPPET_BEFORE);
  /* Start on a word, not in the middle of one. */
  if (start > 0) { const space = flat.indexOf(" ", start); if (space >= 0 && space < at) start = space + 1; }
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

const has = (text: string | null, words: string[]) => {
  const lower = (text ?? "").toLowerCase();
  return words.every((word) => lower.includes(word));
};

function findChats(words: string[]): FindHit[] {
  const where = allWords(["m.content"], words);
  /* Newest matching message per conversation, and how many there were. The
     title is the first thing the owner said, as the rail derives it — see
     `chatSessionSummaries` in db.ts. */
  const rows = db.prepare(
    `SELECT m.session_id, MAX(m.id) AS message_id, COUNT(*) AS matches,
            (SELECT substr(f.content, 1, 200) FROM chat_messages f
              WHERE f.session_id = m.session_id AND f.role = 'user' ORDER BY f.id LIMIT 1) AS title
       FROM chat_messages m
      WHERE m.role IN ('user', 'assistant') AND ${where.sql}
      GROUP BY m.session_id
      ORDER BY message_id DESC
      LIMIT ${PER_GROUP}`,
  ).all(...where.params) as unknown as { session_id: string; message_id: number; matches: number; title: string | null }[];
  const message = db.prepare("SELECT content, ts FROM chat_messages WHERE id = ?");
  return rows.map((row) => {
    const hit = message.get(row.message_id) as unknown as { content: string; ts: string };
    return {
      group: "chat" as const,
      id: row.session_id,
      title: row.title?.replace(/\s+/g, " ").trim() || "Untitled chat",
      snippet: snippetAround(hit.content, words),
      to: `/chat/${encodeURIComponent(row.session_id)}?m=${row.message_id}`,
      ventureId: null,
      at: hit.ts,
      matches: row.matches,
    };
  });
}

function findCards(words: string[]): FindHit[] {
  const where = allWords(["title", "body"], words);
  const rows = db.prepare(
    `SELECT id, title, body, venture_id, updated_at FROM board_cards
      WHERE archived_at IS NULL AND ${where.sql}
      ORDER BY updated_at DESC LIMIT ${PER_GROUP * 3}`,
  ).all(...where.params) as unknown as { id: number; title: string; body: string | null; venture_id: string | null; updated_at: string }[];
  return titleFirst(rows, words).slice(0, PER_GROUP).map((row) => ({
    group: "card" as const,
    id: String(row.id),
    title: row.title,
    snippet: row.body ? snippetAround(row.body, words) : null,
    to: `/board?card=${row.id}`,
    ventureId: row.venture_id,
    at: row.updated_at,
  }));
}

function findReports(words: string[]): FindHit[] {
  const where = allWords(["r.title", "r.output"], words);
  const rows = db.prepare(
    `SELECT r.id, r.kind, r.title, r.output, r.venture_id, v.slug AS venture_slug,
            coalesce(r.finished_at, r.queued_at) AS at
       FROM agent_runs r LEFT JOIN ventures v ON v.id = r.venture_id
      WHERE ${where.sql}
      ORDER BY r.queued_at DESC LIMIT ${PER_GROUP * 3}`,
  ).all(...where.params) as unknown as { id: string; kind: string; title: string; output: string; venture_id: string | null; venture_slug: string | null; at: string }[];
  /* The scan saw the markup too. A row that only matched a tag name or a
     style rule is not a row the owner was looking for. */
  const read = rows.map((row) => ({ ...row, text: readableText(row.output) }))
    .filter((row) => has(`${row.title} ${row.text}`, words));
  return titleFirst(read, words).slice(0, PER_GROUP).map((row) => ({
    group: "report" as const,
    id: row.id,
    title: row.title,
    snippet: snippetAround(row.text, words),
    to: runThreadPage(row),
    ventureId: row.venture_id,
    at: row.at,
  }));
}

function findVentures(words: string[]): FindHit[] {
  const where = allWords(["name", "description", "website"], words);
  const rows = db.prepare(
    `SELECT id, slug, name, description FROM ventures WHERE ${where.sql} ORDER BY position LIMIT ${PER_GROUP * 3}`,
  ).all(...where.params) as unknown as { id: string; slug: string; name: string; description: string }[];
  return titleFirst(rows.map((row) => ({ ...row, title: row.name })), words).slice(0, PER_GROUP).map((row) => ({
    group: "venture" as const,
    id: row.id,
    title: row.name,
    snippet: has(row.name, words) ? null : snippetAround(row.description, words),
    to: `/ventures/${encodeURIComponent(row.slug)}`,
    ventureId: row.id,
    at: null,
  }));
}

/** A watched person — the watchlist ⌘K could not reach. A dossier is filed
 *  per person, so a hit lands on that person's dossiers, exactly where the
 *  people rail in pages/Outputs.tsx navigates. Matches on what the owner
 *  typed about them: the identity lines and the note, not what a dossier
 *  collected about them (a report match already surfaces that). */
function findPeople(words: string[]): FindHit[] {
  const where = allWords(["name", "company", "role", "email", "note"], words);
  const rows = db.prepare(
    `SELECT id, name, company, role, note, updated_at FROM people_watch WHERE ${where.sql} ORDER BY updated_at DESC LIMIT ${PER_GROUP}`,
  ).all(...where.params) as unknown as { id: string; name: string; company: string; role: string; note: string; updated_at: string }[];
  return titleFirst(rows.map((row) => ({ ...row, title: row.name })), words).map((row) => ({
    group: "person" as const,
    id: row.id,
    title: row.name,
    snippet: has(row.name, words)
      ? null
      : snippetAround([row.company, row.role, row.note].filter(Boolean).join(" · "), words),
    to: `/outputs/dossier?person=${encodeURIComponent(row.id)}`,
    ventureId: null,
    at: row.updated_at,
  }));
}

/** A match in the name outranks a match in the text; the order within each
 *  half is the query's own, which is newest first. */
function titleFirst<T extends { title: string }>(rows: T[], words: string[]): T[] {
  return [...rows.filter((row) => has(row.title, words)), ...rows.filter((row) => !has(row.title, words))];
}

export const findRoutes = new Hono();

findRoutes.get("/", (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const words = findWords(q);
  if (!words.length || q.length < 2) return c.json({ q, hits: [] });
  return c.json({
    q,
    hits: [...findVentures(words), ...findPeople(words), ...findChats(words), ...findCards(words), ...findReports(words)],
  });
});
