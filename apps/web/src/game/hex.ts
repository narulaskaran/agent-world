import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  locationAtPoint,
  type WorldLocationId,
} from "@agent-world/shared";
import { clamp } from "./camera";

/** Pointy-top hex radius (center to vertex). */
export const HEX_SIZE = 34;

export type TerrainKind = WorldLocationId | "path" | "grass";

export interface HexCell {
  q: number;
  r: number;
  x: number;
  z: number;
  kind: TerrainKind;
}

export function hexToWorld(q: number, r: number): { x: number; z: number } {
  return {
    x: HEX_SIZE * Math.sqrt(3) * (q + r / 2),
    z: HEX_SIZE * 1.5 * r,
  };
}

function hexRound(q: number, r: number): { q: number; r: number } {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

export function worldToHex(x: number, z: number): { q: number; r: number } {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * z) / HEX_SIZE;
  const r = ((2 / 3) * z) / HEX_SIZE;
  return hexRound(q, r);
}

const PATH_SEGMENTS: Array<
  [{ x: number; z: number }, { x: number; z: number }]
> = [
  [
    { x: 195, z: 165 },
    { x: 560, z: 350 },
  ],
  [
    { x: 910, z: 180 },
    { x: 560, z: 350 },
  ],
  [
    { x: 220, z: 545 },
    { x: 560, z: 350 },
  ],
  [
    { x: 880, z: 545 },
    { x: 560, z: 350 },
  ],
];

function distToSegment(
  x: number,
  z: number,
  a: { x: number; z: number },
  b: { x: number; z: number },
): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz || 1;
  const t = clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1);
  return Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
}

export function terrainKindAt(x: number, z: number): TerrainKind {
  const location = locationAtPoint(x, z);
  if (location) return location.id;
  if (PATH_SEGMENTS.some((seg) => distToSegment(x, z, seg[0], seg[1]) < 34)) {
    return "path";
  }
  return "grass";
}

export const TERRAIN_COLORS: Record<TerrainKind, number> = {
  plaza: 0xe6d6a4,
  cafe: 0xc9a07c,
  park: 0x7dae68,
  library: 0x9a97b8,
  workshop: 0xb48c6a,
  path: 0xcdc6ae,
  grass: 0x7eab67,
};

export const TILE_THICKNESS: Record<TerrainKind, number> = {
  plaza: 12,
  cafe: 10,
  park: 8,
  library: 10,
  workshop: 10,
  path: 9,
  grass: 9,
};

export const TILE_TOP = TILE_THICKNESS.plaza;

export function hexesCoveringWorld(): HexCell[] {
  const hexes: HexCell[] = [];
  const rStart = -2;
  const rEnd = Math.ceil(WORLD_HEIGHT / (HEX_SIZE * 1.5)) + 2;
  for (let r = rStart; r <= rEnd; r++) {
    const qStart = Math.floor(-r / 2) - 2;
    const qEnd = Math.ceil(WORLD_WIDTH / (HEX_SIZE * Math.sqrt(3)) - r / 2) + 2;
    for (let q = qStart; q <= qEnd; q++) {
      const { x, z } = hexToWorld(q, r);
      if (
        x < -HEX_SIZE ||
        z < -HEX_SIZE ||
        x > WORLD_WIDTH + HEX_SIZE ||
        z > WORLD_HEIGHT + HEX_SIZE
      ) {
        continue;
      }
      hexes.push({ q, r, x, z, kind: terrainKindAt(x, z) });
    }
  }
  return hexes;
}
