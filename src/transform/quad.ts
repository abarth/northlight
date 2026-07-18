import type { Point } from '../types';

/** Axis-aligned rectangle in document pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Corners of a rect in quad order: TL, TR, BR, BL. */
export const rectCorners = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

export function quadCenter(q: Point[]): Point {
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
}

/** Whether a quad still sits exactly on its reference rectangle. */
export function quadMatchesRect(quad: Point[], rect: Rect): boolean {
  const rc = rectCorners(rect);
  return quad.every(
    (p, i) => Math.abs(p.x - rc[i].x) < 1e-3 && Math.abs(p.y - rc[i].y) < 1e-3,
  );
}

/** Shift-drag: snap movement to horizontal / vertical / 45° diagonals. */
export function constrain45(dx: number, dy: number): [number, number] {
  if (Math.abs(dx) > 2 * Math.abs(dy)) return [dx, 0];
  if (Math.abs(dy) > 2 * Math.abs(dx)) return [0, dy];
  const d = (Math.abs(dx) + Math.abs(dy)) / 2;
  return [Math.sign(dx) * d, Math.sign(dy) * d];
}

export function pointInQuad(p: Point, q: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i];
    const b = q[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Minimum distance from `p` to the quad's outline (its four segments). */
export function distToQuadEdges(q: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t =
      len2 > 0
        ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2))
        : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)));
  }
  return best;
}

/** Bounding box of a set of paths, or null when there are no points. */
export function pathsBounds(paths: Point[][]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const p of path) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
