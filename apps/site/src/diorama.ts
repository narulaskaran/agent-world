import {
  AmbientLight,
  Color,
  CylinderGeometry,
  DirectionalLight,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  WebGLRenderer,
} from "three";
import {
  dioramaHexes,
  HEX_SIZE,
  prefersReducedMotion,
  TERRAIN_COLORS,
  TILE_THICKNESS,
  type HexCell,
} from "./hex.js";

const CHARACTER_COLORS = [
  0x579c87, 0xc27c54, 0x6b7bb3, 0xb15d6e, 0xd4a017, 0x4f7c5c,
];

interface Wanderer {
  mesh: Mesh;
  from: HexCell;
  to: HexCell;
  t: number;
  duration: number;
}

const neighbors = (cell: HexCell, cells: HexCell[]): HexCell[] => {
  const deltas = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ] as const;
  return deltas
    .map(([dq, dr]) =>
      cells.find((item) => item.q === cell.q + dq && item.r === cell.r + dr),
    )
    .filter((item): item is HexCell => Boolean(item));
};

export function mountDiorama(canvas: HTMLCanvasElement): () => void {
  const fallback = canvas.parentElement?.querySelector(".hero-fallback");
  const reduced = prefersReducedMotion();
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "low-power",
    });
    const gl = renderer.getContext();
    if (!gl) throw new Error("no webgl");
  } catch {
    if (fallback instanceof HTMLElement) fallback.hidden = false;
    canvas.remove();
    return () => undefined;
  }

  const scene = new Scene();
  scene.background = new Color(0xf4eddb);
  const camera = new PerspectiveCamera(32, 1, 0.1, 80);
  camera.position.set(8, 11, 14);
  camera.lookAt(0, 0, 0);

  scene.add(new AmbientLight(0xfff4dd, 0.85));
  const sun = new DirectionalLight(0xfff1c9, 1.05);
  sun.position.set(6, 12, 4);
  scene.add(sun);

  const cells = dioramaHexes(4);
  const dummy = new Object3D();
  const geometry = new CylinderGeometry(HEX_SIZE * 0.95, HEX_SIZE * 0.95, 1, 6);
  geometry.rotateY(Math.PI / 6);
  const kinds = ["plaza", "park", "path", "grass"] as const;
  for (const kind of kinds) {
    const subset = cells.filter((cell) => cell.kind === kind);
    if (!subset.length) continue;
    const mesh = new InstancedMesh(
      geometry,
      new MeshStandardMaterial({
        color: TERRAIN_COLORS[kind],
        roughness: 0.72,
        metalness: 0.04,
      }),
      subset.length,
    );
    const height = TILE_THICKNESS[kind];
    subset.forEach((cell, index) => {
      dummy.position.set(cell.x, height / 2, cell.z);
      dummy.scale.set(1, height, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    scene.add(mesh);
  }

  const characterGeom = new SphereGeometry(0.28, 12, 10);
  const wanderers: Wanderer[] = CHARACTER_COLORS.map((color, index) => {
    const start = cells[(index * 7) % cells.length]!;
    const mesh = new Mesh(
      characterGeom,
      new MeshStandardMaterial({ color, roughness: 0.45 }),
    );
    mesh.position.set(start.x, 0.72, start.z);
    scene.add(mesh);
    const options = neighbors(start, cells);
    return {
      mesh,
      from: start,
      to: options[index % options.length] ?? start,
      t: index / CHARACTER_COLORS.length,
      duration: 2.4 + (index % 3) * 0.5,
    };
  });

  const resize = () => {
    const wrap = canvas.parentElement;
    const width = wrap?.clientWidth || canvas.clientWidth || 640;
    const height = wrap?.clientHeight || 420;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resize();

  let pointerX = 0;
  let pointerY = 0;
  const onPointer = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointerX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
  };
  window.addEventListener("pointermove", onPointer);

  let visible = document.visibilityState === "visible";
  let onscreen = true;
  let frame = 0;
  let elapsed = 0;
  let last = performance.now();
  const render = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;
    if (!reduced) {
      for (const wanderer of wanderers) {
        wanderer.t += dt / wanderer.duration;
        if (wanderer.t >= 1) {
          wanderer.from = wanderer.to;
          const options = neighbors(wanderer.from, cells);
          wanderer.to =
            options[Math.floor(Math.random() * options.length)] ??
            wanderer.from;
          wanderer.t = 0;
        }
        const t = wanderer.t * wanderer.t * (3 - 2 * wanderer.t);
        wanderer.mesh.position.set(
          wanderer.from.x + (wanderer.to.x - wanderer.from.x) * t,
          0.72 + Math.sin((elapsed + t) * 6) * 0.04,
          wanderer.from.z + (wanderer.to.z - wanderer.from.z) * t,
        );
      }
    }
    const parallax = reduced ? 0 : 1;
    camera.position.set(
      8 +
        pointerX * 0.8 * parallax +
        Math.sin(elapsed * 0.12) * 0.35 * parallax,
      11,
      14 +
        pointerY * 0.5 * parallax +
        Math.cos(elapsed * 0.1) * 0.25 * parallax,
    );
    camera.lookAt(0, 0.2, 0);
    renderer.render(scene, camera);
  };

  const tick = (now: number) => {
    if (!visible || !onscreen) {
      frame = 0;
      return;
    }
    render(now);
    if (!reduced) frame = requestAnimationFrame(tick);
  };

  const onVisibility = () => {
    visible = document.visibilityState === "visible";
    if (visible && onscreen && !reduced && !frame)
      frame = requestAnimationFrame(tick);
  };
  document.addEventListener("visibilitychange", onVisibility);
  const observer = new IntersectionObserver((entries) => {
    onscreen = entries.some((entry) => entry.isIntersecting);
    if (visible && onscreen && !reduced && !frame)
      frame = requestAnimationFrame(tick);
  });
  observer.observe(canvas);
  window.addEventListener("resize", resize);

  render(performance.now());
  if (!reduced) frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVisibility);
    observer.disconnect();
    renderer.dispose();
  };
}
