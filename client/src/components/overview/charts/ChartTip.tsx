// Shared visual design with the sibling WorkDash chart kit.
import { X } from "lucide-react";
import type { ReactNode } from "react"
import { clamp } from "./scale"

export type TipState = {

  x: number

  y: number
  title: ReactNode
  rows: ReactNode
} | null

export function ChartTip({ tip, width, pinned = false, onUnpin }: { tip: TipState; width: number; pinned?: boolean; onUnpin?: () => void }) {
  if (!tip) return null
  // 90px of half-width is the widest this tooltip gets in practice; clamping
  // against a constant rather than measuring keeps this render pass free of
  // layout reads.
  const left = clamp(tip.x, 92, Math.max(92, width - 92))
  return (
    <div
      aria-hidden={pinned ? undefined : true}
      role={pinned ? "status" : undefined}
      data-chart-pinned={pinned || undefined}
      className={`absolute z-10 -translate-x-1/2 -translate-y-full rounded-xl bg-foreground px-2.5 py-1.5 text-[11.5px] leading-relaxed text-background shadow-raise-lg ${pinned ? "pointer-events-auto" : "pointer-events-none"}`}
      style={{ left, top: Math.max(72, tip.y - 10), maxWidth: Math.max(160, width - 12) }}
    >
      <div className="flex items-start gap-3"><div className="font-semibold">{tip.title}</div>{pinned && <button type="button" aria-label="Unpin chart value" className="ml-auto shrink-0 rounded p-0.5 hover:bg-background/15 focus-visible:outline-2" onClick={onUnpin}><X className="size-3"/></button>}</div>
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
