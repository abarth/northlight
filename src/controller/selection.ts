import {
  combineMasks,
  invertMask,
  maskBounds,
  maskIsEmpty,
  rasterizeSelection,
  traceContours,
  type SelectionOp,
} from '../gpu/selection';
import type { Rect } from '../transform/quad';
import { DOC_SIZE, useStore } from '../store';
import type { Point } from '../types';
import { getEngine } from './engineHost';
import { commitTransform } from './transform';

/**
 * Selection state: the coverage mask is the source of truth; the ant outline
 * is re-traced from it so boolean ops, inversion, and transforms all stay
 * exact.
 */

let selectionMask: Uint8Array<ArrayBuffer> | null = null;
let lastSelectionMask: Uint8Array<ArrayBuffer> | null = null; // for Reselect

export function getSelectionMask(): Uint8Array<ArrayBuffer> | null {
  return selectionMask;
}

/** Replaces the mask outright and re-traces the outline. */
export function commitSelectionMask(mask: Uint8Array<ArrayBuffer> | null): void {
  const s = useStore.getState();
  if (mask && maskIsEmpty(mask)) mask = null;
  if (selectionMask && !mask) lastSelectionMask = selectionMask;
  selectionMask = mask;
  if (!mask) {
    s.setSelectionPaths(null);
    getEngine()?.setSelectionMask(null);
    return;
  }
  s.setSelectionPaths(traceContours(mask, DOC_SIZE.width, DOC_SIZE.height));
  getEngine()?.setSelectionMask(mask);
}

/** Drops all selection state without touching the engine (document reset). */
export function resetSelectionState(): void {
  selectionMask = null;
  lastSelectionMask = null;
  useStore.getState().setSelectionPaths(null);
}

export function setSelection(paths: Point[][] | null): void {
  commitTransform(); // changing the selection ends any open float
  if (!paths || paths.every((p) => p.length < 3)) {
    commitSelectionMask(null);
    return;
  }
  commitSelectionMask(rasterizeSelection(paths, DOC_SIZE.width, DOC_SIZE.height));
}

/** Combines a marquee/lasso shape into the selection (Shift/Alt modifiers). */
export function applySelectionShape(paths: Point[][], op: SelectionOp): void {
  if (paths.every((p) => p.length < 3)) return;
  commitTransform();
  const shape = rasterizeSelection(paths, DOC_SIZE.width, DOC_SIZE.height);
  commitSelectionMask(combineMasks(selectionMask, shape, op));
}

export function invertSelection(): void {
  commitTransform();
  if (!selectionMask) return;
  commitSelectionMask(invertMask(selectionMask));
}

export function reselect(): void {
  commitTransform();
  if (selectionMask || !lastSelectionMask) return;
  commitSelectionMask(lastSelectionMask);
}

export function selectionBounds(): Rect | null {
  return selectionMask
    ? maskBounds(selectionMask, DOC_SIZE.width, DOC_SIZE.height)
    : null;
}

export function selectAll(): void {
  const { width, height } = DOC_SIZE;
  setSelection([
    [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
  ]);
}

/**
 * Copies a `b`-sized window of premultiplied `src` pixels with the mask's
 * coverage applied — since the pixels are premultiplied, scaling all four
 * channels applies the mask. Shared by Copy and Layer Via Copy.
 */
export function maskedPixels(
  src: Uint8Array,
  mask: Uint8Array,
  docWidth: number,
  b: Rect,
): Uint8Array {
  const out = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const m = mask[(b.y + y) * docWidth + (b.x + x)];
      if (m === 0) continue;
      const si = ((b.y + y) * docWidth + (b.x + x)) * 4;
      const di = (y * b.w + x) * 4;
      out[di] = (src[si] * m + 127) / 255;
      out[di + 1] = (src[si + 1] * m + 127) / 255;
      out[di + 2] = (src[si + 2] * m + 127) / 255;
      out[di + 3] = (src[si + 3] * m + 127) / 255;
    }
  }
  return out;
}
