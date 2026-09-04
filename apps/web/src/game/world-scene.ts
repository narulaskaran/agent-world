import * as THREE from "three";
import type { PublicCharacter, WorldSnapshot } from "@agent-world/shared";
import {
  DEFAULT_DISTANCE,
  MAX_DISTANCE,
  MIN_DISTANCE,
  PAN_BOUNDS,
  PLAZA_FOCUS,
  applyPinchZoom,
  applyZoomDelta,
  cameraOffset,
  clamp,
  isDragGesture,
  panFromScreenDelta,
  pointerSpan,
  rubberBand,
  spring,
} from "./camera";
import {
  HEX_SIZE,
  TERRAIN_COLORS,
  TILE_THICKNESS,
  TILE_TOP,
  hexesCoveringWorld,
} from "./hex";
import { createLandmarks, locationSignAnchors } from "./landmarks";

const SKIN = [0x78bd77, 0x6da7d9, 0xa77ac4, 0xe49a50, 0xd978a5, 0x65b8b0];
const HAIR = [0x324c3c, 0x3c4770, 0x533a68, 0x70442f, 0x67384e, 0x305c5b];

interface CharacterNode {
  id: string;
  group: THREE.Group;
  hit: THREE.Object3D;
  selection: THREE.Mesh;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  tool: THREE.Mesh;
  visualX: number;
  visualZ: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  moveStarted: number;
  moveDuration: number;
  moving: boolean;
  state: string;
  speaking: boolean;
  blinkOffset: number;
  label: HTMLDivElement;
}

export class WorldScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private overlay: HTMLDivElement;
  private labels: HTMLDivElement;
  private signLabels: HTMLDivElement[] = [];
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private hitTarget = new THREE.Vector3();
  private cameraTarget = new THREE.Vector3(PLAZA_FOCUS.x, 0, PLAZA_FOCUS.z);
  private desiredTarget = this.cameraTarget.clone();
  private distance = DEFAULT_DISTANCE;
  private desiredDistance = DEFAULT_DISTANCE;
  private interacting = false;
  private raf = 0;
  private disposed = false;
  private nodes = new Map<string, CharacterNode>();
  private fountainRings: THREE.Mesh[] = [];
  private cafeGlow?: THREE.Mesh;
  private pointers = new Map<number, { x: number; y: number }>();
  private panOrigin: {
    x: number;
    y: number;
    targetX: number;
    targetZ: number;
  } | null = null;
  private pinchOrigin: { span: number; distance: number } | null = null;
  private pointerMoved = false;
  private suppressClick = false;
  private snapshot: WorldSnapshot | null = null;
  private selectedId: string | null = null;
  private onSelect: (id: string | null) => void;
  private host: HTMLElement;
  private resizeObserver: ResizeObserver;

  constructor(host: HTMLElement, onSelect: (id: string | null) => void) {
    this.host = host;
    this.onSelect = onSelect;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xd7e3ee);
    this.scene.fog = new THREE.Fog(0xe7dcc6, 920, 1880);

    this.camera = new THREE.PerspectiveCamera(42, 1, 8, 4000);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "world-gl";
    this.renderer.domElement.setAttribute("aria-hidden", "true");

    this.overlay = document.createElement("div");
    this.overlay.className = "world-overlay";
    this.labels = document.createElement("div");
    this.labels.className = "world-labels";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "camera-reset";
    reset.textContent = "Reset view";
    reset.addEventListener("click", (event) => {
      event.stopPropagation();
      this.resetCamera();
    });
    this.overlay.append(this.labels, reset);

    host.append(this.renderer.domElement, this.overlay);
    this.addLights();
    this.addTerrain();
    const landmarks = createLandmarks(this.scene);
    this.fountainRings = landmarks.fountainRings;
    this.cafeGlow = landmarks.cafeGlow;
    this.addLocationSigns();
    this.bindInput();
    this.resize();
    this.applyCamera(true);
    this.clock.getDelta();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.raf = requestAnimationFrame(this.tick);
  }

  setOnSelect(onSelect: (id: string | null) => void) {
    this.onSelect = onSelect;
  }

  resetCamera() {
    this.desiredTarget.set(PLAZA_FOCUS.x, 0, PLAZA_FOCUS.z);
    this.desiredDistance = DEFAULT_DISTANCE;
    this.interacting = false;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.unbindInput();
    for (const node of this.nodes.values()) node.label.remove();
    this.nodes.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }

  sync(snapshot: WorldSnapshot, selectedId: string | null) {
    this.snapshot = snapshot;
    this.selectedId = selectedId;
    const live = new Set(snapshot.characters.map((character) => character.id));
    for (const [id, node] of this.nodes) {
      if (!live.has(id)) {
        this.scene.remove(node.group);
        node.label.remove();
        this.nodes.delete(id);
      }
    }
    const now = performance.now();
    for (const character of snapshot.characters) {
      let node = this.nodes.get(character.id);
      if (!node) {
        node = this.createCharacter(character);
        this.nodes.set(character.id, node);
        this.scene.add(node.group);
        this.labels.append(node.label);
      }
      const destX =
        character.state === "moving" ? character.targetX : character.x;
      const destZ =
        character.state === "moving" ? character.targetY : character.y;
      const duration = character.state === "moving" ? 1_600 : 900;
      if (node.toX !== destX || node.toZ !== destZ) {
        node.fromX = node.visualX;
        node.fromZ = node.visualZ;
        node.toX = destX;
        node.toZ = destZ;
        node.moveStarted = now;
        node.moveDuration = duration;
      }
      node.moving = character.state === "moving";
      node.state = character.state;
      node.speaking = Boolean(character.speech);
      node.selection.visible = character.id === selectedId;
      node.tool.visible = character.toolActive;
      this.renderCharacterLabel(node, character, selectedId);
    }
  }

  private addLights() {
    const hemi = new THREE.HemisphereLight(0xfff3d6, 0x8ea57a, 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1cc, 1.15);
    sun.position.set(280, 420, 160);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 40;
    sun.shadow.camera.far = 1400;
    sun.shadow.camera.left = -520;
    sun.shadow.camera.right = 520;
    sun.shadow.camera.top = 380;
    sun.shadow.camera.bottom = -380;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xf2e6cc, 0.22));
  }

  private addTerrain() {
    const hexes = hexesCoveringWorld();
    const geometry = new THREE.CylinderGeometry(
      HEX_SIZE * 0.93,
      HEX_SIZE * 0.93,
      1,
      6,
    );
    geometry.rotateY(Math.PI / 6);
    const material = new THREE.MeshLambertMaterial({ vertexColors: false });
    const mesh = new THREE.InstancedMesh(geometry, material, hexes.length);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    hexes.forEach((cell, index) => {
      const thickness = TILE_THICKNESS[cell.kind];
      dummy.position.set(cell.x, thickness / 2, cell.z);
      dummy.scale.set(1, thickness, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      color.setHex(TERRAIN_COLORS[cell.kind]);
      const shade = ((cell.q * 13 + cell.r * 7) % 7) * 0.012;
      color.offsetHSL(0, 0, (cell.q + cell.r) % 2 === 0 ? shade : -shade);
      mesh.setColorAt(index, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1600, 1100),
      new THREE.MeshLambertMaterial({ color: 0x6f9558 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(560, 0.2, 350);
    floor.receiveShadow = true;
    floor.name = "ground-plane";
    this.scene.add(floor);
  }

  private addLocationSigns() {
    for (const spot of locationSignAnchors()) {
      const el = document.createElement("div");
      el.className = "location-sign";
      el.textContent = spot.name;
      el.dataset.x = String(spot.x);
      el.dataset.z = String(spot.z);
      this.labels.append(el);
      this.signLabels.push(el);
    }
  }

  private createCharacter(character: PublicCharacter): CharacterNode {
    const paletteIndex = Math.abs(character.name.charCodeAt(0)) % SKIN.length;
    const skin = SKIN[paletteIndex] ?? 0xe8aa70;
    const hair = HAIR[paletteIndex] ?? 0x4b332c;
    const cloth = new THREE.Color(character.avatarColor);
    const group = new THREE.Group();
    group.position.set(character.x, TILE_TOP, character.y);

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(11, 16),
      new THREE.MeshBasicMaterial({
        color: 0x2d382d,
        transparent: true,
        opacity: 0.28,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.4;
    group.add(shadow);

    const selection = new THREE.Mesh(
      new THREE.RingGeometry(12, 16, 28),
      new THREE.MeshBasicMaterial({
        color: 0xfff5a8,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
      }),
    );
    selection.rotation.x = -Math.PI / 2;
    selection.position.y = 0.55;
    selection.visible = character.id === this.selectedId;
    group.add(selection);

    const leftLeg = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 10, 4.2),
      new THREE.MeshStandardMaterial({ color: 0x3f342e, roughness: 0.9 }),
    );
    leftLeg.position.set(-3.4, 5, 0);
    leftLeg.castShadow = true;
    const rightLeg = leftLeg.clone();
    rightLeg.position.x = 3.4;
    group.add(leftLeg, rightLeg);

    const leftArm = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 11, 3.2),
      new THREE.MeshStandardMaterial({ color: skin, roughness: 0.7 }),
    );
    leftArm.position.set(-8.2, 16, 0);
    leftArm.castShadow = true;
    const rightArm = leftArm.clone();
    rightArm.position.x = 8.2;
    group.add(leftArm, rightArm);

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(12, 16, 8),
      new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.72 }),
    );
    body.position.y = 18;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(6.4, 14, 12),
      new THREE.MeshStandardMaterial({ color: skin, roughness: 0.62 }),
    );
    head.position.y = 30.5;
    head.castShadow = true;
    group.add(head);

    const hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(6.2, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: hair, roughness: 0.8 }),
    );
    hairCap.position.y = 32.4;
    group.add(hairCap);

    const tool = new THREE.Mesh(
      new THREE.BoxGeometry(5, 5, 5),
      new THREE.MeshStandardMaterial({ color: 0xd7a04a, roughness: 0.45 }),
    );
    tool.position.set(0, 42, 0);
    tool.visible = character.toolActive;
    group.add(tool);

    const hit = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 14, 40, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = 20;
    hit.userData.characterId = character.id;
    group.add(hit);

    const label = document.createElement("div");
    label.className = "character-label";

    return {
      id: character.id,
      group,
      hit,
      selection,
      leftLeg,
      rightLeg,
      leftArm,
      rightArm,
      tool,
      visualX: character.x,
      visualZ: character.y,
      fromX: character.x,
      fromZ: character.y,
      toX: character.x,
      toZ: character.y,
      moveStarted: performance.now(),
      moveDuration: 1,
      moving: character.state === "moving",
      state: character.state,
      speaking: Boolean(character.speech),
      blinkOffset: character.name.charCodeAt(0) * 137,
      label,
    };
  }

  private renderCharacterLabel(
    node: CharacterNode,
    character: PublicCharacter,
    selectedId: string | null,
  ) {
    const selected = character.id === selectedId;
    const intent =
      selected && character.state !== "talking" && !character.speech
        ? character.intent
        : "";
    const sleep =
      character.state === "sleeping" || character.state === "paused"
        ? "Zzz"
        : "";
    const stateSymbols: Record<string, string> = {
      waiting: "…",
      tool: "⌁",
      sleeping: "☾",
      paused: "Ⅱ",
    };
    const stateIcon =
      !character.toolActive && stateSymbols[character.state]
        ? stateSymbols[character.state]
        : "";
    node.label.innerHTML = `${
      character.speech
        ? `<span class="speech-bubble">${escapeHtml(character.speech)}</span>`
        : ""
    }${stateIcon ? `<span class="state-icon">${stateIcon}</span>` : ""}${
      sleep ? `<span class="sleep-icon">${sleep}</span>` : ""
    }<span class="name-chip">${escapeHtml(character.name)}</span>${
      intent ? `<span class="intent-chip">${escapeHtml(intent)}</span>` : ""
    }`;
  }

  private bindInput() {
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("contextmenu", this.onContextMenu);
  }

  private unbindInput() {
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onPointerDown);
    el.removeEventListener("pointermove", this.onPointerMove);
    el.removeEventListener("pointerup", this.onPointerUp);
    el.removeEventListener("pointercancel", this.onPointerUp);
    el.removeEventListener("wheel", this.onWheel);
    el.removeEventListener("contextmenu", this.onContextMenu);
  }

  private onContextMenu = (event: Event) => event.preventDefault();

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    event.stopPropagation();
    this.desiredDistance = applyZoomDelta(this.desiredDistance, event.deltaY);
  };

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.pointerMoved = false;
    this.suppressClick = false;
    this.interacting = true;
    if (this.pointers.size === 1) {
      this.panOrigin = {
        x: event.clientX,
        y: event.clientY,
        targetX: this.desiredTarget.x,
        targetZ: this.desiredTarget.z,
      };
      this.pinchOrigin = null;
    } else if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      this.pinchOrigin = {
        span: pointerSpan(pts[0]!, pts[1]!),
        distance: this.desiredDistance,
      };
      this.panOrigin = null;
      this.suppressClick = true;
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2 && this.pinchOrigin) {
      const pts = [...this.pointers.values()];
      this.desiredDistance = applyPinchZoom(
        this.pinchOrigin.distance,
        this.pinchOrigin.span,
        pointerSpan(pts[0]!, pts[1]!),
      );
      this.pointerMoved = true;
      this.suppressClick = true;
      return;
    }
    if (!this.panOrigin || this.pointers.size !== 1) return;
    const dx = event.clientX - this.panOrigin.x;
    const dy = event.clientY - this.panOrigin.y;
    if (isDragGesture(dx, dy)) {
      this.pointerMoved = true;
      this.renderer.domElement.classList.add("is-panning");
      const pan = panFromScreenDelta(
        dx,
        dy,
        this.distance,
        this.host.clientHeight,
      );
      this.desiredTarget.set(
        this.panOrigin.targetX + pan.x,
        0,
        this.panOrigin.targetZ + pan.z,
      );
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    const start = this.pointers.get(event.pointerId);
    this.pointers.delete(event.pointerId);
    try {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    this.renderer.domElement.classList.remove("is-panning");
    if (this.pointers.size === 0) {
      this.interacting = false;
      this.panOrigin = null;
      this.pinchOrigin = null;
      if (
        start &&
        !this.suppressClick &&
        !this.pointerMoved &&
        !isDragGesture(event.clientX - start.x, event.clientY - start.y)
      ) {
        this.pick(event.clientX, event.clientY);
      }
    } else if (this.pointers.size === 1) {
      const remaining = [...this.pointers.entries()][0]!;
      this.panOrigin = {
        x: remaining[1].x,
        y: remaining[1].y,
        targetX: this.desiredTarget.x,
        targetZ: this.desiredTarget.z,
      };
      this.pinchOrigin = null;
      this.suppressClick = true;
    }
  };

  private pick(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = [...this.nodes.values()].map((node) => node.hit);
    const found = this.raycaster.intersectObjects(hits, false)[0];
    const id = found?.object.userData.characterId;
    this.onSelect(typeof id === "string" ? id : null);
  }

  private resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private applyCamera(immediate = false) {
    const dt = immediate ? 1 : this.clock.getDelta();
    const minX = PAN_BOUNDS.minX;
    const maxX = PAN_BOUNDS.maxX;
    const minZ = PAN_BOUNDS.minZ;
    const maxZ = PAN_BOUNDS.maxZ;
    if (!this.interacting) {
      this.desiredDistance = spring(
        this.desiredDistance,
        clamp(this.desiredDistance, MIN_DISTANCE, MAX_DISTANCE),
        dt,
        6,
      );
      this.desiredTarget.x = spring(
        this.desiredTarget.x,
        clamp(this.desiredTarget.x, minX, maxX),
        dt,
        6,
      );
      this.desiredTarget.z = spring(
        this.desiredTarget.z,
        clamp(this.desiredTarget.z, minZ, maxZ),
        dt,
        6,
      );
    }
    const bandedDistance = rubberBand(
      this.desiredDistance,
      MIN_DISTANCE,
      MAX_DISTANCE,
    );
    this.distance = immediate
      ? bandedDistance
      : spring(this.distance, bandedDistance, dt, 12);
    const bandedX = rubberBand(this.desiredTarget.x, minX, maxX);
    const bandedZ = rubberBand(this.desiredTarget.z, minZ, maxZ);
    this.cameraTarget.x = immediate
      ? bandedX
      : spring(this.cameraTarget.x, bandedX, dt, 14);
    this.cameraTarget.z = immediate
      ? bandedZ
      : spring(this.cameraTarget.z, bandedZ, dt, 14);
    const offset = cameraOffset(this.distance);
    this.camera.position.set(
      this.cameraTarget.x + offset.x,
      offset.y,
      this.cameraTarget.z + offset.z,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.cameraTarget.x, 10, this.cameraTarget.z);
  }

  private tick = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
    const time = performance.now();
    this.applyCamera();
    this.fountainRings.forEach((ring, index) => {
      const cycle = (time / 1_400 + index / this.fountainRings.length) % 1;
      const scale = 0.55 + cycle * 1.15;
      ring.scale.set(scale, scale, scale);
      const material = ring.material as THREE.MeshBasicMaterial;
      material.opacity = (1 - cycle) * 0.42;
    });
    if (this.cafeGlow) {
      const material = this.cafeGlow.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = 0.22 + (Math.sin(time / 850) + 1) * 0.16;
    }
    for (const node of this.nodes.values()) {
      const t = clamp(
        (time - node.moveStarted) / Math.max(1, node.moveDuration),
        0,
        1,
      );
      node.visualX = node.fromX + (node.toX - node.fromX) * t;
      node.visualZ = node.fromZ + (node.toZ - node.fromZ) * t;
      const bob = node.moving ? Math.abs(Math.sin(time / 85)) * 1.4 : 0;
      node.group.position.set(node.visualX, TILE_TOP + bob, node.visualZ);
      const dx = node.toX - node.fromX;
      const dz = node.toZ - node.fromZ;
      if (node.moving && (Math.abs(dx) > 0.4 || Math.abs(dz) > 0.4)) {
        node.group.rotation.y = Math.atan2(dx, dz);
      }
      const stride = node.moving ? Math.sin(time / 85) : 0;
      node.leftLeg.rotation.x = stride * 0.7;
      node.rightLeg.rotation.x = -stride * 0.7;
      node.leftArm.rotation.x = -stride * 0.55;
      node.rightArm.rotation.x = stride * 0.55;
      const pulse = 1 + Math.sin(time / 220) * 0.06;
      if (node.selection.visible) node.selection.scale.set(pulse, pulse, pulse);
      this.placeLabel(node.label, node.visualX, 46, node.visualZ);
    }
    for (const sign of this.signLabels) {
      const x = Number(sign.dataset.x);
      const z = Number(sign.dataset.z);
      this.placeLabel(sign, x, 28, z);
    }
    this.renderer.render(this.scene, this.camera);
  };

  private placeLabel(el: HTMLElement, x: number, y: number, z: number) {
    this.hitTarget.set(x, y, z).project(this.camera);
    const visible =
      this.hitTarget.z < 1 &&
      this.hitTarget.x > -1.2 &&
      this.hitTarget.x < 1.2 &&
      this.hitTarget.y > -1.2 &&
      this.hitTarget.y < 1.2;
    el.hidden = !visible;
    if (!visible) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    el.style.left = `${(this.hitTarget.x * 0.5 + 0.5) * width}px`;
    el.style.top = `${(-this.hitTarget.y * 0.5 + 0.5) * height}px`;
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
