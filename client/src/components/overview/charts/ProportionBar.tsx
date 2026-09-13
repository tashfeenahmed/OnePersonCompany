// Shared visual design with the sibling WorkDash chart kit.
export type Proportion = {
  key: string
  label: string
  value: number
  color: string

  ink?: string
}

type Props = {
  parts: Proportion[]

  label: string
  height?: number

  minLabelPct?: number
  format?: (share: number, p: Proportion) => string
  className?: string
}

export function ProportionBar({
  parts,
  label,
  height = 26,
  minLabelPct = 18,
  format = (share) => `${Math.round(share)}%`,
  className,
}: Props) {
  const total = parts.reduce((n, p) => n + Math.max(p.value, 0), 0)
  if (total <= 0) return null

  return (
    <div
      className={`flex gap-0.5 ${className ?? ""}`}
      style={{ height }}
      role="img"
      aria-label={`${label}: ${parts
        .map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`)
        .join(", ")}`}
    >
      {parts.map((p) => {
        const share = (Math.max(p.value, 0) / total) * 100
        if (share <= 0) return null
        return (
          <span
            key={p.key}
            className="flex items-center justify-center overflow-hidden rounded-sm text-[11px] font-semibold whitespace-nowrap transition-[flex-grow] duration-300 ease-out-quint"
            style={{
              flex: `${share} 1 0`,
              background: p.color,
              color: p.ink ?? "var(--color-onaccent)",
            }}
            title={`${p.label} · ${format(share, p)}`}
          >
            {share >= minLabelPct ? `${format(share, p)} ${p.label}` : ""}
          </span>
        )
      })}
    </div>
  )
}
