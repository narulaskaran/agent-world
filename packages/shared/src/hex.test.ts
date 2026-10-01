import { describe, expect, it } from "vitest";
import { hexDisk, hexDistance, hexToWorld, worldToHex } from "./hex.js";

describe("hex geometry", () => {
  it("round-trips every cell of a disk at any size", () => {
    for (const size of [1.15, 34]) {
      for (const cell of hexDisk(4)) {
        const { x, z } = hexToWorld(cell.q, cell.r, size);
        expect(worldToHex(x, z, size)).toEqual({ q: cell.q, r: cell.r });
      }
    }
  });

  it("builds unique disks with the expected size and radius", () => {
    const disk = hexDisk(2);
    expect(disk).toHaveLength(19);
    expect(new Set(disk.map((cell) => `${cell.q},${cell.r}`)).size).toBe(19);
    expect(Math.max(...disk.map((cell) => hexDistance(cell)))).toBe(2);
  });
});
