import { PaintEngine, type RenderState } from './gpu/engine';
import * as shaders from './gpu/shaders';
import * as color from './color/convert';
import * as brushDefaults from './brush/defaults';
import * as brushDynamics from './brush/dynamics';
import * as brushPatterns from './brush/patterns';
import * as brushPresets from './brush/presets';
import * as brushAbr from './brush/abr';
import { engineStrokeParams } from './brush/engineParams';
import { StrokeSession } from './gpu/stroke';
import { rasterizeSelection } from './gpu/selection';
import { DOC_SIZE, nextLayerId, useStore } from './store';
import type { Point } from './types';

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
  },
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

export function buildRenderState(): RenderState {
  const s = useStore.getState();
  return { layers: s.layers, activeLayerId: s.activeLayerId, view: s.view };
}

export const MAX_LAYERS = 64; // matches the compositor's uniform buffer

export function addLayer(): void {
  if (!engine) return;
  const s = useStore.getState();
  if (s.layers.length >= MAX_LAYERS) return;
  const id = nextLayerId();
  engine.ensureLayer(id);
  s.addLayerMeta(
    {
      id,
      name: `Layer ${s.layers.length + 1}`,
      visible: true,
      opacity: 1,
      blendMode: 'normal',
    },
    s.activeLayerId,
  );
}

export function duplicateLayer(srcId: string): void {
  if (!engine) return;
  const s = useStore.getState();
  if (s.layers.length >= MAX_LAYERS) return;
  const src = s.layers.find((l) => l.id === srcId);
  if (!src) return;
  const id = nextLayerId();
  engine.copyLayer(srcId, id);
  s.addLayerMeta({ ...src, id, name: `${src.name} copy` }, srcId);
}

export function deleteLayer(id: string): void {
  const s = useStore.getState();
  if (s.layers.length <= 1) return;
  s.removeLayerMeta(id);
  engine?.deleteLayer(id);
}

export function setSelection(paths: Point[][] | null): void {
  const s = useStore.getState();
  if (!paths || paths.every((p) => p.length < 3)) {
    s.setSelectionPaths(null);
    engine?.setSelectionMask(null);
    return;
  }
  s.setSelectionPaths(paths);
  engine?.setSelectionMask(rasterizeSelection(paths, DOC_SIZE.width, DOC_SIZE.height));
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
  void engine?.undo();
}

export function redo(): void {
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
