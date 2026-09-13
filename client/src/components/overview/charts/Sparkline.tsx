// Shared visual design with the sibling WorkDash chart kit.
import { useId } from "react"

export type SparkPoint = {

  value: number | null
}

type Props = {
  data: SparkPoint[]

  label: string
  width?: number
  height?: number
  color?: string

  area?: boolean

  baseline?: "zero" | "min"
  className?: string
}

export function Sparkline({
  data,
  label,
  width = 72,
  height = 20,
  color = "var(--chart-line-1)",
  area = false,
  baseline = "zero",
  className,
}: Props) {
  const id = useId().replace(/:/g, "")
  const known = data.filter((d): d is { value: number } => d.value !== null)
  if (known.length < 2) return null

  const values = known.map((d) => d.value)
  const max = Math.max(...values)
  const min = baseline === "zero" ? 0 : Math.min(...values)
  const span = max - min
  // A range under 0.5% of the magnitude is noise at this size; drawing it
  // scaled would turn rounding into a trend.
  const flat = span === 0 || span / Math.max(Math.abs(max), 1) < 0.005

  const pad = 2
  const x = (i: number) => pad + (i / (data.length - 1)) * (width - pad * 2)
  const y = (v: number) =>
    flat ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2)

  // Split into runs of consecutive readings; each run is its own path.
  const runs: { i: number; v: number }[][] = []
  let run: { i: number; v: number }[] = []
  data.forEach((d, i) => {
    if (d.value === null) {
      if (run.length) runs.push(run)
      run = []
    } else {
      run.push({ i, v: d.value })
    }
  })
  if (run.length) runs.push(run)

  const lastRun = runs[runs.length - 1]
  const lastPoint = lastRun[lastRun.length - 1]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`block shrink-0 overflow-visible ${className ?? ""}`}
      role="img"
      aria-label={`${label}: ${values[0]} to ${values[values.length - 1]} over ${data.length} points${known.length < data.length ? `, ${data.length - known.length} not reported` : ""}`}
    >
      {area && (
        <defs>
          <linearGradient id={`sp-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {runs.map((r, k) => {
        if (r.length === 1) {
          return (
            <circle
              key={k}
              cx={x(r[0].i)}
              cy={y(r[0].v)}
              r={1.6}
              fill={color}
              opacity={0.8}
            />
          )
        }
        const d = r
          .map((p, j) => `${j ? "L" : "M"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`)
          .join("")
        return (
          <g key={k}>
            {area && (
              <path
                d={`M${x(r[0].i).toFixed(1)},${height}L${d.slice(1)}L${x(r[r.length - 1].i).toFixed(1)},${height}Z`}
                fill={`url(#sp-${id})`}
              />
            )}
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={flat ? 0.45 : 1}
            />
          </g>
        )
      })}
      {}
      {!flat && <circle cx={x(lastPoint.i)} cy={y(lastPoint.v)} r={1.75} fill={color} />}
    </svg>
  )
}
