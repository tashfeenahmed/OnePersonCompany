import { useRef, useState, type KeyboardEvent } from "react";
import type { TipState } from "./ChartTip";

/** One interaction for chart values: hover, focus, tap to pin, Escape to clear. */
export function useTip(resetKey?: string) {
  const [tip, setTip] = useState<TipState>(null);
  const [pinned, setPinned] = useState(false);
  const current = useRef<{ key?: string; value: TipState }>({ value: null });
  const [version, setVersion] = useState(resetKey);
  if (version !== resetKey) { setVersion(resetKey); setTip(null); setPinned(false); }
  const show = (next: TipState) => { current.current = { key: resetKey, value: next }; if (!pinned) setTip(next); };
  const hide = () => { if (!pinned) setTip(null); };
  const unpin = () => { setPinned(false); setTip(null); };
  const pin = () => {
    if (current.current.key !== resetKey || !current.current.value) return;
    if (pinned && tip?.x === current.current.value.x && tip?.y === current.current.value.y && tip?.title === current.current.value.title) unpin();
    else { setTip(current.current.value); setPinned(true); }
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); unpin(); }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pin(); }
  };
  const point = (enter: () => void, label = "Inspect chart value") => ({
    tabIndex: 0, role: "button", "aria-label": label,
    onPointerEnter: enter, onPointerDown: enter, onFocus: enter,
    onPointerLeave: hide, onBlur: hide, onClick: pin, onKeyDown: keys,
    "data-chart-point": true,
  });
  return { tip, show, hide, pin, unpin, pinned, point, keys };
}
