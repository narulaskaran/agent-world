import {
  AmbientLight,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  cellNoise,
  dioramaHexes,
  HEX_SIZE,
  prefersReducedMotion,
  TERRAIN_COLORS,
  TILE_THICKNESS,
  type HexCell,
} from "./hex.js";

const CAST = [
  {
    name: "Juniper",
    color: 0xb15d6e,
    lines: ["Is that a new path?", "I keep finding odd little things."],
  },
  {
    name: "Moss",
    color: 0xd4a017,
    lines: ["Quiet morning.", "I left a paper bird at the shed."],
  },
  {
    name: "Tinker",
    color: 0x579c87,
    lines: ["Restless. Off to the plaza.", "Anyone need something fixed?"],
  },
  {
    name: "Wren",
    color: 0x6b7bb3,
    lines: ["Wait, I remember you.", "The pond looks wonderful today."],
  },
  {
    name: "Clover",
    color: 0x4f7c5c,
    lines: ["Wandering is a fine plan.", "I'll sit in the park a while."],
  },
  {
    name: "Pip",
    color: 0xc27c54,
    lines: ["Did you hear? A new friend!", "Tell me a story?"],
  },
];

const SKIN = [0xf1c9a5, 0xd9a07a, 0xb97b56, 0xf6d8bd, 0x8d5a3b, 0xe8b894];
const HOUSE_CELL = { q: 2, r: -2 };
const TILE_RISE_SECONDS = 0.75;

interface Wanderer {
  group: Group;
  name: string;
  lines: string[];
  from: HexCell;
  to: HexCell;
  t: number;
  duration: number;
  rest: number;
  hop: number;
  heading: number;
}

interface PopIn {
  object: Object3D;
  delay: number;
}

const DELTAS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
] as const;

const easeOutBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const walkable = (cell: HexCell) =>
  cell.kind !== "pond" && !(cell.q === HOUSE_CELL.q && cell.r === HOUSE_CELL.r);

const neighbors = (cell: HexCell, byKey: Map<string, HexCell>): HexCell[] =>
  DELTAS.map(([dq, dr]) => byKey.get(`${cell.q + dq},${cell.r + dr}`))
    .filter((item): item is HexCell => Boolean(item))
    .filter(walkable);

export function mountDiorama(canvas: HTMLCanvasElement): () => void {
  const stage = canvas.parentElement;
  const fallback = stage?.querySelector(".hero-fallback");
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
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 120);
  const viewDir = new Vector3(0.5, 0.78, 1).normalize();

  scene.add(new HemisphereLight(0xffffff, 0xd9c79a, 1.5));
  scene.add(new AmbientLight(0xfff4dd, 0.45));
  const sun = new DirectionalLight(0xfff1c9, 1.9);
  sun.position.set(-7, 14, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -11;
  sun.shadow.camera.right = 11;
  sun.shadow.camera.top = 11;
  sun.shadow.camera.bottom = -11;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0006;
  sun.shadow.radius = 4;
  scene.add(sun);

  const island = new Group();
  scene.add(island);

  const cells = dioramaHexes(4);
  const byKey = new Map(cells.map((c) => [`${c.q},${c.r}`, c]));
  const heightOf = (cell: HexCell) => TILE_THICKNESS[cell.kind];
  const popIns: PopIn[] = [];
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  // --- ground tiles (instanced, tinted per cell, rise in on load) ---
  const tileGeometry = track(
    new CylinderGeometry(HEX_SIZE * 0.97, HEX_SIZE * 0.97, 1, 6),
  );
  tileGeometry.rotateY(Math.PI / 6);
  const dummy = new Object3D();
  const tileMeshes: { mesh: InstancedMesh; subset: HexCell[] }[] = [];
  const kinds = ["plaza", "park", "path", "grass", "pond"] as const;
  const tint = new Color();
  for (const kind of kinds) {
    const subset = cells.filter((cell) => cell.kind === kind);
    if (!subset.length) continue;
    const mesh = new InstancedMesh(
      tileGeometry,
      track(
        new MeshStandardMaterial({
          color: 0xffffff,
          roughness: kind === "pond" ? 0.35 : 0.85,
          metalness: 0,
        }),
      ),
      subset.length,
    );
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    subset.forEach((cell, index) => {
      tint.set(TERRAIN_COLORS[kind]);
      tint.offsetHSL(
        (cellNoise(cell.q, cell.r, 1) - 0.5) * 0.02,
        (cellNoise(cell.q, cell.r, 2) - 0.5) * 0.06,
        (cellNoise(cell.q, cell.r, 3) - 0.5) * 0.07,
      );
      mesh.setColorAt(index, tint);
    });
    island.add(mesh);
    tileMeshes.push({ mesh, subset });
  }

  const delayOf = (cell: HexCell) =>
    Math.hypot(cell.x, cell.z) * 0.07 + cellNoise(cell.q, cell.r, 9) * 0.12;
  const placeTiles = (elapsedSeconds: number) => {
    for (const { mesh, subset } of tileMeshes) {
      subset.forEach((cell, index) => {
        const progress = reduced
          ? 1
          : clamp01((elapsedSeconds - delayOf(cell)) / TILE_RISE_SECONDS);
        const k = Math.max(0.001, easeOutBack(progress));
        const height = heightOf(cell);
        dummy.position.set(
          cell.x,
          (height * k) / 2 - (1 - progress) * 2,
          cell.z,
        );
        dummy.scale.set(1, Math.max(0.001, height * k), 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  };
  placeTiles(0);

  // --- floating-island underside: stepped layers so the sides catch the light ---
  [
    [8.75, 0x9a7650],
    [8.0, 0x8c6a46],
    [7.0, 0x7d5f3e],
    [5.6, 0x6e5539],
    [4.0, 0x60492f],
    [2.4, 0x523f29],
  ].forEach(([radius, color], index) => {
    const layer = new Mesh(
      track(new CylinderGeometry(radius!, radius!, 0.9, 6)),
      track(new MeshStandardMaterial({ color: color!, roughness: 1 })),
    );
    layer.geometry.rotateY(Math.PI / 2);
    layer.position.y = -0.45 - index * 0.85;
    layer.receiveShadow = true;
    layer.castShadow = true;
    island.add(layer);
  });

  // --- props ---
  const foliageGeom = track(new ConeGeometry(0.5, 0.9, 7));
  const trunkGeom = track(new CylinderGeometry(0.07, 0.1, 0.3, 6));
  const trunkMat = track(
    new MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }),
  );
  const leafMats = [0x3f7a49, 0x4f8b4f, 0x5a9a58].map((c) =>
    track(new MeshStandardMaterial({ color: c, roughness: 0.8 })),
  );
  const addProp = (object: Object3D, delay: number) => {
    object.scale.setScalar(reduced ? 1 : 0.001);
    island.add(object);
    popIns.push({ object, delay });
  };
  const shadowed = (mesh: Mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  for (const cell of cells) {
    const roll = cellNoise(cell.q, cell.r, 5);
    const isHouse = cell.q === HOUSE_CELL.q && cell.r === HOUSE_CELL.r;
    if (cell.kind === "grass" && !isHouse && roll > 0.62) {
      const tree = new Group();
      const scale = 0.85 + cellNoise(cell.q, cell.r, 6) * 0.5;
      const leaves = leafMats[Math.floor(cellNoise(cell.q, cell.r, 7) * 3)]!;
      const trunk = shadowed(new Mesh(trunkGeom, trunkMat));
      trunk.position.y = 0.15;
      const lower = shadowed(new Mesh(foliageGeom, leaves));
      lower.position.y = 0.7;
      const upper = shadowed(new Mesh(foliageGeom, leaves));
      upper.position.y = 1.15;
      upper.scale.setScalar(0.72);
      tree.add(trunk, lower, upper);
      tree.scale.setScalar(scale);
      const holder = new Group();
      holder.position.set(
        cell.x + (cellNoise(cell.q, cell.r, 8) - 0.5) * 0.5,
        heightOf(cell),
        cell.z + (cellNoise(cell.q, cell.r, 4) - 0.5) * 0.5,
      );
      holder.add(tree);
      addProp(holder, 0.55 + delayOf(cell));
    }
    if (cell.kind === "park") {
      const flowers = new Group();
      const palette = [0xe8788a, 0xf5c542, 0xf6f0e0, 0xb48be0];
      for (let i = 0; i < 4; i += 1) {
        const bloom = new Mesh(
          track(new SphereGeometry(0.07, 8, 6)),
          track(
            new MeshStandardMaterial({
              color:
                palette[Math.floor(cellNoise(cell.q + i, cell.r, 11) * 4)]!,
              roughness: 0.6,
            }),
          ),
        );
        bloom.position.set(
          (cellNoise(cell.q, cell.r, 20 + i) - 0.5) * 1.3,
          0.1,
          (cellNoise(cell.q, cell.r, 30 + i) - 0.5) * 1.3,
        );
        flowers.add(bloom);
      }
      flowers.position.set(cell.x, heightOf(cell), cell.z);
      addProp(flowers, 0.7 + delayOf(cell));
    }
  }

  // Tinker Shed
  const houseCell = byKey.get(`${HOUSE_CELL.q},${HOUSE_CELL.r}`);
  if (houseCell) {
    const house = new Group();
    const walls = shadowed(
      new Mesh(
        track(new BoxGeometry(1.1, 0.7, 0.9)),
        track(new MeshStandardMaterial({ color: 0xe9d9b4, roughness: 0.9 })),
      ),
    );
    walls.position.y = 0.35;
    const roof = shadowed(
      new Mesh(
        track(new ConeGeometry(0.98, 0.6, 4)),
        track(new MeshStandardMaterial({ color: 0xb4583f, roughness: 0.8 })),
      ),
    );
    roof.rotation.y = Math.PI / 4;
    roof.scale.z = 0.85;
    roof.position.y = 1;
    const door = new Mesh(
      track(new BoxGeometry(0.22, 0.38, 0.05)),
      track(new MeshStandardMaterial({ color: 0x5b3d28 })),
    );
    door.position.set(0, 0.2, 0.46);
    house.add(walls, roof, door);
    house.position.set(houseCell.x, heightOf(houseCell), houseCell.z);
    house.rotation.y = -0.5;
    addProp(house, 0.5);
  }

  // Plaza fountain
  const fountain = new Group();
  const basin = shadowed(
    new Mesh(
      track(new CylinderGeometry(0.62, 0.7, 0.22, 16)),
      track(new MeshStandardMaterial({ color: 0xd6cdb8, roughness: 0.9 })),
    ),
  );
  basin.position.y = 0.11;
  const water = new Mesh(
    track(new CylinderGeometry(0.5, 0.5, 0.05, 16)),
    track(new MeshStandardMaterial({ color: 0x7cc3d1, roughness: 0.15 })),
  );
  water.position.y = 0.2;
  const spout = shadowed(
    new Mesh(track(new CylinderGeometry(0.06, 0.09, 0.4, 8)), basin.material),
  );
  spout.position.y = 0.36;
  fountain.add(basin, water, spout);
  fountain.position.set(0, TILE_THICKNESS.plaza, 0);
  addProp(fountain, 0.3);

  // --- clouds ---
  const cloudMat = track(
    new MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
    }),
  );
  const cloudGeom = track(new SphereGeometry(1, 12, 10));
  const clouds: Group[] = [];
  [
    { x: -9, y: 5.2, z: -3, s: 1 },
    { x: 8, y: 6.4, z: -7, s: 1.25 },
    { x: 1, y: 7.4, z: 5, s: 0.8 },
  ].forEach((spec, index) => {
    const cloud = new Group();
    [
      [0, 0, 0, 1],
      [0.9, -0.12, 0.1, 0.72],
      [-0.9, -0.15, 0, 0.66],
    ].forEach(([x, y, z, r]) => {
      const puff = new Mesh(cloudGeom, cloudMat);
      puff.position.set(x!, y!, z!);
      puff.scale.set(r! * 1.3, r! * 0.7, r!);
      cloud.add(puff);
    });
    cloud.position.set(spec.x, spec.y, spec.z);
    cloud.scale.setScalar(spec.s);
    cloud.userData.speed = 0.18 + index * 0.05;
    clouds.push(cloud);
    scene.add(cloud);
  });

  // --- characters ---
  const bodyGeom = track(new CapsuleGeometry(0.17, 0.28, 4, 10));
  const headGeom = track(new SphereGeometry(0.155, 14, 12));
  const wanderers: Wanderer[] = CAST.map((member, index) => {
    const candidates = cells.filter(walkable);
    const start = candidates[(index * 9 + 4) % candidates.length]!;
    const group = new Group();
    const body = shadowed(
      new Mesh(
        bodyGeom,
        track(
          new MeshStandardMaterial({ color: member.color, roughness: 0.5 }),
        ),
      ),
    );
    body.position.y = 0.34;
    const head = shadowed(
      new Mesh(
        headGeom,
        track(
          new MeshStandardMaterial({ color: SKIN[index]!, roughness: 0.6 }),
        ),
      ),
    );
    head.position.y = 0.76;
    group.add(body, head);
    group.userData.name = member.name;
    island.add(group);
    const options = neighbors(start, byKey);
    return {
      group,
      name: member.name,
      lines: member.lines,
      from: start,
      to: options[index % options.length] ?? start,
      t: index / CAST.length,
      duration: 1.9 + (index % 3) * 0.45,
      rest: 0,
      hop: 0,
      heading: 0,
    };
  });

  // --- speech bubble (DOM, projected over the canvas) ---
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.setAttribute("aria-hidden", "true");
  const bubbleName = document.createElement("b");
  const bubbleText = document.createElement("span");
  bubble.append(bubbleName, bubbleText);
  stage?.append(bubble);
  let speaker: Wanderer | null = null;
  let speakUntil = 0;
  let nextSpeak = 2.2;
  const speak = (who: Wanderer, line: string, now: number, hold = 3) => {
    speaker = who;
    bubbleName.textContent = who.name;
    bubbleText.textContent = line;
    bubble.classList.add("on");
    speakUntil = now + hold;
  };

  // --- layout ---
  const fit = () => {
    const wrap = canvas.parentElement;
    const width = wrap?.clientWidth || canvas.clientWidth || 640;
    const height = wrap?.clientHeight || 420;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    const halfFov = Math.tan((camera.fov * Math.PI) / 360);
    const needV = 7.4 / halfFov;
    const needH = 10.2 / (halfFov * camera.aspect);
    cameraDistance = Math.max(needV, needH);
  };
  let cameraDistance = 34;
  fit();

  let pointerX = 0;
  let pointerY = 0;
  const onPointer = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointerX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointerY = ((event.clientY - rect.top) / rect.height) * 2 - 1;
  };
  window.addEventListener("pointermove", onPointer);

  // Poke a character: it hops and says something.
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const onDown = (event: PointerEvent) => {
    if (reduced) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      wanderers.map((w) => w.group),
      true,
    );
    const hit = hits[0]?.object;
    const who = wanderers.find((w) => hit && w.group.children.includes(hit));
    if (!who) return;
    who.hop = 1;
    speak(
      who,
      who.lines[Math.floor(Math.random() * who.lines.length)]!,
      elapsed,
    );
  };
  const onMoveCursor = (event: PointerEvent) => {
    if (reduced) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const over = raycaster.intersectObjects(
      wanderers.map((w) => w.group),
      true,
    ).length;
    canvas.style.cursor = over ? "pointer" : "";
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMoveCursor);

  // --- loop ---
  let visible = document.visibilityState === "visible";
  let onscreen = true;
  let frame = 0;
  let elapsed = 0;
  let last = performance.now();
  const anchor = new Vector3();
  const look = new Vector3(0, -2, 0);
  const smooth = new Vector3();

  const stepWanderer = (w: Wanderer, dt: number) => {
    w.hop = Math.max(0, w.hop - dt * 2.2);
    if (w.rest > 0) {
      w.rest -= dt;
    } else {
      w.t += dt / w.duration;
      if (w.t >= 1) {
        w.from = w.to;
        const options = neighbors(w.from, byKey);
        w.to = options[Math.floor(Math.random() * options.length)] ?? w.from;
        w.t = 0;
        w.rest = Math.random() < 0.55 ? 0.6 + Math.random() * 1.8 : 0;
      }
    }
    const t = w.t * w.t * (3 - 2 * w.t);
    const walking = w.rest <= 0 && w.from !== w.to;
    const x = w.from.x + (w.to.x - w.from.x) * t;
    const z = w.from.z + (w.to.z - w.from.z) * t;
    const ground = heightOf(w.from) + (heightOf(w.to) - heightOf(w.from)) * t;
    const step = walking ? Math.abs(Math.sin(elapsed * 9 + w.duration)) : 0;
    const hop = Math.sin(w.hop * Math.PI) * 0.45;
    w.group.position.set(x, ground + step * 0.07 + hop, z);
    if (walking) {
      const target = Math.atan2(w.to.x - w.from.x, w.to.z - w.from.z);
      let delta = target - w.heading;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      w.heading += delta * Math.min(1, dt * 8);
    }
    w.group.rotation.y = w.heading;
    // squash a little when idle so they feel alive
    const breathe = 1 + Math.sin(elapsed * 2.4 + w.duration * 3) * 0.015;
    w.group.scale.set(1, breathe, 1);
  };

  const render = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;

    if (!reduced) {
      placeTiles(elapsed);
      for (const prop of popIns) {
        const k = easeOutBack(clamp01((elapsed - prop.delay) / 0.6));
        prop.object.scale.setScalar(Math.max(0.001, k));
      }
      for (const w of wanderers) stepWanderer(w, dt);
      for (const cloud of clouds) {
        cloud.position.x += dt * (cloud.userData.speed as number);
        if (cloud.position.x > 13) cloud.position.x = -13;
      }
      island.position.y = Math.sin(elapsed * 0.9) * 0.12;
      island.rotation.y = Math.sin(elapsed * 0.15) * 0.05;

      if (elapsed > nextSpeak && elapsed > 1.6) {
        const pick = wanderers[Math.floor(Math.random() * wanderers.length)]!;
        speak(
          pick,
          pick.lines[Math.floor(Math.random() * pick.lines.length)]!,
          elapsed,
          2.8,
        );
        nextSpeak = elapsed + 4.2 + Math.random() * 2;
      }
      if (speaker && elapsed > speakUntil) {
        bubble.classList.remove("on");
        speaker = null;
      }
    }

    const parallax = reduced ? 0 : 1;
    smooth.set(
      pointerX * 1.4 * parallax + Math.sin(elapsed * 0.12) * 0.5 * parallax,
      pointerY * -0.8 * parallax,
      0,
    );
    camera.position
      .copy(viewDir)
      .multiplyScalar(cameraDistance)
      .add(smooth)
      .add(look);
    camera.lookAt(look);
    renderer.render(scene, camera);

    if (speaker) {
      anchor.copy(speaker.group.position);
      anchor.y += 1.15;
      island.localToWorld(anchor);
      anchor.project(camera);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      bubble.style.transform = `translate(${((anchor.x + 1) / 2) * w}px, ${((1 - anchor.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  };

  const tick = (now: number) => {
    if (!visible || !onscreen) {
      frame = 0;
      return;
    }
    render(now);
    if (!reduced) frame = requestAnimationFrame(tick);
  };

  const wake = () => {
    if (visible && onscreen && !reduced && !frame) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  };
  const onVisibility = () => {
    visible = document.visibilityState === "visible";
    wake();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const observer = new IntersectionObserver((entries) => {
    onscreen = entries.some((entry) => entry.isIntersecting);
    wake();
  });
  observer.observe(canvas);
  const onResize = () => {
    fit();
    if (reduced) render(performance.now());
  };
  window.addEventListener("resize", onResize);

  for (const w of wanderers) stepWanderer(w, 0);
  render(performance.now());
  if (!reduced) frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onPointer);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMoveCursor);
    observer.disconnect();
    bubble.remove();
    for (const item of disposables) item.dispose();
    renderer.dispose();
  };
}
