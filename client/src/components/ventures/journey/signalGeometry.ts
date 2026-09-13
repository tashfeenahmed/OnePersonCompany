/** Date-based x positions; missing days break the line instead of implying observations. */
export function signalGeometry(input: { day: string; value: number }[]) {
  const data = [...new Map(input.filter(p => Number.isFinite(p.value) && Number.isFinite(Date.parse(p.day))).map(p => [p.day, p])).values()].sort((a, b) => a.day.localeCompare(b.day));
  if (data.length < 2) return null;
  const min = Math.min(...data.map(p => p.value)), max = Math.max(...data.map(p => p.value));
  const pad = Math.max((max - min) * .16, Math.abs(max) * .02, 1), low = min - pad, high = max + pad;
  const start = Date.parse(data[0]!.day), span = Date.parse(data.at(-1)!.day) - start;
  if (!span) return null;
  const y = (n: number) => 12 + (high - n) / (high - low) * 125;
  const points = data.map(p => ({ ...p, x: 48 + (Date.parse(p.day) - start) / span * 370, y: y(p.value) }));
  const groups: typeof points[] = [];
  for (const p of points) {
    const group = groups.at(-1), last = group?.at(-1);
    if (!last || Date.parse(p.day) - Date.parse(last.day) > 86400000) groups.push([p]); else group!.push(p);
  }
  return { points, from: data[0]!.day, to: data.at(-1)!.day,
    ticks: [high, (low + high) / 2, low].map(value => ({ value, y: y(value) })),
    segments: groups.map(g => ({ line: g.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" "), firstX: g[0]!.x, lastX: g.at(-1)!.x })) };
}
