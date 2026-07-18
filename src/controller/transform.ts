import * as color from '../color/convert';
import { transformMask } from '../gpu/selection';
import {
  apply,
  homographyFromQuads,
  rotationAbout,
  scaleAbout,
  translation,
  type Mat3,
} from '../transform/matrix';
import { quadMatchesRect, rectCorners, type Rect } from '../transform/quad';
import { effectiveVisible } from '../layers';
import { DOC_SIZE, useStore, type TransformMode } from '../store';
import { getEngine } from './engineHost';
import { canMoveActiveLayer } from './layerOps';
import { commitSelectionMask, getSelectionMask, selectionBounds } from './selection';

/**
 * Interactive transforms: Edit > Free Transform / Transform, the move tool's
 * float, and Select > Transform Selection.
 */

export function bgFillFor(layerId: string): [number, number, number] | null {
  if (layerId !== 'background') return null;
  const c = color.hsvToRgb(useStore.getState().bg);
  return [c.r, c.g, c.b];
}

/** Bounding box of a layer's non-transparent pixels, or null when empty. */
async function layerContentBounds(layerId: string): Promise<Rect | null> {
  const engine = getEngine();
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
  const engine = getEngine();
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
    if (!canMoveActiveLayer()) return false;
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
  const engine = getEngine();
  const s = useStore.getState();
  if (s.transform) return true;
  if (!engine || engine.transformActive) return false;
  if (!canMoveActiveLayer()) return false;
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
  const engine = getEngine();
  if (!engine) return;
  const s = useStore.getState();
  for (let i = s.layers.length - 1; i >= 0; i--) {
    const l = s.layers[i];
    if (l.kind !== 'layer' || !effectiveVisible(s.layers, l.id)) continue;
    const c = await engine.sampleColor(x, y, 1, { layerId: l.id });
    if (c && c.a > 0.1) {
      if (l.id !== s.activeLayerId) s.setActiveLayer(l.id);
      return;
    }
  }
}

/** Re-renders the layer preview from the current quad. */
export function applyTransformPreview(): void {
  const engine = getEngine();
  const t = useStore.getState().transform;
  if (!t || t.target !== 'layer' || !engine) return;
  const hInv = homographyFromQuads(t.quad, rectCorners(t.rect));
  if (!hInv) return;
  engine.previewTransform(hInv, {
    withSelection: !!getSelectionMask(),
    duplicate: t.duplicate,
    bgFill: bgFillFor(t.layerId),
  });
}

export function commitTransform(): void {
  const engine = getEngine();
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
        withSelection: !!getSelectionMask(),
        duplicate: t.duplicate,
        bgFill: bgFillFor(t.layerId),
      });
      engine.endTransform(true);
    } else {
      // nothing changed: restore the snapshot bit-for-bit, no undo entry
      engine?.endTransform(false);
    }
  }
  const mask = getSelectionMask();
  if (!identity && hInv && mask) {
    commitSelectionMask(transformMask(mask, DOC_SIZE.width, DOC_SIZE.height, hInv));
  }
}

export function cancelTransform(): void {
  const s = useStore.getState();
  const t = s.transform;
  if (!t) return;
  s.setTransform(null);
  if (t.target === 'layer') getEngine()?.endTransform(false);
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

// Switching tools while a transform is open applies it, like Photoshop.
// The view tools (hand, zoom) are exempt so you can reposition mid-transform.
const VIEW_TOOLS: ReadonlySet<string> = new Set(['pan', 'zoom']);
useStore.subscribe((state, prev) => {
  if (!state.transform) return;
  // Switching to another layer ends the float/transform too.
  if (state.activeLayerId !== prev.activeLayerId) {
    commitTransform();
    return;
  }
  if (state.tool !== prev.tool && !VIEW_TOOLS.has(state.tool) && !VIEW_TOOLS.has(prev.tool)) {
    commitTransform();
  }
});
