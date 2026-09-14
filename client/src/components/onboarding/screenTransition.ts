/** A finite transition: no render loop, timers, or animation dependency. */
export function screenTransition(
  target: () => HTMLElement | null,
  reducedMotion: () => boolean,
) {
  let active = false;
  let disposed = false;
  let animation: Animation | null = null;

  async function fade(entering: boolean) {
    const node = target();
    if (!node?.animate || reducedMotion()) return;
    animation = node.animate(
      entering
        ? [
            { opacity: 0, transform: "translateY(7px)" },
            { opacity: 1, transform: "translateY(0)" },
          ]
        : [
            { opacity: 1, transform: "translateY(0)" },
            { opacity: 0, transform: "translateY(-5px)" },
          ],
      {
        duration: entering ? 210 : 130,
        easing: "cubic-bezier(.2,.7,.2,1)",
        fill: "both",
      },
    );
    // cancel() rejects finished; leaving the page is an ordinary cancellation.
    await animation.finished.catch(() => {});
  }

  return {
    async run(commit: () => void) {
      if (active || disposed) return;
      active = true;
      try {
        await fade(false);
        if (disposed) return;
        commit();
        animation?.cancel();
        await fade(true);
      } finally {
        animation?.cancel();
        animation = null;
        active = false;
      }
    },
    finish() {
      animation?.finish();
    },
    dispose() {
      disposed = true;
      animation?.cancel();
    },
  };
}
