// Shared visual design with the sibling WorkDash chart kit.
import { useState } from "react"
import type { TipState } from "./ChartTip"

export function useTip() {
  const [tip, setTip] = useState<TipState>(null)
  return { tip, show: setTip, hide: () => setTip(null) }
}
