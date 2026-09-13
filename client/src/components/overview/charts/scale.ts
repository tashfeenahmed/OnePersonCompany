// Shared visual design with the sibling WorkDash chart kit.


export type Scale = { max: number; step: number }

export function niceScale(max: number, targetTicks = 4): Scale {
  if (!(max > 0)) return { max: 1, step: 1 }
  const raw = max / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step =
    (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) *
    mag
  return { max: Math.ceil(max / step) * step, step }
}

export function ticks(sc: Scale): number[] {
  const out: number[] = []
  // The epsilon is floating-point insurance: 0.1 + 0.2 + ... eventually
  // lands a hair over max and drops the top gridline without it.
  for (let v = 0; v <= sc.max + 1e-9; v += sc.step) out.push(v)
  return out
}

export function barPath(
  x: number,
  y: number,
  w: number,
  h: number,
  rTop: number,
  rBot: number,
): string {
  const r1 = Math.max(0, Math.min(rTop, w / 2, h))
  const r2 = Math.max(0, Math.min(rBot, w / 2, h))
  return (
    `M${x},${y + r1}` +
    `a${r1},${r1} 0 0 1 ${r1},${-r1}` +
    `h${w - 2 * r1}` +
    `a${r1},${r1} 0 0 1 ${r1},${r1}` +
    `v${h - r1 - r2}` +
    `a${r2},${r2} 0 0 1 ${-r2},${r2}` +
    `h${-(w - 2 * r2)}` +
    `a${r2},${r2} 0 0 1 ${-r2},${-r2}Z`
  )
}

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v))

export const usd = (n: number, digits = 2) =>
  `$${Number(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`

export const usd0 = (n: number) =>
  `$${Math.round(Number(n)).toLocaleString("en-US")}`

export const num = (n: number) => Number(n).toLocaleString("en-US")

export function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`
  return String(Math.round(n))
}

export const pct = (n: number, digits = 1) => `${Number(n).toFixed(digits)}%`

export const dayShort = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  })

export const dayFull = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })

export const textWidth = (s: string, fontSize: number) =>
  s.length * fontSize * 0.54
