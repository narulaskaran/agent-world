import * as THREE from "three";
import { WORLD_HEIGHT, WORLD_WIDTH } from "@agent-world/shared";

/** Pitch from the ground plane. Civ-5 overview, not first-person. */
export const CAMERA_PITCH = (52 * Math.PI) / 180;

/** Camera sits south of the look target, slightly east, facing north-ish. */
export const CAMERA_YAW = (14 * Math.PI) / 180;

/** Closest view: about two or three characters fill half the frame. */
export const MIN_DISTANCE = 220;

/** Farthest view: plaza plus neighboring districts stay on screen. */
export const MAX_DISTANCE = 1080;

export const DEFAULT_DISTANCE = 640;

export const CAMERA_FOV = 42;
export const CAMERA_NEAR = 8;
export const CAMERA_FAR = 4000;

export const PLAZA_FOCUS = { x: 560, z: 348 };

/** NDC inset so a pawn is fully inside the canvas, not clipped at the edge. */
export const FRAME_MARGIN = 0.2;

export const DRAG_THRESHOLD_PX = 12;
export const TOUCH_DRAG_THRESHOLD_PX = 22;

export const PAN_BOUNDS = {
  minX: 80,
  maxX: WORLD_WIDTH - 80,
  minZ: 70,
  maxZ: WORLD_HEIGHT - 70,
};

export function cameraOffset(
  distance: number,
  pitch = CAMERA_PITCH,
  yaw = CAMERA_YAW,
): { x: number; y: number; z: number } {
  const elevation = Math.sin(pitch) * distance;
  const horizontal = Math.cos(pitch) * distance;
  return {
    x: Math.sin(yaw) * horizontal,
    y: elevation,
    z: Math.cos(yaw) * horizontal,
  };
}

export function applyZoomDelta(
  distance: number,
  deltaY: number,
  deltaMode = 0,
): number {
  const pixels =
    deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY;
  return distance * Math.exp(pixels * 0.00185);
}

export function applyPinchZoom(
  startDistance: number,
  startSpan: number,
  currentSpan: number,
): number {
  if (startSpan <= 0 || currentSpan <= 0) return startDistance;
  return startDistance * (startSpan / currentSpan);
}

export function rubberBand(
  value: number,
  min: number,
  max: number,
  slack = 0.18,
): number {
  if (min >= max) return min;
  const maxSlack = (max - min) * slack;
  if (value < min) {
    const overflow = min - value;
    return min - (maxSlack * overflow) / (maxSlack + overflow);
  }
  if (value > max) {
    const overflow = value - max;
    return max + (maxSlack * overflow) / (maxSlack + overflow);
  }
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function spring(
  current: number,
  target: number,
  dt: number,
  stiffness = 10,
): number {
  const t = 1 - Math.exp(-stiffness * Math.max(0, dt));
  return current + (target - current) * t;
}

export function isDragGesture(
  dx: number,
  dy: number,
  threshold = DRAG_THRESHOLD_PX,
): boolean {
  return dx * dx + dy * dy >= threshold * threshold;
}

/** Grab-the-map pan: content follows the pointer. */
export function panFromScreenDelta(
  dx: number,
  dy: number,
  distance: number,
  viewportHeight: number,
  yaw = CAMERA_YAW,
): { x: number; z: number } {
  const worldPerPixel = (distance * 1.12) / Math.max(1, viewportHeight);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: (-dx * cos + dy * sin) * worldPerPixel,
    z: (dx * sin + dy * cos) * worldPerPixel,
  };
}

export function pointerSpan(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function applyOverviewPose(
  camera: THREE.PerspectiveCamera,
  targetX: number,
  targetZ: number,
  distance: number,
) {
  const offset = cameraOffset(distance);
  camera.position.set(targetX + offset.x, offset.y, targetZ + offset.z);
  camera.up.set(0, 1, 0);
  camera.lookAt(targetX, 10, targetZ);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

export function sampleInFrame(
  sample: { x: number; y: number; z: number },
  targetX: number,
  targetZ: number,
  distance: number,
  aspect: number,
  margin = FRAME_MARGIN,
): boolean {
  const camera = new THREE.PerspectiveCamera(
    CAMERA_FOV,
    Math.max(0.25, aspect),
    CAMERA_NEAR,
    CAMERA_FAR,
  );
  applyOverviewPose(camera, targetX, targetZ, distance);
  const ndc = new THREE.Vector3(sample.x, sample.y, sample.z).project(camera);
  return (
    ndc.z > -1 &&
    ndc.z < 1 &&
    Math.abs(ndc.x) <= 1 - margin &&
    Math.abs(ndc.y) <= 1 - margin
  );
}

/** Keep fixed pitch/yaw; pan + zoom so every sample sits inside the canvas. */
export function framePoints(
  samples: Array<{ x: number; y: number; z: number }>,
  aspect: number,
): { x: number; z: number; distance: number } {
  if (!samples.length) {
    return {
      x: PLAZA_FOCUS.x,
      z: PLAZA_FOCUS.z,
      distance: DEFAULT_DISTANCE,
    };
  }
  const xs = samples.map((sample) => sample.x);
  const zs = samples.map((sample) => sample.z);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const z = (Math.min(...zs) + Math.max(...zs)) / 2;
  const fits = (distance: number) =>
    samples.every((sample) =>
      sampleInFrame(sample, x, z, distance, aspect, FRAME_MARGIN),
    );
  if (fits(DEFAULT_DISTANCE)) {
    return { x, z, distance: DEFAULT_DISTANCE };
  }
  if (!fits(MAX_DISTANCE)) {
    return { x, z, distance: MAX_DISTANCE };
  }
  let lo = DEFAULT_DISTANCE;
  let hi = MAX_DISTANCE;
  for (let step = 0; step < 16; step++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return { x, z, distance: hi };
}
