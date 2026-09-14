import { useEffect, useRef, type ComponentProps } from "react";

/** Native disclosure semantics, with interruptible height animation. */
export function AnimatedDetails({ children, onClick, ...props }: ComponentProps<"details">) {
  const ref = useRef<HTMLDetailsElement>(null);
  const animation = useRef<Animation | null>(null);
  const target = useRef<boolean | null>(null);
  const frame = useRef(0);
  useEffect(() => () => { cancelAnimationFrame(frame.current); animation.current?.cancel(); }, []);
  return <details {...props} ref={ref} onClick={event => {
    onClick?.(event);
    const el = ref.current;
    if (!el || event.defaultPrevented || (event.target as HTMLElement).closest("summary") !== el.querySelector(":scope > summary")) return;
    event.preventDefault();
    const open = !(target.current ?? el.open);
    const start = el.getBoundingClientRect().height;
    cancelAnimationFrame(frame.current); animation.current?.cancel();
    target.current = open;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.open = open; target.current = null; return; }
    el.open = true;
    frame.current = requestAnimationFrame(() => {
      const summary = el.querySelector("summary")!;
      const style = getComputedStyle(el);
      const end = open ? el.getBoundingClientRect().height : summary.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const run = el.animate([{ height: `${start}px`, overflow: "hidden" }, { height: `${end}px`, overflow: "hidden" }], { duration: 190, easing: "cubic-bezier(.2,.8,.2,1)" });
      animation.current = run;
      run.onfinish = () => { el.open = open; target.current = null; animation.current = null; };
    });
  }}>{children}</details>;
}
