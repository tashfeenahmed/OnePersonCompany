import { useLayoutEffect, useRef, type RefObject } from "react";

/** Animate positions after a committed reorder; the DOM order remains authoritative. */
export function useReorderMotion(ref: RefObject<HTMLElement | null>, order: string, attribute: string) {
  const previous = useRef(new Map<string, { x: number; y: number }>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const host = root.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    const animations: Animation[] = [];
    root.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach(el => {
      const key = el.getAttribute(attribute)!;
      const rect = el.getBoundingClientRect();
      const point = { x: rect.left - host.left, y: rect.top - host.top };
      const before = previous.current.get(key); next.set(key, point);
      if (before && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const x = before.x-point.x, y = before.y-point.y;
        if (Math.abs(x)+Math.abs(y)>1) animations.push(el.animate([{ transform: `translate(${x}px,${y}px)` }, { transform: "translate(0,0)" }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" }));
      }
    });
    previous.current = next;
    const measure = () => {
      if (animations.some(a => a.playState === "running")) return;
      const r = root.getBoundingClientRect();
      root.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach(el => { const b = el.getBoundingClientRect(); previous.current.set(el.getAttribute(attribute)!, { x: b.left-r.left, y: b.top-r.top }); });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root.parentElement ?? root);
    root.querySelectorAll(`[${attribute}]`).forEach(el => observer.observe(el));
    return () => { observer.disconnect(); animations.forEach(animation => animation.cancel()); };
  }, [ref, order, attribute]);
}
