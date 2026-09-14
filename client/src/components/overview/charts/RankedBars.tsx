// Shared visual design with the sibling WorkDash chart kit.
import { ChartTip } from "./ChartTip"
import { useTip } from "./useTip"
import { useMeasuredWidth } from "./useMeasuredWidth"
import { textWidth, usd } from "./scale"

export type RankedBar = {
  key: string
  label: string

  sub?: string

  value: number | null

  empty?: string
  color?: string
}

type Props = {
  bars: RankedBar[]
  label: string
  format?: (v: number) => string

  max?: number
  className?: string
}

export function RankedBars({
  bars,
  label,
  format = (v) => usd(v),
  max,
  className,
}: Props) {
  const [ref, w] = useMeasuredWidth<HTMLDivElement>()
  const { tip, show, hide, point, pinned, unpin } = useTip(JSON.stringify(bars))

  const rowH = 46
  const H = bars.length * rowH

  return (
    <div ref={ref} className={`relative w-full ${className ?? ""}`}>
      {w > 0 && bars.length > 0 && (() => {
        const top =
          max ?? Math.max(1, ...bars.map((b) => (b.value === null ? 0 : b.value)))
        return (
          <svg
            width={w}
            height={H}
            viewBox={`0 0 ${w} ${H}`}
            role="group"
            aria-label={label}
            className="block"
          >
            {bars.map((b, i) => {
              const y = i * rowH
              const color = b.color ?? "var(--chart-line-1)"
              const bw = b.value === null ? 0 : (b.value / top) * w
              const text = b.value === null ? "" : format(b.value)
              // "Fits inside" is measured against an estimate that errs wide,
              // so the failure mode is a label placed outside a bar it would
              // just have fitted — never a label clipped by its own bar.
              const inside = bw > textWidth(text, 11.5) + 20
              return (
                <g
                  key={b.key}
                  {...point(() =>
                    show({
                      x: Math.min(bw, w - 20),
                      y: y + 20,
                      title: b.label,
                      rows:
                        b.value === null
                          ? (b.empty ?? "not reported")
                          : format(b.value),
                    })
                  , `Inspect ${b.label}`)}
                  onPointerLeave={hide}
                >
                  <rect x={0} y={y} width={w} height={rowH} fill="transparent" />
                  <text
                    x={0}
                    y={y + 12}
                    fill="var(--foreground)"
                    fontSize={12.5}
                    fontWeight={620}
                  >
                    {b.label}
                  </text>
                  {b.sub && (
                    <text
                      x={w}
                      y={y + 12}
                      textAnchor="end"
                      fill="var(--muted-foreground)"
                      fontSize={10.5}
                      className="tabular-nums"
                    >
                      {b.sub}
                    </text>
                  )}
                  {b.value === null ? (
                    <text
                      x={0}
                      y={y + 31}
                      fill="var(--muted-foreground)"
                      fontSize={11.5}
                    >
                      {b.empty ?? "not reported"}
                    </text>
                  ) : (
                    <>
                        <rect
                        x={0}
                        y={y + 20}
                        width={w}
                        height={12}
                        rx={6}
                        fill="var(--line-soft)"
                      />
                      <rect
                        x={0}
                        y={y + 20}
                        width={Math.max(bw, 3)}
                        height={12}
                        rx={6}
                        fill={color}
                      />
                      <text
                        x={inside ? bw - 9 : bw + 9}
                        y={y + 30}
                        textAnchor={inside ? "end" : "start"}

                        fill={inside ? "var(--primary-foreground)" : "var(--foreground)"}
                        fontSize={11.5}
                        fontWeight={620}
                        className="tabular-nums"
                      >
                        {text}
                      </text>
                    </>
                  )}
                </g>
              )
            })}
          </svg>
        )
      })()}
      <ChartTip pinned={pinned} onUnpin={unpin} tip={tip} width={w} />
    </div>
  )
}
