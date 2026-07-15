import { create } from 'zustand';
import type { BlendMode, HSV, LayerMeta, Point, ToolId, Viewport } from './types';
import type { BrushSettings } from './brush/types';
import { defaultBrush, makeBrush } from './brush/defaults';
import { findPreset } from './brush/presets';

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

const initialEraser = makeBrush({ tip: { hardness: 1, size: 30, spacing: 0.15 } });

export interface AppState {
  tool: ToolId;
  /** tool to return to after a spacebar-pan */
  toolBeforePan: ToolId | null;

  fg: HSV;
  bg: HSV;

  brush: BrushSettings;
  eraser: BrushSettings;
  /** currently selected preset id per paint tool, for UI highlighting */
  activePreset: Record<PaintToolId, string | null>;

  sideTab: SideTab;

  layers: LayerMeta[]; // bottom -> top
  activeLayerId: string;

  view: Viewport;
  selectionPaths: Point[][] | null;

  canUndo: boolean;
  canRedo: boolean;
  gpuError: string | null;

  setTool: (t: ToolId) => void;
  setToolBeforePan: (t: ToolId | null) => void;
  setFg: (c: HSV) => void;
  setBg: (c: HSV) => void;
  swapColors: () => void;
  resetColors: () => void;

  /** shallow top-level merge; pass whole nested sections when patching them */
  updateBrush: (patch: Partial<BrushSettings>, tool: PaintToolId) => void;
  applyPreset: (presetId: string, tool: PaintToolId) => void;
  setSideTab: (tab: SideTab) => void;

  addLayerMeta: (meta: LayerMeta, aboveId?: string) => void;
  removeLayerMeta: (id: string) => void;
  patchLayer: (id: string, patch: Partial<LayerMeta>) => void;
  moveLayer: (id: string, dir: 1 | -1) => void;
  setActiveLayer: (id: string) => void;
  setLayerBlendMode: (id: string, mode: BlendMode) => void;

  setView: (v: Viewport) => void;
  setSelectionPaths: (paths: Point[][] | null) => void;
  setHistory: (canUndo: boolean, canRedo: boolean) => void;
  setGpuError: (e: string | null) => void;
}

export const useStore = create<AppState>((set) => ({
  tool: 'brush',
  toolBeforePan: null,

  fg: { h: 0, s: 0, v: 0 }, // black
  bg: { h: 0, s: 0, v: 1 }, // white

  brush: defaultBrush(),
  eraser: initialEraser,
  activePreset: { brush: 'soft-round', eraser: null },

  sideTab: 'color',

  layers: [
    {
      id: 'background',
      name: 'Background',
      visible: true,
      opacity: 1,
      blendMode: 'normal',
    },
  ],
  activeLayerId: 'background',

  view: { zoom: 1, panX: 0, panY: 0 },
  selectionPaths: null,

  canUndo: false,
  canRedo: false,
  gpuError: null,

  setTool: (tool) => set({ tool }),
  setToolBeforePan: (toolBeforePan) => set({ toolBeforePan }),
  setFg: (fg) => set({ fg }),
  setBg: (bg) => set({ bg }),
  swapColors: () => set((s) => ({ fg: s.bg, bg: s.fg })),
  resetColors: () => set({ fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } }),

  updateBrush: (patch, tool) =>
    set((s) => ({ [tool]: { ...s[tool], ...patch } }) as Partial<AppState>),

  applyPreset: (presetId, tool) =>
    set((s) => {
      const preset = findPreset(presetId);
      if (!preset) return {};
      return {
        [tool]: structuredClone(preset.settings),
        activePreset: { ...s.activePreset, [tool]: presetId },
      } as Partial<AppState>;
    }),

  setSideTab: (sideTab) => set({ sideTab }),

  addLayerMeta: (meta, aboveId) =>
    set((s) => {
      const layers = [...s.layers];
      const idx = aboveId ? layers.findIndex((l) => l.id === aboveId) : -1;
      if (idx >= 0) layers.splice(idx + 1, 0, meta);
      else layers.push(meta);
      return { layers, activeLayerId: meta.id };
    }),

  removeLayerMeta: (id) =>
    set((s) => {
      if (s.layers.length <= 1) return {};
      const idx = s.layers.findIndex((l) => l.id === id);
      const layers = s.layers.filter((l) => l.id !== id);
      const active =
        s.activeLayerId === id
          ? layers[Math.min(Math.max(idx - 1, 0), layers.length - 1)].id
          : s.activeLayerId;
      return { layers, activeLayerId: active };
    }),

  patchLayer: (id, patch) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    })),

  moveLayer: (id, dir) =>
    set((s) => {
      const idx = s.layers.findIndex((l) => l.id === id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= s.layers.length) return {};
      const layers = [...s.layers];
      const [item] = layers.splice(idx, 1);
      layers.splice(to, 0, item);
      return { layers };
    }),

  setActiveLayer: (activeLayerId) => set({ activeLayerId }),
  setLayerBlendMode: (id, blendMode) =>
    set((s) => ({
      layers: s.layers.map((l) => (l.id === id ? { ...l, blendMode } : l)),
    })),

  setView: (view) => set({ view }),
  setSelectionPaths: (selectionPaths) => set({ selectionPaths }),
  setHistory: (canUndo, canRedo) => set({ canUndo, canRedo }),
  setGpuError: (gpuError) => set({ gpuError }),
}));
