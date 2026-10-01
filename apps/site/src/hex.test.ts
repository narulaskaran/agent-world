import { describe, expect, it } from "vitest";
import {
  cellNoise,
  dioramaHexes,
  hexDisk,
  hexToWorld,
  prefersReducedMotion,
  terrainKindAt,
} from "./hex.js";

describe("hex layout", () => {
  it("places pointy-top hexes on a unique axial disk", () => {
    const origin = hexToWorld(0, 0);
    const east = hexToWorld(1, 0);
    expect(origin).toEqual({ x: 0, z: 0 });
    expect(east.x).toBeGreaterThan(0);
    expect(hexDisk(2)).toHaveLength(19);
    const cells = dioramaHexes(3);
    const keys = new Set(cells.map((cell) => `${cell.q},${cell.r}`));
    expect(keys.size).toBe(cells.length);
    expect(terrainKindAt(0, 0)).toBe("plaza");
  });

  it("keeps the pond off the plaza ring and decor noise stable", () => {
    const ponds = dioramaHexes(4).filter((cell) => cell.kind === "pond");
    expect(ponds.length).toBeGreaterThan(0);
    expect(terrainKindAt(1, 0)).toBe("path");
    expect(cellNoise(2, -1, 3)).toBe(cellNoise(2, -1, 3));
    expect(cellNoise(2, -1, 3)).toBeGreaterThanOrEqual(0);
    expect(cellNoise(2, -1, 3)).toBeLessThan(1);
  });

  it("treats reduced-motion media as a static preference", () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
    expect(prefersReducedMotion(null)).toBe(false);
  });
});
