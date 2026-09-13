// Shared visual design with the sibling WorkDash chart kit.
import type { ReactNode } from "react"
import { clamp } from "./scale"

export type MeterMetric = {
  label: string

  value: number | null
}

export type MeterHost = {
  key: string
  name: string

  title?: string

  meta?: ReactNode

  dot?: string
  metrics: MeterMetric[]
  href?: string
}

type Props = {
  hosts: MeterHost[]

  thresholds?: { warn: number; crit: number }

  colors?: { ok: string; warn: string; crit: string }

  wrap?: (host: MeterHost, children: ReactNode) => ReactNode
  className?: string
}

export function Meters({
  hosts,
  thresholds = { warn: 60, crit: 80 },
  colors = {
    ok: "var(--color-ok-500)",
    warn: "var(--color-warn-500)",
    crit: "var(--color-crit-500)",
  },
  wrap,
  className,
}: Props) {
  const severity = (v: number) =>
    v >= thresholds.crit ? "crit" : v >= thresholds.warn ? "warn" : "ok"

  return (
    <div
      className={`grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3 ${className ?? ""}`}
    >
      {hosts.map((host) => {
        const tile = (
          <div className="rounded-xl border border-border bg-muted/60 p-3 transition hover:border-foreground/15 hover:shadow-raise">
            <div className="mb-2 flex items-center gap-1.5">
              {host.dot && (
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: host.dot }}
                />
              )}
              <span
                className="truncate text-xs font-semibold"
                title={host.title ?? host.name}
              >
                {host.name}
              </span>
              {host.meta && (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
                  {host.meta}
                </span>
              )}
            </div>
            {host.metrics.map((mm) => {
              const c = mm.value === null ? null : colors[severity(mm.value)]
              return (
                <div
                  key={mm.label}
                  className="mt-1.5 grid grid-cols-[30px_1fr_34px] items-center gap-2"
                >
                  <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {mm.label}
                  </span>
                  <div
                    className="relative h-1.5 overflow-hidden rounded-full"
                    style={{
                      background:
                        c === null
                          ? "var(--chart-grid)"
                          : `color-mix(in srgb, ${c} 16%, transparent)`,
                    }}
                  >
                    {mm.value !== null && (
                      <span
                        className="block h-full rounded-full transition-[width] duration-500 ease-out-quint"
                        style={{
                          width: `${clamp(mm.value, 0, 100)}%`,
                          background: c ?? undefined,
                        }}
                      />
                    )}
                    {[thresholds.warn, thresholds.crit].map((t) => (
                      <span
                        key={t}
                        aria-hidden="true"
                        className="absolute inset-y-0 w-px bg-foreground/15"
                        style={{ left: `${t}%` }}
                      />
                    ))}
                  </div>
                  <span className="text-right font-mono text-[10.5px] font-semibold text-muted-foreground tabular-nums">
                    {mm.value === null ? "—" : `${Math.round(mm.value)}%`}
                  </span>
                </div>
              )
            })}
          </div>
        )
        return (
          <div key={host.key} className="min-w-0">
            {wrap ? wrap(host, tile) : tile}
          </div>
        )
      })}
    </div>
  )
}
