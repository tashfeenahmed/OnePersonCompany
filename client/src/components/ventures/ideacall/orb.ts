/**
 * THE ORB · a pearl, and the orbit it throws when it searches.
 *
 * Two numbers drive everything here. `amp` rises while the assistant speaks and
 * idles into a slow breath; `launch` goes 0 → 1 when a search starts and back
 * to 0 when it finishes, so nine thousand points leave the surface of the
 * sphere, bow out into a ring around it, and fall back onto exactly the spot
 * they left. There are no lights and no textures: the shape is noise, and the
 * only reason it reads as a sphere at all is the fresnel term.
 *
 * WHY THIS FILE KNOWS NOTHING ABOUT REACT. The animation runs at 60fps off a
 * requestAnimationFrame loop and writes into uniforms; a React state update per
 * frame would be sixty renders a second of a component that has a thread of
 * measured DOM in it. So the orb is a plain function that takes a canvas and
 * hands back four setters, and the component holds the handle in a ref.
 *
 * WHY `three` IS IMPORTED DYNAMICALLY. It is roughly half a megabyte, and the
 * dashboard that hosts this call must not carry it on every page load. The
 * `await import` inside the async init is what makes Vite give it its own
 * chunk, fetched the first time somebody opens a call.
 *
 * WHY LIGHT MODE IS NOT THE SAME SHADER WITH THE COLOURS FLIPPED. The dark orb
 * is white light ADDED to black — the only way a glow works. Added to paper it
 * would be invisible, and ink added to paper is still paper. So the colour is a
 * uniform, the blending is a material property, and light mode is ink composited
 * NORMALLY over the page: a soft graphite sphere with a darker rim where the
 * fresnel bites, and the ring as fine dark dust. Same geometry, opposite optics.
 */

export type OrbVoice = "idle" | "speak" | "listen" | "search";

export type OrbHandle = {
  setVoice(v: OrbVoice): void;
  setSearching(on: boolean): void;
  setLight(light: boolean): void;
  dispose(): void;
  /**
   * NOT DECORATION. `mountOrb` has to return its setters synchronously — the
   * component needs somewhere to send state the moment it mounts — but three
   * arrives over the network and WebGL can refuse. This resolves false when
   * there will never be an orb, which is the caller's signal to show the CSS
   * breathing ring instead of a blank rectangle.
   */
  ready: Promise<boolean>;
};

/** Ink, for light mode: the same value as the CSS `--ic-fg`, in linear-ish 0-1. */
const INK: [number, number, number] = [0.086, 0.082, 0.059];

/**
 * The envelope: what the pearl is doing, expressed as a number between 0 and 1.
 * Speech is three sines multiplied together, which gives syllables rather than
 * a throb; listening is a shallow lift; idle is a breath you have to look for.
 */
function envelope(voice: OrbVoice, t: number): number {
  if (voice === "speak") {
    const syl =
      (Math.sin(t * 10.7) * 0.5 + 0.5) *
      (Math.sin(t * 6.3 + 1.1) * 0.5 + 0.5) *
      (Math.sin(t * 17.9 + 0.4) * 0.25 + 0.75);
    return 0.3 + 0.7 * syl;
  }
  if (voice === "listen") return 0.1 + 0.1 * (Math.sin(t * 2.3) * 0.5 + 0.5);
  if (voice === "search")
    return 0.16 + 0.09 * (Math.sin(t * 3.1) * 0.5 + 0.5) * (Math.sin(t * 1.7 + 0.9) * 0.5 + 0.5);
  return 0.015 * (Math.sin(t * 0.9) * 0.5 + 0.5);
}

/* Simplex noise, the standard GLSL port. Shared by both halves of the pearl. */
const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(
      i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float f=0.0,a=0.5;for(int i=0;i<4;i++){f+=a*snoise(p);p*=2.03;a*=0.5;}return f;}
`;

export function mountOrb(
  canvas: HTMLCanvasElement,
  wrap: HTMLElement,
  opts: { light: boolean },
): OrbHandle {
  /* State the loop reads. Held out here so the setters work before three has
     finished loading — a `setVoice("speak")` during the import is not dropped,
     it is simply the value the first frame starts from. */
  let voice: OrbVoice = "idle";
  let light = opts.light;
  let launchTarget = 0;
  let disposed = false;

  /* Filled in by init; the setters check for them rather than queueing. */
  let applyLight: ((on: boolean) => void) | null = null;
  let teardown: (() => void) | null = null;

  const ready = (async (): Promise<boolean> => {
    let THREE: typeof import("three");
    try {
      THREE = await import("three");
    } catch {
      return false;
    }
    if (disposed) return false;

    let renderer: import("three").WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      /* No WebGL context: an old machine, a blocked GPU, a headless browser
         without a software rasteriser. The caller draws a ring instead. */
      return false;
    }

    const PR = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(PR);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.z = 5.2;

    const root = new THREE.Group();
    root.rotation.x = 0.22;
    scene.add(root);
    const bodyGroup = new THREE.Group(); // the pearl, spinning slowly
    const halo = new THREE.Group(); // the orbit, with its own motion
    root.add(bodyGroup, halo);

    /* One uniform object per value, shared by every material, so a single write
       per frame reaches the whole scene.
         uT  time          uA  envelope       uL  launch
         uPR pixel ratio   uC  ink or white   uLt 0 dark / 1 light
         uAl overall alpha multiplier (see setLight) */
    const U = {
      uT: { value: 0 },
      uA: { value: 0 },
      uL: { value: 0 },
      uPR: { value: PR },
      uC: { value: new THREE.Vector3(1, 1, 1) },
      uLt: { value: 0 },
      uAl: { value: 1 },
    };

    const shader = (vs: string, fs: string, extra: Record<string, unknown> = {}) =>
      new THREE.ShaderMaterial({
        uniforms: { ...U, ...extra },
        vertexShader: vs,
        fragmentShader: fs,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

    /* ── the pearl ───────────────────────────────────────────────────────── */
    const pearlGeo = new THREE.SphereGeometry(1, 140, 100);
    const pearlMat = shader(
      `
      uniform float uT,uA; varying vec3 vP,vN,vV;
      void main(){
        float br=1.0+0.02*sin(uT*0.7)+uA*0.06;
        vec3 p=position*br;
        vP=position; vN=normalize(normalMatrix*normal);
        vec4 mv=modelViewMatrix*vec4(p,1.0);
        vV=-mv.xyz;
        gl_Position=projectionMatrix*mv;
      }`,
      `${NOISE}
      uniform float uT,uA,uLt,uAl; uniform vec3 uC; varying vec3 vP,vN,vV;
      void main(){
        vec3 n=normalize(vN), v=normalize(vV);
        vec3 q=vP*1.25+vec3(0.0,0.0,uT*0.08);
        float w=fbm(q);
        float s=fbm(q*2.1+w*(1.1+uA*1.4)-vec3(uT*0.05));
        float lum=smoothstep(0.05,0.85,s*0.55+0.45);
        float fres=pow(1.0-max(dot(n,v),0.0),2.8);

        /* DARK: light added to black, so alpha IS brightness — a tenth of it
           shows as a faint glow.
           LIGHT: ink laid over paper, so alpha is COVERAGE, and the same tenth
           is a sphere you can barely see. It needs both a floor, so the middle
           has body, and roughly three times the swing, so the noise inside it
           reads as graphite rather than as a smudge. */
        float dark  = lum*(0.10+uA*0.30) + fres*(0.55+uA*0.35);
        float paper = 0.17 + lum*(0.36+uA*0.32) + fres*(0.44+uA*0.20);
        float a = mix(dark, paper, uLt);
        gl_FragColor=vec4(uC, clamp(a,0.0,1.0)*uAl);
      }`,
    );
    const pearl = new THREE.Mesh(pearlGeo, pearlMat);
    bodyGroup.add(pearl);

    /* ── the orbit · DISC ─────────────────────────────────────────────────
       The surface itself lifts off: each point leaves its home on the sphere,
       bows outward into a ring, and falls back onto the same spot. Each carries
       its own delay, so the shed sweeps across the body as a wave rather than
       going all at once.

       Occlusion is solved in the shader, not with the depth buffer, so it can
       be switched on partway through the flight: while a point is still leaving
       the surface it always shows — you see it depart from the far side too —
       and only once it has reached the ring does the sphere start to hide it.
       On the way home the sphere lets go again. */
    const N = 9000;
    const pos = new Float32Array(N * 3);
    const dA = new Float32Array(N);
    const dR = new Float32Array(N);
    const dY = new Float32Array(N);
    const dD = new Float32Array(N);
    const gr = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const th = gr * i;
      pos[i * 3] = Math.cos(th) * rad;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(th) * rad;
      dA[i] = Math.random();
      dR[i] = Math.random();
      dY[i] = Math.random() * 2 - 1;
      dD[i] = 0.62 * (y * 0.5 + 0.5) + 0.38 * Math.random(); // the wave, pole to pole
    }
    const discGeo = new THREE.BufferGeometry();
    discGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    discGeo.setAttribute("dA", new THREE.BufferAttribute(dA, 1));
    discGeo.setAttribute("dR", new THREE.BufferAttribute(dR, 1));
    discGeo.setAttribute("dY", new THREE.BufferAttribute(dY, 1));
    discGeo.setAttribute("dD", new THREE.BufferAttribute(dD, 1));

    const discMat = shader(
      `
      uniform float uT,uL,uPR; attribute float dA,dR,dY,dD;
      varying float vR,vO,vF;
      void main(){
        vec3 home=position*1.003;
        float u=clamp((uL-dD*0.30)/0.70,0.0,1.0);
        float e=smoothstep(0.0,1.0,u);

        float ang=dA*6.2831853+uT*0.50;
        float rad=1.04+dR*0.36;
        vec3 tgt=vec3(cos(ang)*rad, dY*0.07, sin(ang)*rad);
        vec3 p=mix(home,tgt,e)+normalize(home)*sin(e*3.14159)*0.22;

        vec4 mv=modelViewMatrix*vec4(p,1.0);

        /* hidden by the body? — only once it is out at the ring */
        vec3 co=(modelViewMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
        vec3 dir=normalize(co);
        float tP=dot(mv.xyz,dir);
        float perp=length(mv.xyz-dir*tP);
        float behind=step(length(co),tP);
        float inside=smoothstep(1.06,0.99,perp);
        float gate=smoothstep(0.34,0.76,e);
        vO=1.0-behind*inside*gate;

        vR=dR; vF=smoothstep(0.0,0.12,e);
        gl_PointSize=(0.010+dR*0.011)*uPR*(300.0/-mv.z);
        gl_Position=projectionMatrix*mv;
      }`,
      `
      uniform float uLt,uAl; uniform vec3 uC;
      varying float vR,vO,vF;
      void main(){
        float d=length(gl_PointCoord-0.5);
        if(d>0.5) discard;
        /* Dust on paper reads heavier than dust on black at the same number,
           because every grain now SUBTRACTS from the page instead of adding to
           it — so light mode gets most of the value, not all of it. */
        float a=smoothstep(0.5,0.0,d)*(0.20+vR*0.34)*vF*vO;
        gl_FragColor=vec4(uC, a*uAl*mix(1.0,0.66,uLt));
      }`,
    );
    discMat.depthTest = false;
    const disc = new THREE.Points(discGeo, discMat);
    disc.frustumCulled = false;
    halo.add(disc);

    applyLight = (on: boolean) => {
      U.uLt.value = on ? 1 : 0;
      U.uC.value.set(...(on ? INK : ([1, 1, 1] as [number, number, number])));
      /* Paper wants slightly less than full ink so the sphere sits in the page
         rather than on top of it; black takes the glow at full strength. */
      U.uAl.value = on ? 0.92 : 1;
      for (const m of [pearlMat, discMat]) {
        m.blending = on ? THREE.NormalBlending : THREE.AdditiveBlending;
        m.needsUpdate = true;
      }
    };
    applyLight(light);

    const size = () => {
      const r = wrap.getBoundingClientRect();
      if (!r.width || !r.height) return;
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
    };
    size();

    /* A ResizeObserver rather than a window listener: the call is a portal over
       a dashboard whose own layout can change the wrap's width without the
       window ever resizing. */
    const ro = new ResizeObserver(size);
    ro.observe(wrap);

    /* `THREE.Clock` is deprecated in this version, and performance.now() is what
       it wrapped anyway. */
    const t0 = performance.now();
    let amp = 0;
    let launch = 0;
    let raf = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const t = (performance.now() - t0) / 1000;
      amp += (envelope(voice, t) - amp) * 0.14;
      /* Out faster than in, so the throw reads and the return settles. */
      launch += (launchTarget - launch) * (launchTarget > launch ? 0.042 : 0.03);
      U.uT.value = t;
      U.uA.value = amp;
      U.uL.value = launch;
      bodyGroup.rotation.y += 0.0009 + amp * 0.0042;
      halo.rotation.y += 0.0011;
      halo.rotation.z = Math.sin(t * 0.21) * 0.16;
      root.position.y = Math.sin(t * 0.6) * 0.03;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    teardown = () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      pearlGeo.dispose();
      discGeo.dispose();
      pearlMat.dispose();
      discMat.dispose();
      renderer.dispose();
    };

    /* Disposed while three was still loading: run the teardown we just built. */
    if (disposed) {
      teardown();
      teardown = null;
      return false;
    }
    return true;
  })();

  return {
    setVoice(v) {
      voice = v;
    },
    setSearching(on) {
      launchTarget = on ? 1 : 0;
    },
    setLight(on) {
      light = on;
      applyLight?.(on);
    },
    dispose() {
      disposed = true;
      teardown?.();
      teardown = null;
    },
    ready,
  };
}
