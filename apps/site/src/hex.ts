import {
  hexToWorld as axialToWorld,
  hexDisk,
  hexDistance,
} from "@agent-world/shared/hex";

export { hexDisk };

export const HEX_SIZE = 1.15;

export type TerrainKind = "plaza" | "park" | "path" | "grass";

export interface HexCell {
  q: number;
  r: number;
  x: number;
  z: number;
  kind: TerrainKind;
}

export const hexToWorld = (q: number, r: number, size = HEX_SIZE) =>
  axialToWorld(q, r, size);

export function terrainKindAt(q: number, r: number): TerrainKind {
  const dist = hexDistance({ q, r });
  if (dist === 0) return "plaza";
  if (dist === 1) return "path";
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
  plaza: 0xe6d6a4,
  park: 0x7dae68,
  path: 0xcdc6ae,
  grass: 0x7eab67,
};

export const TILE_THICKNESS: Record<TerrainKind, number> = {
  plaza: 0.42,
  park: 0.28,
  path: 0.32,
  grass: 0.3,
};

export function prefersReducedMotion(
  query: { matches: boolean } | null = globalThis.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ) ?? null,
): boolean {
  return Boolean(query?.matches);
}
