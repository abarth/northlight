import { footprintOutline, penPose } from '../brush/bristle';
import { tipOutline } from '../brush/tipOutline';
import { apply, homographyFromQuads } from '../transform/matrix';
import { pathsBounds, rectCorners } from '../transform/quad';
import { useStore } from '../store';
import type { Point } from '../types';

/**
 * The 2D overlay above the GPU canvas: marching ants, in-progress selection
 * shapes, the transform box + handles, and the brush-tip cursor. Redrawn
 * every frame (the ants animate); everything here is cheap 2D path work.
 */

export interface OverlayScene {
  overlay: HTMLCanvasElement | null;
  wrap: HTMLDivElement | null;
  docToScreen: (p: Point) => Point;
  /** live marquee/lasso drag preview, if one is in progress */
  shape:
    | { kind: 'marquee'; start: Point; end: Point }
    | { kind: 'lasso'; points: Point[] }
    | null;
  /** committed points of an in-progress polygonal lasso */
  poly: Point[] | null;
  polyPreview: Point | null;
  cursor: {
    x: number;
    y: number;
    over: boolean;
    /** live pen orientation for the bristle footprint preview */
    tiltX: number;
    tiltY: number;
    twist: number;
  };
}

export function drawOverlay(scene: OverlayScene): void {
  const { overlay, wrap, docToScreen } = scene;
  if (!overlay || !wrap) return;
  const w = Math.max(1, Math.floor(wrap.clientWidth * devicePixelRatio));
  const h = Math.max(1, Math.floor(wrap.clientHeight * devicePixelRatio));
  if (overlay.width !== w) overlay.width = w;
  if (overlay.height !== h) overlay.height = h;
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  const dpr = devicePixelRatio;
  const s = useStore.getState();

  const tracePath = (pts: Point[], close: boolean) => {
    ctx.beginPath();
    const p0 = docToScreen(pts[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < pts.length; i++) {
      const p = docToScreen(pts[i]);
      ctx.lineTo(p.x, p.y);
    }
    if (close) ctx.closePath();
  };

  const ants = (paths: Point[][], close: boolean, animate: boolean) => {
    const dash = 5 * dpr;
    const offset = animate ? -((performance.now() / 40) % (dash * 2)) : 0;
    ctx.lineWidth = Math.max(1, dpr);
    for (const pts of paths) {
      if (pts.length < 2) continue;
      tracePath(pts, close);
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = offset;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.lineDashOffset = offset + dash;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
    ctx.setLineDash([]);
  };

  // committed selection (mapped through an in-progress transform);
  // hidden while Extras is off (View > Extras, Ctrl+H)
  if (s.selectionPaths && s.showExtras) {
    let paths = s.selectionPaths;
    if (s.transform) {
      const H = homographyFromQuads(rectCorners(s.transform.rect), s.transform.quad);
      if (H) paths = paths.map((path) => path.map((pt) => apply(H, pt)));
    }
    ants(paths, true, true);
  }

  // in-progress previews
  if (scene.shape?.kind === 'marquee') {
    const { start, end } = scene.shape;
    ants(
      [
        [
          { x: start.x, y: start.y },
          { x: end.x, y: start.y },
          { x: end.x, y: end.y },
          { x: start.x, y: end.y },
        ],
      ],
      true,
      false,
    );
  } else if (scene.shape?.kind === 'lasso') {
    ants([scene.shape.points], false, false);
  }
  if (scene.poly) {
    const pts = scene.polyPreview ? [...scene.poly, scene.polyPreview] : scene.poly;
    ants([pts], false, false);
    // highlight the closing point
    const p0 = docToScreen(scene.poly[0]);
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, 4 * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }

  // transform box + handles
  const drawBox = (qs: Point[]) => {
    ctx.beginPath();
    ctx.moveTo(qs[0].x, qs[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(qs[i].x, qs[i].y);
    ctx.closePath();
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = '#3d8bff';
    ctx.stroke();
    const handles = [...qs];
    for (let i = 0; i < 4; i++) {
      handles.push({
        x: (qs[i].x + qs[(i + 1) % 4].x) / 2,
        y: (qs[i].y + qs[(i + 1) % 4].y) / 2,
      });
    }
    const hs = 3.5 * dpr;
    for (const p of handles) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#3d8bff';
      ctx.fillRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
      ctx.strokeRect(p.x - hs, p.y - hs, hs * 2, hs * 2);
    }
  };
  if (s.transform) {
    if (s.transform.showHandles) drawBox(s.transform.quad.map(docToScreen));
  } else if (s.tool === 'move' && s.moveShowTransform && s.selectionPaths) {
    // idle transform controls around the selection, like Photoshop's
    // "Show Transform Controls" (dragging a handle opens the float)
    const b = pathsBounds(s.selectionPaths);
    if (b) drawBox(rectCorners(b).map(docToScreen));
  }

  // brush cursor: an outline of the basic shape of the mark. Sampled and
  // non-round tips use the traced tip contour; round tips an ellipse. The
  // transform mirrors the stamp shader: scale y by roundness, mirror for
  // flips (the shader flips uv, so the mark mirrors), rotate by the static
  // tip angle (negated to Photoshop's CCW-positive convention).
  const cur = scene.cursor;
  const t = s.overrideTool ?? s.tool;

  // Bristle-engine cursor: the analytic filbert footprint, oriented by the
  // live pen tilt/twist — the full-pressure outline (dashed), the light-touch
  // outline (solid), and a tick along the flat of the filbert. You can see
  // what the mark will be before the pen lands.
  if (cur.over && t === 'brush' && s.brushEngine === 'bristle') {
    const pen = { x: 0, y: 0, tiltX: cur.tiltX, tiltY: cur.tiltY, twist: cur.twist };
    const sizePx = s.brush.tip.size * s.view.zoom;
    const stroked = (pts: Point[], dash: number[]) => {
      ctx.beginPath();
      pts.forEach((p, i) =>
        i === 0 ? ctx.moveTo(cur.x + p.x, cur.y + p.y) : ctx.lineTo(cur.x + p.x, cur.y + p.y),
      );
      ctx.closePath();
      ctx.setLineDash(dash);
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1, dpr) * 2.4;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const full = footprintOutline(s.bristle, penPose(s.bristle, { ...pen, pressure: 1 }), sizePx);
    const touch = footprintOutline(
      s.bristle,
      penPose(s.bristle, { ...pen, pressure: 0.35 }),
      sizePx,
    );
    stroked(full, [4 * dpr, 3 * dpr]);
    stroked(touch, []);
    // flat-axis tick: opposite points of the touch outline lie on the long axis
    const a = touch[0];
    const b = touch[touch.length / 2];
    ctx.beginPath();
    ctx.moveTo(cur.x + a.x, cur.y + a.y);
    ctx.lineTo(cur.x + b.x, cur.y + b.y);
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.stroke();
  } else if (cur.over && (t === 'brush' || t === 'eraser')) {
    const tip = (t === 'eraser' ? s.eraser : s.brush).tip;
    const r = Math.max((tip.size / 2) * s.view.zoom, 1);
    const roundness = Math.max(tip.roundness, 0.01);
    const angle = (-tip.angle / 180) * Math.PI;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const loops = tip.shape === 'round' ? [] : tipOutline(tip.shape);

    ctx.beginPath();
    if (loops.length > 0) {
      const fx = tip.flipX ? -1 : 1;
      const fy = tip.flipY ? -1 : 1;
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i++) {
          const lx = loop[i].x * fx * r;
          const ly = loop[i].y * fy * r * roundness;
          const x = cur.x + lx * ca - ly * sa;
          const y = cur.y + lx * sa + ly * ca;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
    } else {
      ctx.ellipse(cur.x, cur.y, r, Math.max(r * roundness, 1), angle, 0, Math.PI * 2);
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, dpr) * 2.4;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.stroke();
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    if (r < 4) {
      // crosshair for tiny brushes
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(cur.x - 6 * dpr, cur.y);
      ctx.lineTo(cur.x + 6 * dpr, cur.y);
      ctx.moveTo(cur.x, cur.y - 6 * dpr);
      ctx.lineTo(cur.x, cur.y + 6 * dpr);
      ctx.stroke();
    }
  }
}
