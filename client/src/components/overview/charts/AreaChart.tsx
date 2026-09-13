// Shared visual design with the sibling WorkDash chart kit.
import { useId, type ReactNode } from "react"
import { ChartTip } from "./ChartTip"
import { useTip } from "./useTip"
import { useMeasuredWidth } from "./useMeasuredWidth"
import {
  clamp,
  compact,
  dayFull,
  dayShort,
  niceScale,
  ticks,
  usd,
  usd0,
} from "./scale"

export type AreaPoint = {

  date: string
  value: number
}

type Props = {
  data: AreaPoint[]

  label: string
  height?: number

  color?: string

  format?: (v: number) => string

  axisFormat?: (v: number) => string

  mean?: boolean
  meanLabel?: (v: number) => string

  annotate?: boolean

  tipRows?: (p: AreaPoint, i: number) => ReactNode
  className?: string
}

export function AreaChart({
  data,
  label,
  height,
  color = "var(--primary)",
  format = (v) => usd(v),
  axisFormat = (v) => (v === 0 ? "$0" : `$${compact(v)}`),
  mean = false,
  meanLabel = (v) => `mean ${usd0(v)}/day`,
  annotate = true,
  tipRows,
  className,
}: Props) {
  const id = useId().replace(/:/g, "")
  const [ref, w] = useMeasuredWidth<HTMLDivElement>()
  const { tip, show, hide } = useTip()

  const H = height ?? (w > 0 && w < 760 ? 250 : 300)
  const m = { t: 22, r: 16, b: 26, l: 54 }

  return (
    <div ref={ref} className={`relative w-full ${className ?? ""}`}>
      {}
      {w > 0 && data.length > 0 && (() => {
        const iw = w - m.l - m.r
        const ih = H - m.t - m.b
        const values = data.map((d) => d.value)
        const maxV = Math.max(...values)
        const sc = niceScale(maxV, 4)
        const X = (i: number) =>
          m.l + (data.length === 1 ? iw / 2 : (i * iw) / (data.length - 1))
        const Y = (v: number) => m.t + ih - (v / sc.max) * ih

        const line = data
          .map((d, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(d.value).toFixed(1)}`)
          .join("")
        const area =
          `M${X(0).toFixed(1)},${Y(0)}L` +
          line.slice(1) +
          `L${X(data.length - 1).toFixed(1)},${Y(0)}Z`

        const avg = values.reduce((a, b) => a + b, 0) / values.length
        const peak = values.indexOf(maxV)
        const last = data.length - 1

        // Month starts carry the x axis; the final day is labelled too so the
        // right edge says when "now" is.
        const months: number[] = []
        let seen: string | null = null
        data.forEach((d, i) => {
          const mo = d.date.slice(0, 7)
          if (mo !== seen) {
            seen = mo
            months.push(i)
          }
        })

        const pick = (px: number) =>
          clamp(Math.round(((px - m.l) / iw) * (data.length - 1)), 0, last)

        return (
          <svg
            width={w}
            height={H}
            viewBox={`0 0 ${w} ${H}`}
            role="img"
            aria-label={`${label}, ${dayShort(data[0].date)} to ${dayShort(data[last].date)}`}
            className="block overflow-visible"
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect()
              const i = pick(e.clientX - box.left)
              const d = data[i]
              show({
                x: X(i),
                y: Y(d.value),
                title: dayFull(d.date),
                rows: (
                  <>
                    <div>
                      <b className="font-semibold text-background tabular-nums">
                        {format(d.value)}
                      </b>
                    </div>
                    {tipRows?.(d, i)}
                  </>
                ),
              })
            }}
            onMouseLeave={hide}
          >
            <defs>
              {}
              <linearGradient id={`ar-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="62%" stopColor={color} stopOpacity={0.1} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>

            {ticks(sc).map((v) => (
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

            {months.map((i) => (
              <g key={i}>
                {i > 2 && (
                  <line
                    x1={X(i)}
                    x2={X(i)}
                    y1={m.t}
                    y2={m.t + ih}
                    stroke="var(--chart-grid)"
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                )}
                {i < data.length - 7 && (
                  <text
                    x={X(i) + 4}
                    y={m.t + ih + 16}
                    fill="var(--muted-foreground)"
                    fontSize={10.5}
                  >
                    {new Date(`${data[i].date}T00:00:00Z`).toLocaleDateString(
                      "en-GB",
                      { month: "short", timeZone: "UTC" },
                    )}
                  </text>
                )}
              </g>
            ))}
            <text
              x={m.l + iw}
              y={m.t + ih + 16}
              textAnchor="end"
              fill="var(--muted-foreground)"
              fontSize={10.5}
            >
              {dayShort(data[last].date)}
            </text>

            <path d={area} fill={`url(#ar-${id})`} />
            <path
              d={line}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {mean && (
              <>
                <line
                  x1={m.l}
                  x2={m.l + iw}
                  y1={Y(avg)}
                  y2={Y(avg)}
                  stroke="var(--muted-foreground)"
                  strokeWidth={1}
                  strokeDasharray="3 4"
                  opacity={0.8}
                />
                <text
                  x={m.l + 6}
                  y={Y(avg) - 6}
                  fill="var(--muted-foreground)"
                  fontSize={10.5}
                  className="tabular-nums"
                >
                  {meanLabel(avg)}
                </text>
              </>
            )}

            {}
            {annotate &&
              [
                { i: peak, anchor: "middle" as const },
                { i: last, anchor: "end" as const },
              ]
                .filter((p, k) => k === 0 || Math.abs(p.i - peak) >= 3)
                .map((p) => (
                  <g key={p.i}>
                    <circle
                      cx={X(p.i)}
                      cy={Y(data[p.i].value)}
                      r={4.5}
                      fill={color}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                    <text
                      x={X(p.i) + (p.anchor === "end" ? 6 : 0)}
                      y={Y(data[p.i].value) - 14}
                      textAnchor={p.anchor}
                      fill="var(--foreground)"
                      fontSize={11.5}
                      fontWeight={640}
                      className="tabular-nums"
                    >
                      {format(data[p.i].value)}
                    </text>
                  </g>
                ))}

            {tip && (
              <g>
                <line
                  x1={tip.x}
                  x2={tip.x}
                  y1={m.t}
                  y2={m.t + ih}
                  stroke={color}
                  strokeWidth={1}
                  opacity={0.45}
                />
                <circle
                  cx={tip.x}
                  cy={tip.y}
                  r={5}
                  fill={color}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>
        )
      })()}
      <ChartTip tip={tip} width={w} />
    </div>
  )
}
