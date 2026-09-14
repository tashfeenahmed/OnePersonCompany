// Imported dynamically by OfficeIllustration only after the welcome art is visible.
// No loaders, model downloads, textures, controls or post-processing dependencies.
import {
  BoxGeometry,
  CylinderGeometry,
  SphereGeometry,
  TorusGeometry,
  ExtrudeGeometry,
  Shape,
  Group,
  Mesh,
  MeshBasicMaterial,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  AdditiveBlending,
  DoubleSide,
  Scene,
  OrthographicCamera,
  WebGLRenderer,
  SRGBColorSpace,
  type BufferGeometry,
  type Material,
} from "three";
import { officeMotion } from "./officeMotion";
import { officeOrbit, type OfficeView } from "./officeOrbit";

export type OfficeScene = {
  replay: () => void;
  setVisible: (visible: boolean) => void;
  dispose: () => void;
};

export function mountOffice(
  host: HTMLElement,
  onPlaying: (playing: boolean) => void,
  onUnavailable: () => void,
): OfficeScene {
  const renderer = new WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.setAttribute("aria-hidden", "true");
  const scene = new Scene();
  const room = new Group();
  scene.add(room);
  const camera = new OrthographicCamera(-5, 5, 4, -4, 0.1, 60);
  const materials = new Set<Material>();
  const geometries = new Map<string, BufferGeometry>();
  const edgeGeometries = new Map<BufferGeometry, EdgesGeometry>();
  const surface = (color: number, opacity = 0.09) => {
    const material = new MeshBasicMaterial({
      color,
      opacity,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    materials.add(material);
    return material;
  };
  const glow = (color: number) => {
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    materials.add(material);
    return material;
  };
  const m = {
    floor: surface(0x123f71, 0.12),
    wall: surface(0x0d2c53, 0.06),
    trim: surface(0x1b6bc0, 0.13),
    wood: surface(0x2070c4, 0.1),
    cream: surface(0x4297ed, 0.12),
    ink: surface(0x103562, 0.07),
    chair: surface(0x256bc0, 0.12),
    leaf: surface(0x1c68b8, 0.1),
    leafLight: surface(0x4497e7, 0.11),
    clay: surface(0x245a98, 0.1),
    violet: surface(0x2e78cc, 0.12),
    gold: surface(0x56a5ef, 0.13),
    screen: surface(0x0d3967, 0.2),
    screenLine: glow(0x3599f0),
    yellow: glow(0x6ebdff),
    white: glow(0x9ed5ff),
    dark: surface(0x071b32, 0.1),
  };
  const outline = new LineBasicMaterial({
    color: 0x469fff,
    transparent: true,
    opacity: 0.46,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
  });
  const structureOutline = new LineBasicMaterial({
    color: 0x2c77c8,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
  });
  materials.add(outline);
  materials.add(structureOutline);
  const geometry = (key: string, build: () => BufferGeometry) => {
    if (!geometries.has(key)) geometries.set(key, build());
    return geometries.get(key)!;
  };
  const mesh = (
    parent: Group,
    shape: BufferGeometry,
    material: Material,
    x: number,
    y: number,
    z: number,
  ) => {
    const object = new Mesh(shape, material);
    object.position.set(x, y, z);
    // Shared edge geometry shows internal structure through the translucent shell.
    // Additive lines provide the X-ray glow without a bloom pass or shadow maps.
    if (!edgeGeometries.has(shape))
      edgeGeometries.set(shape, new EdgesGeometry(shape, 24));
    const edges = new LineSegments(
      edgeGeometries.get(shape)!,
      material === m.floor || material === m.wall || material === m.ink
        ? structureOutline
        : outline,
    );
    edges.renderOrder = 1;
    object.add(edges);
    parent.add(object);
    return object;
  };
  const box = (
    parent: Group,
    w: number,
    h: number,
    d: number,
    material: Material,
    x: number,
    y: number,
    z: number,
    radius = 0.025,
  ) => {
    const key = `box:${w}:${h}:${d}:${radius}`;
    const shape = geometry(key, () => {
      const r = Math.min(radius, w / 4, h / 4, d / 4);
      if (!r) return new BoxGeometry(w, h, d);
      const outline = new Shape();
      outline.moveTo(-w / 2 + r, -h / 2 + r);
      outline.lineTo(w / 2 - r, -h / 2 + r);
      outline.lineTo(w / 2 - r, h / 2 - r);
      outline.lineTo(-w / 2 + r, h / 2 - r);
      outline.closePath();
      const result = new ExtrudeGeometry(outline, {
        depth: d - 2 * r,
        bevelEnabled: true,
        bevelThickness: r,
        bevelSize: r,
        bevelSegments: 2,
        steps: 1,
        curveSegments: 1,
      });
      result.translate(0, 0, -d / 2 + r);
      result.computeVertexNormals();
      return result;
    });
    return mesh(parent, shape, material, x, y, z);
  };
  const cylinder = (
    parent: Group,
    top: number,
    bottom: number,
    height: number,
    material: Material,
    x: number,
    y: number,
    z: number,
  ) =>
    mesh(
      parent,
      geometry(
        `cyl:${top}:${bottom}:${height}`,
        () => new CylinderGeometry(top, bottom, height, 20),
      ),
      material,
      x,
      y,
      z,
    );
  const sphere = (
    parent: Group,
    material: Material,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy = sx,
    sz = sx,
  ) => {
    const object = mesh(
      parent,
      geometry("sphere", () => new SphereGeometry(1, 12, 8)),
      material,
      x,
      y,
      z,
    );
    object.scale.set(sx, sy, sz);
    return object;
  };
  const groups: { object: Group; delay: number }[] = [];
  const section = (delay: number) => {
    const group = new Group();
    room.add(group);
    groups.push({ object: group, delay });
    return group;
  };

  // An open office, rendered as blue internal structure on black.
  box(room, 6.6, 0.24, 5.1, m.ink, 0, -0.18, 0, 0.08);
  box(room, 6.4, 0.12, 4.9, m.floor, 0, 0, 0, 0.04);
  for (let i = -3; i <= 3; i++)
    box(room, 0.012, 0.006, 4.65, m.trim, i * 0.78, 0.065, 0, 0);
  const walls = section(0);
  box(walls, 6.35, 2.65, 0.16, m.wall, 0, 1.39, -2.37, 0.035);
  box(walls, 0.16, 2.65, 4.7, m.wall, -3.12, 1.39, -0.03, 0.035);
  box(walls, 6.25, 0.055, 0.07, m.trim, 0, 0.16, -2.26, 0.008);
  box(walls, 0.07, 0.055, 4.5, m.trim, -3.01, 0.16, 0, 0.008);
  // A recessed window with a softly lit morning sky.
  box(walls, 0.08, 1.65, 1.9, m.ink, -3.015, 1.7, -0.55);
  box(walls, 0.03, 1.46, 1.72, m.screen, -2.96, 1.7, -0.55, 0);
  box(walls, 0.065, 1.5, 0.045, m.trim, -2.925, 1.7, -0.55, 0.008);
  box(walls, 0.065, 0.045, 1.74, m.trim, -2.925, 1.7, -0.55, 0.008);
  box(walls, 0.24, 0.075, 2.02, m.wood, -2.96, 0.94, -0.55);
  // Pinboard: deliberately geometric, with no tiny labels or fake data.
  box(walls, 2.12, 1.18, 0.09, m.wood, 0.1, 1.93, -2.235, 0.04);
  box(walls, 1.95, 1.01, 0.04, m.cream, 0.1, 1.93, -2.16);
  for (let col = 0; col < 3; col++) {
    box(
      walls,
      0.44,
      0.04,
      0.025,
      m.trim,
      -0.52 + col * 0.61,
      2.29,
      -2.12,
      0.006,
    );
    for (let row = 0; row < 2; row++)
      box(
        walls,
        0.44,
        0.25,
        0.027,
        [m.gold, m.chair, m.violet][col]!,
        -0.52 + col * 0.61,
        2.06 - row * 0.32,
        -2.11,
        0.015,
      );
  }

  const desk = section(0.12);
  box(desk, 2.9, 0.14, 1.35, m.wood, 0.15, 1.25, 0.15, 0.05);
  for (const x of [-1.05, 1.35])
    for (const z of [-0.3, 0.64])
      box(desk, 0.075, 1.18, 0.075, m.ink, x, 0.6, z, 0.012);
  // Desk pedestal and drawers.
  box(desk, 0.54, 0.92, 0.85, m.cream, 1.03, 0.59, 0.06, 0.04);
  for (const y of [0.35, 0.66, 0.94]) {
    box(desk, 0.45, 0.015, 0.02, m.wood, 1.03, y, 0.5, 0.003);
    box(desk, 0.13, 0.023, 0.035, m.ink, 1.03, y + 0.08, 0.525, 0.006);
  }
  // Monitor and small, crisp UI surfaces made from geometry.
  box(desk, 0.54, 0.035, 0.32, m.ink, 0.05, 1.35, -0.15);
  box(desk, 0.075, 0.26, 0.075, m.ink, 0.05, 1.49, -0.22);
  box(desk, 1.35, 0.84, 0.075, m.ink, 0.05, 1.94, -0.23, 0.035);
  box(desk, 1.23, 0.7, 0.017, m.screen, 0.05, 1.955, -0.18, 0.009);
  box(desk, 0.21, 0.58, 0.012, m.screenLine, -0.4, 1.955, -0.165, 0.004);
  for (let i = 0; i < 3; i++)
    box(
      desk,
      0.21,
      0.16,
      0.014,
      [m.white, m.yellow, m.screenLine][i]!,
      -0.07 + i * 0.27,
      2.13,
      -0.164,
      0.012,
    );
  for (let i = 0; i < 5; i++)
    box(
      desk,
      0.085,
      0.07 + i * 0.045,
      0.014,
      m.screenLine,
      -0.1 + i * 0.13,
      1.76 + i * 0.0225,
      -0.164,
      0.005,
    );
  box(desk, 0.79, 0.032, 0.28, m.cream, -0.04, 1.343, 0.5, 0.025);
  for (let i = 0; i < 3; i++)
    box(desk, 0.65, 0.004, 0.012, m.wood, -0.04, 1.363, 0.425 + i * 0.062, 0);
  sphere(desk, m.cream, 0.54, 1.355, 0.51, 0.085, 0.04, 0.13);
  box(desk, 0.35, 0.055, 0.44, m.violet, -0.98, 1.35, 0.15, 0.018).rotation.y =
    -0.12;
  cylinder(desk, 0.105, 0.08, 0.21, m.cream, 0.95, 1.425, -0.21);
  cylinder(desk, 0.084, 0.084, 0.008, m.ink, 0.95, 1.534, -0.21);
  const handle = mesh(
    desk,
    geometry("mug-handle", () => new TorusGeometry(0.071, 0.022, 6, 14)),
    m.cream,
    1.06,
    1.43,
    -0.21,
  );
  handle.rotation.y = Math.PI / 2;

  const chair = section(0.27);
  cylinder(chair, 0.055, 0.065, 0.43, m.ink, 0.08, 0.36, 1.47);
  for (let i = 0; i < 5; i++) {
    const angle = (i * Math.PI * 2) / 5;
    const leg = box(chair, 0.07, 0.05, 0.72, m.ink, 0.08, 0.16, 1.47, 0.012);
    leg.rotation.y = angle;
    sphere(
      chair,
      m.ink,
      0.08 + Math.sin(angle) * 0.33,
      0.12,
      1.47 + Math.cos(angle) * 0.33,
      0.064,
    );
  }
  box(chair, 0.88, 0.14, 0.78, m.chair, 0.08, 0.66, 1.43, 0.055);
  box(chair, 0.85, 0.82, 0.14, m.chair, 0.08, 1.1, 1.81, 0.06).rotation.x =
    -0.09;
  for (const x of [-0.43, 0.59]) {
    box(chair, 0.055, 0.29, 0.055, m.ink, x, 0.82, 1.55, 0.012);
    box(chair, 0.1, 0.065, 0.49, m.ink, x, 0.99, 1.46, 0.025);
  }

  const storage = section(0.2);
  box(storage, 1.18, 1.65, 0.5, m.wood, -2.13, 0.91, -1.79, 0.035);
  box(storage, 1.04, 1.48, 0.045, m.ink, -2.13, 0.91, -1.505, 0.012);
  for (const y of [0.24, 0.72, 1.2, 1.68])
    box(storage, 1.08, 0.065, 0.47, m.wood, -2.13, y, -1.5, 0.012);
  for (let i = 0; i < 5; i++) {
    const height = 0.28 + (i % 3) * 0.035;
    box(
      storage,
      0.105,
      height,
      0.25,
      [m.chair, m.cream, m.violet, m.clay, m.gold][i]!,
      -2.51 + i * 0.13,
      0.765 + height / 2,
      -1.39,
      0.009,
    );
  }
  box(storage, 0.65, 0.3, 0.33, m.chair, -2.13, 0.435, -1.38, 0.02);
  box(storage, 0.15, 0.045, 0.012, m.cream, -2.13, 0.45, -1.2, 0.006);
  for (let i = 0; i < 3; i++)
    box(
      storage,
      0.52,
      0.06,
      0.28,
      [m.cream, m.clay, m.violet][i]!,
      -2.15,
      1.28 + 0.065 * i,
      -1.38,
      0.009,
    );

  const plant = (
    parent: Group,
    x: number,
    z: number,
    y: number,
    scale: number,
  ) => {
    const group = new Group();
    parent.add(group);
    group.position.set(x, y, z);
    group.scale.setScalar(scale);
    cylinder(group, 0.26, 0.19, 0.43, m.clay, 0, 0.215, 0);
    cylinder(group, 0.225, 0.225, 0.018, m.dark, 0, 0.425, 0);
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4;
      const height = 0.66 + (i % 3) * 0.2;
      const stem = cylinder(
        group,
        0.018,
        0.019,
        height - 0.3,
        m.leaf,
        Math.sin(angle) * 0.1,
        0.35 + (height - 0.3) / 2,
        Math.cos(angle) * 0.1,
      );
      stem.rotation.z = Math.sin(angle) * 0.15;
      const leaf = sphere(
        group,
        i % 2 ? m.leaf : m.leafLight,
        Math.sin(angle) * 0.24,
        height,
        Math.cos(angle) * 0.24,
        0.16,
        0.35,
        0.07,
      );
      leaf.rotation.set(0.35 * Math.cos(angle), angle, -0.4 * Math.sin(angle));
    }
  };
  const greenery = section(0.38);
  plant(greenery, 2.5, -1.65, 0.07, 1.3);
  plant(greenery, -2.12, -1.58, 1.73, 0.48);
  // A side table with a single quiet lamp.
  cylinder(greenery, 0.4, 0.4, 0.085, m.wood, 2.45, 0.72, 0.05);
  cylinder(greenery, 0.06, 0.08, 0.65, m.ink, 2.45, 0.365, 0.05);
  cylinder(greenery, 0.29, 0.29, 0.04, m.ink, 2.45, 0.08, 0.05);
  cylinder(greenery, 0.12, 0.12, 0.035, m.ink, 2.45, 0.79, 0.05);
  cylinder(greenery, 0.025, 0.025, 0.39, m.gold, 2.45, 0.98, 0.05);
  cylinder(greenery, 0.17, 0.3, 0.27, m.cream, 2.45, 1.22, 0.05);

  let disposed = false;
  let visible = true;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const aim = ({ yaw, elevation }: OfficeView, turn = 0) => {
    const radius = Math.hypot(8, 6.8, 10);
    const horizontal = radius * Math.cos(elevation);
    const angle = Math.atan2(8, 10) + yaw - turn;
    camera.position.set(
      horizontal * Math.sin(angle),
      1 + radius * Math.sin(elevation),
      horizontal * Math.cos(angle),
    );
    camera.lookAt(0, 1, 0);
  };
  const pose = (progress: number) => {
    for (const { object, delay } of groups) {
      const t = Math.min(1, Math.max(0, (progress - delay) / 0.55));
      const ease = 1 - (1 - t) ** 3;
      object.position.y = (1 - ease) * 0.55;
      object.scale.setScalar(0.88 + 0.12 * ease);
      object.visible = t > 0;
    }
    const turn = (1 - progress) ** 3 * 0.28;
    aim(orbit.view(), turn);
  };
  const draw = () => {
    if (!disposed && visible && !document.hidden)
      renderer.render(scene, camera);
  };
  const motion = officeMotion({
    render: (progress) => {
      pose(progress);
      draw();
    },
    playing: onPlaying,
  });
  const orbit = officeOrbit(host, {
    start: () => motion.settle(),
    reducedMotion: () => reduced.matches,
    change: (view) => {
      aim(view);
      draw();
    },
  });
  const resize = () => {
    if (disposed) return;
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    // Cap both device pixel ratio and total backing-buffer size on large displays.
    renderer.setPixelRatio(
      Math.min(devicePixelRatio || 1, 1.5, 1000 / width, 850 / height),
    );
    renderer.setSize(width, height, false);
    const aspect = width / height;
    // Fit the full room at any allowed viewing angle, including on wide screens.
    const halfHeight = Math.max(4.5, 4.5 / aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    draw();
  };
  const visibility = () => {
    orbit.setEnabled(visible && !document.hidden);
    if (document.hidden || !visible) motion.stop();
    else motion.settle();
  };
  const preference = () => {
    if (reduced.matches) {
      orbit.stop();
      motion.settle();
    }
  };
  const resizeObserver = new ResizeObserver(resize);
  const contextLost = (event: Event) => {
    event.preventDefault();
    dispose();
    onUnavailable();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    orbit.dispose();
    motion.dispose();
    resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", visibility);
    reduced.removeEventListener("change", preference);
    renderer.domElement.removeEventListener("webglcontextlost", contextLost);
    geometries.forEach((value) => value.dispose());
    edgeGeometries.forEach((value) => value.dispose());
    materials.forEach((value) => value.dispose());
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
  try {
    host.append(renderer.domElement);
    pose(1);
    resize();
    resizeObserver.observe(host);
    document.addEventListener("visibilitychange", visibility);
    reduced.addEventListener("change", preference);
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    if (!document.hidden) motion.play(reduced.matches);
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    replay: () => {
      if (visible && !document.hidden) {
        orbit.stop();
        motion.play(reduced.matches);
      }
    },
    setVisible: (next) => {
      if (next === visible) return;
      visible = next;
      visibility();
    },
    dispose,
  };
}
