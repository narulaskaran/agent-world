import { describe, expect, it } from "vitest";
import { WORLD_HEIGHT, WORLD_WIDTH } from "@agent-world/shared";
import {
  CAMERA_PITCH,
  DEFAULT_DISTANCE,
  DRAG_THRESHOLD_PX,
  MAX_DISTANCE,
  MIN_DISTANCE,
  PLAZA_FOCUS,
  applyPinchZoom,
  applyZoomDelta,
  cameraOffset,
  isDragGesture,
  panFromScreenDelta,
  pointerSpan,
  rubberBand,
  spring,
} from "./camera";
import { hexToWorld, hexesCoveringWorld, worldToHex } from "./hex";

describe("civ camera", () => {
  it("keeps a tilted overview pitch and north-ish offset", () => {
    const degrees = (CAMERA_PITCH * 180) / Math.PI;
    expect(degrees).toBeGreaterThanOrEqual(45);
    expect(degrees).toBeLessThanOrEqual(55);
    const offset = cameraOffset(DEFAULT_DISTANCE);
    expect(offset.y).toBeGreaterThan(offset.z * 0.7);
    expect(offset.z).toBeGreaterThan(0);
    expect(Math.abs(offset.x)).toBeLessThan(offset.z);
  });

  it("zooms with wheel and pinch without flipping past a hard lock", () => {
    expect(applyZoomDelta(DEFAULT_DISTANCE, 400, 0)).toBeGreaterThan(
      DEFAULT_DISTANCE,
    );
    expect(applyZoomDelta(DEFAULT_DISTANCE, -400, 0)).toBeLessThan(
      DEFAULT_DISTANCE,
    );
    expect(applyZoomDelta(DEFAULT_DISTANCE, 10, 1)).toBeGreaterThan(
      applyZoomDelta(DEFAULT_DISTANCE, 10, 0),
    );
    const pinched = applyPinchZoom(DEFAULT_DISTANCE, 120, 240);
    expect(pinched).toBeCloseTo(DEFAULT_DISTANCE / 2, 5);
    expect(MIN_DISTANCE).toBeLessThan(MAX_DISTANCE);
    expect(DEFAULT_DISTANCE).toBeGreaterThan(MIN_DISTANCE);
    expect(DEFAULT_DISTANCE).toBeLessThan(MAX_DISTANCE);
  });

  it("rubber-bands past zoom limits instead of clamping shut", () => {
    const under = rubberBand(MIN_DISTANCE - 80, MIN_DISTANCE, MAX_DISTANCE);
    const over = rubberBand(MAX_DISTANCE + 120, MIN_DISTANCE, MAX_DISTANCE);
    expect(under).toBeLessThan(MIN_DISTANCE);
    expect(under).toBeGreaterThan(MIN_DISTANCE - 80);
    expect(over).toBeGreaterThan(MAX_DISTANCE);
    expect(over).toBeLessThan(MAX_DISTANCE + 120);
    expect(rubberBand(DEFAULT_DISTANCE, MIN_DISTANCE, MAX_DISTANCE)).toBe(
      DEFAULT_DISTANCE,
    );
  });

  it("treats small pointer movement as a tap, not a pan", () => {
    expect(isDragGesture(2, 2)).toBe(false);
    expect(isDragGesture(DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(isDragGesture(0, DRAG_THRESHOLD_PX + 1)).toBe(true);
  });

  it("pans the board with the pointer instead of orbiting pitch", () => {
    const right = panFromScreenDelta(40, 0, DEFAULT_DISTANCE, 640);
    const down = panFromScreenDelta(0, 40, DEFAULT_DISTANCE, 640);
    expect(right.x).toBeLessThan(0);
    expect(Math.abs(right.z)).toBeLessThan(Math.abs(right.x));
    expect(down.z).toBeGreaterThan(0);
    expect(pointerSpan({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("springs the camera back toward the framed plaza", () => {
    const next = spring(800, DEFAULT_DISTANCE, 1 / 30);
    expect(next).toBeLessThan(800);
    expect(next).toBeGreaterThan(DEFAULT_DISTANCE);
    expect(PLAZA_FOCUS.x).toBeGreaterThan(WORLD_WIDTH * 0.4);
    expect(PLAZA_FOCUS.z).toBeGreaterThan(WORLD_HEIGHT * 0.3);
  });
});

describe("hex board", () => {
  it("round-trips axial coordinates near the plaza", () => {
    const { x, z } = hexToWorld(10, 7);
    const hex = worldToHex(x, z);
    expect(hex).toEqual({ q: 10, r: 7 });
  });

  it("covers plaza and neighboring districts", () => {
    const hexes = hexesCoveringWorld();
    const kinds = new Set(hexes.map((cell) => cell.kind));
    expect(hexes.length).toBeGreaterThan(200);
    expect(kinds.has("plaza")).toBe(true);
    expect(kinds.has("cafe")).toBe(true);
    expect(kinds.has("library")).toBe(true);
    expect(kinds.has("park")).toBe(true);
    expect(kinds.has("workshop")).toBe(true);
  });
});
