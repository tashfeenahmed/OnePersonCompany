import { useLayoutEffect, useRef } from "react";

/** Measures the selected control so wrapped navigation and resized labels work. */
export function SelectionPill({ value }: { value: string | number | null }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const pill = ref.current, root = pill?.parentElement;
    if (!pill || !root) return;
    const update = () => {
      const selected = root.querySelector<HTMLElement>("[data-selected='true']");
      const host = getComputedStyle(root).display === "contents" ? root.parentElement! : root;
      if (!selected || !selected.getClientRects().length) { pill.style.opacity = "0"; return; }
      const r = selected.getBoundingClientRect(), h = host.getBoundingClientRect();
      Object.assign(pill.style, { width: `${r.width}px`, height: `${r.height}px`, transform: `translate(${r.left-h.left+host.scrollLeft}px,${r.top-h.top+host.scrollTop}px)`, opacity: "1" });
    };
    update(); const observer = new ResizeObserver(update); observer.observe(root.parentElement!);
    root.querySelectorAll("[data-selected]").forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [value]);
  return <span ref={ref} aria-hidden="true" className="selection-pill pointer-events-none absolute left-0 top-0 rounded-lg bg-accent"/>;
}
