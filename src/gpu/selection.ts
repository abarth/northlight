import { apply, type Mat3 } from '../transform/matrix';
import type { Point } from '../types';

export type SelectionOp = 'new' | 'add' | 'subtract' | 'intersect';

/**
 * Rasterizes selection polygons into a single-channel coverage mask using an
 * offscreen 2D canvas (which also gives us anti-aliased edges for free).
 */
export function rasterizeSelection(
  paths: Point[][],
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (const path of paths) {
    if (path.length < 3) continue;
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.closePath();
  }
  ctx.fill();
  const img = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = img[i * 4 + 3];
  return mask;
}

/** Combines two coverage masks with a Photoshop-style boolean op. */
export function combineMasks(
  base: Uint8Array<ArrayBuffer> | null,
  next: Uint8Array<ArrayBuffer>,
  op: SelectionOp,
): Uint8Array<ArrayBuffer> {
  if (!base || op === 'new') return next;
  const out = new Uint8Array(base.length);
  switch (op) {
    case 'add':
      for (let i = 0; i < out.length; i++) out[i] = Math.max(base[i], next[i]);
      break;
    case 'subtract':
      for (let i = 0; i < out.length; i++)
        out[i] = Math.max(0, base[i] - next[i]);
      break;
    case 'intersect':
      for (let i = 0; i < out.length; i++) out[i] = Math.min(base[i], next[i]);
      break;
  }
  return out;
}

export function invertMask(mask: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - mask[i];
  return out;
}

export function maskIsEmpty(mask: Uint8Array<ArrayBuffer>): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) return false;
  return true;
}

/** Bounding box of covered pixels, or null when empty. */
export function maskBounds(
  mask: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Resamples the mask through a homography mapping destination -> source. */
export function transformMask(
  mask: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  hInv: Mat3,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = apply(hInv, { x: x + 0.5, y: y + 0.5 });
      const sx = Math.floor(p.x);
      const sy = Math.floor(p.y);
      if (sx >= 0 && sy >= 0 && sx < width && sy < height) {
        out[y * width + x] = mask[sy * width + sx];
      }
    }
  }
  return out;
}

/** Shifts the mask by an integer offset (pixels leaving the canvas drop). */
export function translateMask(
  mask: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < width) out[y * width + x] = mask[sy * width + sx];
    }
  }
  return out;
}

/**
 * Traces the boundary of a coverage mask into closed polygon loops for the
 * marching-ants overlay. Walks pixel edges (threshold 127) with the filled
 * region kept on the left, then collapses collinear runs. Handles multiple
 * islands and holes; exact for any mask a boolean op can produce.
 */
export function traceContours(
  mask: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): Point[][] {
  const filled = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] > 127;

  // Directed boundary edges on the (width+1) x (height+1) vertex grid,
  // keyed by start vertex. dir: 0=right 1=down 2=left 3=up.
  const W1 = width + 1;
  const edges = new Map<number, number[]>(); // startVertex -> list of dirs
  const addEdge = (vx: number, vy: number, dir: number) => {
    const key = vy * W1 + vx;
    const list = edges.get(key);
    if (list) list.push(dir);
    else edges.set(key, [dir]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) addEdge(x, y, 0); // top edge, walk right
      if (!filled(x + 1, y)) addEdge(x + 1, y, 1); // right edge, walk down
      if (!filled(x, y + 1)) addEdge(x + 1, y + 1, 2); // bottom, walk left
      if (!filled(x - 1, y)) addEdge(x, y + 1, 3); // left, walk up
    }
  }

  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const loops: Point[][] = [];

  for (const [startKey] of edges) {
    let key = startKey;
    let dirs = edges.get(key);
    if (!dirs || dirs.length === 0) continue;
    const pts: Point[] = [];
    let prevDir = -1;
    // Walk until we return to the starting vertex.
    for (let guard = 0; guard < width * height * 4 + 8; guard++) {
      dirs = edges.get(key);
      if (!dirs || dirs.length === 0) break;
      // Prefer the tightest left turn to keep holes separate at touch points.
      let dir = dirs[0];
      if (dirs.length > 1 && prevDir >= 0) {
        let best = 5;
        for (const d of dirs) {
          const turn = (d - prevDir + 4) % 4 === 3 ? 0 : (d - prevDir + 4) % 4 + 1;
          if (turn < best) {
            best = turn;
            dir = d;
          }
        }
      }
      dirs.splice(dirs.indexOf(dir), 1);
      if (dirs.length === 0) edges.delete(key);
      const vx = key % W1;
      const vy = (key - vx) / W1;
      if (dir !== prevDir) pts.push({ x: vx, y: vy }); // drop collinear points
      prevDir = dir;
      key = (vy + DY[dir]) * W1 + (vx + DX[dir]);
      if (key === startKey) break;
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}
