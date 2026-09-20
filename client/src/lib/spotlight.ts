/**
 * WHAT ⌘K SHOWS, AS A FUNCTION OF WHAT WAS TYPED. No React in here: the
 * palette draws whatever this returns, and the ordering rules are the part
 * worth testing.
 *
 * TWO SOURCES, ONE LIST. Names — pages, ventures, dashboards, chat titles —
 * are already in the store, so they are matched here on every keystroke with
 * no request. What was SAID, in a transcript or a card or a report, is only on
 * the server (see server/src/routes/find.ts) and arrives a moment later. The
 * merge keeps the list from jumping when it does: the local rows stay where
 * they were and the server's rows fill in under them.
 */
import type { FindHit } from "@/lib/api/find";

export type SpotlightGroup = "Actions" | "Pages" | "Ventures" | "Dashboards" | "Chats" | "Cards" | "Reports";

export type SpotlightItem = {
  key: string;
  group: SpotlightGroup;
  title: string;
  /** A quiet word after the title: the venture a card is for, "3 messages". */
  detail?: string;
  snippet?: string;
  /** Where Enter goes. */
  to?: string;
  /** A path ModuleIcon knows, when the row is a page. */
  icon?: string;
  ventureId?: string | null;
};

export type SpotlightSources = {
  pages: { to: string; label: string; icon?: string; also?: string }[];
  ventures: { id: string; slug: string; name: string }[];
  dashboards: { id: string; name: string; to: string; ventureId?: string | null }[];
  sessions: { id: string; title: string; ventureId?: string | null; children?: { runId?: string; id: string; title: string; to?: string }[] }[];
};

export const GROUP_ORDER: SpotlightGroup[] = ["Actions", "Pages", "Ventures", "Dashboards", "Chats", "Cards", "Reports"];
const PER_GROUP = 6;
const RECENT_CHATS = 5;

export function spotlightWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/** 0 = no match. Higher is better: the name starts with it, a word in the
 *  name starts with it, it is in there somewhere. */
export function nameScore(name: string, words: string[]): number {
  const lower = name.toLowerCase();
  let worst = 3;
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at < 0) return 0;
    const score = at === 0 ? 3 : /[\s\-_/·:(]/.test(lower[at - 1]) ? 2 : 1;
    if (score < worst) worst = score;
  }
  return worst;
}

function best<T>(rows: T[], name: (row: T) => string, words: string[]): T[] {
  return rows.map((row, index) => ({ row, index, score: nameScore(name(row), words) }))
    .filter(entry => entry.score > 0)
    /* Stable within a score, so the store's own order — the owner's order for
       pages, newest first for chats — is the tie-break. */
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, PER_GROUP).map(entry => entry.row);
}

/**
 * WHAT CAN BE MADE, written once: the New button's menu draws these rows and
 * the palette offers them as actions. `key` is the letter that picks the row
 * while the menu is open — see components/NewMenu.tsx.
 */
export const NEW_ITEMS = [
  { id: "chat", group: "chat", title: "New chat", short: "Chat", to: "/", icon: "/chat", key: "c" },
  { id: "dashboard", group: "other", title: "New dashboard", short: "Dashboard", to: "/dashboards/new", icon: "/dashboards", key: "d" },
  { id: "venture-idea", group: "venture", title: "New venture: idea", short: "Idea", to: "/ventures/new?stage=idea", icon: "/ventures", key: "i" },
  { id: "venture-pre-launch", group: "venture", title: "New venture: pre-launch", short: "Pre-launch", to: "/ventures/new?stage=pre-launch", icon: "/ventures", key: "p" },
  { id: "venture-launched", group: "venture", title: "New venture: launched", short: "Launched", to: "/ventures/new?stage=launched", icon: "/ventures", key: "l" },
] as const;

export function newItemForKey(key: string) {
  return key.length === 1 ? NEW_ITEMS.find(item => item.key === key.toLowerCase()) : undefined;
}

const ACTIONS: SpotlightItem[] = NEW_ITEMS.map(item => ({ key: `action:${item.id}`, group: "Actions", title: item.title, to: item.to, icon: item.icon }));
const NEW_CHAT = ACTIONS[0];

/** What the store can answer by itself. With nothing typed it is the start
 *  screen: the one action, the last few chats, every page. */
export function localItems(query: string, sources: SpotlightSources): SpotlightItem[] {
  const words = spotlightWords(query);
  const ventureName = (id?: string | null) => sources.ventures.find(v => v.id === id)?.name;
  const page = (p: SpotlightSources["pages"][number]): SpotlightItem => ({ key: `page:${p.to}`, group: "Pages", title: p.label, to: p.to, icon: p.icon ?? p.to });
  const chat = (s: SpotlightSources["sessions"][number]): SpotlightItem => ({ key: `chat:${s.id}`, group: "Chats", title: s.title, detail: ventureName(s.ventureId), to: `/chat/${encodeURIComponent(s.id)}`, icon: "/chat", ventureId: s.ventureId });
  if (!words.length) return [NEW_CHAT, ...sources.sessions.slice(0, RECENT_CHATS).map(chat), ...sources.pages.map(page)];

  const runs = sources.sessions.flatMap(s => (s.children ?? []).filter(c => c.to).map(c => ({ ...c, from: s.title })));
  return [
    /* An action has to be asked for by the start of one of its words: "board"
       is the Board page, not the tail of "New dashboard" sitting above it. */
    ...best(ACTIONS, a => a.title, words).filter(a => nameScore(a.title, words) >= 2),
    ...best(sources.pages, p => `${p.label} ${p.also ?? ""}`, words).map(page),
    ...best(sources.ventures, v => v.name, words).map((v): SpotlightItem => ({ key: `venture:${v.id}`, group: "Ventures", title: v.name, to: `/ventures/${encodeURIComponent(v.slug)}`, ventureId: v.id })),
    ...best(sources.dashboards, d => d.name, words).map((d): SpotlightItem => ({ key: `dashboard:${d.id}`, group: "Dashboards", title: d.name, detail: ventureName(d.ventureId), to: d.to, icon: "/dashboards", ventureId: d.ventureId })),
    ...best(sources.sessions, s => s.title, words).map(chat),
    ...best(runs, r => r.title, words).map((r): SpotlightItem => ({ key: `report:${r.runId ?? r.id}`, group: "Reports", title: r.title, detail: `from “${r.from}”`, to: r.to, icon: "/outputs" })),
  ];
}

/**
 * The store's rows and the server's, as one grouped list.
 *
 * A thing both sides found is ONE row. For a chat the server's row wins the
 * address — it lands on the message that matched — and the store wins the
 * title, because a chat the owner renamed is called what he called it. For a
 * venture or a report the store's row is kept as it is: it matched on the
 * name, and that is the better reason.
 */
export function mergeItems(local: SpotlightItem[], hits: FindHit[], sources: SpotlightSources): SpotlightItem[] {
  const ventureName = (id?: string | null) => sources.ventures.find(v => v.id === id)?.name;
  const group: Record<FindHit["group"], SpotlightGroup> = { chat: "Chats", card: "Cards", report: "Reports", venture: "Ventures" };
  const icon: Record<FindHit["group"], string | undefined> = { chat: "/chat", card: "/board", report: "/outputs", venture: undefined };
  const items = [...local];
  for (const hit of hits) {
    const key = `${hit.group}:${hit.id}`;
    const mine = items.findIndex(item => item.key === key);
    const found: SpotlightItem = {
      key, group: group[hit.group], title: hit.title, snippet: hit.snippet ?? undefined, to: hit.to, icon: icon[hit.group], ventureId: hit.ventureId,
      detail: hit.group === "chat" ? (hit.matches && hit.matches > 1 ? `${hit.matches} messages` : undefined) : hit.group === "venture" ? undefined : ventureName(hit.ventureId),
    };
    if (mine < 0) items.push(found);
    else if (hit.group === "chat") items[mine] = { ...found, title: items[mine].title, detail: found.detail ?? items[mine].detail };
    else if (!items[mine].snippet && found.snippet) items[mine] = { ...items[mine], snippet: found.snippet };
  }
  return GROUP_ORDER.flatMap(name => items.filter(item => item.group === name));
}

/** `text` cut at every place a word was found, so the palette can mark them.
 *  Case is the text's own; only the comparison is folded. */
export function markParts(text: string, words: string[]): { text: string; hit: boolean }[] {
  const lower = text.toLowerCase();
  const spans: [number, number][] = [];
  for (const word of words) {
    for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) spans.push([at, at + word.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push({ text: text.slice(cursor, from), hit: false });
    parts.push({ text: text.slice(from, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/** Anything on the page may ask for the palette — the rail's Search row does —
 *  without holding a reference to it. The same pattern as WORK_CHANGED. */
export const OPEN_SPOTLIGHT = "opc:open-spotlight";
export const openSpotlight = () => window.dispatchEvent(new Event(OPEN_SPOTLIGHT));

/** ⌘ where there is one. Read once: a keyboard does not change under a tab. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const SEARCH_KEYS = IS_MAC ? "⌘K" : "Ctrl K";
/** ⌃N AND NOT ⌘N ON THE LABEL. Both are bound, but a browser keeps ⌘N for its
 *  own new window and never shows it to the page; ⌃N is the one that arrives
 *  in a tab. A label naming a key that does nothing is the bug ⌘K used to be
 *  when it was printed on New chat and bound to nothing. */
export const NEW_MENU_KEYS = IS_MAC ? "⌃N" : "Ctrl N";
/** ⌃N opens the New menu rather than acting — see components/NewMenu.tsx. */
export const OPEN_NEW_MENU = "opc:open-new-menu";
