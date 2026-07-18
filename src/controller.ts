import { PaintEngine, type RenderState } from './gpu/engine';
import * as shaders from './gpu/shaders';
import * as color from './color/convert';
import * as brushDefaults from './brush/defaults';
import * as brushDynamics from './brush/dynamics';
import * as brushPatterns from './brush/patterns';
import * as brushPresets from './brush/presets';
import * as brushAbr from './brush/abr';
import { engineStrokeParams } from './brush/engineParams';
import { tipOutline } from './brush/tipOutline';
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
import type { LayerLocks, LayerMeta, Point } from './types';
import { makeLayerMeta } from './types';
import {
  childrenOf,
  descendantIds,
  displayRows,
  effectiveLocks,
  effectiveVisible,
  layerById,
  moveSubtree,
  nextName,
  pixelLayers,
  resolveRenderLayers,
  subtreeRange,
} from './layers';

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
        tipOutline: typeof tipOutline;
      };
      setEngine: typeof setEngine;
      edit: {
        selectAll: typeof selectAll;
        setSelection: typeof setSelection;
        copySelection: typeof copySelection;
        cutSelection: typeof cutSelection;
        paste: typeof paste;
      };
      layersUtil: {
        resolveRenderLayers: typeof resolveRenderLayers;
        effectiveLocks: typeof effectiveLocks;
        displayRows: typeof displayRows;
        moveSubtree: typeof moveSubtree;
      };
      layerOps: {
        addLayer: typeof addLayer;
        addGroup: typeof addGroup;
        groupActiveLayer: typeof groupActiveLayer;
        ungroupActiveLayer: typeof ungroupActiveLayer;
        duplicateActiveLayer: typeof duplicateActiveLayer;
        layerViaCopy: typeof layerViaCopy;
        deleteLayer: typeof deleteLayer;
        deleteHiddenLayers: typeof deleteHiddenLayers;
        arrangeActiveLayer: typeof arrangeActiveLayer;
        toggleActiveLayerLock: typeof toggleActiveLayerLock;
        mergeDown: typeof mergeDown;
        mergeGroup: typeof mergeGroup;
        mergeVisible: typeof mergeVisible;
        flattenImage: typeof flattenImage;
      };
      view: {
        zoomIn: typeof zoomIn;
        zoomOut: typeof zoomOut;
        zoomTo: typeof zoomTo;
        fitOnScreen: typeof fitOnScreen;
        nextZoomStop: typeof nextZoomStop;
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
    tipOutline,
  },
  setEngine,
  edit: { selectAll, setSelection, copySelection, cutSelection, paste },
  layersUtil: { resolveRenderLayers, effectiveLocks, displayRows, moveSubtree },
  layerOps: {
    addLayer,
    addGroup,
    groupActiveLayer,
    ungroupActiveLayer,
    duplicateActiveLayer,
    layerViaCopy,
    deleteLayer,
    deleteHiddenLayers,
    arrangeActiveLayer,
    toggleActiveLayerLock,
    mergeDown,
    mergeGroup,
    mergeVisible,
    flattenImage,
  },
  view: { zoomIn, zoomOut, zoomTo, fitOnScreen, nextZoomStop },
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

/**
 * Groups compose as pass-through containers: the compositor sees only pixel
 * layers, with group visibility/opacity folded into each child.
 */
export function buildRenderState(): RenderState {
  const s = useStore.getState();
  return {
    layers: resolveRenderLayers(s.layers),
    activeLayerId: s.activeLayerId,
    view: s.view,
  };
}

export const MAX_LAYERS = 64; // matches the compositor's uniform buffer

// ---------------------------------------------------------------------------
// Layer / group management (Layer menu, layers panel)
// ---------------------------------------------------------------------------

function activeLayer(): LayerMeta | undefined {
  const s = useStore.getState();
  return layerById(s.layers, s.activeLayerId);
}

/** Locks on the active layer, including locks inherited from its groups. */
export function activeLocks(): LayerLocks {
  const s = useStore.getState();
  return effectiveLocks(s.layers, s.activeLayerId);
}

/** Whether painting / erasing / filling may touch the active layer. */
export function canEditActivePixels(): boolean {
  const s = useStore.getState();
  const a = activeLayer();
  if (!a || a.kind !== 'layer' || !effectiveVisible(s.layers, a.id)) return false;
  const locks = activeLocks();
  return !locks.pixels && !locks.all;
}

/** Whether the active layer may be moved or transformed. */
export function canMoveActiveLayer(): boolean {
  const s = useStore.getState();
  const a = activeLayer();
  if (!a || a.kind !== 'layer' || !effectiveVisible(s.layers, a.id)) return false;
  const locks = activeLocks();
  return !locks.position && !locks.all;
}

export function addLayer(): void {
  if (!engine) return;
  const s = useStore.getState();
  if (pixelLayers(s.layers).length >= MAX_LAYERS) return;
  const id = nextLayerId();
  engine.ensureLayer(id);
  s.addLayerMeta(
    makeLayerMeta({ id, name: nextName(s.layers, 'Layer') }),
    s.activeLayerId,
  );
}

/** Layer > New > Group: an empty group above (or inside) the active layer. */
export function addGroup(): void {
  const s = useStore.getState();
  s.addLayerMeta(
    makeLayerMeta({ id: nextLayerId(), name: nextName(s.layers, 'Group'), kind: 'group' }),
    s.activeLayerId,
  );
}

/** Layer > Group Layers (Ctrl+G): wraps the active layer/group in a group. */
export function groupActiveLayer(): void {
  commitTransform();
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active) return;
  const range = subtreeRange(s.layers, active.id)!;
  const id = nextLayerId();
  const group = makeLayerMeta({
    id,
    name: nextName(s.layers, 'Group'),
    kind: 'group',
    parentId: active.parentId,
  });
  const layers = s.layers.map((l, i) =>
    i === range[1] ? { ...l, parentId: id } : l,
  );
  layers.splice(range[1] + 1, 0, group);
  s.setLayers(layers, id);
}

/** Layer > Ungroup Layers (Shift+Ctrl+G): dissolves the active group. */
export function ungroupActiveLayer(): void {
  const s = useStore.getState();
  const g = layerById(s.layers, s.activeLayerId);
  if (!g || g.kind !== 'group') return;
  const kids = childrenOf(s.layers, g.id);
  const layers = s.layers
    .filter((l) => l.id !== g.id)
    .map((l) => (l.parentId === g.id ? { ...l, parentId: g.parentId } : l));
  const active = kids.length > 0 ? kids[kids.length - 1].id : layers[0]?.id;
  if (!active) return;
  s.setLayers(layers, active);
}

/** Deleting must always leave at least one pixel layer behind. */
export function canDeleteActiveLayer(): boolean {
  const s = useStore.getState();
  const a = layerById(s.layers, s.activeLayerId);
  if (!a) return false;
  const inTree = a.kind === 'group' ? descendantIds(s.layers, a.id) : new Set<string>();
  return s.layers.some(
    (l) => l.kind === 'layer' && l.id !== a.id && !inTree.has(l.id),
  );
}

/** Deletes a layer, or a group with everything in it. */
export function deleteLayer(id: string): void {
  const s = useStore.getState();
  const range = subtreeRange(s.layers, id);
  if (!range) return;
  const block = s.layers.slice(range[0], range[1] + 1);
  const blockIds = new Set(block.map((l) => l.id));
  if (s.transform && blockIds.has(s.transform.layerId)) cancelTransform();
  else commitTransform();
  const remaining = s.layers.filter((l) => !blockIds.has(l.id));
  if (!remaining.some((l) => l.kind === 'layer')) return; // keep >= 1 layer
  for (const l of block) {
    if (l.kind === 'layer') engine?.deleteLayer(l.id);
  }
  const active = blockIds.has(s.activeLayerId)
    ? remaining[Math.min(Math.max(range[0] - 1, 0), remaining.length - 1)].id
    : s.activeLayerId;
  useStore.getState().setLayers(remaining, active);
}

/** Layer > Delete > Hidden Layers. */
export function deleteHiddenLayers(): void {
  commitTransform();
  const s = useStore.getState();
  const doomed = s.layers.filter((l) => !effectiveVisible(s.layers, l.id));
  if (doomed.length === 0) return;
  const doomedIds = new Set(doomed.map((l) => l.id));
  const remaining = s.layers.filter((l) => !doomedIds.has(l.id));
  if (!remaining.some((l) => l.kind === 'layer')) return;
  for (const l of doomed) {
    if (l.kind === 'layer') engine?.deleteLayer(l.id);
  }
  const active = doomedIds.has(s.activeLayerId)
    ? remaining[remaining.length - 1].id
    : s.activeLayerId;
  s.setLayers(remaining, active);
}

/** Layer > Duplicate Layer: copies the active layer or whole group. */
export function duplicateActiveLayer(): void {
  if (!engine) return;
  commitTransform();
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active) return;
  const range = subtreeRange(s.layers, active.id)!;
  const block = s.layers.slice(range[0], range[1] + 1);
  const copiesNeeded = block.filter((l) => l.kind === 'layer').length;
  if (pixelLayers(s.layers).length + copiesNeeded > MAX_LAYERS) return;
  const idMap = new Map(block.map((l) => [l.id, nextLayerId()]));
  const copies = block.map((l) =>
    makeLayerMeta({
      ...l,
      id: idMap.get(l.id)!,
      parentId:
        l.parentId !== null && idMap.has(l.parentId)
          ? idMap.get(l.parentId)!
          : l.parentId,
      name: l.id === active.id ? `${l.name} copy` : l.name,
    }),
  );
  for (const l of block) {
    if (l.kind === 'layer') engine.copyLayer(l.id, idMap.get(l.id)!);
  }
  const layers = [...s.layers];
  layers.splice(range[1] + 1, 0, ...copies);
  s.setLayers(layers, idMap.get(active.id)!);
}

/**
 * Layer > New > Layer Via Copy / Via Cut (Ctrl+J / Shift+Ctrl+J): lifts the
 * selected pixels of the active layer onto a new layer above it. Without a
 * selection, Via Copy duplicates the layer.
 */
export async function layerViaCopy(cut: boolean): Promise<void> {
  if (!engine) return;
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active || active.kind !== 'layer') return;
  if (cut && !canEditActivePixels()) return;
  commitTransform();
  if (!selectionMask) {
    if (!cut) duplicateActiveLayer();
    return;
  }
  if (pixelLayers(s.layers).length >= MAX_LAYERS) return;
  const { width: dw, height: dh } = DOC_SIZE;
  const src = await engine.readLayerPixels(active.id);
  if (src.length < dw * dh * 4) return;
  const out = new Uint8Array(dw * dh * 4);
  for (let i = 0; i < dw * dh; i++) {
    const m = selectionMask[i];
    if (m === 0) continue;
    out[i * 4] = (src[i * 4] * m + 127) / 255;
    out[i * 4 + 1] = (src[i * 4 + 1] * m + 127) / 255;
    out[i * 4 + 2] = (src[i * 4 + 2] * m + 127) / 255;
    out[i * 4 + 3] = (src[i * 4 + 3] * m + 127) / 255;
  }
  const id = nextLayerId();
  engine.putLayerImage(id, out, dw, dh);
  const st = useStore.getState();
  st.addLayerMeta(
    makeLayerMeta({ id, name: nextName(st.layers, 'Layer') }),
    active.id,
  );
  if (cut) {
    // clear the selected pixels out of the source, like Edit > Clear
    if (active.id === 'background') {
      const rgb = color.hsvToRgb(st.bg);
      engine.fillRegion(active.id, [rgb.r, rgb.g, rgb.b]);
    } else {
      engine.fillRegion(active.id, null);
    }
  }
  setSelection(null);
}

export type ArrangeOp = 'front' | 'forward' | 'backward' | 'back';

/** Layer > Arrange: moves the active layer/group among its siblings. */
export function arrangeActiveLayer(op: ArrangeOp): void {
  commitTransform();
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active) return;
  const siblings = childrenOf(s.layers, active.parentId); // bottom -> top
  const pos = siblings.findIndex((l) => l.id === active.id);
  const target =
    op === 'forward'
      ? Math.min(pos + 1, siblings.length - 1)
      : op === 'backward'
        ? Math.max(pos - 1, 0)
        : op === 'front'
          ? siblings.length - 1
          : 0;
  if (target === pos) return;
  const layers = moveSubtree(
    s.layers,
    active.id,
    siblings[target].id,
    target > pos ? 'above' : 'below',
  );
  if (layers) s.setLayers(layers, active.id);
}

/** Layer > Hide Layers (Ctrl+,): toggles the active layer's visibility. */
export function toggleActiveLayerVisibility(): void {
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (active) s.patchLayer(active.id, { visible: !active.visible });
}

/** Toggles one of the active layer's own locks. */
export function toggleActiveLayerLock(kind: keyof LayerLocks): void {
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active) return;
  s.patchLayer(active.id, {
    locks: { ...active.locks, [kind]: !active.locks[kind] },
  });
}

/** Layer > Rename Layer: opens the panel's inline rename on the active row. */
export function renameActiveLayer(): void {
  useStore.getState().requestRename();
}

/** Alt+[ / Alt+]: steps the active layer down/up through the panel rows. */
export function selectNeighborLayer(dir: 'up' | 'down'): void {
  const s = useStore.getState();
  const rows = displayRows(s.layers);
  const i = rows.findIndex((r) => r.meta.id === s.activeLayerId);
  if (i < 0) return;
  const j = dir === 'up' ? i - 1 : i + 1; // rows are top-first
  if (j < 0 || j >= rows.length) return;
  s.setActiveLayer(rows[j].meta.id);
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
  if (!canEditActivePixels()) return;
  const s = useStore.getState();
  const rgb = color.hsvToRgb(which === 'fg' ? s.fg : s.bg);
  engine?.fillRegion(
    s.activeLayerId,
    [rgb.r, rgb.g, rgb.b],
    activeLocks().transparency,
  );
}

/**
 * Deletes the selected pixels: clears them to transparency, except on the
 * Background layer where they fill with the background color instead.
 */
export function deleteSelectionContents(): void {
  commitTransform();
  const s = useStore.getState();
  if (!s.selectionPaths || !canEditActivePixels()) return;
  if (s.activeLayerId === 'background') {
    const rgb = color.hsvToRgb(s.bg);
    engine?.fillRegion(s.activeLayerId, [rgb.r, rgb.g, rgb.b]);
  } else if (!activeLocks().transparency) {
    // clearing changes alpha, which Lock Transparent Pixels forbids
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
    let layers = resolveRenderLayers(s.layers);
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
// View (View > Zoom In / Zoom Out / Fit on Screen / 100%)
// ---------------------------------------------------------------------------

export const MIN_ZOOM = 1 / 32;
export const MAX_ZOOM = 32;

/** Photoshop-style zoom stops used by Zoom In/Out and zoom-tool clicks. */
const ZOOM_STOPS = [
  1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3,
  1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32,
];

export function nextZoomStop(zoom: number, dir: 'in' | 'out'): number {
  if (dir === 'in') {
    for (const s of ZOOM_STOPS) if (s > zoom * 1.001) return s;
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STOPS.length - 1; i >= 0; i--) {
    if (ZOOM_STOPS[i] < zoom * 0.999) return ZOOM_STOPS[i];
  }
  return MIN_ZOOM;
}

/**
 * Sets the zoom, keeping `anchor` (device pixels; defaults to the viewport
 * center) fixed on the same document point.
 */
export function applyZoom(newZoom: number, anchor?: Point): void {
  const s = useStore.getState();
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  const size = engine?.viewSize;
  const a = anchor ?? { x: (size?.width ?? 0) / 2, y: (size?.height ?? 0) / 2 };
  const v = s.view;
  const doc = { x: (a.x - v.panX) / v.zoom, y: (a.y - v.panY) / v.zoom };
  s.setView({ zoom, panX: a.x - doc.x * zoom, panY: a.y - doc.y * zoom });
}

export function zoomIn(anchor?: Point): void {
  applyZoom(nextZoomStop(useStore.getState().view.zoom, 'in'), anchor);
}

export function zoomOut(anchor?: Point): void {
  applyZoom(nextZoomStop(useStore.getState().view.zoom, 'out'), anchor);
}

export function zoomTo(zoom: number): void {
  applyZoom(zoom);
}

/** View > Fit on Screen: centers the document at the largest comfortable fit. */
export function fitOnScreen(): void {
  const size = engine?.viewSize;
  if (!size || size.width === 0) return;
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(
      MIN_ZOOM,
      Math.min((size.width * 0.9) / DOC_SIZE.width, (size.height * 0.9) / DOC_SIZE.height),
    ),
  );
  useStore.getState().setView({
    zoom,
    panX: (size.width - DOC_SIZE.width * zoom) / 2,
    panY: (size.height - DOC_SIZE.height * zoom) / 2,
  });
}

// ---------------------------------------------------------------------------
// Clipboard (Edit > Cut / Copy / Copy Merged / Paste)
// ---------------------------------------------------------------------------

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
  if (!engine || !selectionMask) return false;
  commitTransform();
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!merged && active?.kind !== 'layer') return false;
  const b = maskBounds(selectionMask, DOC_SIZE.width, DOC_SIZE.height);
  if (!b) return false;
  const src = merged
    ? await engine.readComposite(buildRenderState())
    : await engine.readLayerPixels(s.activeLayerId);
  if (src.length < DOC_SIZE.width * DOC_SIZE.height * 4) return false;
  const dw = DOC_SIZE.width;
  const out = new Uint8Array(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const m = selectionMask[(b.y + y) * dw + (b.x + x)];
      if (m === 0) continue;
      const si = ((b.y + y) * dw + (b.x + x)) * 4;
      const di = (y * b.w + x) * 4;
      // premultiplied: scaling all four channels applies the mask coverage
      out[di] = (src[si] * m + 127) / 255;
      out[di + 1] = (src[si + 1] * m + 127) / 255;
      out[di + 2] = (src[si + 2] * m + 127) / 255;
      out[di + 3] = (src[si + 3] * m + 127) / 255;
    }
  }
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
  s.setLayers([makeLayerMeta({ id: 'background', name: 'Background' })], 'background');
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
// Merges (Layer > Merge Down / Merge Group / Merge Visible / Flatten Image)
// ---------------------------------------------------------------------------

/** The sibling directly below the active layer, when both are mergeable. */
function mergeDownTarget(): LayerMeta | null {
  const s = useStore.getState();
  const a = layerById(s.layers, s.activeLayerId);
  if (!a || a.kind !== 'layer' || !a.visible) return null;
  const siblings = childrenOf(s.layers, a.parentId);
  const pos = siblings.findIndex((l) => l.id === a.id);
  const below = pos > 0 ? siblings[pos - 1] : null;
  if (!below || below.kind !== 'layer' || !below.visible) return null;
  for (const id of [a.id, below.id]) {
    const locks = effectiveLocks(s.layers, id);
    if (locks.pixels || locks.position || locks.all) return null;
  }
  return below;
}

/** Whether Ctrl+E can do anything (merge down, or merge the active group). */
export function canMergeDown(): boolean {
  const s = useStore.getState();
  const a = layerById(s.layers, s.activeLayerId);
  if (!a) return false;
  if (a.kind === 'group') {
    return [...descendantIds(s.layers, a.id)].some(
      (id) => layerById(s.layers, id)?.kind === 'layer',
    );
  }
  return mergeDownTarget() !== null;
}

/** Ctrl+E: merges the active layer into the one below, or bakes a group. */
export function mergeDown(): void {
  commitTransform();
  const s = useStore.getState();
  const a = layerById(s.layers, s.activeLayerId);
  if (!a || !engine) return;
  if (a.kind === 'group') {
    void mergeGroup();
    return;
  }
  const below = mergeDownTarget();
  if (!below) return;
  engine.mergeDown(a.id, below.id, a.opacity, a.blendMode);
  s.removeLayerMeta(a.id);
  engine.deleteLayer(a.id);
}

/** Layer > Merge Group: bakes the active group into a single layer. */
export async function mergeGroup(): Promise<void> {
  if (!engine) return;
  commitTransform();
  const s = useStore.getState();
  const g = layerById(s.layers, s.activeLayerId);
  if (!g || g.kind !== 'group') return;
  const range = subtreeRange(s.layers, g.id)!;
  const block = s.layers.slice(range[0], range[1] + 1);
  const members = block.filter((l) => l.id !== g.id);
  // resolve visibility/opacity relative to the group: the group's own
  // opacity and visibility stay on the merged layer's meta
  const resolved = resolveRenderLayers(members);
  if (!resolved.some((l) => l.visible)) return;
  const data = await engine.readComposite({
    layers: resolved,
    activeLayerId: s.activeLayerId,
    view: s.view,
  });
  if (data.length === 0) return;
  const id = nextLayerId();
  engine.putLayerImage(id, data, DOC_SIZE.width, DOC_SIZE.height);
  const merged = makeLayerMeta({
    id,
    name: g.name,
    visible: g.visible,
    opacity: g.opacity,
    parentId: g.parentId,
    locks: g.locks,
  });
  for (const l of members) {
    if (l.kind === 'layer') engine.deleteLayer(l.id);
  }
  const st = useStore.getState();
  const blockIds = new Set(block.map((l) => l.id));
  const layers = st.layers.filter((l) => !blockIds.has(l.id));
  const at = st.layers.slice(0, range[0]).filter((l) => !blockIds.has(l.id)).length;
  layers.splice(at, 0, merged);
  st.setLayers(layers, id);
}

/**
 * Layer > Merge Visible (Shift+Ctrl+E): bakes every visible layer into the
 * bottom-most visible one; hidden layers survive untouched.
 */
export async function mergeVisible(): Promise<void> {
  if (!engine) return;
  commitTransform();
  const s = useStore.getState();
  const resolved = resolveRenderLayers(s.layers);
  const visible = resolved.filter((l) => l.visible);
  if (visible.length <= 1) return;
  // a locked visible layer blocks the merge, like Photoshop
  for (const l of visible) {
    const locks = effectiveLocks(s.layers, l.id);
    if (locks.pixels || locks.position || locks.all) return;
  }
  const data = await engine.readComposite({
    layers: resolved,
    activeLayerId: s.activeLayerId,
    view: s.view,
  });
  if (data.length === 0) return;

  const st = useStore.getState();
  const target = layerById(st.layers, visible[0].id)!;
  const visibleIds = new Set(visible.map((l) => l.id));
  // keep hidden pixel layers, and groups that still contain one
  const keptPixels = new Set(
    resolved.filter((l) => !visibleIds.has(l.id)).map((l) => l.id),
  );
  const keep = (l: LayerMeta) =>
    l.kind === 'layer'
      ? keptPixels.has(l.id)
      : [...descendantIds(st.layers, l.id)].some((id) => keptPixels.has(id));
  // the merged result lands at the root, where the target's top-level
  // ancestor sat in the stack
  let root = target;
  while (root.parentId !== null) root = layerById(st.layers, root.parentId)!;
  const rootStart = subtreeRange(st.layers, root.id)![0];
  const merged = makeLayerMeta({
    ...target,
    parentId: null,
    visible: true,
    opacity: 1,
    blendMode: 'normal',
  });
  const remaining = st.layers.filter(keep);
  const at = st.layers.slice(0, rootStart).filter(keep).length;
  remaining.splice(at, 0, merged);
  engine.putLayerImage(target.id, data, DOC_SIZE.width, DOC_SIZE.height);
  for (const l of visible) {
    if (l.id !== target.id) engine.deleteLayer(l.id);
  }
  st.setLayers(remaining, target.id);
}

/** Layer > Flatten Image: everything visible onto one opaque Background. */
export async function flattenImage(): Promise<void> {
  if (!engine) return;
  commitTransform();
  const s = useStore.getState();
  if (s.layers.length === 1 && s.layers[0].opacity === 1 && s.layers[0].kind === 'layer') {
    return;
  }
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
  const keepId = s.layers.some((l) => l.id === 'background')
    ? 'background'
    : pixelLayers(s.layers)[0].id;
  engine.putLayerImage(keepId, data, DOC_SIZE.width, DOC_SIZE.height);
  for (const l of s.layers) {
    if (l.id !== keepId && l.kind === 'layer') engine.deleteLayer(l.id);
  }
  s.setLayers([makeLayerMeta({ id: keepId, name: 'Background' })], keepId);
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
  if (pixelLayers(s.layers).length >= MAX_LAYERS) return;
  const bmp = await createImageBitmap(file);
  const id = nextLayerId();
  engine.putLayerImage(id, bitmapToDocPixels(bmp, true), DOC_SIZE.width, DOC_SIZE.height);
  bmp.close();
  s.addLayerMeta(
    makeLayerMeta({ id, name: file.name.replace(/\.[^.]+$/, '') || 'Placed Image' }),
    s.activeLayerId,
  );
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
