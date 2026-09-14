// Shared visual design with the sibling WorkDash chart kit.
import { ChartTip } from "./ChartTip"
import { useTip } from "./useTip"
import { useMeasuredWidth } from "./useMeasuredWidth"
import { pct, usd } from "./scale"

export type DonutSlice = {
  key: string
  label: string
  value: number

  color: string
}

type Props = {
  slices: DonutSlice[]
  label: string
  height?: number

  total?: number
  centerFormat?: (v: number) => string
  centerNote?: string
  format?: (v: number) => string

  active?: string | null
  onActive?: (key: string | null) => void
  className?: string
}

export function Donut({
  slices,
  label,
  height = 238,
  total,
  centerFormat = (v) => usd(v, 0),
  centerNote = "per month",
  format = (v) => usd(v),
  active,
  onActive,
  className,
}: Props) {
  const [ref, w] = useMeasuredWidth<HTMLDivElement>()
  const { tip, show, hide, point, pinned, unpin } = useTip(JSON.stringify(slices))
  const sum = total ?? slices.reduce((n, s) => n + s.value, 0)

  return (
    <div ref={ref} className={`relative w-full ${className ?? ""}`}>
      {w > 0 && slices.length > 0 && sum > 0 && (() => {
        const H = Math.min(height, Math.max(190, w))
        const cx = w / 2
        const cy = H / 2
        const R = Math.min(w, H) / 2 - 8
        const rIn = R * 0.63
        const gap = 2 / R

        let a0 = -Math.PI / 2
        const arcs = slices.map((s) => {
          const sweep = (s.value / sum) * Math.PI * 2
          const s0 = a0 + gap / 2
          const s1 = a0 + sweep - gap / 2
          a0 += sweep
          const large = s1 - s0 > Math.PI ? 1 : 0
          const d =
            `M${cx + R * Math.cos(s0)},${cy + R * Math.sin(s0)}` +
            `A${R},${R} 0 ${large} 1 ${cx + R * Math.cos(s1)},${cy + R * Math.sin(s1)}` +
            `L${cx + rIn * Math.cos(s1)},${cy + rIn * Math.sin(s1)}` +
            `A${rIn},${rIn} 0 ${large} 0 ${cx + rIn * Math.cos(s0)},${cy + rIn * Math.sin(s0)}Z`
          return { s, d, mid: (s0 + s1) / 2 }
        })

        return (
          <svg
            width={w}
            height={H}
            viewBox={`0 0 ${w} ${H}`}
            role="group"
            aria-label={label}
            className="block"
          >
            {arcs.map(({ s, d, mid }) => (
              <path
                key={s.key}
                d={d}
                fill={s.color}
                opacity={active && active !== s.key ? 0.32 : 1}
                className="transition-opacity duration-150"
                {...point(() => {
                  onActive?.(s.key)
                  show({
                    x: cx + (R + 6) * Math.cos(mid),
                    y: cy + (R + 6) * Math.sin(mid),
                    title: s.label,
                    rows: (
                      <>
                        <b className="font-semibold text-background tabular-nums">
                          {format(s.value)}
                        </b>{" "}
                        ·{" "}
                        <b className="font-semibold text-background tabular-nums">
                          {pct((s.value / sum) * 100)}
                        </b>{" "}
                        of the total
                      </>
                    ),
                  })
                }, `Inspect ${s.label}: ${format(s.value)}`)}
                onPointerLeave={() => {
                  onActive?.(null)
                  hide()
                }}
              />
            ))}
            <text
              x={cx}
              y={cy - 1}
              textAnchor="middle"
              fill="var(--foreground)"
              fontSize={22}
              fontWeight={660}
              letterSpacing="-0.02em"
              className="tabular-nums"
            >
              {centerFormat(sum)}
            </text>
            <text
              x={cx}
              y={cy + 16}
              textAnchor="middle"
              fill="var(--muted-foreground)"
              fontSize={10.5}
            >
              {centerNote}
            </text>
          </svg>
        )
      })()}
      <ChartTip pinned={pinned} onUnpin={unpin} tip={tip} width={w} />
    </div>
  )
}
