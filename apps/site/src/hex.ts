import {
  hexToWorld as axialToWorld,
  hexDisk,
  hexDistance,
} from "@agent-world/shared/hex";

export { hexDisk };

export const HEX_SIZE = 1.15;

export type TerrainKind = "plaza" | "park" | "path" | "grass" | "pond";

export interface HexCell {
  q: number;
  r: number;
  x: number;
  z: number;
  kind: TerrainKind;
}

export const hexToWorld = (q: number, r: number, size = HEX_SIZE) =>
  axialToWorld(q, r, size);

const POND_CENTER = { q: -3, r: 2 };

export function terrainKindAt(q: number, r: number): TerrainKind {
  const dist = hexDistance({ q, r });
  if (dist === 0) return "plaza";
  if (dist === 1) return "path";
  if (hexDistance({ q, r }, POND_CENTER) <= 1) return "pond";
  if (q + r > 2) return "park";
  return "grass";
}

export function dioramaHexes(radius = 4): HexCell[] {
  return hexDisk(radius).map(({ q, r }) => {
    const { x, z } = hexToWorld(q, r);
    return { q, r, x, z, kind: terrainKindAt(q, r) };
  });
}

export const TERRAIN_COLORS: Record<TerrainKind, number> = {
  plaza: 0xf0dfa8,
  park: 0x8fc46f,
  path: 0xd9d0b4,
  grass: 0x86bb6b,
  pond: 0x5fc0d8,
};

export const TILE_THICKNESS: Record<TerrainKind, number> = {
  plaza: 0.42,
  park: 0.28,
  path: 0.32,
  grass: 0.3,
  pond: 0.18,
};

/** Stable 0..1 value per cell so tile tint and decor never change between loads. */
export function cellNoise(q: number, r: number, salt = 0): number {
  const n = Math.sin(q * 127.1 + r * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

export function prefersReducedMotion(
  query: { matches: boolean } | null = globalThis.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ) ?? null,
): boolean {
  return Boolean(query?.matches);
}
