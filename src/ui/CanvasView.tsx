import { useEffect, useRef, useState } from 'react';
import {
  applySelectionShape,
  applyTransformPreview,
  autoSelectMoveTarget,
  buildRenderState,
  cancelTransform,
  commitTransform,
  deleteSelectionContents,
  fillActiveLayer,
  getEngine,
  invertSelection,
  mergeDown,
  nudgeMoveSession,
  redo,
  reselect,
  sampleCanvasColor,
  setEngine,
  setSelection,
  selectAll,
  startMoveSession,
  startTransform,
  transformQuadBy,
  addLayer,
  undo,
} from '../controller';
import { PaintEngine } from '../gpu/engine';
import { StrokeSession } from '../gpu/stroke';
import { engineStrokeParams } from '../brush/engineParams';
import type { PointerSample } from '../brush/dynamics';
import { rgbToHsv } from '../color/convert';
import {
  apply,
  homographyFromQuads,
  rotationAbout,
  translation,
  type Mat3,
} from '../transform/matrix';
import type { SelectionOp } from '../gpu/selection';
import { DOC_SIZE, useStore, type TransformState } from '../store';
import type { Point, ToolId } from '../types';

const MIN_ZOOM = 1 / 32;
const MAX_ZOOM = 32;

type TransformOp =
  | 'scale'
  | 'scaleAxis'
  | 'rotate'
  | 'skew'
  | 'distort'
  | 'perspective'
  | 'edgeMove'
  | 'move';

type Drag =
  | { kind: 'stroke'; session: StrokeSession }
  | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | {
      kind: 'zoom';
      startX: number;
      startY: number;
      startZoom: number;
      anchorDoc: Point;
      moved: boolean;
    }
  | { kind: 'marquee'; start: Point; end: Point; op: SelectionOp }
  | { kind: 'lasso'; points: Point[]; op: SelectionOp }
  | { kind: 'eyedrop' }
  /** move click waiting for async Auto-Select before the float opens */
  | { kind: 'movePending'; start: Point; last: Point; done: boolean }
  | {
      kind: 'transform';
      op: TransformOp;
      index: number; // corner/edge index
      startDoc: Point;
      startQuad: Point[];
      /** R-space -> doc at drag start, and its inverse */
      M: Mat3 | null;
      Minv: Mat3 | null;
      rStart: Point;
      center: Point;
    };

/** Photoshop-style modifier resolution for the selection tools. */
function selectionOpFromEvent(
  e: { shiftKey: boolean; altKey: boolean },
  fallback: SelectionOp,
): SelectionOp {
  if (e.shiftKey && e.altKey) return 'intersect';
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return fallback;
}

const rectCorners = (r: { x: number; y: number; w: number; h: number }): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

/**
 * Resize cursor for an on-screen axis, quantized to the four CSS resize
 * cursors. Because the axis comes from the live quad geometry, a box rotated
 * 90° swaps horizontal/vertical arrows and ~45° rotations show diagonals,
 * like Photoshop.
 */
function resizeCursorFor(dx: number, dy: number): string {
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI; // y-down screen space
  ang = ((ang % 180) + 180) % 180;
  if (ang < 22.5 || ang >= 157.5) return 'ew-resize';
  if (ang < 67.5) return 'nwse-resize';
  if (ang < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

const rotateCursorCache = new Map<number, string>();

/**
 * Curved double-arrow rotation cursor, oriented for a pointer sitting at
 * `angle` (radians) from the transform box center; the arc bows away from
 * the box. Built as an SVG data URI and cached per 45° step.
 */
function rotateCursor(angle: number): string {
  const deg =
    ((Math.round((angle * 180) / Math.PI / 45) * 45) % 360 + 360) % 360;
  let cur = rotateCursorCache.get(deg);
  if (cur) return cur;

  // arc from (16,4) to (16,20), radius 9, bowing toward +x
  const head = (px: number, py: number, dx: number, dy: number) => {
    const leg = (rot: number) => {
      const ca = Math.cos(rot);
      const sa = Math.sin(rot);
      const hx = dx * ca - dy * sa;
      const hy = dx * sa + dy * ca;
      return `M${px} ${py} l${(hx * 6).toFixed(1)} ${(hy * 6).toFixed(1)}`;
    };
    return leg(0.45) + leg(-0.45);
  };
  // arrowhead legs point back along the arc so the tips point outward
  const paths =
    '<path d="M16 4 A 9 9 0 0 1 16 20"/>' +
    `<path d="${head(16, 4, 0.894, 0.447)}"/>` +
    `<path d="${head(16, 20, 0.894, -0.447)}"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">` +
    `<g transform="rotate(${deg} 12 12)" fill="none" stroke-linecap="round">` +
    `<g stroke="%23fff" stroke-width="4.5">${paths}</g>` +
    `<g stroke="%23000" stroke-width="1.8">${paths}</g>` +
    `</g></svg>`;
  cur = `url("data:image/svg+xml,${svg.replace(/"/g, "'")}") 12 12, auto`;
  rotateCursorCache.set(deg, cur);
  return cur;
}

/** Shift-drag: snap movement to horizontal / vertical / 45° diagonals. */
function constrain45(dx: number, dy: number): [number, number] {
  if (Math.abs(dx) > 2 * Math.abs(dy)) return [dx, 0];
  if (Math.abs(dy) > 2 * Math.abs(dx)) return [0, dy];
  const d = (Math.abs(dx) + Math.abs(dy)) / 2;
  return [Math.sign(dx) * d, Math.sign(dy) * d];
}

/** Minimum distance from `p` to the quad's outline (its four segments). */
function distToQuadEdges(q: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)));
  }
  return best;
}

/** How far outside the box the move tool's rotate zone extends (CSS px). */
const ROTATE_BAND = 22;

function pointInQuad(p: Point, q: Point[]): boolean {
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

export function CanvasView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const polyRef = useRef<Point[] | null>(null);
  const polyPreviewRef = useRef<Point | null>(null);
  const cursorRef = useRef<{ x: number; y: number; over: boolean }>({
    x: 0,
    y: 0,
    over: false,
  });
  const spaceRef = useRef(false);
  /** tool to restore when Alt is released (temporary eyedropper) */
  const toolBeforeEyedropRef = useRef<ToolId | null>(null);
  /** drops overlapping eyedropper readbacks while one is in flight */
  const samplingRef = useRef(false);
  const digitRef = useRef<{ str: string; at: number; target: 'opacity' | 'flow' }>({
    str: '',
    at: 0,
    target: 'opacity',
  });
  const [ready, setReady] = useState(false);

  const tool = useStore((s) => s.tool);
  const gpuError = useStore((s) => s.gpuError);
  const fitNonce = useStore((s) => s.fitNonce);
  const hasTransform = useStore((s) => s.transform !== null);
  /** cursor for the transform overlay element under the pointer */
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  /** boolean-op override for an in-progress polygonal lasso */
  const polyOpRef = useRef<SelectionOp>('new');

  // --- engine lifecycle + render loop ---
  useEffect(() => {
    let raf = 0;
    let disposed = false;

    PaintEngine.create(canvasRef.current!, DOC_SIZE.width, DOC_SIZE.height)
      .then((engine) => {
        if (disposed) return;
        void engine.device.lost.then((info) => {
          if (info.reason !== 'destroyed') {
            useStore.getState().setGpuError(`WebGPU device lost: ${info.message}`);
          }
        });
        setEngine(engine);
        engine.resize();
        fitView();
        setReady(true);
        const loop = () => {
          engine.render(buildRenderState());
          drawOverlay();
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
      })
      .catch((err) => {
        useStore.getState().setGpuError(String(err?.message ?? err));
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      setEngine(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasTransform) setHoverCursor(null);
  }, [hasTransform, tool]);

  // re-fit after document size changes (New / Image Size / Canvas Size / ...)
  useEffect(() => {
    if (!ready) return;
    getEngine()?.resize();
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce, ready]);

  // --- keyboard shortcuts ---
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (e.code === 'Space' && !e.repeat) {
        spaceRef.current = true;
        if (s.tool !== 'pan' && !s.toolBeforePan) {
          s.setToolBeforePan(s.tool);
          s.setTool('pan');
        }
        e.preventDefault();
        return;
      }
      // Holding Alt with a painting tool temporarily switches to the
      // eyedropper (which then samples the foreground color), like Photoshop.
      if (e.key === 'Alt') {
        if (
          !e.repeat &&
          !s.transform &&
          (s.tool === 'brush' || s.tool === 'eraser') &&
          !toolBeforeEyedropRef.current
        ) {
          toolBeforeEyedropRef.current = s.tool;
          s.setTool('eyedropper');
        }
        e.preventDefault(); // keep the browser from focusing its menu bar
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      // Ctrl+Shift+I inverse, Ctrl+Shift+D reselect, Ctrl+Shift+N new layer
      if (mod && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        invertSelection();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        reselect();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        addLayer();
        return;
      }
      // Alt+Ctrl+I / Alt+Ctrl+C open the Image Size / Canvas Size dialogs
      if (mod && e.altKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        s.setDialog('imageSize');
        return;
      }
      if (mod && e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        s.setDialog('canvasSize');
        return;
      }
      if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault();
        void startTransform('layer', 'free');
        return;
      }
      if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        mergeDown();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setSelection(null);
        return;
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod && e.key === '0') {
        e.preventDefault();
        fitView();
        return;
      }
      if (mod && e.key === '1') {
        e.preventDefault();
        zoomTo(1);
        return;
      }
      // Photoshop fill/clear shortcuts: Alt+Backspace fills the foreground
      // color, Ctrl+Backspace the background color (both clip to a selection
      // when one exists); plain Backspace/Delete clears the selected pixels.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        if (e.altKey) fillActiveLayer('fg');
        else if (mod) fillActiveLayer('bg');
        else if (s.selectionPaths) deleteSelectionContents();
        return;
      }
      // Arrows nudge the transform box, or the layer/selection with Move (V)
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        if (dx === 0 && dy === 0) return;
        if (s.transform) {
          e.preventDefault();
          transformQuadBy(translation(dx, dy));
        } else if (s.tool === 'move') {
          e.preventDefault();
          nudgeMoveSession(dx, dy);
        }
        return;
      }
      if (mod) return;

      // Photoshop numeric shortcuts: digits set opacity, Shift+digits set
      // flow — swapped while the airbrush toggle is on. Two digits typed
      // quickly combine (4 then 5 -> 45%); 0 means 100%. Match on e.code so
      // Shift+7 ('&' as a key) still counts as a digit.
      const digitMatch = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
      if (digitMatch && (s.tool === 'brush' || s.tool === 'eraser')) {
        const digit = digitMatch[1];
        const toolKey = s.tool;
        const settings = s[toolKey];
        const target: 'opacity' | 'flow' =
          e.shiftKey === settings.airbrush ? 'opacity' : 'flow';
        const now = performance.now();
        const buf = digitRef.current;
        let str =
          now - buf.at < 700 && buf.target === target ? buf.str + digit : digit;
        if (str.length > 2) str = str.slice(-2);
        digitRef.current = { str, at: now, target };
        let val = parseInt(str, 10);
        if (str.length === 1) val *= 10; // single digit means N*10%
        if (val === 0) val = 100;
        s.updateBrush({ [target]: val / 100 } as never, toolKey);
        return;
      }

      // Shift+[ / ] step hardness by 25%, like Photoshop.
      if (e.shiftKey && (e.key === '{' || e.key === '}')) {
        const toolKey = s.tool === 'eraser' ? 'eraser' : 'brush';
        const tip = s[toolKey].tip;
        const dir = e.key === '}' ? 0.25 : -0.25;
        s.updateBrush(
          { tip: { ...tip, hardness: Math.min(1, Math.max(0, tip.hardness + dir)) } },
          toolKey,
        );
        return;
      }

      switch (e.key) {
        case 'v': s.setTool('move'); break;
        case 'b': s.setTool('brush'); break;
        case 'e': s.setTool('eraser'); break;
        case 'i': s.setTool('eyedropper'); break;
        case 'h': s.setTool('pan'); break;
        case 'z': s.setTool('zoom'); break;
        case 'm': s.setTool('marquee'); break;
        case 'l': s.setTool('lasso'); break;
        case 'p': s.setTool('polyLasso'); break;
        case 'x': s.swapColors(); break;
        case 'd': s.resetColors(); break;
        case '[': {
          const t = s.tool === 'eraser' ? 'eraser' : 'brush';
          const tip = s[t].tip;
          const size = Math.max(1, tip.size - Math.max(1, Math.round(tip.size * 0.1)));
          s.updateBrush({ tip: { ...tip, size } }, t);
          break;
        }
        case ']': {
          const t = s.tool === 'eraser' ? 'eraser' : 'brush';
          const tip = s[t].tip;
          const size = Math.min(1000, tip.size + Math.max(1, Math.round(tip.size * 0.1)));
          s.updateBrush({ tip: { ...tip, size } }, t);
          break;
        }
        case 'Enter':
          if (s.transform) commitTransform();
          else closePoly();
          break;
        case 'Escape':
          if (s.transform) {
            dragRef.current = null;
            cancelTransform();
          } else if (polyRef.current) {
            polyRef.current = null;
            polyPreviewRef.current = null;
          } else if (dragRef.current?.kind === 'stroke') {
            dragRef.current.session.cancel();
            getEngine()?.cancelStroke();
            dragRef.current = null;
          } else {
            setSelection(null);
          }
          break;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        const s = useStore.getState();
        if (s.toolBeforePan) {
          s.setTool(s.toolBeforePan);
          s.setToolBeforePan(null);
        }
      }
      if (e.key === 'Alt') {
        const back = toolBeforeEyedropRef.current;
        toolBeforeEyedropRef.current = null;
        const s = useStore.getState();
        if (back && s.tool === 'eyedropper') s.setTool(back);
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // --- wheel zoom (non-passive) ---
  useEffect(() => {
    const el = wrapRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const pt = eventToScreen(e);
      const s = useStore.getState();
      const factor = Math.exp(-e.deltaY * 0.0015);
      applyZoom(s.view.zoom * factor, pt);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function eventToScreen(e: { clientX: number; clientY: number }): Point {
    const rect = wrapRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * devicePixelRatio,
      y: (e.clientY - rect.top) * devicePixelRatio,
    };
  }

  function screenToDoc(p: Point): Point {
    const v = useStore.getState().view;
    return { x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom };
  }

  function docToScreen(p: Point): Point {
    const v = useStore.getState().view;
    return { x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY };
  }

  function applyZoom(newZoom: number, screenAnchor: Point) {
    const s = useStore.getState();
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const doc = screenToDoc(screenAnchor);
    s.setView({
      zoom,
      panX: screenAnchor.x - doc.x * zoom,
      panY: screenAnchor.y - doc.y * zoom,
    });
  }

  function zoomTo(zoom: number) {
    const canvas = canvasRef.current!;
    applyZoom(zoom, { x: canvas.width / 2, y: canvas.height / 2 });
  }

  function fitView() {
    const canvas = canvasRef.current!;
    const w = canvas.width;
    const h = canvas.height;
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((w * 0.9) / DOC_SIZE.width, (h * 0.9) / DOC_SIZE.height)),
    );
    useStore.getState().setView({
      zoom,
      panX: (w - DOC_SIZE.width * zoom) / 2,
      panY: (h - DOC_SIZE.height * zoom) / 2,
    });
  }

  function sampleOf(e: PointerEvent, doc: Point): PointerSample {
    return {
      x: doc.x,
      y: doc.y,
      pressure: e.pointerType === 'pen' ? e.pressure : 1,
      tiltX: e.tiltX ?? 0,
      tiltY: e.tiltY ?? 0,
      twist: e.twist ?? 0,
    };
  }

  function activeTool(e: { button?: number }): ToolId {
    if (e.button === 1 || spaceRef.current) return 'pan';
    return useStore.getState().tool;
  }

  function closePoly() {
    const pts = polyRef.current;
    polyRef.current = null;
    polyPreviewRef.current = null;
    if (pts && pts.length >= 3) applySelectionShape([pts], polyOpRef.current);
  }

  /**
   * Maps a pointer position to a transform-box interaction: corner and edge
   * handles first, then inside (move) / outside (rotate). Which operation a
   * handle performs depends on the transform mode and Ctrl, like Photoshop.
   */
  function transformHandleAt(
    t: TransformState,
    screen: Point,
    ctrl: boolean,
  ): { op: TransformOp; index: number; zone: 'corner' | 'edge' | 'inside' | 'outside' } {
    const qs = t.quad.map(docToScreen);
    const tol = 8 * devicePixelRatio;
    const near = (a: Point) => Math.hypot(a.x - screen.x, a.y - screen.y) <= tol;

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
   * Cursor for the transform overlay under the pointer: rotation-aware
   * resize arrows on the handles (axes come from the live quad geometry, so
   * a rotated box shows rotated arrows), curved rotate arrows outside, and
   * a move cursor inside. Also covers the move tool's idle selection box.
   */
  function transformCursorAt(screen: Point, ctrl: boolean): string | null {
    const s = useStore.getState();
    let tr = s.transform;
    if (!tr && s.tool === 'move' && s.moveShowTransform && s.selectionPaths) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const path of s.selectionPaths) {
        for (const p of path) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
      if (!Number.isFinite(minX)) return null;
      const rect = {
        x: minX,
        y: minY,
        w: Math.max(maxX - minX, 1),
        h: Math.max(maxY - minY, 1),
      };
      tr = {
        target: 'layer',
        mode: 'free',
        layerId: s.activeLayerId,
        rect,
        quad: rectCorners(rect),
        duplicate: false,
        showHandles: true,
        engaged: false,
      };
    }
    if (!tr) return null;
    const h = transformHandleAt(tr, screen, ctrl);
    const moveTool = s.tool === 'move' && !tr.engaged;
    if (moveTool && (!tr.showHandles || h.zone === 'inside')) return 'move';
    if (moveTool && h.zone === 'outside') {
      const qs2 = tr.quad.map(docToScreen);
      if (distToQuadEdges(qs2, screen) > ROTATE_BAND * devicePixelRatio) return 'move';
      // falls through: rotate cursor for the band just outside the box
    }
    const qs = tr.quad.map(docToScreen);
    const center = {
      x: (qs[0].x + qs[1].x + qs[2].x + qs[3].x) / 4,
      y: (qs[0].y + qs[1].y + qs[2].y + qs[3].y) / 4,
    };
    const mid = (i: number) => ({
      x: (qs[i].x + qs[(i + 1) % 4].x) / 2,
      y: (qs[i].y + qs[(i + 1) % 4].y) / 2,
    });
    switch (h.op) {
      case 'move':
      case 'edgeMove':
        return 'move';
      case 'rotate':
        return rotateCursor(Math.atan2(screen.y - center.y, screen.x - center.x));
      case 'scale': {
        const o = qs[(h.index + 2) % 4];
        return resizeCursorFor(qs[h.index].x - o.x, qs[h.index].y - o.y);
      }
      case 'scaleAxis': {
        const m1 = mid(h.index);
        const m2 = mid((h.index + 2) % 4);
        return resizeCursorFor(m1.x - m2.x, m1.y - m2.y);
      }
      case 'skew': {
        // skew slides along the edge, so the arrows follow the edge itself
        const a2 = qs[h.index];
        const b2 = qs[(h.index + 1) % 4];
        return resizeCursorFor(b2.x - a2.x, b2.y - a2.y);
      }
      case 'distort':
      case 'perspective':
        return 'crosshair';
    }
  }

  /** Builds the drag record for a transform-box interaction. */
  function makeTransformDrag(
    tr: TransformState,
    op: TransformOp,
    index: number,
    doc: Point,
  ): Extract<Drag, { kind: 'transform' }> {
    const Rc = rectCorners(tr.rect);
    const M = homographyFromQuads(Rc, tr.quad);
    const Minv = homographyFromQuads(tr.quad, Rc);
    const q = tr.quad;
    return {
      kind: 'transform',
      op,
      index,
      startDoc: doc,
      startQuad: q.map((pt) => ({ ...pt })),
      M,
      Minv,
      rStart: Minv ? apply(Minv, doc) : doc,
      center: {
        x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
        y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
      },
    };
  }

  /** Applies a transform-handle drag, returning the new quad (or null). */
  function computeTransformQuad(
    drag: Extract<Drag, { kind: 'transform' }>,
    rect: TransformState['rect'],
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

  /**
   * Eyedropper sample: sets the foreground color, or the background color on
   * Alt+click. The temporary (Alt-held) eyedropper always samples the
   * foreground, since Alt is what invoked it — matching Photoshop.
   */
  function eyedropAt(doc: Point, altKey: boolean) {
    const target: 'fg' | 'bg' = !toolBeforeEyedropRef.current && altKey ? 'bg' : 'fg';
    if (samplingRef.current) return;
    samplingRef.current = true;
    sampleCanvasColor(doc.x, doc.y)
      .then((rgb) => {
        if (!rgb) return;
        const s = useStore.getState();
        const hsv = rgbToHsv(rgb, target === 'bg' ? s.bg.h : s.fg.h);
        if (target === 'bg') s.setBg(hsv);
        else s.setFg(hsv);
      })
      .catch(() => {})
      .finally(() => {
        samplingRef.current = false;
      });
  }

  // -------------------------------------------------------------------------
  // pointer handlers
  // -------------------------------------------------------------------------

  function onPointerDown(e: React.PointerEvent) {
    if (e.button === 2) return;
    const engine = getEngine();
    if (!engine) return;
    wrapRef.current!.setPointerCapture(e.pointerId);
    const screen = eventToScreen(e.nativeEvent);
    const doc = screenToDoc(screen);
    const s = useStore.getState();
    const t = activeTool(e.nativeEvent);

    // An open transform box (or the move tool, which opens a float on
    // demand) captures pointer input, except while panning/zooming.
    if ((s.transform || t === 'move') && t !== 'pan' && t !== 'zoom') {
      if (t === 'move' && !s.transform) {
        const alt = e.nativeEvent.altKey;
        if (s.moveAutoSelect) {
          // pick the layer under the cursor first, then open the float
          const drag: Extract<Drag, { kind: 'movePending' }> = {
            kind: 'movePending',
            start: doc,
            last: doc,
            done: false,
          };
          dragRef.current = drag;
          void autoSelectMoveTarget(doc.x, doc.y).then(() => {
            if (!startMoveSession(alt)) {
              if (dragRef.current === drag) dragRef.current = null;
              return;
            }
            const dx = Math.round(drag.last.x - drag.start.x);
            const dy = Math.round(drag.last.y - drag.start.y);
            if (dx !== 0 || dy !== 0) transformQuadBy(translation(dx, dy));
            const tr = useStore.getState().transform;
            if (!drag.done && dragRef.current === drag && tr) {
              dragRef.current = makeTransformDrag(tr, 'move', 0, drag.last);
            } else if (dragRef.current === drag) {
              dragRef.current = null;
            }
          });
          return;
        }
        if (!startMoveSession(alt)) return;
      }
      const tr = useStore.getState().transform;
      if (!tr) return;
      let handle = transformHandleAt(tr, screen, e.ctrlKey || e.metaKey);
      if (t === 'move' && !tr.engaged) {
        if (!tr.showHandles || handle.zone === 'inside') {
          handle = { op: 'move', index: 0, zone: 'inside' };
        } else if (handle.zone === 'outside') {
          // a band just outside the box rotates (and engages the transform,
          // like Photoshop's transform controls); farther out still moves
          if (
            distToQuadEdges(tr.quad.map(docToScreen), screen) <=
            ROTATE_BAND * devicePixelRatio
          ) {
            handle = { op: 'rotate', index: 0, zone: 'outside' };
            s.patchTransform({ engaged: true });
          } else {
            handle = { op: 'move', index: 0, zone: 'inside' };
          }
        } else {
          // grabbing a handle escalates the float into a full transform
          s.patchTransform({ engaged: true });
        }
      }
      dragRef.current = makeTransformDrag(tr, handle.op, handle.index, doc);
      return;
    }

    switch (t) {
      case 'brush':
      case 'eraser': {
        const settings = t === 'eraser' ? s.eraser : s.brush;
        // On the Background layer the eraser paints the background color
        // instead of clearing to transparency, like Photoshop.
        const eraseToBg = t === 'eraser' && s.activeLayerId === 'background';
        const params = engineStrokeParams(
          settings,
          t === 'eraser' && !eraseToBg ? 'erase' : 'paint',
        );
        if (eraseToBg) params.blendMode = 'normal';
        engine.beginStroke(params);
        const session = new StrokeSession(
          engine,
          settings,
          eraseToBg ? { fg: s.bg, bg: s.bg } : { fg: s.fg, bg: s.bg },
        );
        session.down(sampleOf(e.nativeEvent, doc));
        dragRef.current = { kind: 'stroke', session };
        break;
      }
      case 'eyedropper':
        dragRef.current = { kind: 'eyedrop' };
        eyedropAt(doc, e.nativeEvent.altKey);
        break;
      case 'pan':
        dragRef.current = {
          kind: 'pan',
          startX: screen.x,
          startY: screen.y,
          panX: s.view.panX,
          panY: s.view.panY,
        };
        break;
      case 'zoom':
        dragRef.current = {
          kind: 'zoom',
          startX: screen.x,
          startY: screen.y,
          startZoom: s.view.zoom,
          anchorDoc: doc,
          moved: false,
        };
        break;
      case 'marquee':
        dragRef.current = {
          kind: 'marquee',
          start: doc,
          end: doc,
          op: selectionOpFromEvent(e.nativeEvent, s.selectionOp),
        };
        break;
      case 'lasso':
        dragRef.current = {
          kind: 'lasso',
          points: [doc],
          op: selectionOpFromEvent(e.nativeEvent, s.selectionOp),
        };
        break;
      case 'polyLasso': {
        const first = polyRef.current?.[0];
        if (first && polyRef.current!.length >= 3) {
          const fs = docToScreen(first);
          if (Math.hypot(fs.x - screen.x, fs.y - screen.y) < 10 * devicePixelRatio) {
            closePoly();
            break;
          }
        }
        if (!polyRef.current) {
          polyRef.current = [doc];
          polyOpRef.current = selectionOpFromEvent(e.nativeEvent, s.selectionOp);
        } else {
          polyRef.current.push(doc);
        }
        break;
      }
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const screen = eventToScreen(e.nativeEvent);
    cursorRef.current = { ...screen, over: true };
    if (!dragRef.current) {
      setHoverCursor(transformCursorAt(screen, e.ctrlKey || e.metaKey));
    }
    const drag = dragRef.current;
    if (polyRef.current) polyPreviewRef.current = screenToDoc(screen);
    if (!drag) return;
    const s = useStore.getState();

    switch (drag.kind) {
      case 'stroke': {
        const events =
          typeof e.nativeEvent.getCoalescedEvents === 'function'
            ? e.nativeEvent.getCoalescedEvents()
            : [e.nativeEvent];
        const list = events.length > 0 ? events : [e.nativeEvent];
        drag.session.move(list.map((ev) => sampleOf(ev, screenToDoc(eventToScreen(ev)))));
        break;
      }
      case 'pan':
        s.setView({
          zoom: s.view.zoom,
          panX: drag.panX + (screen.x - drag.startX),
          panY: drag.panY + (screen.y - drag.startY),
        });
        break;
      case 'zoom': {
        const dx = screen.x - drag.startX;
        if (Math.abs(dx) > 3 || drag.moved) {
          drag.moved = true;
          const zoom = Math.min(
            MAX_ZOOM,
            Math.max(MIN_ZOOM, drag.startZoom * Math.exp(dx * 0.005)),
          );
          s.setView({
            zoom,
            panX: drag.startX - drag.anchorDoc.x * zoom,
            panY: drag.startY - drag.anchorDoc.y * zoom,
          });
        }
        break;
      }
      case 'marquee':
        drag.end = screenToDoc(screen);
        break;
      case 'lasso': {
        const doc = screenToDoc(screen);
        const lastPt = drag.points[drag.points.length - 1];
        const lastScreen = docToScreen(lastPt);
        if (Math.hypot(screen.x - lastScreen.x, screen.y - lastScreen.y) > 1.5) {
          drag.points.push(doc);
        }
        break;
      }
      case 'eyedrop':
        // keep sampling while dragging, like Photoshop
        eyedropAt(screenToDoc(screen), e.altKey);
        break;
      case 'movePending':
        drag.last = screenToDoc(screen);
        break;
      case 'transform': {
        const t = s.transform;
        if (!t) break;
        const quad = computeTransformQuad(
          drag,
          t.rect,
          screenToDoc(screen),
          e.shiftKey,
          e.altKey,
        );
        if (quad) {
          s.patchTransform({ quad });
          applyTransformPreview();
        }
        break;
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const engine = getEngine();
    const s = useStore.getState();
    const screen = eventToScreen(e.nativeEvent);

    switch (drag.kind) {
      case 'stroke':
        drag.session.up();
        engine?.endStroke(s.activeLayerId);
        break;
      case 'zoom':
        if (!drag.moved) {
          applyZoom(s.view.zoom * (e.altKey ? 1 / 1.5 : 1.5), screen);
        }
        break;
      case 'marquee': {
        const { start, end, op } = drag;
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        if (w * s.view.zoom < 3 && h * s.view.zoom < 3) {
          if (op === 'new') setSelection(null); // click deselects
        } else {
          applySelectionShape(
            [
              [
                { x: start.x, y: start.y },
                { x: end.x, y: start.y },
                { x: end.x, y: end.y },
                { x: start.x, y: end.y },
              ],
            ],
            op,
          );
        }
        break;
      }
      case 'lasso':
        if (drag.points.length >= 3) applySelectionShape([drag.points], drag.op);
        else if (drag.op === 'new') setSelection(null);
        break;
      case 'movePending':
        // the float stays open; the Auto-Select continuation sees `done`
        drag.done = true;
        break;
      case 'pan':
      case 'eyedrop':
      case 'transform':
        break;
    }
  }

  // -------------------------------------------------------------------------
  // overlay: marching ants, previews, brush cursor
  // -------------------------------------------------------------------------

  function drawOverlay() {
    const overlay = overlayRef.current;
    const wrap = wrapRef.current;
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

    // committed selection (mapped through an in-progress transform)
    if (s.selectionPaths) {
      let paths = s.selectionPaths;
      if (s.transform) {
        const H = homographyFromQuads(
          rectCorners(s.transform.rect),
          s.transform.quad,
        );
        if (H) paths = paths.map((path) => path.map((pt) => apply(H, pt)));
      }
      ants(paths, true, true);
    }

    // in-progress previews
    const drag = dragRef.current;
    if (drag?.kind === 'marquee') {
      const { start, end } = drag;
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
    } else if (drag?.kind === 'lasso') {
      ants([drag.points], false, false);
    }
    if (polyRef.current) {
      const pts = polyPreviewRef.current
        ? [...polyRef.current, polyPreviewRef.current]
        : polyRef.current;
      ants([pts], false, false);
      // highlight the closing point
      const p0 = docToScreen(polyRef.current[0]);
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
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const path of s.selectionPaths) {
        for (const p of path) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
      if (Number.isFinite(minX)) {
        drawBox(
          rectCorners({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }).map(
            docToScreen,
          ),
        );
      }
    }

    // brush cursor
    const cur = cursorRef.current;
    const t = spaceRef.current ? 'pan' : s.tool;
    if (cur.over && (t === 'brush' || t === 'eraser')) {
      const settings = t === 'eraser' ? s.eraser : s.brush;
      const r = (settings.tip.size / 2) * s.view.zoom;
      ctx.beginPath();
      ctx.arc(cur.x, cur.y, Math.max(r, 1), 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cur.x, cur.y, Math.max(r - dpr, 0.5), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
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

  const cursorStyle: Record<string, string> = {
    move: 'move',
    brush: 'none',
    eraser: 'none',
    eyedropper: 'crosshair',
    pan: dragRef.current?.kind === 'pan' ? 'grabbing' : 'grab',
    zoom: 'zoom-in',
    marquee: 'crosshair',
    lasso: 'crosshair',
    polyLasso: 'crosshair',
  };

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      style={{ cursor: hoverCursor ?? cursorStyle[tool] ?? 'default', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        cursorRef.current.over = false;
        setHoverCursor(null);
      }}
      onDoubleClick={() => {
        if (useStore.getState().transform) commitTransform();
        else closePoly();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="gpu-canvas" />
      <canvas ref={overlayRef} className="overlay-canvas" />
      {gpuError && (
        <div className="gpu-error">
          <h2>WebGPU unavailable</h2>
          <p>{gpuError}</p>
          <p>
            Northlight needs a browser with WebGPU support (Chrome, Edge, or
            recent Safari/Firefox).
          </p>
        </div>
      )}
      {!ready && !gpuError && <div className="gpu-loading">Starting WebGPU…</div>}
    </div>
  );
}
