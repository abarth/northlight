import { useEffect, useRef, useState } from 'react';
import {
  buildRenderState,
  getEngine,
  redo,
  setEngine,
  setSelection,
  selectAll,
  undo,
} from '../controller';
import { hsvToRgb } from '../color/convert';
import { PaintEngine } from '../gpu/engine';
import { StrokeSession } from '../gpu/stroke';
import { DOC_SIZE, useStore } from '../store';
import type { Point, ToolId } from '../types';

const MIN_ZOOM = 1 / 32;
const MAX_ZOOM = 32;

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
  | { kind: 'marquee'; start: Point; end: Point }
  | { kind: 'lasso'; points: Point[] };

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
  const [ready, setReady] = useState(false);

  const tool = useStore((s) => s.tool);
  const gpuError = useStore((s) => s.gpuError);

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
      if (mod) return;

      switch (e.key) {
        case 'b': s.setTool('brush'); break;
        case 'e': s.setTool('eraser'); break;
        case 'h': s.setTool('pan'); break;
        case 'z': s.setTool('zoom'); break;
        case 'm': s.setTool('marquee'); break;
        case 'l': s.setTool('lasso'); break;
        case 'p': s.setTool('polyLasso'); break;
        case 'x': s.swapColors(); break;
        case 'd': s.resetColors(); break;
        case '[': {
          const t = s.tool === 'eraser' ? 'eraser' : 'brush';
          const size = s[t].size;
          s.updateBrush({ size: Math.max(1, size - Math.max(1, Math.round(size * 0.1))) }, t);
          break;
        }
        case ']': {
          const t = s.tool === 'eraser' ? 'eraser' : 'brush';
          const size = s[t].size;
          s.updateBrush({ size: Math.min(1000, size + Math.max(1, Math.round(size * 0.1))) }, t);
          break;
        }
        case 'Enter':
          closePoly();
          break;
        case 'Escape':
          if (polyRef.current) {
            polyRef.current = null;
            polyPreviewRef.current = null;
          } else if (dragRef.current?.kind === 'stroke') {
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

  function pressureOf(e: PointerEvent): number {
    return e.pointerType === 'pen' ? e.pressure : 1;
  }

  function activeTool(e: { button?: number }): ToolId {
    if (e.button === 1 || spaceRef.current) return 'pan';
    return useStore.getState().tool;
  }

  function closePoly() {
    const pts = polyRef.current;
    polyRef.current = null;
    polyPreviewRef.current = null;
    if (pts && pts.length >= 3) setSelection([pts]);
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

    switch (t) {
      case 'brush':
      case 'eraser': {
        const settings = t === 'eraser' ? s.eraser : s.brush;
        const rgb = hsvToRgb(s.fg);
        engine.beginStroke({
          mode: t === 'eraser' ? 'erase' : 'paint',
          color: [rgb.r, rgb.g, rgb.b],
          opacity: settings.opacity,
          hardness: settings.hardness,
        });
        const session = new StrokeSession(engine, settings);
        session.down({ x: doc.x, y: doc.y, pressure: pressureOf(e.nativeEvent) });
        dragRef.current = { kind: 'stroke', session };
        break;
      }
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
        dragRef.current = { kind: 'marquee', start: doc, end: doc };
        break;
      case 'lasso':
        dragRef.current = { kind: 'lasso', points: [doc] };
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
        if (!polyRef.current) polyRef.current = [doc];
        else polyRef.current.push(doc);
        break;
      }
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    const screen = eventToScreen(e.nativeEvent);
    cursorRef.current = { ...screen, over: true };
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
        drag.session.move(
          list.map((ev) => {
            const d = screenToDoc(eventToScreen(ev));
            return { x: d.x, y: d.y, pressure: pressureOf(ev) };
          }),
        );
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
        const { start, end } = drag;
        const w = Math.abs(end.x - start.x);
        const h = Math.abs(end.y - start.y);
        if (w * s.view.zoom < 3 && h * s.view.zoom < 3) {
          setSelection(null);
        } else {
          setSelection([
            [
              { x: start.x, y: start.y },
              { x: end.x, y: start.y },
              { x: end.x, y: end.y },
              { x: start.x, y: end.y },
            ],
          ]);
        }
        break;
      }
      case 'lasso':
        if (drag.points.length >= 3) setSelection([drag.points]);
        else setSelection(null);
        break;
      case 'pan':
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

    // committed selection
    if (s.selectionPaths) ants(s.selectionPaths, true, true);

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

    // brush cursor
    const cur = cursorRef.current;
    const t = spaceRef.current ? 'pan' : s.tool;
    if (cur.over && (t === 'brush' || t === 'eraser')) {
      const settings = t === 'eraser' ? s.eraser : s.brush;
      const r = (settings.size / 2) * s.view.zoom;
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
    brush: 'none',
    eraser: 'none',
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
      style={{ cursor: cursorStyle[tool] ?? 'default', touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        cursorRef.current.over = false;
      }}
      onDoubleClick={closePoly}
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
