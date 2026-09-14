/** A finite, 30fps intro. There is deliberately no animation loop at rest. */
export function officeMotion({
  render,
  playing,
  request = requestAnimationFrame,
  cancel = cancelAnimationFrame,
  now = () => performance.now(),
}: {
  render: (progress: number) => void;
  playing: (active: boolean) => void;
  request?: typeof requestAnimationFrame;
  cancel?: typeof cancelAnimationFrame;
  now?: () => number;
}) {
  let frame: number | null = null;
  let disposed = false;
  const stop = () => {
    if (frame !== null) cancel(frame);
    frame = null;
    playing(false);
  };
  return {
    play(reducedMotion = false) {
      if (disposed) return;
      stop();
      if (reducedMotion) {
        render(1);
        return;
      }
      const start = now();
      let previous = -Infinity;
      playing(true);
      const tick = (time: number) => {
        frame = null;
        if (disposed) return;
        const progress = Math.min(1, Math.max(0, (time - start) / 2800));
        if (time - previous >= 1000 / 30 || progress === 1) {
          render(progress);
          previous = time;
        }
        if (progress < 1) frame = request(tick);
        else playing(false);
      };
      frame = request(tick);
    },
    stop,
    settle() {
      if (disposed) return;
      stop();
      render(1);
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
