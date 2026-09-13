import { useId } from "react";
import { signalGeometry } from "./signalGeometry";
export function SignalChart({ points, label, unit }: { points: { day: string; value: number }[]; label: string; unit: string }) {
  const id = useId().replace(/:/g, ""), plot = signalGeometry(points);
  if (!plot) return <p className="journey-muted py-8">A chart appears after two measured days.</p>;
  const value = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1, notation: Math.abs(n) >= 10000 ? "compact" : "standard" });
  return <svg className="journey-chart" viewBox="0 0 430 170" role="img" aria-label={`${label}, ${plot.from} to ${plot.to}, ${unit}. ${points.length} measured days.`}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop stopColor="var(--journey-green)" stopOpacity=".2" /><stop offset="1" stopColor="var(--journey-green)" stopOpacity="0" /></linearGradient></defs>
    {plot.ticks.map(t => <g key={t.y}><line x1="48" x2="418" y1={t.y} y2={t.y} stroke="var(--border)" strokeDasharray="3 4" /><text x="40" y={t.y + 3} textAnchor="end">{value(t.value)}</text></g>)}
    {plot.segments.map((s, i) => <g key={i}><path d={`${s.line} L ${s.lastX} 137 L ${s.firstX} 137 Z`} fill={`url(#${id})`} /><path d={s.line} stroke="var(--journey-green)" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></g>)}
    {plot.points.map(p => <circle key={p.day} cx={p.x} cy={p.y} r="2.5" fill="var(--journey-green)"><title>{p.day}: {value(p.value)} {unit}</title></circle>)}
    <text x="48" y="161">{plot.from}</text><text x="418" y="161" textAnchor="end">{plot.to}</text>
  </svg>;
}
