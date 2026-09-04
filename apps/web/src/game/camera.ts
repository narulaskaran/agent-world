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

export const PLAZA_FOCUS = { x: 560, z: 348 };

export const DRAG_THRESHOLD_PX = 7;

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

export function applyZoomDelta(distance: number, deltaY: number): number {
  return distance * Math.exp(deltaY * 0.00115);
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
