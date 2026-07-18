import { apply, homographyFromQuads, rotationAbout, type Mat3 } from './matrix';
import {
  constrain45,
  distToQuadEdges,
  pointInQuad,
  quadCenter,
  rectCorners,
  type Rect,
} from './quad';
import type { TransformState } from '../store';
import type { Point } from '../types';

/**
 * Pure math for the interactive transform box: which handle a pointer hits,
 * and how dragging that handle reshapes the quad. Kept free of DOM and store
 * access so the geometry is unit-testable; the view supplies the doc->screen
 * mapping and pixel tolerances.
 */

export type TransformOp =
  | 'scale'
  | 'scaleAxis'
  | 'rotate'
  | 'skew'
  | 'distort'
  | 'perspective'
  | 'edgeMove'
  | 'move';

export interface TransformHandle {
  op: TransformOp;
  index: number; // corner/edge index
  zone: 'corner' | 'edge' | 'inside' | 'outside';
}

/** How far outside the box the move tool's rotate zone extends (CSS px). */
export const ROTATE_BAND = 22;

/** View-dependent inputs: mapping to screen space and hit tolerances. */
export interface ScreenSpace {
  docToScreen: (p: Point) => Point;
  /** handle hit radius, device px */
  tolerance: number;
  /** move tool's rotate band width, device px */
  rotateBand: number;
}

/**
 * Maps a pointer position to a transform-box interaction: corner and edge
 * handles first, then inside (move) / outside (rotate). Which operation a
 * handle performs depends on the transform mode and Ctrl, like Photoshop.
 */
export function transformHandleAt(
  t: TransformState,
  screen: Point,
  ctrl: boolean,
  space: ScreenSpace,
): TransformHandle {
  const qs = t.quad.map(space.docToScreen);
  const near = (a: Point) => Math.hypot(a.x - screen.x, a.y - screen.y) <= space.tolerance;

  const cornerOp: Record<string, TransformOp> = {
    free: ctrl ? 'distort' : 'scale',
    scale: 'scale',
    rotate: 'rotate',
    skew: 'distort',
    distort: 'distort',
    perspective: 'perspective',
  };
  const edgeOp: Record<string, TransformOp> = {
    free: ctrl ? 'skew' : 'scaleAxis',
    scale: 'scaleAxis',
    rotate: 'rotate',
    skew: 'skew',
    distort: 'edgeMove',
    perspective: 'scaleAxis',
  };

  for (let i = 0; i < 4; i++) {
    if (near(qs[i])) return { op: cornerOp[t.mode], index: i, zone: 'corner' };
  }
  for (let i = 0; i < 4; i++) {
    const mid = {
      x: (qs[i].x + qs[(i + 1) % 4].x) / 2,
      y: (qs[i].y + qs[(i + 1) % 4].y) / 2,
    };
    if (near(mid)) return { op: edgeOp[t.mode], index: i, zone: 'edge' };
  }
  if (pointInQuad(screen, qs)) return { op: 'move', index: 0, zone: 'inside' };
  return { op: 'rotate', index: 0, zone: 'outside' };
}

/**
 * Resolves what a pointer at `screen` does to the transform box. Shared by
 * the pointer-down handler and the hover cursor so the interaction regions
 * cannot diverge. With the move tool, the zones are the same whether or
 * not the float is engaged: handles transform, a band just outside the
 * outline rotates (both engage the transform), and everywhere else —
 * inside or far outside — moves. Other tools (an explicit Free Transform)
 * rotate anywhere outside, like Photoshop's Ctrl+T.
 */
export function resolveTransformIntent(
  tr: TransformState,
  screen: Point,
  ctrl: boolean,
  isMoveTool: boolean,
  space: ScreenSpace,
): { op: TransformOp; index: number; engages: boolean } {
  const h = transformHandleAt(tr, screen, ctrl, space);
  if (!isMoveTool) {
    return { op: h.op, index: h.index, engages: false };
  }
  if (!tr.showHandles && !tr.engaged) return { op: 'move', index: 0, engages: false };
  if (h.zone === 'inside') return { op: 'move', index: 0, engages: false };
  if (h.zone === 'outside') {
    const inBand =
      distToQuadEdges(tr.quad.map(space.docToScreen), screen) <= space.rotateBand;
    return inBand
      ? { op: 'rotate', index: 0, engages: true }
      : { op: 'move', index: 0, engages: false };
  }
  return { op: h.op, index: h.index, engages: true };
}

/** Snapshot of the quad and mappings at drag start. */
export interface TransformDragState {
  op: TransformOp;
  index: number; // corner/edge index
  startDoc: Point;
  startQuad: Point[];
  /** R-space -> doc at drag start, and its inverse */
  M: Mat3 | null;
  Minv: Mat3 | null;
  rStart: Point;
  center: Point;
}

/** Builds the drag record for a transform-box interaction. */
export function makeTransformDrag(
  tr: TransformState,
  op: TransformOp,
  index: number,
  doc: Point,
): TransformDragState {
  const Rc = rectCorners(tr.rect);
  const M = homographyFromQuads(Rc, tr.quad);
  const Minv = homographyFromQuads(tr.quad, Rc);
  return {
    op,
    index,
    startDoc: doc,
    startQuad: tr.quad.map((pt) => ({ ...pt })),
    M,
    Minv,
    rStart: Minv ? apply(Minv, doc) : doc,
    center: quadCenter(tr.quad),
  };
}

/** Applies a transform-handle drag, returning the new quad (or null). */
export function computeTransformQuad(
  drag: TransformDragState,
  rect: Rect,
  p: Point,
  shift: boolean,
  alt: boolean,
): Point[] | null {
  const { op, index: k, startDoc, startQuad, M, Minv, rStart, center } = drag;
  const Rc = rectCorners(rect);
  const rCenter = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
  const mapR = (pts: Point[]) => (M ? pts.map((q) => apply(M, q)) : null);

  switch (op) {
    case 'move': {
      let dx = p.x - startDoc.x;
      let dy = p.y - startDoc.y;
      if (shift) [dx, dy] = constrain45(dx, dy);
      // whole-pixel steps keep translated content crisp
      dx = Math.round(dx);
      dy = Math.round(dy);
      return startQuad.map((q) => ({ x: q.x + dx, y: q.y + dy }));
    }
    case 'rotate': {
      let dth =
        Math.atan2(p.y - center.y, p.x - center.x) -
        Math.atan2(startDoc.y - center.y, startDoc.x - center.x);
      if (shift) dth = Math.round(dth / (Math.PI / 12)) * (Math.PI / 12);
      const m = rotationAbout(dth, center.x, center.y);
      return startQuad.map((q) => apply(m, q));
    }
    case 'scale': {
      if (!Minv) return null;
      const r = apply(Minv, p);
      const ck = Rc[k];
      const a = alt ? rCenter : Rc[(k + 2) % 4];
      let sx = Math.abs(ck.x - a.x) < 1e-6 ? 1 : (r.x - a.x) / (ck.x - a.x);
      let sy = Math.abs(ck.y - a.y) < 1e-6 ? 1 : (r.y - a.y) / (ck.y - a.y);
      if (shift) sx = sy = Math.abs(sx) > Math.abs(sy) ? sx : sy;
      return mapR(
        Rc.map((c) => ({ x: a.x + (c.x - a.x) * sx, y: a.y + (c.y - a.y) * sy })),
      );
    }
    case 'scaleAxis': {
      if (!Minv) return null;
      const r = apply(Minv, p);
      const mids = Rc.map((c, i) => ({
        x: (c.x + Rc[(i + 1) % 4].x) / 2,
        y: (c.y + Rc[(i + 1) % 4].y) / 2,
      }));
      const mk = mids[k];
      const a = alt ? rCenter : mids[(k + 2) % 4];
      let sx = 1;
      let sy = 1;
      if (k === 0 || k === 2) {
        sy = Math.abs(mk.y - a.y) < 1e-6 ? 1 : (r.y - a.y) / (mk.y - a.y);
        if (shift) sx = sy;
      } else {
        sx = Math.abs(mk.x - a.x) < 1e-6 ? 1 : (r.x - a.x) / (mk.x - a.x);
        if (shift) sy = sx;
      }
      return mapR(
        Rc.map((c) => ({ x: a.x + (c.x - a.x) * sx, y: a.y + (c.y - a.y) * sy })),
      );
    }
    case 'skew': {
      if (!Minv) return null;
      const r = apply(Minv, p);
      const d = { x: r.x - rStart.x, y: r.y - rStart.y };
      const nr = Rc.map((c) => ({ ...c }));
      if (k === 0 || k === 2) {
        const [i, j] = k === 0 ? [0, 1] : [2, 3];
        nr[i].x += d.x;
        nr[j].x += d.x;
      } else {
        const [i, j] = k === 1 ? [1, 2] : [3, 0];
        nr[i].y += d.y;
        nr[j].y += d.y;
      }
      return mapR(nr);
    }
    case 'distort': {
      const quad = startQuad.map((q) => ({ ...q }));
      quad[k] = { ...p };
      return quad;
    }
    case 'edgeMove': {
      const dx = p.x - startDoc.x;
      const dy = p.y - startDoc.y;
      const quad = startQuad.map((q) => ({ ...q }));
      quad[k] = { x: quad[k].x + dx, y: quad[k].y + dy };
      const j = (k + 1) % 4;
      quad[j] = { x: quad[j].x + dx, y: quad[j].y + dy };
      return quad;
    }
    case 'perspective': {
      if (!Minv) return null;
      const r = apply(Minv, p);
      const d = { x: r.x - rStart.x, y: r.y - rStart.y };
      const px = [1, 0, 3, 2][k]; // partner across the vertical axis
      const py = [3, 2, 1, 0][k]; // partner across the horizontal axis
      const nr = Rc.map((c) => ({ ...c }));
      nr[k] = { x: nr[k].x + d.x, y: nr[k].y + d.y };
      nr[px] = { ...nr[px], x: nr[px].x - d.x };
      nr[py] = { ...nr[py], y: nr[py].y - d.y };
      return mapR(nr);
    }
  }
}
