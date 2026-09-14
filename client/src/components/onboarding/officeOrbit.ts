export type OfficeView = { yaw: number; elevation: number };
const homeView = (): OfficeView => ({
  yaw: 0,
  elevation: Math.atan2(6.8, Math.hypot(8, 10)),
});
const FRICTION = 5.2; // Exponential angular drag, per second.
const MAX_SPEED = 5;
const STOP_SPEED = 0.025;
const MAX_COAST_MS = 1800;

/** Input is coalesced into one frame. A release uses recent angular velocity
 * and time-based friction, then fully stops scheduling once it settles. */
export function officeOrbit(
  element: HTMLElement,
  {
    start,
    change,
    request = requestAnimationFrame,
    cancel = cancelAnimationFrame,
    now = () => performance.now(),
    reducedMotion = () => false,
  }: {
    start: () => void;
    change: (view: OfficeView) => void;
    request?: typeof requestAnimationFrame;
    cancel?: typeof cancelAnimationFrame;
    now?: () => number;
    reducedMotion?: () => boolean;
  },
) {
  let view = homeView();
  let enabled = true;
  let disposed = false;
  let frame: number | null = null;
  let coast: {
    yaw: number;
    elevation: number;
    last: number;
    started: number;
  } | null = null;
  let pointer: {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    time: number;
    moved: boolean;
    yawSpeed: number;
    elevationSpeed: number;
  } | null = null;
  const stopMotion = () => {
    coast = null;
    if (frame !== null) cancel(frame);
    frame = null;
  };
  const rotate = (yaw: number, elevation: number) => {
    view = {
      // Wrap without restricting the number of complete revolutions.
      yaw: Math.atan2(Math.sin(view.yaw + yaw), Math.cos(view.yaw + yaw)),
      elevation: Math.min(1.3, Math.max(0.12, view.elevation + elevation)),
    };
  };
  const render = (time: number) => {
    frame = null;
    if (!enabled || disposed) return;
    if (coast && reducedMotion()) coast = null;
    if (coast) {
      const until = Math.min(time, coast.started + MAX_COAST_MS);
      const dt = Math.max(0, until - coast.last) / 1000;
      // Integrate the exponential exactly, so 60Hz and 120Hz feel the same.
      const decay = Math.exp(-FRICTION * dt);
      const distance = (1 - decay) / FRICTION;
      rotate(coast.yaw * distance, coast.elevation * distance);
      coast.yaw *= decay;
      coast.elevation *= decay;
      coast.last = until;
      if (
        (view.elevation >= 1.3 && coast.elevation > 0) ||
        (view.elevation <= 0.12 && coast.elevation < 0)
      )
        coast.elevation = 0;
      if (
        time - coast.started >= MAX_COAST_MS ||
        Math.hypot(coast.yaw, coast.elevation) < STOP_SPEED
      )
        coast = null;
    }
    change({ ...view });
    if (coast) notify();
  };
  const notify = () => {
    if (frame === null && enabled && !disposed) frame = request(render);
  };
  const release = () => {
    const held = pointer;
    pointer = null;
    element.removeAttribute("data-dragging");
    if (held && element.hasPointerCapture(held.id))
      element.releasePointerCapture(held.id);
    return held;
  };
  const down = (event: PointerEvent) => {
    if (
      !enabled ||
      disposed ||
      pointer ||
      !event.isPrimary ||
      event.button !== 0
    )
      return;
    stopMotion();
    const bounds = element.getBoundingClientRect();
    event.preventDefault();
    // Keep keyboard focus available without displaying a ring for pointer use.
    element.setAttribute("data-pointer-focus", "true");
    element.focus({ preventScroll: true });
    pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
      time: now(),
      moved: false,
      yawSpeed: 0,
      elevationSpeed: 0,
    };
    element.setPointerCapture(event.pointerId);
    element.setAttribute("data-dragging", "true");
    start();
  };
  const move = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    event.preventDefault();
    const dx = event.clientX - pointer.x,
      dy = event.clientY - pointer.y;
    if (!dx && !dy) return;
    const time = now();
    const dt = Math.max(8, time - pointer.time);
    const yaw = (-dx / pointer.width) * Math.PI * 2;
    const elevation = (dy / pointer.height) * Math.PI;
    const blend = pointer.moved ? 1 - Math.exp(-dt / 35) : 1;
    const speed = (delta: number) =>
      Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (delta / dt) * 1000));
    pointer.yawSpeed += (speed(yaw) - pointer.yawSpeed) * blend;
    pointer.elevationSpeed +=
      (speed(elevation) - pointer.elevationSpeed) * blend;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.time = time;
    pointer.moved = true;
    rotate(yaw, elevation);
    notify();
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer?.id) return;
    const held = release()!;
    const time = now(),
      pause = time - held.time;
    // Holding still before release, a tap, or reduced motion produces no fling.
    if (!held.moved || pause > 100 || reducedMotion()) return;
    const freshness = Math.exp(-Math.max(0, pause) / 90);
    const yaw = held.yawSpeed * freshness,
      elevation = held.elevationSpeed * freshness;
    if (Math.hypot(yaw, elevation) < STOP_SPEED) return;
    coast = { yaw, elevation, last: time, started: time };
    notify();
  };
  const cancelled = (event: PointerEvent) => {
    // The lost-capture event after a normal release must not cancel its glide.
    if (event.pointerId === pointer?.id) release();
  };
  const blur = () => element.removeAttribute("data-pointer-focus");
  const key = (event: KeyboardEvent) => {
    if (
      !enabled ||
      disposed ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      pointer
    )
      return;
    const step = Math.PI / 18;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step / 2],
      ArrowDown: [0, -step / 2],
    };
    if (!moves[event.key] && event.key !== "Home") return;
    event.preventDefault();
    element.removeAttribute("data-pointer-focus");
    stopMotion();
    start();
    if (event.key === "Home") view = homeView();
    else rotate(...moves[event.key]!);
    notify();
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancelled);
  element.addEventListener("lostpointercapture", cancelled);
  element.addEventListener("keydown", key);
  element.addEventListener("blur", blur);
  const stop = () => {
    release();
    stopMotion();
  };
  return {
    view: () => ({ ...view }),
    stop,
    setEnabled(next: boolean) {
      enabled = next;
      if (!next) stop();
    },
    dispose() {
      disposed = true;
      stop();
      element.removeAttribute("data-pointer-focus");
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", cancelled);
      element.removeEventListener("lostpointercapture", cancelled);
      element.removeEventListener("keydown", key);
      element.removeEventListener("blur", blur);
    },
  };
}
