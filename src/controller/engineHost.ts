import type { PaintEngine, RenderState } from '../gpu/engine';
import { resolveRenderLayers } from '../layers';
import { useStore } from '../store';

/**
 * Holds the singleton PaintEngine that bridges UI actions (zustand metadata)
 * to GPU textures. Every controller module reaches the engine through here.
 */

let engine: PaintEngine | null = null;

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
