/** Coalesce missed daily schedules into one catch-up, never an accumulated burst. */
export function dueDay(day: string, currentHour: number, scheduledHour: number, lastDueDay: string | null): string | null {
  if (!lastDueDay && currentHour < scheduledHour) return null;
  const candidate = currentHour >= scheduledHour ? day : new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return lastDueDay && lastDueDay >= candidate ? null : candidate;
}
