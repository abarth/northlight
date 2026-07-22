import { create } from 'zustand';
import type { HSV, LayerMeta, Point, ToolId, Viewport } from './types';
import { makeLayerMeta } from './types';
import type { BrushSettings } from './brush/types';
import { defaultBristleBrush, type BristleBrushSettings } from './brush/bristle';
import { findBristlePreset } from './brush/bristlePresets';
import type { SelectionOp } from './gpu/selection';
import { defaultBrush, makeBrush } from './brush/defaults';
import { findPreset } from './brush/presets';
import { insertionPoint, pixelLayers } from './layers';

export const DOC_DEFAULT_WIDTH = 1600;
export const DOC_DEFAULT_HEIGHT = 1000;

function docSizeFromUrl(): { width: number; height: number } {
  const params = new URLSearchParams(location.search);
  const w = parseInt(params.get('w') ?? '', 10);
  const h = parseInt(params.get('h') ?? '', 10);
  return {
    width: Number.isFinite(w) && w > 0 ? Math.min(w, 8192) : DOC_DEFAULT_WIDTH,
    height: Number.isFinite(h) && h > 0 ? Math.min(h, 8192) : DOC_DEFAULT_HEIGHT,
  };
}

export const DOC_SIZE = docSizeFromUrl();

let layerCounter = 1;
export function nextLayerId(): string {
  return `layer-${Date.now().toString(36)}-${layerCounter++}`;
}

export type PaintToolId = 'brush' | 'eraser';
export type SideTab = 'color' | 'brushes' | 'settings';

/** Photoshop eyedropper "Sample Size" (NxN average around the click). */
export type EyedropperSampleSize = 1 | 3 | 5 | 11 | 31 | 51 | 101;
/** Photoshop eyedropper "Sample" scope. */
export type EyedropperSample = 'all' | 'currentBelow' | 'current';

/** Edit > Transform variants (free = Ctrl+T with all modifier behaviors). */
export type TransformMode =
  | 'free'
  | 'scale'
  | 'rotate'
  | 'skew'
  | 'distort'
  | 'perspective';

export interface TransformState {
  /** layer pixels (Free Transform) or the selection outline only */
  target: 'layer' | 'selection';
  mode: TransformMode;
  /** layer being transformed (layer targets), pinned at session start */
  layerId: string;
  /** the untransformed reference rectangle R (content/selection bounds) */
  rect: { x: number; y: number; w: number; h: number };
  /** current corners of R in document space: TL, TR, BR, BL */
  quad: Point[];
  /** Alt-drag move: keep the original pixels too */
  duplicate: boolean;
  /** draw the transform box + handles */
  showHandles: boolean;
  /**
   * A move-tool float starts un-engaged (options bar keeps the move options);
   * grabbing a handle or invoking Free Transform engages it (Apply/Cancel).
   */
  engaged: boolean;
}

export type DialogId = 'new' | 'imageSize' | 'canvasSize' | 'fgColor' | 'bgColor' | null;

const initialEraser = makeBrush({ tip: { hardness: 1, size: 30, spacing: 0.15 } });

export interface AppState {
  tool: ToolId;
  /**
   * Photoshop-style temporary tool while modifier keys are held (Space = pan,
   * Space+Ctrl/Alt = zoom, Alt = eyedropper, Ctrl = move). The base `tool`
   * stays selected in the toolbar; the effective tool is overrideTool ?? tool.
   */
  overrideTool: ToolId | null;

  fg: HSV;
  bg: HSV;

  brush: BrushSettings;
  eraser: BrushSettings;
  /** which mark engine the brush tool uses (the eraser is always stamp) */
  brushEngine: 'stamp' | 'bristle';
  /** experimental track-based bristle brush (docs/bristle-brush.md) */
  bristle: BristleBrushSettings;
  /** currently selected preset id per paint tool, for UI highlighting */
  activePreset: Record<PaintToolId, string | null>;
  /** bumped whenever the preset library changes (e.g. after an ABR import) */
  presetRevision: number;

  sideTab: SideTab;

  eyedropperSampleSize: EyedropperSampleSize;
  eyedropperSample: EyedropperSample;

  /** default boolean op for the selection tools (modifier keys override) */
  selectionOp: SelectionOp;

  /** move tool: click picks the topmost layer with pixels under the cursor */
  moveAutoSelect: boolean;
  /** move tool: show the transform box around the moved content */
  moveShowTransform: boolean;

  /** active interactive transform session, or null */
  transform: TransformState | null;

  /** document metadata mirrored for the UI (pixels + print resolution) */
  doc: { width: number; height: number; resolution: number };
  /** bumped to ask the canvas view to re-fit the viewport */
  fitNonce: number;

  dialog: DialogId;

  layers: LayerMeta[]; // bottom -> top; group children sit just below their header
  activeLayerId: string;
  /** bumped by Layer > Rename Layer to open the panel's inline rename */
  renameNonce: number;

  view: Viewport;
  selectionPaths: Point[][] | null;
  /** View > Extras (Ctrl+H): show selection edges and other helpers */
  showExtras: boolean;
  /** something has been Cut/Copied and can be pasted */
  hasClipboard: boolean;

  canUndo: boolean;
  canRedo: boolean;
  gpuError: string | null;

  setTool: (t: ToolId) => void;
  setOverrideTool: (t: ToolId | null) => void;
  setFg: (c: HSV) => void;
  setBg: (c: HSV) => void;
  swapColors: () => void;
  resetColors: () => void;

  /** shallow top-level merge; pass whole nested sections when patching them */
  updateBrush: (patch: Partial<BrushSettings>, tool: PaintToolId) => void;
  setBrushEngine: (engine: 'stamp' | 'bristle') => void;
  /** shallow merge; pass the whole colorJitter object when patching it */
  updateBristle: (patch: Partial<BristleBrushSettings>) => void;
  /** applies a bristle preset and switches the brush to the bristle engine */
  applyBristlePreset: (presetId: string) => void;
  applyPreset: (presetId: string, tool: PaintToolId) => void;
  bumpPresetRevision: () => void;
  setSideTab: (tab: SideTab) => void;
  setEyedropperSampleSize: (size: EyedropperSampleSize) => void;
  setEyedropperSample: (sample: EyedropperSample) => void;
  setSelectionOp: (op: SelectionOp) => void;
  setMoveAutoSelect: (v: boolean) => void;
  setMoveShowTransform: (v: boolean) => void;
  setTransform: (t: TransformState | null) => void;
  patchTransform: (patch: Partial<TransformState>) => void;
  setDoc: (doc: { width: number; height: number; resolution: number }) => void;
  requestFit: () => void;
  setDialog: (d: DialogId) => void;

  addLayerMeta: (meta: LayerMeta, aboveId?: string) => void;
  removeLayerMeta: (id: string) => void;
  patchLayer: (id: string, patch: Partial<LayerMeta>) => void;
  requestRename: () => void;
  /** Replaces the whole layer stack (new document / flatten / restructure). */
  setLayers: (layers: LayerMeta[], activeId: string) => void;
  setActiveLayer: (id: string) => void;

  setView: (v: Viewport) => void;
  setSelectionPaths: (paths: Point[][] | null) => void;
  setShowExtras: (v: boolean) => void;
  setHasClipboard: (v: boolean) => void;
  setHistory: (canUndo: boolean, canRedo: boolean) => void;
  setGpuError: (e: string | null) => void;
}

export const useStore = create<AppState>((set) => ({
  tool: 'brush',
  overrideTool: null,

  fg: { h: 0, s: 0, v: 0 }, // black
  bg: { h: 0, s: 0, v: 1 }, // white

  brush: defaultBrush(),
  eraser: initialEraser,
  brushEngine: 'stamp',
  bristle: defaultBristleBrush(),
  activePreset: { brush: 'soft-round', eraser: null },
  presetRevision: 0,

  sideTab: 'color',

  eyedropperSampleSize: 1,
  eyedropperSample: 'all',

  selectionOp: 'new',
  moveAutoSelect: false,
  moveShowTransform: true,
  transform: null,
  doc: { width: DOC_SIZE.width, height: DOC_SIZE.height, resolution: 72 },
  fitNonce: 0,
  dialog: null,

  layers: [makeLayerMeta({ id: 'background', name: 'Background' })],
  activeLayerId: 'background',
  renameNonce: 0,

  view: { zoom: 1, panX: 0, panY: 0 },
  selectionPaths: null,
  showExtras: true,
  hasClipboard: false,

  canUndo: false,
  canRedo: false,
  gpuError: null,

  setTool: (tool) => set({ tool }),
  setOverrideTool: (overrideTool) => set({ overrideTool }),
  setFg: (fg) => set({ fg }),
  setBg: (bg) => set({ bg }),
  swapColors: () => set((s) => ({ fg: s.bg, bg: s.fg })),
  resetColors: () => set({ fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } }),

  updateBrush: (patch, tool) =>
    set((s) => {
      const cur = s[tool];
      const next = { ...cur, ...patch };
      // Photoshop scales the dual tip proportionally when the primary tip
      // size changes (explicit dual edits are left alone).
      const newSize = patch.tip?.size;
      if (newSize !== undefined && newSize !== cur.tip.size && !patch.dual) {
        const ratio = newSize / Math.max(cur.tip.size, 0.01);
        next.dual = {
          ...cur.dual,
          size: Math.min(Math.max(cur.dual.size * ratio, 1), 1000),
        };
      }
      return { [tool]: next } as Partial<AppState>;
    }),

  setBrushEngine: (brushEngine) => set({ brushEngine }),

  updateBristle: (patch) => set((s) => ({ bristle: { ...s.bristle, ...patch } })),

  applyBristlePreset: (presetId) =>
    set((s) => {
      const preset = findBristlePreset(presetId);
      if (!preset) return {};
      return {
        bristle: structuredClone(preset.settings),
        brushEngine: 'bristle',
        // size and opacity live in the shared options-bar brush settings
        brush: {
          ...s.brush,
          tip: { ...s.brush.tip, size: preset.size },
          opacity: preset.opacity,
        },
        activePreset: { ...s.activePreset, brush: presetId },
      };
    }),

  applyPreset: (presetId, tool) =>
    set((s) => {
      const preset = findPreset(presetId);
      if (!preset) return {};
      return {
        [tool]: structuredClone(preset.settings),
        activePreset: { ...s.activePreset, [tool]: presetId },
        // picking a stamp preset returns the brush to the stamp engine
        ...(tool === 'brush' ? { brushEngine: 'stamp' as const } : {}),
      } as Partial<AppState>;
    }),

  bumpPresetRevision: () => set((s) => ({ presetRevision: s.presetRevision + 1 })),

  setSideTab: (sideTab) => set({ sideTab }),
  setEyedropperSampleSize: (eyedropperSampleSize) => set({ eyedropperSampleSize }),
  setEyedropperSample: (eyedropperSample) => set({ eyedropperSample }),
  setSelectionOp: (selectionOp) => set({ selectionOp }),
  setMoveAutoSelect: (moveAutoSelect) => set({ moveAutoSelect }),
  setMoveShowTransform: (moveShowTransform) => set({ moveShowTransform }),
  setTransform: (transform) => set({ transform }),
  patchTransform: (patch) =>
    set((s) => (s.transform ? { transform: { ...s.transform, ...patch } } : {})),
  setDoc: (doc) => set({ doc }),
  requestFit: () => set((s) => ({ fitNonce: s.fitNonce + 1 })),
  setDialog: (dialog) => set({ dialog }),

  addLayerMeta: (meta, aboveId) =>
    set((s) => {
      const layers = [...s.layers];
      if (aboveId && layers.some((l) => l.id === aboveId)) {
        // above the active layer, or inside the active group, like Photoshop
        const at = insertionPoint(layers, aboveId);
        layers.splice(at.index, 0, { ...meta, parentId: at.parentId });
      } else {
        layers.push({ ...meta, parentId: null });
      }
      return { layers, activeLayerId: meta.id };
    }),

  removeLayerMeta: (id) =>
    set((s) => {
      const meta = s.layers.find((l) => l.id === id);
      if (!meta) return {};
      if (meta.kind === 'layer' && pixelLayers(s.layers).length <= 1) return {};
      const idx = s.layers.findIndex((l) => l.id === id);
      const layers = s.layers.filter((l) => l.id !== id);
      const active =
        s.activeLayerId === id
          ? layers[Math.min(Math.max(idx - 1, 0), layers.length - 1)].id
          : s.activeLayerId;
      return { layers, activeLayerId: active };
    }),

  requestRename: () => set((s) => ({ renameNonce: s.renameNonce + 1 })),

  patchLayer: (id, patch) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    })),

  setLayers: (layers, activeLayerId) => set({ layers, activeLayerId }),

  setActiveLayer: (activeLayerId) => set({ activeLayerId }),

  setView: (view) => set({ view }),
  setSelectionPaths: (selectionPaths) => set({ selectionPaths }),
  setShowExtras: (showExtras) => set({ showExtras }),
  setHasClipboard: (hasClipboard) => set({ hasClipboard }),
  setHistory: (canUndo, canRedo) => set({ canUndo, canRedo }),
  setGpuError: (gpuError) => set({ gpuError }),
}));
