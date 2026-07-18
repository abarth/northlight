import * as color from '../color/convert';
import { translation, type Mat3 } from '../transform/matrix';
import { DOC_SIZE, useStore } from '../store';
import { makeLayerMeta } from '../types';
import { getEngine } from './engineHost';
import { resetSelectionState, selectionBounds } from './selection';
import { bgFillFor, cancelTransform, commitTransform } from './transform';

/**
 * Document operations (File > New, Image > Image Size / Canvas Size /
 * Image Rotation / Crop).
 */

function setDocMeta(width: number, height: number, resolution: number): void {
  DOC_SIZE.width = width;
  DOC_SIZE.height = height;
  const s = useStore.getState();
  s.setDoc({ width, height, resolution });
  s.requestFit();
}

export function newDocument(
  width: number,
  height: number,
  resolution: number,
  background: 'white' | 'background' | 'transparent',
): void {
  const engine = getEngine();
  if (!engine) return;
  cancelTransform();
  resetSelectionState();
  const s = useStore.getState();
  for (const l of s.layers) engine.deleteLayer(l.id);
  engine.resizeDocument(width, height, null);
  engine.ensureLayer('background');
  if (background === 'white') {
    engine.fillLayer('background', [1, 1, 1, 1]);
  } else if (background === 'background') {
    const c = color.hsvToRgb(s.bg);
    engine.fillLayer('background', [c.r, c.g, c.b, 1]);
  }
  s.setLayers([makeLayerMeta({ id: 'background', name: 'Background' })], 'background');
  setDocMeta(width, height, resolution);
}

/** Image > Image Size: resamples every layer to the new pixel dimensions. */
export function resizeImage(width: number, height: number, resolution: number): void {
  const engine = getEngine();
  if (!engine) return;
  commitTransform();
  const { width: ow, height: oh } = DOC_SIZE;
  if (width === ow && height === oh) {
    setDocMeta(width, height, resolution);
    return;
  }
  resetSelectionState();
  engine.resizeDocument(width, height, [ow / width, 0, 0, 0, oh / height, 0, 0, 0, 1]);
  setDocMeta(width, height, resolution);
}

/**
 * Image > Canvas Size: crops or extends around an anchor (0 | 0.5 | 1 per
 * axis). The Background layer's new area fills with the background color.
 */
export function resizeCanvas(
  width: number,
  height: number,
  anchorX: number,
  anchorY: number,
): void {
  const engine = getEngine();
  if (!engine) return;
  commitTransform();
  resetSelectionState();
  const s = useStore.getState();
  const offX = Math.round((width - DOC_SIZE.width) * anchorX);
  const offY = Math.round((height - DOC_SIZE.height) * anchorY);
  engine.resizeDocument(width, height, translation(-offX, -offY), bgFillFor);
  setDocMeta(width, height, s.doc.resolution);
}

export type CanvasRotation = 'rotate180' | 'rotate90cw' | 'rotate90ccw' | 'flipH' | 'flipV';

/** Image > Image Rotation: rotates/flips every layer and the canvas. */
export function rotateCanvas(op: CanvasRotation): void {
  const engine = getEngine();
  if (!engine) return;
  commitTransform();
  resetSelectionState();
  const s = useStore.getState();
  const { width: w, height: h } = DOC_SIZE;
  let newW = w;
  let newH = h;
  let hInv: Mat3;
  switch (op) {
    case 'rotate180':
      hInv = [-1, 0, w, 0, -1, h, 0, 0, 1];
      break;
    case 'rotate90cw':
      newW = h;
      newH = w;
      hInv = [0, 1, 0, -1, 0, h, 0, 0, 1];
      break;
    case 'rotate90ccw':
      newW = h;
      newH = w;
      hInv = [0, -1, w, 1, 0, 0, 0, 0, 1];
      break;
    case 'flipH':
      hInv = [-1, 0, w, 0, 1, 0, 0, 0, 1];
      break;
    case 'flipV':
      hInv = [1, 0, 0, 0, -1, h, 0, 0, 1];
      break;
  }
  engine.resizeDocument(newW, newH, hInv);
  setDocMeta(newW, newH, s.doc.resolution);
}

/** Image > Crop: crops the canvas to the selection's bounding box. */
export function cropToSelection(): void {
  const engine = getEngine();
  const b = selectionBounds();
  if (!b || !engine) return;
  commitTransform();
  resetSelectionState();
  const s = useStore.getState();
  engine.resizeDocument(b.w, b.h, translation(b.x, b.y));
  setDocMeta(b.w, b.h, s.doc.resolution);
}
