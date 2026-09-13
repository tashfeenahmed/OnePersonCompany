// Shared visual design with the sibling WorkDash chart kit.
import { useLayoutEffect, useRef, useState, type RefObject } from "react"

export function useMeasuredWidth<T extends HTMLElement = HTMLDivElement>(): [
  RefObject<T | null>,
  number,
] {
  const ref = useRef<T | null>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const read = () => setWidth(Math.round(node.getBoundingClientRect().width))
    read()
    // ResizeObserver rather than a window listener: a chart inside a card
    // also changes width when the RAIL collapses or a sibling column folds,
    // and neither of those is a window resize.
    const ro = new ResizeObserver(read)
    ro.observe(node)
    return () => ro.disconnect()
  }, [])

  return [ref, width]
}
