import { PaintEngine, type RenderState } from './gpu/engine';
import * as shaders from './gpu/shaders';
import * as color from './color/convert';
import * as brushDefaults from './brush/defaults';
import * as brushDynamics from './brush/dynamics';
import * as brushPatterns from './brush/patterns';
import * as brushPresets from './brush/presets';
import * as brushAbr from './brush/abr';
import { engineStrokeParams } from './brush/engineParams';
import { StrokeSession } from './gpu/stroke';
import {
  combineMasks,
  invertMask,
  maskBounds,
  maskIsEmpty,
  rasterizeSelection,
  traceContours,
  transformMask,
  type SelectionOp,
} from './gpu/selection';
import {
  apply,
  homographyFromQuads,
  rotationAbout,
  scaleAbout,
  translation,
  type Mat3,
} from './transform/matrix';
import { DOC_SIZE, nextLayerId, useStore, type TransformMode } from './store';
import type { LayerMeta, Point } from './types';

/**
 * Bridges UI actions that need both the zustand store (metadata) and the
 * PaintEngine (GPU textures).
 */

let engine: PaintEngine | null = null;

// Handy for debugging from the console / test drivers.
declare global {
  interface Window {
    __northlight?: {
      store: typeof useStore;
      engine: () => PaintEngine | null;
      shaders: typeof shaders;
      color: typeof color;
      PaintEngine: typeof PaintEngine;
      StrokeSession: typeof StrokeSession;
      rasterizeSelection: typeof rasterizeSelection;
      brush: {
        defaults: typeof brushDefaults;
        dynamics: typeof brushDynamics;
        patterns: typeof brushPatterns;
        presets: typeof brushPresets;
        abr: typeof brushAbr;
        engineStrokeParams: typeof engineStrokeParams;
        importAbr: typeof importAbr;
      };
    };
  }
}
window.__northlight = {
  store: useStore,
  engine: () => engine,
  shaders,
  color,
  PaintEngine,
  StrokeSession,
  rasterizeSelection,
  brush: {
    defaults: brushDefaults,
    dynamics: brushDynamics,
    patterns: brushPatterns,
    presets: brushPresets,
    abr: brushAbr,
    engineStrokeParams,
    importAbr,
  },
};

export function setEngine(e: PaintEngine | null): void {
  engine = e;
  if (e) {
    e.onHistoryChange = (u, r) => useStore.getState().setHistory(u, r);
    for (const layer of useStore.getState().layers) e.ensureLayer(layer.id);
    e.fillLayer('background', [1, 1, 1, 1]);
  }
}

export function getEngine(): PaintEngine | null {
  return engine;
}

export function buildRenderState(): RenderState {
  const s = useStore.getState();
  return { layers: s.layers, activeLayerId: s.activeLayerId, view: s.view };
}

export const MAX_LAYERS = 64; // matches the compositor's uniform buffer

export function addLayer(): void {
  if (!engine) return;
  const s = useStore.getState();
  if (s.layers.length >= MAX_LAYERS) return;
  const id = nextLayerId();
  engine.ensureLayer(id);
  s.addLayerMeta(
    {
      id,
      name: `Layer ${s.layers.length + 1}`,
      visible: true,
      opacity: 1,
      blendMode: 'normal',
    },
    s.activeLayerId,
  );
}

export function deleteLayer(id: string): void {
  const s = useStore.getState();
  if (s.transform?.layerId === id) cancelTransform();
  else commitTransform();
  if (s.layers.length <= 1) return;
  s.removeLayerMeta(id);
  engine?.deleteLayer(id);
}

// ---------------------------------------------------------------------------
// Selection: the coverage mask is the source of truth; the ant outline is
// re-traced from it so boolean ops, inversion, and transforms all stay exact.
// ---------------------------------------------------------------------------

let selectionMask: Uint8Array<ArrayBuffer> | null = null;
let lastSelectionMask: Uint8Array<ArrayBuffer> | null = null; // for Reselect

export function getSelectionMask(): Uint8Array<ArrayBuffer> | null {
  return selectionMask;
}

function commitSelectionMask(mask: Uint8Array<ArrayBuffer> | null): void {
  const s = useStore.getState();
  if (mask && maskIsEmpty(mask)) mask = null;
  if (selectionMask && !mask) lastSelectionMask = selectionMask;
  selectionMask = mask;
  if (!mask) {
    s.setSelectionPaths(null);
    engine?.setSelectionMask(null);
    return;
  }
  s.setSelectionPaths(traceContours(mask, DOC_SIZE.width, DOC_SIZE.height));
  engine?.setSelectionMask(mask);
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

export function selectionBounds(): { x: number; y: number; w: number; h: number } | null {
  return selectionMask
    ? maskBounds(selectionMask, DOC_SIZE.width, DOC_SIZE.height)
    : null;
}

/**
 * Fills the active layer with the foreground or background color, clipped to
 * the current selection when one exists (Alt+Backspace / Ctrl+Backspace).
 */
export function fillActiveLayer(which: 'fg' | 'bg'): void {
  commitTransform();
  const s = useStore.getState();
  const rgb = color.hsvToRgb(which === 'fg' ? s.fg : s.bg);
  engine?.fillRegion(s.activeLayerId, [rgb.r, rgb.g, rgb.b]);
}

/**
 * Deletes the selected pixels: clears them to transparency, except on the
 * Background layer where they fill with the background color instead.
 */
export function deleteSelectionContents(): void {
  commitTransform();
  const s = useStore.getState();
  if (!s.selectionPaths) return;
  if (s.activeLayerId === 'background') {
    const rgb = color.hsvToRgb(s.bg);
    engine?.fillRegion(s.activeLayerId, [rgb.r, rgb.g, rgb.b]);
  } else {
    engine?.fillRegion(s.activeLayerId, null);
  }
}

/**
 * Eyedropper sample at a document coordinate, honoring the Sample Size and
 * Sample scope options. Returns straight RGB, or null on transparent pixels.
 */
export async function sampleCanvasColor(x: number, y: number): Promise<color.RGB | null> {
  if (!engine) return null;
  const s = useStore.getState();
  const size = s.eyedropperSampleSize;
  let result;
  if (s.eyedropperSample === 'current') {
    result = await engine.sampleColor(x, y, size, { layerId: s.activeLayerId });
  } else {
    let layers = s.layers;
    if (s.eyedropperSample === 'currentBelow') {
      const idx = layers.findIndex((l) => l.id === s.activeLayerId);
      if (idx >= 0) layers = layers.slice(0, idx + 1);
    }
    result = await engine.sampleColor(x, y, size, {
      state: { layers, activeLayerId: s.activeLayerId, view: s.view },
    });
  }
  return result ? { r: result.r, g: result.g, b: result.b } : null;
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

// ---------------------------------------------------------------------------
// Transforms (Edit > Free Transform / Transform, Select > Transform Selection)
// ---------------------------------------------------------------------------

const rectCorners = (r: { x: number; y: number; w: number; h: number }): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

function bgFillFor(layerId: string): [number, number, number] | null {
  if (layerId !== 'background') return null;
  const c = color.hsvToRgb(useStore.getState().bg);
  return [c.r, c.g, c.b];
}

/** Bounding box of a layer's non-transparent pixels, or null when empty. */
async function layerContentBounds(
  layerId: string,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  if (!engine) return null;
  const data = await engine.readLayerPixels(layerId);
  const { width, height } = DOC_SIZE;
  if (data.length < width * height * 4) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
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

/**
 * Starts (or re-modes) an interactive transform. Layer targets snapshot the
 * pixels in the engine; the box starts on the selection bounds when a
 * selection exists, else on the layer's content bounds.
 */
export async function startTransform(
  target: 'layer' | 'selection',
  mode: TransformMode = 'free',
): Promise<boolean> {
  const s = useStore.getState();
  if (s.transform) {
    // e.g. Ctrl+T during a move float: engage it as a full transform
    s.patchTransform({ mode, showHandles: true, engaged: true });
    return true;
  }
  let rect = selectionBounds();
  if (target === 'selection') {
    if (!rect) return false;
  } else {
    if (!engine || engine.transformActive) return false;
    if (!rect) rect = await layerContentBounds(s.activeLayerId);
    if (!rect) rect = { x: 0, y: 0, w: DOC_SIZE.width, h: DOC_SIZE.height };
    if (!engine.beginTransform(s.activeLayerId)) return false;
  }
  rect.w = Math.max(rect.w, 1);
  rect.h = Math.max(rect.h, 1);
  useStore.getState().setTransform({
    target,
    mode,
    layerId: s.activeLayerId,
    rect,
    quad: rectCorners(rect),
    duplicate: false,
    showHandles: true,
    engaged: true,
  });
  return true;
}

/**
 * Opens a move-tool float: like a transform session, but synchronous (box on
 * the selection bounds, or the whole document) and initially un-engaged. The
 * float persists across drags and nudges — pixels bake down only when the
 * sequence ends (tool/layer switch, Enter, or another operation) — so the
 * selection's anti-aliased boundary is cut exactly once.
 */
export function startMoveSession(duplicate: boolean): boolean {
  const s = useStore.getState();
  if (s.transform) return true;
  if (!engine || engine.transformActive) return false;
  const rect = selectionBounds() ?? { x: 0, y: 0, w: DOC_SIZE.width, h: DOC_SIZE.height };
  if (!engine.beginTransform(s.activeLayerId)) return false;
  rect.w = Math.max(rect.w, 1);
  rect.h = Math.max(rect.h, 1);
  s.setTransform({
    target: 'layer',
    mode: 'free',
    layerId: s.activeLayerId,
    rect,
    quad: rectCorners(rect),
    duplicate,
    showHandles: s.moveShowTransform,
    engaged: false,
  });
  return true;
}

/** Arrow-key nudge for the move tool: opens/extends the float. */
export function nudgeMoveSession(dx: number, dy: number): void {
  const s = useStore.getState();
  if (!s.transform && !startMoveSession(false)) return;
  transformQuadBy(translation(dx, dy));
}

/**
 * Move-tool Auto-Select: activates the topmost visible layer with an opaque
 * pixel under the pointer, like Photoshop's Auto-Select: Layer.
 */
export async function autoSelectMoveTarget(x: number, y: number): Promise<void> {
  if (!engine) return;
  const s = useStore.getState();
  for (let i = s.layers.length - 1; i >= 0; i--) {
    const l = s.layers[i];
    if (!l.visible) continue;
    const c = await engine.sampleColor(x, y, 1, { layerId: l.id });
    if (c && c.a > 0.1) {
      if (l.id !== s.activeLayerId) s.setActiveLayer(l.id);
      return;
    }
  }
}

/** Re-renders the layer preview from the current quad. */
export function applyTransformPreview(): void {
  const t = useStore.getState().transform;
  if (!t || t.target !== 'layer' || !engine) return;
  const hInv = homographyFromQuads(t.quad, rectCorners(t.rect));
  if (!hInv) return;
  engine.previewTransform(hInv, {
    withSelection: !!selectionMask,
    duplicate: t.duplicate,
    bgFill: bgFillFor(t.layerId),
  });
}

function quadMatchesRect(
  quad: Point[],
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  const rc = rectCorners(rect);
  return quad.every(
    (p, i) => Math.abs(p.x - rc[i].x) < 1e-3 && Math.abs(p.y - rc[i].y) < 1e-3,
  );
}

export function commitTransform(): void {
  const s = useStore.getState();
  const t = s.transform;
  if (!t) return;
  // Clear first so nested selection/layer updates can't re-enter the commit.
  s.setTransform(null);
  const identity = quadMatchesRect(t.quad, t.rect);
  const hInv = homographyFromQuads(t.quad, rectCorners(t.rect));
  if (t.target === 'layer') {
    if (!identity && hInv && engine) {
      // one final resample of the pristine snapshot, then bake
      engine.previewTransform(hInv, {
        withSelection: !!selectionMask,
        duplicate: t.duplicate,
        bgFill: bgFillFor(t.layerId),
      });
      engine.endTransform(true);
    } else {
      // nothing changed: restore the snapshot bit-for-bit, no undo entry
      engine?.endTransform(false);
    }
  }
  if (!identity && hInv && selectionMask) {
    commitSelectionMask(
      transformMask(selectionMask, DOC_SIZE.width, DOC_SIZE.height, hInv),
    );
  }
}

export function cancelTransform(): void {
  const s = useStore.getState();
  const t = s.transform;
  if (!t) return;
  s.setTransform(null);
  if (t.target === 'layer') engine?.endTransform(false);
}

/** Applies a matrix to the current transform quad and refreshes the preview. */
export function transformQuadBy(m: Mat3): void {
  const s = useStore.getState();
  const t = s.transform;
  if (!t) return;
  s.patchTransform({ quad: t.quad.map((p) => apply(m, p)) });
  applyTransformPreview();
}

export type TransformImmediateOp =
  | 'rotate180'
  | 'rotate90cw'
  | 'rotate90ccw'
  | 'flipH'
  | 'flipV';

/**
 * Edit > Transform > Rotate/Flip. Inside an open transform session the op
 * composes into it; otherwise it applies to the layer immediately.
 */
export async function transformImmediate(op: TransformImmediateOp): Promise<void> {
  const s = useStore.getState();
  const hadSession = !!s.transform;
  if (!hadSession && !(await startTransform('layer', 'free'))) return;
  const t = useStore.getState().transform!;
  const cx = (t.quad[0].x + t.quad[2].x) / 2;
  const cy = (t.quad[0].y + t.quad[2].y) / 2;
  const m =
    op === 'rotate180'
      ? rotationAbout(Math.PI, cx, cy)
      : op === 'rotate90cw'
        ? rotationAbout(Math.PI / 2, cx, cy)
        : op === 'rotate90ccw'
          ? rotationAbout(-Math.PI / 2, cx, cy)
          : op === 'flipH'
            ? scaleAbout(-1, 1, cx, cy)
            : scaleAbout(1, -1, cx, cy);
  transformQuadBy(m);
  if (!hadSession) commitTransform();
}

// ---------------------------------------------------------------------------
// Document operations (File > New, Image > Image Size / Canvas Size / ...)
// ---------------------------------------------------------------------------

function setDocMeta(width: number, height: number, resolution: number): void {
  DOC_SIZE.width = width;
  DOC_SIZE.height = height;
  const s = useStore.getState();
  s.setDoc({ width, height, resolution });
  s.requestFit();
}

function resetSelectionState(): void {
  selectionMask = null;
  lastSelectionMask = null;
  useStore.getState().setSelectionPaths(null);
}

export function newDocument(
  width: number,
  height: number,
  resolution: number,
  background: 'white' | 'background' | 'transparent',
): void {
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
  s.setLayers(
    [{ id: 'background', name: 'Background', visible: true, opacity: 1, blendMode: 'normal' }],
    'background',
  );
  setDocMeta(width, height, resolution);
}

/** Image > Image Size: resamples every layer to the new pixel dimensions. */
export function resizeImage(width: number, height: number, resolution: number): void {
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
  const b = selectionBounds();
  if (!b || !engine) return;
  commitTransform();
  resetSelectionState();
  const s = useStore.getState();
  engine.resizeDocument(b.w, b.h, translation(b.x, b.y));
  setDocMeta(b.w, b.h, s.doc.resolution);
}

// ---------------------------------------------------------------------------
// Layer operations (Layer > Merge Down / Flatten Image)
// ---------------------------------------------------------------------------

export function mergeDown(): void {
  const s = useStore.getState();
  const idx = s.layers.findIndex((l) => l.id === s.activeLayerId);
  if (idx <= 0 || !engine) return;
  const top = s.layers[idx];
  const bottom = s.layers[idx - 1];
  engine.mergeDown(top.id, bottom.id, top.opacity, top.blendMode);
  s.removeLayerMeta(top.id);
  engine.deleteLayer(top.id);
}

export async function flattenImage(): Promise<void> {
  if (!engine) return;
  const s = useStore.getState();
  if (s.layers.length <= 1 && s.layers[0]?.opacity === 1) return;
  const data = await engine.readComposite(buildRenderState());
  if (data.length === 0) return;
  // flatten composites onto opaque white, like Photoshop
  for (let i = 0; i < data.length; i += 4) {
    const inv = 255 - data[i + 3];
    data[i] = Math.min(255, data[i] + inv);
    data[i + 1] = Math.min(255, data[i + 1] + inv);
    data[i + 2] = Math.min(255, data[i + 2] + inv);
    data[i + 3] = 255;
  }
  const keepId = s.layers.some((l) => l.id === 'background') ? 'background' : s.layers[0].id;
  engine.putLayerImage(keepId, data, DOC_SIZE.width, DOC_SIZE.height);
  for (const l of s.layers) {
    if (l.id !== keepId) engine.deleteLayer(l.id);
  }
  s.setLayers(
    [{ id: keepId, name: 'Background', visible: true, opacity: 1, blendMode: 'normal' }],
    keepId,
  );
}

// ---------------------------------------------------------------------------
// Image import (File > Open / Place)
// ---------------------------------------------------------------------------

/** Draws a bitmap into a doc-sized buffer of premultiplied RGBA. */
function bitmapToDocPixels(
  bmp: ImageBitmap,
  fit: boolean,
): Uint8Array<ArrayBuffer> {
  const { width: dw, height: dh } = DOC_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let w = bmp.width;
  let h = bmp.height;
  if (fit) {
    const scale = Math.min(1, dw / w, dh / h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  ctx.drawImage(bmp, Math.round((dw - w) / 2), Math.round((dh - h) / 2), w, h);
  const img = ctx.getImageData(0, 0, dw, dh).data;
  const out = new Uint8Array(dw * dh * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = img[i + 3];
    out[i] = (img[i] * a + 127) / 255;
    out[i + 1] = (img[i + 1] * a + 127) / 255;
    out[i + 2] = (img[i + 2] * a + 127) / 255;
    out[i + 3] = a;
  }
  return out;
}

/** File > Place: imports an image as a new layer, scaled down to fit. */
export async function placeImageFile(file: File): Promise<void> {
  if (!engine) return;
  const s = useStore.getState();
  if (s.layers.length >= MAX_LAYERS) return;
  const bmp = await createImageBitmap(file);
  const id = nextLayerId();
  engine.putLayerImage(id, bitmapToDocPixels(bmp, true), DOC_SIZE.width, DOC_SIZE.height);
  bmp.close();
  const meta: LayerMeta = {
    id,
    name: file.name.replace(/\.[^.]+$/, '') || 'Placed Image',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
  };
  s.addLayerMeta(meta, s.activeLayerId);
}

/** File > Open: replaces the document with one sized to the image. */
export async function openImageFile(file: File): Promise<void> {
  if (!engine) return;
  const bmp = await createImageBitmap(file);
  const res = useStore.getState().doc.resolution;
  newDocument(Math.min(bmp.width, 8192), Math.min(bmp.height, 8192), res, 'transparent');
  engine.putLayerImage(
    'background',
    bitmapToDocPixels(bmp, true),
    DOC_SIZE.width,
    DOC_SIZE.height,
  );
  bmp.close();
}

// Switching tools while a transform is open applies it, like Photoshop.
// Spacebar panning is exempt so you can reposition the view mid-transform.
useStore.subscribe((state, prev) => {
  if (!state.transform) return;
  // Switching to another layer ends the float/transform too.
  if (state.activeLayerId !== prev.activeLayerId) {
    commitTransform();
    return;
  }
  if (state.tool !== prev.tool && state.tool !== 'pan' && prev.tool !== 'pan') {
    commitTransform();
  }
});

/**
 * Imports a Photoshop .abr file: registers its sampled tips and texture
 * patterns, wraps every brush into a preset under a new "Imported" group,
 * and selects the first one. Returns the number of imported brushes.
 */
export function importAbr(fileName: string, buffer: ArrayBuffer): number {
  const result = brushAbr.parseAbr(buffer);
  const baseName = fileName.replace(/\.abr$/i, '') || 'Imported';
  const prefixed = (id: string) => `abr:${baseName}:${id}`;

  for (const [id, map] of result.tips) {
    brushPatterns.registerTip(prefixed(id), map);
  }
  for (const [id, pattern] of result.patterns) {
    brushPatterns.registerPattern(prefixed(id), pattern.map, pattern.name || id);
  }

  const presets = result.brushes.map((b, i) => {
    const settings = brushDefaults.makeBrush(b.settings);
    if (b.tipId) {
      settings.tip.shape = prefixed(b.tipId);
      // sampled tips ignore hardness; keep size sane if the desc lacked one
      if (!b.settings.tip?.size) {
        const map = result.tips.get(b.tipId);
        if (map) settings.tip.size = Math.min(map.size, 300);
      }
    }
    // dual brush may reference another sampled tip from this file
    if (settings.dual.enabled && result.tips.has(settings.dual.shape)) {
      settings.dual.shape = prefixed(settings.dual.shape);
    }
    if (settings.texture.enabled) {
      settings.texture.pattern = b.texturePatternId
        ? prefixed(b.texturePatternId)
        : 'paper';
    }
    return {
      id: `abr:${baseName}:${i}`,
      name: b.name || `${baseName} ${i + 1}`,
      settings,
    };
  });

  if (presets.length === 0) {
    throw new Error('No brushes found in this ABR file.');
  }

  brushPresets.registerImportedGroup(baseName, presets);
  const s = useStore.getState();
  s.bumpPresetRevision();
  s.applyPreset(presets[0].id, 'brush');
  return presets.length;
}

export function undo(): void {
  commitTransform(); // undoing right after reverts the just-baked float
  void engine?.undo();
}

export function redo(): void {
  commitTransform();
  void engine?.redo();
}

export async function exportPng(): Promise<void> {
  if (!engine) return;
  let data: Uint8Array;
  try {
    data = await engine.readComposite(buildRenderState());
  } catch (err) {
    alert(`Export failed: ${err}`);
    return;
  }
  if (data.length === 0) {
    alert('Export failed: could not read pixels back from the GPU.');
    return;
  }
  const { width, height } = DOC_SIZE;
  // un-premultiply for PNG
  const img = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    const inv = a > 0 ? 255 / a : 0;
    img.data[i * 4] = Math.min(255, data[i * 4] * inv);
    img.data[i * 4 + 1] = Math.min(255, data[i * 4 + 1] * inv);
    img.data[i * 4 + 2] = Math.min(255, data[i * 4 + 2] * inv);
    img.data[i * 4 + 3] = a;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'northlight.png';
  a.click();
  URL.revokeObjectURL(url);
}
