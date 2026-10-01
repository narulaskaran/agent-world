/** Pointy-top axial hex geometry shared by the app map and the site diorama. */

export interface Axial {
  q: number;
  r: number;
}

export function hexToWorld(
  q: number,
  r: number,
  size: number,
): { x: number; z: number } {
  return {
    x: size * Math.sqrt(3) * (q + r / 2),
    z: size * 1.5 * r,
  };
}

export function hexRound(q: number, r: number): Axial {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  // Adding zero turns -0 into 0 so cells compare and key cleanly.
  return { q: rq + 0, r: rr + 0 };
}

export function worldToHex(x: number, z: number, size: number): Axial {
  const q = ((Math.sqrt(3) / 3) * x - (1 / 3) * z) / size;
  const r = ((2 / 3) * z) / size;
  return hexRound(q, r);
}

export function hexDistance(a: Axial, b: Axial = { q: 0, r: 0 }): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

export function hexDisk(radius: number): Axial[] {
  const cells: Axial[] = [];
  for (let q = -radius; q <= radius; q += 1) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r += 1) cells.push({ q, r });
  }
  return cells;
}
