import { useEffect, useRef, useState } from 'react';
import {
  buildRenderState,
  deleteSelectionContents,
  fillActiveLayer,
  getEngine,
  redo,
  sampleCanvasColor,
  setEngine,
  setSelection,
  selectAll,
  undo,
} from '../controller';
import { PaintEngine } from '../gpu/engine';
import { StrokeSession } from '../gpu/stroke';
import { engineStrokeParams } from '../brush/engineParams';
import type { PointerSample } from '../brush/dynamics';
import { rgbToHsv } from '../color/convert';
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
  | { kind: 'lasso'; points: Point[] }
  | { kind: 'eyedrop' };

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
      // Holding Alt with a painting tool temporarily switches to the
      // eyedropper (which then samples the foreground color), like Photoshop.
      if (e.key === 'Alt') {
        if (
          !e.repeat &&
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
          closePoly();
          break;
        case 'Escape':
          if (polyRef.current) {
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
    if (pts && pts.length >= 3) setSelection([pts]);
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
      case 'eyedrop':
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
