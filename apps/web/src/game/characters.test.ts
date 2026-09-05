import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { LOCATION_WAYPOINTS, type PublicCharacter } from "@agent-world/shared";
import {
  cameraOffset,
  DEFAULT_DISTANCE,
  PLAZA_FOCUS,
  framePoints,
  sampleInFrame,
} from "./camera";
import {
  CHARACTER_HIT_RADIUS,
  characterStandPose,
  createCharacterAvatar,
  createCharacterHitMaterial,
  isCharacterObject,
  pawnFrameSamples,
} from "./characters";
import { TILE_TOP } from "./hex";
import {
  LANDMARK_FOOTPRINTS,
  clearLandmarkFootprint,
  courtyardStandZ,
  createLandmarks,
  pointInLandmarkFootprint,
} from "./landmarks";

function ksnAtShed(): PublicCharacter {
  return {
    id: "fc854a3d-e63e-4213-9fff-0712520fb153",
    name: "KSN",
    personality: "Curious maker.",
    model: "deterministic",
    dailyBudgetMicros: 500_000,
    spentTodayMicros: 0,
    decisionIntervalSeconds: 60,
    state: "paused",
    x: 880,
    y: 520,
    targetX: 880,
    targetY: 520,
    intent: "Paused by owner",
    speech: null,
    avatarUrl: null,
    avatarColor: "#4e9470",
    toolActive: false,
    reputation: 0,
    locationId: "workshop",
    memories: [],
    relationships: [],
    updatedAt: 0,
  };
}

describe("landmark courtyards", () => {
  it("keeps every location waypoint outside building footprints", () => {
    for (const [locationId, points] of Object.entries(LOCATION_WAYPOINTS)) {
      for (const point of points) {
        for (const footprint of LANDMARK_FOOTPRINTS) {
          expect(
            pointInLandmarkFootprint(point.x, point.y, footprint),
            `${locationId} waypoint ${point.x},${point.y} inside ${footprint.id}`,
          ).toBe(false);
        }
      }
    }
  });

  it("pushes a point buried in the Tinker Shed out to the south courtyard", () => {
    const workshop = LANDMARK_FOOTPRINTS.find(
      (item) => item.id === "workshop",
    )!;
    const buried = clearLandmarkFootprint(workshop.x, workshop.z);
    expect(pointInLandmarkFootprint(buried.x, buried.z, workshop)).toBe(false);
    expect(buried.z).toBeGreaterThanOrEqual(courtyardStandZ(workshop));
  });
});

describe("living character avatars", () => {
  it("stands on the tile top in front of the Tinker Shed", () => {
    const pose = characterStandPose(880, 520);
    expect(pose.y).toBeGreaterThanOrEqual(TILE_TOP);
    const workshop = LANDMARK_FOOTPRINTS.find(
      (item) => item.id === "workshop",
    )!;
    expect(pointInLandmarkFootprint(pose.x, pose.z, workshop)).toBe(false);
    expect(pose.z).toBeGreaterThanOrEqual(courtyardStandZ(workshop));
  });

  it("builds an opaque, pickable pawn tagged with the character id", () => {
    const character = ksnAtShed();
    const avatar = createCharacterAvatar(character);
    expect(avatar.group.userData.characterId).toBe(character.id);
    expect(avatar.group.scale.x).toBeGreaterThan(1);
    expect(avatar.hit.userData.characterId).toBe(character.id);
    const hitMaterial = avatar.hit.material as THREE.MeshBasicMaterial;
    expect(hitMaterial.visible).toBe(true);
    expect(avatar.hit.visible).toBe(true);
    const body = avatar.group.children.find(
      (child) =>
        child instanceof THREE.Mesh &&
        child.geometry instanceof THREE.BoxGeometry &&
        (child.geometry as THREE.BoxGeometry).parameters.height === 16,
    ) as THREE.Mesh;
    const bodyMaterial = body.material as THREE.MeshLambertMaterial;
    expect(bodyMaterial.transparent).toBe(false);
    expect(bodyMaterial.opacity).toBe(1);
    expect(bodyMaterial.visible).toBe(true);
  });

  it("keeps the hit material raycastable (not material.visible = false)", () => {
    const material = createCharacterHitMaterial();
    expect(material.visible).toBe(true);
    expect(material.opacity).toBe(0);
  });

  it("is the first opaque hit from the overview camera at the Tinker Shed", () => {
    const scene = new THREE.Scene();
    createLandmarks(scene);
    const character = ksnAtShed();
    const avatar = createCharacterAvatar(character);
    scene.add(avatar.group);
    scene.updateMatrixWorld(true);

    const pose = characterStandPose(character.x, character.y);
    const camera = new THREE.PerspectiveCamera(42, 1280 / 700, 8, 4000);
    const offset = cameraOffset(DEFAULT_DISTANCE);
    camera.position.set(pose.x + offset.x, offset.y, pose.z + offset.z);
    camera.lookAt(pose.x, 10, pose.z);
    camera.updateMatrixWorld(true);

    const chest = new THREE.Vector3(pose.x, pose.y + 20, pose.z);
    const ndc = chest.clone().project(camera);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const hits = raycaster.intersectObject(scene, true).filter((hit) => {
      const material = (hit.object as THREE.Mesh).material as
        THREE.Material | THREE.Material[] | undefined;
      const first = Array.isArray(material) ? material[0] : material;
      if (!first || first.visible === false) return false;
      if ("opacity" in first && first.opacity === 0) return false;
      return true;
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(isCharacterObject(hits[0]!.object, character.id)).toBe(true);
  });

  it("raycasts the invisible hit volume from a tap at default zoom", () => {
    const character = ksnAtShed();
    const avatar = createCharacterAvatar(character);
    avatar.group.updateMatrixWorld(true);
    const pose = characterStandPose(character.x, character.y);
    const camera = new THREE.PerspectiveCamera(42, 390 / 640, 8, 4000);
    const offset = cameraOffset(DEFAULT_DISTANCE);
    camera.position.set(pose.x + offset.x, offset.y, pose.z + offset.z);
    camera.lookAt(pose.x, 10, pose.z);
    camera.updateMatrixWorld(true);
    const ndc = new THREE.Vector3(pose.x, pose.y + 18, pose.z).project(camera);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const hits = raycaster.intersectObject(avatar.hit, false);
    expect(hits.length).toBeGreaterThan(0);
    expect(CHARACTER_HIT_RADIUS).toBeGreaterThanOrEqual(30);
  });
});

describe("default / reset living frame", () => {
  const aspects = [
    ["1280 desktop", 1280 / 720],
    ["390 phone", 390 / 700],
  ] as const;

  it("leaves the Tinker Shed pawn off-screen on a 390 plaza view", () => {
    const pose = characterStandPose(880, 520);
    const chest = { x: pose.x, y: pose.y + 20, z: pose.z };
    expect(
      sampleInFrame(
        chest,
        PLAZA_FOCUS.x,
        PLAZA_FOCUS.z,
        DEFAULT_DISTANCE,
        390 / 700,
      ),
    ).toBe(false);
  });

  it("frames the only living pawn fully on 1280 and 390 canvases", () => {
    const pose = characterStandPose(880, 520);
    const samples = pawnFrameSamples(880, 520);
    for (const [label, aspect] of aspects) {
      const frame = framePoints(samples, aspect);
      expect(frame.x, label).toBeCloseTo(pose.x, 0);
      expect(frame.z, label).toBeCloseTo(pose.z, 0);
      for (const sample of samples) {
        expect(
          sampleInFrame(sample, frame.x, frame.z, frame.distance, aspect),
          `${label} sample`,
        ).toBe(true);
      }
    }
  });

  it("keeps an empty world on the plaza overview", () => {
    const frame = framePoints([], 390 / 700);
    expect(frame.x).toBe(PLAZA_FOCUS.x);
    expect(frame.z).toBe(PLAZA_FOCUS.z);
    expect(frame.distance).toBe(DEFAULT_DISTANCE);
  });
});
