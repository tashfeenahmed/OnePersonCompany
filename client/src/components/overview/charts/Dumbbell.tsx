// Shared visual design with the sibling WorkDash chart kit.
import { type ReactNode } from "react"
import { ChartTip } from "./ChartTip"
import { useTip } from "./useTip"
import { useMeasuredWidth } from "./useMeasuredWidth"
import { compact } from "./scale"

export type DumbbellRow = {
  key: string
  label: string

  a: number
  b: number
  tip?: ReactNode
}

type Props = {
  rows: DumbbellRow[]
  label: string

  names: [string, string]
  colorA?: string
  colorB?: string

  log?: boolean

  domainMax?: number
  format?: (v: number) => string
  rowHeight?: number
  className?: string
}

export function Dumbbell({
  rows,
  label,
  names,
  colorA = "var(--chart-1)",
  colorB = "var(--chart-2)",
  log = false,
  domainMax,
  format = compact,
  rowHeight = 26,
  className,
}: Props) {
  const [ref, w] = useMeasuredWidth<HTMLDivElement>()
  const { tip, show, hide } = useTip()

  return (
    <div ref={ref} className={`relative w-full ${className ?? ""}`}>
      {w > 0 && rows.length > 0 && (() => {
        const m = {
          t: 6,
          r: 46,
          b: 24,
          l: Math.min(130, Math.max(90, w * 0.3)),
        }
        const ih = rows.length * rowHeight
        const H = m.t + ih + m.b
        const iw = w - m.l - m.r
        const hi =
          domainMax ?? Math.max(...rows.map((r) => Math.max(r.a, r.b))) * 1.6
        const X = log
          ? (v: number) => m.l + (Math.log10(Math.max(v, 1)) / Math.log10(hi)) * iw
          : (v: number) => m.l + (Math.max(v, 0) / hi) * iw

        // Log gridlines are the powers of ten inside the domain; a linear
        // axis gets four evenly spaced ones.
        const gridValues: number[] = []
        if (log) {
          for (let p = 1; Math.pow(10, p) <= hi + 1e-9; p++) {
            gridValues.push(Math.pow(10, p))
          }
        } else {
          for (let k = 1; k <= 4; k++) gridValues.push((hi / 4) * k)
        }

        return (
          <svg
            width={w}
            height={H}
            viewBox={`0 0 ${w} ${H}`}
            role="img"
            aria-label={`${label} — ${names[0]} and ${names[1]} per row${log ? ", log scale" : ""}`}
            className="block"
          >
            {gridValues.map((v) => (
              <g key={v}>
                <line
                  x1={X(v)}
                  x2={X(v)}
                  y1={m.t}
                  y2={m.t + ih}
                  stroke="var(--chart-grid)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={X(v)}
                  y={m.t + ih + 15}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontSize={10.5}
                  className="tabular-nums"
                >
                  {format(v)}
                </text>
              </g>
            ))}
            <line
              x1={m.l}
              x2={m.l}
              y1={m.t}
              y2={m.t + ih}
              stroke="var(--chart-axis)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />

            {rows.map((r, i) => {
              const y = m.t + i * rowHeight + rowHeight / 2
              const hot = tip !== null && tip.title === r.label
              return (
                <g
                  key={r.key}
                  onMouseEnter={() =>
                    show({
                      x: X(Math.max(r.a, r.b)),
                      y,
                      title: r.label,
                      rows:
                        r.tip ?? (
                          <>
                            {names[0]}{" "}
                            <b className="font-semibold text-background tabular-nums">
                              {format(r.a)}
                            </b>{" "}
                            · {names[1]}{" "}
                            <b className="font-semibold text-background tabular-nums">
                              {format(r.b)}
                            </b>
                          </>
                        ),
                    })
                  }
                  onMouseLeave={hide}
                >
                  <rect
                    x={0}
                    y={m.t + i * rowHeight}
                    width={w}
                    height={rowHeight}
                    rx={6}
                    fill={hot ? "var(--muted)" : "transparent"}
                  />
                  <text
                    x={m.l - 12}
                    y={y + 3.5}
                    textAnchor="end"
                    fill="var(--chart-label)"
                    fontSize={11.5}
                    fontWeight={560}
                  >
                    {r.label}
                  </text>
                  <line
                    x1={X(r.a)}
                    x2={X(r.b)}
                    y1={y}
                    y2={y}
                    stroke="var(--chart-axis)"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  {}
                  <circle
                    cx={X(r.b)}
                    cy={y}
                    r={4.5}
                    fill={colorB}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                  <circle
                    cx={X(r.a)}
                    cy={y}
                    r={4.5}
                    fill={colorA}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                  <text
                    x={X(Math.max(r.a, r.b)) + 10}
                    y={y + 3.5}
                    fill="var(--muted-foreground)"
                    fontSize={10.5}
                    className="tabular-nums"
                  >
                    {format(Math.max(r.a, r.b))}
                  </text>
                </g>
              )
            })}
          </svg>
        )
      })()}
      <ChartTip tip={tip} width={w} />
    </div>
  )
}
