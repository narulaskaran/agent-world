import * as THREE from "three";
import { TILE_TOP } from "./hex";

const SIGN_SPOTS: Array<{ name: string; x: number; z: number }> = [
  { name: "The Tiny Cup", x: 143, z: 171 },
  { name: "The Memory Stack", x: 145, z: 653 },
  { name: "Sunbeam Plaza", x: 572, z: 215 },
  { name: "Mossbell Park", x: 875, z: 76 },
  { name: "Tinker Shed", x: 880, z: 470 },
];

function std(color: number, extras?: THREE.MeshStandardMaterialParameters) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.84,
    metalness: 0.05,
    ...extras,
  });
}

function box(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
  extras?: THREE.MeshStandardMaterialParameters,
) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    std(color, extras),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  color: number,
  x: number,
  y: number,
  z: number,
  segments = 10,
) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    std(color),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addTree(parent: THREE.Object3D, x: number, z: number, scale = 1) {
  const tree = new THREE.Group();
  tree.position.set(x, TILE_TOP, z);
  tree.add(
    cyl(2.2 * scale, 2.8 * scale, 14 * scale, 0x6a4a32, 0, 7 * scale, 0, 6),
  );
  const canopy = new THREE.Mesh(
    new THREE.IcosahedronGeometry(11 * scale, 0),
    std(0x4f8a4c),
  );
  canopy.position.y = 18 * scale;
  canopy.castShadow = true;
  tree.add(canopy);
  const mid = new THREE.Mesh(
    new THREE.IcosahedronGeometry(8 * scale, 0),
    std(0x5c9b55),
  );
  mid.position.set(4 * scale, 16 * scale, -2 * scale);
  mid.castShadow = true;
  tree.add(mid);
  parent.add(tree);
}

function addCafe(parent: THREE.Object3D) {
  const x = 168;
  // North of cafe waypoints so agents stand in the courtyard, not inside the walls.
  const z = 118;
  parent.add(box(92, 38, 62, 0xc88d6c, x, TILE_TOP + 19, z));
  parent.add(box(100, 6, 70, 0x915d4a, x, TILE_TOP + 40, z));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(62, 22, 4), std(0xb97559));
  roof.position.set(x, TILE_TOP + 54, z);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  parent.add(roof);
  parent.add(
    box(38, 22, 4, 0x7ab0a6, x - 18, TILE_TOP + 20, z + 32, {
      emissive: 0x3a5c56,
      emissiveIntensity: 0.18,
    }),
  );
  parent.add(box(16, 24, 8, 0x573d34, x + 22, TILE_TOP + 12, z + 34));
  parent.add(box(10, 16, 10, 0x7c4c39, x + 40, TILE_TOP + 46, z - 8));
  parent.add(box(54, 3, 18, 0xe9d5a2, x, TILE_TOP + 28, z + 40));
  const glow = box(48, 10, 8, 0xffd98b, x - 8, TILE_TOP + 16, z + 36, {
    emissive: 0xffc56a,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.55,
  });
  glow.name = "cafe-glow";
  parent.add(glow);
}

function addLibrary(parent: THREE.Object3D) {
  const x = 210;
  const z = 488;
  parent.add(box(78, 52, 58, 0x8a87ad, x, TILE_TOP + 26, z));
  parent.add(box(62, 22, 46, 0x9b98be, x, TILE_TOP + 63, z - 4));
  parent.add(box(42, 16, 32, 0x7d7aa3, x, TILE_TOP + 82, z - 6));
  parent.add(box(88, 6, 20, 0xd9c7a2, x, TILE_TOP + 3, z + 36));
  parent.add(box(8, 28, 8, 0xefe6cf, x - 22, TILE_TOP + 20, z + 28));
  parent.add(box(8, 28, 8, 0xefe6cf, x + 22, TILE_TOP + 20, z + 28));
  parent.add(box(14, 18, 6, 0x4d4568, x, TILE_TOP + 9, z + 30));
}

function addWorkshop(parent: THREE.Object3D) {
  const x = 890;
  const z = 478;
  parent.add(box(72, 28, 50, 0xb08968, x, TILE_TOP + 14, z));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(48, 20, 4), std(0x8a6246));
  roof.position.set(x, TILE_TOP + 38, z);
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  parent.add(roof);
  parent.add(box(14, 18, 6, 0x5c3d2e, x, TILE_TOP + 9, z + 26));
  parent.add(box(18, 10, 22, 0x7a5840, x + 28, TILE_TOP + 5, z + 8));
  parent.add(cyl(3, 3, 16, 0x6a4a32, x - 24, TILE_TOP + 36, z - 10, 6));
}

function addFountain(parent: THREE.Object3D) {
  const x = 572;
  const z = 330;
  parent.add(cyl(36, 38, 6, 0xd9d0b4, x, TILE_TOP + 3, z, 16));
  parent.add(cyl(22, 24, 8, 0xcfc6ab, x, TILE_TOP + 10, z, 14));
  parent.add(cyl(8, 10, 16, 0xe8e0c8, x, TILE_TOP + 20, z, 12));
  parent.add(cyl(14, 14, 4, 0xb7dfe2, x, TILE_TOP + 28, z, 16));
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(18, 20),
    new THREE.MeshStandardMaterial({
      color: 0x8ec9d2,
      roughness: 0.22,
      metalness: 0.18,
      transparent: true,
      opacity: 0.82,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(x, TILE_TOP + 6.4, z);
  parent.add(water);
  const rings: THREE.Mesh[] = [];
  for (let index = 0; index < 3; index++) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(8, 10, 24),
      new THREE.MeshBasicMaterial({
        color: 0xd9f4f5,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, TILE_TOP + 7.2, z);
    ring.userData.ring = index;
    parent.add(ring);
    rings.push(ring);
  }
  return rings;
}

/**
 * Solid XZ footprints for landmark buildings. Keep these in sync with the
 * meshes above so living characters can stand in courtyards instead of inside
 * the sheds.
 */
export const LANDMARK_FOOTPRINTS = [
  { id: "cafe", x: 168, z: 118, halfX: 50, halfZ: 36 },
  { id: "library", x: 210, z: 488, halfX: 44, halfZ: 32 },
  { id: "workshop", x: 890, z: 478, halfX: 40, halfZ: 28 },
] as const;

export const STAND_CLEARANCE = 12;

export function pointInLandmarkFootprint(
  x: number,
  z: number,
  footprint: (typeof LANDMARK_FOOTPRINTS)[number],
): boolean {
  return (
    Math.abs(x - footprint.x) <= footprint.halfX &&
    Math.abs(z - footprint.z) <= footprint.halfZ
  );
}

/** Push a board point south (+Z, toward the overview camera) out of buildings. */
export function clearLandmarkFootprint(
  x: number,
  z: number,
): { x: number; z: number } {
  let px = x;
  let pz = z;
  for (let step = 0; step < 4; step++) {
    let moved = false;
    for (const footprint of LANDMARK_FOOTPRINTS) {
      if (!pointInLandmarkFootprint(px, pz, footprint)) continue;
      pz = footprint.z + footprint.halfZ + STAND_CLEARANCE;
      moved = true;
    }
    if (!moved) break;
  }
  return { x: px, z: pz };
}

export function createLandmarks(parent: THREE.Object3D): {
  fountainRings: THREE.Mesh[];
  cafeGlow?: THREE.Mesh;
} {
  addCafe(parent);
  addLibrary(parent);
  addWorkshop(parent);
  const fountainRings = addFountain(parent);
  addTree(parent, 820, 140, 1.15);
  addTree(parent, 940, 110, 0.9);
  addTree(parent, 980, 210, 1.05);
  addTree(parent, 790, 430, 1.2);
  addTree(parent, 1010, 470, 0.85);
  addTree(parent, 430, 170, 0.8);
  addTree(parent, 400, 500, 0.75);
  const parkFlower = box(8, 3, 8, 0xd978a5, 900, TILE_TOP + 2, 200);
  parent.add(parkFlower);
  parent.add(box(7, 3, 7, 0xe49a50, 930, TILE_TOP + 2, 240));
  parent.add(box(7, 3, 7, 0x6da7d9, 860, TILE_TOP + 2, 170));
  return {
    fountainRings,
    cafeGlow: parent.getObjectByName("cafe-glow") as THREE.Mesh | undefined,
  };
}

export function locationSignAnchors() {
  return SIGN_SPOTS;
}
