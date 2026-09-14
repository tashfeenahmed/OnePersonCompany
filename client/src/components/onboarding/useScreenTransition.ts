import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { screenTransition } from "./screenTransition";

export function useScreenTransition() {
  const flow = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof screenTransition> | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const current = screenTransition(
      () => flow.current,
      () => media.matches,
    );
    controller.current = current;
    const changed = () => {
      if (media.matches) current.finish();
    };
    media.addEventListener("change", changed);
    return () => {
      current.dispose();
      controller.current = null;
      media.removeEventListener("change", changed);
    };
  }, []);
  const transition = useCallback(async (commit: () => void) => {
    const current = controller.current;
    if (!current) return;
    setTransitioning(true);
    try {
      // Commit the new screen while the outgoing screen is transparent.
      await current.run(() => flushSync(commit));
    } finally {
      if (controller.current === current) setTransitioning(false);
    }
  }, []);
  return { flow, transitioning, transition };
}
