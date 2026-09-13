// Shared visual design with the sibling WorkDash chart kit.
import { type ReactNode } from "react"
import { ChartTip } from "./ChartTip"
import { useTip } from "./useTip"
import { useMeasuredWidth } from "./useMeasuredWidth"
import { barPath, compact, niceScale, ticks, usd } from "./scale"

export type WaterfallBar = {
  key: string

  label: string

  sub?: string

  from: number
  to: number

  value: number
  color: string

  connect?: boolean
  tip?: ReactNode
}

type Props = {
  bars: WaterfallBar[]
  label: string
  height?: number
  format?: (v: number) => string
  axisFormat?: (v: number) => string

  maxWidth?: number
  className?: string
}

export function Waterfall({
  bars,
  label,
  height = 236,
  format = (v) => usd(Math.abs(v)),
  axisFormat = (v) => (v === 0 ? "$0" : `$${compact(v)}`),
  maxWidth = 560,
  className,
}: Props) {
  const [ref, measured] = useMeasuredWidth<HTMLDivElement>()
  const { tip, show, hide } = useTip()
  const m = { t: 34, r: 10, b: 42, l: 52 }

  return (
    <div ref={ref} className={`relative w-full ${className ?? ""}`}>
      {measured > 0 && bars.length > 0 && (() => {
        const w = Math.min(measured, maxWidth)
        const iw = w - m.l - m.r
        const ih = height - m.t - m.b
        const top = Math.max(...bars.map((b) => Math.max(b.from, b.to)))
        const sc = niceScale(top, 4)

        const floor = Math.min(0, ...bars.map((b) => Math.min(b.from, b.to)))
        const lo = floor < 0 ? -Math.ceil(-floor / sc.step) * sc.step : 0
        const span = sc.max - lo
        const Y = (v: number) => m.t + ih - ((v - lo) / span) * ih
        const axisTicks = ticks(sc).concat(
          lo < 0
            ? Array.from(
                { length: Math.round(-lo / sc.step) },
                (_, k) => -(k + 1) * sc.step,
              )
            : [],
        )
        const slot = iw / bars.length
        const bw = Math.min(24, iw / (bars.length * 2))
        const cx = (i: number) => m.l + slot * i + slot / 2

        return (
          <svg
            width={w}
            height={height}
            viewBox={`0 0 ${w} ${height}`}
            role="img"
            aria-label={label}
            className="block overflow-visible"
          >
            {axisTicks.map((v) => (
              <g key={v}>
                <line
                  x1={m.l}
                  x2={m.l + iw}
                  y1={Y(v)}
                  y2={Y(v)}
                  stroke={v === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={m.l - 10}
                  y={Y(v) + 3.5}
                  textAnchor="end"
                  fill="var(--muted-foreground)"
                  fontSize={10.5}
                  className="tabular-nums"
                >
                  {axisFormat(v)}
                </text>
              </g>
            ))}

            {bars.map((b, i) => {
              if (!b.connect || i === bars.length - 1) return null
              // The connector leaves at the height this step ENDS on, which
              // is where the next one picks the total up.
              const y = Y(Math.max(b.from, b.to))
              return (
                <line
                  key={`c-${b.key}`}
                  x1={cx(i) + bw / 2}
                  x2={cx(i + 1) - bw / 2}
                  y1={y}
                  y2={y}
                  stroke="var(--chart-axis)"
                  strokeWidth={1}
                />
              )
            })}

            {bars.map((b, i) => {
              const yTop = Y(Math.max(b.from, b.to))
              const yBot = Y(Math.min(b.from, b.to))
              const h = Math.max(3, yBot - yTop)
              // A drop hangs from above, so it is rounded at the BOTTOM —
              // the rounded end is always the data end.
              const drop = b.value < 0
              const dim = tip !== null && tip.title !== b.label
              return (
                <g
                  key={b.key}
                  onMouseEnter={() =>
                    show({
                      x: cx(i),
                      y: yTop,
                      title: b.label,
                      rows: b.tip ?? format(b.value),
                    })
                  }
                  onMouseLeave={hide}
                >
                  <path
                    d={barPath(cx(i) - bw / 2, yTop, bw, h, drop ? 0 : 4, drop ? 4 : 0)}
                    fill={b.color}
                    opacity={dim ? 0.35 : 1}
                    className="transition-opacity duration-150"
                  />
                  <text
                    x={cx(i)}
                    y={yTop - 10}
                    textAnchor="middle"
                    fill="var(--foreground)"
                    fontSize={11.5}
                    fontWeight={640}
                    className="tabular-nums"
                  >
                    {b.value > 0 ? "+" : b.value < 0 ? "−" : ""}
                    {format(Math.abs(b.value))}
                  </text>
                  <text
                    x={cx(i)}
                    y={m.t + ih + 17}
                    textAnchor="middle"
                    fill="var(--chart-label)"
                    fontSize={11}
                    fontWeight={600}
                  >
                    {b.label}
                  </text>
                  {b.sub && (
                    <text
                      x={cx(i)}
                      y={m.t + ih + 31}
                      textAnchor="middle"
                      fill="var(--muted-foreground)"
                      fontSize={10.5}
                    >
                      {b.sub}
                    </text>
                  )}
                  {}
                  <rect
                    x={cx(i) - slot / 2}
                    y={m.t}
                    width={slot}
                    height={ih}
                    fill="transparent"
                  />
                </g>
              )
            })}
          </svg>
        )
      })()}
      <ChartTip tip={tip} width={Math.min(measured, maxWidth)} />
    </div>
  )
}
