// Shared visual design with the sibling WorkDash chart kit.
import type { ReactNode } from "react"
import { clamp } from "./scale"

export type TipState = {

  x: number

  y: number
  title: ReactNode
  rows: ReactNode
} | null

export function ChartTip({ tip, width }: { tip: TipState; width: number }) {
  if (!tip) return null
  // 90px of half-width is the widest this tooltip gets in practice; clamping
  // against a constant rather than measuring keeps this render pass free of
  // layout reads.
  const left = clamp(tip.x, 92, Math.max(92, width - 92))
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl bg-foreground px-2.5 py-1.5 text-[11.5px] leading-relaxed whitespace-nowrap text-background shadow-raise-lg"
      style={{ left, top: Math.max(44, tip.y - 10) }}
    >
      <div className="font-semibold">{tip.title}</div>
      <div className="text-background/70">{tip.rows}</div>
    </div>
  )
}

export function TipRow({
  label,
  value,
}: {
  label: string
  value: ReactNode
}) {
  return (
    <div>
      {label}{" "}
      <b className="font-semibold text-background tabular-nums">{value}</b>
    </div>
  )
}
