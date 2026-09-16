/** Find the next wall-clock minute, including half/quarter-hour zones and DST. */
export function nextZonedTime(timezone: string, hour: number, minute: number, from = new Date()): string {
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 48 * 60; i++) {
    const at = new Date(start + i * 60_000);
    const parts = clock.formatToParts(at);
    if (Number(parts.find(p => p.type === "hour")?.value) === hour
      && Number(parts.find(p => p.type === "minute")?.value) === minute) return at.toISOString();
  }
  throw new Error("No matching local time in the next two days.");
}
