import { useEffect, useRef, useState } from 'react';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  activeLocks,
  applySelectionShape,
  applyTransformPreview,
  applyZoom,
  autoSelectMoveTarget,
  buildRenderState,
  canEditActivePixels,
  cancelTransform,
  commitTransform,
  fitOnScreen,
  getEngine,
  nextZoomStop,
  sampleCanvasColor,
  setEngine,
  setSelection,
  startMoveSession,
  transformQuadBy,
} from '../controller';
import { PaintEngine } from '../gpu/engine';
import { StrokeSession } from '../gpu/stroke';
import { engineStrokeParams } from '../brush/engineParams';
import type { PointerSample } from '../brush/dynamics';
import { rgbToHsv } from '../color/convert';
import { translation } from '../transform/matrix';
import {
  ROTATE_BAND,
  computeTransformQuad,
  makeTransformDrag,
  resolveTransformIntent,
  type ScreenSpace,
  type TransformDragState,
} from '../transform/interaction';
import { pathsBounds, quadCenter, rectCorners } from '../transform/quad';
import type { SelectionOp } from '../gpu/selection';
import { DOC_SIZE, useStore, type TransformState } from '../store';
import type { Point, ToolId } from '../types';
import {
  eyedropperCursor,
  moveToolCursor,
  resizeCursorFor,
  rotateCursor,
  selectionToolCursor,
  zoomCursor,
} from './cursors';
import { drawOverlay } from './overlay';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

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
  | ({ kind: 'transform' } & TransformDragState);

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

/** Tools where holding Ctrl temporarily switches to Move, like Photoshop. */
const CTRL_MOVE_TOOLS: ReadonlySet<ToolId> = new Set([
  'brush',
  'eraser',
  'eyedropper',
  'marquee',
  'lasso',
  'polyLasso',
]);

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
  /** currently held modifier keys, for the temporary-tool overrides */
  const spaceRef = useRef(false);
  const altRef = useRef(false);
  const ctrlRef = useRef(false);
  /** drops overlapping eyedropper readbacks while one is in flight */
  const samplingRef = useRef(false);
  const digitRef = useRef<{ str: string; at: number; target: 'opacity' | 'flow' }>({
    str: '',
    at: 0,
    target: 'opacity',
  });
  const [ready, setReady] = useState(false);

  const tool = useStore((s) => s.tool);
  const overrideTool = useStore((s) => s.overrideTool);
  const gpuError = useStore((s) => s.gpuError);
  const fitNonce = useStore((s) => s.fitNonce);
  const hasTransform = useStore((s) => s.transform !== null);
  /** cursor for the transform overlay element under the pointer */
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  /** Alt held: zoom tool shows the zoom-out cursor, like Photoshop */
  const [altDown, setAltDown] = useState(false);
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
        fitOnScreen();
        setReady(true);
        // The GPU composite only reruns when something changed: engine
        // content (dirty flag), the layer stack / active layer / viewport
        // (store references — every update replaces them), or the canvas
        // size. The cheap 2D overlay still draws every frame for the
        // marching ants and the brush cursor.
        let last: { layers?: unknown; activeLayerId?: string; view?: unknown } = {};
        const loop = () => {
          // Device loss surfaces via device.lost above; keep the loop alive
          // so the 2D overlay (ants, transform box, brush cursor) still draws.
          try {
            const rs = buildRenderState();
            const resized = engine.resize();
            if (
              engine.consumeDirty() ||
              resized ||
              rs.layers !== last.layers ||
              rs.activeLayerId !== last.activeLayerId ||
              rs.view !== last.view
            ) {
              engine.render(rs);
              last = rs;
            }
          } catch {
            engine.markDirty(); // retry if the device comes back
          }
          paintOverlay();
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
  }, [hasTransform, tool, overrideTool]);

  // re-fit after document size changes (New / Image Size / Canvas Size / ...)
  useEffect(() => {
    if (!ready) return;
    getEngine()?.resize();
    fitOnScreen();
  }, [fitNonce, ready]);

  /**
   * Photoshop-style temporary tool overrides from held keys, resolved from
   * the full modifier state so any press/release order works:
   *   Space = hand; Space+Ctrl = zoom in; Space+Alt = zoom out;
   *   Alt with a painting tool = eyedropper; Ctrl = move.
   * The base tool never changes — the override lives beside it in the store —
   * so releasing the keys always returns to where you started, and e.g.
   * Space+Alt releasing just Space lands on the eyedropper.
   */
  function syncOverride() {
    // keep the temporary tool through an active drag, like Photoshop
    if (dragRef.current) return;
    const s = useStore.getState();
    const base = s.tool;
    let ov: ToolId | null = null;
    if (spaceRef.current) {
      ov = altRef.current || ctrlRef.current ? 'zoom' : 'pan';
    } else if (!s.transform && altRef.current && (base === 'brush' || base === 'eraser')) {
      ov = 'eyedropper';
    } else if (!s.transform && ctrlRef.current && CTRL_MOVE_TOOLS.has(base)) {
      ov = 'move';
    }
    if (ov === base) ov = null;
    if (ov === s.overrideTool) return;
    // leaving a Ctrl-move: bake the float so the base tool paints again
    if (s.overrideTool === 'move' && ov !== 'move' && s.transform && !s.transform.engaged) {
      commitTransform();
    }
    s.setOverrideTool(ov);
  }

  // The Photoshop keyboard map lives in useKeyboardShortcuts; only the
  // Enter/Escape resolutions need this component's drag/poly state.
  useKeyboardShortcuts({
    spaceRef,
    altRef,
    ctrlRef,
    digitRef,
    setAltDown,
    syncOverride,
    updateHoverCursor,
    onEnter: () => {
      if (useStore.getState().transform) commitTransform();
      else closePoly();
    },
    onEscape: () => {
      if (useStore.getState().transform) {
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
    },
  });

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
    if (e.button === 1) return 'pan'; // middle-button pan
    const s = useStore.getState();
    return s.overrideTool ?? s.tool;
  }

  function closePoly() {
    const pts = polyRef.current;
    polyRef.current = null;
    polyPreviewRef.current = null;
    if (pts && pts.length >= 3) applySelectionShape([pts], polyOpRef.current);
  }

  /** View-dependent inputs for the shared transform-box hit testing. */
  function screenSpace(): ScreenSpace {
    return {
      docToScreen,
      tolerance: 8 * devicePixelRatio,
      rotateBand: ROTATE_BAND * devicePixelRatio,
    };
  }

  /** resolveTransformIntent with this view's tool state and screen mapping. */
  function resolveIntent(tr: TransformState, screen: Point, ctrl: boolean) {
    const s = useStore.getState();
    return resolveTransformIntent(
      tr,
      screen,
      ctrl,
      (s.overrideTool ?? s.tool) === 'move',
      screenSpace(),
    );
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
    const effTool = s.overrideTool ?? s.tool;
    if (!tr && effTool === 'move' && s.moveShowTransform && s.selectionPaths) {
      const b = pathsBounds(s.selectionPaths);
      if (!b) return null;
      const rect = { x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1) };
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
    const h = resolveIntent(tr, screen, ctrl);
    const qs = tr.quad.map(docToScreen);
    const center = quadCenter(qs);
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

  /**
   * Badge cursor for a selection tool when the effective boolean op is not
   * 'new' — from held modifiers or the options-bar op, like Photoshop.
   */
  function selectionModCursor(mods: { shiftKey: boolean; altKey: boolean }): string | null {
    const s = useStore.getState();
    if (s.transform || s.overrideTool) return null;
    const t = s.tool;
    if (t !== 'marquee' && t !== 'lasso' && t !== 'polyLasso') return null;
    // an in-progress polygonal lasso locked its op at the first click
    const fallback = polyRef.current ? polyOpRef.current : s.selectionOp;
    const op = selectionOpFromEvent(mods, fallback);
    return op === 'new' ? null : selectionToolCursor(t, op);
  }

  /**
   * Recomputes the hover cursor from the pointer position and modifier keys.
   * Called on pointer moves and on Shift/Alt/Ctrl transitions so the cursor
   * updates the moment a modifier is pressed, without waiting for movement.
   */
  function updateHoverCursor(mods: {
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }) {
    if (dragRef.current) return;
    const cur = cursorRef.current;
    const ov = useStore.getState().overrideTool;
    // a temporary hand/zoom keeps its own cursor, even over a transform box
    if (!cur.over || ov === 'pan' || ov === 'zoom') {
      setHoverCursor(null);
      return;
    }
    const screen = { x: cur.x, y: cur.y };
    setHoverCursor(
      transformCursorAt(screen, mods.ctrlKey || mods.metaKey) ?? selectionModCursor(mods),
    );
  }

  /**
   * Eyedropper sample: sets the foreground color, or the background color on
   * Alt+click. The temporary (Alt-held) eyedropper always samples the
   * foreground, since Alt is what invoked it — matching Photoshop.
   */
  function eyedropAt(doc: Point, altKey: boolean) {
    const temporary = useStore.getState().overrideTool === 'eyedropper';
    const target: 'fg' | 'bg' = !temporary && altKey ? 'bg' : 'fg';
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
              dragRef.current = {
                kind: 'transform',
                ...makeTransformDrag(tr, 'move', 0, drag.last),
              };
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
      const intent = resolveIntent(tr, screen, e.ctrlKey || e.metaKey);
      // handle grabs and band rotations escalate the float into a full transform
      if (intent.engages && !tr.engaged) s.patchTransform({ engaged: true });
      dragRef.current = {
        kind: 'transform',
        ...makeTransformDrag(tr, intent.op, intent.index, doc),
      };
      return;
    }

    switch (t) {
      case 'brush':
      case 'eraser': {
        // locked / hidden layers and groups reject the stroke, like Photoshop
        if (!canEditActivePixels()) break;
        const settings = t === 'eraser' ? s.eraser : s.brush;
        const locks = activeLocks();
        // On the Background layer — and on transparency-locked layers, where
        // alpha cannot change — the eraser paints the background color
        // instead of clearing to transparency, like Photoshop.
        const eraseToBg =
          t === 'eraser' && (s.activeLayerId === 'background' || locks.transparency);
        const params = engineStrokeParams(
          settings,
          t === 'eraser' && !eraseToBg ? 'erase' : 'paint',
        );
        if (eraseToBg) params.blendMode = 'normal';
        params.lockTransparent = locks.transparency;
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
    updateHoverCursor(e);
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
          // click steps to the next Photoshop zoom stop; Alt+click zooms out
          applyZoom(nextZoomStop(s.view.zoom, e.altKey ? 'out' : 'in'), screen);
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

    // modifiers released mid-drag apply now that the drag is over
    syncOverride();
  }

  // -------------------------------------------------------------------------
  // overlay: marching ants, previews, brush cursor
  // -------------------------------------------------------------------------

  /** Feeds this view's interaction state to the shared overlay painter. */
  function paintOverlay() {
    const drag = dragRef.current;
    drawOverlay({
      overlay: overlayRef.current,
      wrap: wrapRef.current,
      docToScreen,
      shape: drag?.kind === 'marquee' || drag?.kind === 'lasso' ? drag : null,
      poly: polyRef.current,
      polyPreview: polyPreviewRef.current,
      cursor: cursorRef.current,
    });
  }

  /** Base cursor for the effective tool; Alt flips the zoom cursor to −. */
  function baseCursorFor(t: ToolId, alt: boolean): string {
    switch (t) {
      case 'move': return moveToolCursor();
      case 'brush':
      case 'eraser': return 'none'; // the overlay draws the tip outline
      case 'eyedropper': return eyedropperCursor();
      case 'pan': return dragRef.current?.kind === 'pan' ? 'grabbing' : 'grab';
      case 'zoom': return zoomCursor(alt ? 'out' : 'in');
      case 'marquee': return 'crosshair';
      case 'lasso': return selectionToolCursor('lasso', 'new');
      case 'polyLasso': return selectionToolCursor('polyLasso', 'new');
    }
  }

  return (
    <div
      ref={wrapRef}
      className="canvas-wrap"
      style={{
        cursor: hoverCursor ?? baseCursorFor(overrideTool ?? tool, altDown),
        touchAction: 'none',
      }}
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
