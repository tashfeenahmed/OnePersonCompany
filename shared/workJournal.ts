export const JOURNAL_KINDS = ["did", "shipped", "dismissed", "note"] as const;
export type JournalKind = typeof JOURNAL_KINDS[number];
export type JournalEntry = { id: number; day: string; kind: JournalKind; text: string; ventureId: string | null; createdAt: string; updatedAt: string };
export function calendarDay(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function shiftDay(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
}
export function validDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function workStats(counts: { day: string; n: number }[], today: string) {
  const days = new Map(counts.filter(d => d.day <= today && d.n > 0).map(d => [d.day, d.n]));
  let current = 0, best = 0, run = 0, previous = "";
  for (const day of [...days.keys()].sort()) {
    run = previous && shiftDay(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run); previous = day;
  }
  for (let cursor = days.has(today) ? today : shiftDay(today, -1); days.has(cursor); cursor = shiftDay(cursor, -1)) current++;
  return { current, best, today: days.get(today) ?? 0, heatmap: Array.from({ length: 91 }, (_, i) => {
    const day = shiftDay(today, i - 90); return { day, n: days.get(day) ?? 0 };
  }) };
}
export type JournalReport = { timezone: string; today: string; entries: JournalEntry[]; stats: ReturnType<typeof workStats>; total: number };
