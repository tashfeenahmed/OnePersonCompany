import { db, now } from "../db.ts";
import { fileCard } from "../routes/board.ts";

export type BoardCandidate = {
  origin: string;
  title: string;
  detail: string;
  href: string;
  observedAt: string;
  ventureId?: string | null;
  urgency?: number;
  aliases?: string[];
};
export type BoardSource = {
  id: string;
  label: string;
  read: () => BoardCandidate[] | Promise<BoardCandidate[]>;
};
const sources = new Map<string, BoardSource>();
/** Sources read completed local data only. Register one adapter per feed. */
export function registerBoardSource(source: BoardSource) { sources.set(source.id, source); }

function settings() {
  return db.prepare("SELECT * FROM board_automation WHERE id=1").get() as {
    enabled: number; disabled_sources: string; checked_at: string | null;
    filed: number; errors: string;
  };
}
export function boardAutomationStatus() {
  const s = settings(), disabled = new Set<string>(JSON.parse(s.disabled_sources));
  return { enabled: !!s.enabled, sources: [...sources.values()].map(source => ({
    id: source.id, label: source.label, enabled: !disabled.has(source.id),
  })), checkedAt: s.checked_at, lastFiled: s.filed, errors: JSON.parse(s.errors) as string[], running: !!flight,
  totalFiled: (db.prepare("SELECT count(*) AS n FROM board_automation_filings").get() as { n: number }).n };
}
export function configureBoardAutomation(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected automation settings.");
  const patch = body as { enabled?: unknown; sources?: unknown };
  if (Object.keys(patch).some(k => k !== "enabled" && k !== "sources")) throw new Error("Unknown automation setting.");
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be true or false.");
  const s = settings(), disabled = new Set<string>(JSON.parse(s.disabled_sources));
  if (patch.sources !== undefined) {
    if (!patch.sources || typeof patch.sources !== "object" || Array.isArray(patch.sources)) throw new Error("sources must map source IDs to true or false.");
    for (const [id, on] of Object.entries(patch.sources)) {
      if (!sources.has(id) || typeof on !== "boolean") throw new Error("Choose a known source and true or false.");
      if (on) disabled.delete(id); else disabled.add(id);
    }
  }
  db.prepare("UPDATE board_automation SET enabled=?, disabled_sources=? WHERE id=1")
    .run(patch.enabled === undefined ? s.enabled : Number(patch.enabled), JSON.stringify([...disabled]));
  return boardAutomationStatus();
}

const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();
let flight: Promise<{ filed: number; errors: string[] }> | null = null;

/** Repeated timers, manual checks and concurrent tabs share one pass. Database
 * origins and a durable filing receipt also protect across process restarts. */
export function syncBoardCards() {
  if (flight) return flight;
  flight = sweep().finally(() => { flight = null; });
  return flight;
}
async function sweep() {
  if (!settings().enabled) return { filed: 0, errors: [] };
  const errors: string[] = [];
  let filed = 0;
  for (const source of sources.values()) {
    const s = settings();
    if (!s.enabled) break;
    if ((JSON.parse(s.disabled_sources) as string[]).includes(source.id)) continue;
    try {
      const candidates = await source.read();
      // A pause while an adapter was reading takes effect before any writes.
      const current = settings();
      if (!current.enabled) break;
      if ((JSON.parse(current.disabled_sources) as string[]).includes(source.id)) continue;
      db.exec("BEGIN IMMEDIATE");
      const filedBeforeSource = filed;
      try {
        const existing = db.prepare("SELECT id,origin,title,venture_id FROM board_cards").all() as {
          id: number; origin: string | null; title: string; venture_id: string | null;
        }[];
        const held = new Set((db.prepare("SELECT origin FROM board_automation_filings").all() as { origin: string }[]).map(r => r.origin));
        for (const c of candidates) {
          if (filed >= 25) break;
          if (!c.origin || c.origin.length > 180 || !c.title?.trim() || !c.detail?.trim() ||
              !/^\/(?!\/)/.test(c.href) || !Number.isFinite(Date.parse(c.observedAt))) continue;
          if (held.has(c.origin)) continue;
          // Also respect a card filed manually from the same source or report.
          const duplicate = existing.find(r => r.origin === c.origin || (r.origin !== null && c.aliases?.includes(r.origin)) ||
            (r.origin === null && r.venture_id === (c.ventureId ?? null) && titleKey(r.title) === titleKey(c.title.slice(0, 200))));
          let id = duplicate?.id;
          if (!id) {
            const result = fileCard({ origin: c.origin, title: c.title,
              body: `${c.detail.slice(0, 7000)}\n\n[View source](${c.href})\n\nFiled automatically from ${source.label}. Snapshot observed ${c.observedAt}; figures are not live.`,
              ventureId: c.ventureId, urgency: Math.max(0, Math.min(3, Math.round(c.urgency ?? 1))) });
            if (result.filed) filed++;
            const row = db.prepare("SELECT id FROM board_cards WHERE origin=?").get(c.origin) as { id: number };
            id = row.id;
            existing.push({ id, origin: c.origin, title: c.title.slice(0, 200), venture_id: c.ventureId ?? null });
          }
          db.prepare("INSERT INTO board_automation_filings(origin,card_id,source,filed_at) VALUES(?,?,?,?) ON CONFLICT(origin) DO UPDATE SET card_id=excluded.card_id")
            .run(c.origin, id, source.id, now());
          held.add(c.origin);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); filed = filedBeforeSource; throw error; }
    } catch { errors.push(`${source.label} could not be checked. Existing cards were kept.`); }
  }
  db.prepare("UPDATE board_automation SET checked_at=?,filed=?,errors=? WHERE id=1").run(now(), filed, JSON.stringify(errors));
  return { filed, errors };
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startBoardAutomation() {
  if (timer) return;
  const check = () => { void syncBoardCards().catch(error => console.error("[board] automatic filing failed", error)); };
  timer = setInterval(check, 60_000);
  timer.unref();
  setTimeout(check, 5_000).unref();
}
