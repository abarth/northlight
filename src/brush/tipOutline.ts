import { getTip } from './patterns';
import { traceContours } from '../gpu/selection';
import type { TipShape } from './types';
import type { Point } from '../types';

const cache = new Map<TipShape, Point[][]>();

/**
 * Coarse outline of a tip's mark for the brush cursor, as closed loops in
 * unit space (the tip's [-1, 1] square). Like Photoshop's brush outline it
 * shows the basic silhouette of the mark, not every speckle: the alpha map
 * is max-pooled to a small grid, closed morphologically so speckle fields
 * merge into blobs, holes are filled, tiny islands dropped, and the traced
 * contours smoothed. Cached per tip.
 */
export function tipOutline(shape: TipShape): Point[][] {
  const cached = cache.get(shape);
  if (cached) return cached;

  let loops: Point[][] = [];
  try {
    const map = getTip(shape);
    const n = Math.min(map.size, 48);
    // max-pool downsample (keeps thin strokes), binarized at a low threshold
    // so faint speckles still count toward the silhouette
    let mask = new Uint8Array(n * n);
    const step = map.size / n;
    for (let y = 0; y < n; y++) {
      const y0 = Math.floor(y * step);
      const y1 = Math.max(y0 + 1, Math.min(map.size, Math.ceil((y + 1) * step)));
      for (let x = 0; x < n; x++) {
        const x0 = Math.floor(x * step);
        const x1 = Math.max(x0 + 1, Math.min(map.size, Math.ceil((x + 1) * step)));
        let m = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const v = map.data[yy * map.size + xx];
            if (v > m) m = v;
          }
        }
        mask[y * n + x] = m > 64 ? 255 : 0;
      }
    }
    mask = close3x3(mask, n);
    fillHoles(mask, n);

    const minSpan = n * 0.12;
    loops = traceContours(mask, n, n)
      .filter((loop) => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of loop) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        return maxX - minX >= minSpan || maxY - minY >= minSpan;
      })
      .map((loop) =>
        chaikin(chaikin(loop)).map((p) => ({
          x: (p.x / n) * 2 - 1,
          y: (p.y / n) * 2 - 1,
        })),
      );
  } catch {
    // unknown tip id: fall back to the round cursor
  }
  cache.set(shape, loops);
  return loops;
}

/** Morphological closing (3x3 dilate then erode): bridges 1-cell gaps. */
function close3x3(mask: Uint8Array, n: number): Uint8Array<ArrayBuffer> {
  const pass = (src: Uint8Array, dilate: boolean) => {
    const dst = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let hit = !dilate;
        for (let dy = -1; dy <= 1 && (dilate ? !hit : hit); dy++) {
          for (let dx = -1; dx <= 1 && (dilate ? !hit : hit); dx++) {
            const yy = y + dy;
            const xx = x + dx;
            const v =
              yy >= 0 && yy < n && xx >= 0 && xx < n ? src[yy * n + xx] : 0;
            if (dilate) hit ||= v > 0;
            else hit &&= v > 0;
          }
        }
        dst[y * n + x] = hit ? 255 : 0;
      }
    }
    return dst;
  };
  return pass(pass(mask, true), false);
}

/** Fills enclosed holes so only outer silhouettes get traced. */
function fillHoles(mask: Uint8Array, n: number): void {
  // flood the empty region from the borders; unreached empty cells are holes
  const reach = new Uint8Array(n * n);
  const stack: number[] = [];
  const push = (i: number) => {
    if (mask[i] === 0 && reach[i] === 0) {
      reach[i] = 1;
      stack.push(i);
    }
  };
  for (let i = 0; i < n; i++) {
    push(i);
    push((n - 1) * n + i);
    push(i * n);
    push(i * n + n - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % n;
    const y = (i - x) / n;
    if (x > 0) push(i - 1);
    if (x < n - 1) push(i + 1);
    if (y > 0) push(i - n);
    if (y < n - 1) push(i + n);
  }
  for (let i = 0; i < n * n; i++) {
    if (mask[i] === 0 && reach[i] === 0) mask[i] = 255;
  }
}

/** One round of Chaikin corner cutting on a closed loop. */
function chaikin(loop: Point[]): Point[] {
  if (loop.length < 3) return loop;
  const out: Point[] = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % loop.length];
    out.push(
      { x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 },
      { x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 },
    );
  }
  return out;
}
