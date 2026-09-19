export const HEX_SIZE = 1.15;

export type TerrainKind = "plaza" | "park" | "path" | "grass";

export interface HexCell {
  q: number;
  r: number;
  x: number;
  z: number;
  kind: TerrainKind;
}

export function hexToWorld(
  q: number,
  r: number,
  size = HEX_SIZE,
): { x: number; z: number } {
  return {
    x: size * Math.sqrt(3) * (q + r / 2),
    z: size * 1.5 * r,
  };
}

export function hexDisk(radius: number): Array<{ q: number; r: number }> {
  const cells: Array<{ q: number; r: number }> = [];
  for (let q = -radius; q <= radius; q += 1) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r += 1) cells.push({ q, r });
  }
  return cells;
}

export function terrainKindAt(q: number, r: number): TerrainKind {
  const dist = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
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
