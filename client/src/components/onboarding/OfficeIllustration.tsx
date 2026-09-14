import { useEffect, useId, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { OfficeScene } from "./officeScene";

/** This tiny shell is safe to import with onboarding; Three.js stays in a separate chunk. */
export function OfficeIllustration() {
  const host = useRef<HTMLDivElement>(null);
  const office = useRef<OfficeScene | null>(null);
  const hintId = useId();
  const [status, setStatus] = useState<
    "loading" | "playing" | "idle" | "fallback"
  >("loading");
  const interactive = status === "playing" || status === "idle";
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let started = false;
    let visible = false;
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    const load = () => {
      if (disposed || started || !visible || document.hidden) return;
      started = true;
      if (
        connection?.saveData ||
        typeof WebGL2RenderingContext === "undefined"
      ) {
        setStatus("fallback");
        return;
      }
      void import("./officeScene")
        .then(({ mountOffice }) => {
          if (disposed) return;
          office.current = mountOffice(
            element,
            (playing) => {
              if (!disposed) setStatus(playing ? "playing" : "idle");
            },
            () => {
              if (!disposed) setStatus("fallback");
            },
          );
          if (!visible) office.current.setVisible(false);
        })
        .catch(() => {
          if (!disposed) setStatus("fallback");
        });
    };
    const schedule = () => {
      if (
        started ||
        disposed ||
        !visible ||
        document.hidden ||
        idle !== undefined ||
        timer !== undefined
      )
        return;
      if ("requestIdleCallback" in window) {
        idle = window.requestIdleCallback(
          () => {
            idle = undefined;
            load();
          },
          { timeout: 1000 },
        );
      } else {
        timer = setTimeout(() => {
          timer = undefined;
          load();
        }, 0);
      }
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry?.isIntersecting ?? false;
        office.current?.setVisible(visible);
        if (visible) schedule();
      },
      { threshold: 0.1 },
    );
    observer.observe(element);
    document.addEventListener("visibilitychange", schedule);
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
      office.current?.dispose();
      office.current = null;
    };
  }, []);
  return (
    <figure className="ob-office" data-scene-state={status}>
      <div
        ref={host}
        className="ob-office-stage"
        role={interactive ? "group" : "img"}
        aria-roledescription={interactive ? "3D model" : undefined}
        aria-describedby={interactive ? hintId : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label="A blue X-ray view of a three-dimensional office, with transparent walls revealing a desk, planning board, books and plants."
      >
        <svg
          className="ob-office-fallback"
          viewBox="0 0 640 520"
          aria-hidden="true"
        >
          <path d="M80 310 323 173 568 307 325 453Z" fill="#343b35" />
          <path
            d="M80 310v18l245 143v-18zm245 143 243-146v18L325 471Z"
            fill="#242b27"
          />
          <path d="M80 310V155L323 21v152Z" fill="#434c42" />
          <path d="m323 21 245 136v150L323 173Z" fill="#303a33" />
          <path d="m371 90 128 70v72l-128-70Z" fill="#b9ae91" />
          <path
            d="m384 112 25 14v26l-25-14zm37 20 25 14v26l-25-14zm37 20 25 14v26l-25-14Z"
            fill="#778466"
          />
          <path d="m189 272 159-90 153 88-159 94Z" fill="#c1b399" />
          <path
            d="m189 272 153 92v10l-153-92zm153 92 159-94v10l-159 94Z"
            fill="#a39173"
          />
          <path
            d="m202 286 12 7v69l-12-7zm275 8 12-7v73l-12 7zm-146 90 12 7v42l-12-7Z"
            fill="#202a25"
          />
          <path d="m284 219 1-65 93 53v64Z" fill="#1c2827" />
          <path d="m292 165 78 46v44l-78-45Z" fill="#78988b" />
          <path d="m290 284 36-20 51 29-36 21Z" fill="#ddd5c0" />
          <path d="m274 369 58-34 57 33-58 35Z" fill="#94a178" />
          <path d="m331 403 58-35v-59l-58 35Z" fill="#6e7d5c" />
          <path d="M521 298v34c0 19-36 19-36 0v-34Z" fill="#b48e76" />
          <ellipse cx="503" cy="297" rx="18" ry="10" fill="#ccaa87" />
          <path
            d="M503 300v-88m0 53c-40-12-41-43-23-42 18 2 23 42 23 42m1 17c33-8 46-36 28-40-19-4-28 40-28 40m-1-38c-19-23-15-49 0-47 21 4 0 47 0 47"
            stroke="#728d67"
            strokeWidth="5"
            fill="#728d67"
          />
        </svg>
      </div>
      {interactive && (
        <p id={hintId} className="sr-only">
          Use arrow keys to rotate, or Home to reset the view.
        </p>
      )}
      {interactive && (
        <button
          className="ob-office-replay"
          onClick={() => office.current?.replay()}
          disabled={status === "playing"}
          aria-label="Replay office animation"
          title="Replay animation"
        >
          <RotateCcw size={15} />
        </button>
      )}
    </figure>
  );
}
