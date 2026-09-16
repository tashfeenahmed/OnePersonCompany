// Workdash's lightweight paper burst: one canvas shared by successive completions.
const COLORS = ["#6383d4", "#d47845", "#22ab93", "#9380db", "#f2c14e", "#ef5da8"];
const LIFE = 2.4;
type Particle = {
  x: number; y: number; vx: number; vy: number; w: number; h: number;
  spin: number; spinRate: number; tilt: number; tiltRate: number; color: string; age: number;
};
let canvas: HTMLCanvasElement | null = null;
let particles: Particle[] = [];
let frame = 0;
let last = 0;
let preference: MediaQueryList | null = null;

function fit() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function clearConfetti() {
  cancelAnimationFrame(frame);
  frame = 0;
  window.removeEventListener("resize", fit);
  document.removeEventListener("visibilitychange", visibilityChanged);
  preference?.removeEventListener("change", preferenceChanged);
  preference = null;
  canvas?.remove();
  canvas = null;
  particles = [];
}

function visibilityChanged() { if (document.hidden) clearConfetti(); }
function preferenceChanged() { if (preference?.matches) clearConfetti(); }

function tick(now: number) {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return clearConfetti();
  const elapsed = (now - last) / 1000;
  const dt = Math.min(elapsed, 1 / 30);
  last = now;
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  particles = particles.filter(p => {
    p.age += elapsed;
    p.vx *= 1 - 1.1 * dt;
    p.vy = p.vy * (1 - 0.6 * dt) + 1500 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.spin += p.spinRate * dt; p.tilt += p.tiltRate * dt;
    if (p.age >= LIFE || p.y - p.h > window.innerHeight) return false;
    ctx.save();
    ctx.globalAlpha = Math.min(1, ((LIFE - p.age) / LIFE) * 3);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.spin);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w, -p.h * Math.abs(Math.cos(p.tilt)), p.w * 2, p.h * 2);
    ctx.restore();
    return true;
  });
  if (!particles.length) return clearConfetti();
  frame = requestAnimationFrame(tick);
}

/** Viewport coordinates, matching the card's drop event. Pure decoration. */
export function burstConfetti(x: number, y: number) {
  if (typeof window === "undefined" || document.hidden
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.dataset.boardConfetti = "";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60";
    if (!canvas.getContext("2d")) { canvas = null; return; }
    fit();
    document.body.appendChild(canvas);
    window.addEventListener("resize", fit);
    document.addEventListener("visibilitychange", visibilityChanged);
    preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    preference.addEventListener("change", preferenceChanged);
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
  // Bound work when several cards finish in quick succession.
  particles = particles.slice(-220);
  for (let i = 0; i < 110; i++) {
    const angle = (-90 + (Math.random() - 0.5) * 140) * Math.PI / 180;
    const speed = 320 + Math.random() * 520;
    const w = 3 + Math.random() * 3;
    particles.push({
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - Math.random() * 180,
      w, h: w * (0.5 + Math.random() * 0.6), spin: Math.random() * Math.PI * 2,
      spinRate: (Math.random() - 0.5) * 14, tilt: Math.random() * Math.PI * 2,
      tiltRate: 6 + Math.random() * 8, color: COLORS[i % COLORS.length]!, age: 0,
    });
  }
}
