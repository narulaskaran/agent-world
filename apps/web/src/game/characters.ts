import * as THREE from "three";
import type { PublicCharacter } from "@agent-world/shared";
import { HEX_SIZE, TILE_TOP } from "./hex";
import { clearLandmarkFootprint } from "./landmarks";

const SKIN = [0x78bd77, 0x6da7d9, 0xa77ac4, 0xe49a50, 0xd978a5, 0x65b8b0];
const HAIR = [0x324c3c, 0x3c4770, 0x533a68, 0x70442f, 0x67384e, 0x305c5b];

/** Pawn scale: readable at overview zoom without towering over landmarks. */
export const CHARACTER_SCALE = 1.2;

/** About one hex — large enough to tap at default Civ distance on a 390px view. */
export const CHARACTER_HIT_RADIUS = HEX_SIZE;
export const CHARACTER_HIT_HEIGHT = 56;
export const CHARACTER_LABEL_HEIGHT = 50;
export const PAWN_FRAME_RADIUS = 22;
export const PAWN_FRAME_TOP = TILE_TOP + 72;

export interface CharacterAvatar {
  group: THREE.Group;
  hit: THREE.Mesh;
  selection: THREE.Mesh;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  leftArm: THREE.Mesh;
  rightArm: THREE.Mesh;
  tool: THREE.Mesh;
}

export function characterStandPose(
  x: number,
  z: number,
): { x: number; y: number; z: number } {
  const cleared = clearLandmarkFootprint(x, z);
  return { x: cleared.x, y: TILE_TOP + 0.35, z: cleared.z };
}

/** Corners used to keep the whole pawn (mesh + name chip) inside the canvas. */
export function pawnFrameSamples(
  x: number,
  z: number,
): Array<{ x: number; y: number; z: number }> {
  const pose = characterStandPose(x, z);
  const r = PAWN_FRAME_RADIUS;
  return [
    { x: pose.x, y: pose.y, z: pose.z },
    { x: pose.x, y: PAWN_FRAME_TOP, z: pose.z },
    { x: pose.x - r, y: pose.y, z: pose.z },
    { x: pose.x + r, y: pose.y, z: pose.z },
    { x: pose.x, y: pose.y, z: pose.z - r },
    { x: pose.x, y: pose.y, z: pose.z + r },
    { x: pose.x - r, y: PAWN_FRAME_TOP, z: pose.z - r },
    { x: pose.x + r, y: PAWN_FRAME_TOP, z: pose.z + r },
  ];
}

function cloth(color: number) {
  return new THREE.MeshLambertMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.12,
  });
}

export function createCharacterHitMaterial() {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function createCharacterAvatar(
  character: PublicCharacter,
): CharacterAvatar {
  const paletteIndex = Math.abs(character.name.charCodeAt(0)) % SKIN.length;
  const skin = SKIN[paletteIndex] ?? 0xe8aa70;
  const hair = HAIR[paletteIndex] ?? 0x4b332c;
  const outfit = new THREE.Color(character.avatarColor).getHex();
  const pose = characterStandPose(character.x, character.y);
  const group = new THREE.Group();
  group.name = `character:${character.id}`;
  group.userData.characterId = character.id;
  group.scale.setScalar(CHARACTER_SCALE);
  group.position.set(pose.x, pose.y, pose.z);
  group.frustumCulled = false;
  group.renderOrder = 8;

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(12, 16),
    new THREE.MeshBasicMaterial({
      color: 0x2d382d,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.45;
  shadow.renderOrder = 7;
  group.add(shadow);

  const selection = new THREE.Mesh(
    new THREE.RingGeometry(13, 17, 28),
    new THREE.MeshBasicMaterial({
      color: 0xfff5a8,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  selection.rotation.x = -Math.PI / 2;
  selection.position.y = 0.6;
  selection.visible = false;
  selection.renderOrder = 9;
  group.add(selection);

  const leftLeg = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 10, 4.2),
    cloth(0x3f342e),
  );
  leftLeg.position.set(-3.4, 5, 0);
  leftLeg.castShadow = true;
  leftLeg.userData.characterId = character.id;
  const rightLeg = leftLeg.clone();
  rightLeg.position.x = 3.4;
  group.add(leftLeg, rightLeg);

  const leftArm = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 11, 3.2),
    cloth(skin),
  );
  leftArm.position.set(-8.2, 16, 0);
  leftArm.castShadow = true;
  leftArm.userData.characterId = character.id;
  const rightArm = leftArm.clone();
  rightArm.position.x = 8.2;
  group.add(leftArm, rightArm);

  const body = new THREE.Mesh(new THREE.BoxGeometry(12, 16, 8), cloth(outfit));
  body.position.y = 18;
  body.castShadow = true;
  body.userData.characterId = character.id;
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(6.4, 14, 12),
    cloth(skin),
  );
  head.position.y = 30.5;
  head.castShadow = true;
  head.userData.characterId = character.id;
  group.add(head);

  const hairCap = new THREE.Mesh(
    new THREE.SphereGeometry(6.2, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    cloth(hair),
  );
  hairCap.position.y = 32.4;
  hairCap.userData.characterId = character.id;
  group.add(hairCap);

  const tool = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), cloth(0xd7a04a));
  tool.position.set(0, 42, 0);
  tool.visible = character.toolActive;
  tool.userData.characterId = character.id;
  group.add(tool);

  const hit = new THREE.Mesh(
    new THREE.CylinderGeometry(
      CHARACTER_HIT_RADIUS / CHARACTER_SCALE,
      CHARACTER_HIT_RADIUS / CHARACTER_SCALE,
      CHARACTER_HIT_HEIGHT / CHARACTER_SCALE,
      12,
    ),
    createCharacterHitMaterial(),
  );
  hit.position.y = CHARACTER_HIT_HEIGHT / CHARACTER_SCALE / 2;
  hit.userData.characterId = character.id;
  hit.frustumCulled = false;
  group.add(hit);

  group.traverse((child) => {
    child.frustumCulled = false;
  });

  return {
    group,
    hit,
    selection,
    leftLeg,
    rightLeg,
    leftArm,
    rightArm,
    tool,
  };
}

export function isCharacterObject(
  object: THREE.Object3D,
  characterId?: string,
): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    const id = current.userData.characterId;
    if (
      typeof id === "string" &&
      (characterId === undefined || id === characterId)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}
