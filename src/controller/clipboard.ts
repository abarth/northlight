import { maskBounds } from '../gpu/selection';
import { layerById, nextName, pixelLayers } from '../layers';
import { DOC_SIZE, nextLayerId, useStore } from '../store';
import { makeLayerMeta } from '../types';
import { MAX_LAYERS, buildRenderState, getEngine } from './engineHost';
import { deleteSelectionContents } from './layerOps';
import { getSelectionMask, maskedPixels, setSelection } from './selection';
import { commitTransform } from './transform';

/**
 * Internal clipboard (Edit > Cut / Copy / Copy Merged / Paste).
 */

interface ClipboardContent {
  /** premultiplied RGBA, width*height*4 */
  data: Uint8Array;
  width: number;
  height: number;
  /** document position the pixels were copied from (for Paste in Place) */
  x: number;
  y: number;
}

let clipboard: ClipboardContent | null = null;

/**
 * Copies the selected pixels — from the active layer, or from the flattened
 * composite with `merged` — clipped by the selection mask's coverage.
 * Like Photoshop, Copy needs a selection.
 */
export async function copySelection(merged = false): Promise<boolean> {
  const engine = getEngine();
  const mask = getSelectionMask();
  if (!engine || !mask) return false;
  commitTransform();
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!merged && active?.kind !== 'layer') return false;
  const b = maskBounds(mask, DOC_SIZE.width, DOC_SIZE.height);
  if (!b) return false;
  const src = merged
    ? await engine.readComposite(buildRenderState())
    : await engine.readLayerPixels(s.activeLayerId);
  if (src.length < DOC_SIZE.width * DOC_SIZE.height * 4) return false;
  const out = maskedPixels(src, mask, DOC_SIZE.width, b);
  clipboard = { data: out, width: b.w, height: b.h, x: b.x, y: b.y };
  s.setHasClipboard(true);
  return true;
}

export async function cutSelection(): Promise<void> {
  if (await copySelection(false)) deleteSelectionContents();
}

/**
 * Pastes the clipboard as a new layer — centered on the canvas, or at the
 * position it was copied from with `inPlace` — and drops the selection,
 * like Photoshop.
 */
export function paste(inPlace = false): void {
  const engine = getEngine();
  if (!engine || !clipboard) return;
  const s = useStore.getState();
  if (pixelLayers(s.layers).length >= MAX_LAYERS) return;
  commitTransform();
  setSelection(null);
  const { width: dw, height: dh } = DOC_SIZE;
  const c = clipboard;
  const ox = inPlace ? c.x : Math.round((dw - c.width) / 2);
  const oy = inPlace ? c.y : Math.round((dh - c.height) / 2);
  const buf = new Uint8Array(dw * dh * 4);
  const x0 = Math.max(0, ox);
  const x1 = Math.min(dw, ox + c.width);
  const y0 = Math.max(0, oy);
  const y1 = Math.min(dh, oy + c.height);
  for (let y = y0; y < y1; y++) {
    const srcOff = ((y - oy) * c.width + (x0 - ox)) * 4;
    buf.set(c.data.subarray(srcOff, srcOff + (x1 - x0) * 4), (y * dw + x0) * 4);
  }
  const id = nextLayerId();
  engine.putLayerImage(id, buf, dw, dh);
  s.addLayerMeta(
    makeLayerMeta({ id, name: nextName(s.layers, 'Layer') }),
    s.activeLayerId,
  );
}
